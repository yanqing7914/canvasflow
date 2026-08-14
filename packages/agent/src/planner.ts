import type { AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'
import { normalizeFlightNumber } from './flight-number'
import { parsePassengers, stripPassengerPhonePhrases } from './passengers'

export type PlannerIntent =
  | 'create-airport-pickup'
  | 'provide-airport'
  | 'query-flight-options'
  | 'provide-flight-number'
  | 'pick-flight-choice'
  | 'refresh-flight-options'
  | 'start-navigation'
  | 'check-flight-detail'
  | 'check-vehicle-status'
  | 'speed-up'
  | 'speed-down'
  | 'hide-navigation-info'
  | 'show-navigation-info'
  | 'request-return'
  | 'start-return'
  | 'pause-unsupported'
  | 'plan-charging'
  | 'check-charging'
  | 'confirm-passengers-onboard'
  | 'apply-cabin-preferences'
  | 'check-weather'
  | 'check-schedule'
  | 'check-departure-time'
  | 'remind-later'
  | 'view-calendar'
  | 'send-weather-reminder'
  | 'dismiss-advisory'
  | 'cancel-task'
  | 'unknown'

export type PlannerSlot = 'airport' | 'passengers' | 'flightNumber'

export type PlannerSlotUpdates = {
  airport?: { label: string; code?: 'SHA' | 'PVG' }
  passengers?: AirportPickupTaskState['passengers']
  flightNumber?: string
  navigation?: { requested: true }
  charging?: Pick<AirportPickupTaskState['charging'], 'recommended' | 'accepted' | 'status'>
  passengersOnboard?: boolean
  cancelled?: boolean
  /** 1-based row on the arrivals board; the gateway resolves it to a flight. */
  flightChoiceOrdinal?: number
}

export type Plan = {
  intent: PlannerIntent
  confidence: number
  slotUpdates: PlannerSlotUpdates
  missingSlots: PlannerSlot[]
  proposedEvents: AirportPickupEvent[]
  assistantText: string
}

export type PlannerInput = {
  text: string
  state?: AirportPickupTaskState
  eventId?: string
  timestamp?: string
  routeId?: string
}

const fallbackTimestamp = '1970-01-01T00:00:00.000Z'

/** A pure, deterministic parser. Applying events and executing tools are caller responsibilities. */
export class Planner {
  plan(input: string | PlannerInput, state?: AirportPickupTaskState): Plan {
    return planAirportPickup(typeof input === 'string' ? { text: input, state } : input)
  }
}

export function planAirportPickup(input: PlannerInput): Plan {
  const text = input.text.trim()
  const compactText = text.replace(/\s+/g, '')
  const actionableText = stripPassengerPhonePhrases(compactText)
  const state = input.state
  const flightNumber = normalizeFlightNumber(text)
  const passengers = parsePassengers(text)
  const eventBase = {
    eventId: input.eventId ?? `planner-${stableHash(compactText || 'empty')}`,
    timestamp: input.timestamp ?? state?.updatedAt ?? fallbackTimestamp,
  }

  if (isPauseRequest(compactText)) return informationPlan('pause-unsupported', '当前版本暂不支持暂停。')
  if (isFlightDetailQuery(compactText)) return informationPlan('check-flight-detail', '好的，我打开当前航班详情。')
  if (isVehicleStatusQuery(compactText)) return informationPlan('check-vehicle-status', '好的，我打开车辆状态。')
  if (isSpeedUpRequest(compactText)) return informationPlan('speed-up', '好的，尝试调快一档。')
  if (isSpeedDownRequest(compactText)) return informationPlan('speed-down', '好的，尝试调慢一档。')
  if (isHideNavigationInfo(compactText)) return informationPlan('hide-navigation-info', '已隐藏完整导航信息。')
  if (isShowNavigationInfo(compactText)) return informationPlan('show-navigation-info', '已显示完整导航信息。')
  if (isStartReturnRequest(compactText)) return informationPlan('start-return', '好的，准备开始返程。')
  if (isReturnRequest(compactText)) return informationPlan('request-return', '好的，先确认返程路线。')

  const airport = parsePickupAirport(text, state)
  if (airport && state?.phase === 'collecting-airport') {
    return {
      intent: 'provide-airport', confidence: 0.99, slotUpdates: { airport }, missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'pickup.airport-selected', airport }],
      assistantText: `好的，查询${airport.label}最近到达航班。`,
    }
  }

  if (isTaskCancellation(compactText)) {
    return {
      intent: 'cancel-task',
      confidence: 0.99,
      slotUpdates: { cancelled: true },
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.cancelled-task', reason: text }],
      assistantText: '好的，已准备取消本次接机任务。',
    }
  }

  if (/接到人了|已经接到(?:人|她们|他们)|接到她们了|家人(?:已经)?上车|她们(?:已经)?上车/.test(compactText)) {
    if (state?.phase !== 'waiting-for-passengers') {
      return {
        intent: 'confirm-passengers-onboard',
        confidence: 0.99,
        slotUpdates: {},
        missingSlots: [],
        proposedEvents: [],
        assistantText: '请在车辆停稳并到达接机点后，再确认家人已经上车。',
      }
    }
    return {
      intent: 'confirm-passengers-onboard',
      confidence: 0.99,
      slotUpdates: { passengersOnboard: true },
      missingSlots: [],
      proposedEvents: [{
        ...eventBase,
        type: state.pickupAirport ? 'passengers.onboard' : 'user.confirmed-passengers-onboard',
      }],
      assistantText: '已记录乘客上车。',
    }
  }

  if (/先去(?:充电|补能)/.test(compactText)) {
    return {
      intent: 'plan-charging',
      confidence: 0.98,
      slotUpdates: { charging: { recommended: true, accepted: true, status: 'planned' } },
      missingSlots: pickupMissingSlots(state, passengers, flightNumber),
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，已准备把补能安排在前往机场之前。',
    }
  }

  if (/^(?:现在出发|开始导航|出发)$/.test(compactText)) {
    const routeId = input.routeId ?? `route-airport-${stableHash(state?.taskId ?? compactText)}`
    return {
      intent: 'start-navigation',
      confidence: 0.98,
      slotUpdates: { navigation: { requested: true } },
      missingSlots: pickupMissingSlots(state, passengers, flightNumber),
      proposedEvents: [{ ...eventBase, type: 'navigation.started', routeId }],
      assistantText: '好的，已准备开始前往机场的导航。',
    }
  }

  if (
    state?.phase === 'returning-home'
    && /(?:应用|恢复|设置|调整|开启)(?:家庭|后排|座舱|媒体|温度|偏好)*(?:座舱|媒体|温度|偏好)/.test(compactText)
    && !/(?:不要|不需要|别|取消|关闭|停止|是什么|有哪些|查看|告诉我)/.test(compactText)
  ) {
    return {
      intent: 'apply-cabin-preferences',
      confidence: 0.98,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，已准备应用已授权的座舱偏好。',
    }
  }

  const flightChoiceOrdinal = parseFlightChoiceOrdinal(compactText)
  if (flightChoiceOrdinal !== undefined) {
    // Meaningful only while a board is on screen; the gateway checks that and
    // falls back to the ordinary unknown reply when there is nothing to pick.
    return {
      intent: 'pick-flight-choice',
      confidence: 0.97,
      slotUpdates: { flightChoiceOrdinal },
      missingSlots: pickupMissingSlots(state, passengers, flightNumber),
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: `好的，选第 ${flightChoiceOrdinal} 个航班。`,
    }
  }

  // 刷新航班: read the board again. Meaningful only while one is on screen, and
  // gated there by the gateway the same way the ordinal is.
  if (isFlightOptionsRefresh(compactText)) {
    return {
      intent: 'refresh-flight-options',
      confidence: 0.97,
      slotUpdates: {},
      missingSlots: pickupMissingSlots(state, passengers, flightNumber),
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，重新查一遍到达航班。',
    }
  }

  if (isWeatherQuery(compactText)) {
    return {
      intent: 'check-weather',
      confidence: 0.98,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，正在为你查看接机目的地的天气。',
    }
  }

  if (isChargingQuery(compactText)) {
    return {
      intent: 'check-charging',
      confidence: 0.98,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，正在为你生成充电方案。',
    }
  }

  if (isScheduleQuery(compactText)) {
    return {
      intent: 'check-schedule',
      confidence: 0.98,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，正在为你查看今天的日程。',
    }
  }

  if (isDepartureTimeQuery(compactText)) {
    return {
      intent: 'check-departure-time',
      confidence: 0.98,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，正在算建议的出发时间。',
    }
  }

  // 稍后提醒: the answer to a departure recommendation, not a general-purpose
  // "remind me" — this planner has no way to be told what about. The gateway
  // offers it only where a departure time exists to be reminded of.
  if (isRemindLaterRequest(compactText)) {
    return {
      intent: 'remind-later',
      confidence: 0.97,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，到点我提醒你出发。',
    }
  }

  // 查看日程 answers off the calendar the trip already read, which is why it is
  // its own intent rather than a phrasing of 看看日程: same question, and
  // deliberately not the same cost.
  if (isCalendarViewRequest(compactText)) {
    return {
      intent: 'view-calendar',
      confidence: 0.97,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，这是今天的日程。',
    }
  }

  // The two answers to the proactive weather advisory. Meaningful only while
  // an advisory is active; the gateway checks that and leaves the words on
  // the ordinary unknown path otherwise.
  if (/^(?:请|麻烦)?(?:帮我)?提醒(?:乘客|她们|他们|家人|妈妈|爸爸)?带伞(?:吧|好了)?[?？。！!]?$/.test(compactText)) {
    return {
      intent: 'send-weather-reminder',
      confidence: 0.98,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，准备好带伞提醒，发送前请确认。',
    }
  }

  // 暂不处理 answers whichever advisory is on screen. One intent for the family:
  // the words never name the prompt, so an intent that did would be claiming
  // something the driver did not say. The gateway retires what is active.
  // 保持当前计划 joins the family as the calendar conflict's own dismissal — the
  // driver read the lateness and accepted it, which retires the prompt the same
  // way 暂不处理 does.
  if (/^(?:暂不处理|先不用|不用提醒(?:了)?|不用了|先这样|保持当前计划|保持原计划|按原计划(?:走|来)?)(?:吧|好了)?[。！!]?$/.test(compactText)) {
    return {
      intent: 'dismiss-advisory',
      confidence: 0.98,
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，先不处理。',
    }
  }

  const isPickupRequest = /去机场接/.test(actionableText)
    || /机场接(?:人|妈妈|爸爸|豆豆)/.test(actionableText)
    || /接(?:一下|一趟)?(?:妈妈|爸爸|豆豆)/.test(actionableText)
  if (isPickupRequest) {
    const cockpit = state?.phase === 'collecting-airport'
    const statedAirport = parsePickupAirport(text, cockpit ? state : undefined)
    const missingSlots = cockpit
      ? statedAirport ? [] : ['airport' as const]
      : pickupMissingSlots(state, passengers, flightNumber)
    return {
      intent: 'create-airport-pickup',
      confidence: 0.99,
      slotUpdates: {
        ...(passengers ? { passengers } : {}),
        ...(flightNumber ? { flightNumber } : {}),
        ...(statedAirport ? { airport: statedAirport } : {}),
      },
      missingSlots,
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: cockpit && missingSlots.includes('airport')
        ? '你要去哪个机场？例如虹桥机场或浦东机场。'
        : cockpit && statedAirport
          ? `好的，我帮你查${statedAirport.label}最近航班。`
          : missingSlots.includes('flightNumber')
            ? '好的，请告诉我她们的航班号。'
            : '好的，接机信息已齐全，可以继续安排行程。',
    }
  }

  if (flightNumber) {
    const missingSlots = pickupMissingSlots(state, passengers, flightNumber)
    return {
      intent: 'provide-flight-number',
      confidence: 0.99,
      slotUpdates: {
        flightNumber,
        ...(passengers ? { passengers } : {}),
      },
      missingSlots,
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: missingSlots.includes('passengers')
        ? `收到航班号 ${flightNumber}，请告诉我要接谁。`
        : `收到，航班号是 ${flightNumber}。`,
    }
  }

  return {
    intent: 'unknown',
    confidence: 0.2,
    slotUpdates: {},
    missingSlots: pickupMissingSlots(state, passengers, flightNumber),
    proposedEvents: [],
    assistantText: '我还不能确定你的接机安排，请换一种说法。',
  }
}

