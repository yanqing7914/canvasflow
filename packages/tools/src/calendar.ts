import {
  listUpcomingEventsInputSchema,
  listUpcomingEventsOutputSchema,
  type ListUpcomingEventsOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { calendarEvents } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'calendar.list-upcoming'

export function listUpcomingEvents(ctx: ToolContext, input: unknown): ToolResult<ListUpcomingEventsOutput> {
  const parsed = listUpcomingEventsInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要 date', false)
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

  return okResult(ctx, TOOL, listUpcomingEventsOutputSchema.parse({ events }))
}
