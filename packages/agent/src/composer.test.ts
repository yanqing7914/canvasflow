import { describe, expect, it } from 'vitest'
import type { AirportPickupTaskState, FlightArrivalCandidate } from '@canvasflow/schema'
import {
  estimateFinalBatteryPercent,
  memberPreferences,
  meetingPointKey,
  recommendedMeetingPoints,
  vehicleSnapshots,
} from '@canvasflow/tools'
import { ASK_CHARGING_ACTION_ID, ASK_DEPARTURE_TIME_ACTION_ID, ASK_SCHEDULE_ACTION_ID, ASK_WEATHER_ACTION_ID, REMIND_LATER_ACTION_ID, VIEW_CALENDAR_ACTION_ID, applyRequestPresentation, composeAgentSpec, departurePlan, scheduleCardComponent, weatherCardComponent } from './composer'
import { applyEvent, createCockpitTask, createInitialTask } from './index'
import { ReadToolOrchestrator } from './orchestration'
import type { StoredTask } from './store'

const timestamp = '2026-07-22T20:00:00+08:00'

describe('Agent UISpec composer', () => {
  it('offers both supported airports as real agent-message actions', () => {
    const spec = composeAgentSpec(createCockpitTask('cockpit-airport', timestamp))

    expect(spec.actions).toEqual([
      expect.objectContaining({ label: '浦东机场', event: { type: 'agent-message', text: '浦东机场' } }),
      expect.objectContaining({ label: '虹桥机场', event: { type: 'agent-message', text: '虹桥机场' } }),
    ])
  })

  it('offers the real onboard business event while waiting for passengers', () => {
    const spec = composeAgentSpec({
      ...createCockpitTask('cockpit-onboard', timestamp),
      phase: 'waiting-for-passengers',
      pickupAirport: { label: '虹桥机场', code: 'SHA' },
    })

    expect(spec.components).toContainEqual(expect.objectContaining({
      id: 'passenger-status',
      actions: ['confirm-passengers-onboard'],
    }))
    expect(spec.actions).toContainEqual({
      id: 'confirm-passengers-onboard',
      label: '乘客已上车',
      style: 'primary',
      event: { type: 'agent-message', text: '家人上车' },
    })
  })

  it('offers charging as a user-invoked auxiliary action on outbound confirmation', () => {
    const reads = new ReadToolOrchestrator().resolveCockpitRoute('cockpit-charge', 'select-flight', {
      leg: 'outbound', pickupAirport: { label: '虹桥机场', code: 'SHA' }, vehicle: vehicleSnapshots.parked,
    })
    const task: AirportPickupTaskState = {
      ...createCockpitTask('cockpit-charge', timestamp),
      phase: 'confirming-outbound',
      pickupAirport: { label: '虹桥机场', code: 'SHA' },
      flight: {
        flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都', status: 'in-air',
        scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00',
        arrivalAirport: 'SHA', arrivalAirportName: '虹桥机场', terminal: 'T2', trusted: true,
      },
      navigation: { routeId: reads.route.data.routeId, destination: '虹桥机场', eta: reads.route.data.arrivalTime, status: 'planned' },
      navigationSimulation: {
        leg: 'outbound', routeId: reads.route.data.routeId, distanceKm: reads.route.data.distanceKm,
        initialBatteryPercent: reads.vehicle.data.batteryPercent,
        estimatedBatteryAtArrival: reads.route.data.estimatedBatteryAtArrival,
        profiles: { slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 }, fast: { durationSeconds: 45, displaySpeedKph: 75 } },
      },
      charging: { recommended: true, accepted: false, status: 'planned' },
    }

    const spec = composeAgentSpec(task, {
      'navigation.plan-route': reads.route,
      'vehicle.get-status': reads.vehicle,
      'charging.recommend': reads.charging,
    })

    expect(spec.components.map((component) => component.type)).toEqual(['route-confirmation'])
    expect(spec.components.find((component) => component.id === 'outbound-confirmation')).toMatchObject({ actions: ['start-outbound', ASK_CHARGING_ACTION_ID] })
    expect(spec.actions).toContainEqual(expect.objectContaining({ id: ASK_CHARGING_ACTION_ID, event: { type: 'agent-message', text: '规划充电路线' } }))
    expect(spec.actions).toContainEqual(expect.objectContaining({ id: 'start-outbound' }))
  })

  it('combines provider-backed flight, route, and charging cards while preparing', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults)

    // The pre-departure brief is a full-width stack of the three detail cards
    // plus the schedule strip. The route sketch rides inside `navigation-plan`;
    // the map earns its own column only once driving starts, where the frame has
    // room for it beside a single card. (See the split assertions in `route
    // panel` below.)
    expect(spec.components.map((component) => component.type)).toEqual(['flight-status', 'navigation-summary', 'schedule-strip'])
    expect(spec.layout).toMatchObject({
      type: 'stack',
      slots: { main: ['flight-status', 'navigation-plan', 'schedule-strip'] },
    })
    expect(spec.components).toContainEqual(expect.objectContaining({
      id: 'flight-status',
      props: expect.objectContaining({ scheduledArrival: reads.flight.scheduledArrival }),
    }))
    expect(spec.components.some((component) => component.type === 'charging-recommendation')).toBe(false)
  })

  it('lays calendar events alongside task milestones on the preparing schedule strip', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults)
    const strip = spec.components.find((component) => component.type === 'schedule-strip')

    expect(strip).toBeDefined()
    if (strip?.type !== 'schedule-strip') throw new Error('expected a schedule-strip component')
    // MU5102 lands 20:40; handoff (15) + return drive (20) + charging impact land
    // the projected home arrival before 豆豆's 21:30 story, so the calendar entry
    // must stay quiet rather than cry wolf.
    expect(strip.props.milestones).toEqual([
      expect.objectContaining({ label: 'MU5102 落地', time: reads.flight.estimatedArrival, kind: 'task', status: 'next' }),
      expect.objectContaining({ label: '预计到家', kind: 'task', status: 'upcoming' }),
      expect.objectContaining({ label: '豆豆的睡前故事', time: '2026-07-22T21:30:00+08:00', kind: 'calendar', status: 'upcoming' }),
      expect.objectContaining({ label: '项目评审', time: '2026-07-22T21:40:00+08:00', kind: 'calendar', status: 'upcoming' }),
    ])
    // Next-day fixtures must never leak onto today's band.
    expect(strip.props.milestones.map((milestone) => milestone.label)).not.toContain('家庭早餐')
  })

  it('marks a calendar entry at risk when the delayed flight pushes homecoming past it', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5103')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults)
    const strip = spec.components.find((component) => component.type === 'schedule-strip')

    if (strip?.type !== 'schedule-strip') throw new Error('expected a schedule-strip component')
    // MU5103's 21:10 landing cannot reach home before the 21:30 story.
    expect(strip.props.milestones).toContainEqual(
      expect.objectContaining({ label: '豆豆的睡前故事', kind: 'calendar', status: 'at-risk' }),
    )
  })

  it('carries the strip at-risk judgement onto the schedule query card', () => {
    // Same trip whose strip marks the story at risk (MU5103 lands 21:10): a
    // schedule query during it must tell the same story, from the same sum.
    const orchestrator = new ReadToolOrchestrator()
    const reads = orchestrator.prepareTrip('pickup-001', 'request-001', 'MU5103')
    const query = orchestrator.resolveSchedule('pickup-001', 'request-002', { date: '2026-07-22' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task, { ...reads.toolResults, 'calendar.query': query })
    const card = spec.components.find((component) => component.type === 'schedule-card')

    if (card?.type !== 'schedule-card') throw new Error('expected a schedule-card component')
    expect(card.props.events).toContainEqual(
      expect.objectContaining({ title: '豆豆的睡前故事', atRisk: true }),
    )
  })

  it('composes without a schedule strip when the calendar read is absent', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const withoutCalendar = { ...reads.toolResults }
    delete withoutCalendar['calendar.list-upcoming']
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task, withoutCalendar)

    expect(spec.components.map((component) => component.type)).toEqual(['flight-status', 'navigation-summary'])
  })

  it('lets a weather reading borrow the schedule strip slot on the four-card preparing brief', () => {
    const orchestrator = new ReadToolOrchestrator()
    const reads = orchestrator.prepareTrip('pickup-001', 'request-001', 'MU5102')
    const weather = orchestrator.resolveWeather('pickup-001', 'request-001', { locationId: 'destination-hongqiao-t2' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const without = composeAgentSpec(task, reads.toolResults)
    const spec = composeAgentSpec(task, { ...reads.toolResults, 'weather.get-current': weather })

    // Same card count: the query borrows the auxiliary band's slot, it does not
    // grow a brief that already runs at the four-card budget.
    expect(spec.components).toHaveLength(without.components.length)
    expect(spec.components.some((component) => component.type === 'schedule-strip')).toBe(false)
    const card = spec.components.find((component) => component.type === 'weather-card')
    if (card?.type !== 'weather-card') throw new Error('expected a weather-card component')
    expect(card.props).toMatchObject({
      location: '虹桥机场 T2',
      timeLabel: '20:40 到达时',
      condition: 'light-rain',
      conditionLabel: '小雨',
      advisory: expect.stringContaining('室内等候'),
      freshness: 'fixture',
    })
  })

  it('lets cockpit weather pin the reading to now without changing the legacy arrival label', () => {
    const orchestrator = new ReadToolOrchestrator()
    const reads = orchestrator.prepareTrip('pickup-001', 'request-001', 'MU5102')
    const weather = orchestrator.resolveWeather('pickup-001', 'request-001', { locationId: 'destination-hongqiao-t2' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: {
        flightNumber: reads.flight.flightNumber,
        status: reads.flight.status,
        scheduledArrival: reads.flight.scheduledArrival,
        estimatedArrival: reads.flight.estimatedArrival,
        terminal: reads.flight.terminal,
      },
    }

    const legacy = weatherCardComponent(task, weather.data)
    const cockpit = weatherCardComponent(task, weather.data, { timeLabel: '现在' })

    if (legacy.type !== 'weather-card' || cockpit.type !== 'weather-card') throw new Error('expected weather cards')
    expect(legacy.props.timeLabel).toBe('20:40 到达时')
    expect(cockpit.props.timeLabel).toBe('现在')
  })

  it('appends the weather card and extends the split layout while driving', () => {
    const orchestrator = new ReadToolOrchestrator()
    const weather = orchestrator.resolveWeather('pickup-001', 'request-001', { locationId: 'destination-hongqiao-t2' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      navigation: { routeId: 'route-airport-1', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
    }

    const spec = composeAgentSpec(task, { 'weather.get-current': weather })

    const card = spec.components.find((component) => component.type === 'weather-card')
    expect(card).toBeDefined()
    // The split layout must reference the appended card exactly once or the
    // spec parse fails outright; pin where it landed.
    if (spec.layout.type === 'split') {
      expect(spec.layout.slots.secondary).toContain('weather-card')
    } else {
      expect(spec.layout.slots).toMatchObject({ main: expect.arrayContaining(['weather-card']) })
    }
  })

  it('pins the reading to the moment without a flight arrival to anchor on', () => {
    const orchestrator = new ReadToolOrchestrator()
    const weather = orchestrator.resolveWeather('pickup-001', 'request-001', { locationId: 'destination-home' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'waiting-for-passengers' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }

    const spec = composeAgentSpec(task, { 'weather.get-current': weather })

    const card = spec.components.find((component) => component.type === 'weather-card')
    if (card?.type !== 'weather-card') throw new Error('expected a weather-card component')
    expect(card.props.timeLabel).toBe('现在')
    // Cloudy needs no advisory line; an empty suggestion must not render as one.
    expect(card.props.advisory).toBeUndefined()
  })

  it('composes no weather card when there is no weather reading', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'waiting-for-passengers' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }

    const spec = composeAgentSpec(task, {})

    expect(spec.components.some((component) => component.type === 'weather-card')).toBe(false)
  })

  it('lets a schedule query borrow the strip slot on the four-card preparing brief', () => {
    const orchestrator = new ReadToolOrchestrator()
    const reads = orchestrator.prepareTrip('pickup-001', 'request-001', 'MU5102')
    const query = orchestrator.resolveSchedule('pickup-001', 'request-001', { date: '2026-07-22' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const without = composeAgentSpec(task, reads.toolResults)
    const spec = composeAgentSpec(task, { ...reads.toolResults, 'calendar.query': query })

    expect(spec.components).toHaveLength(without.components.length)
    expect(spec.components.some((component) => component.type === 'schedule-strip')).toBe(false)
    const card = spec.components.find((component) => component.type === 'schedule-card')
    if (card?.type !== 'schedule-card') throw new Error('expected a schedule-card component')
    expect(card.props.events).toEqual([
      expect.objectContaining({ title: '豆豆的睡前故事', location: '家' }),
      expect.objectContaining({ title: '项目评审', location: '线上' }),
    ])
    expect(card.props.emptyCopy).toBeUndefined()
  })

  it('answers an empty schedule day with the empty copy instead of dropping the card', () => {
    const orchestrator = new ReadToolOrchestrator()
    const query = orchestrator.resolveSchedule('pickup-001', 'request-001', { date: '2026-07-24' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'waiting-for-passengers' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }

    const spec = composeAgentSpec(task, { 'calendar.query': query })

    const card = spec.components.find((component) => component.type === 'schedule-card')
    if (card?.type !== 'schedule-card') throw new Error('expected a schedule-card component')
    expect(card.props.events).toEqual([])
    expect(card.props.emptyCopy).toBe('今天没有更多安排了')
    expect(card.props.moreCount).toBeUndefined()
  })

  it('caps the schedule card at four rows and reports the tail as a count', () => {
    const events = Array.from({ length: 6 }, (_, index) => ({
      eventId: `event-${index}`,
      title: `安排 ${index}`,
      startAt: `2026-07-22T1${index}:00:00+08:00`,
    }))
    const card = scheduleCardComponent(events)

    if (card.type !== 'schedule-card') throw new Error('expected a schedule-card component')
    expect(card.props.events).toHaveLength(4)
    expect(card.props.events[0]!.title).toBe('安排 0')
    expect(card.props.moreCount).toBe(2)
  })

  it('extends the split layout when the schedule card appends while driving', () => {
    const orchestrator = new ReadToolOrchestrator()
    const query = orchestrator.resolveSchedule('pickup-001', 'request-001', { date: '2026-07-22' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      navigation: { routeId: 'route-airport-1', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
    }

    const spec = composeAgentSpec(task, { 'calendar.query': query })

    expect(spec.components.some((component) => component.type === 'schedule-card')).toBe(true)
    if (spec.layout.type === 'split') {
      expect(spec.layout.slots.secondary).toContain('schedule-card')
    } else {
      expect(spec.layout.slots).toMatchObject({ main: expect.arrayContaining(['schedule-card']) })
    }
  })

  it('offers the pre-departure question on the card that carries the eta', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults)

    expect(spec.components).toContainEqual(expect.objectContaining({
      id: 'navigation-plan',
      actions: [ASK_DEPARTURE_TIME_ACTION_ID, ASK_CHARGING_ACTION_ID],
    }))
    // Ordinary user input, so the button and the spoken sentence reach the same
    // planner branch instead of the button needing a path of its own.
    expect(spec.actions).toContainEqual({
      id: ASK_DEPARTURE_TIME_ACTION_ID,
      label: '什么时候出发',
      style: 'secondary',
      event: { type: 'agent-message', text: '什么时候出发' },
    })
    expect(spec.actions).toContainEqual({ id: ASK_CHARGING_ACTION_ID, label: '规划充电', style: 'secondary', event: { type: 'agent-message', text: '规划充电路线' } })
  })

  it('works the departure time backwards from the landing it is timed against', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
    }

    // MU5102 lands 20:40; the planned drive is 20 minutes; the buffer is 10.
    expect(departurePlan(task, reads.route)).toEqual({
      departAtLabel: '20:10',
      arrivalLabel: 'MU5102 20:40 落地',
      driveMinutes: 20,
      bufferMinutes: 10,
      viaLabel: reads.route.summary,
    })
  })

  it('declines to invent a departure time with nothing to work backwards from', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const flight = { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, arrivalAirport: reads.flight.arrivalAirport, terminal: reads.flight.terminal }
    const base = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }

    expect(departurePlan(base, reads.route)).toBeUndefined()
    expect(departurePlan({ ...base, flight }, undefined)).toBeUndefined()
  })

  it('answers the departure question in the auxiliary slot only when the turn asked', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const quiet = composeAgentSpec(task, reads.toolResults)
    const asked = composeAgentSpec(task, reads.toolResults, undefined, { queryAnswer: 'departure' })

    expect(quiet.components.some((component) => component.type === 'departure-plan')).toBe(false)
    // Borrows the auxiliary band rather than growing the brief.
    expect(asked.components).toHaveLength(quiet.components.length)
    expect(asked.components.some((component) => component.type === 'schedule-strip')).toBe(false)
    const card = asked.components.find((component) => component.type === 'departure-plan')
    if (card?.type !== 'departure-plan') throw new Error('expected a departure-plan component')
    expect(card.props).toMatchObject({ departAtLabel: '20:10', driveMinutes: 20, bufferMinutes: 10 })
  })

  it('offers the two side scenes on the driving brief', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
    }

    const spec = composeAgentSpec(task, {})

    expect(spec.components).toContainEqual(expect.objectContaining({
      id: 'navigation-summary',
      actions: [ASK_WEATHER_ACTION_ID, ASK_SCHEDULE_ACTION_ID, ASK_CHARGING_ACTION_ID],
    }))
    // The label is the sentence, so the button teaches the voice command.
    expect(spec.actions).toEqual([
      { id: ASK_WEATHER_ACTION_ID, label: '看下天气', style: 'secondary', event: { type: 'agent-message', text: '看下天气' } },
      { id: ASK_SCHEDULE_ACTION_ID, label: '看看日程', style: 'secondary', event: { type: 'agent-message', text: '看看日程' } },
      { id: ASK_CHARGING_ACTION_ID, label: '规划充电', style: 'secondary', event: { type: 'agent-message', text: '规划充电路线' } },
    ])
  })

  it('keeps both side scenes offered while one of them is being answered', () => {
    const orchestrator = new ReadToolOrchestrator()
    const weather = orchestrator.resolveWeather('pickup-001', 'request-001', { locationId: 'destination-hongqiao-t2' })
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
    }

    const spec = composeAgentSpec(task, { 'weather.get-current': weather })

    // Reading the weather must not cost the driver the way back to the calendar.
    expect(spec.actions.map((action) => action.id)).toEqual([ASK_WEATHER_ACTION_ID, ASK_SCHEDULE_ACTION_ID, ASK_CHARGING_ACTION_ID])

    // Underway the rail beside the map holds exactly one card — that is what makes
    // the panel read as floating over the map instead of as a second column. So the
    // answer takes the brief's slot rather than joining it, and it carries the brief's
    // buttons across: the way to the other scene is not what asking costs.
    const answer = spec.components.find((component) => component.type === 'weather-card')
    expect(answer).toBeDefined()
    expect(answer!.actions).toEqual([ASK_WEATHER_ACTION_ID, ASK_SCHEDULE_ACTION_ID, ASK_CHARGING_ACTION_ID])
    expect(spec.components.some((component) => component.id === 'navigation-summary')).toBe(false)
    const layout = spec.layout
    if (layout?.type !== 'split') throw new Error(`expected a split layout underway, got ${layout?.type}`)
    expect(layout.slots.secondary).toEqual([answer!.id])
  })

  it('leaves an answer that has its own controls holding them when it takes the rail', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'active' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults, undefined, { queryAnswer: 'departure' })

    // The rail hands its side-scene buttons to a reading, which has nothing of its
    // own to put there. It must not hand them to the departure answer: 稍后提醒 and
    // 查看日程 are the controls that question was asked to reach, and a card whose
    // own actions are defined in the spec and referenced by nothing is the same as
    // not having built them.
    //
    // The gateway never composes this state — 什么时候出发 underway is answered with
    // the arrival instead, since the recommendation was worked backwards from the
    // landing (see the departure query's `hasDeparted` turn). This pins the branch
    // so that stays a routing decision rather than the only thing holding it up.
    const answer = spec.components.find((component) => component.type === 'departure-plan')
    expect(answer).toBeDefined()
    expect(answer!.actions).toEqual([REMIND_LATER_ACTION_ID, VIEW_CALENDAR_ACTION_ID])
    const layout = spec.layout
    if (layout?.type !== 'split') throw new Error(`expected a split layout underway, got ${layout?.type}`)
    expect(layout.slots.secondary).toEqual([answer!.id])
    // And the way to the other scenes is still defined, so it is still reachable.
    expect(spec.actions.map((action) => action.id)).toEqual([
      ASK_WEATHER_ACTION_ID, ASK_SCHEDULE_ACTION_ID, ASK_CHARGING_ACTION_ID, REMIND_LATER_ACTION_ID, VIEW_CALENDAR_ACTION_ID,
    ])
  })

  it('keeps the schedule strip on the return trip, anchored to the home eta', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: true },
      navigation: { routeId: 'route-home-001', destination: '家', eta: '2026-07-22T21:15:00+08:00', status: 'active' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults)
    const strip = spec.components.find((component) => component.type === 'schedule-strip')

    if (strip?.type !== 'schedule-strip') throw new Error('expected a schedule-strip component')
    // Home by 21:15 keeps both evening entries quiet.
    expect(strip.props.milestones).toEqual([
      expect.objectContaining({ label: '到家', time: '2026-07-22T21:15:00+08:00', kind: 'task', status: 'next' }),
      expect.objectContaining({ label: '豆豆的睡前故事', kind: 'calendar', status: 'upcoming' }),
      expect.objectContaining({ label: '项目评审', kind: 'calendar', status: 'upcoming' }),
    ])
    // The strip is auxiliary context: it trails the passenger status, never leads it.
    expect(spec.components[0]?.type).toBe('passenger-status')
  })

  it('marks the return-trip calendar entry at risk when the home eta lands past it', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: true },
      navigation: { routeId: 'route-home-001', destination: '家', eta: '2026-07-22T21:40:00+08:00', status: 'active' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults)
    const strip = spec.components.find((component) => component.type === 'schedule-strip')

    if (strip?.type !== 'schedule-strip') throw new Error('expected a schedule-strip component')
    expect(strip.props.milestones).toContainEqual(
      expect.objectContaining({ label: '豆豆的睡前故事', kind: 'calendar', status: 'at-risk' }),
    )
  })

  it('returns home without a strip when the calendar read is absent', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const withoutCalendar = { ...reads.toolResults }
    delete withoutCalendar['calendar.list-upcoming']
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: true },
      navigation: { routeId: 'route-home-001', destination: '家', eta: '2026-07-22T21:15:00+08:00', status: 'active' as const },
    }

    const spec = composeAgentSpec(task, withoutCalendar)

    expect(spec.components.some((component) => component.type === 'schedule-strip')).toBe(false)
  })

  it('projects a scheduled landing notification into a cancellable message preview', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      message: { ...createInitialTask().message, status: 'scheduled' as const, pendingMessageId: 'MU5102:landing' },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      presentation: { density: 'minimal', priority: 'high' },
      components: [{ type: 'message-preview', props: { cancellable: true } }],
    })
  })

  it('projects a failed landing notification into an explicit retry action', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed' as const, scheduledArrival: timestamp, estimatedArrival: timestamp, terminal: 'T2' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
      message: {
        ...createInitialTask().message,
        status: 'failed' as const,
        landingNoticeSent: false,
        pendingContactId: 'contact-mom',
      },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      title: '落地通知失败',
      presentation: { density: 'minimal', priority: 'high' },
      components: [{
        id: 'message-preview',
        type: 'message-preview',
        props: { status: 'failed', cancellable: false },
        actions: ['retry-landing-message'],
      }],
      actions: [{
        id: 'retry-landing-message',
        event: { type: 'tool-request', actionToken: 'pickup-001:retry-landing-message' },
      }],
    })
  })

  it('surfaces unavailable state when failed notify has no authorized contact', () => {
    const preferences = {
      ...memberPreferences,
      mom: { ...memberPreferences.mom, landingNotificationAuthorized: false },
    }
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed' as const, scheduledArrival: timestamp, estimatedArrival: timestamp, terminal: 'T2' },
      message: {
        ...createInitialTask().message,
        status: 'failed' as const,
        landingNoticeSent: false,
        pendingContactId: 'contact-mom',
      },
    }

    expect(composeAgentSpec(task, preferences)).toMatchObject({
      title: '落地通知失败',
      components: [{
        type: 'status-banner',
        props: {
          level: 'error',
          title: '无法重试发送',
          message: '没有已授权的落地通知联系人',
        },
      }],
      actions: [],
    })
  })

  it('treats an empty second argument as an authoritative preference map', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed' as const, scheduledArrival: timestamp, estimatedArrival: timestamp, terminal: 'T2' },
      message: {
        ...createInitialTask().message,
        status: 'failed' as const,
        landingNoticeSent: false,
        pendingContactId: 'contact-mom',
      },
    }

    expect(composeAgentSpec(task, {})).toMatchObject({
      components: [{ type: 'status-banner', props: { title: '无法重试发送' } }],
      actions: [],
    })
  })

  it('projects the completion confirmation into a confirmation action', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'completed' as const,
      pendingConfirmation: { confirmationId: 'pickup-001:save-memory', action: 'save-memory' as const },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      meta: { requiresConfirm: true },
      actions: [
        { event: { type: 'confirmation', confirmationId: 'pickup-001:save-memory', decision: 'accept' } },
        { event: { type: 'confirmation', confirmationId: 'pickup-001:save-memory', decision: 'reject' } },
      ],
    })
  })

  it('keeps global confirmation actions while applying driving presentation limits', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'completed' as const,
      pendingConfirmation: { confirmationId: 'pickup-001:save-memory', action: 'save-memory' as const },
    }

    const spec = applyRequestPresentation(composeAgentSpec(task), {
      vehicle: { speedKph: 80, batteryPercent: 42, remainingRangeKm: 210, gear: 'D', isNight: false },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    })

    expect(spec.presentation).toMatchObject({ density: 'minimal', theme: 'light' })
    expect(spec.actions).toHaveLength(2)
  })

  it('keeps the map in its own column when driving policy trims the brief', () => {
    // A driving spec has a real map column; pad its rail with extra cards so the
    // minimal-density budget has something to trim.
    const base = composeAgentSpec({
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'in-air' as const, scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
    })
    // Guard: the driving brief really produced a two-column map layout to trim.
    expect(base.layout.type).toBe('split')

    const spec = applyRequestPresentation({
      ...base,
      components: [
        ...base.components,
        { id: 'extra-1', type: 'status-banner', props: { level: 'info', title: '附加一' } },
        { id: 'extra-2', type: 'status-banner', props: { level: 'info', title: '附加二' } },
      ],
      layout: { type: 'split', ratio: [1.75, 1], slots: { primary: ['route-map'], secondary: ['navigation-summary', 'extra-1', 'extra-2'] } },
    }, {
      vehicle: { speedKph: 80, batteryPercent: 42, remainingRangeKm: 210, gear: 'D', isNight: false },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    })

    // Two columns survive the trim: minimal keeps two cards, and the map is exempt
    // from that budget because it has a column of its own — so the trim takes the
    // last card off the rail rather than the map out of its slot.
    expect(spec.presentation.density).toBe('minimal')
    expect(spec.layout).toEqual({
      type: 'split',
      ratio: [1.75, 1],
      slots: { primary: ['route-map'], secondary: ['navigation-summary', 'extra-1'] },
    })
    expect(spec.components.map((component) => component.id)).toEqual(['route-map', 'navigation-summary', 'extra-1'])
  })

  it('collapses a split back to a stack when the trim empties one of its columns', () => {
    const base = composeAgentSpec(createInitialTask('pickup-001', timestamp))
    const spec = applyRequestPresentation({
      ...base,
      components: [
        { id: 'lead', type: 'status-banner', props: { level: 'info', title: '主要状态' } },
        { id: 'second', type: 'status-banner', props: { level: 'info', title: '次要状态' } },
        { id: 'aside', type: 'status-banner', props: { level: 'info', title: '边栏状态' } },
      ],
      actions: [],
      layout: { type: 'split', ratio: [1.75, 1], slots: { primary: ['lead', 'second'], secondary: ['aside'] } },
    }, {
      vehicle: { speedKph: 80, batteryPercent: 42, remainingRangeKm: 210, gear: 'D', isNight: false },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    })

    // `minimal` keeps two cards, and both of them were in the left column. Two
    // columns with nothing in one of them is a worse frame than one column.
    expect(spec.layout).toEqual({ type: 'stack', gap: 'md', slots: { main: ['lead', 'second'] } })
  })

  it('removes actions owned only by components truncated by driving policy', () => {
    const base = composeAgentSpec(createInitialTask('pickup-001', timestamp))
    const spec = applyRequestPresentation({
      ...base,
      components: [
        ...base.components,
        { id: 'primary', type: 'status-banner', props: { level: 'info', title: '主要状态' } },
        { id: 'secondary', type: 'status-banner', props: { level: 'info', title: '次要操作' }, actions: ['secondary-action'] },
      ],
      actions: [
        { id: 'secondary-action', label: '次要操作', style: 'secondary', event: { type: 'dismiss', targetId: 'secondary' } },
      ],
      layout: { type: 'stack', gap: 'md', slots: { main: [...base.components.map((component) => component.id), 'primary', 'secondary'] } },
    }, {
      vehicle: { speedKph: 80, batteryPercent: 42, remainingRangeKm: 210, gear: 'D', isNight: false },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    })

    expect(spec.components.map((component) => component.id)).not.toContain('secondary')
    expect(spec.actions).toEqual([])
  })

  it('projects the latest request-context battery into charging UI', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      charging: { recommended: true, accepted: true, status: 'completed' as const },
    }
    const spec = applyRequestPresentation(composeAgentSpec(task), {
      vehicle: { speedKph: 0, batteryPercent: 88, remainingRangeKm: 260, gear: 'P', isNight: false },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      updatedAt: '2026-07-22T20:18:00+08:00',
    })

    expect(spec.components).toContainEqual(expect.objectContaining({
      type: 'charging-recommendation',
      props: expect.objectContaining({ currentBatteryPercent: 88 }),
    }))
  })

  it('keeps original scheduledArrival separate from delayed estimatedArrival', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: {
        flightNumber: 'MU5102',
        status: 'delayed' as const,
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T21:10:00+08:00',
        terminal: 'T1',
      },
    }

    expect(composeAgentSpec(task)).toMatchObject({
      components: [{
        type: 'flight-status',
        props: {
          status: 'delayed',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T21:10:00+08:00',
          terminal: 'T1',
        },
      }],
    })
  })

  it('surfaces delayed and cancelled flight status over active navigation', () => {
    for (const status of ['delayed', 'cancelled'] as const) {
      const task = {
        ...createInitialTask('pickup-001', timestamp),
        phase: 'driving-to-airport' as const,
        passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
        flight: {
          flightNumber: 'MU5102',
          status,
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: status === 'delayed' ? '2026-07-22T21:10:00+08:00' : '2026-07-22T20:30:00+08:00',
          terminal: status === 'delayed' ? 'T1' : 'T2',
        },
        navigation: {
          routeId: 'route-airport-001',
          destination: '虹桥机场 T2',
          eta: '2026-07-22T20:25:00+08:00',
          status: 'active' as const,
        },
      }

      const spec = composeAgentSpec(task)
      expect(spec.components).toMatchObject([{
        type: 'flight-status',
        props: {
          status,
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: status === 'delayed' ? '2026-07-22T21:10:00+08:00' : '2026-07-22T20:30:00+08:00',
        },
      }])
      expect(spec.components.map((component) => component.type)).not.toContain('navigation-summary')
    }
  })

  it('does not retain a landing notification after task cancellation', () => {
    const scheduled = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      message: { ...createInitialTask().message, status: 'scheduled' as const, pendingMessageId: 'MU5102:landing' },
    }
    const cancelled = applyEvent(scheduled, { eventId: 'cancel', type: 'user.cancelled-task', timestamp: '2026-07-22T20:01:00+08:00' })

    expect(cancelled.message).toMatchObject({ status: 'cancelled', pendingMessageId: undefined })
    expect(composeAgentSpec(cancelled)).toMatchObject({
      title: '接机任务已取消',
      components: [{ type: 'status-banner', props: { title: '接机任务已取消' } }],
    })
  })
})

