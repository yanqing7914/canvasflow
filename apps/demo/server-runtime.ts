import { createServer, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { AgentGateway } from '@canvasflow/agent'
import { createAgentHttpHandler, type AgentHttpGateway } from '@canvasflow/agent/http'
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
  })
}

export function createAgentServer(options: AgentServerOptions = {}) {
  const staticDirectory = options.staticDirectory ? resolve(options.staticDirectory) : undefined
  const gateway = options.gateway ?? new AgentGateway()
  const agentHandler = createAgentHttpHandler(gateway)
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
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

async function serveStatic(staticDirectory: string, url: string, response: ServerResponse) {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname)
  } catch {
    response.writeHead(400).end()
    return
  }
  const relative = normalize(pathname).replace(/^([/\\])+/, '')
  const requested = resolve(join(staticDirectory, relative || 'index.html'))
  if (!requested.startsWith(`${staticDirectory}/`) && requested !== staticDirectory) {
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
