import { describe, expect, it } from 'vitest'
import type { CockpitWindowSpec } from './contracts'
import { createWindowManagerState, windowManagerReducer } from './window-manager'

const viewport = { width: 1280, height: 720 }

function windowSpec(id: string, kind: CockpitWindowSpec['kind'] = 'weather'): CockpitWindowSpec {
  return {
    id,
    kind,
    title: `${id}窗口`,
    componentIds: [],
    size: 'medium',
    controls: { closable: true, minimizable: true, maximizable: true },
  }
}

describe('window manager reducer', () => {
  it('opens every new window at the same top-right position and keeps older windows', () => {
    let state = windowManagerReducer(createWindowManagerState(), { type: 'sync', specs: [windowSpec('one')], viewport })
    state = windowManagerReducer(state, { type: 'sync', specs: [windowSpec('two')], viewport })
    expect(state.windows).toHaveLength(2)
    expect(state.windows[0]).toMatchObject({ x: 816, y: 84 })
    expect(state.windows[1]).toMatchObject({ x: 816, y: 84 })
    expect(state.windows[1]!.zIndex).toBeGreaterThan(state.windows[0]!.zIndex)
  })

  it('focuses, moves and clamps a window', () => {
    let state = windowManagerReducer(createWindowManagerState(), { type: 'sync', specs: [windowSpec('one'), windowSpec('two')], viewport })
    state = windowManagerReducer(state, { type: 'focus', id: 'one' })
    expect(state.windows[0]!.zIndex).toBeGreaterThan(state.windows[1]!.zIndex)
    state = windowManagerReducer(state, { type: 'move', id: 'one', x: -900, y: 900, viewport })
    expect(state.windows[0]).toMatchObject({ x: 16, y: 664 })
  })

  it('minimizes, restores and maximizes independently', () => {
    let state = windowManagerReducer(createWindowManagerState(), { type: 'sync', specs: [windowSpec('one'), windowSpec('two')], viewport })
    state = windowManagerReducer(state, { type: 'minimize', id: 'one' })
    expect(state.windows.map((window) => window.mode)).toEqual(['minimized', 'normal'])
    state = windowManagerReducer(state, { type: 'restore', id: 'one' })
    expect(state.windows[0]!.mode).toBe('normal')
    state = windowManagerReducer(state, { type: 'toggle-maximize', id: 'one' })
    expect(state.windows[0]!.mode).toBe('maximized')
    state = windowManagerReducer(state, { type: 'toggle-maximize', id: 'one' })
    expect(state.windows[0]!.mode).toBe('normal')
  })

  it('closes with a tombstone, reopens a new same-kind id and clears completion state', () => {
    let state = windowManagerReducer(createWindowManagerState(), { type: 'sync', specs: [windowSpec('weather-1')], viewport })
    state = windowManagerReducer(state, { type: 'close', id: 'weather-1' })
    state = windowManagerReducer(state, { type: 'sync', specs: [windowSpec('weather-1'), windowSpec('weather-2')], viewport })
    expect(state.windows.map((window) => window.spec.id)).toEqual(['weather-2'])
    expect(state.tombstones).toEqual(['weather-1'])
    state = windowManagerReducer(state, { type: 'clear' })
    expect(state).toEqual(createWindowManagerState())
  })

  it('can synchronize server-owned windows away', () => {
    let state = windowManagerReducer(createWindowManagerState(), { type: 'sync', specs: [windowSpec('one'), windowSpec('two')], viewport })
    state = windowManagerReducer(state, { type: 'sync', specs: [windowSpec('two')], viewport, preserveMissing: false })
    expect(state.windows.map((window) => window.spec.id)).toEqual(['two'])
  })
})
