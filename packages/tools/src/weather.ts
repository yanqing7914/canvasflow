import {
  weatherOutputSchema,
  weatherQueryInputSchema,
  type ToolResult,
  type WeatherOutput,
} from '@canvasflow/schema'
import { TIMEOUT_WEATHER_LOCATION_ID, weatherSnapshots } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'weather.get-current'

export function getWeather(ctx: ToolContext, input: unknown): ToolResult<WeatherOutput> {
  const parsed = weatherQueryInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要 locationId', false)
  }
  if (parsed.data.locationId === TIMEOUT_WEATHER_LOCATION_ID) {
    return errorResult(ctx, TOOL, 'PROVIDER_TIMEOUT', '天气服务超时', true)
  }

  const snapshot = weatherSnapshots[parsed.data.locationId]
  if (!snapshot) {
    return errorResult(ctx, TOOL, 'LOCATION_NOT_FOUND', '未收录该地点的天气', false)
  }

  // `at` narrows which moment the caller cares about; the fixture keeps one
  // deterministic reading per location, so the reading itself does not vary.
  return okResult(ctx, TOOL, weatherOutputSchema.parse(snapshot))
}
