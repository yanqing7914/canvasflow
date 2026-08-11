import { describe, expect, it } from 'vitest'
import { generateRuntimeCalendar, listUpcomingEvents } from './calendar'
import type { ToolContext } from './result'

const ctx: ToolContext = { taskId: 'pickup-001' }

describe('calendar.list-upcoming', () => {
  it('builds the runtime day in Asia/Shanghai with all three requested statuses', () => {
    expect(generateRuntimeCalendar({ date: '2026-08-11', now: '2026-08-11T14:30:00+08:00' }).events).toEqual([
      expect.objectContaining({ title: 'her开发日会', startAt: '2026-08-11T10:00:00+08:00', endAt: '2026-08-11T11:00:00+08:00', status: 'ended' }),
      expect.objectContaining({ title: '新建her', startAt: '2026-08-11T14:00:00+08:00', endAt: '2026-08-11T15:00:00+08:00', status: 'ongoing' }),
      expect.objectContaining({ title: 'A2A调研', startAt: '2026-08-11T16:00:00+08:00', endAt: '2026-08-11T17:00:00+08:00', status: 'upcoming' }),
    ])
  })
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
