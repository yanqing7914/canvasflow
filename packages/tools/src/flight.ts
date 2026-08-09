import {
  flightArrivalsInputSchema,
  flightArrivalsOutputSchema,
  flightStatusInputSchema,
  flightStatusOutputSchema,
  type FlightArrivalsOutput,
  type FlightStatusOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { ARRIVAL_CITY, arrivalBoard, flights, TIMEOUT_FLIGHT_NUMBER } from './data'
import { errorResult, FIXTURE_GENERATED_AT, okResult, type ToolContext } from './result'

const TOOL = 'flight.get-status'
const ARRIVALS_TOOL = 'flight.list-arrivals'

export function getFlightStatus(ctx: ToolContext, input: unknown): ToolResult<FlightStatusOutput> {
  const parsed = flightStatusInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要 flightNumber 和 date', false)
  }

  const flightNumber = parsed.data.flightNumber.toUpperCase()
  const { date } = parsed.data

  if (flightNumber === TIMEOUT_FLIGHT_NUMBER) {
    return errorResult(ctx, TOOL, 'PROVIDER_TIMEOUT', '航班数据源超时', true)
  }

  const flight = flights[flightNumber]
  if (!flight || flight.date !== date) {
    return errorResult(ctx, TOOL, 'FLIGHT_NOT_FOUND', `未找到航班 ${flightNumber}（${date}）`, false)
  }

  return okResult(
    ctx,
    TOOL,
    flightStatusOutputSchema.parse({
      flightNumber: flight.flightNumber,
      status: flight.status,
      scheduledArrival: flight.scheduledArrival,
      estimatedArrival: flight.estimatedArrival,
      arrivalAirport: flight.arrivalAirport,
      arrivalAirportName: flight.arrivalAirportName,
      terminal: flight.terminal,
      baggageClaim: flight.baggageClaim,
      sourceUpdatedAt: flight.sourceUpdatedAt,
    }),
  )
}

/**
 * FNV-1a over a canonical string. Deliberately not imported from the planner's
 * copy: tools sit below the agent, and a hash is cheaper to restate than a
 * dependency edge pointing the wrong way.
 */
function stableHash(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * The identity of one exact board.
 *
 * Derived from the query and from every row's identifying facts — never from a
 * clock or a counter — so the same fixture read always replays to the same id and
 * "相同输入始终返回相同顺序" stays checkable. Status and estimate are folded in on
 * purpose: a board re-read after a delay is genuinely a different set to choose
 * from, and should not be able to pass itself off as the one the driver saw.
 */
function candidateSetId(
  arrivalCityId: string,
  date: string,
  rows: { flightNumber: string; status: string; estimatedArrival: string }[],
): string {
  const canonical = [
    arrivalCityId,
    date,
    ...rows.map((row) => `${row.flightNumber}@${row.status}@${row.estimatedArrival}`),
  ].join('|')
  return `cs-${stableHash(canonical)}`
}

/**
 * The arrivals board for a city on a date — the read that runs before the driver
 * has named a flight.
 *
 * Each row is assembled from the board's own fields plus the `flights` record
 * behind it, so a row can never quote a time the status lookup would contradict.
 * A row whose record is for another date is left out rather than adjusted, which
 * means a date with nothing scheduled answers with an empty board instead of an
 * error: no arrivals is a real answer, and the caller decides how to say it.
 */
export function listFlightArrivals(ctx: ToolContext, input: unknown): ToolResult<FlightArrivalsOutput> {
  const parsed = flightArrivalsInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, ARRIVALS_TOOL, 'INVALID_ARGUMENT', '需要 arrivalCityId 和 date', false)
  }

  const { arrivalCityId, date, limit } = parsed.data
  if (arrivalCityId !== ARRIVAL_CITY.id) {
    return errorResult(ctx, ARRIVALS_TOOL, 'CITY_NOT_FOUND', `未收录该城市的到达航班（${arrivalCityId}）`, false)
  }

  const arrivals = arrivalBoard
    .flatMap((row) => {
      const flight = flights[row.flightNumber]
      if (!flight || flight.date !== date) return []
      return [{
        flightNumber: flight.flightNumber,
        airlineName: row.airlineName,
        originName: row.originName,
        status: flight.status,
        scheduledArrival: flight.scheduledArrival,
        estimatedArrival: flight.estimatedArrival,
        arrivalAirport: flight.arrivalAirport,
        arrivalAirportName: flight.arrivalAirportName,
        terminal: flight.terminal,
      }]
    })
    .slice(0, limit ?? arrivalBoard.length)

  return okResult(
    ctx,
    ARRIVALS_TOOL,
    flightArrivalsOutputSchema.parse({
      arrivalCityId: ARRIVAL_CITY.id,
      arrivalCityName: ARRIVAL_CITY.name,
      candidateSetId: candidateSetId(ARRIVAL_CITY.id, date, arrivals),
      // The board answers for a named day, so that day is when it stops meaning
      // anything — an honest bound that a fixture read can also reproduce. A
      // short rolling TTL would read as more careful and be less true: it would
      // have to come from a clock, and every replay would then disagree with the
      // last. What actually protects a spoken ordinal from a board that changed
      // underneath it is the new id plus the revision bump on refresh; this is
      // the outer edge, not the guard.
      expiresAt: `${date}T23:59:59+08:00`,
      arrivals,
      sourceUpdatedAt: FIXTURE_GENERATED_AT,
    }),
  )
}
