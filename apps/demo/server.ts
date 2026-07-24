import { createServer } from 'node:http'
import { AgentGateway } from '@canvasflow/agent'
import { createAgentHttpHandler } from '@canvasflow/agent/http'

const port = Number(process.env.AGENT_PORT ?? 8787)
const gateway = new AgentGateway()
const agentHandler = createAgentHttpHandler(gateway)
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  void agentHandler(request, response)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`CanvasFlow Agent API listening on http://127.0.0.1:${port}`)
})
