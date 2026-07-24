import { describe, expect, it } from 'vitest'
import { componentSpecSchema, uiSpecSchema } from './ui'

describe('UISpec', () => {
  it('rejects stale source revisions', () => {
    const result = uiSpecSchema.safeParse({
      version: '1.0', taskId: 'task', surfaceId: 'surface', taskRevision: 2, uiRevision: 3,
      phase: 'preparing', title: 'Pickup',
      presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
      layout: { type: 'stack', gap: 'md', slots: { main: [] } }, components: [], actions: [],
      meta: { generatedBy: 'composer', sourceTaskRevision: 1, requiresConfirm: false, generatedAt: '2026-07-22T12:00:00+08:00', traceId: 'trace' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects cabin-profile cards with no applied preference value', () => {
    const empty = componentSpecSchema.safeParse({
      id: 'cabin',
      type: 'cabin-profile',
      props: { zone: 'rear', appliedFromMemory: true, reversible: true },
    })
    expect(empty.success).toBe(false)

    const mediaOnly = componentSpecSchema.safeParse({
      id: 'cabin',
      type: 'cabin-profile',
      props: { zone: 'rear', mediaTitle: '豆豆故事', appliedFromMemory: true, reversible: true },
    })
    expect(mediaOnly.success).toBe(true)
  })
})
