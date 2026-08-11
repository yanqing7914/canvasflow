import { describe, expect, it, vi } from 'vitest'
import type { UISpec } from '@canvasflow/schema'
import { createProviderRegistry, createSideEffectRuntime } from '@canvasflow/tools'
import { AgentGateway, AgentGatewayError } from './gateway'
import { ReadToolOrchestrationError, ReadToolOrchestrator, type ReadToolOrchestration } from './orchestration'
import { Planner } from './planner'
import { MemoryTaskStore } from './store'

const now = '2026-07-22T12:00:00+08:00'

function createGateway() {
  return new AgentGateway({
    store: new MemoryTaskStore(),
    now: () => now,
    createId: () => '001',
  })
}

function createRequest(text = '我现在要去机场接妈妈和豆豆') {
  return {
    clientRequestId: 'client-create',
    input: { type: 'text' as const, text },
    vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P' as const, isNight: true },
    clientCapabilities: { uiSchemaVersion: '1.0' as const, supportsSse: true, supportsTts: true },
  }
}

function createCockpitRequest(text: string, clientRequestId: string) {
  return {
    ...createRequest(text),
    clientRequestId,
    clientCapabilities: {
      uiSchemaVersion: '1.0' as const,
      supportsSse: true,
      supportsTts: true,
      cockpitVersion: '1' as const,
    },
  }
}

function startCockpitOutbound(gateway: AgentGateway, prefix: string) {
  const flights = gateway.createTask(createCockpitRequest('去虹桥机场接人', `${prefix}-create`))
  const board = flights.ui.components.find((component) => component.type === 'flight-choices')
  if (board?.type !== 'flight-choices') throw new Error('expected cockpit flight board')
  const actionId = board.props.choices[0]?.actionId
  if (!actionId) throw new Error('expected cockpit flight action')
  const selected = gateway.submitAction(flights.task.taskId, {
    clientRequestId: `${prefix}-pick`, expectedTaskRevision: flights.task.taskRevision,
    expectedUiRevision: flights.ui.uiRevision, actionId, componentId: board.id, idempotencyKey: `${prefix}-pick`,
  })
  return gateway.submitAction(selected.task.taskId, {
    clientRequestId: `${prefix}-start`, expectedTaskRevision: selected.task.taskRevision,
    expectedUiRevision: selected.ui.uiRevision, actionId: 'start-outbound',
    componentId: 'outbound-confirmation', idempotencyKey: `${prefix}-start`,
  })
}

function failedLandingMessageTask(gateway: AgentGateway) {
  const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
  const started = gateway.submitAction(created.task.taskId, {
    clientRequestId: 'helper-start', expectedTaskRevision: created.task.taskRevision,
    expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation',
    componentId: 'navigation-plan', idempotencyKey: 'helper-start',
  })
  const landed = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'helper-landed', expectedTaskRevision: started.task.taskRevision,
    event: {
      eventId: 'helper-landed', type: 'flight.updated',
      flight: {
        flightNumber: 'MU5102', status: 'landed',
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
      },
      timestamp: '2026-07-22T20:40:00+08:00',
    },
  })
  return gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'helper-failed', expectedTaskRevision: landed.task.taskRevision,
    event: {
      eventId: 'helper-failed', type: 'message.failed',
      messageId: landed.task.message.pendingMessageId!, errorCode: 'SEND_FAILED',
      timestamp: '2026-07-22T20:41:00+08:00',
    },
  })
}

