import { uiSpecSchema, type AirportPickupTaskState, type UISpec } from '@canvasflow/schema'

const phaseLabels: Record<AirportPickupTaskState['phase'], string> = {
  'collecting-information': '收集信息', preparing: '准备出发', 'driving-to-airport': '前往机场',
  'approaching-airport': '接近机场', 'waiting-for-passengers': '等待家人', 'returning-home': '返程中', completed: '已完成', cancelled: '已取消',
}

export type ComposerContext = { toolResults?: Record<string, unknown>; fallback?: { title: string; message?: string; level?: 'warning' | 'error' } }

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
  else if (successfulPreferences(context.toolResults?.['memory.get-preferences'])) { const preferences = (context.toolResults!['memory.get-preferences'] as { data: { temperatureC: number; mediaTitle?: string } }).data; title = '已应用家庭偏好'; density = 'compact'; components = [{ id: 'cabin-profile', type: 'cabin-profile', props: { zone: 'rear', temperatureC: preferences.temperatureC, mediaTitle: preferences.mediaTitle, appliedFromMemory: true, reversible: true } }] }
  else if (task.passengers.confirmedOnboard) { title = '返程回家'; density = 'compact'; components = [{ id: 'passenger-status', type: 'passenger-status', props: { label: `${task.passengers.names.join('和')}已上车`, status: 'confirmed-onboard' } }] }
  else if (task.message.status === 'scheduled') { title = '落地通知'; density = 'minimal'; priority = 'high'; components = [{ id: 'message-preview', type: 'message-preview', props: { contactLabel: task.passengers.names[0] ?? '乘客', textPreview: '我已到达机场，正在接你们。', status: 'scheduled', cancellable: true } }] }
  else if (task.charging.status === 'completed') { density = 'compact'; components = [{ id: 'charging-plan', type: 'charging-recommendation', props: { recommended: false, reason: '补能完成，已恢复机场路线', currentBatteryPercent: 78, estimatedFinalBatteryPercent: 42 } }] }
  else if (task.navigation) { density = 'compact'; components = [{ id: 'navigation-summary', type: 'navigation-summary', props: { routeId: task.navigation.routeId, destination: task.navigation.destination, eta: task.navigation.eta, distanceKm: 32, estimatedBatteryAtArrival: 27 } }] }
  else if (task.charging.recommended && !task.flight) components = [{ id: 'charging-plan', type: 'charging-recommendation', props: { recommended: true, reason: '完成往返后预计低于安全余量', currentBatteryPercent: 42, estimatedFinalBatteryPercent: 18, suggestedDurationMinutes: 10, etaImpactMinutes: 12 } }]
  else if (task.flight) { density = 'compact'; components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }] }
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId, taskRevision: task.taskRevision, uiRevision: nextUiRevision,
    phase: task.phase, title, presentation: { mode: 'replace', density, theme: 'dark', priority },
    layout: { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } }, components, actions,
    meta: { generatedBy: 'composer', sourceTaskRevision: task.taskRevision, requiresConfirm, generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-${nextUiRevision}` },
  })
}

function successfulPreferences(value: unknown): value is { ok: true; data: { temperatureC: number; mediaTitle?: string } } {
  if (typeof value !== 'object' || value === null || (value as { ok?: unknown }).ok !== true) return false
  const data = (value as { data?: unknown }).data
  return typeof data === 'object' && data !== null && typeof (data as { temperatureC?: unknown }).temperatureC === 'number'
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
