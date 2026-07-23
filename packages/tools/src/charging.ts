import {
  chargingRecommendationInputSchema,
  chargingRecommendationOutputSchema,
  type ChargingRecommendationOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { chargingStation, FIXTURE_CONSUMPTION_PERCENT_PER_KM } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'charging.recommend'

export function recommendCharging(ctx: ToolContext, input: unknown): ToolResult<ChargingRecommendationOutput> {
  const parsed = chargingRecommendationInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INSUFFICIENT_INPUT', '需要电量、续航、往返里程和安全余量', false)
  }

  const { batteryPercent, outboundDistanceKm, returnDistanceKm, safetyReservePercent } = parsed.data
  const roundTripKm = outboundDistanceKm + returnDistanceKm
  const estimatedFinalBatteryPercent = Math.max(
    0,
    Math.round(batteryPercent - roundTripKm * FIXTURE_CONSUMPTION_PERCENT_PER_KM),
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
