import { uiSpecSchema, type AirportPickupTaskState, type UISpec } from '@canvasflow/schema'
import {
  chargingDensityForSpeed,
  chargingStation,
  chargingStationsForDensity,
  recommendedMeetingPoints,
  type ChargingPresentationDensity,
} from '@canvasflow/tools'

const phaseLabels: Record<AirportPickupTaskState['phase'], string> = {
  'collecting-information': '收集信息', preparing: '准备出发', 'driving-to-airport': '前往机场',
  'approaching-airport': '接近机场', 'waiting-for-passengers': '等待家人', 'returning-home': '返程中', completed: '已完成', cancelled: '已取消',
}

export type ComposerContext = {
  toolResults?: Record<string, unknown>
  /** Explicit vehicle snapshot; wins over toolResults['vehicle.get-status'] when set. */
  vehicle?: { speedKph: number }
  fallback?: { title: string; message?: string; level?: 'warning' | 'error' }
}

export function composePickupSpec(task: AirportPickupTaskState, context: ComposerContext = {}): UISpec {
  if (context.fallback) return composeFallbackSpec(task, context.fallback.title, context.fallback.message, context.fallback.level)
  const nextUiRevision = Math.max(task.uiRevision, task.taskRevision) + 1
  const phaseOrder: AirportPickupTaskState['phase'][] = ['collecting-information', 'preparing', 'driving-to-airport', 'approaching-airport', 'waiting-for-passengers', 'returning-home', 'completed']
  const currentIndex = phaseOrder.indexOf(task.phase)
  const progressStatus = (phase: AirportPickupTaskState['phase']) => {
    const phaseIndex = phaseOrder.indexOf(phase)
    if (phase === task.phase) return 'active' as const
    if (currentIndex >= 0 && phaseIndex >= 0 && phaseIndex < currentIndex) return 'completed' as const
    return 'pending' as const
  }
  const airport = task.navigation?.destination?.includes('机场') ? task.navigation.destination.replace(/\s*T\d$/, '') : '虹桥机场'
  const allProgressPhases = task.phase === 'completed'
    ? phaseOrder.slice(-5)
    : task.phase === 'cancelled'
      ? [...phaseOrder.slice(0, 4), 'cancelled' as const]
      : phaseOrder.slice(0, Math.max(5, phaseOrder.indexOf(task.phase) + 1))
  const progressPhases = allProgressPhases.length > 5
    ? allProgressPhases.slice(-5)
    : allProgressPhases
  let components: UISpec['components'] = [
    { id: 'pickup-overview', type: 'pickup-overview' as const, props: { passengers: task.passengers.names, flightNumber: task.flight?.flightNumber ?? '待补充', airport, terminal: task.flight?.terminal ?? 'T2', phaseLabel: phaseLabels[task.phase] } },
    { id: 'task-progress', type: 'task-progress' as const, props: { currentPhase: task.phase, steps: progressPhases.map((phase) => ({ phase, label: phaseLabels[phase], status: progressStatus(phase) })) } },
  ]
  let title = task.passengers.names.length > 0 ? `去${airport}接${task.passengers.names.join('和')}` : '机场接人任务'
  let density: UISpec['presentation']['density'] = 'full'
  let priority: UISpec['presentation']['priority'] = 'normal'
  let requiresConfirm = false
  let actions: UISpec['actions'] = []
  if (task.phase === 'collecting-information') components = [{ id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号' } }]
  else if (task.phase === 'completed') {
    title = '接机任务已完成'
    components = [components[1]]
    requiresConfirm = task.pendingConfirmation?.action === 'save-memory'
    actions = requiresConfirm ? [{ id: 'save-trip-preferences', label: '保存本次偏好', style: 'primary', event: { type: 'confirmation', confirmationId: task.pendingConfirmation!.confirmationId, decision: 'accept' } }] : []
  }
  else if (task.message.status === 'scheduled') { title = '落地通知'; density = 'minimal'; priority = 'high'; components = [{ id: 'message-preview', type: 'message-preview', props: { contactLabel: task.passengers.names[0] ?? '乘客', textPreview: '我已到达机场，正在接你们。', status: 'scheduled', cancellable: true } }] }
  else if (task.message.status === 'failed') {
    title = '落地通知失败'
    density = 'minimal'
    priority = 'high'
    components = [{ id: 'message-preview', type: 'message-preview', props: { contactLabel: task.passengers.names[0] ?? '乘客', textPreview: '我已到达机场，正在接你们。', status: 'failed', cancellable: false } }]
    actions =
      task.pendingConfirmation?.action === 'send-message'
        ? [{ id: 'confirm-retry-landing-message', label: '确认发送', style: 'primary', event: { type: 'confirmation', confirmationId: task.pendingConfirmation.confirmationId, decision: 'accept' } }]
        : [{ id: 'retry-landing-message', label: '重试发送', style: 'primary', event: { type: 'tool-request', actionToken: `${task.taskId}:retry-landing-message` } }]
  }
  else if (
    task.charging.status === 'completed' &&
    (task.phase === 'driving-to-airport' || task.phase === 'approaching-airport')
  ) {
    density = 'compact'
    components = [{ id: 'charging-plan', type: 'charging-recommendation', props: { recommended: false, reason: '补能完成，机场路线上下文保持', currentBatteryPercent: 78, estimatedFinalBatteryPercent: 42 } }]
  }
  else if (
    task.phase === 'returning-home' &&
    task.passengers.confirmedOnboard &&
    successfulPreferences(context.toolResults?.['memory.get-preferences'])
  ) {
    const members = (context.toolResults!['memory.get-preferences'] as {
      data: { members: Array<{ rearTemperatureC?: number; mediaTitle?: string; fanLevel?: number }> }
    }).data.members
    const temperatureC = members.find((member) => typeof member.rearTemperatureC === 'number')?.rearTemperatureC
    const mediaTitle = members.find((member) => typeof member.mediaTitle === 'string')?.mediaTitle
    const fanLevel = members.find((member) => typeof member.fanLevel === 'number')?.fanLevel
    title = '已应用家庭偏好'
    density = 'compact'
    const cabinProps: {
      zone: 'rear'
      appliedFromMemory: true
      reversible: true
      temperatureC?: number
      mediaTitle?: string
      fanLevel?: number
    } = {
      zone: 'rear',
      appliedFromMemory: true,
      reversible: true,
    }
    if (temperatureC !== undefined) cabinProps.temperatureC = temperatureC
    if (mediaTitle !== undefined) cabinProps.mediaTitle = mediaTitle
    if (fanLevel !== undefined) cabinProps.fanLevel = fanLevel
    components = [{ id: 'cabin-profile', type: 'cabin-profile', props: cabinProps }]
  }
  else if (task.passengers.confirmedOnboard) { title = '返程回家'; density = 'compact'; components = [{ id: 'passenger-status', type: 'passenger-status', props: { label: `${task.passengers.names.join('和')}已上车`, status: 'confirmed-onboard' } }] }
  else if (task.phase === 'approaching-airport' || task.phase === 'waiting-for-passengers') {
    density = 'compact'
    const meeting = task.flight?.terminal ? recommendedMeetingPoints[task.flight.terminal] : undefined
    components = [{
      id: 'passenger-status',
      type: 'passenger-status',
      props: {
        label: task.phase === 'waiting-for-passengers' ? '已停稳，等待家人' : '接近接机点',
        status: task.phase === 'waiting-for-passengers' ? 'waiting' : 'landed',
        ...(meeting ? { meetingPoint: meeting.name } : {}),
      },
    }]
  }
  else if (task.navigation) { density = 'compact'; components = [{ id: 'navigation-summary', type: 'navigation-summary', props: { routeId: task.navigation.routeId, destination: task.navigation.destination, eta: task.navigation.eta, distanceKm: 32, estimatedBatteryAtArrival: 27 } }] }
  else if (task.flight && (task.flight.status === 'cancelled' || task.flight.status === 'delayed')) {
    // Exception flight states outrank a pending charging recommendation.
    density = 'compact'
    components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }]
  }
  else if (task.charging.recommended && task.charging.status === 'planned' && task.phase === 'preparing') {
    density = chargingDensityFromContext(context)
    const stations = chargingStationsForDensity(density)
    components = [{
      id: 'charging-plan',
      type: 'charging-recommendation',
      props: {
        recommended: true,
        reason: `完成往返后预计低于安全余量（对比 ${stations.length} 站）`,
        currentBatteryPercent: 42,
        estimatedFinalBatteryPercent: 18,
        suggestedDurationMinutes: chargingStation.suggestedDurationMinutes,
        etaImpactMinutes: chargingStation.etaImpactMinutes,
      },
    }]
  }
  else if (task.flight) { density = 'compact'; components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }] }
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId, taskRevision: task.taskRevision, uiRevision: nextUiRevision,
    phase: task.phase, title, presentation: { mode: 'replace', density, theme: 'dark', priority },
    layout: { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } }, components, actions,
    meta: { generatedBy: 'composer', sourceTaskRevision: task.taskRevision, requiresConfirm, generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-${nextUiRevision}` },
  })
}

/** Parked→full, city→compact, highway→minimal; missing vehicle context defaults to full. */
function chargingDensityFromContext(context: ComposerContext): ChargingPresentationDensity {
  const speedKph = resolveVehicleSpeedKph(context)
  return speedKph === undefined ? 'full' : chargingDensityForSpeed(speedKph)
}

function resolveVehicleSpeedKph(context: ComposerContext): number | undefined {
  if (typeof context.vehicle?.speedKph === 'number' && Number.isFinite(context.vehicle.speedKph)) {
    return Math.max(0, context.vehicle.speedKph)
  }
  const result = context.toolResults?.['vehicle.get-status']
  if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== true) return undefined
  const data = (result as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return undefined
  const speedKph = (data as { speedKph?: unknown }).speedKph
  return typeof speedKph === 'number' && Number.isFinite(speedKph) ? Math.max(0, speedKph) : undefined
}

/** Matches the memory.get-preferences output contract: any applicable cabin/media preference counts. */
function successfulPreferences(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || (value as { ok?: unknown }).ok !== true) return false
  const data = (value as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return false
  const members = (data as { members?: unknown }).members
  return Array.isArray(members) && members.some((member) => {
    if (typeof member !== 'object' || member === null) return false
    const record = member as { rearTemperatureC?: unknown; mediaTitle?: unknown }
    // memory.get-preferences does not emit fanLevel; only temperature/media count.
    return typeof record.rearTemperatureC === 'number' || typeof record.mediaTitle === 'string'
  })
}

export function composeFallbackSpec(task: AirportPickupTaskState, title: string, message?: string, level: 'warning' | 'error' = 'warning'): UISpec {
  const nextUiRevision = Math.max(task.uiRevision, task.taskRevision) + 1
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId, taskRevision: task.taskRevision, uiRevision: nextUiRevision,
    phase: task.phase, title: '接机任务', presentation: { mode: 'replace', density: 'minimal', theme: 'dark', priority: 'high' },
    layout: { type: 'stack', gap: 'md', slots: { main: ['offline-banner'] } },
    components: [{ id: 'offline-banner', type: 'status-banner', props: { level, title, message } }], actions: [],
    meta: { generatedBy: 'fallback', sourceTaskRevision: task.taskRevision, requiresConfirm: false, generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-fallback-${nextUiRevision}` },
  })
}
