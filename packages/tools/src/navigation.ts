import {
  navigationStartInputSchema,
  navigationStartOutputSchema,
  navigationUpdateRouteInputSchema,
  navigationUpdateRouteOutputSchema,
  routePlanInputSchema,
  routePlanOutputSchema,
  type NavigationStartOutput,
  type NavigationUpdateRouteOutput,
  type RoutePlanOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { knownRouteIds, routeFixtureKey, routes } from './data'
import type { SideEffectRuntime } from './idempotency'
import { errorResult, okResult, type ToolContext } from './result'

const PLAN = 'navigation.plan-route'
const START = 'navigation.start'
const UPDATE = 'navigation.update-route'

export function planRoute(ctx: ToolContext, input: unknown): ToolResult<RoutePlanOutput> {
  const parsed = routePlanInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, PLAN, 'INVALID_ARGUMENT', '需要 origin 和 destination', false)
  }

  const { destination, via, preferences } = parsed.data
  const key = routeFixtureKey({
    destinationId: destination.id,
    viaIds: (via ?? []).map((point) => point.id),
    avoidHighway: preferences?.avoidHighway === true,
    avoidTolls: preferences?.avoidTolls === true,
  })

  const route = routes[key]
  if (!route) {
    const constraints: string[] = []
    if ((via ?? []).length > 0) constraints.push(`via=${(via ?? []).map((point) => point.id).join(',')}`)
    if (preferences?.avoidHighway) constraints.push('avoidHighway')
    if (preferences?.avoidTolls) constraints.push('avoidTolls')
    const suffix = constraints.length > 0 ? `（约束：${constraints.join(', ')}）` : ''
    return errorResult(
      ctx,
      PLAN,
      'ROUTE_NOT_FOUND',
      `未找到通往 ${destination.name} 的匹配路线${suffix}`,
      false,
    )
  }

  return okResult(ctx, PLAN, routePlanOutputSchema.parse(route))
}

export function createNavigationSideEffects(runtime: SideEffectRuntime) {
  function startNavigation(ctx: ToolContext, input: unknown): ToolResult<NavigationStartOutput> {
    const parsed = navigationStartInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, START, 'INVALID_ARGUMENT', '需要 routeId 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<NavigationStartOutput>(START, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') {
      return errorResult(ctx, START, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    if (!knownRouteIds.has(parsed.data.routeId)) {
      return errorResult(ctx, START, 'ROUTE_EXPIRED', `路线已失效或不存在：${parsed.data.routeId}`, false)
    }

    const result = okResult(
      ctx,
      START,
      navigationStartOutputSchema.parse({
        navigationId: `${ctx.taskId}:nav:${parsed.data.routeId}`,
        routeId: parsed.data.routeId,
        status: 'active',
      }),
    )
    runtime.idempotency.set(START, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }

  function updateRoute(ctx: ToolContext, input: unknown): ToolResult<NavigationUpdateRouteOutput> {
    const parsed = navigationUpdateRouteInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, UPDATE, 'INVALID_ARGUMENT', '需要 routeId、destination 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<NavigationUpdateRouteOutput>(UPDATE, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') {
      return errorResult(ctx, UPDATE, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    if (!knownRouteIds.has(parsed.data.routeId)) {
      return errorResult(ctx, UPDATE, 'ROUTE_EXPIRED', `路线已失效或不存在：${parsed.data.routeId}`, false)
    }

    const planned = planRoute(ctx, {
      origin: { latitude: 0, longitude: 0 },
      destination: parsed.data.destination,
      via: parsed.data.via,
    })
    if (!planned.ok || !planned.data) {
      return errorResult(
        ctx,
        UPDATE,
        planned.error?.code ?? 'ROUTE_NOT_FOUND',
        planned.error?.message ?? '无法更新路线',
        false,
      )
    }

    const result = okResult(
      ctx,
      UPDATE,
      navigationUpdateRouteOutputSchema.parse({
        navigationId: `${ctx.taskId}:nav:${planned.data.routeId}`,
        routeId: planned.data.routeId,
        destination: parsed.data.destination.name,
        status: 'active',
      }),
    )
    runtime.idempotency.set(UPDATE, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }

  return { startNavigation, updateRoute }
}
