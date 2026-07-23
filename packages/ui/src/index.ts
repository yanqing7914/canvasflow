import { uiSpecSchema, type AirportPickupTaskState, type UISpec } from '@canvasflow/schema'

const phaseLabels: Record<AirportPickupTaskState['phase'], string> = {
  'collecting-information': '收集信息', preparing: '准备出发', 'driving-to-airport': '前往机场',
  'approaching-airport': '接近机场', 'waiting-for-passengers': '等待家人', 'returning-home': '返程中', completed: '已完成', cancelled: '已取消',
}

export function composePickupSpec(task: AirportPickupTaskState): UISpec {
  const phaseOrder: AirportPickupTaskState['phase'][] = ['collecting-information', 'preparing', 'driving-to-airport', 'approaching-airport', 'waiting-for-passengers', 'returning-home', 'completed']
  const currentIndex = phaseOrder.indexOf(task.phase)
  const progressStatus = (phase: AirportPickupTaskState['phase']) => {
    const phaseIndex = phaseOrder.indexOf(phase)
    if (phase === task.phase) return 'active' as const
    if (currentIndex >= 0 && phaseIndex >= 0 && phaseIndex < currentIndex) return 'completed' as const
    return 'pending' as const
  }
  const airport = task.navigation?.destination?.includes('机场') ? task.navigation.destination.replace(/\s*T\d$/, '') : '虹桥机场'
  const title = task.passengers.names.length > 0
    ? `去${airport}接${task.passengers.names.join('和')}`
    : '机场接人任务'
  const progressPhases = task.phase === 'completed'
    ? phaseOrder.slice(-5)
    : task.phase === 'cancelled'
      ? [...phaseOrder.slice(0, 4), 'cancelled' as const]
      : phaseOrder.slice(0, 5)
  const components = [
    { id: 'pickup-overview', type: 'pickup-overview' as const, props: { passengers: task.passengers.names, flightNumber: task.flight?.flightNumber ?? '待补充', airport, terminal: task.flight?.terminal ?? 'T2', phaseLabel: phaseLabels[task.phase] } },
    { id: 'task-progress', type: 'task-progress' as const, props: { currentPhase: task.phase, steps: progressPhases.map((phase) => ({ phase, label: phaseLabels[phase], status: progressStatus(phase) })) } },
  ]
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId, taskRevision: task.taskRevision, uiRevision: task.uiRevision + 1,
    phase: task.phase, title, presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
    layout: { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } }, components, actions: [],
    meta: { generatedBy: 'composer', sourceTaskRevision: task.taskRevision, requiresConfirm: false, generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-${task.uiRevision + 1}` },
  })
}

export function composeFallbackSpec(task: AirportPickupTaskState, title: string, message?: string): UISpec {
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId, taskRevision: task.taskRevision, uiRevision: task.uiRevision + 1,
    phase: task.phase, title: '接机任务', presentation: { mode: 'replace', density: 'minimal', theme: 'dark', priority: 'high' },
    layout: { type: 'stack', gap: 'md', slots: { main: ['status-banner'] } },
    components: [{ id: 'status-banner', type: 'status-banner', props: { level: 'warning', title, message } }], actions: [],
    meta: { generatedBy: 'fallback', sourceTaskRevision: task.taskRevision, requiresConfirm: false, generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-fallback-${task.uiRevision + 1}` },
  })
}
