import { uiSpecSchema, type AirportPickupTaskState, type CalendarEvent, type FlightArrivalCandidate, type FlightArrivalsOutput, type RouteSketch, type UISpec, type WeatherOutput } from '@canvasflow/schema'
import {
  chargingStation,
  chargingStationsForDensity,
  estimateFinalBatteryPercent,
  memberPreferences,
  recommendedMeetingPoints,
  routeSketchFor,
  vehicleSnapshots,
  type MemberPreferenceRecord,
} from '@canvasflow/tools'
import { canRetryLandingMessage } from './landing-message-retry'
import type { ReadToolResults } from './orchestration'
import type { StoredTask } from './store'

/** Canonical demo round-trip legs, used when no charging.recommend output is available. */
const DEMO_LEG_KM = 32

/** Rows the arrivals board offers: the schema's ceiling, and the frame's. */
const MAX_FLIGHT_CHOICES = 5

/**
 * Everything the gateway knows that is neither task state nor a tool read.
 *
 * `cabinRevertActionToken` is a secret the composer may only spend, never mint.
 * `departureAnswer` is the opposite kind of thing — a flag saying this turn was
 * a question about when to leave — and it lives here for the same reason: the
 * composer cannot tell from the snapshot alone which turn asked.
 */
export type ComposeContext = {
  cabinRevertActionToken?: string
  departureAnswer?: true
}

/** The pre-departure screen's own question, asked as ordinary user input. */
export const ASK_DEPARTURE_TIME_ACTION_ID = 'ask-departure-time'

/**
 * The two side scenes the drive can ask about without leaving it.
 *
 * The labels are the sentences. A driver who reads 看下天气 off the brief has
 * also just learned what to say next time, and both paths land in the same
 * planner branch — so the button teaches the voice command instead of being an
 * alternative to it.
 */
export const ASK_WEATHER_ACTION_ID = 'ask-weather'
export const ASK_SCHEDULE_ACTION_ID = 'ask-schedule'

