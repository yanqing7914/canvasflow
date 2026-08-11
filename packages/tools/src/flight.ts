import {
  flightStatusInputSchema,
  flightStatusOutputSchema,
  type FlightArrivalCandidate,
  type FlightArrivalsOutput,
  type FlightStatusOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { z } from 'zod'
import { ARRIVAL_CITY, arrivalBoard, flights, TIMEOUT_FLIGHT_NUMBER } from './data'
import { errorResult, FIXTURE_GENERATED_AT, okResult, type ToolContext } from './result'

const TOOL = 'flight.get-status'
const ARRIVALS_TOOL = 'flight.list-arrivals'

const cockpitPickupAirportSchema = z.object({
  label: z.string().trim().min(1).max(80),
  code: z.enum(['SHA', 'PVG']).optional(),
}).strict()

const arrivalsInputSchema = z.object({
  arrivalCityId: z.string().min(1),
  date: z.iso.date(),
  limit: z.number().int().min(1).max(10).optional(),
  queryAt: z.iso.datetime({ offset: true }).optional(),
  queryId: z.string().min(1).optional(),
  pickupAirport: cockpitPickupAirportSchema.optional(),
})

const arrivalCandidateSchema = z.object({
  flightNumber: z.string().min(1), airlineName: z.string().min(1), originName: z.string().min(1),
  status: z.enum(['scheduled', 'in-air', 'landed', 'delayed', 'cancelled']),
  scheduledArrival: z.iso.datetime({ offset: true }), estimatedArrival: z.iso.datetime({ offset: true }),
  arrivalAirport: z.enum(['SHA', 'PVG']).optional(), arrivalAirportName: z.string().min(1), terminal: z.string().min(1),
})

const arrivalsOutputSchema = z.object({
  arrivalCityId: z.string().min(1), arrivalCityName: z.string().min(1), candidateSetId: z.string().min(1),
  queryId: z.string().min(1).optional(), queriedAt: z.iso.datetime({ offset: true }).optional(),
  expiresAt: z.iso.datetime({ offset: true }), arrivals: z.array(arrivalCandidateSchema),
  sourceUpdatedAt: z.iso.datetime({ offset: true }),
})

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

const dynamicFlightTemplates = [
  { prefix: 'MU', airlineName: '东方航空', originName: '北京首都' },
  { prefix: 'HO', airlineName: '吉祥航空', originName: '成都天府' },
  { prefix: 'CA', airlineName: '中国国际航空', originName: '广州白云' },
  { prefix: 'CZ', airlineName: '中国南方航空', originName: '深圳宝安' },
  { prefix: 'FM', airlineName: '上海航空', originName: '西安咸阳' },
] as const

const dynamicArrivalOffsetsMinutes = [30, 72, 118, 173, 232] as const

/** Fictional, injected-clock arrivals for the cockpit flow. */
export function generateDeterministicFlightArrivals(input: {
  pickupAirport: { label: string; code?: 'SHA' | 'PVG' }
  queryAt: string
  queryId: string
}): FlightArrivalsOutput {
  const queryMs = Date.parse(input.queryAt)
  if (Number.isNaN(queryMs)) throw new TypeError('queryAt must be an ISO datetime')
  if (!input.queryId.trim()) throw new TypeError('queryId is required')

  const arrivals: FlightArrivalCandidate[] = dynamicFlightTemplates.map((template, index) => {
    const estimatedMs = queryMs + dynamicArrivalOffsetsMinutes[index]! * 60_000
    const scheduledMs = estimatedMs - (index % 2 === 0 ? 0 : 8) * 60_000
    const suffix = String(1000 + (numericHash(`${input.queryId}:${input.pickupAirport.label}:${index}`) % 9000))
    return {
      flightNumber: `${template.prefix}${suffix}`,
      airlineName: template.airlineName,
      originName: template.originName,
      status: index === 1 || index === 3 ? 'in-air' : 'scheduled',
      scheduledArrival: shanghaiIso(scheduledMs),
      estimatedArrival: shanghaiIso(estimatedMs),
      ...(input.pickupAirport.code ? { arrivalAirport: input.pickupAirport.code } : {}),
      arrivalAirportName: input.pickupAirport.label,
      terminal: index % 3 === 0 ? 'T1' : 'T2',
    }
  })

  return arrivalsOutputSchema.parse({
    arrivalCityId: `airport:${stableHash(input.pickupAirport.label)}`,
    arrivalCityName: input.pickupAirport.label,
    candidateSetId: `cs-${stableHash(`${input.queryId}:${input.queryAt}:${input.pickupAirport.label}`)}`,
    queryId: input.queryId,
    queriedAt: input.queryAt,
    expiresAt: shanghaiIso(queryMs + 6 * 60 * 60_000),
    arrivals,
    sourceUpdatedAt: input.queryAt,
  })
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
  const parsed = arrivalsInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, ARRIVALS_TOOL, 'INVALID_ARGUMENT', '需要 arrivalCityId 和 date', false)
  }

  const { arrivalCityId, date, limit } = parsed.data
  if (parsed.data.queryAt || parsed.data.queryId || parsed.data.pickupAirport) {
    if (!parsed.data.queryAt || !parsed.data.queryId || !parsed.data.pickupAirport) {
      return errorResult(ctx, ARRIVALS_TOOL, 'INVALID_ARGUMENT', '动态航班需要 queryAt、queryId 和 pickupAirport', false)
    }
    const board = generateDeterministicFlightArrivals({
      pickupAirport: parsed.data.pickupAirport,
      queryAt: parsed.data.queryAt,
      queryId: parsed.data.queryId,
    })
    return okResult(ctx, ARRIVALS_TOOL, { ...board, arrivals: board.arrivals.slice(0, limit ?? 5) })
  }
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
    arrivalsOutputSchema.parse({
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

function numericHash(value: string): number {
  return Number.parseInt(stableHash(value), 36) >>> 0
}

function shanghaiIso(epochMs: number): string {
  return new Date(epochMs + 8 * 60 * 60_000).toISOString().replace(/\.\d{3}Z$/u, '+08:00')
}
