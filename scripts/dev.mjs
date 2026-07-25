import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webCommand = process.argv[2] === 'preview' ? 'preview' : 'dev'
const commands = webCommand === 'preview'
  ? [['preview', ['run', 'agent', '--workspace', '@canvasflow/demo'], {
      ...process.env,
      AGENT_PORT: process.env.AGENT_PORT ?? '4173',
      DEMO_STATIC_DIR: process.env.DEMO_STATIC_DIR ?? resolve(repositoryRoot, 'apps/demo/dist'),
    }]]
  : [
      ['agent', ['run', 'agent', '--workspace', '@canvasflow/demo'], process.env],
      ['vite', ['run', 'dev', '--workspace', '@canvasflow/demo'], process.env],
    ]

const children = commands.map(([name, args, env]) => {
  const child = spawn(npm, args, { stdio: 'inherit', env })
  child.on('exit', (code, signal) => {
    if (stopping) return
    if (code !== 0 && signal === null) {
      console.error(`${name} exited with code ${code ?? 'unknown'}`)
      stop(code ?? 1)
    }
  })
  return child
})

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 100)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
