import type { ProviderMode, ToolDefinition, ToolResult } from '@canvasflow/schema'
import { createCabinProfileTools } from './cabin'
import { listUpcomingEvents } from './calendar'
import { getFixtureChargingRecommendation, getFixtureFlightStatus } from './compat'
import { recommendCharging } from './charging'
import { resolveMembers } from './family'
import { getFlightStatus, listFlightArrivals } from './flight'
import { createSideEffectRuntime, type SideEffectRuntime } from './idempotency'
import { createMediaPlayer } from './media'
import { createPreferenceReader } from './memory'
import { createMemoryWriteTools } from './memory-write'
import { createMessageAuthorizationRevoker, createMessageConfirmationRevoker, createMessagePreparer, createMessageSender } from './message'
import { createNavigationSideEffects } from './navigation'
import type { ToolContext } from './result'
import { getVehicleStatus } from './vehicle'
import { getWeather } from './weather'

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
  'memory.propose-update': {
    name: 'memory.propose-update',
    version: '1.0',
    description: '生成待确认的长期记忆更新',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'memory.confirm-update': {
    name: 'memory.confirm-update',
    version: '1.0',
    description: '用户确认后写入长期记忆',
    riskLevel: 'persistent',
    timeoutMs: 2000,
  },
  'memory.reject-update': {
    name: 'memory.reject-update',
    version: '1.0',
    description: '撤销待确认的长期记忆更新',
    riskLevel: 'reversible',
    timeoutMs: 1000,
  },
  'flight.get-status': {
    name: 'flight.get-status',
    version: '1.0',
    description: '查询航班状态、ETA 和航站楼',
    riskLevel: 'read',
    timeoutMs: 3000,
  },
  'flight.list-arrivals': {
    name: 'flight.list-arrivals',
    version: '1.0',
    description: '列出某城市当天的到达航班供用户选择',
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
  'navigation.start': {
    name: 'navigation.start',
    version: '1.0',
    description: '启动已确认路线',
    riskLevel: 'reversible',
    timeoutMs: 2000,
  },
  'navigation.update-route': {
    name: 'navigation.update-route',
    version: '1.0',
    description: '根据补能或接机点调整路线',
    riskLevel: 'reversible',
    timeoutMs: 2000,
  },
  'vehicle.get-status': {
    name: 'vehicle.get-status',
    version: '1.0',
    description: '获取电量、续航、车速、挡位和乘员状态',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'vehicle.apply-cabin-profile': {
    name: 'vehicle.apply-cabin-profile',
    version: '1.0',
    description: '应用授权的温度、风量和媒体偏好',
    riskLevel: 'reversible',
    timeoutMs: 2000,
  },
  'vehicle.revert-cabin-profile': {
    name: 'vehicle.revert-cabin-profile',
    version: '1.0',
    description: '撤销本次自动座舱设置',
    riskLevel: 'reversible',
    timeoutMs: 2000,
  },
  'charging.recommend': {
    name: 'charging.recommend',
    version: '1.0',
    description: '计算是否需要补能及推荐站点',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'calendar.list-upcoming': {
    name: 'calendar.list-upcoming',
    version: '1.0',
    description: '读取家庭日历当天的剩余日程',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'weather.get-current': {
    name: 'weather.get-current',
    version: '1.0',
    description: '读取指定地点的天气快照',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'media.play': {
    name: 'media.play',
    version: '1.0',
    description: '播放授权范围内的媒体内容',
    riskLevel: 'reversible',
    timeoutMs: 2000,
  },
  'message.prepare': {
    name: 'message.prepare',
    version: '1.0',
    description: '根据航班和导航状态生成消息预览',
    riskLevel: 'read',
    timeoutMs: 1000,
  },
  'message.send': {
    name: 'message.send',
    version: '1.0',
    description: '向授权联系人发送一次消息',
    riskLevel: 'external',
    timeoutMs: 3000,
  },
  'message.revoke-confirmation': {
    name: 'message.revoke-confirmation',
    version: '1.0',
    description: '撤销尚未使用的消息确认凭据',
    riskLevel: 'reversible',
    timeoutMs: 1000,
  },
  'message.revoke-authorization': {
    name: 'message.revoke-authorization',
    version: '1.0',
    description: '撤销尚未使用的落地通知预授权凭据',
    riskLevel: 'reversible',
    timeoutMs: 1000,
  },
} satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

/**
 * Provider registry: every handler takes `(ctx, input)` and returns a contract
 * `ToolResult`. Prefer this over the legacy `createToolRegistry`.
 */
export function createProviderRegistry(
  runtime: SideEffectRuntime = createSideEffectRuntime(),
  mode: Exclude<ProviderMode, 'live'> = 'fixture',
) {
  const navigation = createNavigationSideEffects(runtime)
  const cabin = createCabinProfileTools(runtime)
  const memoryWrite = createMemoryWriteTools(runtime)
  const playMedia = createMediaPlayer(runtime)
  const prepareMessage = createMessagePreparer(runtime)
  const sendMessage = createMessageSender(runtime)
  const revokeMessageConfirmation = createMessageConfirmationRevoker(runtime)
  const revokeMessageAuthorization = createMessageAuthorizationRevoker(runtime)

  const registry = {
    'family.resolve-members': resolveMembers,
    // 绑定 runtime 的可变偏好副本，让 memory.confirm-update 的写入对读取可见。
    'memory.get-preferences': createPreferenceReader(runtime.preferences),
    'memory.propose-update': memoryWrite.proposeMemoryUpdate,
    'memory.confirm-update': memoryWrite.confirmMemoryUpdate,
    'memory.reject-update': memoryWrite.rejectMemoryUpdate,
    'flight.get-status': getFlightStatus,
    'flight.list-arrivals': listFlightArrivals,
    'navigation.plan-route': navigation.planRoute,
    'navigation.start': navigation.startNavigation,
    'navigation.update-route': navigation.updateRoute,
    'vehicle.get-status': getVehicleStatus,
    'vehicle.apply-cabin-profile': cabin.applyCabinProfile,
    'vehicle.revert-cabin-profile': cabin.revertCabinProfile,
    'charging.recommend': recommendCharging,
    'calendar.list-upcoming': listUpcomingEvents,
    'weather.get-current': getWeather,
    'media.play': playMedia,
    'message.prepare': prepareMessage,
    'message.send': sendMessage,
    'message.revoke-confirmation': revokeMessageConfirmation,
    'message.revoke-authorization': revokeMessageAuthorization,
  } as const satisfies Record<ToolName, (ctx: ToolContext, input?: unknown) => ToolResult<unknown>>

  return Object.fromEntries(
    Object.entries(registry).map(([name, provider]) => [
      name,
      (context: ToolContext, input?: unknown) => provider({ ...context, provider: mode }, input),
    ]),
  ) as typeof registry
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
/** @deprecated Prefer ProviderRegistry / createProviderRegistry. */
export type ToolRegistry = ProviderRegistry
