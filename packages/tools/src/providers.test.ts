import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toolResultSchema } from '@canvasflow/schema'
import { recommendCharging } from './charging'
import { getFixtureChargingRecommendation, getFixtureFlightStatus } from './compat'
import { resolveMembers } from './family'
import { getFlightStatus } from './flight'
import { getPreferences } from './memory'
import { planRoute } from './navigation'
import { DEMO_ORIGIN } from './data'
import { createProviderRegistry, createToolRegistry, toolDefinitions, type ToolName } from './registry'
import type { ToolContext } from './result'
import { getVehicleStatus } from './vehicle'

const ctx: ToolContext = { taskId: 'pickup-001' }

const readOnlyTools = [
  'family.resolve-members',
  'memory.get-preferences',
  'flight.get-status',
  'navigation.plan-route',
  'vehicle.get-status',
  'charging.recommend',
  'message.prepare',
] as const satisfies readonly ToolName[]

const canonicalInputs: Record<(typeof readOnlyTools)[number], unknown> = {
  'family.resolve-members': { labels: ['妈妈', '豆豆'] },
  'memory.get-preferences': { memberIds: ['mom', 'doubao'], scopes: ['cabin', 'media', 'address', 'notification'] },
  'flight.get-status': { flightNumber: 'MU5102', date: '2026-07-22' },
  'navigation.plan-route': {
    origin: { ...DEMO_ORIGIN },
    destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
  },
  'vehicle.get-status': undefined,
  'charging.recommend': {
    batteryPercent: 42,
    remainingRangeKm: 112,
    outboundDistanceKm: 32,
    returnDistanceKm: 32,
    safetyReservePercent: 20,
  },
  'message.prepare': { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:45' },
}

describe('provider registry (ctx, input)', () => {
  it('每个只读工具对同样输入返回完全相同、Schema 合法的结果', () => {
    const registry = createProviderRegistry()
    for (const name of readOnlyTools) {
      const first = registry[name](ctx, canonicalInputs[name] as never)
      const second = registry[name](ctx, canonicalInputs[name] as never)
      expect(second).toEqual(first)
      expect(first.ok).toBe(true)
      expect(() => toolResultSchema(z.unknown()).parse(first)).not.toThrow()
      expect(first.meta).toMatchObject({ taskId: 'pickup-001', tool: name, provider: 'fixture' })
    }
  })

  it('工具定义的风险级别和超时符合契约 P0 表', () => {
    expect(toolDefinitions['flight.get-status'].timeoutMs).toBe(3000)
    expect(toolDefinitions['navigation.plan-route'].timeoutMs).toBe(5000)
    expect(toolDefinitions['charging.recommend'].timeoutMs).toBe(1000)
    expect(toolDefinitions['navigation.start'].riskLevel).toBe('reversible')
    expect(toolDefinitions['message.send'].riskLevel).toBe('external')
    expect(toolDefinitions['memory.confirm-update'].riskLevel).toBe('persistent')
    expect(toolDefinitions['message.send'].timeoutMs).toBe(3000)
  })
})

describe('family.resolve-members', () => {
  it('解析已知标签并列出未解析标签', () => {
    const result = resolveMembers(ctx, { labels: ['妈妈', '二姨'] })
    expect(result.ok).toBe(true)
    expect(result.data?.members).toEqual([{ memberId: 'mom', displayName: '妈妈', contactId: 'contact-mom' }])
    expect(result.data?.unresolvedLabels).toEqual(['二姨'])
  })

  it('全部标签未知时返回 MEMBER_NOT_FOUND', () => {
    const result = resolveMembers(ctx, { labels: ['二姨'] })
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'MEMBER_NOT_FOUND', retryable: false })
  })

  it('非法输入返回 INVALID_ARGUMENT', () => {
    const result = resolveMembers(ctx, { labels: [] })
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })
})

