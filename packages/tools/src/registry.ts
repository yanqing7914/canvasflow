import type { ToolDefinition, ToolResult } from '@canvasflow/schema'
import { getFixtureChargingRecommendation, getFixtureFlightStatus } from './compat'
import { recommendCharging } from './charging'
import { resolveMembers } from './family'
import { getFlightStatus } from './flight'
import { getPreferences } from './memory'
import { planRoute } from './navigation'
import type { ToolContext } from './result'
import { getVehicleStatus } from './vehicle'

/** Risk levels and timeouts follow the P0 table in the tool contract. */
export const toolDefinitions = {
  'family.resolve-members': {
    name: 'family.resolve-members',
    version: '1.0',
    description: '解析“妈妈”“豆豆”等家庭成员标签',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'memory.get-preferences': {
    name: 'memory.get-preferences',
    version: '1.0',
    description: '读取已授权的车控、媒体和地址偏好',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'flight.get-status': {
    name: 'flight.get-status',
    version: '1.0',
    description: '查询航班状态、ETA 和航站楼',
    riskLevel: 'read',
    timeoutMs: 3000,
  },
  'navigation.plan-route': {
    name: 'navigation.plan-route',
    version: '1.0',
    description: '规划机场、充电站或家庭目的地路线',
    riskLevel: 'read',
    timeoutMs: 5000,
  },
  'vehicle.get-status': {
    name: 'vehicle.get-status',
    version: '1.0',
    description: '获取电量、续航、车速、挡位和乘员状态',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'charging.recommend': {
    name: 'charging.recommend',
    version: '1.0',
    description: '计算是否需要补能及推荐站点',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
} satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

export type ToolHandler = (ctx: ToolContext, input?: unknown) => ToolResult<unknown>

/**
 * New provider registry: every handler takes `(ctx, input)` and returns a
 * contract `ToolResult`. Prefer this over the legacy `createToolRegistry`.
 */
export function createProviderRegistry(): Record<ToolName, ToolHandler> {
  return {
    'family.resolve-members': resolveMembers,
    'memory.get-preferences': getPreferences,
    'flight.get-status': getFlightStatus,
    'navigation.plan-route': planRoute,
    'vehicle.get-status': getVehicleStatus,
    'charging.recommend': recommendCharging,
  }
}

/**
 * Legacy registry that shipped on `dev`: handlers take a bare `taskId` string
 * and return the canonical demo fixture for that tool. Kept so existing
 * callers of `createToolRegistry()['flight.get-status']('task-id')` keep
 * working. New code should use `createProviderRegistry()`.
 *
 * @deprecated Use {@link createProviderRegistry} with a ToolContext.
 */
export function createToolRegistry() {
  return {
    'flight.get-status': getFixtureFlightStatus,
    'charging.recommend': getFixtureChargingRecommendation,
  } as const
}

/** @deprecated Alias kept for clarity in migration notes. */
export type LegacyToolRegistry = ReturnType<typeof createToolRegistry>
export type ProviderRegistry = ReturnType<typeof createProviderRegistry>