function informationPlan(intent: PlannerIntent, assistantText: string): Plan {
  return { intent, confidence: 0.99, slotUpdates: {}, missingSlots: [], proposedEvents: [], assistantText }
}

export function parsePickupAirport(text: string, state?: AirportPickupTaskState): { label: string; code?: 'SHA' | 'PVG' } | undefined {
  if (state?.phase === 'collecting-airport' && /^虹桥[。！!？?]?$/.test(text)) return { label: '虹桥机场', code: 'SHA' }
  if (state?.phase === 'collecting-airport' && /^浦东[。！!？?]?$/.test(text)) return { label: '浦东机场', code: 'PVG' }
  if (/虹桥(?:国际)?机场|上海虹桥/.test(text)) return { label: '虹桥机场', code: 'SHA' }
  if (/浦东(?:国际)?机场|上海浦东/.test(text)) return { label: '浦东机场', code: 'PVG' }
  if (state?.phase !== 'collecting-airport' && !/机场/.test(text)) return undefined
  const match = /([\p{Script=Han}A-Za-z0-9·]{2,24}机场)/u.exec(text)
  if (!match) return undefined
  // The broad custom-airport fallback must not turn the request scaffold into
  // a fact. For example, "我现在要去机场接人" contains the characters 机场,
  // but names no airport. Strip only common leading intent words, then require
  // at least two characters of actual airport identity before the suffix.
  const label = match[1]!.replace(
    /^(?:(?:我)?(?:现在)?(?:要|想|准备)?(?:去|到|前往)|请(?:帮我)?|帮我|选择|是)+/u,
    '',
  )
  return label.slice(0, -2).length >= 2 ? { label } : undefined
}

