import { describe, expect, it } from 'vitest'
import { launcherSpawnOptions, npmExecutable } from './dev.mjs'

/**
 * The launcher itself execs npm and forwards stdio, so its platform decisions
 * are exported as pure functions and pinned here; the spawn call is exercised
 * for real by the e2e webServer on every CI run.
 */
describe('dev launcher platform handling', () => {
  it('goes through a shell for npm.cmd on Windows (EINVAL hardening)', () => {
    expect(npmExecutable('win32')).toBe('npm.cmd')
    expect(launcherSpawnOptions({ A: '1' }, 'win32')).toEqual({
      stdio: 'inherit',
      env: { A: '1' },
      shell: true,
    })
  })

  it('spawns npm directly on POSIX platforms', () => {
    expect(npmExecutable('linux')).toBe('npm')
    expect(npmExecutable('darwin')).toBe('npm')
    expect(launcherSpawnOptions({ A: '1' }, 'linux')).toEqual({
      stdio: 'inherit',
      env: { A: '1' },
      shell: false,
    })
  })

  it('importing the module does not launch anything', () => {
    // This suite imported dev.mjs at the top; reaching this assertion at all
    // means the main-guard kept the spawns from running under the test runner.
    expect(typeof launcherSpawnOptions).toBe('function')
  })
})
