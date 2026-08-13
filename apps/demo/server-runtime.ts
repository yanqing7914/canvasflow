import { createServer, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { AgentGateway } from '@canvasflow/agent'
import { createAgentHttpHandler, type AgentHttpGateway } from '@canvasflow/agent/http'
import { ModelGateway, larkCalendarAdapterFromEnvironment, modelAdapterOptionsFromEnvironment } from '@canvasflow/agent'
import { messageSendInputSchema } from '@canvasflow/schema'
import {
  PersistentAgentRuntime,
  providerModeFromEnvironment,
  type ProviderFactory,
} from '@canvasflow/agent/persistent'
import { createProviderRegistry, errorResult } from '@canvasflow/tools'

export type AgentServerOptions = {
  staticDirectory?: string
  gateway?: AgentHttpGateway
}

export type ConfiguredAgentRuntimeOptions = {
  environment?: NodeJS.ProcessEnv
  providerFactory?: ProviderFactory
}

export const E2E_FAIL_AUTO_MESSAGE_SEND = 'AGENT_E2E_FAIL_AUTO_MESSAGE_SEND'
export const CANVASFLOW_E2E = 'CANVASFLOW_E2E'
export const CANVASFLOW_E2E_NOW = 'CANVASFLOW_E2E_NOW'

export const LOCAL_VOICE_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
} as const

export const VOICE_ASR_PREFIX = '/v1/voice/transcribe'
export const VOICE_CAPABILITIES_PREFIX = '/v1/voice/capabilities'

export async function proxyVoiceTranscription(
  request: import('node:http').IncomingMessage,
  response: ServerResponse,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const upstream = environment.CANVASFLOW_ASR_URL
  if (!upstream) {
    response.writeHead(503, { ...LOCAL_VOICE_ISOLATION_HEADERS, 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'PCM ASR provider is not configured' }))
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const result = await fetchImpl(upstream, {
    method: 'POST',
    headers: {
      'content-type': request.headers['content-type'] ?? 'audio/pcm;format=s16le;rate=16000;channels=1',
      'x-voice-generation': String(request.headers['x-voice-generation'] ?? ''),
    },
    body: Buffer.concat(chunks),
  })
  response.writeHead(result.status, {
    ...LOCAL_VOICE_ISOLATION_HEADERS,
    'content-type': result.headers.get('content-type') ?? 'application/json; charset=utf-8',
  })
  response.end(Buffer.from(await result.arrayBuffer()))
}

type RuntimeClock = {
  now: () => string
  nowMs: () => number
}

/**
 * A deterministic clock for browser tests. It is deliberately gated by the
 * explicit E2E mode flag so an accidental production environment variable can
 * never freeze the Agent's wall clock.
 */
