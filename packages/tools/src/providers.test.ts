import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toolResultSchema } from '@canvasflow/schema'
import { recommendCharging } from './charging'
import { resolveMembers } from './family'
import { getFlightStatus } from './flight'
import { getPreferences } from './memory'
import { planRoute } from './navigation'
import { createToolRegistry, toolDefinitions, type ToolName } from './registry'
import type { ToolContext } from './result'
import { getVehicleStatus } from './vehicle'

const ctx: ToolContext = { taskId: 'pickup-001' }

const canonicalInputs: Record<ToolName, unknown> = {
  'family.resolve-members': { labels: ['妈妈', '豆豆'] },
  'memory.get-preferences': { memberIds: ['mom', 'doubao'], scopes: ['cabin', 'media', 'address', 'notification'] },
  'flight.get-status': { flightNumber: 'MU5102', date: '2026-07-22' },
  'navigation.plan-route': {
    origin: { latitude: 31.23, longitude: 121.47 },
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
}

describe('tool registry', () => {
  it('每个 P0 只读工具对同样输入返回完全相同、Schema 合法的结果', () => {
    const registry = createToolRegistry()
    for (const name of Object.keys(registry) as ToolName[]) {
      const first = registry[name](ctx, canonicalInputs[name] as never)
      const second = registry[name](ctx, canonicalInputs[name] as never)
      expect(second).toEqual(first)
      expect(first.ok).toBe(true)
      expect(() => toolResultSchema(z.unknown()).parse(first)).not.toThrow()
      expect(first.meta).toMatchObject({ taskId: 'pickup-001', tool: name, provider: 'fixture' })
    }
  })

  it('工具定义的风险级别和超时符合契约 P0 表', () => {
    for (const definition of Object.values(toolDefinitions)) {
      expect(definition.riskLevel).toBe('read')
    }
    expect(toolDefinitions['flight.get-status'].timeoutMs).toBe(3000)
    expect(toolDefinitions['navigation.plan-route'].timeoutMs).toBe(5000)
    expect(toolDefinitions['charging.recommend'].timeoutMs).toBe(1000)
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
})

describe('navigation.plan-route', () => {
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

  it('未知目的地返回 ROUTE_NOT_FOUND', () => {
    const result = planRoute(ctx, {
      origin: { latitude: 0, longitude: 0 },
      destination: { id: 'destination-mars', name: '火星' },
    })
    expect(result.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', retryable: false })
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
