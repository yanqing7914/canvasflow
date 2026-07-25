import { createAgentServer, serverHost, serverPort } from './server-runtime'

const host = serverHost()
const port = serverPort()
const server = createAgentServer({ staticDirectory: process.env.DEMO_STATIC_DIR })

server.listen(port, host, () => {
  console.log(`CanvasFlow Agent API listening on http://${host}:${port}`)
})
