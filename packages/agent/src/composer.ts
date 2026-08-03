import { uiSpecSchema, type AirportPickupTaskState, type UISpec } from '@canvasflow/schema'
import { memberPreferences, routeSketchFor, type MemberPreferenceRecord } from '@canvasflow/tools'
import { canRetryLandingMessage } from './landing-message-retry'
import type { ReadToolResults } from './orchestration'
import type { StoredTask } from './store'

const phaseLabels: Record<AirportPickupTaskState['phase'], string> = {
  'collecting-information': '收集信息',
  preparing: '准备出发',
  'driving-to-airport': '前往机场',
  'approaching-airport': '接近机场',
  'waiting-for-passengers': '等待家人',
  'returning-home': '返程中',
  completed: '已完成',
  cancelled: '已取消',
}

export function composeAgentSpec(task: AirportPickupTaskState, toolResults?: ReadToolResults): UISpec
export function composeAgentSpec(
  task: AirportPickupTaskState,
  preferences?: Record<string, MemberPreferenceRecord>,
): UISpec
export function composeAgentSpec(
  task: AirportPickupTaskState,
  toolResults?: ReadToolResults,
  preferences?: Record<string, MemberPreferenceRecord>,
  privateContext?: { cabinRevertActionToken?: string },
): UISpec
export function composeAgentSpec(
  task: AirportPickupTaskState,
  context?: ReadToolResults | Record<string, MemberPreferenceRecord>,
  preferences?: Record<string, MemberPreferenceRecord>,
  privateContext?: { cabinRevertActionToken?: string },
): UISpec {
  const hasExplicitPreferences = preferences !== undefined
  const contextIsToolResults = hasExplicitPreferences || context === undefined || isReadToolResults(context)
  const toolResults = contextIsToolResults ? (context as ReadToolResults | undefined) ?? {} : {}
  const resolvedPreferences = contextIsToolResults
    ? preferences ?? memberPreferences
    : context as Record<string, MemberPreferenceRecord>
  const progress = progressComponent(task)
  let components: UISpec['components'] = [overviewComponent(task), progress]
  let title = task.passengers.names.length > 0
    ? `去虹桥机场接${task.passengers.names.join('和')}`
    : '机场接人任务'
  let density: UISpec['presentation']['density'] = 'full'
  let priority: UISpec['presentation']['priority'] = 'normal'
  let actions: UISpec['actions'] = []
  let requiresConfirm = false

  if (task.phase === 'collecting-information') {
    components = [{ id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号' } }]
  } else if (task.phase === 'cancelled') {
    title = '接机任务已取消'
    priority = 'high'
    components = [{ id: 'status-banner', type: 'status-banner', props: { level: 'warning', title: '接机任务已取消' } }]
  } else if (task.phase === 'completed') {
    title = '接机任务已完成'
    components = [progress]
    requiresConfirm = task.pendingConfirmation?.action === 'save-memory'
    actions = requiresConfirm
      ? [
          { id: 'save-trip-preferences', label: '保存本次偏好', style: 'primary', event: { type: 'confirmation', confirmationId: task.pendingConfirmation!.confirmationId, decision: 'accept' } },
          { id: 'reject-trip-preferences', label: '暂不保存', style: 'secondary', event: { type: 'confirmation', confirmationId: task.pendingConfirmation!.confirmationId, decision: 'reject' } },
        ]
      : []
  } else if (task.phase === 'preparing' && task.flight && toolResults['navigation.plan-route'] && toolResults['charging.recommend'] && toolResults['vehicle.get-status']) {
    const route = toolResults['navigation.plan-route'].data
    const charging = toolResults['charging.recommend'].data
    const vehicle = toolResults['vehicle.get-status'].data
    const plannedSketch = routeSketchFor(task, route)
    density = 'compact'
    components = [
      { id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } },
      { id: 'navigation-plan', type: 'navigation-summary', props: { routeId: route.routeId, destination: task.navigation?.destination ?? '虹桥机场 T2', eta: task.navigation?.eta ?? route.arrivalTime, distanceKm: route.distanceKm, estimatedBatteryAtArrival: route.estimatedBatteryAtArrival, ...(plannedSketch ? { routeSketch: plannedSketch } : {}) } },
      { id: 'charging-plan', type: 'charging-recommendation', props: { recommended: charging.recommended, reason: charging.reason, currentBatteryPercent: vehicle.batteryPercent, estimatedFinalBatteryPercent: charging.estimatedFinalBatteryPercent, suggestedDurationMinutes: charging.suggestedDurationMinutes, etaImpactMinutes: charging.etaImpactMinutes } },
    ]
  } else if (task.passengers.confirmedOnboard) {
    title = '返程回家'
    density = 'compact'
    components = [{ id: 'passenger-status', type: 'passenger-status', props: { label: `${task.passengers.names.join('和')}已上车`, status: 'confirmed-onboard' } }]
    const preferences = toolResults['memory.get-preferences']?.data.members
    const temperatureC = preferences?.find((member) => member.rearTemperatureC !== undefined)?.rearTemperatureC
    const mediaTitle = preferences?.find((member) => member.mediaTitle !== undefined)?.mediaTitle
    const cabinRevertStatus = task.returnTrip?.cabin.revert?.status
    const cabinReverted = cabinRevertStatus === 'succeeded'
    const cabinApplied = task.returnTrip?.cabin.status === 'succeeded' && !cabinReverted
    const cabinRevertAvailable = privateContext?.cabinRevertActionToken !== undefined
      && cabinRevertStatus !== 'unknown'
      && cabinRevertStatus !== 'succeeded'
    if (cabinApplied && (temperatureC !== undefined || mediaTitle !== undefined)) {
      const cabinProps = {
        zone: 'rear' as const,
        ...(temperatureC !== undefined ? { temperatureC } : {}),
        ...(mediaTitle !== undefined ? { mediaTitle } : {}),
        appliedFromMemory: true,
        reversible: cabinRevertAvailable,
      }
      const cabinComponent = {
        id: 'cabin-profile',
        type: 'cabin-profile',
        visibility: 'parked-only',
        props: cabinProps,
        ...(cabinRevertAvailable ? { actions: ['revert-cabin-profile'] } : {}),
      } as const
      components = [...components, cabinComponent]
      if (cabinRevertStatus === 'failed') {
        components.push({
          id: 'cabin-revert-failed',
          type: 'status-banner',
          props: { level: 'error', title: '座舱设置撤销失败', message: '设置仍保持生效，可停车后重试。' },
        })
      } else if (cabinRevertStatus === 'unknown') {
        components.push({
          id: 'cabin-revert-unknown',
          type: 'status-banner',
          props: { level: 'warning', title: '座舱状态待确认', message: '为避免重复操作，已暂停再次撤销。' },
        })
      }
      actions = cabinRevertAvailable
        ? [{
            id: 'revert-cabin-profile',
            label: '撤销座舱设置',
            style: 'secondary',
            event: {
              type: 'tool-request',
              actionToken: privateContext!.cabinRevertActionToken!,
            },
          }]
        : []
    }
    if (cabinReverted) {
      components.push({
        id: 'cabin-reverted',
        type: 'status-banner',
        props: { level: 'info', title: '座舱设置已撤销', message: '已恢复应用前的座舱配置；媒体播放不包含在本次撤销中。' },
      })
    }
    if (task.returnTrip && [task.returnTrip.route, task.returnTrip.cabin, task.returnTrip.media].some((effect) => effect.status === 'failed')) {
      const passengerIndex = components.findIndex((component) => component.id === 'passenger-status')
      if (passengerIndex >= 0) components[passengerIndex] = { ...components[passengerIndex]!, actions: ['retry-return-trip'] }
      actions = [
        ...actions,
        { id: 'retry-return-trip', label: '重试返程设置', style: 'primary', event: { type: 'tool-request', actionToken: `${task.taskId}:retry-return-trip` } },
      ]
    }
  } else if (task.message.status === 'scheduled') {
    title = '落地通知'
    density = 'minimal'
    priority = 'high'
    components = [{ id: 'message-preview', type: 'message-preview', props: { contactLabel: task.passengers.names[0] ?? '乘客', textPreview: '我已到达机场，正在接你们。', status: 'scheduled', cancellable: true, scheduledAt: task.message.scheduledAt } }]
  } else if (task.message.status === 'failed') {
    title = '落地通知失败'
    density = 'minimal'
    priority = 'high'
    const retryAvailable =
      task.pendingConfirmation?.action === 'send-message'
      || canRetryLandingMessage(task, resolvedPreferences)
    if (!retryAvailable) {
      components = [{
        id: 'status-banner',
        type: 'status-banner',
        props: {
          level: 'error',
          title: '无法重试发送',
          message: '没有已授权的落地通知联系人',
        },
      }]
      actions = []
    } else {
      components = [{
        id: 'message-preview',
        type: 'message-preview',
        props: {
          contactLabel: task.passengers.names[0] ?? '乘客',
          textPreview: '我已到达机场，正在接你们。',
          status: 'failed',
          cancellable: false,
        },
        actions: task.pendingConfirmation?.action === 'send-message'
          ? ['confirm-retry-landing-message']
          : ['retry-landing-message'],
      }]
      actions =
        task.pendingConfirmation?.action === 'send-message'
          ? [{ id: 'confirm-retry-landing-message', label: '确认发送', style: 'primary', event: { type: 'confirmation', confirmationId: task.pendingConfirmation.confirmationId, decision: 'accept' } }]
          : [{ id: 'retry-landing-message', label: '重试发送', style: 'primary', event: { type: 'tool-request', actionToken: `${task.taskId}:retry-landing-message` } }]
    }
  } else if (task.charging.status === 'completed') {
    density = 'compact'
    components = [{ id: 'charging-plan', type: 'charging-recommendation', props: { recommended: false, reason: '补能完成，已恢复机场路线', currentBatteryPercent: 78, estimatedFinalBatteryPercent: 42 } }]
  } else if (task.flight && (task.flight.status === 'cancelled' || task.flight.status === 'delayed')) {
    // Exception flight states outrank active navigation and pending charging.
    density = 'compact'
    components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival ?? task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }]
  } else if (task.charging.recommended && !task.flight) {
    components = [{ id: 'charging-plan', type: 'charging-recommendation', props: { recommended: true, reason: '完成往返后预计低于安全余量', currentBatteryPercent: 42, estimatedFinalBatteryPercent: 18, suggestedDurationMinutes: 10, etaImpactMinutes: 12 } }]
  } else if (task.navigation) {
    density = 'compact'
    const activeSketch = routeSketchFor(task, { routeId: task.navigation.routeId })
    components = [{ id: 'navigation-summary', type: 'navigation-summary', props: { routeId: task.navigation.routeId, destination: task.navigation.destination, eta: task.navigation.eta, distanceKm: 32, estimatedBatteryAtArrival: 27, ...(activeSketch ? { routeSketch: activeSketch } : {}) } }]
  } else if (task.flight && task.flight.trusted === false) {
    components = [{ id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '航班号已收到', message: '航班信息正在确认中。' } }]
  } else if (task.flight) {
    density = 'compact'
    components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival ?? task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }]
  }
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId,
    taskRevision: task.taskRevision, uiRevision: Math.max(task.uiRevision, task.taskRevision) + 1,
    phase: task.phase, title,
    presentation: { mode: 'replace', density, theme: 'dark', priority },
    layout: { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } },
    components, actions,
    meta: {
      generatedBy: 'composer', sourceTaskRevision: task.taskRevision, requiresConfirm,
      generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-${task.taskRevision}`,
    },
  })
}

const densityRank: Record<UISpec['presentation']['density'], number> = { full: 0, compact: 1, minimal: 2 }

export function applyRequestPresentation(ui: UISpec, context: StoredTask['requestContext']): UISpec {
  if (!context) return ui
  const fromSpeed: UISpec['presentation']['density'] = context.vehicle.speedKph > 60
    ? 'minimal'
    : context.vehicle.speedKph > 0
      ? 'compact'
      : 'full'
  // Two independent claims about how much reading this screen can carry: the composer
  // knows how much content the phase puts on the brief, the vehicle context knows what
  // the cabin can afford. Neither is allowed to loosen the other, so the stricter one
  // wins. Letting speed replace the composer's answer meant a parked car re-expanded a
  // brief the composer had already declared too full for `full` density.
  const density = densityRank[fromSpeed] >= densityRank[ui.presentation.density] ? fromSpeed : ui.presentation.density
  const maxComponents = density === 'minimal' ? 2 : density === 'compact' ? 4 : 6
  const components = ui.components.slice(0, maxComponents).map((component) => (
    component.type === 'charging-recommendation'
      ? {
          ...component,
          props: { ...component.props, currentBatteryPercent: context.vehicle.batteryPercent },
        }
      : component
  ))
  const retainedComponentActionIds = new Set(components.flatMap((component) => component.actions ?? []))
  const ownedActionIds = new Set(ui.components.flatMap((component) => component.actions ?? []))
  const actions = ui.actions.filter((action) => (
    retainedComponentActionIds.has(action.id) || !ownedActionIds.has(action.id)
  ))
  const registeredActionIds = new Set(actions.map((action) => action.id))
  const componentsWithActions = components.map((component) => component.actions
    ? { ...component, actions: component.actions.filter((actionId) => registeredActionIds.has(actionId)) }
    : component)
  const layout = {
    type: 'stack' as const,
    gap: ui.layout.type === 'stack' ? ui.layout.gap : 'md' as const,
    slots: { main: componentsWithActions.map((component) => component.id) },
  }
  return uiSpecSchema.parse({
    ...ui,
    presentation: {
      ...ui.presentation,
      density,
      theme: context.vehicle.isNight ? 'dark' : 'light',
    },
    layout,
    components: componentsWithActions,
    actions,
  })
}

/**
 * Stable, schema-checked UI used when a read provider cannot produce a
 * trustworthy result. It intentionally contains no derived provider facts.
 */
export function composeFallbackSpec(
  task: AirportPickupTaskState,
  title: string,
  message?: string,
  level: 'warning' | 'error' = 'warning',
  retry?: { actionId: string; label: string; componentId: string; actionToken: string },
): UISpec {
  const nextUiRevision = Math.max(task.uiRevision, task.taskRevision) + 1
  const actions: UISpec['actions'] = retry
    ? [{ id: retry.actionId, label: retry.label, style: 'primary', event: { type: 'tool-request', actionToken: retry.actionToken } }]
    : []
  return uiSpecSchema.parse({
    version: '1.0',
    taskId: task.taskId,
    surfaceId: task.surfaceId,
    taskRevision: task.taskRevision,
    uiRevision: nextUiRevision,
    phase: task.phase,
    title,
    presentation: { mode: 'replace', density: 'minimal', theme: 'dark', priority: 'high' },
    layout: { type: 'stack', gap: 'md', slots: { main: [retry?.componentId ?? 'provider-fallback'] } },
    components: [{
      id: retry?.componentId ?? 'provider-fallback',
      type: 'status-banner',
      props: { level, title, message },
      ...(retry ? { actions: [retry.actionId] } : {}),
    }],
    actions,
    meta: {
      generatedBy: 'fallback',
      sourceTaskRevision: task.taskRevision,
      requiresConfirm: false,
      generatedAt: task.updatedAt,
      traceId: `trace-${task.taskId}-fallback-${nextUiRevision}`,
    },
  })
}

function isReadToolResults(
  value: ReadToolResults | Record<string, MemberPreferenceRecord>,
): value is ReadToolResults {
  return Object.values(value).some((result) => (
    typeof result === 'object'
    && result !== null
    && 'ok' in result
    && 'data' in result
    && 'error' in result
    && 'meta' in result
  ))
}

function overviewComponent(task: AirportPickupTaskState): UISpec['components'][number] {
  return {
    id: 'pickup-overview',
    type: 'pickup-overview',
    props: {
      passengers: task.passengers.names,
      flightNumber: task.flight?.flightNumber ?? '待补充',
      airport: '虹桥机场',
      terminal: task.flight?.terminal ?? 'T2',
      phaseLabel: phaseLabels[task.phase],
    },
  }
}

function progressComponent(task: AirportPickupTaskState): UISpec['components'][number] {
  const phases: AirportPickupTaskState['phase'][] = [
    'collecting-information', 'preparing', 'driving-to-airport', 'approaching-airport', 'waiting-for-passengers', 'returning-home', 'completed',
  ]
  const currentIndex = phases.indexOf(task.phase)
  const visiblePhases = task.phase === 'completed' ? phases.slice(-5) : phases.slice(0, Math.max(5, currentIndex + 1))
  return {
    id: 'task-progress',
    type: 'task-progress',
    props: {
      currentPhase: task.phase,
      steps: visiblePhases.slice(-5).map((phase) => ({
        phase,
        label: phaseLabels[phase],
        status: phase === task.phase ? 'active' : phases.indexOf(phase) < currentIndex ? 'completed' : 'pending',
      })),
    },
  }
}