describe('Agent UISpec composer arrival and battery consistency', () => {
  const flight = {
    flightNumber: 'MU5102',
    status: 'landed' as const,
    scheduledArrival: '2026-07-22T20:30:00+08:00',
    estimatedArrival: '2026-07-22T20:40:00+08:00',
    arrivalAirport: 'SHA' as const,
    terminal: 'T2',
  }

  function arrivedTask(phase: 'approaching-airport' | 'waiting-for-passengers'): AirportPickupTaskState {
    return {
      ...createInitialTask('pickup-001', timestamp),
      phase,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight,
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
      // A completed charge stays `completed` for the rest of the trip. It must not
      // keep owning the brief once the car is at the airport.
      charging: { recommended: true, accepted: true, status: 'completed' },
    }
  }

  function drivingContext(batteryPercent: number, remainingRangeKm: number): StoredTask['requestContext'] {
    return {
      vehicle: { speedKph: 30, batteryPercent, remainingRangeKm, gear: 'D', isNight: true },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: false, supportsTts: true },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    }
  }

  it('shows the recommended meeting point once the car reaches the airport', () => {
    for (const [phase, label, status] of [
      ['approaching-airport', '接近接机点', 'landed'],
      ['waiting-for-passengers', '已停稳，等待家人', 'waiting'],
    ] as const) {
      const spec = composeAgentSpec(arrivedTask(phase))

      expect(spec.components, phase).toEqual([expect.objectContaining({
        type: 'passenger-status',
        props: { label, status, meetingPoint: recommendedMeetingPoints[meetingPointKey(flight.arrivalAirport, flight.terminal)]!.name },
      })])
      // The stale post-charge card is what used to occupy this screen.
      expect(spec.components.map((component) => component.type), phase).not.toContain('charging-recommendation')
    }
  })

  it('sends a 浦东 arrival to a different door than a 虹桥 arrival of the same terminal number', () => {
    // Both flights land at a "T2". They are an hour of driving apart, and the
    // terminal number alone cannot tell them apart — which is why the lookup
    // takes the airport too.
    const doorFor = (arrivalAirport: 'SHA' | 'PVG') => {
      const spec = composeAgentSpec({
        ...arrivedTask('waiting-for-passengers'),
        flight: { ...flight, arrivalAirport, terminal: 'T2' },
      })
      const card = spec.components[0]
      if (card?.type !== 'passenger-status') throw new Error('expected the passenger card')
      return card.props.meetingPoint
    }

    expect(doorFor('PVG')).toBeTruthy()
    expect(doorFor('PVG')).not.toBe(doorFor('SHA'))
    expect(doorFor('PVG')).toContain('浦东')
    expect(doorFor('SHA')).toContain('虹桥')
  })

  it('names the airport the trip is actually to in the copy around the cards', () => {
    // The heading is on screen in every phase of the drive, so a name written
    // into it rather than read off the trip would contradict the route card
    // sitting under it from the moment the board offered two airports.
    expect(composeAgentSpec(arrivedTask('approaching-airport')).title)
      .toBe('去虹桥机场接妈妈和豆豆')

    const pudong = composeAgentSpec({
      ...arrivedTask('approaching-airport'),
      flight: { ...flight, arrivalAirport: 'PVG', terminal: 'T2' },
      navigation: { routeId: 'route-airport-pvg-001', destination: '浦东机场 T2', eta: '2026-07-22T21:33:00+08:00', status: 'active' },
    })

    expect(pudong.title).toBe('去浦东机场接妈妈和豆豆')
    // Same name, from the same read, wherever the trip is named: the overview's
    // 机场 metric only reaches a screen before a flight is chosen, but it must
    // not be the one place a second answer is kept.
    const overview = composeAgentSpec({ ...createInitialTask('pickup-001', timestamp), phase: 'preparing' as const, passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false } })
      .components.find((component) => component.type === 'pickup-overview')
    if (overview?.type !== 'pickup-overview') throw new Error('expected the overview card')
    expect(overview.props.airport).toBe('虹桥机场')
  })

  it('omits the meeting point rather than guessing one for a flight whose airport is unknown', () => {
    // The locally parsed flight number does not know where the plane lands.
    // Naming a door anyway would be a confident wrong answer in the phase where
    // the driver is standing at the curb.
    const spec = composeAgentSpec({
      ...arrivedTask('waiting-for-passengers'),
      flight: { ...flight, arrivalAirport: undefined },
    })

    expect(spec.components).toEqual([expect.objectContaining({
      type: 'passenger-status',
      props: { label: '已停稳，等待家人', status: 'waiting' },
    })])
  })

  it('omits the meeting point rather than guessing one for an unknown terminal', () => {
    const spec = composeAgentSpec({
      ...arrivedTask('waiting-for-passengers'),
      flight: { ...flight, terminal: 'T9' },
    })

    expect(spec.components).toEqual([expect.objectContaining({
      type: 'passenger-status',
      props: { label: '已停稳，等待家人', status: 'waiting' },
    })])
  })

  it('reports the post-charge battery pair as one snapshot the estimator agrees with', () => {
    const spec = composeAgentSpec({
      ...arrivedTask('waiting-for-passengers'),
      phase: 'driving-to-airport',
    })
    const card = spec.components[0]
    if (card?.type !== 'charging-recommendation') throw new Error('缺少补能卡片')

    const { batteryPercent, remainingRangeKm } = vehicleSnapshots['post-charge']
    expect(card.props).toMatchObject({
      recommended: false,
      // Nothing was "restored": the charging stop is on the airport route itself.
      reason: '补能完成，机场路线上下文保持',
      currentBatteryPercent: batteryPercent,
      estimatedFinalBatteryPercent: estimateFinalBatteryPercent(batteryPercent, remainingRangeKm, 32, 32),
    })
    expect(card.props.estimatedFinalBatteryPercent).toBeLessThan(card.props.currentBatteryPercent)
  })

  it('re-derives the arrival estimate whenever it overrides the live battery reading', () => {
    const task = { ...arrivedTask('waiting-for-passengers'), phase: 'driving-to-airport' as const }

    // A full battery cannot arrive with less charge than a nearly empty one. Replacing
    // only `currentBatteryPercent` used to leave every reading claiming the same canned
    // arrival figure, so the card contradicted itself at both ends of the range.
    const readings = [[90, 240], [55, 146], [20, 53]] as const
    const cards = readings.map(([batteryPercent, remainingRangeKm]) => {
      const spec = applyRequestPresentation(composeAgentSpec(task), drivingContext(batteryPercent, remainingRangeKm))
      const card = spec.components.find((component) => component.type === 'charging-recommendation')
      if (card?.type !== 'charging-recommendation') throw new Error(`缺少补能卡片：${batteryPercent}`)
      return card.props
    })

    expect(cards.map((props) => props.currentBatteryPercent)).toEqual([90, 55, 20])
    expect(cards.map((props) => props.estimatedFinalBatteryPercent)).toEqual(
      readings.map(([batteryPercent, remainingRangeKm]) => estimateFinalBatteryPercent(batteryPercent, remainingRangeKm, 32, 32)),
    )
    for (const props of cards) {
      expect(props.estimatedFinalBatteryPercent).toBeLessThanOrEqual(props.currentBatteryPercent)
    }
    const [full, half] = cards
    expect(full!.estimatedFinalBatteryPercent).toBeGreaterThan(half!.estimatedFinalBatteryPercent)
  })

  it('leaves a provider-computed battery pair untouched when it already matches the live reading', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const vehicle = reads.toolResults['vehicle.get-status']!.data!
    const recommend = reads.toolResults['charging.recommend']!
    // The demo provider plans exactly the 32+32 km round trip the presentation
    // fallback assumes, so its answer and the fallback coincide and the guard
    // would be invisible. Stand in a provider that planned a longer trip: its
    // arrival estimate is lower than the fallback's and must survive intact,
    // because the provider knows the route and this layer only knows the demo legs.
    const providerEstimate = recommend.data!.estimatedFinalBatteryPercent - 7
    expect(providerEstimate).not.toBe(
      estimateFinalBatteryPercent(vehicle.batteryPercent, vehicle.remainingRangeKm, 32, 32),
    )
    const toolResults = {
      ...reads.toolResults,
      'charging.recommend': { ...recommend, data: { ...recommend.data!, estimatedFinalBatteryPercent: providerEstimate } },
    }
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = applyRequestPresentation(
      composeAgentSpec(task, toolResults),
      drivingContext(vehicle.batteryPercent, vehicle.remainingRangeKm),
    )
    expect(spec.components.some((component) => component.id === 'charging-plan')).toBe(false)
  })

  it('counts the charging alternatives the same density tier actually surfaces', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task)
    expect(spec.components.some((component) => component.type === 'charging-recommendation')).toBe(false)
  })
})

