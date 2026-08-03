import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The npm executable name Windows actually resolves: npm ships as npm.cmd there. */
export function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

/**
 * Spawn options for one launcher child. On Windows the spawn must go through a
 * shell: Node refuses to spawn .cmd files directly (EINVAL) since the
 * CVE-2024-27980 hardening, which is exactly how `npm run dev`/`preview` used
 * to die there before it started anything.
 */
export function launcherSpawnOptions(env, platform = process.platform) {
  return { stdio: 'inherit', env, shell: platform === 'win32' }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const npm = npmExecutable()
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

  let stopping = false
  const stop = (code = 0) => {
    if (stopping) return
    stopping = true
    for (const child of children) child.kill('SIGTERM')
    setTimeout(() => process.exit(code), 100)
  }

  const children = commands.map(([name, args, env]) => {
    const child = spawn(npm, args, launcherSpawnOptions(env))
    child.on('exit', (code, signal) => {
      if (stopping) return
      if (code !== 0 && signal === null) {
        console.error(`${name} exited with code ${code ?? 'unknown'}`)
        stop(code ?? 1)
      }
    })
    return child
  })

  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
}
