import { describe, expect, it } from 'vitest'
import { listUpcomingEvents } from './calendar'
import type { ToolContext } from './result'

const ctx: ToolContext = { taskId: 'pickup-001' }

describe('calendar.list-upcoming', () => {
  it('returns only the requested day, ordered by start time', () => {
    const result = listUpcomingEvents(ctx, { date: '2026-07-22' })

    expect(result.ok).toBe(true)
    expect(result.data?.events).toEqual([
      expect.objectContaining({
        eventId: 'event-bedtime-story',
        title: '豆豆的睡前故事',
        startAt: '2026-07-22T21:30:00+08:00',
        location: '家',
      }),
      expect.objectContaining({
        eventId: 'event-project-review',
        title: '项目评审',
        startAt: '2026-07-22T21:40:00+08:00',
        location: '线上',
      }),
    ])
  })

  it('answers an empty day with an empty list, not an error', () => {
    const result = listUpcomingEvents(ctx, { date: '2026-07-24' })

    expect(result.ok).toBe(true)
    expect(result.data?.events).toEqual([])
  })

  it('rejects a request without a date', () => {
    const result = listUpcomingEvents(ctx, {})

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })
})
