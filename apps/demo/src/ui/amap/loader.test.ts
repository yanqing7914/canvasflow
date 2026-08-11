import { afterEach, describe, expect, it } from 'vitest'
import { loadAMap, retryAMap, switchAMapKey, __resetAMapLoaderForTest, __setAMapKeysForTest } from './loader'

/**
 * The suite runs with no `VITE_AMAP_JS_KEY`, which is exactly CI's state and the
 * demo's default. The loader must then stay entirely offline: resolve null,
 * inject no script, and reach the network not at all — the guarantee the route
 * panel leans on to show its sketch instead of a half-loaded map.
 */
describe('loadAMap (keyless default)', () => {
  afterEach(() => {
    __setAMapKeysForTest(undefined)
    __resetAMapLoaderForTest()
    document.getElementById('amap-js-api')?.remove()
    delete (window as { _AMapSecurityConfig?: unknown })._AMapSecurityConfig
  })

  it('resolves null without injecting a script when no key is configured', async () => {
    await expect(loadAMap()).resolves.toBeNull()
    expect(document.getElementById('amap-js-api')).toBeNull()
  })

  it('does not set the security service host in the keyless state', async () => {
    await loadAMap()
    expect((window as { _AMapSecurityConfig?: unknown })._AMapSecurityConfig).toBeUndefined()
  })

  it('is single-flight: repeated calls share one resolution', async () => {
    const first = loadAMap()
    const second = loadAMap()
    expect(first).toBe(second)
    await expect(first).resolves.toBeNull()
  })
})

describe('loadAMap key rotation', () => {
  afterEach(() => {
    __setAMapKeysForTest(undefined)
    __resetAMapLoaderForTest()
    delete (window as { AMap?: unknown }).AMap
  })

  it('keeps single-key compatibility and single-flight injection', async () => {
    __setAMapKeysForTest(['first'])
    const first = loadAMap()
    const second = loadAMap()
    expect(first).toBe(second)
    const script = document.getElementById('amap-js-api') as HTMLScriptElement
    expect(script.src).toContain('key=first')
    ;(window as { AMap?: unknown }).AMap = { Map: class {} }
    script.dispatchEvent(new Event('load'))
    await expect(first).resolves.toBe((window as { AMap?: unknown }).AMap)
  })

  it('cleans the failed script and tries the next key', async () => {
    __setAMapKeysForTest(['first', 'second'])
    const result = loadAMap()
    const first = document.getElementById('amap-js-api') as HTMLScriptElement
    expect(first.src).toContain('key=first')
    first.dispatchEvent(new Event('error'))
    await Promise.resolve()
    const second = document.getElementById('amap-js-api') as HTMLScriptElement
    expect(second).not.toBe(first)
    expect(second.src).toContain('key=second')
    ;(window as { AMap?: unknown }).AMap = { Map: class {} }
    second.dispatchEvent(new Event('load'))
    await expect(result).resolves.toBe((window as { AMap?: unknown }).AMap)
  })

  it('recovers after all keys fail through manual retry or switch', async () => {
    __setAMapKeysForTest(['first', 'second'])
    const failed = loadAMap()
    document.getElementById('amap-js-api')?.dispatchEvent(new Event('error'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const secondAttempt = document.getElementById('amap-js-api')
    expect(secondAttempt).not.toBeNull()
    secondAttempt?.dispatchEvent(new Event('error'))
    await expect(failed).resolves.toBeNull()
    expect(document.getElementById('amap-js-api')).toBeNull()

    const retried = switchAMapKey()
    const script = document.getElementById('amap-js-api') as HTMLScriptElement
    expect(script.src).toContain('key=second')
    ;(window as { AMap?: unknown }).AMap = { Map: class {} }
    script.dispatchEvent(new Event('load'))
    await expect(retried).resolves.toBeTruthy()
    const recovered = retryAMap()
    const recoveryScript = document.getElementById('amap-js-api') as HTMLScriptElement
    ;(window as { AMap?: unknown }).AMap = { Map: class {} }
    recoveryScript.dispatchEvent(new Event('load'))
    await expect(recovered).resolves.toBeTruthy()
  })
})
