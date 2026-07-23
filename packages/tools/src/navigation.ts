import {
  routePlanInputSchema,
  routePlanOutputSchema,
  type RoutePlanOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { routeFixtureKey, routes } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'navigation.plan-route'

export function planRoute(ctx: ToolContext, input: unknown): ToolResult<RoutePlanOutput> {
  const parsed = routePlanInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要 origin 和 destination', false)
  }

  const { origin, destination, via, preferences } = parsed.data
  const key = routeFixtureKey({
    originLatitude: origin.latitude,
    originLongitude: origin.longitude,
    destinationId: destination.id,
    viaIds: (via ?? []).map((point) => point.id),
    avoidHighway: preferences?.avoidHighway === true,
    avoidTolls: preferences?.avoidTolls === true,
  })

  const route = routes[key]
  if (!route) {
    const constraints: string[] = [`origin=${origin.latitude},${origin.longitude}`]
    if ((via ?? []).length > 0) constraints.push(`via=${(via ?? []).map((point) => point.id).join(',')}`)
    if (preferences?.avoidHighway) constraints.push('avoidHighway')
    if (preferences?.avoidTolls) constraints.push('avoidTolls')
    return errorResult(
      ctx,
      TOOL,
      'ROUTE_NOT_FOUND',
      `未找到通往 ${destination.name} 的匹配路线（约束：${constraints.join(', ')}）`,
      false,
    )
  }

  return okResult(ctx, TOOL, routePlanOutputSchema.parse(route))
}
