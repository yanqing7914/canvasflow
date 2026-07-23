import {
  routePlanInputSchema,
  routePlanOutputSchema,
  type RoutePlanOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { routes } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'navigation.plan-route'

export function planRoute(ctx: ToolContext, input: unknown): ToolResult<RoutePlanOutput> {
  const parsed = routePlanInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要 origin 和 destination', false)
  }

  const route = routes[parsed.data.destination.id]
  if (!route) {
    return errorResult(ctx, TOOL, 'ROUTE_NOT_FOUND', `未找到通往 ${parsed.data.destination.name} 的路线`, false)
  }
  return okResult(ctx, TOOL, routePlanOutputSchema.parse(route))
}