describe('memory.get-preferences', () => {
  it('按 scope 过滤偏好字段，未请求 notification 时不泄露授权标记', () => {
    const result = getPreferences(ctx, { memberIds: ['mom', 'doubao'], scopes: ['media'] })
    expect(result.ok).toBe(true)
    expect(result.data?.members).toEqual([
      { memberId: 'mom' },
      { memberId: 'doubao', mediaTitle: '豆豆故事' },
    ])
    for (const member of result.data?.members ?? []) {
      expect(member).not.toHaveProperty('landingNotificationAuthorized')
    }
  })

  it('请求 notification scope 时才返回落地通知授权', () => {
    const result = getPreferences(ctx, { memberIds: ['mom'], scopes: ['notification'] })
    expect(result.data?.members).toEqual([{ memberId: 'mom', landingNotificationAuthorized: true }])
  })

  it('未知成员返回 PREFERENCE_UNAVAILABLE', () => {
    const result = getPreferences(ctx, { memberIds: ['stranger'], scopes: ['cabin'] })
    expect(result.error).toMatchObject({ code: 'PREFERENCE_UNAVAILABLE', retryable: false })
  })

  it('拒绝原型属性名作为 memberId，不抛异常', () => {
    for (const memberId of ['toString', 'constructor', '__proto__']) {
      const result = getPreferences(ctx, { memberIds: [memberId], scopes: ['cabin'] })
      expect(result.ok, memberId).toBe(false)
      expect(result.error, memberId).toMatchObject({ code: 'PREFERENCE_UNAVAILABLE', retryable: false })
    }
  })
})

describe('flight.get-status', () => {
  it('返回 MU5102 的确定性状态并忽略大小写', () => {
    const result = getFlightStatus(ctx, { flightNumber: 'mu5102', date: '2026-07-22' })
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      flightNumber: 'MU5102',
      status: 'scheduled',
      estimatedArrival: '2026-07-22T20:40:00+08:00',
      terminal: 'T2',
    })
  })

  it('未知航班返回 FLIGHT_NOT_FOUND', () => {
    const result = getFlightStatus(ctx, { flightNumber: 'CA1234', date: '2026-07-22' })
    expect(result.error).toMatchObject({ code: 'FLIGHT_NOT_FOUND', retryable: false })
  })

  it('MU0000 确定性触发 PROVIDER_TIMEOUT 且可重试', () => {
    const result = getFlightStatus(ctx, { flightNumber: 'MU0000', date: '2026-07-22' })
    expect(result.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
  })

  it('日期不匹配时返回 FLIGHT_NOT_FOUND', () => {
    const result = getFlightStatus(ctx, { flightNumber: 'MU5102', date: '2026-07-23' })
    expect(result.error).toMatchObject({ code: 'FLIGHT_NOT_FOUND', retryable: false })
  })

  it('MU5103 / MU5104 分别返回延误与取消状态', () => {
    expect(getFlightStatus(ctx, { flightNumber: 'MU5103', date: '2026-07-22' }).data).toMatchObject({
      flightNumber: 'MU5103',
      status: 'delayed',
      terminal: 'T1',
      estimatedArrival: '2026-07-22T21:10:00+08:00',
    })
    expect(getFlightStatus(ctx, { flightNumber: 'MU5104', date: '2026-07-22' }).data).toMatchObject({
      flightNumber: 'MU5104',
      status: 'cancelled',
      terminal: 'T2',
    })
  })
})