const EN_ROUTE_QUERY_ACTIONS: UISpec['actions'] = [
  { id: ASK_WEATHER_ACTION_ID, label: '看下天气', style: 'secondary', event: { type: 'agent-message', text: '看下天气' } },
  { id: ASK_SCHEDULE_ACTION_ID, label: '看看日程', style: 'secondary', event: { type: 'agent-message', text: '看看日程' } },
]

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
  composeContext?: ComposeContext,
): UISpec
export function composeAgentSpec(
  task: AirportPickupTaskState,
  context?: ReadToolResults | Record<string, MemberPreferenceRecord>,
  preferences?: Record<string, MemberPreferenceRecord>,
  composeContext?: ComposeContext,
): UISpec {
  const hasExplicitPreferences = preferences !== undefined
  const contextIsToolResults = hasExplicitPreferences || context === undefined || isReadToolResults(context)
  const toolResults = contextIsToolResults ? (context as ReadToolResults | undefined) ?? {} : {}
  const resolvedPreferences = contextIsToolResults
    ? preferences ?? memberPreferences
    : context as Record<string, MemberPreferenceRecord>
  const progress = progressComponent(task)
  let components: UISpec['components'] = [overviewComponent(task), progress]
  let layout: UISpec['layout'] | undefined
  let title = task.passengers.names.length > 0
    ? `去虹桥机场接${task.passengers.names.join('和')}`
    : '机场接人任务'
  let density: UISpec['presentation']['density'] = 'full'
  let priority: UISpec['presentation']['priority'] = 'normal'
  let actions: UISpec['actions'] = []
  let requiresConfirm = false

  if (task.phase === 'collecting-information') {
    // A board the driver can pick from answers the missing slot better than a
    // banner asking them to recall a number. When there is no usable board the
    // ask stands unchanged: the question is still the question.
    const board = flightChoicesComponent(toolResults['flight.list-arrivals']?.data)
    components = board
      ? [board.component]
      : [{ id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号' } }]
    actions = board?.actions ?? []
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
    // The pre-departure brief stays a full-width stack: it carries three detail
    // cards, and a map would need a column of its own, which — beside three cards
    // designed as wide bands — cannot fit the fixed frame. The map gets its own
    // slot once driving begins (see the `task.navigation` branch below), the
    // screen this route sketch is actually the hero of. The planned sketch still
    // rides inside `navigation-plan`; the multi-card guard keeps its band hidden.
    components = [
      { id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } },
      { id: 'navigation-plan', type: 'navigation-summary', props: { routeId: route.routeId, destination: task.navigation?.destination ?? '虹桥机场 T2', eta: task.navigation?.eta ?? route.arrivalTime, distanceKm: route.distanceKm, estimatedBatteryAtArrival: route.estimatedBatteryAtArrival, ...(plannedSketch ? { routeSketch: plannedSketch } : {}) } },
      { id: 'charging-plan', type: 'charging-recommendation', props: { recommended: charging.recommended, reason: charging.reason, currentBatteryPercent: vehicle.batteryPercent, estimatedFinalBatteryPercent: charging.estimatedFinalBatteryPercent, suggestedDurationMinutes: charging.suggestedDurationMinutes, etaImpactMinutes: charging.etaImpactMinutes } },
    ]
    const calendar = toolResults['calendar.list-upcoming']
    if (calendar && calendar.data.events.length > 0) {
      const strip = preparingScheduleStrip(task.flight, route, charging, calendar.data.events)
      if (strip) components.push(strip)
    }
    // The one thing the pre-departure screen cannot answer by standing still. It
    // sits on the card that carries the ETA rather than in the global bar, beside
    // the number it is a question about, and it travels as ordinary user input so
    // the button and the spoken sentence reach the same planner branch.
    const planIndex = components.findIndex((component) => component.id === 'navigation-plan')
    if (planIndex >= 0) {
      components[planIndex] = { ...components[planIndex]!, actions: [ASK_DEPARTURE_TIME_ACTION_ID] }
      actions = [{
        id: ASK_DEPARTURE_TIME_ACTION_ID,
        label: '什么时候出发',
        style: 'secondary',
        event: { type: 'agent-message', text: '什么时候出发' },
      }]
    }
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
    const cabinRevertAvailable = composeContext?.cabinRevertActionToken !== undefined
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
              actionToken: composeContext!.cabinRevertActionToken!,
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
    const returnCalendar = toolResults['calendar.list-upcoming']
    if (task.phase === 'returning-home' && task.navigation && returnCalendar && returnCalendar.data.events.length > 0) {
      const strip = returningScheduleStrip(task.navigation.eta, returnCalendar.data.events)
      if (strip) components.push(strip)
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
  } else if (task.charging.status === 'completed' && task.phase === 'driving-to-airport') {
    // The charging stop is on the airport route, so nothing is "restored" when it
    // finishes — the route, ETA and every other context value carry over unchanged
    // (`degradation.test.ts` asserts exactly that). The phase guard matters too: a
    // completed charge stays `completed` for the rest of the trip, and without it
    // this branch kept the card on screen through the airport approach and after
    // the car had parked, hiding the meeting point the driver needs at that
    // moment. Post-charge battery is news on the leg it happened on; at the
    // airport the arrival screen outranks it.
    const postCharge = vehicleSnapshots['post-charge']
    density = 'compact'
    components = [{
      id: 'charging-plan',
      type: 'charging-recommendation',
      props: {
        recommended: false,
        reason: '补能完成，机场路线上下文保持',
        currentBatteryPercent: postCharge.batteryPercent,
        estimatedFinalBatteryPercent: estimateFinalBatteryPercent(
          postCharge.batteryPercent, postCharge.remainingRangeKm, DEMO_LEG_KM, DEMO_LEG_KM,
        ),
      },
    }]
  } else if (task.phase === 'approaching-airport' || task.phase === 'waiting-for-passengers') {
    const waiting = task.phase === 'waiting-for-passengers'
    const meetingPoint = task.flight?.terminal ? recommendedMeetingPoints[task.flight.terminal] : undefined
    density = 'compact'
    components = [{
      id: 'passenger-status',
      type: 'passenger-status',
      props: {
        label: waiting ? '已停稳，等待家人' : '接近接机点',
        status: waiting ? 'waiting' : 'landed',
        ...(meetingPoint ? { meetingPoint: meetingPoint.name } : {}),
      },
    }]
  } else if (task.flight && (task.flight.status === 'cancelled' || task.flight.status === 'delayed')) {
    // Exception flight states outrank active navigation and pending charging.
    density = 'compact'
    components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival ?? task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }]
  } else if (task.charging.recommended && !task.flight) {
    // Both battery numbers come from one snapshot so the card cannot contradict
    // itself, and the station count matches what the same density tier surfaces.
    const parked = vehicleSnapshots.parked
    components = [{
      id: 'charging-plan',
      type: 'charging-recommendation',
      props: {
        recommended: true,
        reason: `完成往返后预计低于安全余量（对比 ${chargingStationsForDensity(density).length} 站）`,
        currentBatteryPercent: parked.batteryPercent,
        estimatedFinalBatteryPercent: estimateFinalBatteryPercent(
          parked.batteryPercent, parked.remainingRangeKm, DEMO_LEG_KM, DEMO_LEG_KM,
        ),
        suggestedDurationMinutes: chargingStation.suggestedDurationMinutes,
        etaImpactMinutes: chargingStation.etaImpactMinutes,
      },
    }]
  } else if (task.navigation) {
    density = 'compact'
    const activeSketch = routeSketchFor(task, { routeId: task.navigation.routeId })
    const underway = withRouteMap(
      [{
        id: 'navigation-summary',
        type: 'navigation-summary',
        props: { routeId: task.navigation.routeId, destination: task.navigation.destination, eta: task.navigation.eta, distanceKm: 32, estimatedBatteryAtArrival: 27 },
        // The drive is where the side scenes belong: the driver is committed to a
        // destination and is now asking about what happens around it. They sit on
        // the brief that carries the ETA — the number both answers are relative to.
        actions: [ASK_WEATHER_ACTION_ID, ASK_SCHEDULE_ACTION_ID],
      }],
      activeSketch,
      task.navigation.destination,
    )
    components = underway.components
    layout = underway.layout
    actions = EN_ROUTE_QUERY_ACTIONS
  } else if (task.flight && task.flight.trusted === false) {
    components = [{ id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '航班号已收到', message: '航班信息正在确认中。' } }]
  } else if (task.flight) {
    density = 'compact'
    components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival ?? task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }]
  }
  const weather = toolResults['weather.get-current']
  const scheduleQuery = toolResults['calendar.query']
  const queryAnswerable = task.phase !== 'collecting-information' && task.phase !== 'cancelled' && task.phase !== 'completed'
  const departure = composeContext?.departureAnswer
    ? departurePlan(task, toolResults['navigation.plan-route']?.data)
    : undefined
  const queryCard = queryAnswerable
    ? departure
      ? departurePlanComponent(departure)
      : weather
        ? weatherCardComponent(task, weather.data)
        : scheduleQuery
          ? scheduleCardComponent(scheduleQuery.data.events, scheduleQuery.meta.provider === 'live' ? 'live' : 'fixture')
          : undefined
    : undefined
  if (queryCard) {
    const stripIndex = components.findIndex((component) => component.id === 'schedule-strip')
    const summaryIndex = components.findIndex((component) => component.id === 'navigation-summary')
    if (stripIndex >= 0) {
      // The brief already runs at its card budget when the strip is on it, and
      // the strip is the auxiliary band of the two. The query turn borrows its
      // slot; the reading is not persisted, so the strip returns next event.
      components = components.map((component, index) => index === stripIndex ? queryCard : component)
    } else if (summaryIndex >= 0 && layout?.type === 'split') {
      // Underway the map has its own column and the rail beside it holds exactly
      // one card — that is what makes it read as a panel floating over the map
      // rather than a second column. So the answer takes the rail instead of
      // appending beside the brief, and it brings the side-scene buttons with it:
      // the way to the other scene must not be what the driver loses by asking.
      //
      // The ETA is what the rail gives up for one turn. It is the number they can
      // already see the route for, they asked for something else, and the next
      // trip event brings the brief back unchanged.
      const answered: UISpec['components'][number] = {
        ...queryCard,
        ...(components[summaryIndex]!.actions ? { actions: components[summaryIndex]!.actions } : {}),
      }
      components = components.map((component, index) => index === summaryIndex ? answered : component)
      layout = {
        ...layout,
        slots: {
          ...layout.slots,
          secondary: layout.slots.secondary.map((id) => id === 'navigation-summary' ? answered.id : id),
        },
      }
    } else {
      components = [...components, queryCard]
      if (layout?.type === 'split') {
        layout = { ...layout, slots: { ...layout.slots, secondary: [...layout.slots.secondary, queryCard.id] } }
      }
    }
  }
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId,
    taskRevision: task.taskRevision, uiRevision: Math.max(task.uiRevision, task.taskRevision) + 1,
    phase: task.phase, title,
    presentation: { mode: 'replace', density, theme: 'dark', priority },
    layout: layout ?? { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } },
    components, actions,
    meta: {
      generatedBy: 'composer', sourceTaskRevision: task.taskRevision, requiresConfirm,
      generatedAt: task.updatedAt, traceId: `trace-${task.taskId}-${task.taskRevision}`,
    },
  })
}

