import { describe, expect, it } from 'vitest'
import { applyEvent, createInitialTask } from './index'
import { Planner, planAirportPickup } from './planner'

const timestamp = '2026-07-22T20:00:00+08:00'

describe('airport pickup Planner', () => {
  it('does not treat a generic airport request as a named airport', () => {
    const state = createInitialTask('cockpit-001', timestamp)
    state.phase = 'collecting-airport'

    expect(planAirportPickup({ text: '我现在要去机场接人', state, eventId: 'generic-airport' })).toMatchObject({
      intent: 'create-airport-pickup',
      slotUpdates: {},
      missingSlots: ['airport'],
      assistantText: expect.stringContaining('哪个机场'),
    })
  })

  it.each([
    ['虹桥机场', { label: '虹桥机场', code: 'SHA' }],
    ['浦东国际机场', { label: '浦东机场', code: 'PVG' }],
    ['去萧山机场接人', { label: '萧山机场' }],
  ] as const)('keeps an explicitly named airport from %s', (text, airport) => {
    const state = createInitialTask('cockpit-002', timestamp)
    state.phase = 'collecting-airport'

    expect(planAirportPickup({ text, state, eventId: 'named-airport' })).toMatchObject({
      intent: 'provide-airport',
      slotUpdates: { airport },
      missingSlots: [],
    })
  })

  it('collects passengers and asks for a missing flight number', () => {
    const state = createInitialTask('pickup-001', timestamp)
    const before = structuredClone(state)
    const plan = planAirportPickup({ text: '去机场接妈妈和豆豆', state, eventId: 'input-1' })

    expect(plan).toMatchObject({
      intent: 'create-airport-pickup',
      confidence: 0.99,
      slotUpdates: { passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false } },
      missingSlots: ['flightNumber'],
      proposedEvents: [{ eventId: 'input-1', timestamp, type: 'user.input', text: '去机场接妈妈和豆豆' }],
    })
    expect(plan.assistantText).toContain('航班号')
    expect(state).toEqual(before)
  })

  it('normalizes an MU flight number and fills the last required slot', () => {
    const state = createInitialTask('pickup-001', timestamp)
    state.passengers = { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false }

    expect(planAirportPickup({ text: '航班是 mu 5102', state, eventId: 'input-2' })).toMatchObject({
      intent: 'provide-flight-number',
      slotUpdates: { flightNumber: 'MU5102' },
      missingSlots: [],
      proposedEvents: [{ type: 'user.input', text: '航班是 mu 5102' }],
    })
  })

  it('supports passenger names from the shared catalog, including dad', () => {
    expect(planAirportPickup({ text: '接爸爸去机场，航班 MU5102', eventId: 'dad-1', timestamp })).toMatchObject({
      slotUpdates: {
        passengers: { memberIds: ['dad'], names: ['爸爸'], confirmedOnboard: false },
        flightNumber: 'MU5102',
      },
      missingSlots: [],
    })
  })

  it.each([
    '去航站楼接一下妈妈的电话',
    '去航站楼接一下妈妈和豆豆的电话',
  ])('does not interpret a passenger phone call as pickup: %s', (text) => {
    expect(planAirportPickup({ text, eventId: `phone-${text}`, timestamp })).toMatchObject({
      intent: 'unknown',
      proposedEvents: [],
    })
  })

  it.each([
    ['先接一下妈妈的电话，然后去机场接爸爸', undefined],
    ['先接一下妈妈的电话，然后去机场接爸爸，航班 MU5102', 'MU5102'],
  ] as const)('keeps the pickup intent after an unrelated phone request: %s', (text, expectedFlight) => {
    const plan = planAirportPickup({ text, eventId: `mixed-${text}`, timestamp })

    expect(plan).toMatchObject({
      intent: 'create-airport-pickup',
      slotUpdates: {
        passengers: { memberIds: ['dad'], names: ['爸爸'], confirmedOnboard: false },
        ...(expectedFlight ? { flightNumber: expectedFlight } : {}),
      },
      missingSlots: expectedFlight ? [] : ['flightNumber'],
      proposedEvents: [{ type: 'user.input', text }],
    })
    if (expectedFlight) {
      expect(applyEvent(createInitialTask('mixed-task', timestamp), plan.proposedEvents[0]!)).toMatchObject({
        passengers: { memberIds: ['dad'], names: ['爸爸'], confirmedOnboard: false },
        flight: { flightNumber: expectedFlight },
      })
    }
  })

  it('fills passengers when the flight is provided before the passenger', () => {
    const state = createInitialTask('pickup-001', timestamp)
    const plan = planAirportPickup({ text: '航班 MU5102，接爸爸', state, eventId: 'dad-after-flight', timestamp })

    expect(plan.slotUpdates).toMatchObject({ flightNumber: 'MU5102', passengers: { names: ['爸爸'] } })
    expect(plan.missingSlots).toEqual([])
  })

  it.each(['MU 5102', 'MU-5102', 'mu 5102'])('keeps %s consistent through Planner, event, and reducer', (input) => {
    const state = {
      ...createInitialTask('pickup-001', timestamp),
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }
    const plan = planAirportPickup({ text: `航班是 ${input}`, state, eventId: `flight-${input}`, timestamp })
    const event = plan.proposedEvents[0]

    expect(plan.slotUpdates.flightNumber).toBe('MU5102')
    expect(event).toMatchObject({ type: 'user.input' })
    expect(applyEvent(state, event!).flight?.flightNumber).toBe('MU5102')
  })

  it.each(['MU', 'MU51', '航班是 5102'])('does not propose a flight for invalid input %s', (input) => {
    const state = createInitialTask('pickup-001', timestamp)
    const plan = planAirportPickup({ text: input, state, eventId: `invalid-${input}`, timestamp })

    expect(plan.slotUpdates.flightNumber).toBeUndefined()
    expect(plan.proposedEvents).toEqual([])
    expect(applyEvent(state, { eventId: `reducer-${input}`, type: 'user.input', text: input, timestamp }).flight).toBeUndefined()
  })

  it('proposes a navigation event without applying it', () => {
    const state = createInitialTask('pickup-001', timestamp)
    state.passengers = { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false }
    state.flight = { flightNumber: 'MU5102', status: 'scheduled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: timestamp, terminal: 'T2' }

    const plan = new Planner().plan({ text: '开始导航', state, eventId: 'nav-1', routeId: 'route-airport-001' })

    expect(plan).toMatchObject({
      intent: 'start-navigation',
      slotUpdates: { navigation: { requested: true } },
      missingSlots: [],
      proposedEvents: [{ eventId: 'nav-1', timestamp, type: 'navigation.started', routeId: 'route-airport-001' }],
    })
    expect(state.navigation).toBeUndefined()
  })

  it.each(['先去充电', '先去补能'])('plans charging for %s', (text) => {
    expect(planAirportPickup({ text, eventId: 'charge-1', timestamp })).toMatchObject({
      intent: 'plan-charging',
      slotUpdates: { charging: { recommended: true, accepted: true, status: 'planned' } },
      proposedEvents: [{ type: 'user.input', text }],
    })
  })

  it.each(['先去充电', '先去补能'])('persists accepted charging when applying %s', (text) => {
    const state = createInitialTask('pickup-001', timestamp)
    const plan = planAirportPickup({ text, state, eventId: `charging-${text}`, timestamp })
    const next = applyEvent(state, plan.proposedEvents[0]!)

    expect(next.charging).toMatchObject({ recommended: true, accepted: true, status: 'planned' })
  })

  it.each(['已经接到她们', '家人上车'])('maps %s to the onboard domain event', (text) => {
    const state = { ...createInitialTask('pickup-001', timestamp), phase: 'waiting-for-passengers' as const }
    expect(planAirportPickup({ text, state, eventId: 'onboard-1', timestamp })).toMatchObject({
      intent: 'confirm-passengers-onboard',
      slotUpdates: { passengersOnboard: true },
      missingSlots: [],
      proposedEvents: [{ type: 'user.confirmed-passengers-onboard' }],
    })
  })

  it('does not bypass the waiting-for-passengers precondition', () => {
    const plan = planAirportPickup({ text: '已经接到她们', state: createInitialTask('pickup-001', timestamp), eventId: 'onboard-1', timestamp })

    expect(plan).toMatchObject({ intent: 'confirm-passengers-onboard', proposedEvents: [] })
    expect(plan.assistantText).toContain('停稳')
  })

  it.each(['取消接机任务', '不用接了'])('maps %s to task cancellation', (text) => {
    expect(planAirportPickup({ text, eventId: 'cancel-1', timestamp })).toMatchObject({
      intent: 'cancel-task',
      slotUpdates: { cancelled: true },
      missingSlots: [],
      proposedEvents: [{ type: 'user.cancelled-task', reason: text }],
    })
  })

  it('requires an explicit affirmative returning-home command for cabin preferences', () => {
    const state = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
    }
    expect(planAirportPickup({ text: '应用家庭座舱偏好', state, eventId: 'cabin-yes', timestamp })).toMatchObject({
      intent: 'apply-cabin-preferences',
      proposedEvents: [{ type: 'user.input' }],
    })
    expect(planAirportPickup({ text: '不要应用座舱偏好', state, eventId: 'cabin-no', timestamp })).toMatchObject({
      intent: 'unknown',
      proposedEvents: [],
    })
    expect(planAirportPickup({ text: '座舱偏好是什么', state, eventId: 'cabin-question', timestamp })).toMatchObject({
      intent: 'unknown',
      proposedEvents: [],
    })
  })

  it('returns the same fallback metadata and event for identical inputs', () => {
    const first = new Planner().plan('开始导航')
    const second = new Planner().plan('开始导航')

    expect(second).toEqual(first)
  })

  it.each(['看下天气', '天气怎么样', '到的时候天气怎么样'])('recognizes %s as a whole-utterance weather query', (text) => {
    expect(planAirportPickup({ text, timestamp })).toMatchObject({
      intent: 'check-weather',
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
    })
  })

  it('keeps the task meaning of a mixed sentence that also mentions weather', () => {
    expect(planAirportPickup({ text: '接妈妈，顺便看下天气', timestamp }).intent).toBe('create-airport-pickup')
  })

  it.each(['看看我的日程', '今天有什么安排', '我的待办', '看看我的待办事项'])('recognizes %s as a whole-utterance schedule query', (text) => {
    expect(planAirportPickup({ text, timestamp })).toMatchObject({
      intent: 'check-schedule',
      slotUpdates: {},
      missingSlots: [],
      proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
    })
  })

  it('keeps the task meaning of a mixed sentence that also mentions the schedule', () => {
    expect(planAirportPickup({ text: '接妈妈，顺便看看日程', timestamp }).intent).toBe('create-airport-pickup')
  })

  it('does not consume schedule questions outside the fixed forms', () => {
    expect(planAirportPickup({ text: '明天有什么安排', timestamp }).intent).toBe('unknown')
    expect(planAirportPickup({ text: '安排一下接机', timestamp }).intent).toBe('unknown')
  })

  it.each([
    ['第三个', 3],
    ['选第三个', 3],
    ['第3个', 3],
    ['要第一个', 1],
    ['接第五班', 5],
    ['第二个航班', 2],
    ['就第四个吧', 4],
  ] as const)('parses %s as a board pick of row %d', (text, ordinal) => {
    expect(planAirportPickup({ text, timestamp })).toMatchObject({
      intent: 'pick-flight-choice',
      slotUpdates: { flightChoiceOrdinal: ordinal },
      proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
    })
  })

  it('does not consume ordinals outside the pick forms', () => {
    // Beyond the board's five rows, bare counts, and sentences that merely
    // contain a rank all keep their own meaning.
    expect(planAirportPickup({ text: '第六个', timestamp }).intent).toBe('unknown')
    expect(planAirportPickup({ text: '三个', timestamp }).intent).toBe('unknown')
    expect(planAirportPickup({ text: '第三个问题是什么', timestamp }).intent).toBe('unknown')
  })

  it.each(['刷新航班', '刷新一下航班', '再查一下到达航班', '重新查一下航班列表', '帮我再看一遍', '换一批航班', '换一批'])(
    'recognizes %s as asking for the board again',
    (text) => {
      expect(planAirportPickup({ text, timestamp })).toMatchObject({
        intent: 'refresh-flight-options',
        slotUpdates: {},
        proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
      })
    },
  )

  it('does not let a refresh swallow a sentence that asks for something else', () => {
    // 查航班号 names a flight, not the list; 刷新地图 names another surface. Both
    // have to miss, or the refresh would answer questions it cannot answer.
    expect(planAirportPickup({ text: '查一下 MU5102', timestamp }).intent).not.toBe('refresh-flight-options')
    expect(planAirportPickup({ text: '刷新地图', timestamp }).intent).not.toBe('refresh-flight-options')
    expect(planAirportPickup({ text: '再查一下天气', timestamp }).intent).not.toBe('refresh-flight-options')
  })

  it.each(['什么时候出发', '几点出发比较好', '我该几点出发', '算下什么时候走', '现在要出发吗', '现在可以走了吗'])(
    'recognizes %s as a whole-utterance departure-time query',
    (text) => {
      expect(planAirportPickup({ text, timestamp })).toMatchObject({
        intent: 'check-departure-time',
        slotUpdates: {},
        missingSlots: [],
        proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
      })
    },
  )

  it('leaves a bare departure instruction alone rather than answering it with a card', () => {
    // 现在出发 is a command. Consuming it as a question would swallow the order.
    expect(planAirportPickup({ text: '现在出发', timestamp }).intent).not.toBe('check-departure-time')
    expect(planAirportPickup({ text: '现在就走', timestamp }).intent).not.toBe('check-departure-time')
  })

  it('keeps 开始导航 ahead of the departure question', () => {
    expect(planAirportPickup({ text: '开始导航', timestamp }).intent).toBe('start-navigation')
  })

  it('does not consume open-ended weather questions outside the fixed forms', () => {
    expect(planAirportPickup({ text: '明天天气怎么样', timestamp }).intent).toBe('unknown')
    expect(planAirportPickup({ text: '天气预报', timestamp }).intent).toBe('unknown')
  })

  it('does not invent an event for unsupported language', () => {
    expect(planAirportPickup({ text: '今天天气怎么样', timestamp })).toMatchObject({
      intent: 'unknown',
      confidence: 0.2,
      slotUpdates: {},
      proposedEvents: [],
    })
  })

  it.each(['提醒乘客带伞', '帮我提醒她们带伞', '提醒妈妈带伞吧'])('recognizes %s as the umbrella reminder answer', (text) => {
    expect(planAirportPickup({ text, timestamp })).toMatchObject({
      intent: 'send-weather-reminder',
      slotUpdates: {},
      proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
    })
  })

  it.each(['暂不处理', '先不用', '不用提醒了'])('recognizes %s as dismissing the advisory', (text) => {
    expect(planAirportPickup({ text, timestamp })).toMatchObject({
      intent: 'dismiss-advisory',
      slotUpdates: {},
      proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
    })
  })

  it('keeps advisory-shaped fragments and mixed sentences off the advisory intents', () => {
    expect(planAirportPickup({ text: '带伞', timestamp }).intent).toBe('unknown')
    expect(planAirportPickup({ text: '提醒乘客', timestamp }).intent).toBe('unknown')
    expect(planAirportPickup({ text: '暂不处理这个问题', timestamp }).intent).toBe('unknown')
  })

  it.each(['稍后提醒我', '待会儿提醒我出发', '到点提醒我', '提醒我出发', '到点叫我一下', '晚点再提醒我'])(
    'recognizes %s as setting the departure reminder',
    (text) => {
      expect(planAirportPickup({ text, timestamp })).toMatchObject({
        intent: 'remind-later',
        slotUpdates: {},
        proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
      })
    },
  )

  it('keeps the umbrella reminder and other objects away from the departure reminder', () => {
    // The one thing this intent must never swallow: 提醒 with an object it cannot
    // deliver. 带伞 is a different answer to a different card, and a bare 提醒我
    // names nothing at all.
    expect(planAirportPickup({ text: '提醒乘客带伞', timestamp }).intent).toBe('send-weather-reminder')
    expect(planAirportPickup({ text: '提醒我带伞', timestamp }).intent).not.toBe('remind-later')
    expect(planAirportPickup({ text: '提醒我', timestamp }).intent).toBe('unknown')
    expect(planAirportPickup({ text: '提醒我接妈妈', timestamp }).intent).not.toBe('remind-later')
  })

  it.each(['查看日程', '查看一下今天的日程', '帮我查看今天的安排', '打开日历'])(
    'recognizes %s as showing the calendar already read',
    (text) => {
      expect(planAirportPickup({ text, timestamp })).toMatchObject({
        intent: 'view-calendar',
        slotUpdates: {},
        proposedEvents: [expect.objectContaining({ type: 'user.input', text })],
      })
    },
  )

  it('leaves the open schedule question on the path that goes and asks', () => {
    // Same question, deliberately not the same cost: 看看日程 fires the read,
    // 查看日程 spends the one the trip already made.
    expect(planAirportPickup({ text: '看看日程', timestamp }).intent).toBe('check-schedule')
    expect(planAirportPickup({ text: '今天有什么安排', timestamp }).intent).toBe('check-schedule')
    expect(planAirportPickup({ text: '查看航班', timestamp }).intent).not.toBe('view-calendar')
  })
})
