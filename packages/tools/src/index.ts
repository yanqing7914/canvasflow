import {
  chargingRecommendationOutputSchema,
  flightStatusOutputSchema,
  type ProviderMode,
  type ToolResult,
} from '@canvasflow/schema'

const generatedAt = '2026-07-22T12:00:00+08:00'

function result<T>(taskId: string, tool: string, data: T, provider: ProviderMode = 'fixture'): ToolResult<T> {
  return {
    ok: true, data, error: null,
    meta: { requestId: `${taskId}:${tool}`, taskId, tool, provider, durationMs: 1, generatedAt },
  }
}

export function getFixtureFlightStatus(taskId: string): ToolResult<ReturnType<typeof flightStatusOutputSchema.parse>> {
  const data = flightStatusOutputSchema.parse({
    flightNumber: 'MU5102', status: 'scheduled', scheduledArrival: generatedAt,
    estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2', sourceUpdatedAt: generatedAt,
  })
  return result(taskId, 'flight.get-status', data)
}

export function getFixtureChargingRecommendation(taskId: string): ToolResult<ReturnType<typeof chargingRecommendationOutputSchema.parse>> {
  const data = chargingRecommendationOutputSchema.parse({
    recommended: true, reason: '完成往返后预计低于安全余量', estimatedFinalBatteryPercent: 18,
    suggestedDurationMinutes: 10, stationId: 'station-hongqiao-01', etaImpactMinutes: 12,
  })
  return result(taskId, 'charging.recommend', data)
}

export function createToolRegistry() {
  return {
    'flight.get-status': getFixtureFlightStatus,
    'charging.recommend': getFixtureChargingRecommendation,
  } as const
}
