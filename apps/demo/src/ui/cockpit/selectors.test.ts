import type { UISpec } from '@canvasflow/schema'
import { describe, expect, it } from 'vitest'
import { deriveCockpitView } from './selectors'
import type { CockpitUISpec } from '../navigation/contracts'

function spec(phase: CockpitUISpec['phase'], windows: NonNullable<CockpitUISpec['windows']> = []): UISpec {
  return {
    version: '1.0', taskId: 'task-1', surfaceId: 'surface-1', taskRevision: 1, uiRevision: 1,
    phase, title: '接机',
    presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'normal' },
    layout: { type: 'stack', gap: 'sm', slots: { main: [] } }, components: [], actions: [], windows,
    meta: { generatedBy: 'composer', sourceTaskRevision: 1, requiresConfirm: false, generatedAt: '2026-08-12T10:00:00+08:00', traceId: 'trace-1' },
  } as CockpitUISpec
}

const controls = { closable: true, minimizable: true, maximizable: true }

describe('deriveCockpitView', () => {
  it('treats an absent spec as the idle cockpit', () => {
    expect(deriveCockpitView()).toEqual({ mode: 'idle', auxiliaryWindows: [] })
  })

  it('selects the primary task window and leaves auxiliary windows separate', () => {
    const primary = { id: 'flights', kind: 'flight-list' as const, title: '到达航班', componentIds: [], size: 'medium' as const, controls }
    const weather = { id: 'weather', kind: 'weather' as const, title: '天气', componentIds: [], size: 'compact' as const, controls }
    const view = deriveCockpitView(spec('choosing-flight', [weather, primary]))
    expect(view.mode).toBe('primary')
    expect(view.primaryWindow).toEqual(primary)
    expect(view.auxiliaryWindows).toEqual([weather])
  })

  it('prioritizes navigation and terminal modes over window contents', () => {
    const weather = { id: 'weather', kind: 'weather' as const, title: '天气', componentIds: [], size: 'compact' as const, controls }
    expect(deriveCockpitView(spec('driving-to-airport', [weather])).mode).toBe('navigation')
    expect(deriveCockpitView(spec('completed', [weather])).mode).toBe('terminal')
  })

  it('keeps a non-navigation task in the primary mode without a declared window', () => {
    const view = deriveCockpitView(spec('collecting-information'))
    expect(view.mode).toBe('primary')
    expect(view.primaryWindow).toBeUndefined()
    expect(view.auxiliaryWindows).toEqual([])
  })
})
