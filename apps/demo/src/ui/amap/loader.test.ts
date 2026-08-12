import { afterEach, describe, expect, it, vi } from 'vitest'
import { amapLoaderSnapshot, invalidateAMap, loadAMap, retryAMap, switchAMapKey, __resetAMapLoaderForTest, __setAMapKeysForTest, type AMapApi } from './loader'

const amap = {} as AMapApi
const amapWindow = window as typeof window & { AMap?: AMapApi; _AMapSecurityConfig?: unknown }
const script = () => document.getElementById('amap-js-api') as HTMLScriptElement
const succeed = (target = script()) => { amapWindow.AMap = amap; target.dispatchEvent(new Event('load')) }

describe('loadAMap', () => {
  afterEach(() => {
    __resetAMapLoaderForTest()
    document.getElementById('amap-js-api')?.remove()
    delete amapWindow.AMap
    delete amapWindow._AMapSecurityConfig
    vi.useRealTimers()
  })

  it('stays offline and publishes failure when no key is configured', async () => {
    __setAMapKeysForTest([])
    await expect(loadAMap()).resolves.toBeNull()
    expect(document.getElementById('amap-js-api')).toBeNull()
    expect(amapLoaderSnapshot()).toEqual({ state: 'failed', keyCount: 0 })
  })

  it('keeps single-key compatibility and injects once for concurrent callers', async () => {
    __setAMapKeysForTest(['single-key'])
    const first = loadAMap()
    const second = loadAMap()
    expect(first).toBe(second)
    expect(document.querySelectorAll('#amap-js-api')).toHaveLength(1)
    expect(script().src).toContain('key=single-key')
    succeed()
    await expect(first).resolves.toBe(amap)
    expect(amapLoaderSnapshot()).toMatchObject({ state: 'ready', keyIndex: 0, keyCount: 1 })
  })

  it('rotates automatically after a failed script', async () => {
    __setAMapKeysForTest(['first-key', 'second-key'])
    const loading = loadAMap()
    const first = script()
    first.dispatchEvent(new Event('error'))
    await Promise.resolve()
    expect(script()).not.toBe(first)
    expect(script().src).toContain('key=second-key')
    succeed()
    await expect(loading).resolves.toBe(amap)
    expect(amapLoaderSnapshot()).toMatchObject({ state: 'ready', keyIndex: 1, keyCount: 2 })
  })

  it('resolves null and removes the script after all keys fail', async () => {
    __setAMapKeysForTest(['first-key', 'second-key'])
    const loading = loadAMap()
    script().dispatchEvent(new Event('error'))
    await Promise.resolve()
    script().dispatchEvent(new Event('error'))
    await expect(loading).resolves.toBeNull()
    expect(document.getElementById('amap-js-api')).toBeNull()
    expect(amapLoaderSnapshot().state).toBe('failed')
  })

  it('supports manual retry on the same key and explicit key switching', async () => {
    __setAMapKeysForTest(['first-key', 'second-key'])
    const firstLoad = loadAMap()
    script().dispatchEvent(new Event('error'))
    await Promise.resolve()
    script().dispatchEvent(new Event('error'))
    await firstLoad
    const retried = retryAMap()
    expect(script().src).toContain('key=first-key')
    invalidateAMap({ rotate: false })
    await expect(retried).resolves.toBeNull()
    const switched = switchAMapKey()
    expect(script().src).toContain('key=second-key')
    succeed()
    await expect(switched).resolves.toBe(amap)
  })

  it('does not let stale timeout/error remove a newer successful generation', async () => {
    vi.useFakeTimers()
    __setAMapKeysForTest(['first-key', 'second-key'])
    const stale = loadAMap()
    const staleScript = script()
    const fresh = switchAMapKey()
    const freshScript = script()
    succeed(freshScript)
    await expect(fresh).resolves.toBe(amap)
    staleScript.dispatchEvent(new Event('error'))
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(stale).resolves.toBeNull()
    expect(amapWindow.AMap).toBe(amap)
    expect(document.getElementById('amap-js-api')).toBe(freshScript)
  })
})
