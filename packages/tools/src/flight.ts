import {
  flightStatusInputSchema,
  flightStatusOutputSchema,
  type FlightStatusOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { flights, TIMEOUT_FLIGHT_NUMBER } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'flight.get-status'

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
      terminal: flight.terminal,
      baggageClaim: flight.baggageClaim,
      sourceUpdatedAt: flight.sourceUpdatedAt,
    }),
  )
}
