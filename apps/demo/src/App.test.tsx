import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { applyEvent, createInitialTask } from '@canvasflow/agent'
import type { AgentResponse, AirportPickupEvent, AirportPickupTaskState, UISpec, VehicleContext } from '@canvasflow/schema'
import { estimateFinalBatteryPercent, vehicleSnapshots } from '@canvasflow/tools'
import { composePickupSpec } from '@canvasflow/ui'

describe('demo integration', () => {
  function apiResponse(task: AirportPickupTaskState): AgentResponse {
    const ui = composePickupSpec(task)
    const withNavigationAction = task.phase === 'preparing'
      ? {
          ...ui,
          components: ui.components.map((component) => component.id === 'flight-status'
            ? { ...component, actions: ['start-navigation'] }
            : component),
          actions: [{ id: 'start-navigation', label: '开始导航', style: 'primary' as const, event: { type: 'tool-request' as const, actionToken: 'start-navigation' } }],
        }
      : ui
    return {
      requestId: `request-${task.taskRevision}`,
      task,
      ui: withNavigationAction,
      effects: [],
      meta: { mode: 'fixture', durationMs: 1, fallbackUsed: false },
    }
  }

  it('loads the shared main-flow timeline for the demo player', () => {
    expect(mainFlowTimeline.id).toBe('main-flow')
    expect(mainFlowTimeline.steps[0]?.event.eventId).toBe('event-task-created')
    expect(mainFlowTimeline.steps.some((step) => step.event.eventId === 'event-charging-recommended')).toBe(true)

    let task = mainFlowTimeline.initialTaskState
    expect(task.phase).toBe('collecting-information')

    // Create task + resolve passengers (statePatch from shared timeline).
    task = advanceMainFlowStep(task)
    expect(task.passengers.names).toEqual(['妈妈', '豆豆'])
    expect(task.processedEventIds).toContain('event-task-created')

    // Flight number → preparing.
    task = advanceMainFlowStep(task)
    expect(task.phase).toBe('preparing')
    expect(task.flight?.flightNumber).toBe('MU5102')

    // Charging recommend step from main-flow (not a hard-coded skip-ahead).
    task = advanceMainFlowStep(task)
    expect(task.charging).toMatchObject({ recommended: true, status: 'planned' })
    expect(task.processedEventIds).toContain('event-charging-recommended')

    const chargingStep = mainFlowTimeline.steps.find((step) => step.event.eventId === 'event-charging-recommended')
    expect(chargingStep?.toolCalls).toEqual(expect.arrayContaining(['vehicle.get-status', 'charging.recommend']))
  })

  it('composes a valid UI from task state', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.surfaceId).toBe('airport-pickup-main')
    expect(spec.meta.sourceTaskRevision).toBe(spec.taskRevision)
  })

  it('shows the information request for the initial phase', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.components[0]).toMatchObject({ type: 'status-banner', props: { title: '请补充航班号' } })
  })

  it('does not fabricate a task before the Agent API creates one', () => {
    const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<App api={api} />)
    expect(screen.getByText('等待创建任务')).toBeInTheDocument()
    expect(screen.getByText('尚无任务')).toBeInTheDocument()
    expect(screen.queryByText('status-banner')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '推进下一事件' })).toBeDisabled()
  })

  it.each([
    {
      name: 'parked',
      vehicle: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false } satisfies VehicleContext,
      visibleTitle: '停车提示',
      hiddenTitle: '驾驶提示',
    },
    {
      name: 'driving',
      vehicle: { speedKph: 30, batteryPercent: 42, remainingRangeKm: 112, gear: 'D', isNight: false } satisfies VehicleContext,
      visibleTitle: '驾驶提示',
      hiddenTitle: '停车提示',
    },
  ])('passes authoritative $name context from task creation into UISpec visibility', async ({ vehicle, visibleTitle, hiddenTitle }) => {
    const user = userEvent.setup()
    const task = createInitialTask()
    const base = composePickupSpec(task)
    const ui: UISpec = {
      ...base,
      layout: { type: 'stack', gap: 'md', slots: { main: ['parked-status', 'driving-status'] } },
      components: [
        { id: 'parked-status', type: 'status-banner', visibility: 'parked-only', props: { level: 'info', title: '停车提示' } },
        { id: 'driving-status', type: 'status-banner', visibility: 'driving-only', props: { level: 'info', title: '驾驶提示' } },
      ],
    }
    const response = { ...apiResponse(task), ui }
    const create = vi.fn().mockResolvedValue(response)
    const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }

    render(<App api={api} initialVehicleContext={vehicle} />)
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText(visibleTitle)).toBeInTheDocument()
    expect(screen.queryByText(hiddenTitle)).not.toBeInTheDocument()
    expect(create).toHaveBeenCalledWith('我现在要去机场接妈妈和豆豆', { vehicleContext: vehicle })
  })

  it('updates conditional visibility after successful moving and parked sensor events', async () => {
    const user = userEvent.setup()
    let task = {
      ...createInitialTask(),
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }
    const responseWithVisibility = (current: AirportPickupTaskState): AgentResponse => {
      const response = apiResponse(current)
      return {
        ...response,
        ui: {
          ...response.ui,
          layout: { type: 'stack', gap: 'md', slots: { main: ['parked-status', 'driving-status'] } },
          components: [
            { id: 'parked-status', type: 'status-banner', visibility: 'parked-only', props: { level: 'info', title: '停车提示' } },
            { id: 'driving-status', type: 'status-banner', visibility: 'driving-only', props: { level: 'info', title: '驾驶提示' } },
          ],
        },
      }
    }
    const api = {
      create: vi.fn(async () => responseWithVisibility(task)),
      event: vi.fn(async (current: AirportPickupTaskState, event: AirportPickupEvent) => {
        task = applyEvent(current, {
          ...event,
          eventId: event.eventId ?? `event-${event.type}`,
          timestamp: event.timestamp ?? '2026-07-22T20:10:00+08:00',
        })
        return responseWithVisibility(task)
      }),
      action: vi.fn(async (current: AgentResponse) => {
        task = applyEvent(current.task, mainFlowTimeline.steps[3]!.event)
        return responseWithVisibility(task)
      }),
      confirmation: vi.fn(),
    }
    render(<App api={api} />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('停车提示')).toBeInTheDocument()

    const advance = screen.getByRole('button', { name: '推进下一事件' })
    await user.clear(screen.getByLabelText('任务输入'))
    await user.type(screen.getByLabelText('任务输入'), 'MU5102')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await user.click(screen.getByRole('button', { name: '开始导航' }))
    expect(await screen.findByText('驾驶提示')).toBeInTheDocument()
    expect(screen.queryByText('停车提示')).not.toBeInTheDocument()

    for (let index = 0; index < 7; index += 1) await user.click(advance)
    expect(api.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'vehicle.parked' }))
    expect(await screen.findByText('停车提示')).toBeInTheDocument()
    expect(screen.queryByText('驾驶提示')).not.toBeInTheDocument()
  })

  it('surfaces the terminal meeting point while approaching / waiting', () => {
    const approaching = composePickupSpec({
      ...createInitialTask(),
      phase: 'approaching-airport',
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2', baggageClaim: '12' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    })
    expect(approaching.components[0]).toMatchObject({
      type: 'passenger-status',
      props: { status: 'landed', meetingPoint: 'P2 停车场到达层 3 号门' },
    })

    const waiting = composePickupSpec({
      ...createInitialTask(),
      phase: 'waiting-for-passengers',
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2', baggageClaim: '12' },
    })
    expect(waiting.components[0]).toMatchObject({
      type: 'passenger-status',
      props: { status: 'waiting', meetingPoint: 'P2 停车场到达层 3 号门' },
    })
  })

  it('projects charging comparison station count into the recommendation reason', () => {
    const spec = composePickupSpec({
      ...createInitialTask(),
      phase: 'preparing',
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      charging: { recommended: true, accepted: false, status: 'planned' },
    })
    expect(spec.components[0]).toMatchObject({
      type: 'charging-recommendation',
      props: {
        recommended: true,
        reason: '完成往返后预计低于安全余量（对比 3 站）',
        currentBatteryPercent: vehicleSnapshots.parked.batteryPercent,
        estimatedFinalBatteryPercent: 18,
      },
    })
  })

  it('keeps preparing charging recommendation after a flight is attached', () => {
    const spec = composePickupSpec({
      ...createInitialTask(),
      phase: 'preparing',
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: {
        flightNumber: 'MU5102',
        status: 'in-air',
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T20:40:00+08:00',
        terminal: 'T2',
      },
      navigation: {
        routeId: 'route-airport-001',
        destination: '虹桥机场 T2',
        eta: '2026-07-22T20:25:00+08:00',
        status: 'active',
      },
      charging: { recommended: true, accepted: false, status: 'planned' },
    })
    expect(spec.components[0]).toMatchObject({
      type: 'charging-recommendation',
      props: { recommended: true, reason: '完成往返后预计低于安全余量（对比 3 站）' },
    })
    expect(spec.components.map((component) => component.type)).not.toContain('flight-status')
    expect(spec.components.map((component) => component.type)).not.toContain('navigation-summary')
  })

  it('surfaces delayed and cancelled flight status over active navigation', () => {
    for (const status of ['delayed', 'cancelled'] as const) {
      const spec = composePickupSpec({
        ...createInitialTask(),
        phase: 'driving-to-airport',
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
          status: 'active',
        },
        charging: { recommended: true, accepted: false, status: 'planned' },
      })
      expect(spec.components[0]).toMatchObject({
        type: 'flight-status',
        props: {
          status,
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: status === 'delayed' ? '2026-07-22T21:10:00+08:00' : '2026-07-22T20:30:00+08:00',
        },
      })
      expect(spec.components.map((component) => component.type)).not.toContain('navigation-summary')
      expect(spec.components.map((component) => component.type)).not.toContain('charging-recommendation')
    }
  })

  it('selects charging station density from parked/city/highway vehicle context', () => {
    const chargingTask = {
      ...createInitialTask(),
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      charging: { recommended: true, accepted: false, status: 'planned' as const },
    }
    const cases = [
      { snapshot: vehicleSnapshots['low-battery-parked'], density: 'full', stations: 3 },
      { snapshot: vehicleSnapshots['low-battery-city'], density: 'compact', stations: 2 },
      { snapshot: vehicleSnapshots['low-battery-highway'], density: 'minimal', stations: 1 },
    ] as const

    for (const { snapshot, density, stations } of cases) {
      const expectedFinal = estimateFinalBatteryPercent(
        snapshot.batteryPercent,
        snapshot.remainingRangeKm,
        32,
        32,
      )
      const fromVehicle = composePickupSpec(chargingTask, {
        vehicle: {
          speedKph: snapshot.speedKph,
          batteryPercent: snapshot.batteryPercent,
          remainingRangeKm: snapshot.remainingRangeKm,
        },
      })
      expect(fromVehicle).toMatchObject({
        presentation: { density },
        components: [{
          type: 'charging-recommendation',
          props: {
            reason: `完成往返后预计低于安全余量（对比 ${stations} 站）`,
            currentBatteryPercent: snapshot.batteryPercent,
            estimatedFinalBatteryPercent: expectedFinal,
          },
        }],
      })

      const fromToolResult = composePickupSpec(chargingTask, {
        toolResults: {
          'vehicle.get-status': {
            ok: true,
            data: snapshot,
          },
        },
      })
      expect(fromToolResult.presentation.density).toBe(density)
      expect(fromToolResult.components[0]).toMatchObject({
        props: {
          reason: `完成往返后预计低于安全余量（对比 ${stations} 站）`,
          currentBatteryPercent: snapshot.batteryPercent,
          estimatedFinalBatteryPercent: expectedFinal,
        },
      })
    }
  })

  it('prefers charging.recommend estimated final over recomputation', () => {
    const snapshot = vehicleSnapshots['low-battery-parked']
    const spec = composePickupSpec({
      ...createInitialTask(),
      phase: 'preparing',
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      charging: { recommended: true, accepted: false, status: 'planned' },
    }, {
      toolResults: {
        'vehicle.get-status': { ok: true, data: snapshot },
        'charging.recommend': {
          ok: true,
          data: {
            recommended: true,
            reason: '完成往返后预计低于安全余量',
            estimatedFinalBatteryPercent: 12,
            suggestedDurationMinutes: 10,
            stationId: 'station-hongqiao-01',
            etaImpactMinutes: 12,
          },
        },
      },
    })
    expect(spec.components[0]).toMatchObject({
      props: {
        currentBatteryPercent: snapshot.batteryPercent,
        estimatedFinalBatteryPercent: 12,
      },
    })
  })

  it('includes completed and cancelled terminal phases in progress', () => {
    for (const phase of ['completed', 'cancelled'] as const) {
      const spec = composePickupSpec({ ...createInitialTask(), phase })
      const progress = spec.components.find((component) => component.type === 'task-progress')
      expect(progress?.props.steps.some((step) => step.phase === phase && step.status === 'active')).toBe(true)
    }
  })

  it('keeps UI revisions ahead of task revisions', () => {
    const first = composePickupSpec(createInitialTask())
    const second = composePickupSpec({ ...createInitialTask(), taskRevision: 2, uiRevision: first.uiRevision })
    expect(second.uiRevision).toBeGreaterThan(first.uiRevision)
  })

  it('advances the rendered demo from main-flow through the charging step', async () => {
    const user = userEvent.setup()
    render(<App initialTask={mainFlowTimeline.initialTaskState} />)
    const advance = screen.getByRole('button', { name: '推进下一事件' })
    expect(screen.getByText(/collecting-information/)).toBeInTheDocument()

    await user.click(advance) // passengers
    await user.click(advance) // flight → preparing
    expect(screen.getByText(/preparing/)).toBeInTheDocument()

    await user.click(advance) // charging recommend
    expect(screen.getByText('charging-recommendation')).toBeInTheDocument()
    expect(screen.getByLabelText('当前电量 42%')).toBeInTheDocument()
    expect(screen.getByText('18%')).toBeInTheDocument()

    await user.click(advance) // navigation.started
    expect(screen.getByText(/driving-to-airport/)).toBeInTheDocument()
  })

  it('keeps the API timeline cursor synchronized and retries a failed advance', async () => {
    const user = userEvent.setup()
    let task = applyEvent(createInitialTask(), mainFlowTimeline.steps[0]!.event)
    task = {
      ...task,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
    }
    let flightUpdateAttempts = 0
    const event = vi.fn(async (current: AirportPickupTaskState, input: AirportPickupEvent) => {
      const eventId = input.eventId ?? (input.type === 'user.input' ? 'event-flight-number' : `event-${input.type}`)
      const normalized = {
        ...input,
        eventId,
        timestamp: input.timestamp ?? (input.type === 'user.input' ? '2026-07-22T20:01:00+08:00' : '2026-07-22T20:10:00+08:00'),
      } as AirportPickupEvent
      if (eventId === 'event-flight-in-air') {
        flightUpdateAttempts += 1
        if (flightUpdateAttempts === 1) throw new Error('temporary network failure')
      }
      task = applyEvent(current, normalized)
      return apiResponse(task)
    })
    const action = vi.fn(async (current: AgentResponse) => {
      task = applyEvent({
        ...current.task,
        charging: { ...current.task.charging, recommended: true, status: 'planned' },
      }, mainFlowTimeline.steps[3]!.event)
      return apiResponse(task)
    })
    const api = {
      create: vi.fn(async () => apiResponse(task)),
      event,
      action,
      confirmation: vi.fn(),
    }
    render(<App api={api} />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    await user.clear(screen.getByLabelText('任务输入'))
    await user.type(screen.getByLabelText('任务输入'), 'MU5102')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText(/preparing/)
    await user.click(screen.getByRole('button', { name: '开始导航' }))
    await screen.findByText(/driving-to-airport/)

    const advance = screen.getByRole('button', { name: '推进下一事件' })
    await user.click(advance)
    expect(event).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ eventId: 'event-charging-started', timestamp: undefined }))
    await user.click(advance)
    await screen.findByRole('alert')
    expect(event).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ eventId: 'event-flight-in-air', timestamp: undefined }))
    await user.click(advance)
    expect(flightUpdateAttempts).toBe(2)
  })

  it('serializes API mutations and disables controls while a request is pending', async () => {
    const user = userEvent.setup()
    let resolveCreate!: (response: AgentResponse) => void
    const create = vi.fn(() => new Promise<AgentResponse>((resolve) => { resolveCreate = resolve }))
    const api = {
      create,
      event: vi.fn(),
      action: vi.fn(),
      confirmation: vi.fn(),
    }
    render(<App api={api} />)

    const send = screen.getByRole('button', { name: '发送' })
    await user.click(send)
    expect(send).toBeDisabled()
    await user.click(send)
    expect(create).toHaveBeenCalledTimes(1)

    resolveCreate(apiResponse(createInitialTask()))
    await screen.findByText(/collecting-information/)
    expect(send).toBeEnabled()
  })

  it('keeps create input after a failure and allows a direct retry', async () => {
    const user = userEvent.setup()
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('temporary create failure'))
      .mockResolvedValueOnce(apiResponse(createInitialTask()))
    const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<App api={api} />)

    const input = screen.getByLabelText('任务输入')
    await user.clear(input)
    await user.type(input, '接妈妈')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByRole('alert')
    expect(input).toHaveValue('接妈妈')

    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText(/collecting-information/)
    expect(create).toHaveBeenCalledTimes(2)
    expect(input).toHaveValue('')
  })

  it('keeps event input after a failure and allows a direct retry', async () => {
    const user = userEvent.setup()
    const createdTask = {
      ...createInitialTask(),
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
    }
    const preparedTask = applyEvent(createdTask, {
      eventId: 'event-flight-number',
      type: 'user.input',
      text: 'MU5102',
      timestamp: '2026-07-22T20:01:00+08:00',
    })
    const event = vi.fn()
      .mockRejectedValueOnce(new Error('temporary event failure'))
      .mockResolvedValueOnce(apiResponse(preparedTask))
    const api = {
      create: vi.fn().mockResolvedValue(apiResponse(createdTask)),
      event,
      action: vi.fn(),
      confirmation: vi.fn(),
    }
    render(<App api={api} />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    const input = screen.getByLabelText('任务输入')
    await user.type(input, 'MU5102')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByRole('alert')
    expect(input).toHaveValue('MU5102')

    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText(/preparing/)
    expect(event).toHaveBeenCalledTimes(2)
    expect(input).toHaveValue('')
  })

  it('renders and resolves the completion confirmation action', async () => {
    const user = userEvent.setup()
    render(<App initialTask={{ ...createInitialTask(), phase: 'completed', pendingConfirmation: { confirmationId: 'pickup-001:save-memory', action: 'save-memory' } }} />)
    const save = screen.getByRole('button', { name: '保存本次偏好' })
    await user.click(save)
    expect(screen.queryByRole('button', { name: '保存本次偏好' })).not.toBeInTheDocument()
  })

  it('skips timeline events that are invalid for an injected phase', async () => {
    const user = userEvent.setup()
    render(<App initialTask={{ ...createInitialTask(), phase: 'driving-to-airport', updatedAt: '2026-07-22T20:30:00+08:00' }} />)
    await user.click(screen.getByRole('button', { name: '推进下一事件' }))
    expect(screen.getByText(/taskRevision 1/)).toBeInTheDocument()
  })

  it('renders fallback status banner without a blank screen', () => {
    render(
      <App
        composeContext={{
          fallback: { title: '界面暂时降级', message: '已切换到安全模板。', level: 'error' },
        }}
      />,
    )
    expect(screen.getByText('界面暂时降级')).toBeInTheDocument()
    expect(screen.getByText('已切换到安全模板。')).toBeInTheDocument()
    expect(screen.getByText('status-banner')).toBeInTheDocument()
  })

  it('renders media-only cabin preferences without inventing temperature', () => {
    render(
      <App
        initialTask={{
          ...createInitialTask(),
          phase: 'returning-home',
          passengers: { memberIds: ['doubao'], names: ['豆豆'], confirmedOnboard: true },
          updatedAt: '2026-07-22T20:56:00+08:00',
        }}
        composeContext={{
          toolResults: {
            'memory.get-preferences': {
              ok: true,
              data: { members: [{ memberId: 'doubao', mediaTitle: '豆豆故事' }] },
            },
          },
        }}
      />,
    )
    expect(screen.getByText('豆豆故事')).toBeInTheDocument()
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
    expect(screen.queryByText(/°C/)).not.toBeInTheDocument()
  })

  it('does not execute provider-backed failed-message retries in local-only preview mode', async () => {
    const user = userEvent.setup()
    render(
      <App
        initialTask={{
          ...createInitialTask(),
          phase: 'driving-to-airport',
          passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
          flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
          navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
          message: {
            autoNotifyAuthorized: true,
            status: 'failed',
            landingNoticeSent: false,
            pendingContactId: 'contact-mom',
          },
          updatedAt: '2026-07-22T20:41:00+08:00',
        }}
      />,
    )
    expect(screen.getByRole('button', { name: '重试发送' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试发送' }))
    expect(screen.getByRole('button', { name: '重试发送' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认发送' })).not.toBeInTheDocument()
    expect(screen.getByText(/driving-to-airport/)).toBeInTheDocument()
  })

  it('shows unavailable state instead of retry when no authorized contact remains', () => {
    render(
      <App
        initialTask={{
          ...createInitialTask(),
          phase: 'driving-to-airport',
          passengers: { memberIds: ['doubao'], names: ['豆豆'], confirmedOnboard: false },
          flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
          message: { autoNotifyAuthorized: true, status: 'failed', landingNoticeSent: false },
          updatedAt: '2026-07-22T20:41:00+08:00',
        }}
      />,
    )
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument()
    expect(screen.getByText('无法重试发送')).toBeInTheDocument()
    expect(screen.getByText('没有已授权的落地通知联系人')).toBeInTheDocument()
  })
})
