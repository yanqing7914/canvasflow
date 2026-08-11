import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidateAMap, loadAMap, __resetAMapLoaderForTest, type AMapApi } from './loader'

const amap = {} as AMapApi
const amapWindow = window as typeof window & { AMap?: AMapApi; _AMapSecurityConfig?: unknown }

function setKeys(multiple = '', single = ''): void {
  vi.stubEnv('VITE_AMAP_JS_KEYS', multiple)
  vi.stubEnv('VITE_AMAP_JS_KEY', single)
}

function script(): HTMLScriptElement {
  return document.getElementById('amap-js-api') as HTMLScriptElement
}

function succeed(target = script()): void {
  amapWindow.AMap = amap
  target.dispatchEvent(new Event('load'))
}

describe('loadAMap', () => {
  afterEach(() => {
    __resetAMapLoaderForTest()
    document.getElementById('amap-js-api')?.remove()
    delete amapWindow.AMap
    delete amapWindow._AMapSecurityConfig
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('stays offline when no key is configured', async () => {
    setKeys()
    await expect(loadAMap()).resolves.toBeNull()
    expect(document.getElementById('amap-js-api')).toBeNull()
    expect(amapWindow._AMapSecurityConfig).toBeUndefined()
  })

  it('keeps the single-key variable compatible', async () => {
    setKeys('', 'single-key')
    const loading = loadAMap()
    expect(script().src).toContain('key=single-key')
    succeed()
    await expect(loading).resolves.toBe(amap)
  })

  it('is single-flight and injects one script for concurrent callers', async () => {
    setKeys('first-key,second-key')
    const first = loadAMap()
    const second = loadAMap()
    expect(first).toBe(second)
    expect(document.querySelectorAll('#amap-js-api')).toHaveLength(1)
    succeed()
    await expect(first).resolves.toBe(amap)
  })

  it('rotates after a failed script and succeeds with the next key', async () => {
    setKeys('first-key, second-key')
    const loading = loadAMap()
    const first = script()
    expect(first.src).toContain('key=first-key')
    first.dispatchEvent(new Event('error'))
    await Promise.resolve()
    expect(script()).not.toBe(first)
    expect(script().src).toContain('key=second-key')
    succeed()
    await expect(loading).resolves.toBe(amap)
  })

  it('resolves null and removes the script after every key fails', async () => {
    setKeys('first-key,second-key')
    const loading = loadAMap()
    script().dispatchEvent(new Event('error'))
    await Promise.resolve()
    script().dispatchEvent(new Event('error'))
    await expect(loading).resolves.toBeNull()
    expect(document.getElementById('amap-js-api')).toBeNull()
    expect(amapWindow.AMap).toBeUndefined()
  })

  it('lets manual retry use the same key and manual switch advance', async () => {
    setKeys('first-key,second-key')
    const firstLoad = loadAMap()
    script().dispatchEvent(new Event('error'))
    await Promise.resolve()
    script().dispatchEvent(new Event('error'))
    await firstLoad

    invalidateAMap({ rotate: false })
    const retry = loadAMap()
    expect(script().src).toContain('key=first-key')
    invalidateAMap()
    const switched = loadAMap()
    expect(script().src).toContain('key=second-key')
    succeed()
    await expect(switched).resolves.toBe(amap)
    await expect(retry).resolves.toBeNull()
  })

  it('ignores a stale attempt without removing a newer script or global', async () => {
    vi.useFakeTimers()
    setKeys('first-key,second-key')
    const staleLoad = loadAMap()
    const staleScript = script()

    invalidateAMap()
    const freshLoad = loadAMap()
    const freshScript = script()
    expect(freshScript).not.toBe(staleScript)
    succeed(freshScript)
    await expect(freshLoad).resolves.toBe(amap)

    staleScript.dispatchEvent(new Event('error'))
    await vi.advanceTimersByTimeAsync(3000)
    await expect(staleLoad).resolves.toBeNull()
    expect(amapWindow.AMap).toBe(amap)
    expect(document.getElementById('amap-js-api')).toBe(freshScript)
  })
})