describe('Agent UISpec composer route sketch', () => {
  const flight = {
    flightNumber: 'MU5102',
    status: 'in-air' as const,
    scheduledArrival: '2026-07-22T20:30:00+08:00',
    estimatedArrival: '2026-07-22T20:40:00+08:00',
    terminal: 'T2',
  }

  function drivingTask(overrides: Partial<AirportPickupTaskState> = {}): AirportPickupTaskState {
    return {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'driving-to-airport' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight,
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' as const },
      ...overrides,
    }
  }

  /** The geometry the route panel carries, wherever the brief put the panel. */
  function sketchOf(spec: ReturnType<typeof composeAgentSpec>) {
    const component = spec.components.find((candidate) => candidate.type === 'route-map')
    if (component?.type !== 'route-map') throw new Error('没有路线面板')
    return component.props.routeSketch
  }

  it('carries the planned route geometry inside the pre-departure brief, with no vehicle position yet', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task, reads.toolResults)
    const sketch = navigationProps(spec, 'navigation-plan').routeSketch

    // Before departure the map has no column of its own — three wide detail cards
    // beside a 64%-width map would break the fixed frame. The planned geometry
    // rides inside the navigation card instead, and the multi-card brief keeps its
    // band hidden until the map earns its own slot once driving starts.
    expect(spec.components.some((component) => component.type === 'route-map')).toBe(false)
    expect(spec.layout.type).toBe('stack')
    expect(sketch?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥机场 T2'])
    expect(sketch?.polyline).toEqual(reads.route.polyline)
    // Nothing has departed, so no checkpoint stages a position.
    expect(sketch?.progress).toBeUndefined()
  })

  it('places the vehicle at the departure step once navigation is active', () => {
    const spec = composeAgentSpec(drivingTask())

    expect(sketchOf(spec).progress).toBe(0.08)
    expect(sketchOf(spec).polyline.length).toBeGreaterThan(1)
    // Underway, the panel follows the part of the trip the driver is on.
    expect(spec.components).toContainEqual(expect.objectContaining({
      type: 'route-map', props: expect.objectContaining({ mode: 'follow', destination: '虹桥机场 T2' }),
    }))
    expect(navigationProps(spec, 'navigation-summary').routeSketch).toBeUndefined()
  })

  it('moves the vehicle further along once charging is under way on the supercharger route', () => {
    const departed = sketchOf(composeAgentSpec(drivingTask()))
    const charging = sketchOf(composeAgentSpec(drivingTask({
      navigation: { routeId: 'route-airport-via-charge-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:37:00+08:00', status: 'active' },
      charging: { recommended: true, accepted: true, status: 'active' },
    })))

    expect(charging.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥枢纽超充站', '虹桥机场 T2'])
    expect(charging.progress).toBeGreaterThan(departed.progress!)
  })

  it('redraws the sketch on the route the reroute actually selected', () => {
    const direct = sketchOf(composeAgentSpec(drivingTask()))
    const bypass = sketchOf(composeAgentSpec(drivingTask({
      navigation: { routeId: 'route-airport-bypass-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:35:00+08:00', status: 'active' },
    })))

    expect(bypass.waypoints.map((waypoint) => waypoint.name)).toContain('外环快速路')
    expect(bypass.polyline).not.toEqual(direct.polyline)
  })

  it('keeps the navigation card whole when the active route has no sketch to draw', () => {
    const spec = composeAgentSpec(drivingTask({
      navigation: { routeId: 'route-does-not-exist', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    }))

    // Nothing to draw means no panel and no column to put it in: the card owns
    // the frame alone rather than sharing it with an empty box.
    expect(spec.components.some((component) => component.type === 'route-map')).toBe(false)
    expect(spec.layout.type).toBe('stack')
    expect(navigationProps(spec, 'navigation-summary').routeSketch).toBeUndefined()
    expect(spec.components).toContainEqual(expect.objectContaining({
      id: 'navigation-summary',
      props: expect.objectContaining({ destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00' }),
    }))
  })
})

describe('Agent UISpec composer flight choices', () => {
  const board = () => new ReadToolOrchestrator().resolveArrivals('pickup-001', 'request-001')

  function boardSpec(arrivals?: FlightArrivalCandidate[]) {
    const read = board()
    const toolResults = {
      'flight.list-arrivals': arrivals
        ? { ...read, data: { ...read.data, arrivals } }
        : read,
    }
    return composeAgentSpec(createInitialTask('pickup-001', timestamp), toolResults)
  }

  function choicesComponent(spec: ReturnType<typeof composeAgentSpec>) {
    const component = spec.components.find((candidate) => candidate.type === 'flight-choices')
    if (component?.type !== 'flight-choices') throw new Error('没有航班选择卡片')
    return component
  }

  it('offers the arrivals board instead of asking for a number', () => {
    const spec = boardSpec()
    const choices = choicesComponent(spec)

    expect(spec.components.map((component) => component.type)).toEqual(['flight-choices'])
    expect(choices.props.arrivalCityName).toBe('上海')
    // Board order is the presentation order, so the numbered rows the driver sees
    // match the numbers the fixture authored.
    expect(choices.props.choices.map((choice) => choice.flightNumber))
      .toEqual(board().data.arrivals.map((arrival) => arrival.flightNumber))
  })

  it('sends each pick back as the user saying that flight number', () => {
    const spec = boardSpec()
    const choices = choicesComponent(spec)

    // Every row's action is declared on the component (so it stays out of the
    // global bar) and defined in the spec (so the row is pressable). The refresh
    // rides on the same list for the same reason, behind the rows it re-reads.
    expect(choices.actions).toEqual([
      ...choices.props.choices.map((choice) => choice.actionId),
      choices.props.refreshActionId,
    ])
    expect(spec.actions.map((action) => action.id)).toEqual(choices.actions)
    for (const action of spec.actions) {
      expect(action.event.type).toBe('agent-message')
    }
    expect(spec.actions[0]).toMatchObject({
      id: 'pick-MU5102',
      label: '接 MU5102',
      event: { type: 'agent-message', text: '航班号 MU5102' },
    })
    // The refresh says the words too — the board is a faster way of speaking, and
    // a control that reached the Agent by some other route would be a second path
    // to keep in step with the rows.
    expect(spec.actions.at(-1)).toMatchObject({
      id: 'refresh-flight-options',
      label: '刷新航班',
      event: { type: 'agent-message', text: '刷新航班' },
    })
  })

  it('marks a revised arrival time only when the estimate moved', () => {
    const rows = choicesComponent(boardSpec()).props.choices
    const onTime = rows.find((choice) => choice.flightNumber === 'HO1252')!
    const delayed = rows.find((choice) => choice.flightNumber === 'MU5103')!

    expect(onTime.arrivalTimeLabel).toBe('20:55')
    expect(onTime.revisedTimeLabel).toBeUndefined()
    expect(delayed).toMatchObject({ arrivalTimeLabel: '20:30', revisedTimeLabel: '预计 21:10', statusLabel: '延误' })
  })

  it('leaves a cancelled arrival off the board', () => {
    const arrivals = board().data.arrivals
    const spec = boardSpec(arrivals.map((arrival, index) => index === 0 ? { ...arrival, status: 'cancelled' as const } : arrival))

    const numbers = choicesComponent(spec).props.choices.map((choice) => choice.flightNumber)
    expect(numbers).not.toContain(arrivals[0]!.flightNumber)
    expect(numbers).toHaveLength(arrivals.length - 1)
  })

  it('asks for the number when there is no board, or nothing left to choose between', () => {
    const arrivals = board().data.arrivals
    const withoutBoard = composeAgentSpec(createInitialTask('pickup-001', timestamp))
    const oneRow = boardSpec(arrivals.slice(0, 1))
    const allCancelled = boardSpec(arrivals.map((arrival) => ({ ...arrival, status: 'cancelled' as const })))

    for (const spec of [withoutBoard, oneRow, allCancelled]) {
      expect(spec.components).toEqual([
        { id: 'status-banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号' } },
      ])
      expect(spec.actions).toEqual([])
    }
  })
})

function navigationProps(spec: ReturnType<typeof composeAgentSpec>, componentId: string) {
  const component = spec.components.find((candidate) => candidate.id === componentId)
  if (component?.type !== 'navigation-summary') throw new Error(`没有导航卡片：${componentId}`)
  return component.props
}
