import { spawn } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const commands = [
  ['agent', ['run', 'agent', '--workspace', '@canvasflow/demo']],
  ['vite', ['run', 'dev', '--workspace', '@canvasflow/demo']],
]

const children = commands.map(([name, args]) => {
  const child = spawn(npm, args, { stdio: 'inherit', env: process.env })
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