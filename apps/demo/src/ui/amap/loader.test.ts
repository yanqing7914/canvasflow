import { afterEach, describe, expect, it } from 'vitest'
import { loadAMap, __resetAMapLoaderForTest } from './loader'

/**
 * The suite runs with no `VITE_AMAP_JS_KEY`, which is exactly CI's state and the
 * demo's default. The loader must then stay entirely offline: resolve null,
 * inject no script, and reach the network not at all — the guarantee the route
 * panel leans on to show its sketch instead of a half-loaded map.
 */
describe('loadAMap (keyless default)', () => {
  afterEach(() => {
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