/**
 * Give the route its own column: the map on the left, the cards that describe
 * the same trip on the right.
 *
 * The geometry used to ride inside `navigation-summary` as a thin band, which a
 * multi-card brief has no height to draw. A `route-map` component gets a slot of
 * its own instead, so the same fixture points read as a picture of the trip
 * rather than a rule between two lines of text. The cards keep their own
 * `routeSketch` off: one route, drawn once.
 *
 * Without usable geometry there is nothing to put in the left column, so the
 * cards stay exactly as they were and the caller falls back to a stack.
 */
function withRouteMap(
  cards: UISpec['components'],
  sketch: RouteSketch | undefined,
  destination: string,
): { components: UISpec['components']; layout?: UISpec['layout'] } {
  if (!sketch) return { components: cards }
  const routeMap: UISpec['components'][number] = {
    id: 'route-map',
    type: 'route-map',
    props: {
      destination,
      // Underway, the driver is reading the part of the trip they are on; before
      // departure, the whole thing. Neither is a camera setting — the renderer
      // decides what zoom or bearing that means.
      mode: sketch.progress !== undefined && sketch.progress > 0 ? 'follow' : 'overview',
      routeSketch: sketch,
    },
  }
  return {
    // First, so the density trim in `applyRequestPresentation` drops cards off
    // the end of the brief rather than the map out of its own column.
    components: [routeMap, ...cards],
    layout: { type: 'split', ratio: [1.75, 1], slots: { primary: [routeMap.id], secondary: cards.map((card) => card.id) } },
  }
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
  // The budget counts cards, not the map. It is a claim about how much reading one
  // column can carry, and a `route-map` is neither reading nor in that column — it
  // has a column of its own. Counting it spent a slot the cards needed and dropped
  // the last card off the brief, which at `minimal` took the action the driver was
  // being offered along with it.
  let remaining = maxComponents
  const components = ui.components.filter((component) => {
    if (component.type === 'route-map') return true
    if (remaining === 0) return false
    remaining -= 1
    return true
  }).map((component) => (
    component.type === 'charging-recommendation'
      && component.props.currentBatteryPercent !== context.vehicle.batteryPercent
      ? {
          ...component,
          // The card states two numbers about one battery: what it holds now and
          // what the round trip leaves. Replacing only the first one produced a
          // card that contradicted itself — a 90% battery still claimed it would
          // arrive with the canned 42%, i.e. a 48-point trip on a 64 km round
          // trip. When the composed reading already equals the live one the pair
          // came from this request (a provider computed it), so it is left alone;
          // a mismatch means the composer used a canned snapshot and both numbers
          // have to be re-derived from the live reading with the same estimator
          // `charging.recommend` itself uses.
          props: {
            ...component.props,
            currentBatteryPercent: context.vehicle.batteryPercent,
            estimatedFinalBatteryPercent: estimateFinalBatteryPercent(
              context.vehicle.batteryPercent, context.vehicle.remainingRangeKm, DEMO_LEG_KM, DEMO_LEG_KM,
            ),
          },
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
  const layout = reslot(ui.layout, componentsWithActions.map((component) => component.id))
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
 * Rebuild the layout's slots around the components that survived the density
 * trim, keeping the shape the composer chose.
 *
 * The schema requires slots to reference every component exactly once, so
 * dropping a component has to drop its slot entry too. What this must not do is
 * flatten the shape: a `split` says the composer put the map in one column and
 * the cards in the other, and a parked car re-reading the same brief should not
 * turn that into a single stack. A two-column layout with an empty column is a
 * worse frame than a stack, though, so a trim that empties one collapses to a
 * stack rather than leaving a blank half.
 */
function reslot(layout: UISpec['layout'], retainedIds: string[]): UISpec['layout'] {
  const stack = { type: 'stack' as const, gap: layout.type === 'stack' ? layout.gap : ('md' as const), slots: { main: retainedIds } }
  if (layout.type !== 'split' && layout.type !== 'focus') return stack
  const retained = new Set(retainedIds)
  const primary = layout.slots.primary.filter((id) => retained.has(id))
  const secondary = layout.slots.secondary.filter((id) => retained.has(id))
  if (primary.length === 0 || secondary.length === 0) return stack
  return { ...layout, slots: { primary, secondary } }
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

/** Every fixture timestamp carries +08:00, so computed instants render in that offset too. */
const FIXTURE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
/** Curbside meeting, luggage, and leaving the parking structure. */
const PICKUP_HANDOFF_MINUTES = 15
const MAX_CALENDAR_MILESTONES = 2

function fixtureIso(epochMs: number): string {
  return new Date(epochMs + FIXTURE_UTC_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/u, '+08:00')
}

function calendarMilestones(events: CalendarEvent[], projectedHomeMs: number) {
  return events.slice(0, MAX_CALENDAR_MILESTONES).map((event) => ({
    label: event.title,
    time: event.startAt,
    kind: 'calendar' as const,
    status: Date.parse(event.startAt) < projectedHomeMs ? 'at-risk' as const : 'upcoming' as const,
  }))
}

function preparingScheduleStrip(
  flight: NonNullable<AirportPickupTaskState['flight']>,
  route: { durationMinutes: number },
  charging: { recommended: boolean; etaImpactMinutes?: number },
  events: CalendarEvent[],
): UISpec['components'][number] | undefined {
  const landingMs = Date.parse(flight.estimatedArrival)
  if (Number.isNaN(landingMs)) return undefined
  const chargingMinutes = charging.recommended ? charging.etaImpactMinutes ?? 0 : 0
  const projectedHomeMs = landingMs + (PICKUP_HANDOFF_MINUTES + route.durationMinutes + chargingMinutes) * 60_000
  return {
    id: 'schedule-strip',
    type: 'schedule-strip',
    props: {
      milestones: [
        { label: `${flight.flightNumber} 落地`, time: flight.estimatedArrival, kind: 'task', status: 'next' },
        { label: '预计到家', time: fixtureIso(projectedHomeMs), kind: 'task', status: 'upcoming' },
        ...calendarMilestones(events, projectedHomeMs),
      ],
    },
  }
}

function returningScheduleStrip(
  homeEta: string,
  events: CalendarEvent[],
): UISpec['components'][number] | undefined {
  const homeMs = Date.parse(homeEta)
  if (Number.isNaN(homeMs)) return undefined
  return {
    id: 'schedule-strip',
    type: 'schedule-strip',
    props: {
      milestones: [
        { label: '到家', time: homeEta, kind: 'task', status: 'next' },
        ...calendarMilestones(events, homeMs),
      ],
    },
  }
}

export const flightStatusLabels: Record<FlightArrivalCandidate['status'], string> = {
  scheduled: '计划中',
  'in-air': '飞行中',
  landed: '已落地',
  delayed: '延误',
  cancelled: '已取消',
}

/**
 * The arrivals board as the pickup's opening question, together with the action
 * each row dispatches.
 *
 * A cancelled arrival is left off. Nobody can be picked up from it, and a row
 * that exists only to be refused spends the one glance the driver has. What is
 * left has to be an actual choice — fewer than two rows is an answer, not a
 * board, and more than the schema's ceiling is a list to scan rather than pick
 * from — so anything else returns nothing and the caller keeps asking for the
 * number.
 *
 * Each row's action is a plain `agent-message` carrying the flight number, so a
 * pick travels the same planner path as typing it. The board is a faster way to
 * say the number, never a second way to set the slot.
 */
/**
 * The rows a driver can actually pick, in the order the board presents them.
 * Shared with the gateway's ordinal resolution ("第三个") so a spoken index and
 * the rendered row can never disagree about which flight is third.
 */
export function pickableArrivals(board: FlightArrivalsOutput): FlightArrivalsOutput['arrivals'] {
  return board.arrivals
    .filter((arrival) => arrival.status !== 'cancelled')
    .slice(0, MAX_FLIGHT_CHOICES)
}

function flightChoicesComponent(board: FlightArrivalsOutput | undefined): {
  component: UISpec['components'][number]
  actions: UISpec['actions']
} | undefined {
  if (!board) return undefined
  const pickable = pickableArrivals(board)
  if (pickable.length < 2) return undefined
  const rows = pickable.map((arrival) => ({
    arrival,
    actionId: `pick-${arrival.flightNumber}`,
  }))
  return {
    component: {
      id: 'flight-choices',
      type: 'flight-choices',
      actions: rows.map((row) => row.actionId),
      props: {
        arrivalCityName: board.arrivalCityName,
        dateLabel: '今天',
        choices: rows.map(({ arrival, actionId }) => ({
          flightNumber: arrival.flightNumber,
          airlineName: arrival.airlineName,
          originName: arrival.originName,
          status: arrival.status,
          statusLabel: flightStatusLabels[arrival.status],
          arrivalTimeLabel: clockLabel(arrival.scheduledArrival),
          ...(arrival.estimatedArrival !== arrival.scheduledArrival
            ? {
                revisedTimeLabel: `预计 ${clockLabel(arrival.estimatedArrival)}`,
                revisedDirection: Date.parse(arrival.estimatedArrival) > Date.parse(arrival.scheduledArrival)
                  ? ('later' as const)
                  : ('earlier' as const),
              }
            : {}),
          terminal: arrival.terminal,
          actionId,
        })),
        freshness: 'fixture',
      },
    },
    // The card draws every row identically, so `style` only matters to a group
    // renderer that never sees these. The first row still reads as the primary
    // one there, which is what the ordering already says.
    actions: rows.map(({ arrival, actionId }, index) => ({
      id: actionId,
      label: `接 ${arrival.flightNumber}`,
      style: index === 0 ? 'primary' : 'secondary',
      event: { type: 'agent-message', text: `航班号 ${arrival.flightNumber}` },
    })),
  }
}

/** The clock time inside a fixture timestamp, or the timestamp if it has none. */
export function clockLabel(timestamp: string): string {
  return timestamp.match(/T(\d{2}:\d{2})/)?.[1] ?? timestamp
}

/**
 * How early the recommendation puts the car at the terminal.
 *
 * Arriving before the wheels touch down is the whole point of a pickup, and
 * parking costs nothing but time already set aside. Ten minutes is small enough
 * that a driver who wants to leave later can spend it knowingly, which is why
 * the card states the figure instead of folding it into the departure time.
 */
const AIRPORT_ARRIVAL_BUFFER_MINUTES = 10

export type DeparturePlan = {
  departAtLabel: string
  arrivalLabel: string
  driveMinutes: number
  bufferMinutes: number
  viaLabel?: string
}

/**
 * When to leave, worked backwards from the landing the trip is timed against.
 *
 * Deliberately no comparison against a clock. The fixture timeline and the wall
 * clock disagree by design, so "you should have left already" is a sentence this
 * demo cannot say truthfully — the card gives the driver the three numbers and
 * lets them make the call.
 *
 * Nothing to work backwards from means no answer: without a flight or a planned
 * route the caller says so rather than inventing a time.
 */
export function departurePlan(
  task: AirportPickupTaskState,
  route: { durationMinutes: number; summary?: string } | undefined,
): DeparturePlan | undefined {
  if (!task.flight || !route) return undefined
  const landingMs = Date.parse(task.flight.estimatedArrival)
  if (Number.isNaN(landingMs)) return undefined
  const driveMinutes = Math.round(route.durationMinutes)
  const departAtMs = landingMs - (driveMinutes + AIRPORT_ARRIVAL_BUFFER_MINUTES) * 60_000
  return {
    departAtLabel: clockLabel(fixtureIso(departAtMs)),
    arrivalLabel: `${task.flight.flightNumber} ${clockLabel(task.flight.estimatedArrival)} 落地`,
    driveMinutes,
    bufferMinutes: AIRPORT_ARRIVAL_BUFFER_MINUTES,
    ...(route.summary ? { viaLabel: route.summary } : {}),
  }
}

/** The departure answer as one card, shaped like the other query answers. */
export function departurePlanComponent(plan: DeparturePlan): UISpec['components'][number] {
  return { id: 'departure-plan', type: 'departure-plan', props: plan }
}

export const weatherConditionLabels: Record<WeatherOutput['condition'], string> = {
  sunny: '晴',
  cloudy: '多云',
  overcast: '阴',
  'light-rain': '小雨',
  'heavy-rain': '大雨',
  fog: '有雾',
}

/**
 * The on-demand weather answer as one card. Which moment it describes follows
 * the trip: an arrival still ahead pins the reading to it, while a landed or
 * cancelled flight — or a return trip already underway — reads as now. Rain
 * earns the one advisory line the pickup actually needs.
 */
export function weatherCardComponent(
  task: AirportPickupTaskState,
  data: WeatherOutput,
): UISpec['components'][number] {
  const arrivalAhead = !task.passengers.confirmedOnboard
    && task.flight !== undefined
    && task.flight.status !== 'landed'
    && task.flight.status !== 'cancelled'
  const arrivalClock = arrivalAhead ? task.flight!.estimatedArrival.match(/T(\d{2}:\d{2})/)?.[1] : undefined
  // The advisory tells the family where to wait, which stops being advice the
  // moment they are in the car.
  const raining = data.condition === 'light-rain' || data.condition === 'heavy-rain'
  const advising = raining && !task.passengers.confirmedOnboard
  return {
    id: 'weather-card',
    type: 'weather-card',
    props: {
      location: data.locationName,
      timeLabel: arrivalClock ? `${arrivalClock} 到达时` : '现在',
      temperatureC: data.temperatureC,
      condition: data.condition,
      conditionLabel: weatherConditionLabels[data.condition],
      ...(data.windLevel !== undefined ? { windLevel: data.windLevel } : {}),
      ...(data.precipitationChance !== undefined ? { precipitationChance: data.precipitationChance } : {}),
      ...(advising ? { advisory: '到达时段有雨，建议家人在到达层室内等候。' } : {}),
      freshness: 'fixture',
    },
  }
}

/** Rows the schedule answer shows before handing the tail to moreCount. */
const MAX_SCHEDULE_CARD_EVENTS = 4

/**
 * The on-demand schedule answer as one card: the day's remaining events in
 * start order, capped to a glance. An empty day still answers — a query with
 * no card is indistinguishable from a query that failed.
 */
export function scheduleCardComponent(
  events: CalendarEvent[],
  freshness: 'live' | 'cached' | 'fixture' = 'fixture',
): UISpec['components'][number] {
  const ordered = [...events].sort((left, right) => left.startAt.localeCompare(right.startAt))
  const shown = ordered.slice(0, MAX_SCHEDULE_CARD_EVENTS)
  const moreCount = ordered.length - shown.length
  return {
    id: 'schedule-card',
    type: 'schedule-card',
    props: {
      dateLabel: '今天',
      events: shown.map((event) => ({
        eventId: event.eventId,
        title: event.title,
        startAt: event.startAt,
        ...(event.endAt ? { endAt: event.endAt } : {}),
        ...(event.location ? { location: event.location } : {}),
      })),
      ...(moreCount > 0 ? { moreCount } : {}),
      ...(shown.length === 0 ? { emptyCopy: '今天没有更多安排了' } : {}),
      freshness,
    },
  }
}