function pickupMissingSlots(
  state: AirportPickupTaskState | undefined,
  parsedPassengers: AirportPickupTaskState['passengers'] | undefined,
  parsedFlightNumber: string | undefined,
): PlannerSlot[] {
  const missing: PlannerSlot[] = []
  if (!parsedPassengers && !state?.passengers.names.length) missing.push('passengers')
  if (!parsedFlightNumber && !state?.flight?.flightNumber) missing.push('flightNumber')
  return missing
}

function isPauseRequest(text: string): boolean { return /^(?:暂停|先停一下|暂停导航)$/.test(text) }
function isFlightDetailQuery(text: string): boolean { return /^(?:查看|看看|打开)?(?:当前)?航班详情$/.test(text) }
function isVehicleStatusQuery(text: string): boolean { return /^(?:查看|看看|打开)?车辆状态$|^(?:看看|查看)?电量$/.test(text) }
function isSpeedUpRequest(text: string): boolean { return /^(?:跑快点|快一点|加快一档)$/.test(text) }
function isSpeedDownRequest(text: string): boolean { return /^(?:跑慢点|慢一点|降低一档)$/.test(text) }
function isHideNavigationInfo(text: string): boolean { return /^(?:隐藏导航信息|隐藏HUD|隐藏抬头显示)$/.test(text) }
function isShowNavigationInfo(text: string): boolean { return /^(?:显示导航信息|显示HUD|显示抬头显示)$/.test(text) }
function isReturnRequest(text: string): boolean { return /^(?:送我们回家|开始回家|回家)$/.test(text) }
function isStartReturnRequest(text: string): boolean { return /^(?:开始返程|确认返程)$/.test(text) }

