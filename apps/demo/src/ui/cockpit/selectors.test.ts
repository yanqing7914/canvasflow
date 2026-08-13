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

function componentSpec(phase: CockpitUISpec['phase'], component: UISpec['components'][number]): UISpec {
  return {
    ...spec(phase),
    components: [component],
    actions: component.actions?.map((id) => ({ id, label: id, style: 'primary' as const, event: { type: 'agent-message' as const, text: id } })) ?? [],
  } as UISpec
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

  it('advances the primary window by phase without reopening historical task windows', () => {
    const flights = { id: 'flights', kind: 'flight-list' as const, title: '到达航班', componentIds: [], size: 'large' as const, controls }
    const confirmation = { id: 'outbound', kind: 'outbound-confirmation' as const, title: '现在出发', componentIds: [], size: 'medium' as const, controls }
    const weather = { id: 'weather', kind: 'weather' as const, title: '天气', componentIds: [], size: 'compact' as const, controls }
    const view = deriveCockpitView(spec('confirming-outbound', [flights, weather, confirmation]))

    expect(view.primaryWindow).toEqual(confirmation)
    expect(view.auxiliaryWindows).toEqual([weather])
  })

  it('prioritizes navigation and terminal modes over window contents', () => {
    const weather = { id: 'weather', kind: 'weather' as const, title: '天气', componentIds: [], size: 'compact' as const, controls }
    expect(deriveCockpitView(spec('driving-to-airport', [weather])).mode).toBe('navigation')
    expect(deriveCockpitView(spec('waiting-for-passengers', [weather])).mode).toBe('navigation')
    expect(deriveCockpitView(spec('completed', [weather])).mode).toBe('terminal')
  })

  it('keeps a non-navigation task in the primary mode without a declared window', () => {
    const view = deriveCockpitView(spec('collecting-information'))
    expect(view.mode).toBe('primary')
    expect(view.primaryWindow).toBeUndefined()
    expect(view.auxiliaryWindows).toEqual([])
  })

  it('derives a primary flight window when the server explicitly has no auxiliary windows', () => {
    const view = deriveCockpitView(componentSpec('choosing-flight', {
      id: 'flight-choices',
      type: 'flight-choices',
      props: {
        arrivalCityName: '上海',
        dateLabel: '今天',
        choices: [
          {
            flightNumber: 'MU5102', airlineName: '东方航空', originName: '上海',
            status: 'scheduled', statusLabel: '计划', arrivalTimeLabel: '14:20',
            terminal: 'T1', airportName: '虹桥机场', actionId: 'pick-MU5102',
          },
          {
            flightNumber: 'CA1887', airlineName: '中国国航', originName: '北京',
            status: 'scheduled', statusLabel: '计划', arrivalTimeLabel: '14:28',
            terminal: 'T2', airportName: '浦东机场', actionId: 'pick-CA1887',
          },
        ],
        freshness: 'fixture',
      },
      actions: [],
    }))

    expect(view.primaryWindow).toEqual(expect.objectContaining({
      kind: 'flight-list',
      componentIds: ['flight-choices'],
    }))
    expect(view.auxiliaryWindows).toEqual([])
  })

  it('derives outbound confirmation content without inventing an auxiliary window', () => {
    const view = deriveCockpitView(componentSpec('confirming-outbound', {
      id: 'outbound-confirmation',
      type: 'route-confirmation',
      props: { leg: 'outbound', destination: '虹桥机场', durationMinutes: 20, arrivalTime: '2026-08-13T10:00:00+08:00', distanceKm: 20, currentBatteryPercent: 42, estimatedBatteryAtArrival: 30, simulated: true },
      actions: ['start-outbound'],
    }))

    expect(view.primaryWindow?.kind).toBe('outbound-confirmation')
    expect(view.auxiliaryWindows).toEqual([])
  })
})
