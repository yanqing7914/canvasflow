import type { ToolDefinition } from '@canvasflow/schema'
import { recommendCharging } from './charging'
import { resolveMembers } from './family'
import { getFlightStatus } from './flight'
import { getPreferences } from './memory'
import { planRoute } from './navigation'
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

export function createToolRegistry() {
  return {
    'family.resolve-members': resolveMembers,
    'memory.get-preferences': getPreferences,
    'flight.get-status': getFlightStatus,
    'navigation.plan-route': planRoute,
    'vehicle.get-status': getVehicleStatus,
    'charging.recommend': recommendCharging,
  } as const satisfies Record<ToolName, unknown>
}
