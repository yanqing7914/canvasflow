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
import { DEMO_ORIGIN, knownRouteIds, routeFixtureKey, routes, TIMEOUT_DESTINATION_ID } from './data'
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

  const { origin, destination, via, preferences } = parsed.data
  if (destination.id === TIMEOUT_DESTINATION_ID) {
    return errorResult(ctx, PLAN, 'PROVIDER_TIMEOUT', '路线数据源超时', true)
  }

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
      PLAN,
      'ROUTE_NOT_FOUND',
      `未找到通往 ${destination.name} 的匹配路线（约束：${constraints.join(', ')}）`,
      false,
    )
  }

  return okResult(ctx, PLAN, routePlanOutputSchema.parse(route))
}

function rememberPlannedRoute(runtime: SideEffectRuntime, taskId: string, routeId: string): void {
  let planned = runtime.plannedRouteIdsByTask.get(taskId)
  if (!planned) {
    planned = new Set()
    runtime.plannedRouteIdsByTask.set(taskId, planned)
  }
  planned.add(routeId)
}

function isRoutePlannedForTask(runtime: SideEffectRuntime, taskId: string, routeId: string): boolean {
  return runtime.plannedRouteIdsByTask.get(taskId)?.has(routeId) === true
}

export function createNavigationSideEffects(runtime: SideEffectRuntime) {
  function planRouteForTask(ctx: ToolContext, input: unknown): ToolResult<RoutePlanOutput> {
    const result = planRoute(ctx, input)
    if (result.ok && result.data) {
      rememberPlannedRoute(runtime, ctx.taskId, result.data.routeId)
    }
    return result
  }

  function startNavigation(ctx: ToolContext, input: unknown): ToolResult<NavigationStartOutput> {
    const parsed = navigationStartInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, START, 'INVALID_ARGUMENT', '需要 routeId 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<NavigationStartOutput>(ctx.taskId, START, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') {
      return errorResult(ctx, START, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    if (!knownRouteIds.has(parsed.data.routeId)) {
      return errorResult(ctx, START, 'ROUTE_EXPIRED', `路线已失效或不存在：${parsed.data.routeId}`, false)
    }

    // 仅允许启动本任务已 plan-route（或 update-route）确认过的路线，避免凭 fixture ID 直接开导航。
    if (!isRoutePlannedForTask(runtime, ctx.taskId, parsed.data.routeId)) {
      return errorResult(
        ctx,
        START,
        'ROUTE_EXPIRED',
        `路线尚未在本任务中规划或确认：${parsed.data.routeId}`,
        false,
      )
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
    runtime.idempotency.set(ctx.taskId, START, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }

  function updateRoute(ctx: ToolContext, input: unknown): ToolResult<NavigationUpdateRouteOutput> {
    const parsed = navigationUpdateRouteInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, UPDATE, 'INVALID_ARGUMENT', '需要 routeId、destination 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<NavigationUpdateRouteOutput>(ctx.taskId, UPDATE, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') {
      return errorResult(ctx, UPDATE, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    if (!knownRouteIds.has(parsed.data.routeId)) {
      return errorResult(ctx, UPDATE, 'ROUTE_EXPIRED', `路线已失效或不存在：${parsed.data.routeId}`, false)
    }

    if (!isRoutePlannedForTask(runtime, ctx.taskId, parsed.data.routeId)) {
      return errorResult(
        ctx,
        UPDATE,
        'ROUTE_EXPIRED',
        `路线尚未在本任务中规划或确认：${parsed.data.routeId}`,
        false,
      )
    }

    const planned = planRoute(ctx, {
      origin: { latitude: DEMO_ORIGIN.latitude, longitude: DEMO_ORIGIN.longitude },
      destination: parsed.data.destination,
      via: parsed.data.via,
    })
    if (!planned.ok || !planned.data) {
      return errorResult(
        ctx,
        UPDATE,
        planned.error?.code ?? 'ROUTE_NOT_FOUND',
        planned.error?.message ?? '无法更新路线',
        // Preserve provider retryability (e.g. destination-timeout → PROVIDER_TIMEOUT).
        planned.error?.retryable ?? false,
      )
    }

    rememberPlannedRoute(runtime, ctx.taskId, planned.data.routeId)

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
    runtime.idempotency.set(ctx.taskId, UPDATE, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }

  return { planRoute: planRouteForTask, startNavigation, updateRoute }
}