export function e2eClockFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeClock | undefined {
  if (environment[CANVASFLOW_E2E] !== '1') return undefined
  const configured = environment[CANVASFLOW_E2E_NOW]
  if (!configured) return undefined
  const timestamp = Date.parse(configured)
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${CANVASFLOW_E2E_NOW} must be a valid ISO timestamp`)
  }
  return {
    // Preserve the authored offset for fixtures and user-facing local dates.
    now: () => configured,
    nowMs: () => timestamp,
  }
}

/** Request prefix the client hits; forwarded to {@link AMAP_UPSTREAM_ORIGIN}. */
export const AMAP_SERVICE_PREFIX = '/_AMapService'
/** The one host this proxy will ever forward to. Whitelist, not blacklist. */
export const AMAP_UPSTREAM_ORIGIN = 'https://restapi.amap.com'

/**
 * Map a `/_AMapService/...` request onto its restapi.amap.com URL, appending the
 * server-only security code when configured, or null when the request is not a
 * well-formed call to that prefix.
 *
 * The upstream host is pinned by constructing the URL from a fixed origin and
 * only setting its path and query, so nothing in the request can redirect the
 * proxy to another host — a protocol-relative `//evil.com` becomes part of
 * restapi.amap.com's path, not a new authority. A `..` segment is rejected
 * outright so the forwarded path is exactly what the client asked for. The
 * jscode is added last and never comes from the request.
 */
export function resolveAMapServiceUrl(
  requestUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  // WHATWG URL normalizes dot segments before exposing `pathname`, so inspect
  // the raw request target first to catch both literal and percent-encoded `..`.
  const rawPath = requestUrl.split(/[?#]/, 1)[0] ?? ''
  if (rawPath.startsWith(`${AMAP_SERVICE_PREFIX}/`)) {
    try {
      if (decodeURIComponent(rawPath.slice(AMAP_SERVICE_PREFIX.length)).split('/').includes('..')) return null
    } catch {
      return null
    }
  }
  let parsed: URL
  try {
    parsed = new URL(requestUrl, 'http://localhost')
  } catch {
    return null
  }
  if (parsed.pathname !== AMAP_SERVICE_PREFIX && !parsed.pathname.startsWith(`${AMAP_SERVICE_PREFIX}/`)) {
    return null
  }
  const rest = parsed.pathname.slice(AMAP_SERVICE_PREFIX.length) || '/'
  const upstream = new URL(AMAP_UPSTREAM_ORIGIN)
  upstream.pathname = rest
  upstream.search = parsed.search
  // Belt and suspenders: setting pathname/search cannot move the host, but if a
  // future edit ever let it, this refuses to forward off the whitelist.
  if (upstream.protocol !== 'https:' || upstream.host !== 'restapi.amap.com') return null
  const jscode = environment.AMAP_SECURITY_JS_CODE
  if (jscode) upstream.searchParams.set('jscode', jscode)
  return upstream.toString()
}

/**
 * Forward an AMap service call and stream the response back. The upstream URL
 * carries the jscode, so a failure is answered with a bare status and never
 * echoes the URL, and the code is not logged. `fetchImpl` is injectable so the
 * body-passthrough and no-leak behavior stay testable without a live upstream.
 */
export async function proxyAMapService(
  requestUrl: string,
  response: ServerResponse,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const upstream = resolveAMapServiceUrl(requestUrl, environment)
  if (!upstream) {
    response.writeHead(400).end()
    return
  }
  try {
    const result = await fetchImpl(upstream)
    const body = Buffer.from(await result.arrayBuffer())
    response.writeHead(result.status, {
      'content-type': result.headers.get('content-type') ?? 'application/json; charset=utf-8',
    })
    response.end(body)
  } catch {
    if (!response.headersSent) response.writeHead(502)
    if (!response.writableEnded) response.end()
  }
}

export function createE2eProviderFactory(environment: NodeJS.ProcessEnv): ProviderFactory | undefined {
  if (environment[CANVASFLOW_E2E] !== '1' || environment[E2E_FAIL_AUTO_MESSAGE_SEND] !== '1') return undefined
  return (runtime, mode) => {
    if (mode === 'live') throw new Error(`${E2E_FAIL_AUTO_MESSAGE_SEND} is unavailable in live provider mode`)
    const registry = createProviderRegistry(runtime, mode)
    const send = registry['message.send']
    return {
      ...registry,
      'message.send': (context, input) => {
        const parsed = messageSendInputSchema.safeParse(input)
        if (
          parsed.success
          && parsed.data.authorizationId !== undefined
          && parsed.data.confirmationId === undefined
          && parsed.data.messageId === 'MU5103:landing'
        ) {
          return errorResult(
            { ...context, provider: mode },
            'message.send',
            'SEND_FAILED',
            'E2E auto-notify failure',
            false,
          )
        }
        return send(context, input)
      },
    }
  }
}

export function createConfiguredAgentRuntime(options: ConfiguredAgentRuntimeOptions = {}): PersistentAgentRuntime {
  const environment = options.environment ?? process.env
  const mode = providerModeFromEnvironment(environment)
  const e2eClock = e2eClockFromEnvironment(environment)
  if (mode === 'live' && createE2eProviderFactory(environment)) {
    throw new Error(`${E2E_FAIL_AUTO_MESSAGE_SEND} is unavailable in live provider mode`)
  }
  return new PersistentAgentRuntime({
    databasePath: environment.AGENT_DATABASE_PATH ?? '.canvasflow/agent.sqlite',
    mode,
    providerFactory: options.providerFactory ?? createE2eProviderFactory(environment),
    modelGateway: new ModelGateway(modelAdapterOptionsFromEnvironment(environment)),
    scheduleAdapter: larkCalendarAdapterFromEnvironment(environment),
    ...(e2eClock ?? {}),
  })
}

export function createAgentServer(options: AgentServerOptions = {}) {
  const staticDirectory = options.staticDirectory ? resolve(options.staticDirectory) : undefined
  const gateway = options.gateway ?? new AgentGateway()
  const agentHandler = createAgentHttpHandler(gateway)
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, {
        ...LOCAL_VOICE_ISOLATION_HEADERS,
        'content-type': 'application/json',
      })
      response.end('{"ok":true}')
      return
    }
    if (request.method === 'POST' && request.url?.split('?', 1)[0] === VOICE_ASR_PREFIX) {
      void proxyVoiceTranscription(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502, { ...LOCAL_VOICE_ISOLATION_HEADERS, 'content-type': 'application/json' })
        if (!response.writableEnded) response.end(JSON.stringify({ error: 'PCM ASR provider failed' }))
      })
      return
    }
    if (request.method === 'GET' && request.url?.split('?', 1)[0] === VOICE_CAPABILITIES_PREFIX) {
      const pcmAsr = Boolean(process.env.CANVASFLOW_ASR_URL)
      response.writeHead(200, { ...LOCAL_VOICE_ISOLATION_HEADERS, 'cache-control': 'no-store', 'content-type': 'application/json' })
      response.end(JSON.stringify({ pcmAsr }))
      return
    }
    if (request.method === 'GET' && request.url?.startsWith(AMAP_SERVICE_PREFIX)) {
      void proxyAMapService(request.url, response).catch(() => {
        if (!response.headersSent) response.writeHead(502)
        if (!response.writableEnded) response.end()
      })
      return
    }
    if (staticDirectory && request.method === 'GET' && !request.url?.startsWith('/v1/')) {
      void serveStatic(staticDirectory, request.url ?? '/', response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        if (!response.writableEnded) response.end()
      })
      return
    }
    void agentHandler(request, response)
  })
}