describe('navigation.plan-route', () => {
  const origin = { ...DEMO_ORIGIN }
  const airport = { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' }

  it('机场路线与 route-airport Fixture 一致', () => {
    const result = planRoute(ctx, canonicalInputs['navigation.plan-route'])
    expect(result.data).toEqual({
      routeId: 'route-airport-001',
      distanceKm: 32,
      durationMinutes: 20,
      arrivalTime: '2026-07-22T20:25:00+08:00',
      estimatedBatteryAtArrival: 27,
    })
  })

  it('支持途经已知充电站的机场路线', () => {
    const result = planRoute(ctx, {
      origin,
      destination: airport,
      via: [{ id: 'station-hongqiao-01', name: '虹桥补能站' }],
    })
    expect(result.ok).toBe(true)
    expect(result.data?.routeId).toBe('route-airport-via-charge-001')
  })

  it('未知目的地返回 ROUTE_NOT_FOUND', () => {
    const result = planRoute(ctx, {
      origin: { latitude: 0, longitude: 0 },
      destination: { id: 'destination-mars', name: '火星' },
    })
    expect(result.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', retryable: false })
  })

  it('avoidHighway 命中拥堵备选路线，不静默退回默认直达', () => {
    const result = planRoute(ctx, {
      origin,
      destination: airport,
      preferences: { avoidHighway: true },
    })
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      routeId: 'route-airport-avoid-hw-001',
      durationMinutes: 28,
    })
    // 默认直达与避高路线必须是两条不同路线
    expect(planRoute(ctx, { origin, destination: airport }).data?.routeId).toBe('route-airport-001')
  })

  it('不支持的避让组合显式失败，不静默返回默认路线', () => {
    const result = planRoute(ctx, {
      origin,
      destination: airport,
      preferences: { avoidHighway: true, avoidTolls: true },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', retryable: false })
    expect(result.error?.message).toContain('avoidTolls')
  })

  it('destination-timeout 确定性触发 PROVIDER_TIMEOUT 且可重试', () => {
    const result = planRoute(ctx, {
      origin,
      destination: { id: 'destination-timeout', name: '超时目的地' },
    })
    expect(result.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
  })

  it('外环绕行 via 命中拥堵改线路线', () => {
    const result = planRoute(ctx, {
      origin,
      destination: airport,
      via: [{ id: 'via-ring-road-01', name: '外环快速路' }],
    })
    expect(result.ok).toBe(true)
    expect(result.data?.routeId).toBe('route-airport-bypass-001')
  })

  it('未知 via 点显式失败，不静默忽略', () => {
    const result = planRoute(ctx, {
      origin,
      destination: airport,
      via: [{ id: 'station-unknown', name: '未知站' }],
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', retryable: false })
    expect(result.error?.message).toContain('station-unknown')
  })

  it('via 顺序有意义：颠倒顺序不会命中同一条路线', () => {
    const forward = planRoute(ctx, {
      origin,
      destination: airport,
      via: [
        { id: 'station-hongqiao-01', name: '虹桥补能站' },
        { id: 'station-unknown', name: '未知站' },
      ],
    })
    const reversed = planRoute(ctx, {
      origin,
      destination: airport,
      via: [
        { id: 'station-unknown', name: '未知站' },
        { id: 'station-hongqiao-01', name: '虹桥补能站' },
      ],
    })
    // fixture 未定义任何多途经点排列，两个方向都必须显式失败，且互不折叠
    expect(forward.ok).toBe(false)
    expect(reversed.ok).toBe(false)
    expect(forward.error?.message).toContain('station-hongqiao-01,station-unknown')
    expect(reversed.error?.message).toContain('station-unknown,station-hongqiao-01')
  })

  it('已支持的 origin 返回预期路线；不支持的 origin 返回 ROUTE_NOT_FOUND', () => {
    const supported = planRoute(ctx, { origin, destination: airport })
    expect(supported.ok).toBe(true)
    expect(supported.data?.routeId).toBe('route-airport-001')

    const unsupported = planRoute(ctx, {
      origin: { latitude: 0, longitude: 0 },
      destination: airport,
    })
    expect(unsupported.ok).toBe(false)
    expect(unsupported.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', retryable: false })
    expect(unsupported.error?.message).toContain('origin=0,0')
  })

  it('不同 origin 不会命中同一个错误 fixture', () => {
    const otherOrigin = planRoute(ctx, {
      origin: { latitude: 31.24, longitude: 121.48 },
      destination: airport,
    })
    const zeroOrigin = planRoute(ctx, {
      origin: { latitude: 0, longitude: 0 },
      destination: airport,
    })
    expect(otherOrigin.ok).toBe(false)
    expect(zeroOrigin.ok).toBe(false)
    expect(otherOrigin.error?.message).not.toEqual(zeroOrigin.error?.message)
    expect(otherOrigin.error?.message).toContain('origin=31.24,121.48')
    expect(zeroOrigin.error?.message).toContain('origin=0,0')
  })
})

describe('vehicle.get-status', () => {
  it('默认返回停车快照', () => {
    const result = getVehicleStatus(ctx)
    expect(result.data).toMatchObject({ speedKph: 0, batteryPercent: 42, gear: 'P', isNight: true })
  })

  it('可以切换到高速快照驱动 UI 密度场景', () => {
    const result = getVehicleStatus(ctx, { snapshot: 'highway-driving' })
    expect(result.data).toMatchObject({ speedKph: 80, gear: 'D' })
  })

  it('未知快照返回 VEHICLE_STATE_UNAVAILABLE', () => {
    const result = getVehicleStatus(ctx, { snapshot: 'flying' })
    expect(result.error).toMatchObject({ code: 'VEHICLE_STATE_UNAVAILABLE', retryable: false })
  })

  it('拒绝原型属性名作为 snapshot，不抛异常', () => {
    for (const snapshot of ['toString', 'constructor', '__proto__']) {
      expect(() => getVehicleStatus(ctx, { snapshot })).not.toThrow()
      const result = getVehicleStatus(ctx, { snapshot })
      expect(result.ok, snapshot).toBe(false)
      expect(result.error, snapshot).toMatchObject({ code: 'VEHICLE_STATE_UNAVAILABLE', retryable: false })
    }
  })
})

describe('charging.recommend', () => {
  it('主演示输入复现 charging-recommended Fixture 的数值', () => {
    const result = recommendCharging(ctx, canonicalInputs['charging.recommend'])
    expect(result.data).toEqual({
      recommended: true,
      reason: '完成往返后预计低于安全余量',
      estimatedFinalBatteryPercent: 18,
      suggestedDurationMinutes: 10,
      stationId: 'station-hongqiao-01',
      etaImpactMinutes: 12,
    })
  })

  it('电量充足时不推荐补能且不附带站点', () => {
    const result = recommendCharging(ctx, {
      batteryPercent: 90,
      remainingRangeKm: 240,
      outboundDistanceKm: 32,
      returnDistanceKm: 32,
      safetyReservePercent: 20,
    })
    expect(result.data).toEqual({
      recommended: false,
      reason: '完成往返后预计仍高于安全余量',
      estimatedFinalBatteryPercent: 66,
    })
  })

  it('相同电量百分比下 remainingRangeKm 会改变补能结论', () => {
    const lowRange = recommendCharging(ctx, {
      batteryPercent: 42,
      remainingRangeKm: 50,
      outboundDistanceKm: 32,
      returnDistanceKm: 32,
      safetyReservePercent: 20,
    })
    const highRange = recommendCharging(ctx, {
      batteryPercent: 42,
      remainingRangeKm: 300,
      outboundDistanceKm: 32,
      returnDistanceKm: 32,
      safetyReservePercent: 20,
    })
    expect(lowRange.data?.recommended).toBe(true)
    expect(lowRange.data?.estimatedFinalBatteryPercent).toBe(0)
    expect(highRange.data?.recommended).toBe(false)
    expect(highRange.data?.estimatedFinalBatteryPercent).toBe(33)
  })

  it('缺少输入返回 INSUFFICIENT_INPUT', () => {
    const result = recommendCharging(ctx, { batteryPercent: 42 })
    expect(result.error).toMatchObject({ code: 'INSUFFICIENT_INPUT', retryable: false })
  })
})

describe('deprecated compat wrappers', () => {
  it('保留旧 taskId 签名并返回与新 provider 一致的结果', () => {
    const flight = getFixtureFlightStatus('pickup-001')
    expect(flight).toEqual(getFlightStatus(ctx, { flightNumber: 'MU5102', date: '2026-07-22' }))
    expect(flight.ok).toBe(true)
    expect(flight.meta).toMatchObject({ taskId: 'pickup-001', tool: 'flight.get-status' })

    const charging = getFixtureChargingRecommendation('pickup-001')
    expect(charging).toEqual(recommendCharging(ctx, canonicalInputs['charging.recommend']))
    expect(charging.ok).toBe(true)
    expect(charging.data).toMatchObject({ recommended: true, estimatedFinalBatteryPercent: 18 })
  })
})

describe('legacy createToolRegistry (taskId-only handlers)', () => {
  it('保留旧调用形态 createToolRegistry()[tool](taskId)', () => {
    const legacy = createToolRegistry()
    const flight = legacy['flight.get-status']('pickup-001')
    const charging = legacy['charging.recommend']('pickup-001')
    expect(flight).toEqual(getFixtureFlightStatus('pickup-001'))
    expect(charging).toEqual(getFixtureChargingRecommendation('pickup-001'))
    expect(flight.ok).toBe(true)
    expect(charging.ok).toBe(true)
  })

  it('旧 registry 不会把 taskId 当成 ctx 静默返回 invalid input', () => {
    const legacy = createToolRegistry()
    // 旧签名只有一个 string 参数；若误把 handler 换成 (ctx, input)，
    // 传入 'pickup-001' 会被当成非法 ctx 并返回 INVALID_ARGUMENT。
    const flight = legacy['flight.get-status']('pickup-001')
    expect(flight.error).toBeNull()
    expect(flight.data).toMatchObject({ flightNumber: 'MU5102', status: 'scheduled' })
  })
})
