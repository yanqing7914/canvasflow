import { uiSpecSchema, type AirportPickupTaskState, type CalendarEvent, type FlightArrivalCandidate, type FlightArrivalsOutput, type RouteSketch, type UISpec, type WeatherOutput } from '@canvasflow/schema'
import {
  chargingStation,
  chargingStationsForDensity,
  estimateFinalBatteryPercent,
  memberPreferences,
  meetingPointKey,
  pickupAirportName,
  pickupDestinationForAirport,
  recommendedMeetingPoints,
  resolveAuthorizedLandingContact,
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
 * `queryAnswer` is the opposite kind of thing — a flag naming which side question
 * this turn asked — and it lives here for the same reason: both answers change
 * nothing about the task, so the composer cannot tell from the snapshot alone
 * which turn asked. One field rather than a flag each, because the two answers
 * compete for the same slot and only one of them can hold it.
 */
export type ComposeContext = {
  cabinRevertActionToken?: string
  queryAnswer?: 'departure' | 'calendar'
}

/** The pre-departure screen's own question, asked as ordinary user input. */
export const ASK_DEPARTURE_TIME_ACTION_ID = 'ask-departure-time'

/** Airport choices replay ordinary user input so Planner remains the authority. */
export const SELECT_PUDONG_AIRPORT_ACTION_ID = 'select-pudong-airport'
export const SELECT_HONGQIAO_AIRPORT_ACTION_ID = 'select-hongqiao-airport'
export const CONFIRM_PASSENGERS_ONBOARD_ACTION_ID = 'confirm-passengers-onboard'

/**
 * The two answers to the departure recommendation, both on the card that makes
 * it. Neither is 出发 — that is `start-navigation`, and it lives in the global
 * bar because leaving is a task-wide commitment rather than a reply to a card.
 *
 * 稍后提醒 records the time and nothing else: no provider, no message, no
 * scheduler. 查看日程 spends the calendar read `prepareTrip` already made, so the
 * driver can check the recommendation against 豆豆's bedtime without paying for a
 * second read — which is exactly why it is not `ask-schedule`, whose whole job is
 * to go and ask.
 */
export const REMIND_LATER_ACTION_ID = 'remind-later'
export const VIEW_CALENDAR_ACTION_ID = 'view-calendar'

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

export const SEND_UMBRELLA_REMINDER_ACTION_ID = 'send-umbrella-reminder'

/**
 * 暂不处理, named for the family rather than for the weather.
 *
 * One intent and one gateway path answer every advisory, but the id stays typed:
 * the driver dismisses *this* prompt, and a shared `dismiss-advisory` id would
 * make an idempotency key ambiguous the moment a second advisory can be on screen
 * at the same time. `dismiss-advisory-<kind>` keeps that distinction without
 * needing a mechanism to carry the kind.
 */
export const DISMISS_ADVISORY_WEATHER_ACTION_ID = 'dismiss-advisory-weather'

/**
 * The calendar conflict's own answers, `dismiss-advisory-<kind>` like the
 * weather's. 保持当前计划 is a dismissal that owns its meaning — the driver read
 * the lateness and accepted it — and 查看安排 spends the calendar read the trip
 * already holds, exactly as `view-calendar` does on the departure card.
 */
export const DISMISS_ADVISORY_CALENDAR_ACTION_ID = 'dismiss-advisory-calendar'

const CALENDAR_ADVISORY_ACTIONS: UISpec['actions'] = [
  { id: VIEW_CALENDAR_ACTION_ID, label: '查看安排', style: 'secondary', event: { type: 'agent-message', text: '查看日程' } },
  { id: DISMISS_ADVISORY_CALENDAR_ACTION_ID, label: '保持当前计划', style: 'secondary', event: { type: 'agent-message', text: '保持当前计划' } },
]

/**
 * The conflict as one card: which event, how late, and the two answers. The
 * facts were pinned when the advisory was raised, so the card keeps saying
 * what the driver first read even as later updates shift the projection.
 */
function calendarAdvisoryCard(
  conflict: NonNullable<AirportPickupTaskState['calendarAdvisory']>,
): UISpec['components'][number] {
  return {
    id: 'calendar-advisory',
    type: 'alert',
    props: {
      level: 'warning',
      title: `${clockLabel(conflict.eventStartAt)}有「${conflict.eventTitle}」`,
      message: `按当前接人计划，预计迟到约 ${conflict.lateByMinutes} 分钟。`,
    },
    actions: [VIEW_CALENDAR_ACTION_ID, DISMISS_ADVISORY_CALENDAR_ACTION_ID],
  }
}

/**
 * 刷新航班, bound the same way the rows are.
 *
 * An `agent-message` like every other choice on this card: the board is a faster
 * way of saying something, so the button says it. Nothing about the refresh needs
 * a token the rows do not need — the new set's identity is recorded on the task
 * when the read lands, and the revision bump that comes with it is what refuses a
 * rank spoken against the old list.
 */
export const REFRESH_FLIGHT_OPTIONS_ACTION_ID = 'refresh-flight-options'

const phaseLabels: Record<AirportPickupTaskState['phase'], string> = {
  'collecting-airport': '确认机场',
  'choosing-flight': '选择航班',
  'confirming-outbound': '确认出发',
  'outbound-driving': '去程导航',
  'passengers-onboard': '乘客已上车',
  'confirming-return': '确认返程',
  'return-driving': '返程导航',
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
  // Which airport this trip is about, asked once and answered from the trip
  // itself. The board offers 虹桥 and 浦东, so a name written into the copy would
  // contradict the route on the very next screen.
  const airportName = pickupAirportName(task.flight?.arrivalAirport, task.navigation?.destination)
  let components: UISpec['components'] = [overviewComponent(task, airportName), progress]
  let layout: UISpec['layout'] | undefined
  let title = task.passengers.names.length > 0
    ? `去${airportName}接${task.passengers.names.join('和')}`
    : '机场接人任务'
  let density: UISpec['presentation']['density'] = 'full'
  let priority: UISpec['presentation']['priority'] = 'normal'
  let actions: UISpec['actions'] = []
  let requiresConfirm = false

  if (task.phase === 'collecting-airport') {
    components = [{
      id: 'airport-required',
      type: 'status-banner',
      props: { level: 'info', title: '你要去哪个机场？', message: '例如虹桥机场或浦东机场。' },
      actions: [SELECT_PUDONG_AIRPORT_ACTION_ID, SELECT_HONGQIAO_AIRPORT_ACTION_ID],
    }]
    actions = [
      { id: SELECT_PUDONG_AIRPORT_ACTION_ID, label: '浦东机场', style: 'primary', event: { type: 'agent-message', text: '浦东机场' } },
      { id: SELECT_HONGQIAO_AIRPORT_ACTION_ID, label: '虹桥机场', style: 'secondary', event: { type: 'agent-message', text: '虹桥机场' } },
    ]
  } else if (task.phase === 'choosing-flight') {
    const board = flightChoicesComponent(toolResults['flight.list-arrivals']?.data)
    components = board ? [board.component] : [{ id: 'flight-loading', type: 'status-banner', props: { level: 'info', title: '正在查询最近航班' } }]
    actions = board?.actions ?? []
  } else if ((task.phase === 'confirming-outbound' || task.phase === 'confirming-return') && task.navigation && task.navigationSimulation) {
    const outbound = task.phase === 'confirming-outbound'
    const route = toolResults['navigation.plan-route']?.data
    const componentId = outbound ? 'outbound-confirmation' : 'return-confirmation'
    const actionId = outbound ? 'start-outbound' : 'start-return'
    title = outbound ? '现在出发' : '确认返程'
    components = [{
      id: componentId, type: 'route-confirmation', actions: [actionId], props: {
        leg: outbound ? 'outbound' : 'return', destination: task.navigation.destination,
        ...(outbound && task.flight ? { flightNumber: task.flight.flightNumber, flightEstimatedArrival: task.flight.estimatedArrival } : {}),
        durationMinutes: route?.durationMinutes ?? (outbound ? 20 : 40), arrivalTime: task.navigation.eta,
        distanceKm: task.navigationSimulation.distanceKm,
        currentBatteryPercent: task.navigationSimulation.initialBatteryPercent,
        estimatedBatteryAtArrival: task.navigationSimulation.estimatedBatteryAtArrival,
        ...(route ? { routeSketch: routeSketchFor(task, route) } : {}), simulated: true,
      },
    }]
    actions = [{ id: actionId, label: outbound ? '现在出发' : '开始返程', style: 'primary', event: { type: 'tool-request', actionToken: actionId } }]
    requiresConfirm = true
  } else if (task.phase === 'passengers-onboard') {
    title = '乘客已上车'
    components = [{ id: 'passenger-onboard', type: 'passenger-status', props: { label: '乘客已上车', status: 'confirmed-onboard' } }]
  } else if (task.phase === 'outbound-driving' || task.phase === 'return-driving') {
    density = 'compact'
    components = [{ id: 'navigation-summary', type: 'navigation-summary', props: {
      routeId: task.navigation?.routeId ?? task.navigationSimulation?.routeId ?? 'simulation-route',
      destination: task.navigation?.destination ?? (task.phase === 'return-driving' ? '家' : task.pickupAirport?.label ?? '机场'),
      eta: task.navigation?.eta ?? task.updatedAt, distanceKm: task.navigationSimulation?.distanceKm ?? 0,
      estimatedBatteryAtArrival: task.navigationSimulation?.estimatedBatteryAtArrival ?? 0,
    } }]
  } else if (task.phase === 'collecting-information') {
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
    //
    // The drive's own label comes from the trip when it has one. A flight whose
    // airport is known but whose route has not been recorded on the task yet
    // still names the right place; only a flight number parsed locally, which
    // genuinely does not know its airport, falls back to the demo's main one.
    const plannedDestination = task.navigation?.destination
      ?? (task.flight.arrivalAirport
        ? pickupDestinationForAirport(task.flight.arrivalAirport).name
        : `${airportName} T2`)
    components = [
      { id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } },
      { id: 'navigation-plan', type: 'navigation-summary', props: { routeId: route.routeId, destination: plannedDestination, eta: task.navigation?.eta ?? route.arrivalTime, distanceKm: route.distanceKm, estimatedBatteryAtArrival: route.estimatedBatteryAtArrival, ...(plannedSketch ? { routeSketch: plannedSketch } : {}) } },
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
    const awaitingConfirmation = task.pendingConfirmation?.action === 'send-message'
    title = awaitingConfirmation ? '确认发送提醒' : '落地通知'
    density = 'minimal'
    priority = 'high'
    components = [{
      id: 'message-preview',
      type: 'message-preview',
      props: {
        contactLabel: task.passengers.names[0] ?? '乘客',
        // The exact provider-prepared payload when one is armed; the canned
        // landing line otherwise (the auto-notify path never sets pendingText).
        textPreview: task.message.pendingText ?? '我已到达机场，正在接你们。',
        status: 'scheduled',
        cancellable: !awaitingConfirmation,
        scheduledAt: task.message.scheduledAt,
      },
      ...(awaitingConfirmation ? { actions: ['confirm-send-message', 'reject-send-message'] } : {}),
    }]
    actions = awaitingConfirmation
      ? [
          { id: 'confirm-send-message', label: '确认发送', style: 'primary', event: { type: 'confirmation', confirmationId: task.pendingConfirmation!.confirmationId, decision: 'accept' } },
          { id: 'reject-send-message', label: '取消发送', style: 'secondary', event: { type: 'confirmation', confirmationId: task.pendingConfirmation!.confirmationId, decision: 'reject' } },
        ]
      : []
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
    // Both halves of the key are required. "T2" alone names a door at 虹桥 and a
    // different door an hour east at 浦东, so a terminal-only lookup would send
    // the family to whichever one the table happened to list first. When the
    // airport is not known — the locally parsed flight number never knows it —
    // the card omits the meeting point rather than naming a plausible wrong one.
    const meetingPoint = task.flight?.arrivalAirport
      ? recommendedMeetingPoints[meetingPointKey(task.flight.arrivalAirport, task.flight.terminal)]
      : undefined
    density = 'compact'
    components = [{
      id: 'passenger-status',
      type: 'passenger-status',
      props: {
        label: waiting ? '已停稳，等待家人' : '接近接机点',
        status: waiting ? 'waiting' : 'landed',
        ...(meetingPoint ? { meetingPoint: meetingPoint.name } : {}),
      },
      ...(waiting ? { actions: [CONFIRM_PASSENGERS_ONBOARD_ACTION_ID] } : {}),
    }]
    if (waiting) {
      actions = [{
        id: CONFIRM_PASSENGERS_ONBOARD_ACTION_ID,
        label: '乘客已上车',
        style: 'primary',
        event: { type: 'agent-message', text: '家人上车' },
      }]
    }
  } else if (task.flight && (task.flight.status === 'cancelled' || task.flight.status === 'delayed')) {
    // Exception flight states outrank active navigation and pending charging.
    density = 'compact'
    components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival ?? task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }]
    // A delay is how the calendar conflict usually arrives, so its card rides
    // the same screen as the delay that caused it: the flight brief says what
    // changed, the conflict says what it costs, and the two answers sit below.
    if (task.calendarAdvisory?.status === 'active' && task.flight.status === 'delayed') {
      components = [...components, calendarAdvisoryCard(task.calendarAdvisory)]
      actions = CALENDAR_ADVISORY_ACTIONS
    }
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
    // The proactive advisory owns the rail while it is active: the one thing
    // the driver needs from the screen is the rain and its two answers. Its
    // weather reading rides the persisted toolResults, so the card survives
    // every recompose until the driver answers it.
    const advisoryWeather = task.weatherAdvisory?.status === 'active'
      ? toolResults['weather.advisory']
      : undefined
    const advisoryContactAvailable = task.weatherAdvisory?.status === 'active'
      && resolveAuthorizedLandingContact(task.passengers.memberIds, resolvedPreferences) !== undefined
    if (advisoryWeather && task.weatherAdvisory?.status === 'active') {
      const advisoryCard = {
        ...weatherCardComponent(task, advisoryWeather.data),
        // Its own id: a transient weather QUERY during an active advisory would
        // otherwise mint a second 'weather-card' and break id uniqueness.
        id: 'weather-advisory',
        actions: [
          ...(advisoryContactAvailable ? [SEND_UMBRELLA_REMINDER_ACTION_ID] : []),
          DISMISS_ADVISORY_WEATHER_ACTION_ID,
        ],
      }
      const underway = withRouteMap([advisoryCard], activeSketch, task.navigation.destination)
      components = underway.components
      layout = underway.layout
      actions = [
        ...(advisoryContactAvailable
          ? [{ id: SEND_UMBRELLA_REMINDER_ACTION_ID, label: '提醒乘客带伞', style: 'primary' as const, event: { type: 'agent-message' as const, text: '提醒乘客带伞' } }]
          : []),
        { id: DISMISS_ADVISORY_WEATHER_ACTION_ID, label: '暂不处理', style: 'secondary' as const, event: { type: 'agent-message' as const, text: '暂不处理' } },
      ]
    } else if (task.calendarAdvisory?.status === 'active') {
      // The calendar conflict takes the rail the same way the rain does, and
      // for the same reason: one condition, its consequence in minutes, and
      // its answers are the only things the drive needs the screen to say.
      // The weather branch above wins when both are active — rain has a send
      // behind it where this card only asks to be read.
      const underway = withRouteMap([calendarAdvisoryCard(task.calendarAdvisory)], activeSketch, task.navigation.destination)
      components = underway.components
      layout = underway.layout
      actions = CALENDAR_ADVISORY_ACTIONS
    } else {
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
    }
  } else if (task.flight && task.flight.trusted === false) {
    components = [{ id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '航班号已收到', message: '航班信息正在确认中。' } }]
  } else if (task.flight) {
    density = 'compact'
    components = [{ id: 'flight-status', type: 'flight-status', props: { flightNumber: task.flight.flightNumber, status: task.flight.status, scheduledArrival: task.flight.scheduledArrival ?? task.flight.estimatedArrival, estimatedArrival: task.flight.estimatedArrival, terminal: task.flight.terminal, baggageClaim: task.flight.baggageClaim, freshness: 'fixture' } }]
  }
  const weather = toolResults['weather.get-current']
  const scheduleQuery = toolResults['calendar.query']
  const queryAnswerable = task.phase !== 'collecting-information' && task.phase !== 'cancelled' && task.phase !== 'completed'
  const departure = composeContext?.queryAnswer === 'departure'
    ? departurePlan(task, toolResults['navigation.plan-route']?.data)
    : undefined
  // 查看日程 draws the same card the schedule query draws, off the read the trip
  // already has. Same card on purpose: the driver asked one question — what is on
  // today — and a second layout for it would only advertise which tool answered.
  const upcoming = composeContext?.queryAnswer === 'calendar'
    ? toolResults['calendar.list-upcoming']
    : undefined
  // What the departure answer can offer, which is not the same as what it would
  // like to. A reminder already standing has nothing left to set, and 查看日程
  // cannot be offered against a calendar nobody read — an inert button is worse
  // than an absent one, so both are conditions rather than disabled states.
  const departureActions: UISpec['actions'] = departure
    ? [
        ...(task.departureReminder
          ? []
          : [{ id: REMIND_LATER_ACTION_ID, label: '稍后提醒', style: 'secondary' as const, event: { type: 'agent-message' as const, text: '稍后提醒我' } }]),
        ...((toolResults['calendar.list-upcoming']?.data.events.length ?? 0) > 0
          ? [{ id: VIEW_CALENDAR_ACTION_ID, label: '查看日程', style: 'secondary' as const, event: { type: 'agent-message' as const, text: '查看日程' } }]
          : []),
      ]
    : []
  // The schedule answer marks what the return would miss, off the same reads
  // the strip plots. Both card sites share it so a query during preparation
  // and one underway agree with the strip's at-risk milestones.
  const scheduleProjectedHomeMs = task.flight && toolResults['navigation.plan-route']
    ? projectedHomeArrivalMs(
        task.flight,
        toolResults['navigation.plan-route'].data,
        toolResults['charging.recommend']?.data ?? { recommended: false },
      )
    : undefined
  const queryCard = queryAnswerable
    ? departure
      ? departurePlanComponent(departure, departureActions.map((action) => action.id))
      : upcoming
        ? scheduleCardComponent(upcoming.data.events, upcoming.meta.provider === 'live' ? 'live' : 'fixture', scheduleProjectedHomeMs)
        : weather
          ? weatherCardComponent(task, weather.data)
          : scheduleQuery
            ? scheduleCardComponent(scheduleQuery.data.events, scheduleQuery.meta.provider === 'live' ? 'live' : 'fixture', scheduleProjectedHomeMs)
            : undefined
    : undefined
  // Declared on the card and defined in the spec, the way every other card's own
  // controls are. The brief's own 什么时候出发 stays where it was: asking again is
  // how the driver sees the reminder they just set stated back.
  if (queryCard) actions = [...actions, ...departureActions]
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
      // appending beside the brief.
      //
      // The ETA is what the rail gives up for one turn. It is the number they can
      // already see the route for, they asked for something else, and the next
      // trip event brings the brief back unchanged.
      //
      // What the brief hands over with the rail is its side-scene buttons — the
      // way to the other scene must not be what the driver loses by asking. But
      // only to an answer that has nothing of its own to say: the weather and
      // schedule cards are readings and no more, so the buttons are the only
      // controls in the rail and inheriting them is pure gain. The departure
      // answer carries 稍后提醒 and 查看日程, and those are the controls the
      // question was asked to reach — overwriting them with the brief's would
      // leave a card whose own actions are defined in the spec and referenced by
      // nothing, which is the same as not having built them.
      const answered: UISpec['components'][number] = {
        ...queryCard,
        ...(queryCard.actions?.length || !components[summaryIndex]!.actions
          ? {}
          : { actions: components[summaryIndex]!.actions }),
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
  // The pre-navigation airport choice and outbound confirmation stay in the
  // persistent task surface. Later navigation handoffs still use focused
  // windows because the map workspace owns the main screen by then.
  const cockpitWindow = task.phase === 'passengers-onboard'
    ? [{ id: `passenger-onboard-${task.uiRevision + 1}`, kind: 'passenger-onboard' as const, title: '乘客已上车', componentIds: ['passenger-onboard'], size: 'compact' as const, controls: { closable: true, minimizable: true, maximizable: true } }]
    : task.phase === 'confirming-return'
      ? [{ id: `return-confirmation-${task.uiRevision + 1}`, kind: 'return-confirmation' as const, title: '确认返程', componentIds: ['return-confirmation'], actionIds: ['start-return'], size: 'medium' as const, controls: { closable: true, minimizable: true, maximizable: true } }]
      : undefined
  return uiSpecSchema.parse({
    version: '1.0', taskId: task.taskId, surfaceId: task.surfaceId,
    taskRevision: task.taskRevision, uiRevision: Math.max(task.uiRevision, task.taskRevision) + 1,
    phase: task.phase, title,
    presentation: { mode: 'replace', density, theme: 'dark', priority },
    layout: layout ?? { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } },
    components, actions, ...(cockpitWindow ? { windows: cockpitWindow } : {}),
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

function overviewComponent(task: AirportPickupTaskState, airportName: string): UISpec['components'][number] {
  return {
    id: 'pickup-overview',
    type: 'pickup-overview',
    props: {
      passengers: task.passengers.names,
      flightNumber: task.flight?.flightNumber ?? '待补充',
      airport: airportName,
      terminal: task.flight?.terminal ?? 'T2',
      phaseLabel: phaseLabels[task.phase],
    },
  }
}

function progressComponent(task: AirportPickupTaskState): UISpec['components'][number] {
  const phases: AirportPickupTaskState['phase'][] = [
    ...(task.phase === 'collecting-airport' || task.phase === 'choosing-flight' || task.phase === 'confirming-outbound'
      || task.phase === 'outbound-driving' || task.phase === 'passengers-onboard'
      || task.phase === 'confirming-return' || task.phase === 'return-driving'
      ? ['collecting-airport', 'choosing-flight', 'confirming-outbound', 'outbound-driving', 'waiting-for-passengers', 'passengers-onboard', 'confirming-return', 'return-driving', 'completed'] as const
      : ['collecting-information', 'preparing', 'driving-to-airport', 'approaching-airport', 'waiting-for-passengers', 'returning-home', 'completed'] as const),
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

/**
 * When the pickup is projected to get the driver home, in epoch ms — landing
 * plus the curbside handoff, the drive back, and any accepted charging detour.
 * The same sum the schedule strip plots, exported so the gateway's conflict
 * check and the strip cannot disagree about what "late" means.
 */
export function projectedHomeArrivalMs(
  flight: { estimatedArrival: string },
  route: { durationMinutes: number },
  charging: { recommended: boolean; etaImpactMinutes?: number },
): number | undefined {
  const landingMs = Date.parse(flight.estimatedArrival)
  if (Number.isNaN(landingMs)) return undefined
  const chargingMinutes = charging.recommended ? charging.etaImpactMinutes ?? 0 : 0
  return landingMs + (PICKUP_HANDOFF_MINUTES + route.durationMinutes + chargingMinutes) * 60_000
}

/**
 * The first calendar event the projected return would miss, with the lateness
 * in whole minutes. Undefined when nothing conflicts — a zero-minute conflict
 * is not one. First in start order on purpose: the earliest missed event is
 * the one the driver can still do something about.
 */
export function firstCalendarConflict(
  events: CalendarEvent[],
  projectedHomeMs: number,
): { event: CalendarEvent; lateByMinutes: number } | undefined {
  const missed = [...events]
    .sort((left, right) => left.startAt.localeCompare(right.startAt))
    .find((event) => Date.parse(event.startAt) < projectedHomeMs)
  if (!missed) return undefined
  const lateByMinutes = Math.ceil((projectedHomeMs - Date.parse(missed.startAt)) / 60_000)
  if (lateByMinutes <= 0) return undefined
  return { event: missed, lateByMinutes }
}

function preparingScheduleStrip(
  flight: NonNullable<AirportPickupTaskState['flight']>,
  route: { durationMinutes: number },
  charging: { recommended: boolean; etaImpactMinutes?: number },
  events: CalendarEvent[],
): UISpec['components'][number] | undefined {
  const projectedHomeMs = projectedHomeArrivalMs(flight, route, charging)
  if (projectedHomeMs === undefined) return undefined
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

/**
 * The rows the board actually renders, or undefined when it does not render at
 * all: fewer than two pickable rows is not a choice, so the composer falls
 * back to asking for the number. The gateway's ordinal resolution ("第三个")
 * uses this same function, so a spoken rank can never select from a board the
 * driver was never shown.
 */
export function renderedArrivalRows(board: FlightArrivalsOutput | undefined): FlightArrivalsOutput['arrivals'] | undefined {
  if (!board) return undefined
  const rows = pickableArrivals(board)
  return rows.length >= 2 ? rows : undefined
}

function flightChoicesComponent(board: FlightArrivalsOutput | undefined): {
  component: UISpec['components'][number]
  actions: UISpec['actions']
} | undefined {
  const pickable = board ? renderedArrivalRows(board) : undefined
  if (!board || !pickable) return undefined
  const rows = pickable.map((arrival) => ({
    arrival,
    actionId: board.queryId ? `pick-${board.queryId}-${arrival.flightNumber}` : `pick-${arrival.flightNumber}`,
  }))
  const cockpitBoard = board.queryId !== undefined
  const componentId = board.queryId ? `flight-choices-${board.queryId}` : 'flight-choices'
  return {
    component: {
      id: componentId,
      type: 'flight-choices',
      actions: [...rows.map((row) => row.actionId), ...(cockpitBoard ? [] : [REFRESH_FLIGHT_OPTIONS_ACTION_ID])],
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
          airportName: arrival.arrivalAirportName,
          actionId,
        })),
        freshness: 'fixture',
        ...(cockpitBoard ? {} : { refreshActionId: REFRESH_FLIGHT_OPTIONS_ACTION_ID }),
      },
    },
    // The card draws every row identically, so `style` only matters to a group
    // renderer that never sees these. The first row still reads as the primary
    // one there, which is what the ordering already says.
    actions: [
      ...rows.map(({ arrival, actionId }, index) => ({
        id: actionId,
        label: `接 ${arrival.flightNumber}`,
        style: index === 0 ? ('primary' as const) : ('secondary' as const),
        event: cockpitBoard
          ? { type: 'tool-request' as const, actionToken: actionId }
          : { type: 'agent-message' as const, text: `航班号 ${arrival.flightNumber}` },
      })),
      ...(cockpitBoard ? [] : [{
        id: REFRESH_FLIGHT_OPTIONS_ACTION_ID,
        label: '刷新航班',
        style: 'secondary' as const,
        event: { type: 'agent-message' as const, text: '刷新航班' },
      }]),
    ],
  }
}

/** Build a standalone cockpit arrivals window from a deterministic query result. */
export function composeCockpitFlightChoices(board: FlightArrivalsOutput): {
  component: UISpec['components'][number]
  actions: UISpec['actions']
} | undefined {
  return flightChoicesComponent(board)
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
  reminderAtLabel?: string
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
  const departAt = departureAtIso(task, route)
  if (!departAt) return undefined
  return {
    departAtLabel: clockLabel(departAt),
    arrivalLabel: `${task.flight.flightNumber} ${clockLabel(task.flight.estimatedArrival)} 落地`,
    driveMinutes: Math.round(route.durationMinutes),
    bufferMinutes: AIRPORT_ARRIVAL_BUFFER_MINUTES,
    ...(route.summary ? { viaLabel: route.summary } : {}),
    // The standing reminder is read off the task rather than recomputed, so a
    // reminder set against an earlier route keeps saying the time the driver was
    // actually told — the card would otherwise silently revise a promise.
    ...(task.departureReminder ? { reminderAtLabel: clockLabel(task.departureReminder.remindAt) } : {}),
  }
}

/**
 * The recommended departure as an instant, which is what a reminder has to store.
 *
 * Shares the arithmetic with `departurePlan` rather than repeating it, so a
 * reminder can only ever name the moment the card showed a clock label for. The
 * card keeps the label because a label is what a driver reads; the reminder keeps
 * the instant because a label is not something you can compare or reschedule.
 */
export function departureAtIso(
  task: AirportPickupTaskState,
  route: { durationMinutes: number } | undefined,
): string | undefined {
  if (!task.flight || !route) return undefined
  const landingMs = Date.parse(task.flight.estimatedArrival)
  if (Number.isNaN(landingMs)) return undefined
  const driveMinutes = Math.round(route.durationMinutes)
  return fixtureIso(landingMs - (driveMinutes + AIRPORT_ARRIVAL_BUFFER_MINUTES) * 60_000)
}

/**
 * The departure answer as one card, shaped like the other query answers.
 *
 * The card declares its controls; the caller defines them. Same split as every
 * other card here — the composer decides what is answerable, not what the ids do.
 */
export function departurePlanComponent(plan: DeparturePlan, actionIds: string[] = []): UISpec['components'][number] {
  return {
    id: 'departure-plan',
    type: 'departure-plan',
    props: plan,
    ...(actionIds.length > 0 ? { actions: actionIds } : {}),
  }
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
  options: { timeLabel?: string } = {},
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
      timeLabel: options.timeLabel ?? (arrivalClock ? `${arrivalClock} 到达时` : '现在'),
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
 * no card is indistinguishable from a query that failed. When the caller can
 * project the return (`projectedHomeMs`), events the pickup would miss carry
 * `atRisk` — the same judgement the strip renders, from the same number.
 */
export function scheduleCardComponent(
  events: CalendarEvent[],
  freshness: 'live' | 'cached' | 'fixture' = 'fixture',
  projectedHomeMs?: number,
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
        ...(projectedHomeMs !== undefined && Date.parse(event.startAt) < projectedHomeMs
          ? { atRisk: true }
          : {}),
        ...(event.status ? { status: event.status } : {}),
      })),
      ...(moreCount > 0 ? { moreCount } : {}),
      ...(shown.length === 0 ? { emptyCopy: '今天没有更多安排了' } : {}),
      freshness,
    },
  }
}
