import { fileURLToPath } from 'node:url'
import {
  createAgentServer,
  createConfiguredAgentRuntime,
  loadLocalEnvironment,
  serverHost,
  serverPort,
} from './server-runtime'

// Server-only settings (the AMap security code) live in apps/demo/.env.local,
// which Vite reads only for its VITE_-prefixed client vars. Resolve the file
// against this module rather than the working directory, so the launcher's cwd
// cannot change which file is read. Anything already in the environment wins.
loadLocalEnvironment(fileURLToPath(new URL('.env.local', import.meta.url)))

const host = serverHost()
const port = serverPort()
const runtime = createConfiguredAgentRuntime()
const server = createAgentServer({ staticDirectory: process.env.DEMO_STATIC_DIR, gateway: runtime })

server.on('close', () => runtime.close())

server.listen(port, host, () => {
  console.log(`CanvasFlow Agent API listening on http://${host}:${port}`)
})
