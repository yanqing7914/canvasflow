import type { ToolDefinition, ToolResult } from '@canvasflow/schema'
import { createCabinProfileTools } from './cabin'
import { getFixtureChargingRecommendation, getFixtureFlightStatus } from './compat'
import { recommendCharging } from './charging'
import { resolveMembers } from './family'
import { getFlightStatus } from './flight'
import { createSideEffectRuntime, type SideEffectRuntime } from './idempotency'
import { createMediaPlayer } from './media'
import { createPreferenceReader } from './memory'
import { createMemoryWriteTools } from './memory-write'
import { createMessageSender, prepareMessage } from './message'
import { createNavigationSideEffects } from './navigation'
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
} satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof toolDefinitions

/**
 * Provider registry: every handler takes `(ctx, input)` and returns a contract
 * `ToolResult`. Prefer this over the legacy `createToolRegistry`.
 */
export function createProviderRegistry(runtime: SideEffectRuntime = createSideEffectRuntime()) {
  const navigation = createNavigationSideEffects(runtime)
  const cabin = createCabinProfileTools(runtime)
  const memoryWrite = createMemoryWriteTools(runtime)
  const playMedia = createMediaPlayer(runtime)
  const sendMessage = createMessageSender(runtime)

  return {
    'family.resolve-members': resolveMembers,
    // 绑定 runtime 的可变偏好副本，让 memory.confirm-update 的写入对读取可见。
    'memory.get-preferences': createPreferenceReader(runtime.preferences),
    'memory.propose-update': memoryWrite.proposeMemoryUpdate,
    'memory.confirm-update': memoryWrite.confirmMemoryUpdate,
    'flight.get-status': getFlightStatus,
    'navigation.plan-route': navigation.planRoute,
    'navigation.start': navigation.startNavigation,
    'navigation.update-route': navigation.updateRoute,
    'vehicle.get-status': getVehicleStatus,
    'vehicle.apply-cabin-profile': cabin.applyCabinProfile,
    'vehicle.revert-cabin-profile': cabin.revertCabinProfile,
    'charging.recommend': recommendCharging,
    'media.play': playMedia,
    'message.prepare': prepareMessage,
    'message.send': sendMessage,
  } as const satisfies Record<ToolName, (ctx: ToolContext, input?: unknown) => ToolResult<unknown>>
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
