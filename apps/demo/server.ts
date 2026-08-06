import { createAgentServer, createConfiguredAgentRuntime, serverHost, serverPort } from './server-runtime'

const host = serverHost()
const port = serverPort()
const runtime = createConfiguredAgentRuntime()
const server = createAgentServer({ staticDirectory: process.env.DEMO_STATIC_DIR, gateway: runtime })

server.on('close', () => runtime.close())

server.listen(port, host, () => {
  console.log(`CanvasFlow Agent API listening on http://${host}:${port}`)
})
