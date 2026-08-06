import {
  chargingRecommendationInputSchema,
  chargingRecommendationOutputSchema,
  type ChargingRecommendationOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { chargingStation } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'charging.recommend'

/**
 * Estimate remaining battery after a round trip using the vehicle's reported
 * remainingRangeKm (not a fixed consumption constant). Canonical demo input
 * (42% / 112 km / 32+32 km) yields exactly 18%, matching the fixture.
 */
export function estimateFinalBatteryPercent(
  batteryPercent: number,
  remainingRangeKm: number,
  outboundDistanceKm: number,
  returnDistanceKm: number,
): number {
  const roundTripKm = outboundDistanceKm + returnDistanceKm
  if (remainingRangeKm <= 0) return 0
  const remainingAfterTripKm = Math.max(0, remainingRangeKm - roundTripKm)
  return Math.max(0, Math.round((batteryPercent * remainingAfterTripKm) / remainingRangeKm))
}

export function recommendCharging(ctx: ToolContext, input: unknown): ToolResult<ChargingRecommendationOutput> {
  const parsed = chargingRecommendationInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INSUFFICIENT_INPUT', '需要电量、续航、往返里程和安全余量', false)
  }

  const { batteryPercent, remainingRangeKm, outboundDistanceKm, returnDistanceKm, safetyReservePercent } =
    parsed.data
  const estimatedFinalBatteryPercent = estimateFinalBatteryPercent(
    batteryPercent,
    remainingRangeKm,
    outboundDistanceKm,
    returnDistanceKm,
  )
  const recommended = estimatedFinalBatteryPercent < safetyReservePercent

  const output: ChargingRecommendationOutput = recommended
    ? {
        recommended: true,
        reason: '完成往返后预计低于安全余量',
        estimatedFinalBatteryPercent,
        suggestedDurationMinutes: chargingStation.suggestedDurationMinutes,
        stationId: chargingStation.stationId,
        etaImpactMinutes: chargingStation.etaImpactMinutes,
      }
    : {
        recommended: false,
        reason: '完成往返后预计仍高于安全余量',
        estimatedFinalBatteryPercent,
      }
  return okResult(ctx, TOOL, chargingRecommendationOutputSchema.parse(output))
}
