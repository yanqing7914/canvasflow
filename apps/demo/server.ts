import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { AgentGateway } from '@canvasflow/agent'
import { createAgentHttpHandler } from '@canvasflow/agent/http'

const port = Number(process.env.AGENT_PORT ?? 8787)
const staticDirectory = process.env.DEMO_STATIC_DIR ? resolve(process.env.DEMO_STATIC_DIR) : undefined
const gateway = new AgentGateway()
const agentHandler = createAgentHttpHandler(gateway)
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  if (staticDirectory && request.method === 'GET' && !request.url?.startsWith('/v1/')) {
    void serveStatic(request.url ?? '/', response)
    return
  }
  void agentHandler(request, response)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`CanvasFlow Agent API listening on http://127.0.0.1:${port}`)
})

async function serveStatic(url: string, response: import('node:http').ServerResponse) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname)
  const relative = normalize(pathname).replace(/^([/\\])+/, '')
  const requested = resolve(join(staticDirectory!, relative || 'index.html'))
  if (!requested.startsWith(`${staticDirectory!}/`) && requested !== staticDirectory) {
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
      const body = await readFile(join(staticDirectory!, 'index.html'))
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