export function serverHost(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.AGENT_HOST ?? '0.0.0.0'
}

export function serverPort(environment: NodeJS.ProcessEnv = process.env): number {
  return Number(environment.AGENT_PORT ?? 8787)
}

/** The slice of `node:path` the static resolver uses, injectable for tests. */
export type StaticPathModule = {
  normalize: (value: string) => string
  join: (...segments: string[]) => string
  resolve: (...segments: string[]) => string
  sep: string
}

/**
 * Maps a request pathname onto a file inside the static directory, or null when
 * the path would escape it. The containment check compares with the module's
 * own separator: `resolve` yields backslash paths on Windows, so a hard-coded
 * '/' prefix would reject every legitimate file there. The path implementation
 * is injectable so both the POSIX and the Windows behavior stay covered by
 * tests regardless of the host the suite runs on.
 */
export function resolveStaticPath(
  staticDirectory: string,
  pathname: string,
  pathModule: StaticPathModule = { normalize, join, resolve, sep },
): string | null {
  const relative = pathModule.normalize(pathname).replace(/^([/\\])+/, '')
  const requested = pathModule.resolve(pathModule.join(staticDirectory, relative || 'index.html'))
  if (!requested.startsWith(staticDirectory + pathModule.sep) && requested !== staticDirectory) return null
  return requested
}

async function serveStatic(staticDirectory: string, url: string, response: ServerResponse) {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname)
  } catch {
    response.writeHead(400).end()
    return
  }
  const requested = resolveStaticPath(staticDirectory, pathname)
  if (!requested) {
    response.writeHead(404).end()
    return
  }
  try {
    const file = (await stat(requested)).isDirectory() ? join(requested, 'index.html') : requested
    const body = await readFile(file)
    response.writeHead(200, {
      ...LOCAL_VOICE_ISOLATION_HEADERS,
      'content-type': contentType(file),
    })
    response.end(body)
  } catch {
    try {
      const body = await readFile(join(staticDirectory, 'index.html'))
      response.writeHead(200, {
        ...LOCAL_VOICE_ISOLATION_HEADERS,
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  }
}

function contentType(file: string): string {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}