describe('AgentGateway', () => {
  it('opens first-turn cockpit weather at the fixed origin and labels it as now', () => {
    const orchestrator = new ReadToolOrchestrator()
    const resolveWeather = vi.spyOn(orchestrator, 'resolveWeather')
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => 'origin', orchestrator,
    })
    const weather = gateway.createTask(createCockpitRequest('查天气', 'origin-weather'))

    expect(weather.task.phase).toBe('collecting-airport')
    expect(resolveWeather).toHaveBeenCalledWith(weather.task.taskId, 'origin-weather', { locationId: 'navigation-segment-origin' })
    expect(weather.ui.windows?.at(-1)?.kind).toBe('weather')
    const card = weather.ui.components.find((component) => component.type === 'weather-card')
    if (card?.type !== 'weather-card') throw new Error('expected weather card')
    expect(card.props.timeLabel).toBe('现在')
  })

  it('keeps first-turn cockpit weather in airport collection with an explicit provider failure', () => {
    const orchestrator = new ReadToolOrchestrator()
    const failing: ReadToolOrchestration = {
      resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
      prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
      resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
      resolveWeather: () => {
        throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'weather timed out', true)
      },
    }
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => 'origin-failure', orchestrator: failing,
    })

    const created = gateway.createTask(createCockpitRequest('查天气', 'origin-weather-failure'))

    expect(created.task.phase).toBe('collecting-airport')
    expect(created.ui.windows ?? []).toHaveLength(0)
    expect(created.assistant?.text).toBe('天气服务暂时不可用，稍后可以再问我。')
  })

  it('uses exact speed-control boundary copy without changing a parked cockpit task', () => {
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => 'parked-speed' })
    const created = gateway.createTask(createCockpitRequest('我现在要去机场接人', 'parked-speed-create'))

    for (const [index, text] of ['跑快点', '跑慢点'].entries()) {
      const answered = gateway.submitEvent(created.task.taskId, {
        clientRequestId: `parked-speed-${index}`, expectedTaskRevision: created.task.taskRevision,
        event: { eventId: `parked-speed-${index}`, type: 'user.input', text, source: 'text', timestamp: now },
      })
      expect(answered.task).toEqual(created.task)
      expect(answered.assistant?.text).toBe('当前没有正在行驶的车辆')
    }
  })

  it('uses exact fastest and slowest boundary copy while preserving the active drive', () => {
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => 'speed-boundary' })
    const driving = startCockpitOutbound(gateway, 'speed-boundary')
    const fast = gateway.submitEvent(driving.task.taskId, {
      clientRequestId: 'speed-fast', expectedTaskRevision: driving.task.taskRevision,
      event: { eventId: 'speed-fast', type: 'user.input', text: '跑快点', source: 'text', timestamp: now },
    })
    const fastest = gateway.submitEvent(fast.task.taskId, {
      clientRequestId: 'speed-fastest', expectedTaskRevision: fast.task.taskRevision,
      event: { eventId: 'speed-fastest', type: 'user.input', text: '跑快点', source: 'text', timestamp: now },
    })
    expect(fastest.task).toEqual(fast.task)
    expect(fastest.assistant?.text).toBe('已经是最快档位')

    const normal = gateway.submitEvent(fastest.task.taskId, {
      clientRequestId: 'speed-normal', expectedTaskRevision: fastest.task.taskRevision,
      event: { eventId: 'speed-normal', type: 'user.input', text: '跑慢点', source: 'text', timestamp: now },
    })
    const slow = gateway.submitEvent(normal.task.taskId, {
      clientRequestId: 'speed-slow', expectedTaskRevision: normal.task.taskRevision,
      event: { eventId: 'speed-slow', type: 'user.input', text: '跑慢点', source: 'text', timestamp: now },
    })
    const slowest = gateway.submitEvent(slow.task.taskId, {
      clientRequestId: 'speed-slowest', expectedTaskRevision: slow.task.taskRevision,
      event: { eventId: 'speed-slowest', type: 'user.input', text: '跑慢点', source: 'text', timestamp: now },
    })
    expect(slowest.task).toEqual(slow.task)
    expect(slowest.assistant?.text).toBe('已经是最慢档位')
  })

  it('retries cockpit weather after a provider timeout without caching the failed event', () => {
    const orchestrator = new ReadToolOrchestrator()
    let attempts = 0
    const resolveWeather = vi.fn((taskId: string, requestId: string, input: { locationId: string; at?: string }) => {
      attempts += 1
      if (attempts === 1) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'weather timed out', true)
      return orchestrator.resolveWeather(taskId, requestId, input)
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => 'weather-retry',
      orchestrator: {
        resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
        prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
        resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        resolveWeather,
      },
    })
    const created = gateway.createTask(createCockpitRequest('我现在要去机场接人', 'weather-retry-create'))
    const request = {
      clientRequestId: 'weather-retry-first', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'weather-retry-event', type: 'user.input' as const, text: '查天气', source: 'text' as const, timestamp: now },
    }

    expect(() => gateway.submitEvent(created.task.taskId, request)).toThrowError(expect.objectContaining({
      code: 'PROVIDER_TIMEOUT', retryable: true, latest: expect.objectContaining({ task: created.task }),
    }))
    const retried = gateway.submitEvent(created.task.taskId, request)

    expect(resolveWeather).toHaveBeenCalledTimes(2)
    expect(retried.ui.windows?.at(-1)?.kind).toBe('weather')
    const card = retried.ui.components.find((component) => component.type === 'weather-card')
    if (card?.type !== 'weather-card') throw new Error('expected weather card')
    expect(card.props.timeLabel).toBe('现在')
  })

  it('retries cockpit calendar after a provider timeout without caching the failed event', () => {
    const orchestrator = new ReadToolOrchestrator()
    let attempts = 0
    const resolveSchedule = vi.fn((taskId: string, requestId: string, input: { date: string; now?: string }) => {
      attempts += 1
      if (attempts === 1) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'calendar timed out', true)
      return orchestrator.resolveSchedule(taskId, requestId, input)
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => 'calendar-retry',
      orchestrator: {
        resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
        prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
        resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        resolveSchedule,
      },
    })
    const created = gateway.createTask(createCockpitRequest('我现在要去机场接人', 'calendar-retry-create'))
    const request = {
      clientRequestId: 'calendar-retry-first', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'calendar-retry-event', type: 'user.input' as const, text: '查日历', source: 'text' as const, timestamp: now },
    }

    expect(() => gateway.submitEvent(created.task.taskId, request)).toThrowError(expect.objectContaining({
      code: 'PROVIDER_TIMEOUT', retryable: true, latest: expect.objectContaining({ task: created.task }),
    }))
    const retried = gateway.submitEvent(created.task.taskId, { ...request, clientRequestId: 'calendar-retry-second' })

    expect(resolveSchedule).toHaveBeenCalledTimes(2)
    expect(retried.ui.windows?.at(-1)?.kind).toBe('calendar')
  })

  it('runs the opt-in cockpit flow through guarded create, event, and action paths', () => {
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => '2026-08-11T09:00:00+08:00',
      createId: () => 'cockpit',
    })
    const cockpitRequest = {
      ...createRequest('我现在要去机场接人'),
      clientRequestId: 'cockpit-create',
      clientCapabilities: { uiSchemaVersion: '1.0' as const, supportsSse: true, supportsTts: true, cockpitVersion: '1' as const },
    }
    const created = gateway.createTask(cockpitRequest)
    expect(created.task.phase).toBe('collecting-airport')
    expect(created.assistant?.text).toContain('哪个机场')

    const flights = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'airport-answer', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'airport-answer', type: 'user.input', text: '虹桥机场', source: 'text', timestamp: now },
    })
    expect(flights.task.phase).toBe('choosing-flight')
    expect(flights.assistant?.shouldSpeak).toBe(false)
    expect(flights.ui.windows?.at(-1)?.kind).toBe('flight-list')
    const board = flights.ui.components.find((component) => component.type === 'flight-choices')
    if (board?.type !== 'flight-choices') throw new Error('expected cockpit flight board')
    expect(board.props.choices).toHaveLength(5)
    const pickAction = board.props.choices[0]!.actionId
    if (!pickAction) throw new Error('expected pick action')

    const selected = gateway.submitAction(flights.task.taskId, {
      clientRequestId: 'pick-flight', expectedTaskRevision: flights.task.taskRevision, expectedUiRevision: flights.ui.uiRevision,
      actionId: pickAction, componentId: board.id, idempotencyKey: 'pick-flight',
    })
    expect(selected.task.phase).toBe('confirming-outbound')
    expect(selected.task.flight?.flightNumber).toBe(board.props.choices[0]!.flightNumber)
    expect(selected.ui.windows?.map((window) => window.kind)).toEqual(expect.arrayContaining(['flight-list', 'outbound-confirmation']))

    const started = gateway.submitAction(selected.task.taskId, {
      clientRequestId: 'start-outbound', expectedTaskRevision: selected.task.taskRevision, expectedUiRevision: selected.ui.uiRevision,
      actionId: 'start-outbound', componentId: 'outbound-confirmation', idempotencyKey: 'start-outbound',
    })
    expect(started.task.phase).toBe('outbound-driving')
    expect(started.ui.windows ?? []).toHaveLength(0)

    const missingPositionWeather = gateway.submitEvent(started.task.taskId, {
      clientRequestId: 'weather-without-position', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'weather-without-position', type: 'user.input', text: '查天气', source: 'voice', timestamp: now },
    })
    expect(missingPositionWeather.ui.windows).toEqual(started.ui.windows)
    expect(missingPositionWeather.assistant?.text).toContain('当前模拟位置')
    const outboundSeed = started.task.navigationSimulation!
    const midBattery = (outboundSeed.initialBatteryPercent + outboundSeed.estimatedBatteryAtArrival) / 2
    const midRange = midBattery / cockpitRequest.vehicleContext.batteryPercent * cockpitRequest.vehicleContext.remainingRangeKm
    const weather = gateway.submitEvent(started.task.taskId, {
      clientRequestId: 'weather', expectedTaskRevision: missingPositionWeather.task.taskRevision,
      event: {
        eventId: 'weather', type: 'user.input', text: '查天气', source: 'voice', timestamp: now,
        navigationSnapshot: {
          routeId: started.task.navigationSimulation!.routeId, leg: 'outbound', progress: 0.5,
          speedKph: 55, batteryPercent: midBattery, remainingRangeKm: midRange,
          remainingDistanceKm: 16, currentRoad: '伪造道路',
        },
      },
    })
    expect(weather.ui.windows?.at(-1)?.kind).toBe('weather')
    expect(weather.assistant?.shouldSpeak).toBe(true)
    const calendar = gateway.submitEvent(weather.task.taskId, {
      clientRequestId: 'calendar', expectedTaskRevision: weather.task.taskRevision,
      event: { eventId: 'calendar', type: 'user.input', text: '查日历', source: 'text', timestamp: now },
    })
    expect(calendar.ui.windows?.at(-1)?.kind).toBe('calendar')
    expect(calendar.assistant?.shouldSpeak).toBe(false)
    const faster = gateway.submitEvent(calendar.task.taskId, {
      clientRequestId: 'faster', expectedTaskRevision: calendar.task.taskRevision,
      event: { eventId: 'faster', type: 'user.input', text: '跑快点', source: 'text', timestamp: now },
    })
    expect(faster.task.cockpit?.speedMode).toBe('fast')
    expect(faster.ui.windows?.some((window) => window.kind === 'weather')).toBe(true)

    expect(() => gateway.submitEvent(faster.task.taskId, {
      clientRequestId: 'premature-arrival', expectedTaskRevision: faster.task.taskRevision,
      event: {
        eventId: 'premature-arrival', type: 'navigation.outbound-arrived', timestamp: now,
        navigationSnapshot: {
          routeId: faster.task.navigationSimulation!.routeId, leg: 'outbound', progress: 0.5,
          speedKph: 75, batteryPercent: midBattery, remainingRangeKm: midRange, remainingDistanceKm: 16, currentRoad: '内环高架',
        },
      },
    })).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }))
    expect(() => gateway.submitEvent(faster.task.taskId, {
      clientRequestId: 'wrong-route-arrival', expectedTaskRevision: faster.task.taskRevision,
      event: {
        eventId: 'wrong-route-arrival', type: 'navigation.outbound-arrived', timestamp: now,
        navigationSnapshot: {
          routeId: 'wrong-route', leg: 'outbound', progress: 1,
          speedKph: 0, batteryPercent: outboundSeed.estimatedBatteryAtArrival,
          remainingRangeKm: outboundSeed.estimatedBatteryAtArrival / cockpitRequest.vehicleContext.batteryPercent * cockpitRequest.vehicleContext.remainingRangeKm,
          remainingDistanceKm: 0, currentRoad: '机场接人点',
        },
      },
    })).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }))
    const arrived = gateway.submitEvent(faster.task.taskId, {
      clientRequestId: 'arrived-airport', expectedTaskRevision: faster.task.taskRevision,
      event: {
        eventId: 'arrived-airport', type: 'navigation.outbound-arrived', timestamp: now,
        navigationSnapshot: {
          routeId: faster.task.navigationSimulation!.routeId, leg: 'outbound', progress: 1,
          speedKph: 0, batteryPercent: outboundSeed.estimatedBatteryAtArrival,
          remainingRangeKm: outboundSeed.estimatedBatteryAtArrival / cockpitRequest.vehicleContext.batteryPercent * cockpitRequest.vehicleContext.remainingRangeKm,
          remainingDistanceKm: 0, currentRoad: '机场接人点',
        },
      },
    })
    const onboard = gateway.submitEvent(arrived.task.taskId, {
      clientRequestId: 'onboard', expectedTaskRevision: arrived.task.taskRevision,
      event: { eventId: 'onboard', type: 'user.input', text: '接到人了', source: 'text', timestamp: now },
    })
    expect(onboard.task.phase).toBe('passengers-onboard')
    const airportWeather = gateway.submitEvent(onboard.task.taskId, {
      clientRequestId: 'airport-weather', expectedTaskRevision: onboard.task.taskRevision,
      event: { eventId: 'airport-weather', type: 'user.input', text: '查天气', source: 'text', timestamp: now },
    })
    const terminalBattery = onboard.task.navigationSimulation!.estimatedBatteryAtArrival
    const terminalRange = terminalBattery / cockpitRequest.vehicleContext.batteryPercent * cockpitRequest.vehicleContext.remainingRangeKm
    expect(() => gateway.submitEvent(onboard.task.taskId, {
      clientRequestId: 'return-without-vehicle', expectedTaskRevision: airportWeather.task.taskRevision,
      event: { eventId: 'return-without-vehicle', type: 'user.input', text: '开始回家', source: 'text', timestamp: now },
    })).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }))
    const confirmingReturn = gateway.submitEvent(onboard.task.taskId, {
      clientRequestId: 'return-request', expectedTaskRevision: airportWeather.task.taskRevision,
      event: {
        eventId: 'return-request', type: 'user.input', text: '开始回家', source: 'text', timestamp: now,
        navigationSnapshot: {
          routeId: onboard.task.navigationSimulation!.routeId, leg: 'outbound', progress: 1,
          speedKph: 0, batteryPercent: terminalBattery, remainingRangeKm: terminalRange, remainingDistanceKm: 0,
          currentRoad: '伪造机场道路',
        },
      },
    })
    expect(confirmingReturn.task.phase).toBe('confirming-return')
    expect(confirmingReturn.task.navigationSimulation?.initialBatteryPercent).toBe(terminalBattery)
    const returnCard = confirmingReturn.ui.components.find((component) => component.type === 'route-confirmation')
    expect(returnCard).toMatchObject({ props: { currentBatteryPercent: terminalBattery } })
    const returning = gateway.submitAction(confirmingReturn.task.taskId, {
      clientRequestId: 'start-return', expectedTaskRevision: confirmingReturn.task.taskRevision, expectedUiRevision: confirmingReturn.ui.uiRevision,
      actionId: 'start-return', componentId: 'return-confirmation', idempotencyKey: 'start-return',
    })
    expect(returning.task.phase).toBe('return-driving')
    const completed = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'home', expectedTaskRevision: returning.task.taskRevision,
      event: {
        eventId: 'home', type: 'navigation.return-arrived', timestamp: now,
        navigationSnapshot: {
          routeId: returning.task.navigationSimulation!.routeId, leg: 'return', progress: 1,
          speedKph: 0, batteryPercent: returning.task.navigationSimulation!.estimatedBatteryAtArrival,
          remainingRangeKm: returning.task.navigationSimulation!.estimatedBatteryAtArrival / cockpitRequest.vehicleContext.batteryPercent * cockpitRequest.vehicleContext.remainingRangeKm,
          remainingDistanceKm: 0, currentRoad: '家',
        },
      },
    })
    expect(completed.task).toMatchObject({ phase: 'completed', passengers: { names: [], confirmedOnboard: false } })
    expect(completed.task.flight).toBeUndefined()
    expect(completed.task.cockpit).toBeUndefined()
    expect(completed.ui.windows ?? []).toHaveLength(0)
  })

  it('rejects forged navigation snapshots and uses server-derived segment values', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('我现在要去机场接人'),
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true, cockpitVersion: '1' },
      clientRequestId: 'snapshot-create',
    })
    const flights = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'snapshot-airport', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'snapshot-airport', type: 'user.input', text: '虹桥机场', timestamp: now },
    })
    const board = flights.ui.components.find((component) => component.type === 'flight-choices')
    if (board?.type !== 'flight-choices' || !board.props.choices[0]?.actionId) throw new Error('expected flight choices')
    const selected = gateway.submitAction(flights.task.taskId, {
      clientRequestId: 'snapshot-pick', expectedTaskRevision: flights.task.taskRevision, expectedUiRevision: flights.ui.uiRevision,
      actionId: board.props.choices[0].actionId, componentId: board.id, idempotencyKey: 'snapshot-pick',
    })
    const started = gateway.submitAction(selected.task.taskId, {
      clientRequestId: 'snapshot-start', expectedTaskRevision: selected.task.taskRevision, expectedUiRevision: selected.ui.uiRevision,
      actionId: 'start-outbound', componentId: 'outbound-confirmation', idempotencyKey: 'snapshot-start',
    })
    expect(() => gateway.submitEvent(started.task.taskId, {
      clientRequestId: 'snapshot-forged', expectedTaskRevision: started.task.taskRevision,
      event: {
        eventId: 'snapshot-forged', type: 'user.input', text: '查天气', timestamp: now,
        navigationSnapshot: {
          routeId: started.task.navigationSimulation!.routeId, leg: 'outbound', progress: 0.5,
          speedKph: 1, batteryPercent: 99, remainingRangeKm: 999, remainingDistanceKm: 1,
          eta: '2099-01-01T00:00:00+00:00', currentRoad: '伪造道路',
        },
      },
    })).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }))
    const weather = gateway.submitEvent(started.task.taskId, {
      clientRequestId: 'snapshot-valid', expectedTaskRevision: started.task.taskRevision,
      event: {
        eventId: 'snapshot-valid', type: 'user.input', text: '查天气', timestamp: now,
        navigationSnapshot: {
          routeId: started.task.navigationSimulation!.routeId, leg: 'outbound', progress: 0.5,
          speedKph: 55, batteryPercent: 34.5, remainingRangeKm: 172.5, remainingDistanceKm: 16,
          eta: '2099-01-01T00:00:00+00:00', currentRoad: '伪造道路',
        },
      },
    })
    const weatherCard = weather.ui.components.find((component) => component.type === 'weather-card')
    expect(weatherCard).toMatchObject({ props: { location: '内环高架' } })
    const vehicle = gateway.submitEvent(started.task.taskId, {
      clientRequestId: 'snapshot-vehicle', expectedTaskRevision: weather.task.taskRevision,
      event: {
        eventId: 'snapshot-vehicle', type: 'user.input', text: '查看车辆状态', timestamp: now,
        navigationSnapshot: {
          routeId: started.task.navigationSimulation!.routeId, leg: 'outbound', progress: 0.5,
          speedKph: 55, batteryPercent: 34.5, remainingRangeKm: 172.5, remainingDistanceKm: 16,
          eta: '2099-01-01T00:00:00+00:00', currentRoad: '伪造道路',
        },
      },
    })
    const vehicleCard = vehicle.ui.components.find((component) => component.type === 'vehicle-status')
    expect(vehicleCard).toMatchObject({ props: { roadName: '内环高架', remainingDistanceKm: 16 } })
    if (vehicleCard?.type === 'vehicle-status') expect(vehicleCard.props.eta).not.toBe('2099-01-01T00:00:00+00:00')
  })

  it('uses the injected Planner as the create slot-filling boundary', () => {
    const planner = new Planner()
    const plan = vi.spyOn(planner, 'plan').mockReturnValue({
      intent: 'create-airport-pickup',
      confidence: 0.95,
      slotUpdates: {
        passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
        flightNumber: 'MU5102',
      },
      missingSlots: [],
      proposedEvents: [{
        eventId: 'client-create:input', type: 'user.input', text: '接妈妈，航班 MU5102', timestamp: now,
      }],
      assistantText: '接机信息已齐全。',
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', planner,
    })

    const created = gateway.createTask(createRequest('模型可理解但规则无法解析的创建请求'))

    expect(plan).toHaveBeenCalledWith(expect.objectContaining({
      text: '模型可理解但规则无法解析的创建请求',
      eventId: 'client-create:input',
      timestamp: now,
    }))
    expect(created.task).toMatchObject({
      phase: 'preparing', passengers: { memberIds: ['mom'], names: ['妈妈'] }, flight: { flightNumber: 'MU5102' },
    })
  })

  it('uses the injected Planner to fill slots from later user input', () => {
    const planner = new Planner()
    const plan = vi.spyOn(planner, 'plan')
    plan.mockReturnValueOnce({
      intent: 'unknown', confidence: 0.2, slotUpdates: {}, missingSlots: ['passengers', 'flightNumber'],
      proposedEvents: [], assistantText: '请补充接机信息。',
    })
    plan.mockReturnValueOnce({
      intent: 'create-airport-pickup',
      confidence: 0.95,
      slotUpdates: {
        passengers: { memberIds: ['dad'], names: ['爸爸'], confirmedOnboard: false },
        flightNumber: 'MU5102',
      },
      missingSlots: [],
      proposedEvents: [{
        eventId: 'planned-event', type: 'user.input', text: '接爸爸，航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00',
      }],
      assistantText: '接机信息已齐全。',
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', planner,
    })
    const created = gateway.createTask(createRequest('先创建一个空任务'))

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'planned-update', expectedTaskRevision: created.task.taskRevision,
      event: {
        eventId: 'planned-event', type: 'user.input', text: '模型可理解但规则无法解析的补充信息',
        timestamp: '2026-07-22T12:01:00+08:00',
      },
    })

    expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({
      text: '模型可理解但规则无法解析的补充信息', state: created.task, eventId: 'planned-event',
    }))
    expect(updated.task).toMatchObject({
      phase: 'preparing', passengers: { memberIds: ['dad'], names: ['爸爸'] }, flight: { flightNumber: 'MU5102' },
    })
  })

  it('does not bypass an authoritative Planner result with direct text parsing', () => {
    const planner = new Planner()
    const plan = vi.spyOn(planner, 'plan').mockReturnValue({
      intent: 'unknown', confidence: 0.2, slotUpdates: {}, missingSlots: ['passengers', 'flightNumber'],
      proposedEvents: [], assistantText: '请补充接机信息。',
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', planner,
    })

    const created = gateway.createTask(createRequest('接爸爸，航班 MU5102'))

    expect(plan).toHaveBeenCalledTimes(1)
    expect(created.task.passengers.names).toEqual([])
    expect(created.task.flight).toBeUndefined()
    expect(created.task.phase).toBe('collecting-information')
  })

  it('does not invoke the Planner again for create or event replays', () => {
    const planner = new Planner()
    const plan = vi.spyOn(planner, 'plan')
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', planner,
    })
    const create = createRequest('接妈妈')
    const created = gateway.createTask(create)
    gateway.createTask(create)
    const event = {
      clientRequestId: 'planner-event', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'planner-event', type: 'user.input' as const, text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    }
    gateway.submitEvent(created.task.taskId, event)
    gateway.submitEvent(created.task.taskId, event)

    expect(plan).toHaveBeenCalledTimes(2)
  })

  it('rejects a revision conflict before invoking the Planner', () => {
    const planner = new Planner()
    const plan = vi.spyOn(planner, 'plan')
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', planner,
    })
    const created = gateway.createTask(createRequest('接妈妈'))
    plan.mockClear()

    expect(() => gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'stale-planner-event', expectedTaskRevision: created.task.taskRevision + 1,
      event: {
        eventId: 'stale-planner-event', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00',
      },
    })).toThrow(AgentGatewayError)
    expect(plan).not.toHaveBeenCalled()
  })

  it('cancels and idempotently resets only the requested task', () => {
    let id = 0
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => `${++id}`,
    })
    const first = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const second = gateway.createTask({ ...createRequest('接爸爸，航班 MU5102'), clientRequestId: 'create-second' })

    const cancelled = gateway.cancelTask(first.task.taskId, {
      clientRequestId: 'cancel-first',
      expectedTaskRevision: first.task.taskRevision,
      eventId: 'cancel-event',
      reason: '用户取消',
    })
    const duplicateCancel = gateway.cancelTask(first.task.taskId, {
      clientRequestId: 'cancel-first-retry',
      expectedTaskRevision: first.task.taskRevision,
      eventId: 'cancel-event',
      reason: '用户取消',
    })
    expect(cancelled.task.phase).toBe('cancelled')
    expect(duplicateCancel.task).toEqual(cancelled.task)

    const reset = gateway.resetTask(first.task.taskId, {
      clientRequestId: 'reset-first',
      expectedTaskRevision: cancelled.task.taskRevision,
    })
    const duplicateReset = gateway.resetTask(first.task.taskId, {
      clientRequestId: 'reset-first',
      expectedTaskRevision: cancelled.task.taskRevision,
    })
    expect(reset.task.phase).toBe('collecting-information')
    expect(reset.task.taskRevision).toBe(cancelled.task.taskRevision + 1)
    expect(reset.task.uiRevision).toBeGreaterThan(cancelled.task.uiRevision)
    expect(duplicateReset.task).toEqual(reset.task)
    const createReplay = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    expect(createReplay.task).toEqual(first.task)
    expect(createReplay.ui).toEqual(first.ui)
    expect(gateway.getTask(second.task.taskId).task).toEqual(second.task)
  })

  it('does not replay a non-cancel event when cancel uses the same external event id', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const afterEvent = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'ordinary-event',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'shared-event-id', type: 'provider.timeout', provider: 'flight.get-status', timestamp: now },
    })
    const cancelled = gateway.cancelTask(created.task.taskId, {
      clientRequestId: 'cancel-collision',
      expectedTaskRevision: afterEvent.task.taskRevision,
      eventId: 'shared-event-id',
    })
    expect(cancelled.task.phase).toBe('cancelled')
  })

  it('creates a recoverable task and asks for the missing flight number', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())

    expect(created.task).toMatchObject({
      taskId: 'pickup-001',
      phase: 'collecting-information',
      passengers: { names: ['妈妈', '豆豆'] },
      taskRevision: 0,
      uiRevision: 1,
    })
    expect(created.assistant?.text).toContain('航班号')
    expect(gateway.getTask(created.task.taskId).task).toEqual(created.task)
  })

  it('keeps low-confidence input recoverable without applying parsed slots', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      input: { type: 'text', text: '接妈妈，航班 MU5102', source: 'voice', confidence: 0.59 },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: false },
    })

    expect(created.task).toMatchObject({ phase: 'collecting-information', passengers: { memberIds: [] } })
    expect(created.task.flight).toBeUndefined()
    expect(created.assistant).toEqual({ text: '我不太确定刚才的内容，请确认或编辑后再试一次。', shouldSpeak: false })

    const corrected = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'correct-low-confidence',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'correct-low-confidence', type: 'user.input', text: '接妈妈', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(corrected.task.passengers).toMatchObject({ memberIds: ['mom'], names: ['妈妈'] })
    expect(corrected.task.taskRevision).toBe(created.task.taskRevision + 1)
    expect(corrected.assistant).toEqual({ text: '好的，请告诉我她们的航班号。', shouldSpeak: false })
  })

  it('does not let stale or terminal events mutate request context or passenger facts', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      vehicleContext: { speedKph: 80, batteryPercent: 90, remainingRangeKm: 240, gear: 'D', isNight: false },
    })
    const stale = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'stale-parked', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'stale-parked', type: 'vehicle.parked', timestamp: '2026-07-22T11:59:00+08:00' },
    })
    expect(stale.task).toEqual(created.task)
    expect(stale.ui).toEqual(created.ui)

    const cancelled = gateway.cancelTask(created.task.taskId, {
      clientRequestId: 'cancel-terminal-input', expectedTaskRevision: created.task.taskRevision,
      eventId: 'cancel-terminal-input',
    })
    const terminal = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'terminal-passenger', expectedTaskRevision: cancelled.task.taskRevision,
      event: { eventId: 'terminal-passenger', type: 'user.input', text: '接爸爸', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(terminal.task).toEqual(cancelled.task)
    expect(terminal.ui).toEqual(cancelled.ui)
  })

  it('uses vehicle context for charging and preserves presentation across events', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      vehicleContext: { speedKph: 0, batteryPercent: 90, remainingRangeKm: 240, gear: 'P', isNight: false },
    })

    expect(created.task.charging.recommended).toBe(false)
    // Parked, so the vehicle context asks for nothing stricter than `full`; the composer has
    // already declared `preparing` a `compact` brief, and density takes the stricter of the two.
    expect(created.ui.presentation).toMatchObject({ density: 'compact', theme: 'light' })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'vehicle-moving', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'vehicle-moving', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(moving.ui.presentation).toMatchObject({ density: 'minimal', theme: 'light' })
    const denied = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'moving-navigation', expectedTaskRevision: moving.task.taskRevision,
      expectedUiRevision: moving.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'moving-navigation',
    })
    expect(denied.task).toEqual(moving.task)
    expect(denied.effects).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'VEHICLE_MOVING' })])

    const parked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'vehicle-parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'vehicle-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    // Parking relaxes the speed-derived density back to `full`, but it cannot undo the
    // composer's own `compact` judgement about how much this phase puts on the brief.
    expect(parked.ui.presentation).toMatchObject({ density: 'compact', theme: 'light' })
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'parked-navigation', expectedTaskRevision: parked.task.taskRevision,
      expectedUiRevision: parked.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'parked-navigation',
    })
    expect(started.task.phase).toBe('driving-to-airport')
  })

  it('rejects a stale onboard confirmation while the latest vehicle context is moving', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const plan = vi.fn(base['navigation.plan-route'])
    const update = vi.fn(base['navigation.update-route'])
    const cabin = vi.fn(base['vehicle.apply-cabin-profile'])
    const media = vi.fn(base['media.play'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => 'moving-return',
      runtime,
      providers: {
        ...base,
        'navigation.plan-route': plan,
        'navigation.update-route': update,
        'vehicle.apply-cabin-profile': cabin,
        'media.play': media,
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'moving-return-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'moving-return-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'moving-return-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'moving-return-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'moving-return-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'moving-return-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'moving-return-sensor', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'moving-return-sensor', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:04:00+08:00' },
    })
    expect(moving.task).toMatchObject({
      taskRevision: waiting.task.taskRevision,
      updatedAt: waiting.task.updatedAt,
      passengers: waiting.task.passengers,
      phase: 'waiting-for-passengers',
    })
    expect(moving.ui.presentation.density).toBe('compact')
    // Task creation plans the outbound route. The stale onboard request must
    // not add any return-trip provider call after the moving sensor update.
    plan.mockClear()
    update.mockClear()
    cabin.mockClear()
    media.mockClear()

    const denied = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'moving-return-onboard', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'moving-return-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:05:00+08:00' },
    })

    expect(denied.task).toEqual(moving.task)
    expect(denied.effects).toEqual([expect.objectContaining({ type: 'return-trip', status: 'failed', errorCode: 'VEHICLE_MOVING' })])
    expect(plan).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(cabin).not.toHaveBeenCalled()
    expect(media).not.toHaveBeenCalled()
  })

  it('rejects stale parked context after a newer moving event without changing task facts', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      vehicleContext: { speedKph: 0, batteryPercent: 90, remainingRangeKm: 240, gear: 'P', isNight: false },
    })

    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'ordered-moving', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'ordered-moving', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:02:00+08:00' },
    })
    expect(moving.task).toMatchObject({
      taskRevision: created.task.taskRevision,
      updatedAt: created.task.updatedAt,
      processedEventIds: created.task.processedEventIds,
    })
    expect(moving.task.processedEventIds).not.toContain('ordered-moving')
    expect(moving.ui.presentation.density).toBe('minimal')

    const staleParked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'stale-ordered-parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'stale-ordered-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(staleParked.task).toEqual(moving.task)
    expect(staleParked.ui).toEqual(moving.ui)
    expect(staleParked.task.processedEventIds).not.toContain('stale-ordered-parked')

    const denied = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'stale-parked-navigation', expectedTaskRevision: staleParked.task.taskRevision,
      expectedUiRevision: staleParked.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'stale-parked-navigation',
    })
    expect(denied.effects).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'VEHICLE_MOVING' })])
  })

  it('applies occupant input stamped behind the task clock instead of swallowing it', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈'))

    // A cabin clock behind `updatedAt` used to hit the reducer's freshness
    // guard and vanish behind an OK response. Occupant intent is clamped
    // forward now, so the typed flight number must land.
    const behindClock = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'behind-clock-input', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'behind-clock-input', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T11:00:00+08:00' },
    })

    expect(behindClock.task.flight?.flightNumber).toBe('MU5102')
    expect(behindClock.task.processedEventIds).toContain('behind-clock-input')
  })

  it('completes the trip on an arrival signal stamped behind the task clock', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'behind-clock-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'behind-clock-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'behind-clock-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'behind-clock-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'behind-clock-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'behind-clock-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
    })
    // The onboard confirmation is occupant intent too: stamped behind the
    // parked signal above, it still has to open the return trip.
    const returning = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'behind-clock-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'behind-clock-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T11:30:00+08:00' },
    })
    expect(returning.task.phase).toBe('returning-home')

    // Async return-trip receipts advance `updatedAt` past the cabin clock in
    // the real runtime; the fixed timestamps here model the same skew. The
    // arrival must close the task, not disappear behind an OK response.
    const arrived = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'behind-clock-arrived', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'behind-clock-arrived', type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T11:00:00+08:00' },
    })

    expect(arrived.task.phase).toBe('completed')
    expect(arrived.task.processedEventIds).toContain('behind-clock-arrived')
  })

  it('advances event ordering for a context-only charging completion', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))

    const charged = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'context-charging-completed', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'context-charging-completed', type: 'charging.completed', batteryPercent: 88, timestamp: '2026-07-22T12:02:00+08:00' },
    })
    expect(charged.task).toMatchObject({
      taskRevision: created.task.taskRevision,
      updatedAt: created.task.updatedAt,
      processedEventIds: created.task.processedEventIds,
    })
    expect(charged.task.processedEventIds).not.toContain('context-charging-completed')

    const staleMoving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'stale-after-charging', expectedTaskRevision: charged.task.taskRevision,
      event: { eventId: 'stale-after-charging', type: 'vehicle.moving', speedKph: 80, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(staleMoving.task).toEqual(charged.task)
    expect(staleMoving.ui).toEqual(charged.ui)
  })

  it('does not let a newer sensor watermark reject a valid task event', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈'))
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'future-sensor', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'future-sensor', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:02:00+08:00' },
    })

    const flight = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'task-after-sensor', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'task-after-sensor', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(flight.task).toMatchObject({ phase: 'preparing', flight: { flightNumber: 'MU5102' } })
    expect(flight.ui.presentation.density).toBe('compact')
  })

  it('advances a valid parked phase transition without overwriting newer moving context', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'mixed-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'mixed-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'mixed-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-moving', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'mixed-moving', type: 'vehicle.moving', speedKph: 20, timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const parked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'mixed-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:02:00+08:00' },
    })

    expect(parked.task.phase).toBe('waiting-for-passengers')
    expect(parked.ui.presentation.density).toBe('compact')

    const reset = gateway.resetTask(created.task.taskId, {
      clientRequestId: 'mixed-reset', expectedTaskRevision: parked.task.taskRevision,
    })
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-reprepare', expectedTaskRevision: reset.task.taskRevision,
      event: { eventId: 'mixed-reprepare', type: 'user.input', text: '接妈妈，航班 MU5102', timestamp: '2026-07-22T12:04:00+08:00' },
    })
    const denied = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'mixed-navigation-denied', expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'mixed-navigation-denied',
    })
    expect(denied.effects).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'VEHICLE_MOVING' })])
  })

  it('keeps moving safety context when parked arrives with the same timestamp', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'equal-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'equal-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'equal-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'equal-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'equal-moving', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'equal-moving', type: 'vehicle.moving', speedKph: 20, timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const parked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'equal-parked', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'equal-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:02:00+08:00' },
    })

    expect(parked.task.phase).toBe('waiting-for-passengers')
    expect(parked.ui.presentation.density).toBe('compact')

    const reset = gateway.resetTask(created.task.taskId, {
      clientRequestId: 'equal-reset', expectedTaskRevision: parked.task.taskRevision,
    })
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'equal-reprepare', expectedTaskRevision: reset.task.taskRevision,
      event: { eventId: 'equal-reprepare', type: 'user.input', text: '接妈妈，航班 MU5102', timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const denied = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'equal-navigation-denied', expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'equal-navigation-denied',
    })
    expect(denied.effects).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'VEHICLE_MOVING' })])
  })

  it('does not let a newer moving watermark reject active charging completion', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'mixed-charge-navigation', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'mixed-charge-navigation',
    })
    const charging = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-plan', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'mixed-charge-plan', type: 'user.input', text: '先去充电', timestamp: '2026-07-22T12:00:30+08:00' },
    })
    const active = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-start', expectedTaskRevision: charging.task.taskRevision,
      event: { eventId: 'mixed-charge-start', type: 'charging.started', stationId: 'station-hongqiao-01', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-moving', expectedTaskRevision: active.task.taskRevision,
      event: { eventId: 'mixed-charge-moving', type: 'vehicle.moving', speedKph: 10, timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const completed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'mixed-charge-completed', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'mixed-charge-completed', type: 'charging.completed', batteryPercent: 88, timestamp: '2026-07-22T12:02:00+08:00' },
    })

    expect(completed.task.charging).toMatchObject({ accepted: true, status: 'completed' })
    expect(completed.ui.components).toContainEqual(expect.objectContaining({
      type: 'charging-recommendation', props: expect.objectContaining({ currentBatteryPercent: 42 }),
    }))
    expect(completed.ui.presentation.density).toBe('compact')
  })

  it('persists a custom destination through passenger-first slot filling', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const planRoute = vi.fn(base['navigation.plan-route'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'navigation.plan-route': planRoute },
      orchestrator: new ReadToolOrchestrator({ registry: { ...base, 'navigation.plan-route': planRoute } }),
    })
    const created = gateway.createTask({
      ...createRequest('接妈妈'),
      destination: { id: 'destination-hongqiao-t2', name: '虹桥接机点' },
    })
    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'destination-flight', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'destination-flight', type: 'user.input', text: '航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(planRoute).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: created.task.taskId }),
      expect.objectContaining({ destination: { id: 'destination-hongqiao-t2', name: '虹桥接机点' } }),
    )
    expect(updated.task.navigation?.destination).toBe('虹桥接机点')
  })

  it('clears low-confidence guidance when fixture state is reset', () => {
    const gateway = createGateway()
    const created = gateway.createTask({
      ...createRequest('接妈妈，航班 MU5102'),
      input: { type: 'text', text: '接妈妈，航班 MU5102', source: 'voice', confidence: 0.2 },
    })

    const reset = gateway.resetTask(created.task.taskId, {
      clientRequestId: 'reset-low-confidence',
      expectedTaskRevision: created.task.taskRevision,
    })

    expect(reset.assistant?.text).toContain('航班号')
    expect(reset.assistant?.text).not.toContain('不太确定')
  })

  it.each([
    ['MU5102', 'MU5102'],
    ['MU 5102', 'MU5102'],
    ['MU-5102', 'MU5102'],
    ['mu 5102', 'MU5102'],
  ])('normalizes %s in the initial task request', (input, expectedFlightNumber) => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest(`我现在要去机场接妈妈和豆豆，航班 ${input}`))

    expect(created.task.flight?.flightNumber).toBe(expectedFlightNumber)
    expect(created.task.phase).toBe('preparing')
  })

  it.each(['MU', 'MU51', '接机航班是 5102'])('does not create a flight from invalid input %s', (input) => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest(`我现在要去机场接妈妈和豆豆，${input}`))

    expect(created.task.flight).toBeUndefined()
  })

  it('fills passengers after a flight-first create request', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('航班 MU5102'))
    expect(created.task.phase).toBe('collecting-information')

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-passenger',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'passenger-input', type: 'user.input', text: '接爸爸', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({
      phase: 'preparing',
      passengers: { memberIds: ['dad'], names: ['爸爸'] },
      flight: { flightNumber: 'MU5102' },
      navigation: { routeId: 'route-airport-001' },
    })
  })

  it('fills passengers after a passenger-first create request', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接爸爸'))
    expect(created.task).toMatchObject({ phase: 'collecting-information', passengers: { memberIds: ['dad'], names: ['爸爸'] } })

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-input', type: 'user.input', text: '航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({ phase: 'preparing', passengers: { names: ['爸爸'] }, flight: { flightNumber: 'MU5102' } })
  })

  it('preserves an authorized landing contact when an unauthorized passenger is added', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈'))
    expect(created.task.message.autoNotifyAuthorized).toBe(true)

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-add-dad',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'add-dad', type: 'user.input', text: '接爸爸，航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task.passengers.names).toEqual(['妈妈', '爸爸'])
    expect(updated.task.message.autoNotifyAuthorized).toBe(true)
  })

  it('enables landing notification when an authorized passenger is added', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接爸爸'))
    expect(created.task.message.autoNotifyAuthorized).toBe(false)

    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-add-mom',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'add-mom', type: 'user.input', text: '接妈妈，航班 MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task.passengers.names).toEqual(['爸爸', '妈妈'])
    expect(updated.task.message.autoNotifyAuthorized).toBe(true)
  })

  it('keeps unresolved passengers missing while still accepting the flight slot', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接叔叔，航班 MU5102'))

    expect(created.task).toMatchObject({ phase: 'collecting-information', flight: { flightNumber: 'MU5102' }, passengers: { memberIds: [], names: [] } })
    expect(created.assistant?.text).toContain('哪位家人')
  })

  it('returns the original task for a retried create request', () => {
    const gateway = createGateway()
    const first = gateway.createTask(createRequest())
    gateway.submitEvent(first.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: first.task.taskRevision,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const retry = gateway.createTask(createRequest())

    expect(retry.task).toEqual(first.task)
    expect(retry.ui).toEqual(first.ui)
    expect(retry.task.taskRevision).toBe(0)
  })

  it('accepts an event at the expected revision and publishes a new UI', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({ phase: 'preparing', taskRevision: 1, uiRevision: 2 })
    expect(updated.ui).toMatchObject({ phase: 'preparing', taskRevision: 1, uiRevision: 2 })
    expect(updated.ui.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'flight-status' }),
      expect.objectContaining({ type: 'navigation-summary' }),
      expect.objectContaining({ type: 'charging-recommendation' }),
    ]))
  })

  it('prepares one provider-backed transaction with trusted task and UI values', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const updated = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(updated.task).toMatchObject({
      taskRevision: 1,
      flight: { flightNumber: 'MU5102', status: 'scheduled', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' },
      charging: { recommended: false, status: 'none' },
      message: { autoNotifyAuthorized: true },
    })
    expect(updated.ui.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'flight-status', props: expect.objectContaining({ scheduledArrival: '2026-07-22T20:30:00+08:00' }) }),
      expect.objectContaining({ id: 'navigation-plan', props: expect.objectContaining({ routeId: 'route-airport-001', distanceKm: 32 }) }),
      expect.objectContaining({ id: 'charging-plan', props: expect.objectContaining({ estimatedFinalBatteryPercent: 29 }) }),
    ]))
    expect(updated).not.toHaveProperty('toolResults')
  })

  it('leaves event state unchanged when provider preparation times out and returns deterministic fallback UI', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001', orchestrator: new ReadToolOrchestrator() })
    const created = gateway.createTask(createRequest())
    const request = {
      clientRequestId: 'client-timeout',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-timeout', type: 'user.input' as const, text: 'MU0000', timestamp: '2026-07-22T12:01:00+08:00' },
    }

    const first = gateway.submitEvent(created.task.taskId, request)
    expect(first.task).toMatchObject({
      uiRevision: created.task.uiRevision + 1,
      taskRevision: created.task.taskRevision,
      phase: created.task.phase,
    })
    expect(first.task.flight).toBeUndefined()
    expect(first.ui.meta.generatedBy).toBe('fallback')
    expect(first.meta.fallbackUsed).toBe(true)
    const duplicate = gateway.submitEvent(created.task.taskId, { ...request, clientRequestId: 'client-timeout-retry' })
    expect(duplicate.task).toEqual(first.task)
    expect(duplicate.ui).toEqual(first.ui)
    expect(duplicate.effects).toEqual(first.effects)
  })

  it('maps non-timeout provider failures to a deterministic fallback without committing the event', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001' })
    const created = gateway.createTask(createRequest())

    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-provider-failed',
      expectedTaskRevision: 0,
      event: { eventId: 'unknown-flight', type: 'user.input', text: 'MU9999', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(failed.task).toMatchObject({
      uiRevision: created.task.uiRevision + 1,
      taskRevision: created.task.taskRevision,
      phase: created.task.phase,
    })
    expect(failed.task.flight).toBeUndefined()
    expect(failed.ui.meta.generatedBy).toBe('fallback')
    expect(failed.meta.fallbackUsed).toBe(true)
  })

  it('stores and replays the same fallback when initial trip preparation times out', () => {
    const gateway = createGateway()
    const request = createRequest('接妈妈，航班 MU0000')

    const first = gateway.createTask(request)
    const duplicate = gateway.createTask(request)

    expect(first.task).toMatchObject({
      taskRevision: 1,
      flight: { flightNumber: 'MU0000' },
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
    })
    expect(first.ui.meta.generatedBy).toBe('fallback')
    expect(first.meta.fallbackUsed).toBe(true)
    expect(duplicate.task).toEqual(first.task)
    expect(duplicate.ui).toEqual(first.ui)
    expect(duplicate.effects).toEqual(first.effects)
  })

  it('preserves locally parsed passenger and flight facts when initial passenger lookup fails', () => {
    const base = new ReadToolOrchestrator()
    let passengerReads = 0
    const orchestrator = {
      resolveInitialPassengers: (taskId: string, requestId: string, labels: string[]) => {
        passengerReads += 1
        if (passengerReads === 1) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'family timeout', true)
        return base.resolveInitialPassengers(taskId, requestId, labels)
      },
      prepareTrip: base.prepareTrip.bind(base),
      resolveReturnTripPreferences: base.resolveReturnTripPreferences.bind(base),
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator })
    const request = createRequest('接妈妈，航班 MU5102')

    const fallback = gateway.createTask(request)

    expect(fallback.task).toMatchObject({
      phase: 'preparing',
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
      flight: { flightNumber: 'MU5102', trusted: false },
      message: { autoNotifyAuthorized: false },
    })
    expect(fallback.assistant).toBeUndefined()
    expect(fallback.meta.fallbackUsed).toBe(true)

    const recovered = gateway.submitEvent(fallback.task.taskId, {
      clientRequestId: 'client-create-retry',
      expectedTaskRevision: fallback.task.taskRevision,
      event: { eventId: 'retry-input', type: 'user.input', text: request.input.text, timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(recovered.meta.fallbackUsed).toBe(false)
    expect(recovered.task).toMatchObject({
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
      flight: { flightNumber: 'MU5102' },
      navigation: { routeId: 'route-airport-001' },
      message: { autoNotifyAuthorized: true },
    })
  })

  it('preserves the previous task snapshot when incremental flight preparation fails', () => {
    const base = new ReadToolOrchestrator()
    const orchestrator = {
      resolveInitialPassengers: base.resolveInitialPassengers.bind(base),
      prepareTrip: () => { throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'flight timeout', true) },
      resolveReturnTripPreferences: base.resolveReturnTripPreferences.bind(base),
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator })
    const created = gateway.createTask(createRequest('接妈妈'))

    const fallback = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-input',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-input', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(fallback.meta.fallbackUsed).toBe(true)
    expect(fallback.task).toMatchObject({
      phase: created.task.phase,
      taskRevision: created.task.taskRevision,
      passengers: { memberIds: ['mom'], names: ['妈妈'] },
    })
    expect(fallback.task.flight).toBeUndefined()
    const duplicate = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-input-retry',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-input', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    expect(duplicate.task).toEqual(fallback.task)
    expect(duplicate.ui).toEqual(fallback.ui)
  })

  it('returns deterministic fallback when incremental passenger resolution times out', () => {
    const base = new ReadToolOrchestrator()
    const orchestrator = {
      resolveInitialPassengers: (taskId: string, requestId: string, labels: string[]) => {
        if (labels.includes('爸爸')) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'family timeout', true)
        return base.resolveInitialPassengers(taskId, requestId, labels)
      },
      prepareTrip: base.prepareTrip.bind(base),
      resolveReturnTripPreferences: base.resolveReturnTripPreferences.bind(base),
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator })
    const created = gateway.createTask(createRequest('航班 MU5102'))

    const fallback = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'passenger-timeout', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'passenger-timeout', type: 'user.input', text: '接爸爸', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(fallback.meta.fallbackUsed).toBe(true)
    expect(fallback.task.flight?.flightNumber).toBe('MU5102')
    expect(fallback.task.passengers.names).not.toContain('爸爸')
    expect(fallback.task.taskRevision).toBe(created.task.taskRevision)
  })

  it('returns the current snapshot through revision conflict errors', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())

    expect(() => gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-stale',
      expectedTaskRevision: 3,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })).toThrowError(AgentGatewayError)

    try {
      gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-stale',
        expectedTaskRevision: 3,
        event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'TASK_REVISION_CONFLICT', latest: { task: created.task } })
    }
  })

  it('returns the first result when an event request is retried with its original revision', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const request = {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input' as const, text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    }
    const first = gateway.submitEvent(created.task.taskId, request)
    const duplicate = gateway.submitEvent(created.task.taskId, {
      ...request,
      clientRequestId: 'client-flight-duplicate',
    })

    expect(duplicate.task).toEqual(first.task)
    expect(duplicate.ui).toEqual(first.ui)
    expect(duplicate.effects).toEqual(first.effects)
  })

  it('registers and executes the current start-navigation action through the event pipeline', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(prepared.ui.actions).toContainEqual(expect.objectContaining({
      id: 'start-navigation',
      event: { type: 'tool-request', actionToken: 'start-navigation' },
    }))
    // Leaving leads the card; the pre-departure question follows it.
    expect(prepared.ui.components).toContainEqual(expect.objectContaining({
      id: 'navigation-plan',
      actions: ['start-navigation', 'ask-departure-time'],
    }))

    const request = {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    }
    const started = gateway.submitAction(created.task.taskId, request)
    const duplicate = gateway.submitAction(created.task.taskId, { ...request, clientRequestId: 'client-start-navigation-retry' })

    expect(started.task).toMatchObject({ phase: 'driving-to-airport', taskRevision: 2, navigation: { routeId: 'route-airport-001' } })
    expect(started.effects).toMatchObject([{ type: 'navigation.start', tool: 'navigation.start' }])
    expect(duplicate.task).toEqual(started.task)
    expect(duplicate.ui).toEqual(started.ui)
    expect(duplicate.effects).toEqual(started.effects)
  })

  it('executes navigation.start before committing the navigation event', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const startNavigation = vi.fn(base['navigation.start'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
      providers: { ...base, 'navigation.start': startNavigation },
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-001',
    })

    expect(startNavigation).toHaveBeenCalledTimes(1)
    expect(startNavigation).toHaveBeenCalledWith(
      { taskId: created.task.taskId, requestId: 'pickup-001:navigation.start:nav-provider-001' },
      { routeId: 'route-airport-001', idempotencyKey: 'nav-provider-001' },
    )
    expect(started.task).toMatchObject({ phase: 'driving-to-airport', navigation: { status: 'active' } })
    expect(started.effects).toEqual([{
      effectId: 'action:nav-provider-001:0',
      type: 'navigation.start',
      status: 'succeeded',
      tool: 'navigation.start',
    }])

    const duplicate = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation-retry',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-001',
    })
    expect(startNavigation).toHaveBeenCalledTimes(1)
    expect(duplicate.task).toEqual(started.task)
    expect(duplicate.effects).toEqual(started.effects)
  })

  it('executes the return-trip route, cabin, and media providers after passengers board', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const updateRoute = vi.fn(base['navigation.update-route'])
    const applyCabin = vi.fn(base['vehicle.apply-cabin-profile'])
    const playMedia = vi.fn(base['media.play'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'navigation.update-route': updateRoute, 'vehicle.apply-cabin-profile': applyCabin, 'media.play': playMedia },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'return-nav-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'return-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'return-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const returning = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'return-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })

    expect(returning.task).toMatchObject({ phase: 'returning-home', passengers: { confirmedOnboard: true }, navigation: { destination: '家', status: 'active' } })
    expect(returning.effects).toEqual([
      { effectId: 'return-onboard:effect:0', type: 'navigation.update-route', status: 'succeeded', tool: 'navigation.update-route' },
      { effectId: 'return-onboard:effect:1', type: 'vehicle.apply-cabin-profile', status: 'succeeded', tool: 'vehicle.apply-cabin-profile' },
      { effectId: 'return-onboard:effect:2', type: 'media.play', status: 'succeeded', tool: 'media.play' },
    ])
    expect(updateRoute).toHaveBeenCalledTimes(1)
    expect(applyCabin).toHaveBeenCalledTimes(1)
    expect(playMedia).toHaveBeenCalledTimes(1)
    expect(applyCabin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ zone: 'rear', temperatureC: 25, mediaTitle: '豆豆故事', sourceMemberIds: ['mom', 'doubao'] }))
    expect(playMedia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mediaTitle: '豆豆故事', sourceMemberId: 'doubao' }))

    const duplicate = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-onboard-retry', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'return-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })
    expect(duplicate.task).toEqual(returning.task)
    expect(updateRoute).toHaveBeenCalledTimes(1)
    expect(applyCabin).toHaveBeenCalledTimes(1)
    expect(playMedia).toHaveBeenCalledTimes(1)
  })

  it('executes and idempotently replays the registered cabin undo action', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)

    expect(returning.ui.components).toContainEqual(expect.objectContaining({
      id: 'cabin-profile',
      actions: ['revert-cabin-profile'],
      props: expect.objectContaining({ reversible: true }),
    }))
    const request = {
      clientRequestId: 'cabin-revert',
      expectedTaskRevision: returning.task.taskRevision,
      expectedUiRevision: returning.ui.uiRevision,
      actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile',
      idempotencyKey: 'cabin-revert-001',
    }
    const reverted = gateway.submitAction(returning.task.taskId, request)
    const duplicate = gateway.submitAction(returning.task.taskId, { ...request, clientRequestId: 'cabin-revert-replay' })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(reverted.effects).toEqual([
      expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'succeeded' }),
    ])
    expect(reverted.task.returnTrip?.cabin.revert).toEqual({ status: 'succeeded' })
    expect(reverted.ui.actions.some((action) => action.id === 'revert-cabin-profile')).toBe(false)
    expect(reverted.ui.components).toContainEqual(expect.objectContaining({
      id: 'cabin-reverted',
      props: expect.objectContaining({ title: '座舱设置已撤销' }),
    }))
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
    expect(duplicate.task).toEqual(reverted.task)
    expect(duplicate.effects).toEqual(reverted.effects)
  })

  it('preserves cabin undo across context events and policy-denies it while moving', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)
    const moving = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'return-moving', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'return-moving', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:05:00+08:00' },
    })

    expect(moving.ui.actions.some((action) => action.id === 'revert-cabin-profile')).toBe(false)
    expect(moving.ui.components).toContainEqual(expect.objectContaining({
      id: 'cabin-profile',
      props: expect.objectContaining({ reversible: false }),
    }))
    expect(() => gateway.submitAction(moving.task.taskId, {
      clientRequestId: 'moving-revert', expectedTaskRevision: moving.task.taskRevision,
      expectedUiRevision: moving.ui.uiRevision, actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile', idempotencyKey: 'moving-revert',
    })).toThrow(AgentGatewayError)
    expect(revertCabin).not.toHaveBeenCalled()

    const parked = gateway.submitEvent(moving.task.taskId, {
      clientRequestId: 'return-parked-again', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'return-parked-again', type: 'vehicle.parked', timestamp: '2026-07-22T12:06:00+08:00' },
    })
    const reverted = gateway.submitAction(parked.task.taskId, {
      clientRequestId: 'parked-revert', expectedTaskRevision: parked.task.taskRevision,
      expectedUiRevision: parked.ui.uiRevision, actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile', idempotencyKey: 'parked-revert',
    })
    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(reverted.task.returnTrip?.cabin.revert?.status).toBe('succeeded')
  })

  it('freezes cabin undo after an ambiguous provider result', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn((ctx: Parameters<typeof base['vehicle.revert-cabin-profile']>[0], input: unknown) => {
      const result = base['vehicle.revert-cabin-profile'](ctx, input)
      return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)
    const unknown = gateway.submitAction(returning.task.taskId, {
      clientRequestId: 'ambiguous-revert', expectedTaskRevision: returning.task.taskRevision,
      expectedUiRevision: returning.ui.uiRevision, actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile', idempotencyKey: 'ambiguous-revert',
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(unknown.task.returnTrip?.cabin.revert).toEqual({ status: 'unknown', errorCode: 'PROVIDER_FAILED' })
    expect(unknown.ui.actions.some((action) => action.id === 'revert-cabin-profile')).toBe(false)
    expect(unknown.ui.components).toContainEqual(expect.objectContaining({ id: 'cabin-revert-unknown' }))
  })

  it('reverts the active cabin effect before cancelling the task', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)

    const cancelled = gateway.cancelTask(returning.task.taskId, {
      clientRequestId: 'return-cancel', expectedTaskRevision: returning.task.taskRevision, eventId: 'return-cancel',
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(cancelled.task.phase).toBe('cancelled')
    expect(cancelled.task.returnTrip?.cabin.revert).toEqual({ status: 'succeeded' })
    expect(cancelled.effects).toContainEqual(expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'succeeded',
    }))
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('reverts the active cabin effect before accepting a flight cancellation', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)

    const cancelled = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'return-flight-cancel', expectedTaskRevision: returning.task.taskRevision,
      event: {
        eventId: 'return-flight-cancel', type: 'flight.updated',
        flight: {
          flightNumber: 'MU5102', status: 'cancelled',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
        },
        timestamp: '2026-07-22T20:40:00+08:00',
      },
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(cancelled.task.flight?.status).toBe('cancelled')
    expect(cancelled.task.returnTrip?.cabin.revert).toEqual({ status: 'succeeded' })
    expect(cancelled.ui.actions.some((action) => action.id === 'revert-cabin-profile')).toBe(false)
    expect(cancelled.effects).toContainEqual(expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'succeeded',
    }))
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('persists a successful cabin cleanup when later terminal authorization cleanup fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'vehicle.revert-cabin-profile': revertCabin,
        'message.revoke-authorization': (context) => ({
          ok: false, data: null,
          error: { code: 'REVOKE_FAILED', message: 'offline', retryable: true },
          meta: { requestId: context.requestId!, taskId: context.taskId, tool: 'message.revoke-authorization', provider: 'fixture', durationMs: 1, generatedAt: now },
        }),
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'returning-landed-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'returning-landed-start',
    })
    const landed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'returning-landed', expectedTaskRevision: started.task.taskRevision,
      event: {
        eventId: 'returning-landed', type: 'flight.updated',
        flight: {
          flightNumber: 'MU5102', status: 'landed',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
        },
        timestamp: '2026-07-22T20:40:00+08:00',
      },
    })
    expect(landed.task.message.authorizationId).toBeDefined()

    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'returning-late-geofence', expectedTaskRevision: landed.task.taskRevision,
      event: { eventId: 'returning-late-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T20:41:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'returning-late-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'returning-late-parked', type: 'vehicle.parked', timestamp: '2026-07-22T20:42:00+08:00' },
    })
    const returning = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'returning-late-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'returning-late-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T20:43:00+08:00' },
    })

    const failed = gateway.cancelTask(returning.task.taskId, {
      clientRequestId: 'return-cancel-late-failure', expectedTaskRevision: returning.task.taskRevision,
      eventId: 'return-cancel-late-failure',
    })
    const replay = gateway.cancelTask(returning.task.taskId, {
      clientRequestId: 'return-cancel-late-failure-replay', expectedTaskRevision: returning.task.taskRevision,
      eventId: 'return-cancel-late-failure',
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(failed.task.phase).toBe('returning-home')
    expect(failed.task.returnTrip?.cabin.revert).toEqual({ status: 'succeeded' })
    expect(failed.task.message.authorizationId).toBeDefined()
    expect(failed.ui.actions.some((action) => action.id === 'revert-cabin-profile')).toBe(false)
    expect(failed.effects).toEqual([
      expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'succeeded' }),
      expect.objectContaining({ type: 'message.revoke-authorization', status: 'failed', errorCode: 'REVOKE_FAILED' }),
    ])
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
    expect(replay.task).toEqual(failed.task)
    expect(replay.effects).toEqual(failed.effects)
  })

  it('keeps the returning snapshot when terminal cabin cleanup fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'vehicle.revert-cabin-profile': (context) => ({
          ok: false, data: null,
          error: { code: 'REVERT_FAILED', message: 'offline', retryable: true },
          meta: { requestId: context.requestId!, taskId: context.taskId, tool: 'vehicle.revert-cabin-profile', provider: 'fixture', durationMs: 1, generatedAt: now },
        }),
      },
    })
    const returning = returningTask(gateway)

    const failed = gateway.cancelTask(returning.task.taskId, {
      clientRequestId: 'return-cancel-failed', expectedTaskRevision: returning.task.taskRevision, eventId: 'return-cancel-failed',
    })

    expect(failed.task).toEqual(returning.task)
    expect(failed.effects).toEqual([expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'failed', errorCode: 'REVERT_FAILED',
    })])
    expect(runtime.cabinCurrent.temperatureC).toBe(25)
  })

  it('reverts the active cabin effect before completing at home', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)

    const completed = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'return-arrived', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'return-arrived', type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T12:05:00+08:00' },
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(completed.task.phase).toBe('completed')
    expect(completed.task.returnTrip?.cabin.revert).toEqual({ status: 'succeeded' })
    expect(completed.effects).toContainEqual(expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'succeeded',
    }))
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('reverts the active cabin effect before resetting the task', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)

    const reset = gateway.resetTask(returning.task.taskId, {
      clientRequestId: 'return-reset', expectedTaskRevision: returning.task.taskRevision,
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(reset.task.phase).toBe('collecting-information')
    expect(reset.effects).toContainEqual(expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'succeeded',
    }))
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  // The live-mode counterpart of the test above: the same armed task, the same reset
  // call, and the cabin revert that reset would otherwise perform must not happen.
  //
  // Live mode fails every fixture provider by design (`enforceGatewayProviderMode`), so a
  // live gateway cannot drive a task into an armed state by itself. The task is therefore
  // armed through a fixture gateway and the reset is issued by a live gateway sharing that
  // store and side-effect runtime — one store, one vehicle, two gateway configurations.
  it('refuses to reset a task in live provider mode and reverts nothing', () => {
    const runtime = createSideEffectRuntime()
    const store = new MemoryTaskStore()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const providers = { ...base, 'vehicle.revert-cabin-profile': revertCabin }
    const fixtureGateway = new AgentGateway({
      store, now: () => now, createId: () => '001', runtime, providers,
    })
    const liveGateway = new AgentGateway({
      store, now: () => now, createId: () => '001', runtime, mode: 'live', providers,
    })
    const returning = returningTask(fixtureGateway)
    const appliedCabinTemperature = runtime.cabinCurrent.temperatureC
    expect(appliedCabinTemperature).not.toBe(22)

    expect(() => liveGateway.resetTask(returning.task.taskId, {
      clientRequestId: 'live-reset', expectedTaskRevision: returning.task.taskRevision,
    })).toThrowError(AgentGatewayError)

    try {
      liveGateway.resetTask(returning.task.taskId, {
        clientRequestId: 'live-reset', expectedTaskRevision: returning.task.taskRevision,
      })
      expect.unreachable('live mode must refuse a reset')
    } catch (error) {
      // No `latest`: a refused operation does not hand back task state.
      expect(error).toMatchObject({ code: 'POLICY_DENIED', retryable: false, latest: undefined })
    }

    // Nothing ran. The compensation the fixture-mode reset performs is not attempted, the
    // cabin the task applied is left exactly as the task left it, and the stored task is
    // untouched — including its revision, so no write reached the store.
    expect(revertCabin).not.toHaveBeenCalled()
    expect(runtime.cabinCurrent.temperatureC).toBe(appliedCabinTemperature)
    expect(fixtureGateway.getTask(returning.task.taskId).task).toEqual(returning.task)

    // And the same store still resets through a gateway that is allowed to: the refusal is
    // about the mode, not about this task having become un-resettable.
    const reset = fixtureGateway.resetTask(returning.task.taskId, {
      clientRequestId: 'fixture-reset', expectedTaskRevision: returning.task.taskRevision,
    })
    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(reset.task.phase).toBe('collecting-information')
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  // Ordering, stated as behaviour rather than as a comment: the refusal is reached before
  // the schema parse and before the task lookup, so neither an unknown task nor an invalid
  // body can produce anything other than the refusal. Anything that ran ahead of the guard
  // would surface here as TASK_NOT_FOUND or a ZodError instead.
  it('refuses a live-mode reset ahead of request validation and task lookup', () => {
    const runtime = createSideEffectRuntime()
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      mode: 'live', providers: createProviderRegistry(runtime),
    })

    try {
      gateway.resetTask('task-that-does-not-exist', { clientRequestId: 'live-reset-unknown', expectedTaskRevision: 0 })
      expect.unreachable('live mode must refuse a reset')
    } catch (error) {
      expect(error).toMatchObject({ code: 'POLICY_DENIED' })
    }

    try {
      gateway.resetTask('task-that-does-not-exist', {} as never)
      expect.unreachable('live mode must refuse a reset')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentGatewayError)
      expect(error).toMatchObject({ code: 'POLICY_DENIED' })
    }
  })

  it('still resets a task in mock provider mode', () => {
    const runtime = createSideEffectRuntime()
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      mode: 'mock', providers: createProviderRegistry(runtime, 'mock'),
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))

    const reset = gateway.resetTask(created.task.taskId, {
      clientRequestId: 'mock-reset', expectedTaskRevision: created.task.taskRevision,
    })

    expect(reset.task.phase).toBe('collecting-information')
  })

  it.each(['cancel', 'arrival', 'flight cancellation'] as const)(
    'accepts %s while moving and finishes the deferred cabin cleanup after parking',
    (operation) => {
      const runtime = createSideEffectRuntime()
      const base = createProviderRegistry(runtime)
      const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
        providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
      })
      const returning = returningTask(gateway)
      const moving = gateway.submitEvent(returning.task.taskId, {
        clientRequestId: `${operation}-moving`, expectedTaskRevision: returning.task.taskRevision,
        event: { eventId: `${operation}-moving`, type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:05:00+08:00' },
      })
      const submitTerminal = (expectedTaskRevision: number) => operation === 'cancel'
        ? gateway.cancelTask(returning.task.taskId, {
            clientRequestId: `${operation}-request`, expectedTaskRevision, eventId: `${operation}-terminal`,
          })
        : gateway.submitEvent(returning.task.taskId, operation === 'arrival'
          ? {
              clientRequestId: `${operation}-request`, expectedTaskRevision,
              event: { eventId: `${operation}-terminal`, type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T12:06:00+08:00' },
            }
          : {
              clientRequestId: `${operation}-request`, expectedTaskRevision,
              event: {
                eventId: `${operation}-terminal`, type: 'flight.updated',
                flight: { flightNumber: 'MU5102', status: 'cancelled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
                timestamp: '2026-07-22T12:06:00+08:00',
              },
            })

      const deferred = submitTerminal(moving.task.taskRevision)

      expect(deferred.effects).toContainEqual(expect.objectContaining({
        type: 'vehicle.revert-cabin-profile', status: 'failed', errorCode: 'VEHICLE_MOVING',
      }))
      expect(revertCabin).not.toHaveBeenCalled()
      if (operation === 'cancel') expect(deferred.task.phase).toBe('cancelled')
      if (operation === 'arrival') expect(deferred.task.phase).toBe('completed')
      if (operation === 'flight cancellation') expect(deferred.task.flight?.status).toBe('cancelled')

      const parked = gateway.submitEvent(returning.task.taskId, {
        clientRequestId: `${operation}-parked`, expectedTaskRevision: deferred.task.taskRevision,
        event: { eventId: `${operation}-parked`, type: 'vehicle.parked', timestamp: '2026-07-22T12:07:00+08:00' },
      })

      expect(revertCabin).toHaveBeenCalledTimes(1)
      expect(parked.effects).toContainEqual(expect.objectContaining({
        type: 'vehicle.revert-cabin-profile', status: 'succeeded',
      }))
    },
  )

  it('resets while moving and finishes deferred cleanup without consuming the next trip parking event', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const returning = returningTask(gateway)
    const oldCabinEffectId = returning.task.returnTrip?.workflowId
    const moving = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'reset-moving', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'reset-moving', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:05:00+08:00' },
    })

    const deferred = gateway.resetTask(returning.task.taskId, {
      clientRequestId: 'deferred-reset', expectedTaskRevision: moving.task.taskRevision,
    })

    expect(deferred.task.phase).toBe('collecting-information')
    expect(deferred.effects).toEqual([expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'failed', errorCode: 'VEHICLE_MOVING',
    })])
    expect(revertCabin).not.toHaveBeenCalled()

    const prepared = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'reset-new-trip', expectedTaskRevision: deferred.task.taskRevision,
      event: { eventId: 'reset-new-trip', type: 'user.input', text: '接妈妈，航班 MU5102', timestamp: '2026-07-22T12:06:00+08:00' },
    })
    const parkedForNewTrip = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'reset-first-parked', expectedTaskRevision: prepared.task.taskRevision,
      event: { eventId: 'reset-first-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:07:00+08:00' },
    })
    const started = gateway.submitAction(returning.task.taskId, {
      clientRequestId: 'reset-new-trip-start', expectedTaskRevision: parkedForNewTrip.task.taskRevision,
      expectedUiRevision: parkedForNewTrip.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'reset-new-trip-start',
    })
    const approaching = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'reset-new-trip-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'reset-new-trip-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:08:00+08:00' },
    })
    const parked = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'reset-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'reset-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:09:00+08:00' },
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(parkedForNewTrip.effects).toContainEqual(expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'succeeded',
    }))
    expect(runtime.cabinEffects.has(oldCabinEffectId!)).toBe(false)
    expect(parked.task.phase).toBe('waiting-for-passengers')
  })

  it('retains deferred cabin cleanup when reset message authorization revocation fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'vehicle.revert-cabin-profile': revertCabin,
        'message.revoke-authorization': (context) => ({
          ok: false, data: null,
          error: { code: 'REVOKE_FAILED', message: 'offline', retryable: true },
          meta: { requestId: context.requestId!, taskId: context.taskId, tool: 'message.revoke-authorization', provider: 'fixture', durationMs: 1, generatedAt: now },
        }),
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'deferred-revoke-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'deferred-revoke-start',
    })
    const landed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'deferred-revoke-landed', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'deferred-revoke-landed', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' },
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'deferred-revoke-geofence', expectedTaskRevision: landed.task.taskRevision,
      event: { eventId: 'deferred-revoke-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T20:41:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'deferred-revoke-waiting', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'deferred-revoke-waiting', type: 'vehicle.parked', timestamp: '2026-07-22T20:42:00+08:00' },
    })
    const returning = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'deferred-revoke-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'deferred-revoke-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T20:43:00+08:00' },
    })
    expect(returning.task.message.authorizationId).toBeDefined()

    const moving = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'deferred-revoke-moving', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'deferred-revoke-moving', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T20:44:00+08:00' },
    })
    const failedReset = gateway.resetTask(created.task.taskId, {
      clientRequestId: 'deferred-revoke-reset', expectedTaskRevision: moving.task.taskRevision,
    })

    expect(failedReset.task).toEqual(moving.task)
    expect(failedReset.effects).toContainEqual(expect.objectContaining({
      type: 'message.revoke-authorization', status: 'failed', errorCode: 'REVOKE_FAILED',
    }))

    const parked = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'deferred-revoke-parked', expectedTaskRevision: failedReset.task.taskRevision,
      event: { eventId: 'deferred-revoke-parked', type: 'vehicle.parked', timestamp: '2026-07-22T20:45:00+08:00' },
    })

    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(parked.effects).toEqual([expect.objectContaining({
      type: 'vehicle.revert-cabin-profile', status: 'succeeded',
    })])
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
  })

  it('keeps the original task snapshot when a later return-trip provider fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    let mediaCalls = 0
    const updateRoute = vi.fn(base['navigation.update-route'])
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'navigation.update-route': updateRoute,
        'vehicle.revert-cabin-profile': revertCabin,
        'media.play': (ctx, input) => {
          mediaCalls += 1
          if (mediaCalls === 1) return { ok: false, data: null, error: { code: 'MEDIA_UNAVAILABLE', message: 'offline', retryable: false }, meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'media.play', provider: 'fixture', durationMs: 1, generatedAt: now } }
          return base['media.play'](ctx, input)
        },
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 's', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 's' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    expect(waiting.task.phase).toBe('waiting-for-passengers')
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })
    expect(failed.task).toEqual(waiting.task)
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'media.play', status: 'failed', errorCode: 'MEDIA_UNAVAILABLE' }))
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'succeeded' }))
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'navigation.update-route.rollback', status: 'succeeded' }))
    expect(revertCabin).toHaveBeenCalledTimes(1)
    expect(updateRoute).toHaveBeenCalledTimes(2)
    expect(updateRoute).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      routeId: 'route-airport-001',
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    }))
    expect(failed.ui.components).toContainEqual(expect.objectContaining({
      type: 'status-banner',
      props: expect.objectContaining({ message: expect.stringContaining('返程操作已撤销') }),
    }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
    const retry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'o-retry', expectedTaskRevision: failed.task.taskRevision, expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'return-retry',
    })
    const duplicateRetry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'o-retry-duplicate', expectedTaskRevision: failed.task.taskRevision, expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'return-retry',
    })
    expect(mediaCalls).toBe(2)
    expect(retry.task).toMatchObject({
      phase: 'returning-home',
      passengers: { confirmedOnboard: true },
      navigation: { routeId: 'route-home-001', destination: '家', status: 'active' },
    })
    expect(retry.task.returnTrip).toMatchObject({ route: { status: 'succeeded' }, cabin: { status: 'succeeded' }, media: { status: 'succeeded' } })
    expect(retry.effects).toContainEqual(expect.objectContaining({ type: 'media.play', status: 'succeeded' }))
    expect(duplicateRetry.task).toEqual(retry.task)
    expect(duplicateRetry.effects).toEqual(retry.effects)
  })

  it('publishes remaining side effects when compensation cannot restore navigation', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const updateRoute = vi.fn((ctx: { taskId: string; requestId?: string }, input: unknown) => {
      const parsed = input as { idempotencyKey: string }
      if (parsed.idempotencyKey.endsWith(':rollback:route')) {
        return {
          ok: false as const,
          data: null,
          error: { code: 'ROLLBACK_FAILED', message: 'cannot restore route', retryable: false },
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'navigation.update-route', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
        }
      }
      return base['navigation.update-route'](ctx, input)
    })
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'navigation.update-route': updateRoute,
        'media.play': (ctx) => ({
          ok: false as const,
          data: null,
          error: { code: 'MEDIA_UNAVAILABLE', message: 'offline', retryable: false },
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'media.play', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
        }),
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'rollback-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'rollback-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'rollback-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'rollback-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'rollback-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'rollback-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })

    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'rollback-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'rollback-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })

    expect(failed.task).toMatchObject({
      phase: 'returning-home',
      passengers: { confirmedOnboard: true },
      navigation: { routeId: 'route-home-001', destination: '家', status: 'active' },
      returnTrip: { route: { status: 'succeeded' }, cabin: { status: 'pending' }, media: { status: 'failed' } },
    })
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'navigation.update-route.rollback', status: 'failed', errorCode: 'ROLLBACK_FAILED' }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
    expect(failed.ui.components).toContainEqual(expect.objectContaining({
      type: 'status-banner',
      props: expect.objectContaining({ message: expect.stringContaining('部分返程操作仍在生效') }),
    }))
  })

  it('keeps semantically invalid media output failed and retries it', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    let mediaCalls = 0
    const media = vi.fn((ctx: { taskId: string; requestId?: string }, input: unknown) => {
      mediaCalls += 1
      if (mediaCalls === 1) {
        return {
          ok: true as const,
          data: { playbackId: 'wrong-playback', title: '轻音乐', status: 'playing' as const, reversible: true as const },
          error: null,
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'media.play', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
        }
      }
      return base['media.play'](ctx, input)
    })
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, providers: { ...base, 'media.play': media } })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'invalid-media-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'invalid-media-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-media-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'invalid-media-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-media-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'invalid-media-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-media-onboard', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'invalid-media-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(failed.task.returnTrip).toMatchObject({ media: { status: 'failed', errorCode: 'PROVIDER_FAILED' } })
    const retry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'invalid-media-retry', expectedTaskRevision: failed.task.taskRevision, expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'invalid-media-retry',
    })

    expect(media).toHaveBeenCalledTimes(2)
    expect(retry.task.returnTrip?.media.status).toBe('succeeded')
  })

  it('keeps invalid cabin output failed when cabin compensation also fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const applyCabin = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: true as const,
      data: { effectId: `${ctx.taskId}:cabin:invalid`, applied: true, previous: { temperatureC: 22, fanLevel: 2 }, current: { temperatureC: 19, fanLevel: 2 }, reversible: true },
      error: null,
      meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'vehicle.apply-cabin-profile', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
    }))
    const revertCabin = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: false as const,
      data: null,
      error: { code: 'ROLLBACK_FAILED', message: 'cannot revert cabin', retryable: false },
      meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'vehicle.revert-cabin-profile', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
    }))
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.apply-cabin-profile': applyCabin, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'invalid-cabin-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'invalid-cabin-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-cabin-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'invalid-cabin-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-cabin-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'invalid-cabin-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'invalid-cabin-onboard', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'invalid-cabin-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(failed.task.returnTrip).toMatchObject({ cabin: { status: 'failed', errorCode: 'PROVIDER_FAILED' } })
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'failed', errorCode: 'ROLLBACK_FAILED' }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
  })

  it.each([
    ['navigation.update-route', 'ROUTE_PROVIDER_FAILED'],
    ['vehicle.apply-cabin-profile', 'CABIN_PROVIDER_FAILED'],
  ] as const)('does not commit onboard facts when %s fails', (tool, errorCode) => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const failedProvider = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: false as const,
      data: null,
      error: { code: errorCode, message: 'failed', retryable: false },
      meta: {
        requestId: ctx.requestId!, taskId: ctx.taskId, tool, provider: 'fixture' as const,
        durationMs: 1, generatedAt: now,
      },
    }))
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, [tool]: failedProvider },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: `s-${tool}`, expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: `s-${tool}` })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: `g-${tool}`, expectedTaskRevision: started.task.taskRevision, event: { eventId: `g-${tool}`, type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: `p-${tool}`, expectedTaskRevision: approaching.task.taskRevision, event: { eventId: `p-${tool}`, type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const event = { eventId: `onboard-${tool}`, type: 'user.confirmed-passengers-onboard' as const, timestamp: '2026-07-22T12:04:00+08:00' }

    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: `o-${tool}`, expectedTaskRevision: waiting.task.taskRevision, event })
    const duplicate = gateway.submitEvent(created.task.taskId, { clientRequestId: `o-${tool}-retry`, expectedTaskRevision: waiting.task.taskRevision, event })

    expect(failed.task).toEqual(waiting.task)
    expect(failed.effects).toContainEqual(expect.objectContaining({ tool, status: 'failed', errorCode }))
    expect(duplicate.task).toEqual(failed.task)
    expect(duplicate.ui).toEqual(failed.ui)
    expect(duplicate.effects).toEqual(failed.effects)
    expect(failedProvider).toHaveBeenCalledTimes(1)
  })

  it('keeps a retry action when return-trip preference lookup falls back', () => {
    const runtime = createSideEffectRuntime()
    const base = new ReadToolOrchestrator({ registry: createProviderRegistry(runtime) })
    let preferenceReads = 0
    const orchestrator = {
      resolveInitialPassengers: base.resolveInitialPassengers.bind(base),
      prepareTrip: base.prepareTrip.bind(base),
      resolveReturnTripPreferences: (taskId: string, requestId: string, memberIds: string[]) => {
        preferenceReads += 1
        if (preferenceReads === 1) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'preference timeout', true)
        return base.resolveReturnTripPreferences(taskId, requestId, memberIds)
      },
    }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, orchestrator })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 's', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 's' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const fallback = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(fallback.task).toEqual(waiting.task)
    expect(preferenceReads).toBe(1)
    expect(fallback.meta.fallbackUsed).toBe(true)
    expect(fallback.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))

    const retry = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'o-retry', expectedTaskRevision: fallback.task.taskRevision, expectedUiRevision: fallback.ui.uiRevision,
      actionId: 'retry-return-trip', componentId: 'return-trip-provider-fallback', idempotencyKey: 'return-retry',
    })
    expect(retry.meta.fallbackUsed).toBe(false)
    expect(retry.task.phase).toBe('returning-home')
    expect(retry.task.returnTrip?.route.status).toBe('succeeded')
  })

  it('marks a previously failed route succeeded when retry resumes later effects', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const prepared = gateway.submitEvent(created.task.taskId, { clientRequestId: 'flight', expectedTaskRevision: created.task.taskRevision, event: { eventId: 'flight', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' } })
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'start', expectedTaskRevision: prepared.task.taskRevision, expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const first = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })
    expect(first.task.returnTrip?.route.status).toBe('succeeded')
  })

  it('does not retain the outbound route when return-home address lookup fails', () => {
    const runtime = createSideEffectRuntime()
    runtime.preferences.mom = { ...runtime.preferences.mom, homeDestinationId: undefined }
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 's', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 's' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'g', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'g', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'p', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'p', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'o', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'o', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })

    expect(failed.task).toEqual(waiting.task)
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'navigation.update-route', status: 'failed', errorCode: 'PREFERENCE_UNAVAILABLE' }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-return-trip' }))
  })

  it('keeps the original snapshot and records a failed effect when navigation.start fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const startNavigation = vi.fn((ctx: { taskId: string; requestId?: string }) => ({
      ok: false,
      data: null,
      error: { code: 'PROVIDER_TIMEOUT', message: 'navigation timeout', retryable: true },
      meta: {
        requestId: ctx.requestId!,
        taskId: ctx.taskId,
        tool: 'navigation.start',
        provider: 'fixture' as const,
        durationMs: 1,
        generatedAt: '2026-07-22T12:00:00+08:00',
      },
    }))
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
      providers: { ...base, 'navigation.start': startNavigation },
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const failed = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-timeout',
    })

    expect(failed.task).toEqual(created.task)
    expect(failed.ui).toEqual(created.ui)
    expect(failed.effects).toEqual([expect.objectContaining({
      type: 'navigation.start', status: 'failed', tool: 'navigation.start', errorCode: 'PROVIDER_TIMEOUT',
    })])
    expect(gateway.getTask(created.task.taskId).task).toEqual(created.task)

    const duplicate = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation-retry',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-provider-timeout',
    })
    expect(startNavigation).toHaveBeenCalledTimes(1)
    expect(duplicate.effects).toEqual(failed.effects)
  })

  it('rejects stale and unregistered navigation actions with typed errors', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: 0,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })
    const request = {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: prepared.task.taskRevision,
      expectedUiRevision: prepared.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    }

    expect(() => gateway.submitAction(created.task.taskId, { ...request, expectedUiRevision: 0 })).toThrowError(
      expect.objectContaining({ code: 'UI_REVISION_CONFLICT' }),
    )
    expect(() => gateway.submitAction(created.task.taskId, { ...request, expectedTaskRevision: 0 })).toThrowError(
      expect.objectContaining({ code: 'TASK_REVISION_CONFLICT' }),
    )
    expect(() => gateway.submitAction(created.task.taskId, { ...request, actionId: 'unknown-action' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    )
  })

  it('does not publish or execute navigation after the flight is cancelled', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const startNavigation = vi.fn(base['navigation.start'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
      providers: { ...base, 'navigation.start': startNavigation },
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const cancelled = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-cancelled',
      expectedTaskRevision: created.task.taskRevision,
      event: {
        eventId: 'flight-cancelled',
        type: 'flight.updated',
        flight: {
          flightNumber: 'MU5102',
          status: 'cancelled',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:30:00+08:00',
          terminal: 'T2',
        },
        timestamp: '2026-07-22T12:01:00+08:00',
      },
    })

    expect(cancelled.task.flight?.status).toBe('cancelled')
    expect(cancelled.ui.actions.some((action) => action.id === 'start-navigation')).toBe(false)
    expect(() => gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-cancelled',
      expectedTaskRevision: cancelled.task.taskRevision,
      expectedUiRevision: cancelled.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'nav-cancelled',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(startNavigation).not.toHaveBeenCalled()
  })

  it('rejects externally submitted navigation events', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())
    const prepared = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight',
      expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
    })

    expect(() => gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-bypass-navigation',
      expectedTaskRevision: prepared.task.taskRevision,
      event: { eventId: 'bypass-navigation', type: 'navigation.started', routeId: 'untrusted-route', timestamp: '2026-07-22T12:02:00+08:00' },
    })).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }))

    const current = gateway.getTask(created.task.taskId).task
    expect(current).toMatchObject({ phase: 'preparing', taskRevision: prepared.task.taskRevision })
    expect(current.navigation).toMatchObject({ routeId: 'route-airport-001', status: 'planned' })
  })

  it('proposes and accepts the arrival memory update through the provider', () => {
    const runtime = createSideEffectRuntime()
    const acceptGateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime })
    const accepted = completeTask(acceptGateway)
    expect(accepted.memoryProposal).toMatchObject({ status: 'pending', memberId: 'mom' })
    expect(accepted.pendingConfirmation?.confirmationId).toBe(accepted.memoryProposal?.confirmationId)
    const acceptRequest = {
      clientRequestId: 'client-save-memory-accept',
      expectedTaskRevision: accepted.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-accept',
    } as const
    const confirmationId = accepted.pendingConfirmation!.confirmationId
    const acceptedResult = acceptGateway.submitConfirmation(accepted.taskId, confirmationId, acceptRequest)
    const acceptedRetry = acceptGateway.submitConfirmation(accepted.taskId, confirmationId, {
      ...acceptRequest,
      clientRequestId: 'client-save-memory-accept-retry',
    })

    expect(acceptedResult.task).toMatchObject({ taskRevision: accepted.taskRevision + 1, pendingConfirmation: undefined, memoryProposal: { status: 'accepted' } })
    expect(acceptedResult.effects).toEqual([expect.objectContaining({ type: 'memory.confirm-update', status: 'succeeded' })])
    expect(runtime.preferences.mom.rearTemperatureC).toBe(25)
    expect(acceptedRetry.task).toEqual(acceptedResult.task)
    expect(acceptedRetry.ui).toEqual(acceptedResult.ui)

    expect(() => acceptGateway.submitConfirmation(accepted.taskId, confirmationId, {
      ...acceptRequest,
      clientRequestId: 'client-save-memory-reject-after-accept',
      decision: 'reject',
    })).toThrowError(expect.objectContaining({ code: 'TASK_REVISION_CONFLICT' }))

    const rejectGateway = createGateway()
    const rejected = completeTask(rejectGateway)
    const rejectedResult = rejectGateway.submitConfirmation(rejected.taskId, rejected.pendingConfirmation!.confirmationId, {
      clientRequestId: 'client-save-memory-reject',
      expectedTaskRevision: rejected.taskRevision,
      decision: 'reject',
      idempotencyKey: 'save-memory-reject',
    })

    expect(rejectedResult.task).toMatchObject({ taskRevision: rejected.taskRevision + 1, pendingConfirmation: undefined, memoryProposal: { status: 'rejected' } })
    expect(rejectedResult.effects).toEqual([expect.objectContaining({ type: 'memory.reject-update', status: 'cancelled', errorCode: 'USER_REJECTED' })])
  })

  it('does not confirm an expired proposal when the gateway clock is ahead of the provider clock', () => {
    const runtime = createSideEffectRuntime(() => Date.parse('2026-07-22T12:00:00Z'))
    let gatewayNow = now
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => gatewayNow,
      createId: () => '001',
      runtime,
    })
    const completed = completeTask(gateway)
    expect(completed.pendingConfirmation?.expiresAt).toBe('2026-07-22T12:30:00.000Z')
    gatewayNow = '2026-07-22T12:31:00Z'

    const expired = gateway.submitConfirmation(completed.taskId, completed.pendingConfirmation!.confirmationId, {
      clientRequestId: 'client-save-memory-expired',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-expired',
    })

    expect(expired.task).toMatchObject({ pendingConfirmation: undefined, memoryProposal: { status: 'expired', errorCode: 'PROPOSAL_EXPIRED' } })
    expect(expired.effects).toEqual([expect.objectContaining({ type: 'memory.reject-update', status: 'failed', errorCode: 'PROPOSAL_EXPIRED' })])
    expect(runtime.preferences.mom.rearTemperatureC).toBe(25)
  })

  it('revokes rejected proposals through the injected provider runtime', () => {
    const providerRuntime = createSideEffectRuntime()
    const providers = createProviderRegistry(providerRuntime)
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', providers })
    const completed = completeTask(gateway)
    const confirmationId = completed.pendingConfirmation!.confirmationId
    const proposalId = completed.memoryProposal!.proposalId!

    gateway.submitConfirmation(completed.taskId, confirmationId, {
      clientRequestId: 'client-provider-runtime-reject',
      expectedTaskRevision: completed.taskRevision,
      decision: 'reject',
      idempotencyKey: 'provider-runtime-reject',
    })

    const retained = providers['memory.confirm-update'](
      { taskId: completed.taskId, requestId: 'stolen-confirm' },
      { proposalId, confirmationId, idempotencyKey: 'stolen-confirm' },
    )
    expect(retained.error?.code).toBe('PROPOSAL_EXPIRED')
    expect(providerRuntime.preferences.mom.rearTemperatureC).toBe(25)
  })

  it('dismisses an expired prompt when the provider already removed the proposal', () => {
    let providerNow = Date.parse('2026-07-22T12:00:00Z')
    let gatewayNow = now
    const providerRuntime = createSideEffectRuntime(() => providerNow)
    const providers = createProviderRegistry(providerRuntime)
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => gatewayNow, createId: () => '001', providers })
    const completed = completeTask(gateway)
    const confirmationId = completed.pendingConfirmation!.confirmationId
    const proposalId = completed.memoryProposal!.proposalId!

    providerNow = Date.parse('2026-07-22T12:31:00Z')
    providers['memory.confirm-update'](
      { taskId: completed.taskId, requestId: 'provider-expiry-cleanup' },
      { proposalId, confirmationId, idempotencyKey: 'provider-expiry-cleanup' },
    )
    gatewayNow = '2026-07-22T12:31:00Z'

    const expired = gateway.submitConfirmation(completed.taskId, confirmationId, {
      clientRequestId: 'client-provider-first-expiry',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'provider-first-expiry',
    })

    expect(expired.task).toMatchObject({ pendingConfirmation: undefined, memoryProposal: { status: 'expired' } })
    expect(expired.ui.actions).toEqual([])
  })

  it('preserves trusted provider context when accepting save-memory confirmation', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => '001' })
    const completed = completeTask(gateway)

    gateway.submitConfirmation(completed.taskId, completed.pendingConfirmation!.confirmationId, {
      clientRequestId: 'client-save-memory-context',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-context',
    })

    expect(store.get(completed.taskId)?.toolResults?.['navigation.plan-route']).toMatchObject({
      ok: true,
      data: { routeId: 'route-airport-001' },
    })
  })

  it('does not reuse an action result for a confirmation with the same idempotency key', () => {
    const gateway = createGateway()
    const completed = completeTask(gateway, 'shared-idempotency-key')

    const confirmed = gateway.submitConfirmation(completed.taskId, completed.pendingConfirmation!.confirmationId, {
      clientRequestId: 'client-save-memory',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'shared-idempotency-key',
    })

    expect(confirmed.task).toMatchObject({ taskRevision: completed.taskRevision + 1, pendingConfirmation: undefined, memoryProposal: { status: 'accepted' } })
  })

  it('requires a current save-memory confirmation', () => {
    const gateway = createGateway()
    const created = gateway.createTask(createRequest())

    expect(() => gateway.submitConfirmation(created.task.taskId, 'missing-confirmation', {
      clientRequestId: 'client-save-memory',
      expectedTaskRevision: created.task.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-001',
    })).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_EXPIRED' }))
  })

  it('rejects a confirmation request with the wrong confirmation id', () => {
    const gateway = createGateway()
    const completed = completeTask(gateway)

    expect(() => gateway.submitConfirmation(completed.taskId, 'wrong-confirmation', {
      clientRequestId: 'client-save-memory',
      expectedTaskRevision: completed.taskRevision,
      decision: 'accept',
      idempotencyKey: 'save-memory-wrong-confirmation',
    })).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_EXPIRED' }))
  })

  it('rejects unknown task ids', () => {
    expect(() => createGateway().getTask('missing')).toThrowError(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    )
  })

  it('retries a failed landing message through action → confirmation → send', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const prepareMessage = vi.fn(base['message.prepare'])
    const sendMessage = vi.fn(base['message.send'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
      providers: { ...base, 'message.prepare': prepareMessage, 'message.send': sendMessage },
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    })
    const landed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-landed',
      expectedTaskRevision: started.task.taskRevision,
      event: {
        eventId: 'flight-landed',
        type: 'flight.updated',
        flight: {
          flightNumber: 'MU5102',
          status: 'landed',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:40:00+08:00',
          terminal: 'T2',
        },
        timestamp: '2026-07-22T20:40:00+08:00',
      },
    })
    expect(landed.task.message).toMatchObject({ status: 'scheduled', pendingContactId: 'contact-mom' })

    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-message-failed',
      expectedTaskRevision: landed.task.taskRevision,
      event: {
        eventId: 'message-failed',
        type: 'message.failed',
        messageId: landed.task.message.pendingMessageId!,
        errorCode: 'SEND_FAILED',
        timestamp: '2026-07-22T20:41:00+08:00',
      },
    })
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({
      id: 'retry-landing-message',
      event: { type: 'tool-request', actionToken: 'pickup-001:retry-landing-message' },
    }))
    expect(failed.ui.components).toContainEqual(expect.objectContaining({
      id: 'message-preview',
      actions: ['retry-landing-message'],
    }))

    const armed = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-retry-landing',
      expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision,
      actionId: 'retry-landing-message',
      componentId: 'message-preview',
      idempotencyKey: 'retry-landing-001',
    })
    expect(armed.task.pendingConfirmation).toMatchObject({ action: 'send-message' })
    expect(armed.effects).toEqual([expect.objectContaining({
      type: 'message.prepare', status: 'pending-confirmation', tool: 'message.prepare',
    })])
    expect(prepareMessage).toHaveBeenCalledWith(
      { taskId: created.task.taskId, requestId: 'pickup-001:message.prepare:retry-landing-001' },
      { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:25' },
    )
    expect(armed.task.message).toMatchObject({
      status: 'failed',
      pendingContactId: 'contact-mom',
      idempotencyKey: 'pickup-001:MU5102:landing',
      pendingText: '我已到达机场接机点，航班 MU5102，预计 20:25 会合。',
    })
    expect(armed.ui.actions).toContainEqual(expect.objectContaining({
      id: 'confirm-retry-landing-message',
      event: {
        type: 'confirmation',
        confirmationId: armed.task.pendingConfirmation!.confirmationId,
        decision: 'accept',
      },
    }))

    const sent = gateway.submitConfirmation(
      created.task.taskId,
      armed.task.pendingConfirmation!.confirmationId,
      {
        clientRequestId: 'client-confirm-retry',
        expectedTaskRevision: armed.task.taskRevision,
        decision: 'accept',
        idempotencyKey: 'confirm-retry-001',
      },
    )
    expect(sent.task.message).toMatchObject({ status: 'sent', landingNoticeSent: true })
    expect(sent.task.pendingConfirmation).toBeUndefined()
    expect(sent.effects).toMatchObject([{ type: 'message.send', status: 'succeeded', tool: 'message.send' }])
    expect(sendMessage).toHaveBeenCalledWith(
      { taskId: created.task.taskId, requestId: 'pickup-001:message.send:confirm-retry-001' },
      expect.objectContaining({
        contactId: 'contact-mom',
        messageId: 'pickup-001:MU5102:landing',
        confirmationId: armed.task.pendingConfirmation!.confirmationId,
        idempotencyKey: 'confirm-retry-001',
      }),
    )
    expect(sent.ui.actions.some((action) => action.id === 'retry-landing-message')).toBe(false)

    const duplicate = gateway.submitConfirmation(
      created.task.taskId,
      armed.task.pendingConfirmation!.confirmationId,
      {
        clientRequestId: 'client-confirm-retry-duplicate',
        expectedTaskRevision: armed.task.taskRevision,
        decision: 'accept',
        idempotencyKey: 'confirm-retry-001',
      },
    )
    expect(duplicate.task).toEqual(sent.task)
    expect(duplicate.effects).toEqual(sent.effects)
    expect(prepareMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects a retry through the injected confirmation revoker without sending', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revoke = vi.fn(base['message.revoke-confirmation'])
    const send = vi.fn(base['message.send'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'message.revoke-confirmation': revoke, 'message.send': send },
    })
    const failed = failedLandingMessageTask(gateway)
    const armed = gateway.submitAction(failed.task.taskId, {
      clientRequestId: 'reject-retry-arm', expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision, actionId: 'retry-landing-message',
      componentId: 'message-preview', idempotencyKey: 'reject-retry-arm',
    })
    const rejected = gateway.submitConfirmation(armed.task.taskId, armed.task.pendingConfirmation!.confirmationId, {
      clientRequestId: 'reject-retry', expectedTaskRevision: armed.task.taskRevision,
      decision: 'reject', idempotencyKey: 'reject-retry',
    })
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(rejected.task.pendingConfirmation).toBeUndefined()
    expect(rejected.effects).toEqual([expect.objectContaining({
      type: 'message.revoke-confirmation', status: 'cancelled', errorCode: 'USER_REJECTED',
    })])
  })

  it('revokes an armed retry before cancelling the task', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revoke = vi.fn(base['message.revoke-confirmation'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'message.revoke-confirmation': revoke },
    })
    const failed = failedLandingMessageTask(gateway)
    const armed = gateway.submitAction(failed.task.taskId, {
      clientRequestId: 'cancel-retry-arm', expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision, actionId: 'retry-landing-message',
      componentId: 'message-preview', idempotencyKey: 'cancel-retry-arm',
    })
    const cancelled = gateway.cancelTask(armed.task.taskId, {
      clientRequestId: 'cancel-armed-retry', expectedTaskRevision: armed.task.taskRevision,
      eventId: 'cancel-armed-retry',
    })
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(cancelled.task.phase).toBe('cancelled')
    expect(cancelled.task.pendingConfirmation).toBeUndefined()
    expect(cancelled.effects).toEqual([expect.objectContaining({ type: 'message.revoke-confirmation' })])
  })

  it('revokes an armed retry before accepting a matching external message failure', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revoke = vi.fn(base['message.revoke-confirmation'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'message.revoke-confirmation': revoke },
    })
    const failed = failedLandingMessageTask(gateway)
    const armed = gateway.submitAction(failed.task.taskId, {
      clientRequestId: 'external-failure-arm', expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision, actionId: 'retry-landing-message',
      componentId: 'message-preview', idempotencyKey: 'external-failure-arm',
    })
    const afterFailure = gateway.submitEvent(armed.task.taskId, {
      clientRequestId: 'external-failure', expectedTaskRevision: armed.task.taskRevision,
      event: {
        eventId: 'external-failure', type: 'message.failed',
        messageId: armed.task.message.pendingMessageId!, errorCode: 'SEND_FAILED',
        timestamp: '2026-07-22T20:42:00+08:00',
      },
    })
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(afterFailure.task.pendingConfirmation).toBeUndefined()
    expect(afterFailure.task.message.pendingMessageId).toBeUndefined()
    expect(afterFailure.effects).toEqual([expect.objectContaining({ type: 'message.revoke-confirmation' })])
  })

  it('keeps an armed retry when provider revocation fails during reset', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'message.revoke-confirmation': (ctx) => ({
          ok: false, data: null,
          error: { code: 'REVOKE_FAILED', message: 'failed', retryable: true },
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'message.revoke-confirmation', provider: 'fixture', durationMs: 1, generatedAt: now },
        }),
      },
    })
    const failed = failedLandingMessageTask(gateway)
    const armed = gateway.submitAction(failed.task.taskId, {
      clientRequestId: 'reset-retry-arm', expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision, actionId: 'retry-landing-message',
      componentId: 'message-preview', idempotencyKey: 'reset-retry-arm',
    })
    const reset = gateway.resetTask(armed.task.taskId, {
      clientRequestId: 'reset-armed-retry', expectedTaskRevision: armed.task.taskRevision,
    })
    expect(reset.task).toEqual(armed.task)
    expect(reset.effects).toEqual([expect.objectContaining({
      type: 'message.revoke-confirmation', status: 'failed', errorCode: 'REVOKE_FAILED',
    })])
  })

  it('preserves the failed retry snapshot when message.prepare returns invalid metadata', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revoke = vi.fn(base['message.revoke-confirmation'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'message.prepare': (ctx, input) => {
          const result = base['message.prepare'](ctx, input)
          return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
        },
        'message.revoke-confirmation': revoke,
      },
    })
    const failed = failedLandingMessageTask(gateway)
    const retry = gateway.submitAction(failed.task.taskId, {
      clientRequestId: 'invalid-prepare-retry', expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision, actionId: 'retry-landing-message',
      componentId: 'message-preview', idempotencyKey: 'invalid-prepare-retry',
    })
    expect(retry.task).toEqual(failed.task)
    expect(retry.ui).toEqual(failed.ui)
    expect(retry.effects).toEqual([expect.objectContaining({
      type: 'message.prepare', status: 'failed', errorCode: 'PROVIDER_FAILED',
    })])
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('fails closed when direct Gateway providers do not match the configured mode', () => {
    const runtime = createSideEffectRuntime()
    const fixtureProviders = createProviderRegistry(runtime, 'fixture')
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      mode: 'live', providers: fixtureProviders,
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    expect(created.meta).toMatchObject({ mode: 'live', fallbackUsed: true })
    expect(created.task.phase).toBe('preparing')
  })

  it('executes the scheduled landing message before committing the sent state', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const sendMessage = vi.fn(base['message.send'])
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, providers: { ...base, 'message.send': sendMessage } })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'message-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'message-nav',
    })
    const landed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'message-landed', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'message-landed-event', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' },
    })
    expect(landed.task.message).toMatchObject({ status: 'scheduled', authorizationId: expect.stringMatching(/^cnf_/) })

    const sent = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'message-sent', expectedTaskRevision: landed.task.taskRevision,
      event: { eventId: 'message-sent-event', type: 'message.sent', messageId: landed.task.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' },
    })
    const duplicate = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'message-sent-retry', expectedTaskRevision: landed.task.taskRevision,
      event: { eventId: 'message-sent-event', type: 'message.sent', messageId: landed.task.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' },
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sent.task.message).toMatchObject({ status: 'sent', landingNoticeSent: true, authorizationId: undefined })
    expect(sent.effects).toEqual([expect.objectContaining({ type: 'message.send', status: 'succeeded' })])
    expect(duplicate.task).toEqual(sent.task)
  })

  it('reconciles a successful landing send with invalid response metadata as failed and non-retryable', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'message.send': (ctx, input) => {
          const result = base['message.send'](ctx, input)
          return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
        },
      },
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'ambiguous-send-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'ambiguous-send-start' })
    const landed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'ambiguous-send-landed', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'ambiguous-send-landed', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' } })

    const sent = gateway.submitEvent(created.task.taskId, { clientRequestId: 'ambiguous-send', expectedTaskRevision: landed.task.taskRevision, event: { eventId: 'ambiguous-send', type: 'message.sent', messageId: landed.task.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' } })

    expect(sent.task.message).toMatchObject({ status: 'failed', landingNoticeSent: false, authorizationId: undefined, pendingMessageId: undefined })
    expect(sent.effects).toEqual([
      expect.objectContaining({ type: 'message.send', status: 'failed', errorCode: 'PROVIDER_FAILED' }),
      expect.objectContaining({ type: 'message.revoke-authorization' }),
    ])
  })

  it('executes a later cabin-preference request through the provider and replays the first receipt', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const applyCabin = vi.fn(base['vehicle.apply-cabin-profile'])
    const revertCabin = vi.fn(base['vehicle.revert-cabin-profile'])
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({
      store, now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'vehicle.apply-cabin-profile': applyCabin, 'vehicle.revert-cabin-profile': revertCabin },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'later-cabin-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'later-cabin-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'later-cabin-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'later-cabin-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'later-cabin-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'later-cabin-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const returning = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'later-cabin-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'later-cabin-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })
    const returningStored = store.get(created.task.taskId)!
    const activeCabin = returningStored.effectReceipts?.activeCabin
    store.save({
      ...returningStored,
      task: {
        ...returningStored.task,
        returnTrip: returningStored.task.returnTrip
          ? { ...returningStored.task.returnTrip, cabin: { status: 'failed', errorCode: 'APPLY_FAILED' } }
          : undefined,
      },
      effectReceipts: activeCabin
        ? { activeCabin: { ...activeCabin, state: 'reverted' } }
        : undefined,
    })
    applyCabin.mockClear()

    const applied = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'later-cabin-input', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'later-cabin-input', type: 'user.input', text: '应用家庭座舱偏好', timestamp: '2026-07-22T12:05:00+08:00' },
    })
    const duplicate = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'later-cabin-replay', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'later-cabin-input', type: 'user.input', text: '应用家庭座舱偏好', timestamp: '2026-07-22T12:05:00+08:00' },
    })

    expect(applyCabin).toHaveBeenCalledTimes(1)
    expect(revertCabin).not.toHaveBeenCalled()
    expect(applied.effects).toEqual([expect.objectContaining({ type: 'vehicle.apply-cabin-profile', status: 'succeeded' })])
    expect(applied.task.returnTrip?.cabin).toEqual({ status: 'succeeded', revert: { status: 'available' } })
    expect(duplicate.task).toEqual(applied.task)
    expect(duplicate.effects).toEqual(applied.effects)
  })

  it('undoes a replacement cabin profile back to the pre-task baseline', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: base,
    })
    const returning = returningTask(gateway)

    const replaced = gateway.submitEvent(returning.task.taskId, {
      clientRequestId: 'replace-cabin-input', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'replace-cabin-input', type: 'user.input', text: '应用家庭座舱偏好', timestamp: '2026-07-22T12:05:00+08:00' },
    })
    const reverted = gateway.submitAction(replaced.task.taskId, {
      clientRequestId: 'replace-cabin-undo', expectedTaskRevision: replaced.task.taskRevision,
      expectedUiRevision: replaced.ui.uiRevision, actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile', idempotencyKey: 'replace-cabin-undo',
    })

    expect(reverted.task.returnTrip?.cabin.revert).toEqual({ status: 'succeeded' })
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
    expect(runtime.cabinCurrent.mediaTitle).toBeUndefined()
  })

  it('resolves a failed cabin undo before applying a replacement profile', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    let revertCalls = 0
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'vehicle.revert-cabin-profile': (context, input) => {
          revertCalls += 1
          if (revertCalls === 1) {
            return {
              ok: false as const,
              data: null,
              error: { code: 'REVERT_FAILED', message: 'offline', retryable: true },
              meta: { requestId: context.requestId!, taskId: context.taskId, tool: 'vehicle.revert-cabin-profile', provider: 'fixture' as const, durationMs: 1, generatedAt: now },
            }
          }
          return base['vehicle.revert-cabin-profile'](context, input)
        },
      },
    })
    const returning = returningTask(gateway)
    const failedUndo = gateway.submitAction(returning.task.taskId, {
      clientRequestId: 'failed-revert', expectedTaskRevision: returning.task.taskRevision,
      expectedUiRevision: returning.ui.uiRevision, actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile', idempotencyKey: 'failed-revert',
    })
    expect(failedUndo.task.returnTrip?.cabin.revert).toEqual({ status: 'failed', errorCode: 'REVERT_FAILED' })

    const replaced = gateway.submitEvent(failedUndo.task.taskId, {
      clientRequestId: 'replace-after-failed-revert', expectedTaskRevision: failedUndo.task.taskRevision,
      event: { eventId: 'replace-after-failed-revert', type: 'user.input', text: '应用家庭座舱偏好', timestamp: '2026-07-22T12:05:00+08:00' },
    })
    const reverted = gateway.submitAction(replaced.task.taskId, {
      clientRequestId: 'replace-after-failed-revert-undo', expectedTaskRevision: replaced.task.taskRevision,
      expectedUiRevision: replaced.ui.uiRevision, actionId: 'revert-cabin-profile',
      componentId: 'cabin-profile', idempotencyKey: 'replace-after-failed-revert-undo',
    })

    expect(revertCalls).toBe(3)
    expect(replaced.effects).toEqual([
      expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'succeeded' }),
      expect.objectContaining({ type: 'vehicle.apply-cabin-profile', status: 'succeeded' }),
    ])
    expect(reverted.task.returnTrip?.cabin.revert).toEqual({ status: 'succeeded' })
    expect(runtime.cabinCurrent.temperatureC).toBe(22)
    expect(runtime.cabinCurrent.mediaTitle).toBeUndefined()
  })

  it('marks unavailable cabin and media preferences as skipped after a successful return route', () => {
    const runtime = createSideEffectRuntime()
    runtime.preferences.mom = {
      ...runtime.preferences.mom,
      rearTemperatureC: undefined,
    }
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: createProviderRegistry(runtime),
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'skipped-return-start', expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan',
      idempotencyKey: 'skipped-return-start',
    })
    const approaching = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'skipped-return-geofence', expectedTaskRevision: started.task.taskRevision,
      event: { eventId: 'skipped-return-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    const waiting = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'skipped-return-parked', expectedTaskRevision: approaching.task.taskRevision,
      event: { eventId: 'skipped-return-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
    })
    const returning = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'skipped-return-onboard', expectedTaskRevision: waiting.task.taskRevision,
      event: { eventId: 'skipped-return-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
    })

    expect(returning.task.returnTrip).toMatchObject({
      route: { status: 'succeeded' }, cabin: { status: 'skipped' }, media: { status: 'skipped' },
    })
    expect(returning.ui.actions.some((action) => action.id === 'retry-return-trip')).toBe(false)
  })

  it('preserves the returning-home snapshot when a later cabin provider fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    let failCabin = false
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'vehicle.apply-cabin-profile': (ctx, input) => failCabin
          ? { ok: false, data: null, error: { code: 'APPLY_FAILED', message: 'offline', retryable: true }, meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'vehicle.apply-cabin-profile', provider: 'fixture', durationMs: 1, generatedAt: now } }
          : base['vehicle.apply-cabin-profile'](ctx, input),
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'fail-cabin-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'fail-cabin-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'fail-cabin-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'fail-cabin-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'fail-cabin-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'fail-cabin-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const returning = gateway.submitEvent(created.task.taskId, { clientRequestId: 'fail-cabin-onboard', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'fail-cabin-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })
    failCabin = true

    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'fail-cabin-input', expectedTaskRevision: returning.task.taskRevision,
      event: { eventId: 'fail-cabin-input', type: 'user.input', text: '应用家庭座舱偏好', timestamp: '2026-07-22T12:05:00+08:00' },
    })

    expect(failed.task).toEqual({
      ...returning.task,
      taskRevision: returning.task.taskRevision + 1,
      uiRevision: failed.task.uiRevision,
      returnTrip: returning.task.returnTrip
        ? { ...returning.task.returnTrip, cabin: { ...returning.task.returnTrip.cabin, revert: { status: 'succeeded' } } }
        : undefined,
    })
    expect(failed.task.uiRevision).toBeGreaterThan(returning.task.uiRevision)
    expect(failed.effects).toEqual([
      expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'succeeded' }),
      expect.objectContaining({ type: 'vehicle.apply-cabin-profile', status: 'failed', errorCode: 'APPLY_FAILED' }),
    ])
    expect(failed.meta.fallbackUsed).toBe(true)
  })

  it('publishes truthful residual cabin state when compensation fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    let customFailure = false
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'vehicle.apply-cabin-profile': (ctx, input) => {
          const result = base['vehicle.apply-cabin-profile'](ctx, input)
          return customFailure && result.ok && result.data
            ? { ...result, data: { ...result.data, current: { ...result.data.current, temperatureC: 24 } } }
            : result
        },
        'vehicle.revert-cabin-profile': (ctx) => ({
          ok: false, data: null, error: { code: 'REVERT_FAILED', message: 'offline', retryable: true },
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'vehicle.revert-cabin-profile', provider: 'fixture', durationMs: 1, generatedAt: now },
        }),
      },
    })
    const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'residual-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'residual-start' })
    const approaching = gateway.submitEvent(created.task.taskId, { clientRequestId: 'residual-geofence', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'residual-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' } })
    const waiting = gateway.submitEvent(created.task.taskId, { clientRequestId: 'residual-parked', expectedTaskRevision: approaching.task.taskRevision, event: { eventId: 'residual-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' } })
    const returning = gateway.submitEvent(created.task.taskId, { clientRequestId: 'residual-onboard', expectedTaskRevision: waiting.task.taskRevision, event: { eventId: 'residual-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' } })
    customFailure = true
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'residual-input', expectedTaskRevision: returning.task.taskRevision, event: { eventId: 'residual-input', type: 'user.input', text: '应用家庭座舱偏好', timestamp: '2026-07-22T12:05:00+08:00' } })

    expect(failed.task.returnTrip?.cabin).toEqual({ status: 'succeeded', revert: { status: 'available' } })
    expect(failed.effects).toContainEqual(expect.objectContaining({ type: 'vehicle.revert-cabin-profile', status: 'failed' }))
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'revert-cabin-profile' }))
    expect(failed.ui.components).toContainEqual(expect.objectContaining({
      id: 'cabin-profile', actions: ['revert-cabin-profile'],
    }))
    expect(failed.meta.fallbackUsed).toBe(false)
  })

  it('keeps the scheduled snapshot when the landing message provider fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'message.send': (ctx) => ({ ok: false as const, data: null, error: { code: 'SEND_FAILED', message: 'failed', retryable: false }, meta: { taskId: ctx.taskId, tool: 'message.send', requestId: ctx.requestId ?? `${ctx.taskId}:message.send`, provider: 'fixture' as const, durationMs: 1, generatedAt: now } }) },
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'failed-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'failed-nav' })
    const landed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'failed-landed', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'failed-landed-event', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' } })
    const failed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'failed-sent', expectedTaskRevision: landed.task.taskRevision, event: { eventId: 'failed-sent-event', type: 'message.sent', messageId: landed.task.message.pendingMessageId!, timestamp: '2026-07-22T20:41:00+08:00' } })
    expect(failed.task.message).toMatchObject({ status: 'failed', pendingContactId: 'contact-mom', pendingMessageId: undefined, authorizationId: undefined })
    expect(failed.ui.actions).toContainEqual(expect.objectContaining({ id: 'retry-landing-message' }))
    expect(failed.effects).toEqual([
      expect.objectContaining({ type: 'message.send', status: 'failed', errorCode: 'SEND_FAILED' }),
      expect.objectContaining({ type: 'message.revoke-authorization', status: 'cancelled' }),
    ])
  })

  it('revokes an armed retry before accepting a cancelled flight update', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revoke = vi.fn(base['message.revoke-confirmation'])
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, providers: { ...base, 'message.revoke-confirmation': revoke } })
    const failed = failedLandingMessageTask(gateway)
    const armed = gateway.submitAction(failed.task.taskId, {
      clientRequestId: 'cancel-flight-arm', expectedTaskRevision: failed.task.taskRevision,
      expectedUiRevision: failed.ui.uiRevision, actionId: 'retry-landing-message', componentId: 'message-preview',
      idempotencyKey: 'cancel-flight-arm',
    })
    const cancelled = gateway.submitEvent(armed.task.taskId, {
      clientRequestId: 'cancel-flight-event', expectedTaskRevision: armed.task.taskRevision,
      event: {
        eventId: 'cancel-flight-event', type: 'flight.updated',
        flight: { flightNumber: 'MU5102', status: 'cancelled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
        timestamp: '2026-07-22T20:42:00+08:00',
      },
    })
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(cancelled.task.pendingConfirmation).toBeUndefined()
    expect(cancelled.task.flight?.status).toBe('cancelled')
    expect(cancelled.effects).toEqual([expect.objectContaining({ type: 'message.revoke-confirmation', status: 'cancelled' })])
  })

  it('revokes scheduled auto-notify authorization before cancelling the task', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const revoke = vi.fn(base['message.revoke-authorization'])
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: { ...base, 'message.revoke-authorization': revoke },
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'revoke-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'revoke-start' })
    const landed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'revoke-landed', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'revoke-landed', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' } })
    const authorizationId = landed.task.message.authorizationId!
    const payload = {
      contactId: landed.task.message.pendingContactId!,
      messageId: landed.task.message.pendingMessageId!,
      text: `我已到达机场接机点，航班 MU5102，预计 ${landed.task.navigation!.eta} 会合。`,
    }

    const cancelled = gateway.cancelTask(created.task.taskId, {
      clientRequestId: 'revoke-cancel', expectedTaskRevision: landed.task.taskRevision, eventId: 'revoke-cancel',
    })

    expect(revoke).toHaveBeenCalledTimes(1)
    expect(cancelled.task.phase).toBe('cancelled')
    expect(cancelled.effects).toEqual([expect.objectContaining({ type: 'message.revoke-authorization', status: 'cancelled' })])
    expect(base['message.send']({ taskId: created.task.taskId }, { ...payload, authorizationId, idempotencyKey: 'stale-after-cancel' }).error?.code)
      .toBe('AUTHORIZATION_REQUIRED')
  })

  it.each([
    ['task cancellation', () => ({ eventId: 'stale-terminal-cancel', type: 'user.cancelled-task' as const, reason: 'old client', timestamp: '2026-07-22T20:39:00+08:00' })],
    ['flight cancellation', () => ({ eventId: 'stale-terminal-flight', type: 'flight.updated' as const, flight: { flightNumber: 'MU5102', status: 'cancelled' as const, scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:39:00+08:00' })],
    ['message failure', (messageId: string) => ({ eventId: 'stale-terminal-message', type: 'message.failed' as const, messageId, errorCode: 'SEND_FAILED', timestamp: '2026-07-22T20:39:00+08:00' })],
  ])('does not consume a scheduled authorization for a stale %s event', (_name, staleEvent) => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({ store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime, providers: base })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'stale-terminal-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'stale-terminal-start' })
    const landed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'stale-terminal-landed', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'stale-terminal-landed', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' } })
    const authorizationId = landed.task.message.authorizationId!

    const stale = gateway.submitEvent(created.task.taskId, { clientRequestId: `client-${staleEvent(landed.task.message.pendingMessageId!).eventId}`, expectedTaskRevision: landed.task.taskRevision, event: staleEvent(landed.task.message.pendingMessageId!) })

    expect(stale.task).toEqual(landed.task)
    expect(stale.effects).toEqual([])
    expect(base['message.send']({ taskId: created.task.taskId }, {
      contactId: landed.task.message.pendingContactId!, messageId: landed.task.message.pendingMessageId!,
      text: `我已到达机场接机点，航班 MU5102，预计 ${landed.task.navigation!.eta} 会合。`,
      authorizationId, idempotencyKey: 'stale-terminal-send',
    }).ok).toBe(true)
  })

  it('reconciles task state when authorization revocation succeeds with invalid metadata', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'message.revoke-authorization': (ctx, input) => {
          const result = base['message.revoke-authorization'](ctx, input)
          return { ...result, meta: { ...result.meta, requestId: 'wrong-request' } }
        },
      },
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'ambiguous-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'ambiguous-start' })
    const landed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'ambiguous-landed', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'ambiguous-landed', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' } })
    const authorizationId = landed.task.message.authorizationId!

    const failed = gateway.cancelTask(created.task.taskId, { clientRequestId: 'ambiguous-cancel', expectedTaskRevision: landed.task.taskRevision, eventId: 'ambiguous-cancel' })

    expect(failed.task.phase).toBe(landed.task.phase)
    expect(failed.task.message.authorizationId).toBeUndefined()
    expect(failed.effects).toEqual([expect.objectContaining({ type: 'message.revoke-authorization', status: 'failed', errorCode: 'PROVIDER_FAILED' })])
    expect(base['message.send']({ taskId: created.task.taskId }, { contactId: landed.task.message.pendingContactId!, messageId: landed.task.message.pendingMessageId!, text: `我已到达机场接机点，航班 MU5102，预计 ${landed.task.navigation!.eta} 会合。`, authorizationId, idempotencyKey: 'ambiguous-stale-send' }).error?.code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('keeps the scheduled snapshot when authorization revocation fails', () => {
    const runtime = createSideEffectRuntime()
    const base = createProviderRegistry(runtime)
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(), now: () => now, createId: () => '001', runtime,
      providers: {
        ...base,
        'message.revoke-authorization': (ctx) => ({
          ok: false, data: null, error: { code: 'REVOKE_FAILED', message: 'offline', retryable: true },
          meta: { requestId: ctx.requestId!, taskId: ctx.taskId, tool: 'message.revoke-authorization', provider: 'fixture', durationMs: 1, generatedAt: now },
        }),
      },
    })
    const created = gateway.createTask(createRequest('接妈妈，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, { clientRequestId: 'revoke-fail-start', expectedTaskRevision: created.task.taskRevision, expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: 'revoke-fail-start' })
    const landed = gateway.submitEvent(created.task.taskId, { clientRequestId: 'revoke-fail-landed', expectedTaskRevision: started.task.taskRevision, event: { eventId: 'revoke-fail-landed', type: 'flight.updated', flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' }, timestamp: '2026-07-22T20:40:00+08:00' } })

    const failed = gateway.cancelTask(created.task.taskId, { clientRequestId: 'revoke-fail-cancel', expectedTaskRevision: landed.task.taskRevision, eventId: 'revoke-fail-cancel' })
    const duplicate = gateway.cancelTask(created.task.taskId, { clientRequestId: 'revoke-fail-cancel-retry', expectedTaskRevision: landed.task.taskRevision, eventId: 'revoke-fail-cancel' })

    expect(failed.task).toEqual(landed.task)
    expect(failed.effects).toEqual([expect.objectContaining({ type: 'message.revoke-authorization', status: 'failed', errorCode: 'REVOKE_FAILED' })])
    expect(duplicate.effects).toEqual(failed.effects)
  })

  it('hides retry and surfaces unavailable UI when failed notify has no authorized contact', () => {
    const runtime = createSideEffectRuntime()
    const gateway = new AgentGateway({
      store: new MemoryTaskStore(),
      now: () => now,
      createId: () => '001',
      runtime,
    })
    const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆，航班 MU5102'))
    const started = gateway.submitAction(created.task.taskId, {
      clientRequestId: 'client-start-navigation',
      expectedTaskRevision: created.task.taskRevision,
      expectedUiRevision: created.ui.uiRevision,
      actionId: 'start-navigation',
      componentId: 'navigation-plan',
      idempotencyKey: 'start-navigation-001',
    })
    const landed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-flight-landed',
      expectedTaskRevision: started.task.taskRevision,
      event: {
        eventId: 'flight-landed',
        type: 'flight.updated',
        flight: {
          flightNumber: 'MU5102',
          status: 'landed',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:40:00+08:00',
          terminal: 'T2',
        },
        timestamp: '2026-07-22T20:40:00+08:00',
      },
    })
    const failed = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-message-failed',
      expectedTaskRevision: landed.task.taskRevision,
      event: {
        eventId: 'message-failed',
        type: 'message.failed',
        messageId: landed.task.message.pendingMessageId!,
        errorCode: 'SEND_FAILED',
        timestamp: '2026-07-22T20:41:00+08:00',
      },
    })
    expect(failed.ui.actions.some((action) => action.id === 'retry-landing-message')).toBe(true)

    // Revoke authorization after failure; next publish must not keep a dead retry button.
    runtime.preferences.mom = { ...runtime.preferences.mom, landingNotificationAuthorized: false }
    const view = gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'client-auth-revoked-view',
      expectedTaskRevision: failed.task.taskRevision,
      event: {
        eventId: 'timeout-after-revoke',
        type: 'provider.timeout',
        provider: 'flight',
        timestamp: '2026-07-22T20:41:30+08:00',
      },
    })
    expect(view.ui.actions.some((action) => action.id === 'retry-landing-message')).toBe(false)
    expect(view.ui.components).toContainEqual(expect.objectContaining({
      type: 'status-banner',
      props: {
        level: 'error',
        title: '无法重试发送',
        message: '没有已授权的落地通知联系人',
      },
    }))
  })

  describe('check-weather query turn', () => {
    it('answers with a transient weather card that yields the surface on the next event', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      expect(created.task.phase).toBe('preparing')
      expect(created.ui.components.some((component) => component.type === 'schedule-strip')).toBe(true)

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'weather-1', type: 'user.input', text: '到的时候天气怎么样', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // The query changed no task fact, only the composed surface.
      expect(asked.task.taskRevision).toBe(created.task.taskRevision)
      expect(asked.task.processedEventIds).not.toContain('weather-1')
      expect(asked.ui.uiRevision).toBeGreaterThan(created.ui.uiRevision)
      const card = asked.ui.components.find((component) => component.type === 'weather-card')
      expect(card).toMatchObject({
        props: expect.objectContaining({ location: '虹桥机场 T2', condition: 'light-rain' }),
      })
      // preparing already runs at the four-card budget: the strip yields its slot.
      expect(asked.ui.components.some((component) => component.type === 'schedule-strip')).toBe(false)
      expect(asked.ui.components).toHaveLength(created.ui.components.length)
      expect(asked.assistant).toMatchObject({ shouldSpeak: true })
      expect(asked.assistant?.text).toContain('虹桥机场')

      // The next accepted event recomposes without the reading: the card is gone
      // and the schedule strip returns.
      const moved = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-after-weather', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'moving-after-weather', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:02:00+08:00' },
      })
      expect(moved.ui.components.some((component) => component.type === 'weather-card')).toBe(false)
      expect(moved.ui.components.some((component) => component.type === 'schedule-strip')).toBe(true)
    })

    it('moves the turn forward on the update stream without leaving the reading on it', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const before = gateway.getTaskUpdates(created.task.taskId).latestCursor

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather-sse', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'weather-sse', type: 'user.input', text: '看下天气', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // The turn happened, so the stream moves: the revision the asking client is
      // now holding is the revision the stream reports, and its next action lines
      // up with the store.
      const read = gateway.getTaskUpdates(created.task.taskId, before)
      expect(read.updates.length).toBeGreaterThan(0)
      const latest = read.updates.at(-1)?.snapshot
      expect(latest?.ui.uiRevision).toBe(asked.ui.uiRevision)

      // But the reading itself is not trip state, and the durable snapshot is what
      // a reconnect and a replayed no-op event both read. Leaving the card there
      // means a driver who comes back an hour later is shown an hour-old sky. The
      // answer rides the response that was asked for; the stream keeps the trip.
      expect(latest?.ui.components.some((component) => component.type === 'weather-card')).toBe(false)
      expect(asked.ui.components.some((component) => component.type === 'weather-card')).toBe(true)
    })

    it('replays an identical weather event id idempotently', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const request = {
        clientRequestId: 'client-weather-replay', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'weather-replay', type: 'user.input' as const, text: '看下天气', timestamp: '2026-07-22T12:01:00+08:00' },
      }

      const first = gateway.submitEvent(created.task.taskId, request)
      const second = gateway.submitEvent(created.task.taskId, request)

      // A retry that lands while the trip is where it was gets the response it
      // lost, whole — snapshot, card, and spoken line — and does not move the
      // revision a second time.
      expect(second.task).toEqual(first.task)
      expect(second.ui).toEqual(first.ui)
      expect(second.assistant).toEqual(first.assistant)
      expect(second.ui.components.some((component) => component.type === 'weather-card')).toBe(true)
    })

    it('lets an ordinary event through even when its id is spelled like a side-answer key', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather-keyspace', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'weather-keyspace', type: 'user.input', text: '看下天气', timestamp: '2026-07-22T12:01:00+08:00' },
      })
      expect(asked.ui.components.some((component) => component.type === 'weather-card')).toBe(true)

      // Side answers live in the gateway's own operation keyspace, so no event id a
      // client can spell reaches them. This one is named after the recorded answer
      // on purpose and is still executed as the event it is.
      const moved = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-collision', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'side-answer:weather-keyspace', type: 'provider.timeout', provider: 'flight.get-status', timestamp: '2026-07-22T12:02:00+08:00' },
      })
      expect(moved.task.processedEventIds).toContain('side-answer:weather-keyspace')
      expect(moved.ui.components.some((component) => component.type === 'weather-card')).toBe(false)
    })

    it('answers a duplicate afresh once another side answer has published over it', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const weather = {
        clientRequestId: 'client-weather-then-schedule', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'weather-then-schedule', type: 'user.input' as const, text: '看下天气', timestamp: '2026-07-22T12:01:00+08:00' },
      }
      const asked = gateway.submitEvent(created.task.taskId, weather)
      expect(asked.ui.components.some((component) => component.type === 'weather-card')).toBe(true)

      const schedule = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-schedule-after-weather', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'schedule-after-weather', type: 'user.input', text: '看看日程', timestamp: '2026-07-22T12:02:00+08:00' },
      })
      expect(schedule.ui.components.some((component) => component.type === 'schedule-card')).toBe(true)

      // A side answer leaves the task revision alone, so only the UI revision says
      // the weather card has been published over. Replaying it here would hand the
      // client a snapshot older than the one it is already showing.
      const retry = { ...weather, expectedTaskRevision: schedule.task.taskRevision }
      expect(gateway.userInputPlanningState(created.task.taskId, retry)).toBeDefined()

      const late = gateway.submitEvent(created.task.taskId, retry)
      expect(late.ui.uiRevision).toBeGreaterThan(schedule.ui.uiRevision)
      expect(late.ui.components.some((component) => component.type === 'schedule-card')).toBe(false)
      expect(late.ui.components.some((component) => component.type === 'weather-card')).toBe(true)
    })

    it('degrades to a spoken notice on the unchanged snapshot when the weather read fails', () => {
      const orchestrator = new ReadToolOrchestrator()
      const failing: ReadToolOrchestration = {
        resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
        prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
        resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        resolveWeather: () => {
          throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'weather provider timed out', true)
        },
      }
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator: failing,
      })
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather-fail', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'weather-fail', type: 'user.input', text: '看下天气', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task).toEqual(created.task)
      expect(asked.ui.uiRevision).toBe(created.ui.uiRevision)
      expect(asked.ui.meta.generatedBy).not.toBe('fallback')
      expect(asked.assistant?.text).toContain('天气服务暂时不可用')
    })

    it('degrades the same way when the orchestration offers no weather read at all', () => {
      const orchestrator = new ReadToolOrchestrator()
      const withoutWeather: ReadToolOrchestration = {
        resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
        prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
        resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
      }
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator: withoutWeather,
      })
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather-none', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'weather-none', type: 'user.input', text: '看下天气', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task).toEqual(created.task)
      expect(asked.assistant?.text).toContain('天气服务暂时不可用')
    })

    it('leaves terminal tasks on the ordinary event path', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const cancelled = gateway.cancelTask(created.task.taskId, {
        clientRequestId: 'client-cancel-for-weather', expectedTaskRevision: created.task.taskRevision,
        eventId: 'cancel-for-weather',
      })

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather-terminal', expectedTaskRevision: cancelled.task.taskRevision,
        event: { eventId: 'weather-terminal', type: 'user.input', text: '看下天气', timestamp: '2026-07-22T12:10:00+08:00' },
      })

      expect(asked.ui.components.some((component) => component.type === 'weather-card')).toBe(false)
      expect(asked.task.phase).toBe('cancelled')
    })

    it('asks about home, in the present tense, once the passengers are onboard', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const started = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'weather-home-start', expectedTaskRevision: created.task.taskRevision,
        expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation',
        componentId: 'navigation-plan', idempotencyKey: 'weather-home-start',
      })
      const approaching = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'weather-home-geofence', expectedTaskRevision: started.task.taskRevision,
        event: { eventId: 'weather-home-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T20:50:00+08:00' },
      })
      const waiting = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'weather-home-parked', expectedTaskRevision: approaching.task.taskRevision,
        event: { eventId: 'weather-home-parked', type: 'vehicle.parked', timestamp: '2026-07-22T20:52:00+08:00' },
      })
      const returning = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'weather-home-onboard', expectedTaskRevision: waiting.task.taskRevision,
        event: { eventId: 'weather-home-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T20:54:00+08:00' },
      })
      expect(returning.task.passengers.confirmedOnboard).toBe(true)

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather-home', expectedTaskRevision: returning.task.taskRevision,
        event: { eventId: 'weather-home', type: 'user.input', text: '看下天气', timestamp: '2026-07-22T20:55:00+08:00' },
      })

      // The trip is routing home now: the airport stored at create time is the
      // wrong place, the landed flight's arrival the wrong moment, and the
      // wait-indoors advisory the wrong advice with everyone already in the car.
      const card = asked.ui.components.find((component) => component.type === 'weather-card')
      if (card?.type !== 'weather-card') throw new Error('expected a weather-card component')
      expect(card.props.location).toBe('家')
      expect(card.props.timeLabel).toBe('现在')
      expect(card.props.advisory).toBeUndefined()
      expect(asked.assistant?.text).toContain('家')
      expect(asked.task.taskRevision).toBe(returning.task.taskRevision)
    })

    it('resolves the weather for a non-default home destination on the return trip', () => {
      // The fixture route table only knows the default home, so the non-default
      // destination is injected as stored task state: what is under test is that
      // the weather query reads the return trip's own destination, not how that
      // destination got there.
      const store = new MemoryTaskStore()
      const orchestrator = new ReadToolOrchestrator()
      const weatherInputs: Array<{ locationId: string; at?: string }> = []
      const stubbed: ReadToolOrchestration = {
        resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
        prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
        resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        resolveWeather: (taskId, requestId, input) => {
          weatherInputs.push(input)
          return orchestrator.resolveWeather(taskId, requestId, { locationId: 'destination-home' })
        },
      }
      const gateway = new AgentGateway({
        store, now: () => now, createId: () => '001', orchestrator: stubbed,
      })
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const stored = store.get(created.task.taskId)!
      store.save({
        ...stored,
        task: {
          ...stored.task,
          phase: 'returning-home',
          passengers: { ...stored.task.passengers, confirmedOnboard: true },
          returnTrip: {
            workflowId: 'wf-grandma',
            homeDestinationId: 'destination-grandma',
            route: { status: 'succeeded', routeId: 'route-grandma', eta: '2026-07-22T21:20:00+08:00' },
            cabin: { status: 'skipped' },
            media: { status: 'skipped' },
          },
          navigation: { routeId: 'route-grandma', destination: '外婆家', eta: '2026-07-22T21:20:00+08:00', status: 'active' },
        },
      })

      gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-weather-grandma',
        expectedTaskRevision: stored.task.taskRevision,
        event: { eventId: 'weather-grandma', type: 'user.input', text: '看下天气', timestamp: '2026-07-22T20:55:00+08:00' },
      })

      expect(weatherInputs).toEqual([{ locationId: 'destination-grandma' }])
    })
  })

  describe('check-schedule query turn', () => {
    it('answers with a transient schedule card that yields the surface on the next event', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      expect(created.ui.components.some((component) => component.type === 'schedule-strip')).toBe(true)

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-schedule', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'schedule-1', type: 'user.input', text: '看看我的日程', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // The query changed no task fact, only the composed surface.
      expect(asked.task.taskRevision).toBe(created.task.taskRevision)
      expect(asked.task.processedEventIds).not.toContain('schedule-1')
      expect(asked.ui.uiRevision).toBeGreaterThan(created.ui.uiRevision)
      const card = asked.ui.components.find((component) => component.type === 'schedule-card')
      if (card?.type !== 'schedule-card') throw new Error('expected a schedule-card component')
      expect(card.props.events).toEqual([
        expect.objectContaining({ title: '豆豆的睡前故事', startAt: '2026-07-22T21:30:00+08:00' }),
      ])
      expect(card.props.freshness).toBe('fixture')
      // The strip's slot is borrowed, not joined: the count must not grow.
      expect(asked.ui.components.some((component) => component.type === 'schedule-strip')).toBe(false)
      expect(asked.ui.components).toHaveLength(created.ui.components.length)
      expect(asked.assistant?.text).toContain('1 项安排')
      expect(asked.assistant?.text).toContain('21:30')

      // Transience: the next accepted event recomposes without the reading.
      const moved = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-after-schedule', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'moving-after-schedule', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:02:00+08:00' },
      })
      expect(moved.ui.components.some((component) => component.type === 'schedule-card')).toBe(false)
      expect(moved.ui.components.some((component) => component.type === 'schedule-strip')).toBe(true)
    })

    it('replays an identical schedule event id idempotently', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const request = {
        clientRequestId: 'client-schedule-replay', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'schedule-replay', type: 'user.input' as const, text: '看看我的日程', timestamp: '2026-07-22T12:01:00+08:00' },
      }

      const first = gateway.submitEvent(created.task.taskId, request)
      const second = gateway.submitEvent(created.task.taskId, request)

      // A retry that lands while the trip is where it was gets the response it
      // lost, whole — snapshot, card, and spoken line — and does not move the
      // revision a second time.
      expect(second.task).toEqual(first.task)
      expect(second.ui).toEqual(first.ui)
      expect(second.assistant).toEqual(first.assistant)
      expect(second.ui.components.some((component) => component.type === 'schedule-card')).toBe(true)
    })

    it('degrades to a spoken notice on the unchanged snapshot when the calendar read fails', () => {
      const orchestrator = new ReadToolOrchestrator()
      const failing: ReadToolOrchestration = {
        resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
        prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
        resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        resolveSchedule: () => {
          throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'calendar provider timed out', true)
        },
      }
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator: failing,
      })
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-schedule-fail', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'schedule-fail', type: 'user.input', text: '看看我的日程', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task).toEqual(created.task)
      expect(asked.ui.uiRevision).toBe(created.ui.uiRevision)
      expect(asked.ui.meta.generatedBy).not.toBe('fallback')
      expect(asked.assistant?.text).toContain('日程服务暂时不可用')
    })

    it('answers an empty day with the empty card, not silence', () => {
      const orchestrator = new ReadToolOrchestrator()
      const empty: ReadToolOrchestration = {
        resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
        prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
        resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        // A calendar day with nothing left is a successful read of zero events.
        resolveSchedule: (taskId, requestId) => orchestrator.resolveSchedule!(taskId, requestId, { date: '2026-07-24' }),
      }
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(), now: () => now, createId: () => '001', orchestrator: empty,
      })
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-schedule-empty', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'schedule-empty', type: 'user.input', text: '今天有什么安排', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      const card = asked.ui.components.find((component) => component.type === 'schedule-card')
      if (card?.type !== 'schedule-card') throw new Error('expected a schedule-card component')
      expect(card.props.events).toEqual([])
      expect(card.props.emptyCopy).toBe('今天没有更多安排了')
      expect(asked.assistant?.text).toContain('没有更多安排')
    })

    it('leaves terminal tasks on the ordinary event path', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const cancelled = gateway.cancelTask(created.task.taskId, {
        clientRequestId: 'client-cancel-for-schedule', expectedTaskRevision: created.task.taskRevision,
        eventId: 'cancel-for-schedule',
      })

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-schedule-terminal', expectedTaskRevision: cancelled.task.taskRevision,
        event: { eventId: 'schedule-terminal', type: 'user.input', text: '看看我的日程', timestamp: '2026-07-22T12:10:00+08:00' },
      })

      expect(asked.ui.components.some((component) => component.type === 'schedule-card')).toBe(false)
      expect(asked.task.phase).toBe('cancelled')
    })
  })

  describe('check-departure-time query turn', () => {
    it('answers with a transient departure card that yields the surface on the next event', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      expect(created.task.phase).toBe('preparing')

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'departure-1', type: 'user.input', text: '什么时候出发', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // Arithmetic over facts the trip already has: no task fact changes.
      expect(asked.task.taskRevision).toBe(created.task.taskRevision)
      expect(asked.task.processedEventIds).not.toContain('departure-1')
      expect(asked.ui.uiRevision).toBeGreaterThan(created.ui.uiRevision)
      expect(asked.ui.components).toContainEqual(expect.objectContaining({
        type: 'departure-plan',
        props: expect.objectContaining({
          departAtLabel: '20:10', arrivalLabel: 'MU5102 20:40 落地', driveMinutes: 20, bufferMinutes: 10,
        }),
      }))
      expect(asked.ui.components).toHaveLength(created.ui.components.length)
      expect(asked.assistant).toMatchObject({ shouldSpeak: true })
      expect(asked.assistant?.text).toContain('建议 20:10 出发')

      const moved = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-after-departure', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'moving-after-departure', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:02:00+08:00' },
      })
      expect(moved.ui.components.some((component) => component.type === 'departure-plan')).toBe(false)
    })

    it('answers the same question when the button asks it', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const action = created.ui.actions.find((candidate) => candidate.id === 'ask-departure-time')
      if (action?.event.type !== 'agent-message') throw new Error('expected an agent-message action')

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure-button', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'departure-button', type: 'user.input', text: action.event.text, timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.ui.components.some((component) => component.type === 'departure-plan')).toBe(true)
    })

    it('replays an identical departure event id idempotently', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const request = {
        clientRequestId: 'client-departure-replay', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'departure-replay', type: 'user.input' as const, text: '什么时候出发', timestamp: '2026-07-22T12:01:00+08:00' },
      }

      const first = gateway.submitEvent(created.task.taskId, request)
      const second = gateway.submitEvent(created.task.taskId, request)

      // A retry that lands while the trip is where it was gets the response it
      // lost, whole — snapshot, card, and spoken line — and does not move the
      // revision a second time.
      expect(second.task).toEqual(first.task)
      expect(second.ui).toEqual(first.ui)
      expect(second.assistant).toEqual(first.assistant)
      expect(second.ui.components.some((component) => component.type === 'departure-plan')).toBe(true)
    })

    it('keeps a replayable side answer away from the model planner', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const request = {
        clientRequestId: 'client-departure-planning', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'departure-planning', type: 'user.input' as const, text: '什么时候出发', timestamp: '2026-07-22T12:01:00+08:00' },
      }
      expect(gateway.userInputPlanningState(created.task.taskId, request)).toBeDefined()

      const asked = gateway.submitEvent(created.task.taskId, request)
      expect(asked.ui.components.some((component) => component.type === 'departure-plan')).toBe(true)

      // submitEvent would answer this retry from the store, so the planner boundary
      // has no reason to send the text out to a provider.
      expect(gateway.userInputPlanningState(created.task.taskId, request)).toBeUndefined()

      const driving = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'client-start-after-planning-question',
        expectedTaskRevision: asked.task.taskRevision,
        expectedUiRevision: asked.ui.uiRevision,
        actionId: 'start-navigation',
        componentId: 'navigation-plan',
        idempotencyKey: 'start-after-planning-question',
      })

      // Once the trip moves the recorded answer stops being true, so the same
      // duplicate is a real turn again and planning it is back on the table.
      const late = { ...request, expectedTaskRevision: driving.task.taskRevision }
      expect(gateway.userInputPlanningState(created.task.taskId, late)).toBeDefined()
    })

    it('answers a duplicate afresh once the trip has moved past the answer it replayed', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const request = {
        clientRequestId: 'client-departure-stale', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'departure-stale', type: 'user.input' as const, text: '什么时候出发', timestamp: '2026-07-22T12:01:00+08:00' },
      }
      const asked = gateway.submitEvent(created.task.taskId, request)
      expect(asked.ui.components.some((component) => component.type === 'departure-plan')).toBe(true)

      const driving = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'client-start-after-stale-question',
        expectedTaskRevision: asked.task.taskRevision,
        expectedUiRevision: asked.ui.uiRevision,
        actionId: 'start-navigation',
        componentId: 'navigation-plan',
        idempotencyKey: 'start-after-stale-question',
      })
      expect(driving.task.phase).toBe('driving-to-airport')

      // The same eventId, arriving late. Replaying the recommendation here would
      // put advice about a departure back on screen after the car made it, so the
      // duplicate is answered from where the car is instead.
      const late = gateway.submitEvent(created.task.taskId, { ...request, expectedTaskRevision: driving.task.taskRevision })
      expect(late.ui.components.some((component) => component.type === 'departure-plan')).toBe(false)
      expect(late.assistant?.text).toContain('已经在路上了')
      expect(late.task.taskRevision).toBe(driving.task.taskRevision)
    })

    it('says so instead of inventing a time when there is nothing to work backwards from', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('去机场接妈妈'))
      expect(created.task.phase).toBe('collecting-information')

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure-empty', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'departure-empty', type: 'user.input', text: '什么时候出发', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task).toEqual(created.task)
      expect(asked.ui.uiRevision).toBe(created.ui.uiRevision)
      // A missing side answer is not a broken trip.
      expect(asked.ui.meta.generatedBy).not.toBe('fallback')
      expect(asked.assistant?.text).toContain('还没有航班和路线')
    })

    it('answers with where the car is heading once it has already left', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const driving = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'client-start-before-departure-question',
        expectedTaskRevision: created.task.taskRevision,
        expectedUiRevision: created.ui.uiRevision,
        actionId: 'start-navigation',
        componentId: 'navigation-plan',
        idempotencyKey: 'start-before-departure-question',
      })
      expect(driving.task.phase).toBe('driving-to-airport')

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure-underway', expectedTaskRevision: driving.task.taskRevision,
        event: { eventId: 'departure-underway', type: 'user.input', text: '什么时候出发', timestamp: '2026-07-22T12:05:00+08:00' },
      })

      // The recommendation was worked backwards from the landing, so repeating it
      // underway would be advice about a departure that already happened. What the
      // driver is really asking about now is the arrival, so answer that.
      expect(asked.ui.components.some((component) => component.type === 'departure-plan')).toBe(false)
      expect(asked.assistant?.text).not.toContain('建议')
      expect(asked.assistant?.text).toContain('已经在路上了')
      // And asking changed nothing about the drive.
      expect(asked.task).toEqual(driving.task)
      expect(asked.ui.uiRevision).toBe(driving.ui.uiRevision)
    })

    it('answers the same way on the way home, where there is no departure left to plan', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const driving = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'client-start-before-returning-question',
        expectedTaskRevision: created.task.taskRevision,
        expectedUiRevision: created.ui.uiRevision,
        actionId: 'start-navigation',
        componentId: 'navigation-plan',
        idempotencyKey: 'start-before-returning-question',
      })
      const approaching = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-geofence-before-returning', expectedTaskRevision: driving.task.taskRevision,
        event: { eventId: 'geofence-before-returning', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:30:00+08:00' },
      })
      const waiting = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-parked-before-returning', expectedTaskRevision: approaching.task.taskRevision,
        event: { eventId: 'parked-before-returning', type: 'vehicle.parked', timestamp: '2026-07-22T12:35:00+08:00' },
      })
      const returning = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-onboard-before-returning', expectedTaskRevision: waiting.task.taskRevision,
        event: { eventId: 'onboard-before-returning', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:50:00+08:00' },
      })
      expect(returning.task.phase).toBe('returning-home')

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure-returning', expectedTaskRevision: returning.task.taskRevision,
        event: { eventId: 'departure-returning', type: 'user.input', text: '几点出发比较好', timestamp: '2026-07-22T13:00:00+08:00' },
      })

      expect(asked.ui.components.some((component) => component.type === 'departure-plan')).toBe(false)
      expect(asked.assistant?.text).not.toContain('建议')
      expect(asked.task).toEqual(returning.task)
    })

    it('leaves terminal tasks on the ordinary event path', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const cancelled = gateway.cancelTask(created.task.taskId, {
        clientRequestId: 'client-cancel-for-departure', expectedTaskRevision: created.task.taskRevision,
        eventId: 'cancel-for-departure',
      })

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure-terminal', expectedTaskRevision: cancelled.task.taskRevision,
        event: { eventId: 'departure-terminal', type: 'user.input', text: '什么时候出发', timestamp: '2026-07-22T12:10:00+08:00' },
      })

      expect(asked.ui.components.some((component) => component.type === 'departure-plan')).toBe(false)
      expect(asked.task.phase).toBe('cancelled')
    })
  })

  describe('the two answers on the departure card', () => {
    function askedDeparture(gateway = createGateway()) {
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure-for-answers', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'departure-for-answers', type: 'user.input', text: '什么时候出发', timestamp: '2026-07-22T12:01:00+08:00' },
      })
      return { gateway, created, asked }
    }

    function departureCard(ui: UISpec) {
      const card = ui.components.find((component) => component.type === 'departure-plan')
      if (card?.type !== 'departure-plan') throw new Error('expected a departure-plan component')
      return card
    }

    it('offers both answers on the card it makes, and defines them in the spec', () => {
      const { asked } = askedDeparture()

      // Declared on the card and defined alongside it: the renderer resolves the
      // ids it is handed, so an id on one side only would be an inert button.
      expect(departureCard(asked.ui).actions).toEqual(['remind-later', 'view-calendar'])
      for (const actionId of ['remind-later', 'view-calendar']) {
        const action = asked.ui.actions.find((candidate) => candidate.id === actionId)
        expect(action?.event.type).toBe('agent-message')
      }
    })

    it('records the departure it was told about and states it back on every later ask', () => {
      const { gateway, created, asked } = askedDeparture()
      expect(departureCard(asked.ui).props.reminderAtLabel).toBeUndefined()

      const armed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-remind-later', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'remind-later-1', type: 'user.input', text: '稍后提醒我', timestamp: '2026-07-22T12:02:00+08:00' },
      })

      // The recorded instant is the one the card showed a clock label for.
      expect(armed.task.departureReminder).toEqual({
        remindAt: '2026-07-22T20:10:00+08:00',
        armedAt: expect.any(String),
      })
      expect(armed.task.taskRevision).toBe(asked.task.taskRevision + 1)
      expect(armed.assistant?.text).toContain('20:10')

      const again = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-departure-again', expectedTaskRevision: armed.task.taskRevision,
        event: { eventId: 'departure-again', type: 'user.input', text: '什么时候出发', timestamp: '2026-07-22T12:03:00+08:00' },
      })

      // Which is the whole point of recording it: asking again is now confirmation
      // rather than the same unanswered question, and there is nothing left to set.
      const card = departureCard(again.ui)
      expect(card.props.reminderAtLabel).toBe('20:10')
      expect(card.actions).toEqual(['view-calendar'])
      expect(again.ui.actions.some((action) => action.id === 'remind-later')).toBe(false)
    })

    it('claims nothing new when the same time is set twice', () => {
      const { gateway, created, asked } = askedDeparture()
      const armed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-remind-once', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'remind-once', type: 'user.input', text: '稍后提醒我', timestamp: '2026-07-22T12:02:00+08:00' },
      })

      const twice = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-remind-twice', expectedTaskRevision: armed.task.taskRevision,
        event: { eventId: 'remind-twice', type: 'user.input', text: '到点提醒我', timestamp: '2026-07-22T12:03:00+08:00' },
      })

      // A different sentence and a different event, so not a replay — but the same
      // fact, so the trip does not move. The driver still hears the confirmation.
      expect(twice.task.taskRevision).toBe(armed.task.taskRevision)
      expect(twice.task.departureReminder).toEqual(armed.task.departureReminder)
      expect(twice.assistant?.text).toContain('已经设好了')
    })

    it('replays an identical reminder event id off the log', () => {
      const { gateway, created, asked } = askedDeparture()
      const request = {
        clientRequestId: 'client-remind-replay', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'remind-replay', type: 'user.input' as const, text: '稍后提醒我', timestamp: '2026-07-22T12:02:00+08:00' },
      }

      const first = gateway.submitEvent(created.task.taskId, request)
      const second = gateway.submitEvent(created.task.taskId, request)

      // This turn changes state, so it replays off the event log rather than off
      // the side-answer contract — which is defined by the revision not moving.
      expect(second.task).toEqual(first.task)
      expect(second.task.taskRevision).toBe(asked.task.taskRevision + 1)
    })

    it('promises nothing when there is no departure to work backwards from', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('去机场接妈妈'))
      expect(created.task.phase).toBe('collecting-information')

      const armed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-remind-empty', expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'remind-empty', type: 'user.input', text: '稍后提醒我', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(armed.task).toEqual(created.task)
      expect(armed.task.departureReminder).toBeUndefined()
      expect(armed.assistant?.text).toContain('还没有航班和路线')
    })

    it('refuses to set one after the car has left, and spends the one it was holding', () => {
      const { gateway, created, asked } = askedDeparture()
      const armed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-remind-before-start', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'remind-before-start', type: 'user.input', text: '稍后提醒我', timestamp: '2026-07-22T12:02:00+08:00' },
      })
      expect(armed.task.departureReminder).toBeDefined()

      const driving = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'client-start-after-remind',
        expectedTaskRevision: armed.task.taskRevision,
        expectedUiRevision: armed.ui.uiRevision,
        actionId: 'start-navigation',
        componentId: 'navigation-plan',
        idempotencyKey: 'start-after-remind',
      })

      // A reminder to leave is spent the moment the car does; left standing it
      // would be state that contradicts the trip it belongs to.
      expect(driving.task.phase).toBe('driving-to-airport')
      expect(driving.task.departureReminder).toBeUndefined()

      const late = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-remind-underway', expectedTaskRevision: driving.task.taskRevision,
        event: { eventId: 'remind-underway', type: 'user.input', text: '稍后提醒我', timestamp: '2026-07-22T12:05:00+08:00' },
      })
      expect(late.task).toEqual(driving.task)
      expect(late.assistant?.text).toContain('已经在路上了')
    })

    it('shows the calendar the trip already read without going back to the provider', () => {
      const orchestrator = new ReadToolOrchestrator()
      const schedule = vi.fn(orchestrator.resolveSchedule.bind(orchestrator))
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(), now: () => now, createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
          resolveSchedule: schedule,
        },
      })
      const { created, asked } = askedDeparture(gateway)

      const viewed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-view-calendar', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'view-calendar-1', type: 'user.input', text: '查看日程', timestamp: '2026-07-22T12:02:00+08:00' },
      })

      // The events were already on the snapshot, and that is the whole difference
      // between this and 看看日程: same card, no second read.
      expect(schedule).not.toHaveBeenCalled()
      const card = viewed.ui.components.find((component) => component.type === 'schedule-card')
      if (card?.type !== 'schedule-card') throw new Error('expected a schedule-card component')
      expect(card.props.events.map((event) => event.title)).toEqual(['豆豆的睡前故事'])
      expect(viewed.assistant?.text).toContain('21:30 豆豆的睡前故事')
      // A glance, not a fact: nothing about the trip changed, and the next event
      // takes the surface back.
      expect(viewed.task.taskRevision).toBe(asked.task.taskRevision)
      expect(viewed.task.processedEventIds).not.toContain('view-calendar-1')
      const moved = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-moving-after-calendar', expectedTaskRevision: viewed.task.taskRevision,
        event: { eventId: 'moving-after-calendar', type: 'vehicle.moving', speedKph: 30, timestamp: '2026-07-22T12:03:00+08:00' },
      })
      expect(moved.ui.components.some((component) => component.type === 'schedule-card')).toBe(false)

      // The control on that "no second read": the open question does go and ask,
      // through the very method the glance left untouched.
      gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-ask-schedule-control', expectedTaskRevision: moved.task.taskRevision,
        event: { eventId: 'ask-schedule-control', type: 'user.input', text: '看看日程', timestamp: '2026-07-22T12:04:00+08:00' },
      })
      expect(schedule).toHaveBeenCalledTimes(1)
    })

    it('offers no glance at a calendar nobody read, and says where to get one', () => {
      const orchestrator = new ReadToolOrchestrator()
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(), now: () => now, createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
          // The calendar read is already best-effort inside prepareTrip; this is
          // the shape of the trip that survived without it.
          prepareTrip: (taskId, requestId, flightNumber) => {
            const reads = orchestrator.prepareTrip(taskId, requestId, flightNumber)
            const toolResults = { ...reads.toolResults }
            delete toolResults['calendar.list-upcoming']
            return { ...reads, toolResults }
          },
        },
      })
      const { created, asked } = askedDeparture(gateway)

      // An absent button rather than an inert one: there is nothing to glance at.
      expect(departureCard(asked.ui).actions).toEqual(['remind-later'])

      const viewed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-view-calendar-empty', expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'view-calendar-empty', type: 'user.input', text: '查看日程', timestamp: '2026-07-22T12:02:00+08:00' },
      })

      // Saying so beats an empty card, which would read as "you have nothing on".
      expect(viewed.ui.components.some((component) => component.type === 'schedule-card')).toBe(false)
      expect(viewed.assistant?.text).toContain('看看日程')
      expect(viewed.task).toEqual(asked.task)
    })

    it('leaves both answers unknown once the trip is terminal', () => {
      const { gateway, created, asked } = askedDeparture()
      const cancelled = gateway.cancelTask(created.task.taskId, {
        clientRequestId: 'client-cancel-for-answers', expectedTaskRevision: asked.task.taskRevision,
        eventId: 'cancel-for-answers',
      })

      for (const [index, text] of ['稍后提醒我', '查看日程'].entries()) {
        const answered = gateway.submitEvent(created.task.taskId, {
          clientRequestId: `client-terminal-answer-${index}`, expectedTaskRevision: cancelled.task.taskRevision,
          event: { eventId: `terminal-answer-${index}`, type: 'user.input', text, timestamp: '2026-07-22T12:10:00+08:00' },
        })
        expect(answered.task.phase).toBe('cancelled')
        expect(answered.task.departureReminder).toBeUndefined()
        expect(answered.ui.components.some((component) => component.type === 'schedule-card')).toBe(false)
      }
    })
  })

  describe('en-route side scenes', () => {
    function drivingTask() {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      const driving = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'client-start-for-side-scenes',
        expectedTaskRevision: created.task.taskRevision,
        expectedUiRevision: created.ui.uiRevision,
        actionId: 'start-navigation',
        componentId: 'navigation-plan',
        idempotencyKey: 'start-for-side-scenes',
      })
      expect(driving.task.phase).toBe('driving-to-airport')
      return { gateway, driving }
    }

    it('offers both side scenes on the driving brief and answers each from its own label', () => {
      const { gateway, driving } = drivingTask()
      const offered = driving.ui.actions.filter((action) => action.id === 'ask-weather' || action.id === 'ask-schedule')
      expect(offered).toHaveLength(2)

      for (const [index, action] of offered.entries()) {
        if (action.event.type !== 'agent-message') throw new Error('expected an agent-message action')
        const asked = gateway.submitEvent(driving.task.taskId, {
          clientRequestId: `client-side-scene-${index}`,
          expectedTaskRevision: driving.task.taskRevision,
          event: { eventId: `side-scene-${index}`, type: 'user.input', text: action.event.text, timestamp: '2026-07-22T12:05:00+08:00' },
        })

        // Answered mid-drive, and the drive is untouched by the answering.
        expect(asked.task.phase).toBe('driving-to-airport')
        expect(asked.task.taskRevision).toBe(driving.task.taskRevision)
        expect(asked.ui.components.some((component) => (
          component.type === 'weather-card' || component.type === 'schedule-card'
        ))).toBe(true)
        // Reading one must not cost the driver the way back to the other.
        expect(asked.ui.actions.map((candidate) => candidate.id)).toEqual(
          expect.arrayContaining(['ask-weather', 'ask-schedule']),
        )
      }
    })

    it('gives the brief back on the next real trip event', () => {
      const { gateway, driving } = drivingTask()
      const asked = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-side-scene-transient',
        expectedTaskRevision: driving.task.taskRevision,
        event: { eventId: 'side-scene-transient', type: 'user.input', text: '看看日程', timestamp: '2026-07-22T12:05:00+08:00' },
      })
      expect(asked.ui.components.some((component) => component.type === 'schedule-card')).toBe(true)

      // The answer rode one snapshot. The next thing that actually happens on the
      // trip recomposes without it, and the ETA is back where it was.
      const charging = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-side-scene-after',
        expectedTaskRevision: asked.task.taskRevision,
        event: { eventId: 'side-scene-after', type: 'charging.started', stationId: 'station-hongqiao-01', timestamp: '2026-07-22T12:06:00+08:00' },
      })
      expect(charging.ui.components.some((component) => component.type === 'schedule-card')).toBe(false)
      expect(charging.ui.components.some((component) => component.id === 'navigation-summary')).toBe(true)
    })

    it('refuses the side-scene ids on the action path, which is not where they travel', () => {
      const { gateway, driving } = drivingTask()

      expect(() => gateway.submitAction(driving.task.taskId, {
        clientRequestId: 'client-side-scene-action',
        expectedTaskRevision: driving.task.taskRevision,
        expectedUiRevision: driving.ui.uiRevision,
        actionId: 'ask-weather',
        componentId: 'navigation-summary',
        idempotencyKey: 'side-scene-action',
      })).toThrow(/Action is not registered/)
    })
  })

  describe('arrivals board turn', () => {
    function boardOf(ui: UISpec) {
      const component = ui.components.find((candidate) => candidate.type === 'flight-choices')
      if (!component || component.type !== 'flight-choices') return undefined
      return component
    }

    /**
     * A gateway whose arrivals board is a live read for yesterday. The rows still
     * render — they are true about a day that is over — and the revision is
     * perfectly current, which is exactly why the revision guard cannot catch
     * this. Live is the half that makes the expiry askable at all: a real
     * provider read is stamped by the same clock the rank arrives on, where a
     * fixture read is authored on a fixed day and has no instant to compare.
     */
    function expiredLiveBoardGateway() {
      const orchestrator = new ReadToolOrchestrator()
      return new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => now,
        createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
          resolveArrivals: (taskId, requestId) => {
            const result = orchestrator.resolveArrivals(taskId, requestId)
            return {
              ...result,
              data: { ...result.data, expiresAt: '2026-07-21T23:59:59+08:00' },
              meta: { ...result.meta, provider: 'live' as const },
            }
          },
        },
      })
    }

    it('offers the arrivals board while the flight number is still missing', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))

      const board = boardOf(created.ui)
      expect(created.task.phase).toBe('collecting-information')
      expect(board?.props.choices.length).toBeGreaterThanOrEqual(2)
      // Every offered row is pressable: the ids the card declares are exactly the
      // actions the spec defines.
      expect(created.ui.actions.map((action) => action.id)).toEqual(board?.actions)
    })

    it('prepares the trip from a picked row and retires the board', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      const pick = created.ui.actions.find((action) => action.id === 'pick-CA1516')
      expect(pick?.event).toEqual({ type: 'agent-message', text: '航班号 CA1516' })

      // The client replays the action's own text as user input, which is the only
      // path a picked row takes into the Agent.
      const picked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-pick-row',
        expectedTaskRevision: created.task.taskRevision,
        event: {
          eventId: 'pick-row',
          type: 'user.input',
          text: pick!.event.type === 'agent-message' ? pick!.event.text : '',
          timestamp: '2026-07-22T12:01:00+08:00',
        },
      })

      expect(picked.task.phase).toBe('preparing')
      expect(picked.task.flight?.flightNumber).toBe('CA1516')
      // The choice has been made, so the offer goes away rather than following the
      // driver into the brief.
      expect(boardOf(picked.ui)).toBeUndefined()
      expect(picked.ui.components.map((component) => component.type)).toContain('flight-status')
    })

    it('drives to the airport the picked flight lands at, not the one the request assumed', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      const rows = boardOf(created.ui)!.props.choices
      const pudongRow = rows.find((row) => row.airportName.includes('浦东'))
      const hongqiaoRow = rows.find((row) => row.airportName.includes('虹桥'))
      // The board has to actually offer the contrast, or the rest asserts nothing.
      expect(pudongRow, '浦东 row').toBeDefined()
      expect(hongqiaoRow, '虹桥 row').toBeDefined()

      // Each pick gets its own task: two picks on one task is a revision
      // conflict, and what is being compared is two trips, not two turns.
      const pick = (row: { flightNumber: string }, suffix: string) => {
        const own = createGateway()
        const task = own.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
        return own.submitEvent(task.task.taskId, {
          clientRequestId: `client-pick-${suffix}`,
          expectedTaskRevision: task.task.taskRevision,
          event: {
            eventId: `pick-${suffix}`, type: 'user.input',
            text: `航班号 ${row.flightNumber}`, timestamp: '2026-07-22T12:01:00+08:00',
          },
        })
      }

      const pudong = pick(pudongRow!, 'pvg')
      expect(pudong.task.flight?.arrivalAirport).toBe('PVG')
      expect(pudong.task.navigation?.destination).toBe('浦东机场 T2')

      // Same board, same city, other row: the destination is a consequence of the
      // pick, so the two picks must not agree.
      const hongqiao = pick(hongqiaoRow!, 'sha')
      expect(hongqiao.task.flight?.arrivalAirport).toBe('SHA')
      expect(hongqiao.task.navigation?.destination).toBe('虹桥机场 T2')
      expect(hongqiao.task.navigation?.routeId).not.toBe(pudong.task.navigation?.routeId)
    })

    it('asks for the number when the orchestration cannot offer a board', () => {
      const orchestrator = new ReadToolOrchestrator()
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => now,
        createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        },
      })
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))

      expect(boardOf(created.ui)).toBeUndefined()
      expect(created.ui.components).toEqual([
        { id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号' } },
      ])
    })

    it('resolves a spoken ordinal onto the same rows the board rendered', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      const board = boardOf(created.ui)
      const thirdOnScreen = board!.props.choices[2]!.flightNumber

      const picked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-pick-ordinal',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'pick-ordinal', type: 'user.input', text: '选第三个', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // The ordinal took the exact path a tap takes: the third rendered row's
      // number went through the ordinary flight-number turn and prepared the trip.
      expect(picked.task.phase).toBe('preparing')
      expect(picked.task.flight?.flightNumber).toBe(thirdOnScreen)
      expect(boardOf(picked.ui)).toBeUndefined()
    })

    it('keeps an ordinal on the ordinary unknown path when there is no board to pick from', () => {
      const orchestrator = new ReadToolOrchestrator()
      // No resolveArrivals: the driver was asked for a number, not shown rows,
      // so 第三个 points at nothing and must not invent a flight.
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => now,
        createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
        },
      })
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      expect(boardOf(created.ui)).toBeUndefined()

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-pick-no-board',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'pick-no-board', type: 'user.input', text: '第三个', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task.phase).toBe('collecting-information')
      expect(asked.task.flight).toBeUndefined()
    })

    it('does not resolve an ordinal from arrivals data the board never rendered', () => {
      const orchestrator = new ReadToolOrchestrator()
      // One pickable row is not a choice: the composer falls back to asking for
      // the number, so the arrivals data is persisted but no board is on
      // screen. 第一个 must not silently pick the hidden row.
      const single = orchestrator.resolveArrivals('probe', 'probe')
      const onlyRow = single.data.arrivals[0]!
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => now,
        createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
          resolveArrivals: (taskId, requestId) => {
            const result = orchestrator.resolveArrivals(taskId, requestId)
            return { ...result, data: { ...result.data, arrivals: [onlyRow] } }
          },
        },
      })
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      expect(boardOf(created.ui)).toBeUndefined()

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-pick-hidden-board',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'pick-hidden-board', type: 'user.input', text: '第一个', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task.phase).toBe('collecting-information')
      expect(asked.task.flight).toBeUndefined()
    })

    it('leaves an ordinal alone once the flight is already chosen', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      expect(created.task.phase).toBe('preparing')

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-pick-after-choice',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'pick-after-choice', type: 'user.input', text: '第二个', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // There is no board on a preparing brief; the words keep their unknown
      // meaning and the chosen flight stands.
      expect(asked.task.flight?.flightNumber).toBe('MU5102')
      expect(asked.task.taskRevision).toBe(created.task.taskRevision)
    })

    it('records which set of arrivals the board came from, and retires it with the board', () => {
      const gateway = createGateway()
      const orchestrator = new ReadToolOrchestrator()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))

      // The identity on the task is the one the tool minted, not a second
      // number the Agent invented alongside it.
      expect(created.task.flightDiscovery?.candidateSetId)
        .toBe(orchestrator.resolveArrivals('probe', 'probe').data.candidateSetId)
      expect(created.task.flightDiscovery?.expiresAt).toBe('2026-07-22T23:59:59+08:00')

      const picked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-pick-clears-set',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'pick-clears-set', type: 'user.input', text: '航班号 CA1516', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // The choice has been made, so there is no set left to be choosing from.
      expect(boardOf(picked.ui)).toBeUndefined()
      expect(picked.task.flightDiscovery).toBeUndefined()
    })

    it('re-reads the board on 刷新航班 and moves the revision an in-flight rank was planned against', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      const before = boardOf(created.ui)!.props.choices.map((choice) => choice.flightNumber)

      const refreshed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-refresh',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'refresh-board', type: 'user.input', text: '刷新航班', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // Still collecting, still a board, and the flight nobody picked is still
      // unpicked: a refresh answers a question about the list, not about the trip.
      expect(refreshed.task.phase).toBe('collecting-information')
      expect(refreshed.task.flight).toBeUndefined()
      expect(boardOf(refreshed.ui)!.props.choices.map((choice) => choice.flightNumber)).toEqual(before)
      expect(refreshed.assistant?.text).toContain('已刷新')
      // The bump is the whole protection: a rank spoken against the previous list
      // carries the previous revision, and that is what refuses it.
      expect(refreshed.task.taskRevision).toBe(created.task.taskRevision + 1)
      expect(() => gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-stale-rank',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'stale-rank', type: 'user.input', text: '选第三个', timestamp: '2026-07-22T12:02:00+08:00' },
      })).toThrowError(expect.objectContaining({ code: 'TASK_REVISION_CONFLICT' }))
    })

    it('leaves the board standing when the refresh read fails', () => {
      const orchestrator = new ReadToolOrchestrator()
      let attempts = 0
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => now,
        createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
          resolveArrivals: (taskId, requestId) => {
            attempts += 1
            if (attempts > 1) throw new ReadToolOrchestrationError('PROVIDER_TIMEOUT', 'arrivals timed out', true)
            return orchestrator.resolveArrivals(taskId, requestId)
          },
        },
      })
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      expect(boardOf(created.ui)).toBeDefined()

      const refreshed = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-refresh-fails',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'refresh-fails', type: 'user.input', text: '刷新航班', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // A failed attempt to improve the list must not cost the driver the list.
      // Nothing was claimed, so nothing moved: same rows, same revision, and the
      // spoken line says so instead of pretending the read landed.
      expect(boardOf(refreshed.ui)!.props.choices.length).toBe(boardOf(created.ui)!.props.choices.length)
      expect(refreshed.task.taskRevision).toBe(created.task.taskRevision)
      expect(refreshed.task.flightDiscovery).toEqual(created.task.flightDiscovery)
      expect(refreshed.assistant?.text).toContain('刷新不了')
    })

    it('keeps 刷新航班 on the unknown path once the flight is chosen', () => {
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-refresh-after-pick',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'refresh-after-pick', type: 'user.input', text: '刷新航班', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      // There is no list to refresh on a preparing brief, so the words mean
      // nothing and the trip is left exactly as it was.
      expect(asked.task.flight?.flightNumber).toBe('MU5102')
      expect(asked.task.taskRevision).toBe(created.task.taskRevision)
    })

    it('will not count a rank against a candidate set that has expired', () => {
      const gateway = expiredLiveBoardGateway()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      expect(boardOf(created.ui)).toBeDefined()

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-expired-rank',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'expired-rank', type: 'user.input', text: '选第三个', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task.flight).toBeUndefined()
      expect(asked.task.phase).toBe('collecting-information')
    })

    /**
     * The same expired board, reached through the pre-planning rewrite instead.
     *
     * The persistent runtime resolves the ordinal into the flight number's own
     * words before it plans, so this seam decides the pick — and once the text
     * says 航班号 MU5102, the turn is an ordinary typed number and the board is
     * never consulted again. So the seam has to refuse on exactly the boards the
     * in-transaction path would refuse on, measured against exactly the instant
     * that path would measure against.
     *
     * The trap is the caller's own stamp. User input is clamped forward on the
     * way in — occupant intent is never stale — so a stamp from before the
     * board expired is going to be applied as now; believing it here would make
     * a client clock the thing that decides whether an expired board can still
     * be picked from.
     */
    it('refuses the pre-planning rewrite on an expired board even for a stamp behind the clock', () => {
      const gateway = expiredLiveBoardGateway()
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      expect(boardOf(created.ui)).toBeDefined()

      const behindExpiry = {
        clientRequestId: 'client-expired-rewrite',
        expectedTaskRevision: created.task.taskRevision,
        event: {
          eventId: 'expired-rewrite',
          type: 'user.input' as const,
          text: '选第三个',
          timestamp: '2026-07-21T20:00:00+08:00',
        },
      }

      expect(gateway.ordinalRewriteText(created.task.taskId, behindExpiry)).toBeUndefined()

      // And submitting it changes nothing, which is the same answer the rank
      // gets when it is spoken with an honest stamp.
      const asked = gateway.submitEvent(created.task.taskId, behindExpiry)
      expect(asked.task.flight).toBeUndefined()
      expect(asked.task.phase).toBe('collecting-information')
    })

    /**
     * The other half of that guard: a live board that has NOT expired is still
     * rewritten, so the fix above is a clamp and not a retirement of the seam.
     */
    it('still rewrites a rank against a live board that is current', () => {
      const orchestrator = new ReadToolOrchestrator()
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => now,
        createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
          resolveArrivals: (taskId, requestId) => {
            const result = orchestrator.resolveArrivals(taskId, requestId)
            return { ...result, meta: { ...result.meta, provider: 'live' as const } }
          },
        },
      })
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      const board = boardOf(created.ui)
      if (!board) throw new Error('expected a flight-choices board')

      expect(gateway.ordinalRewriteText(created.task.taskId, {
        clientRequestId: 'client-current-rewrite',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'current-rewrite', type: 'user.input', text: '选第三个', timestamp: '2026-07-22T12:01:00+08:00' },
      })).toBe(`航班号 ${board.props.choices[2]!.flightNumber}`)
    })

    /**
     * The same board, authored rather than read, long after the day it describes.
     *
     * The fixture demo runs on one fixed day for as long as the repository lives,
     * so a wall clock is always eventually past it. Counting that as an expiry
     * would take the spoken ordinal away from every run after the fixture date
     * while the board it is spoken against is still on screen and still pickable
     * by row — a guard that only ever fires on the honest case.
     */
    it('still counts a rank against a fixture board once the wall clock is past its day', () => {
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => '2026-08-09T21:00:00+08:00',
        createId: () => '001',
      })
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      const board = boardOf(created.ui)
      expect(board).toBeDefined()

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-late-rank',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'late-rank', type: 'user.input', text: '选第三个', timestamp: '2026-08-09T21:00:01+08:00' },
      })

      expect(asked.task.flight?.flightNumber).toBe(board!.props.choices[2]!.flightNumber)
      expect(asked.task.phase).toBe('preparing')
    })

    it('will not count a rank against a board the task does not recognize', () => {
      const store = new MemoryTaskStore()
      const gateway = new AgentGateway({ store, now: () => now, createId: () => '001' })
      const created = gateway.createTask(createRequest('我现在要去机场接妈妈和豆豆'))
      expect(boardOf(created.ui)).toBeDefined()

      // The two halves are written together, so a disagreement is a snapshot
      // whose record and board have gotten out of step. Which set the driver was
      // shown is then unanswerable, and an unanswerable rank must not be guessed.
      const stored = store.get(created.task.taskId)!
      store.save({ ...stored, task: { ...stored.task, flightDiscovery: { ...stored.task.flightDiscovery!, candidateSetId: 'cs-someone-elses' } } })

      const asked = gateway.submitEvent(created.task.taskId, {
        clientRequestId: 'client-unknown-set',
        expectedTaskRevision: created.task.taskRevision,
        event: { eventId: 'unknown-set', type: 'user.input', text: '选第三个', timestamp: '2026-07-22T12:01:00+08:00' },
      })

      expect(asked.task.flight).toBeUndefined()
      expect(asked.task.phase).toBe('collecting-information')
    })
  })

  describe('proactive weather advisory and the umbrella reminder', () => {
    /** Create → start navigation → the driving brief, ready for en-route events. */
    function drivingTask(gateway: AgentGateway) {
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      return gateway.submitAction(created.task.taskId, {
        clientRequestId: 'advisory-helper-start', expectedTaskRevision: created.task.taskRevision,
        expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation',
        componentId: 'navigation-plan', idempotencyKey: 'advisory-helper-start',
      })
    }

    function inAirUpdate(taskRevision: number, eventId = 'advisory-in-air') {
      return {
        clientRequestId: `client-${eventId}`, expectedTaskRevision: taskRevision,
        event: {
          eventId, type: 'flight.updated' as const,
          flight: {
            flightNumber: 'MU5102', status: 'in-air' as const,
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
          },
          timestamp: '2026-07-22T19:10:00+08:00',
        },
      }
    }

    it('does not warn a 浦东 pickup about the rain over 虹桥', () => {
      // The two airports have different weather on purpose. Before the drive
      // destination followed the flight, this trip read 虹桥 — and a family
      // landing an hour east would have been told to bring an umbrella for
      // somewhere they were never going.
      const gateway = createGateway()
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 HO1252'))
      expect(created.task.flight?.arrivalAirport).toBe('PVG')
      const driving = gateway.submitAction(created.task.taskId, {
        clientRequestId: 'pvg-advisory-start', expectedTaskRevision: created.task.taskRevision,
        expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation',
        componentId: 'navigation-plan', idempotencyKey: 'pvg-advisory-start',
      })

      const updated = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-pvg-in-air', expectedTaskRevision: driving.task.taskRevision,
        event: {
          eventId: 'pvg-in-air', type: 'flight.updated' as const,
          flight: {
            flightNumber: 'HO1252', status: 'in-air' as const,
            scheduledArrival: '2026-07-22T21:05:00+08:00',
            estimatedArrival: '2026-07-22T21:05:00+08:00', terminal: 'T2',
          },
          timestamp: '2026-07-22T19:10:00+08:00',
        },
      })

      // 浦东 reads overcast, so there is nothing to advise about — and the update
      // that carried no airport must not have moved the trip back west either.
      expect(updated.task.flight?.arrivalAirport).toBe('PVG')
      expect(updated.task.weatherAdvisory).toBeUndefined()
      expect(updated.ui.components.some((component) => component.id === 'weather-advisory')).toBe(false)
    })

    it('raises the advisory once when a flight update finds rain over the arrival', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)

      const updated = gateway.submitEvent(driving.task.taskId, inAirUpdate(driving.task.taskRevision))

      expect(updated.task.weatherAdvisory).toMatchObject({ status: 'active' })
      const card = updated.ui.components.find((component) => component.id === 'weather-advisory')
      if (card?.type !== 'weather-card') throw new Error('expected the advisory weather card')
      expect(card.props.condition).toBe('light-rain')
      expect(card.actions).toEqual(['send-umbrella-reminder', 'dismiss-advisory-weather'])
      expect(updated.ui.actions.map((action) => action.id)).toEqual(['send-umbrella-reminder', 'dismiss-advisory-weather'])

      // The advisory survives an unrelated recompose: it is persisted, not a
      // transient query answer.
      const moving = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-advisory-moving', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'advisory-moving', type: 'vehicle.moving', speedKph: 60, timestamp: '2026-07-22T19:11:00+08:00' },
      })
      expect(moving.ui.components.some((component) => component.id === 'weather-advisory')).toBe(true)
    })

    it('arms the umbrella reminder for confirmation and sends it only on accept', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)
      const updated = gateway.submitEvent(driving.task.taskId, inAirUpdate(driving.task.taskRevision))

      const armed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-umbrella', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'umbrella-ask', type: 'user.input', text: '提醒乘客带伞', timestamp: '2026-07-22T19:12:00+08:00' },
      })

      expect(armed.task.weatherAdvisory).toMatchObject({ status: 'resolved' })
      expect(armed.task.message).toMatchObject({ status: 'scheduled' })
      expect(armed.task.message.pendingText).toContain('带伞')
      expect(armed.task.pendingConfirmation).toMatchObject({ action: 'send-message' })
      expect(armed.effects).toEqual([expect.objectContaining({ type: 'message.prepare', status: 'pending-confirmation' })])
      // The scheduled message takes the brief; the advisory card has retired.
      expect(armed.ui.components.some((component) => component.type === 'message-preview')).toBe(true)
      expect(armed.ui.components.some((component) => component.id === 'weather-advisory')).toBe(false)

      const confirmed = gateway.submitConfirmation(driving.task.taskId, armed.task.pendingConfirmation!.confirmationId, {
        clientRequestId: 'client-umbrella-confirm',
        expectedTaskRevision: armed.task.taskRevision,
        decision: 'accept',
        idempotencyKey: 'umbrella-confirm',
      })

      expect(confirmed.task.message.status).toBe('sent')
      // The umbrella reminder must not claim the landing notice bookkeeping.
      expect(confirmed.task.message.landingNoticeSent).toBe(false)
      expect(confirmed.effects).toContainEqual(expect.objectContaining({ type: 'message.send', status: 'succeeded' }))
    })

    it('still schedules the landing notice after the umbrella reminder was sent', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)
      const updated = gateway.submitEvent(driving.task.taskId, inAirUpdate(driving.task.taskRevision))
      const armed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-umbrella-2', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'umbrella-ask-2', type: 'user.input', text: '提醒乘客带伞', timestamp: '2026-07-22T19:12:00+08:00' },
      })
      const confirmed = gateway.submitConfirmation(driving.task.taskId, armed.task.pendingConfirmation!.confirmationId, {
        clientRequestId: 'client-umbrella-confirm-2',
        expectedTaskRevision: armed.task.taskRevision,
        decision: 'accept',
        idempotencyKey: 'umbrella-confirm-2',
      })

      const landed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-advisory-landed', expectedTaskRevision: confirmed.task.taskRevision,
        event: {
          eventId: 'advisory-landed', type: 'flight.updated',
          flight: {
            flightNumber: 'MU5102', status: 'landed',
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
          },
          timestamp: '2026-07-22T20:40:00+08:00',
        },
      })

      expect(landed.task.message).toMatchObject({ status: 'scheduled', pendingMessageId: 'MU5102:landing' })
    })

    it('rejecting the preview revokes the reminder without sending', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)
      const updated = gateway.submitEvent(driving.task.taskId, inAirUpdate(driving.task.taskRevision))
      const armed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-umbrella-3', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'umbrella-ask-3', type: 'user.input', text: '提醒乘客带伞', timestamp: '2026-07-22T19:12:00+08:00' },
      })

      const rejected = gateway.submitConfirmation(driving.task.taskId, armed.task.pendingConfirmation!.confirmationId, {
        clientRequestId: 'client-umbrella-reject',
        expectedTaskRevision: armed.task.taskRevision,
        decision: 'reject',
        idempotencyKey: 'umbrella-reject',
      })

      expect(rejected.task.pendingConfirmation).toBeUndefined()
      expect(rejected.task.message.status).not.toBe('sent')
      // The advisory stays resolved: rejecting the preview is an answer too.
      expect(rejected.task.weatherAdvisory).toMatchObject({ status: 'resolved' })
    })

    it('dismisses the advisory for good and returns the rail to the navigation brief', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)
      const updated = gateway.submitEvent(driving.task.taskId, inAirUpdate(driving.task.taskRevision))

      const dismissed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-advisory-dismiss', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'advisory-dismiss', type: 'user.input', text: '暂不处理', timestamp: '2026-07-22T19:12:00+08:00' },
      })

      expect(dismissed.task.weatherAdvisory).toMatchObject({ status: 'dismissed' })
      expect(dismissed.ui.components.some((component) => component.id === 'weather-advisory')).toBe(false)
      expect(dismissed.ui.components.some((component) => component.type === 'navigation-summary')).toBe(true)

      // Retired for good: the next flight update must not re-raise it.
      const again = gateway.submitEvent(driving.task.taskId, inAirUpdate(dismissed.task.taskRevision, 'advisory-in-air-again'))
      expect(again.task.weatherAdvisory).toMatchObject({ status: 'dismissed' })
    })

    it('replays advisory answers idempotently', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)
      const updated = gateway.submitEvent(driving.task.taskId, inAirUpdate(driving.task.taskRevision))
      const request = {
        clientRequestId: 'client-umbrella-replay', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'umbrella-replay', type: 'user.input' as const, text: '提醒乘客带伞', timestamp: '2026-07-22T19:12:00+08:00' },
      }

      const first = gateway.submitEvent(driving.task.taskId, request)
      const second = gateway.submitEvent(driving.task.taskId, request)

      expect(second.task).toEqual(first.task)
      expect(second.ui).toEqual(first.ui)
    })

    it('leaves advisory words on the unknown path when no advisory is active', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)

      const asked = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-umbrella-none', expectedTaskRevision: driving.task.taskRevision,
        event: { eventId: 'umbrella-none', type: 'user.input', text: '提醒乘客带伞', timestamp: '2026-07-22T19:12:00+08:00' },
      })

      expect(asked.task.message.status).toBe('idle')
      expect(asked.task.pendingConfirmation).toBeUndefined()
      expect(asked.task.taskRevision).toBe(driving.task.taskRevision)
    })

    it('does not raise the advisory from a landed-first update while still driving', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)

      // The flight lands before any in-air beat arrived. Warning about arrival
      // rain after the passenger has arrived is advice about the past, so the
      // landed update schedules the landing notice and raises nothing.
      const landed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-landed-first', expectedTaskRevision: driving.task.taskRevision,
        event: {
          eventId: 'landed-first', type: 'flight.updated',
          flight: {
            flightNumber: 'MU5102', status: 'landed',
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
          },
          timestamp: '2026-07-22T20:40:00+08:00',
        },
      })

      expect(landed.task.weatherAdvisory).toBeUndefined()
      expect(landed.task.message.status).toBe('scheduled')
      expect(landed.task.message.pendingMessageId).toBe('MU5102:landing')
    })

    it('does not raise the advisory when the weather read is unavailable', () => {
      const orchestrator = new ReadToolOrchestrator()
      const gateway = new AgentGateway({
        store: new MemoryTaskStore(),
        now: () => now,
        createId: () => '001',
        orchestrator: {
          resolveInitialPassengers: orchestrator.resolveInitialPassengers.bind(orchestrator),
          prepareTrip: orchestrator.prepareTrip.bind(orchestrator),
          resolveReturnTripPreferences: orchestrator.resolveReturnTripPreferences.bind(orchestrator),
          resolveArrivals: orchestrator.resolveArrivals.bind(orchestrator),
        },
      })
      const driving = drivingTask(gateway)

      const updated = gateway.submitEvent(driving.task.taskId, inAirUpdate(driving.task.taskRevision))

      // No weather read, no prompt — and the flight update itself is untouched.
      expect(updated.task.weatherAdvisory).toBeUndefined()
      expect(updated.task.flight?.status).toBe('in-air')
    })
  })

  describe('proactive calendar conflict advisory', () => {
    /** Create → start navigation, same as the weather suite's helper. */
    function drivingTask(gateway: AgentGateway) {
      const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
      return gateway.submitAction(created.task.taskId, {
        clientRequestId: 'calendar-helper-start', expectedTaskRevision: created.task.taskRevision,
        expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation',
        componentId: 'navigation-plan', idempotencyKey: 'calendar-helper-start',
      })
    }

    function delayedUpdate(taskRevision: number, eventId = 'calendar-delayed') {
      // 21:10 landing + 15 handoff + 20 route = 21:45 home, past 豆豆's 21:30
      // bedtime story by 15 minutes (the trip's own charging is not accepted,
      // so no detour applies).
      return {
        clientRequestId: `client-${eventId}`, expectedTaskRevision: taskRevision,
        event: {
          eventId, type: 'flight.updated' as const,
          flight: {
            flightNumber: 'MU5102', status: 'delayed' as const,
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T21:10:00+08:00', terminal: 'T2',
          },
          timestamp: '2026-07-22T19:10:00+08:00',
        },
      }
    }

    it('stays quiet while the projected return still makes the bedtime story', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)

      // In-air with the fixture's own 20:40 estimate: home well before 21:30.
      const updated = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-calendar-in-air', expectedTaskRevision: driving.task.taskRevision,
        event: {
          eventId: 'calendar-in-air', type: 'flight.updated' as const,
          flight: {
            flightNumber: 'MU5102', status: 'in-air' as const,
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
          },
          timestamp: '2026-07-22T19:10:00+08:00',
        },
      })

      expect(updated.task.calendarAdvisory).toBeUndefined()
      expect(updated.ui.components.some((component) => component.id === 'calendar-advisory')).toBe(false)
    })

    it('raises the conflict when a delay pushes the return past the event', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)

      const updated = gateway.submitEvent(driving.task.taskId, delayedUpdate(driving.task.taskRevision))

      expect(updated.task.calendarAdvisory).toMatchObject({
        status: 'active',
        eventTitle: '豆豆的睡前故事',
        eventStartAt: '2026-07-22T21:30:00+08:00',
        lateByMinutes: 15,
      })
      const card = updated.ui.components.find((component) => component.id === 'calendar-advisory')
      if (card?.type !== 'alert') throw new Error('expected the calendar conflict alert card')
      expect(card.props.title).toContain('豆豆的睡前故事')
      expect(card.props.message).toContain('15 分钟')
      expect(card.actions).toEqual(['view-calendar', 'dismiss-advisory-calendar'])
      expect(updated.ui.actions.map((action) => action.id)).toEqual(['view-calendar', 'dismiss-advisory-calendar'])

      // Persisted, not a transient answer: it survives an unrelated recompose.
      const moving = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-calendar-moving', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'calendar-moving', type: 'vehicle.moving', speedKph: 60, timestamp: '2026-07-22T19:11:00+08:00' },
      })
      expect(moving.ui.components.some((component) => component.id === 'calendar-advisory')).toBe(true)
    })

    it('retires the conflict for good on 保持当前计划', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)
      const updated = gateway.submitEvent(driving.task.taskId, delayedUpdate(driving.task.taskRevision))

      const kept = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-keep-plan', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'keep-plan', type: 'user.input', text: '保持当前计划', timestamp: '2026-07-22T19:12:00+08:00' },
      })

      expect(kept.task.calendarAdvisory).toMatchObject({ status: 'dismissed' })
      expect(kept.ui.components.some((component) => component.id === 'calendar-advisory')).toBe(false)

      // Dismissed means never again — a later delayed beat must not re-raise.
      const again = gateway.submitEvent(driving.task.taskId, delayedUpdate(kept.task.taskRevision, 'calendar-delayed-again'))
      expect(again.task.calendarAdvisory).toMatchObject({ status: 'dismissed' })
      expect(again.ui.components.some((component) => component.id === 'calendar-advisory')).toBe(false)
    })

    it('answers 查看安排 from the conflict card with the schedule the trip already read', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)
      const updated = gateway.submitEvent(driving.task.taskId, delayedUpdate(driving.task.taskRevision))

      const viewed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-view-from-conflict', expectedTaskRevision: updated.task.taskRevision,
        event: { eventId: 'view-from-conflict', type: 'user.input', text: '查看日程', timestamp: '2026-07-22T19:12:00+08:00' },
      })

      const card = viewed.ui.components.find((component) => component.id === 'schedule-card')
      if (card?.type !== 'schedule-card') throw new Error('expected the schedule card')
      // The card carries the same at-risk judgement the advisory was raised on.
      expect(card.props.events).toEqual([
        expect.objectContaining({ title: '豆豆的睡前故事', atRisk: true }),
      ])
    })

    it('lets the rain advisory keep the rail when both are active', () => {
      const gateway = createGateway()
      const driving = drivingTask(gateway)

      // One update carries both conditions: a delayed flight into rain. The
      // arrival window firmed up late AND wet — but only in-air raises the
      // weather advisory, so drive the delay first, then the in-air beat.
      const delayed = gateway.submitEvent(driving.task.taskId, delayedUpdate(driving.task.taskRevision))
      expect(delayed.task.calendarAdvisory).toMatchObject({ status: 'active' })

      const rained = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-both-in-air', expectedTaskRevision: delayed.task.taskRevision,
        event: {
          eventId: 'both-in-air', type: 'flight.updated' as const,
          flight: {
            flightNumber: 'MU5102', status: 'in-air' as const,
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T21:10:00+08:00', terminal: 'T2',
          },
          timestamp: '2026-07-22T19:15:00+08:00',
        },
      })

      expect(rained.task.weatherAdvisory).toMatchObject({ status: 'active' })
      expect(rained.task.calendarAdvisory).toMatchObject({ status: 'active' })
      // The rail shows the rain (it has a send behind it); the conflict waits.
      expect(rained.ui.components.some((component) => component.id === 'weather-advisory')).toBe(true)
      expect(rained.ui.components.some((component) => component.id === 'calendar-advisory')).toBe(false)

      // 暂不处理 retires both prompts: the words answer whatever is asking.
      const dismissed = gateway.submitEvent(driving.task.taskId, {
        clientRequestId: 'client-both-dismiss', expectedTaskRevision: rained.task.taskRevision,
        event: { eventId: 'both-dismiss', type: 'user.input', text: '暂不处理', timestamp: '2026-07-22T19:16:00+08:00' },
      })
      expect(dismissed.task.weatherAdvisory).toMatchObject({ status: 'dismissed' })
      expect(dismissed.task.calendarAdvisory).toMatchObject({ status: 'dismissed' })
    })
  })
})

