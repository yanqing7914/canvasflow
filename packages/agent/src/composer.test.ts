import { describe, expect, it } from 'vitest'
import type { AirportPickupTaskState } from '@canvasflow/schema'
import {
  chargingStationsForDensity,
  estimateFinalBatteryPercent,
  memberPreferences,
  recommendedMeetingPoints,
  vehicleSnapshots,
} from '@canvasflow/tools'
import { applyRequestPresentation, composeAgentSpec } from './composer'
import { applyEvent, createInitialTask } from './index'
import { ReadToolOrchestrator } from './orchestration'
import type { StoredTask } from './store'

const timestamp = '2026-07-22T20:00:00+08:00'

describe('Agent UISpec composer', () => {
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

    expect(spec.components.map((component) => component.type)).toEqual([
      'flight-status', 'navigation-summary', 'charging-recommendation',
    ])
    expect(spec.components).toContainEqual(expect.objectContaining({
      id: 'flight-status',
      props: expect.objectContaining({ scheduledArrival: reads.flight.scheduledArrival }),
    }))
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
        props: { label, status, meetingPoint: recommendedMeetingPoints[flight.terminal]!.name },
      })])
      // The stale post-charge card is what used to occupy this screen.
      expect(spec.components.map((component) => component.type), phase).not.toContain('charging-recommendation')
    }
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
    const card = spec.components.find((component) => component.id === 'charging-plan')
    if (card?.type !== 'charging-recommendation') throw new Error('缺少补能卡片')

    expect(card.props).toMatchObject({
      currentBatteryPercent: vehicle.batteryPercent,
      estimatedFinalBatteryPercent: providerEstimate,
    })
  })

  it('counts the charging alternatives the same density tier actually surfaces', () => {
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const spec = composeAgentSpec(task)
    const card = spec.components[0]
    if (card?.type !== 'charging-recommendation') throw new Error('缺少补能卡片')

    const { batteryPercent, remainingRangeKm } = vehicleSnapshots.parked
    expect(spec.presentation.density).toBe('full')
    expect(card.props).toMatchObject({
      reason: `完成往返后预计低于安全余量（对比 ${chargingStationsForDensity('full').length} 站）`,
      currentBatteryPercent: batteryPercent,
      estimatedFinalBatteryPercent: estimateFinalBatteryPercent(batteryPercent, remainingRangeKm, 32, 32),
    })
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

  function sketchOf(spec: ReturnType<typeof composeAgentSpec>, componentId: string) {
    const component = spec.components.find((candidate) => candidate.id === componentId)
    if (component?.type !== 'navigation-summary') throw new Error(`没有导航卡片：${componentId}`)
    return component.props.routeSketch
  }

  it('carries the planned route geometry while preparing, with no vehicle position yet', () => {
    const reads = new ReadToolOrchestrator().prepareTrip('pickup-001', 'request-001', 'MU5102')
    const task = {
      ...createInitialTask('pickup-001', timestamp),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: reads.flight.flightNumber, status: reads.flight.status, scheduledArrival: reads.flight.scheduledArrival, estimatedArrival: reads.flight.estimatedArrival, terminal: reads.flight.terminal },
      navigation: { routeId: reads.route.routeId, destination: '虹桥机场 T2', eta: reads.route.arrivalTime, status: 'planned' as const },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }

    const sketch = sketchOf(composeAgentSpec(task, reads.toolResults), 'navigation-plan')

    expect(sketch?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥机场 T2'])
    expect(sketch?.polyline).toEqual(reads.route.polyline)
    // Nothing has departed, so no checkpoint stages a position.
    expect(sketch?.progress).toBeUndefined()
  })

  it('places the vehicle at the departure step once navigation is active', () => {
    const sketch = sketchOf(composeAgentSpec(drivingTask()), 'navigation-summary')

    expect(sketch?.progress).toBe(0.08)
    expect(sketch?.polyline.length).toBeGreaterThan(1)
  })

  it('moves the vehicle further along once charging is under way on the supercharger route', () => {
    const departed = sketchOf(composeAgentSpec(drivingTask()), 'navigation-summary')
    const charging = sketchOf(composeAgentSpec(drivingTask({
      navigation: { routeId: 'route-airport-via-charge-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:37:00+08:00', status: 'active' },
      charging: { recommended: true, accepted: true, status: 'active' },
    })), 'navigation-summary')

    expect(charging?.waypoints.map((waypoint) => waypoint.name)).toEqual(['出发地', '虹桥枢纽超充站', '虹桥机场 T2'])
    expect(charging?.progress).toBeGreaterThan(departed!.progress!)
  })

  it('redraws the sketch on the route the reroute actually selected', () => {
    const direct = sketchOf(composeAgentSpec(drivingTask()), 'navigation-summary')
    const bypass = sketchOf(composeAgentSpec(drivingTask({
      navigation: { routeId: 'route-airport-bypass-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:35:00+08:00', status: 'active' },
    })), 'navigation-summary')

    expect(bypass?.waypoints.map((waypoint) => waypoint.name)).toContain('外环快速路')
    expect(bypass?.polyline).not.toEqual(direct?.polyline)
  })

  it('keeps the navigation card whole when the active route has no sketch to draw', () => {
    const spec = composeAgentSpec(drivingTask({
      navigation: { routeId: 'route-does-not-exist', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    }))

    expect(sketchOf(spec, 'navigation-summary')).toBeUndefined()
    expect(spec.components).toContainEqual(expect.objectContaining({
      id: 'navigation-summary',
      props: expect.objectContaining({ destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00' }),
    }))
  })
})
