import type { ChargingRecommendationOutput, FlightStatusOutput, ToolResult } from '@canvasflow/schema'
import { recommendCharging } from './charging'
import { getFlightStatus } from './flight'

/**
 * Compatibility wrappers for the pre-provider fixture API that shipped on dev.
 * They delegate to the real providers with the canonical demo inputs so legacy
 * callers keep working. Remove once all consumers use createToolRegistry with
 * a ToolContext.
 */

/** @deprecated Use `getFlightStatus(ctx, { flightNumber, date })` instead. */
export function getFixtureFlightStatus(taskId: string): ToolResult<FlightStatusOutput> {
  return getFlightStatus({ taskId }, { flightNumber: 'MU5102', date: '2026-07-22' })
}

/** @deprecated Use `recommendCharging(ctx, input)` instead. */
export function getFixtureChargingRecommendation(taskId: string): ToolResult<ChargingRecommendationOutput> {
  return recommendCharging(
    { taskId },
    { batteryPercent: 42, remainingRangeKm: 112, outboundDistanceKm: 32, returnDistanceKm: 32, safetyReservePercent: 20 },
  )
}
