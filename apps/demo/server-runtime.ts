import { createServer, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { AgentGateway } from '@canvasflow/agent'
import { createAgentHttpHandler, type AgentHttpGateway } from '@canvasflow/agent/http'
import { ModelGateway, modelAdapterOptionsFromEnvironment } from '@canvasflow/agent'
import { messageSendInputSchema } from '@canvasflow/schema'
import {
  PersistentAgentRuntime,
  providerModeFromEnvironment,
  type ProviderFactory,
} from '@canvasflow/agent/persistent'
import { createProviderRegistry, errorResult } from '@canvasflow/tools'
import { createConfiguredVoiceProvider, createVoiceHttpHandler } from './voice-http'
import type { VoiceProvider } from '@canvasflow/tools'

export type AgentServerOptions = {
  staticDirectory?: string
  gateway?: AgentHttpGateway
  voiceProvider?: VoiceProvider
}

export type ConfiguredAgentRuntimeOptions = {
  environment?: NodeJS.ProcessEnv
  providerFactory?: ProviderFactory
}

export const E2E_FAIL_AUTO_MESSAGE_SEND = 'AGENT_E2E_FAIL_AUTO_MESSAGE_SEND'
export const CANVASFLOW_E2E = 'CANVASFLOW_E2E'

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
  if (mode === 'live' && createE2eProviderFactory(environment)) {
    throw new Error(`${E2E_FAIL_AUTO_MESSAGE_SEND} is unavailable in live provider mode`)
  }
  return new PersistentAgentRuntime({
    databasePath: environment.AGENT_DATABASE_PATH ?? '.canvasflow/agent.sqlite',
    mode,
    providerFactory: options.providerFactory ?? createE2eProviderFactory(environment),
    modelGateway: new ModelGateway(modelAdapterOptionsFromEnvironment(environment)),
  })
}

export function createAgentServer(options: AgentServerOptions = {}) {
  const staticDirectory = options.staticDirectory ? resolve(options.staticDirectory) : undefined
  const gateway = options.gateway ?? new AgentGateway()
  const agentHandler = createAgentHttpHandler(gateway)
  let voiceHandler: ReturnType<typeof createVoiceHttpHandler> | undefined
  const getVoiceHandler = () => {
    voiceHandler ??= createVoiceHttpHandler({
      provider: options.voiceProvider,
      createProvider: createConfiguredVoiceProvider,
    })
    return voiceHandler
  }
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
      return
    }
    if (request.url?.split('?', 1)[0] === '/v1/voice/transcriptions') {
      void getVoiceHandler()(request, response)
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
    response.writeHead(200, { 'content-type': contentType(file) })
    response.end(body)
  } catch {
    try {
      const body = await readFile(join(staticDirectory, 'index.html'))
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
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
