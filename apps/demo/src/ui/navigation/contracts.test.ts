import { describe, expect, it } from 'vitest'
import type { UISpec } from '@canvasflow/schema'
import { workspaceWindows } from './contracts'

function spec(overrides: Partial<UISpec> = {}): UISpec {
  return {
    version: '1.0',
    taskId: 'task-1',
    surfaceId: 'surface-1',
    taskRevision: 1,
    uiRevision: 1,
    phase: 'choosing-flight',
    title: '机场接人',
    presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'normal' },
    layout: { type: 'stack', gap: 'sm', slots: { main: ['content'] } },
    components: [{ id: 'content', type: 'status-banner', props: { level: 'info', title: '内容' } }],
    actions: [],
    meta: {
      generatedBy: 'composer', sourceTaskRevision: 1,
      generatedAt: '2026-08-13T09:00:00+08:00', traceId: 'trace-1', requiresConfirm: false,
    },
    ...overrides,
  }
}

describe('workspaceWindows', () => {
  it('honours an explicit empty server-owned window list', () => {
    expect(workspaceWindows({ ...spec(), windows: [] } as UISpec)).toEqual([])
  })

  it('keeps the legacy navigation summary while moving route geometry to the persistent map', () => {
    const navigation = spec({
      phase: 'driving-to-airport',
      layout: { type: 'split', ratio: [1, 1], slots: { primary: ['map'], secondary: ['summary'] } },
      components: [
        { id: 'map', type: 'route-map', props: { mode: 'follow', destination: '虹桥机场', routeSketch: { waypoints: [], polyline: [] } } },
        { id: 'summary', type: 'navigation-summary', props: { routeId: 'route-1', destination: '虹桥机场', eta: '2026-08-13T10:00:00+08:00', distanceKm: 12, estimatedBatteryAtArrival: 30 } },
      ],
    })

    expect(workspaceWindows(navigation)).toEqual([
      expect.objectContaining({ componentIds: ['summary'] }),
    ])
  })
})