function isTaskCancellation(text: string): boolean {
  return /取消(?:这个|本次)?(?:接机)?任务|取消接机|不去接了|不用接了|别去机场了/.test(text)
}

/**
 * A whole-utterance weather question and nothing else. Anchored on purpose:
 * a mixed sentence that also carries passengers or a flight number keeps its
 * task meaning and must not be consumed by the query path.
 */
function isWeatherQuery(text: string): boolean {
  return /^(?:请|麻烦)?(?:帮我|给我)?(?:看下|看看|查|查下|查查|查一下|看一下)?(?:到(?:的时候|达时|那边))?(?:的)?天气(?:怎么样|如何|情况)?[?？。！!]?$/.test(text)
}

function isChargingQuery(text: string): boolean {
  return /^(?:请|麻烦)?(?:帮我|给我)?(?:看下|看看|查看|查|查下|查查|查一下|看一下|找|找下|规划|检查)?(?:附近)?(?:的)?(?:充电|补能|充电站|充电路线|补能路线|充电方案|补能方案|是否需要充电|要不要充电)(?:怎么样|如何|情况)?[?？。！!]?$/.test(text)
}

/**
 * A whole-utterance schedule question, anchored like the weather form. 今天
 * is optional but nothing else may ride along: a sentence that also carries
 * passengers or a flight number keeps its task meaning.
 */
function isScheduleQuery(text: string): boolean {
  return /^(?:请|麻烦)?(?:帮我|给我)?(?:看下|看看|查|查下|查查|查一下|看一下)?(?:我)?(?:今天)?(?:的)?(?:还)?有?(?:什么|哪些)?(?:日历|日程|待办|安排|行程安排)(?:事项)?(?:怎么样|有哪些|有什么)?[?？。！!]?$/.test(text)
}

/**
 * 刷新航班 / 再查一下 / 换一批: read the arrivals board again.
 *
 * Anchored like the other whole-utterance forms. The bare 再查一下 is included
 * without a noun even though it is vague in isolation — while a board is on
 * screen there is only one thing to check again, and the gateway refuses the
 * intent everywhere else, so the vagueness costs an unknown reply rather than a
 * wrong action.
 */