function returningTask(gateway: AgentGateway) {
  const created = gateway.createTask(createRequest('接妈妈和豆豆，航班 MU5102'))
  const started = gateway.submitAction(created.task.taskId, {
    clientRequestId: 'returning-helper-start', expectedTaskRevision: created.task.taskRevision,
    expectedUiRevision: created.ui.uiRevision, actionId: 'start-navigation',
    componentId: 'navigation-plan', idempotencyKey: 'returning-helper-start',
  })
  const approaching = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'returning-helper-geofence', expectedTaskRevision: started.task.taskRevision,
    event: { eventId: 'returning-helper-geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
  })
  const waiting = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'returning-helper-parked', expectedTaskRevision: approaching.task.taskRevision,
    event: { eventId: 'returning-helper-parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
  })
  return gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'returning-helper-onboard', expectedTaskRevision: waiting.task.taskRevision,
    event: { eventId: 'returning-helper-onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
  })
}

function completeTask(gateway: AgentGateway, navigationIdempotencyKey = 'start-navigation-001') {
  const created = gateway.createTask(createRequest())
  const prepared = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-flight', expectedTaskRevision: 0,
    event: { eventId: 'flight-number', type: 'user.input', text: 'MU5102', timestamp: '2026-07-22T12:01:00+08:00' },
  })
  const started = gateway.submitAction(created.task.taskId, {
    clientRequestId: 'client-start-navigation', expectedTaskRevision: prepared.task.taskRevision,
    expectedUiRevision: prepared.ui.uiRevision, actionId: 'start-navigation', componentId: 'navigation-plan', idempotencyKey: navigationIdempotencyKey,
  })
  const approaching = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-geofence', expectedTaskRevision: started.task.taskRevision,
    event: { eventId: 'geofence', type: 'vehicle.entered-airport-geofence', timestamp: '2026-07-22T12:02:00+08:00' },
  })
  const waiting = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-parked', expectedTaskRevision: approaching.task.taskRevision,
    event: { eventId: 'parked', type: 'vehicle.parked', timestamp: '2026-07-22T12:03:00+08:00' },
  })
  const returning = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-onboard', expectedTaskRevision: waiting.task.taskRevision,
    event: { eventId: 'onboard', type: 'user.confirmed-passengers-onboard', timestamp: '2026-07-22T12:04:00+08:00' },
  })
  const completed = gateway.submitEvent(created.task.taskId, {
    clientRequestId: 'client-arrived', expectedTaskRevision: returning.task.taskRevision,
    event: { eventId: 'arrived', type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T12:05:00+08:00' },
  })

  expect(completed.task.pendingConfirmation).toMatchObject({ action: 'save-memory' })
  return completed.task
}
