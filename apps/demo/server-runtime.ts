import { createServer, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { AgentGateway } from '@canvasflow/agent'
import { createAgentHttpHandler } from '@canvasflow/agent/http'

export type AgentServerOptions = {
  staticDirectory?: string
  gateway?: AgentGateway
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