function isFlightOptionsRefresh(text: string): boolean {
  return /^(?:请|麻烦)?(?:帮我|给我)?(?:再|重新)?(?:刷新|更新|查|看)(?:一下|一遍|下)?(?:最近|到达)?(?:航班|列表|航班列表)(?:吧|好了)?[?？。！!]?$/.test(text)
    || /^(?:请|麻烦)?(?:帮我|给我)?(?:再|重新)(?:查|看|搜)(?:一下|一遍|下)?(?:吧|好了)?[?？。！!]?$/.test(text)
    || /^(?:请|麻烦)?(?:帮我|给我)?换(?:一)?(?:批|组|些)(?:航班)?(?:吧|好了)?[?？。！!]?$/.test(text)
}

const CHINESE_ORDINAL_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
}

/**
 * A whole-utterance pick of an arrivals-board row: 第三个 / 选第三个 / 第3个航班.
 * Anchored so a sentence that happens to contain a rank keeps its own meaning,
 * and capped at five because the board never shows more rows than that. The
 * ordinal is 1-based and means nothing outside the board the driver is looking
 * at — the gateway resolves it against the same rows the composer rendered.
 */
function parseFlightChoiceOrdinal(text: string): number | undefined {
  const match = /^(?:请|麻烦)?(?:帮我)?(?:选|要|接|就)?(?:选)?第([一二两三四五12345])(?:个|班|条|架)?(?:航班|飞机)?(?:吧|好了)?[?？。！!]?$/.exec(text)
  if (!match) return undefined
  return CHINESE_ORDINAL_DIGITS[match[1]!]
}

/**
 * A whole-utterance question about when to leave, anchored like the weather and
 * schedule forms.
 *
 * Two shapes only, and both have to be questions. A bare 现在出发 is an
 * instruction, not a query — answering it with a card would swallow a command —
 * so the "now" shape requires 吗/嘛/呢 and the open shape requires 什么时候/几点.
 */
function isDepartureTimeQuery(text: string): boolean {
  return /^(?:请|麻烦)?(?:帮我|给我)?(?:看下|看看|算下|算一下)?(?:我)?(?:现在)?(?:要|该|得|应该)?(?:什么时候|几点)(?:出发|走|动身)(?:比较好|合适|呢)?[?？。！!]?$/.test(text)
    || /^现在(?:就)?(?:要|该|能|可以)?(?:出发|走|动身)(?:了)?(?:吗|嘛|呢)[?？。！!]?$/.test(text)
}

/**
 * 稍后提醒 / 到点提醒我 / 待会儿提醒我: set the reminder for the departure that
 * was just recommended.
 *
 * Anchored whole-utterance like the rest. 提醒我带伞 and 提醒乘客带伞 must not
 * reach here, which is why every shape requires the object to be a departure or
 * absent — a bare 提醒我 next to a departure card can only mean one thing, but
 * 提醒 followed by anything else means something this intent cannot deliver.
 */
function isRemindLaterRequest(text: string): boolean {
  return /^(?:请|麻烦)?(?:稍后|待会(?:儿)?|晚点|回头|到点|到时候)(?:再)?提醒(?:我|一下|我一下)?(?:出发|走|动身)?(?:吧|好了)?[。！!]?$/.test(text)
    || /^(?:请|麻烦)?提醒(?:我|一下|我一下)(?:出发|走|动身)(?:吧|好了)?[。！!]?$/.test(text)
    || /^(?:请|麻烦)?(?:到点|到时候)(?:叫|喊)我(?:一下)?(?:吧|好了)?[。！!]?$/.test(text)
}

/**
 * 查看日程 / 看下今天的日程: show the calendar the trip already read.
 *
 * Deliberately narrower than `isScheduleQuery`, which owns the open forms
 * (看看日程). These are the 查看-shaped requests the card's own button speaks, so
 * the button and the sentence land on the free path while an open-ended question
 * still goes and asks. Both end in the same card, so a driver who says the other
 * one is not worse off — only a read poorer.
 */
function isCalendarViewRequest(text: string): boolean {
  return /^(?:请|麻烦)?(?:帮我|给我)?查看(?:一下|下)?(?:我)?(?:今天(?:的)?)?(?:日程|日历|安排)(?:吧|好了)?[?？。！!]?$/.test(text)
    || /^(?:请|麻烦)?(?:帮我|给我)?打开(?:我的)?(?:日历|日程)(?:吧|好了)?[?？。！!]?$/.test(text)
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
