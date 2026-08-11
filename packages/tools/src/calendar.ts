import {
  type ListUpcomingEventsOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { z } from 'zod'
import { calendarEvents } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'calendar.list-upcoming'

const calendarInputSchema = z.object({ date: z.iso.date(), now: z.iso.datetime({ offset: true }).optional() })
const calendarOutputSchema = z.object({
  events: z.array(z.object({
    eventId: z.string().min(1), title: z.string().min(1), startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }).optional(), location: z.string().min(1).optional(),
    status: z.enum(['ended', 'ongoing', 'upcoming']).optional(),
  })),
})

const runtimeEvents = [
  { eventId: 'event-her-daily', title: 'her开发日会', start: '10:00', end: '11:00' },
  { eventId: 'event-create-her', title: '新建her', start: '14:00', end: '15:00' },
  { eventId: 'event-a2a-research', title: 'A2A调研', start: '16:00', end: '17:00' },
] as const

export function generateRuntimeCalendar(input: { date: string; now: string }): ListUpcomingEventsOutput {
  const nowMs = Date.parse(input.now)
  if (Number.isNaN(nowMs)) throw new TypeError('now must be an ISO datetime')
  return calendarOutputSchema.parse({
    events: runtimeEvents.map((event) => {
      const startAt = `${input.date}T${event.start}:00+08:00`
      const endAt = `${input.date}T${event.end}:00+08:00`
      const status = nowMs >= Date.parse(endAt) ? 'ended' : nowMs >= Date.parse(startAt) ? 'ongoing' : 'upcoming'
      return { eventId: event.eventId, title: event.title, startAt, endAt, status }
    }),
  })
}

export function listUpcomingEvents(ctx: ToolContext, input: unknown): ToolResult<ListUpcomingEventsOutput> {
  const parsed = calendarInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要 date', false)
  }

  if (parsed.data.now) {
    return okResult(ctx, TOOL, generateRuntimeCalendar({ date: parsed.data.date, now: parsed.data.now }))
  }

  // Every fixture timestamp carries the same +08:00 offset, so lexicographic
  // order on the ISO strings is chronological order.
  const events = calendarEvents
    .filter((event) => event.date === parsed.data.date)
    .map((event) => ({
      eventId: event.eventId,
      title: event.title,
      startAt: event.startAt,
      ...(event.endAt ? { endAt: event.endAt } : {}),
      ...(event.location ? { location: event.location } : {}),
    }))
    .sort((left, right) => left.startAt.localeCompare(right.startAt))

  return okResult(ctx, TOOL, calendarOutputSchema.parse({ events }))
}
