import { uiSpecSchema, type AirportPickupTaskState, type UISpec } from '@canvasflow/schema'

const phaseLabels: Record<AirportPickupTaskState['phase'], string> = {
  'collecting-information': '收集信息', preparing: '准备出发', 'driving-to-airport': '前往机场',
  'approaching-airport': '接近机场', 'waiting-for-passengers': '等待家人', 'returning-home': '返程中', completed: '已完成', cancelled: '已取消',
}

export function composePickupSpec(task: AirportPickupTaskState): UISpec {
  const components = [
    { id: 'pickup-overview', type: 'pickup-overview' as const, props: { passengers: task.passengers.names, flightNumber: task.flight?.flightNumber ?? '待补充', airport: '虹桥机场', terminal: task.flight?.terminal ?? 'T2', phaseLabel: phaseLabels[task.phase] } },
    { id: 'task-progress', type: 'task-progress' as const, props: { currentPhase: task.phase, steps: ['preparing', 'driving-to-airport', 'waiting-for-passengers', 'returning-home', 'completed'].map((phase) => ({ phase: phase as AirportPickupTaskState['phase'], label: phaseLabels[phase as AirportPickupTaskState['phase']], status: phase === task.phase ? 'active' as const : 'pending' as const })) } },
  ]
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId, taskRevision: task.taskRevision, uiRevision: task.uiRevision + 1,
    phase: task.phase, title: '去虹桥机场接妈妈和豆豆', presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
    layout: { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } }, components, actions: [],
    meta: { generatedBy: 'composer', sourceTaskRevision: task.taskRevision, requiresConfirm: false, generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-${task.uiRevision + 1}` },
  })
}
