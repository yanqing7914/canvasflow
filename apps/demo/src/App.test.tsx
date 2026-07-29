import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { applyEvent, createInitialTask } from '@canvasflow/agent'
import type { AgentResponse, AirportPickupEvent, AirportPickupTaskState, TaskUpdateEnvelope, UISpec, VehicleContext } from '@canvasflow/schema'
import { estimateFinalBatteryPercent, vehicleSnapshots } from '@canvasflow/tools'
import { composePickupSpec } from '@canvasflow/ui'
import { createFakeSpeech } from './test/speech'

describe('demo integration', () => {
  /**
   * Engineering metadata and the demo player live in the controls drawer, never on
   * the driver-facing brief. Tests that assert a raw phase or press 推进下一事件
   * have to open it first, exactly as an engineer would.
   */
  async function openControls(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '打开演示控制' }))
    return screen.getByRole('dialog', { name: '演示控制' })
  }

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

  it('does not fabricate a task before the Agent API creates one', async () => {
    const user = userEvent.setup()
    const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<App api={api} />)

    // With no task there is no phase to name, so the brief says what it waits for
    // rather than borrowing a phase label it does not have.
    expect(screen.getByText('等待创建任务')).toBeInTheDocument()
    expect(screen.getByText('告诉我接谁，我来安排这趟行程。')).toBeInTheDocument()
    expect(screen.queryByText('status-banner')).not.toBeInTheDocument()

    const drawer = await openControls(user)
    expect(drawer).toHaveTextContent('尚无任务')
    expect(screen.getByRole('button', { name: /推进下一事件/ })).toBeDisabled()
  })

  it('applies newer validated task snapshots received over SSE and closes the stream on unmount', async () => {
    const initial = apiResponse(createInitialTask('pickup-sse', '2026-07-22T12:00:00+08:00'))
    const updatedTask = {
      ...initial.task,
      taskRevision: initial.task.taskRevision + 1,
      phase: 'preparing' as const,
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: {
        flightNumber: 'MU5102', trusted: false, status: 'scheduled' as const,
        scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
      },
    }
    const update: TaskUpdateEnvelope = {
      type: 'task.updated', cursor: 2, taskId: 'pickup-sse', snapshot: { task: updatedTask, ui: composePickupSpec(updatedTask) },
    }
    let onUpdate: ((value: TaskUpdateEnvelope) => void) | undefined
    const close = vi.fn()
    const api = {
      create: vi.fn().mockResolvedValue(initial), event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
      subscribeTaskUpdates: vi.fn((_taskId: string, callback: (value: TaskUpdateEnvelope) => void) => {
        onUpdate = callback
        return { close }
      }),
    }
    const user = userEvent.setup()
    const rendered = render(<App api={api} />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    const drawer = await openControls(user)
    await waitFor(() => expect(api.subscribeTaskUpdates).toHaveBeenCalledWith('pickup-sse', expect.any(Function)))
    act(() => {
      onUpdate!(update)
      onUpdate!({ ...update, cursor: 1, snapshot: { task: initial.task, ui: initial.ui } })
    })

    // The newer snapshot lands and the replayed older cursor is ignored, so the
    // revision stays at the value the newer snapshot carried.
    await waitFor(() => expect(drawer).toHaveTextContent('preparing'))
    expect(drawer).toHaveTextContent('taskRevision 1')
    expect(screen.getByText('准备出发')).toBeInTheDocument()
    rendered.unmount()
    expect(close).toHaveBeenCalledOnce()
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

    await openControls(user)
    const advance = screen.getByRole('button', { name: /推进下一事件/ })
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
    const drawer = await openControls(user)
    const advance = screen.getByRole('button', { name: /推进下一事件/ })
    // The raw phase is drawer-only; the driver reads 准备接机 on the brief instead.
    expect(drawer).toHaveTextContent('collecting-information')
    expect(screen.getByText('准备接机')).toBeInTheDocument()

    await user.click(advance) // passengers
    await user.click(advance) // flight → preparing
    expect(drawer).toHaveTextContent('preparing')
    expect(screen.getByText('准备出发')).toBeInTheDocument()

    await user.click(advance) // charging recommend
    // The card is identified by what the driver reads, not by its component type: the
    // renderer no longer prints schema vocabulary on the task surface.
    expect(document.querySelector('[data-component-type="charging-recommendation"]')).toBeInTheDocument()
    expect(screen.getByLabelText('电量从 42% 到 18%')).toBeInTheDocument()
    expect(screen.getByText('18%')).toBeInTheDocument()

    await user.click(advance) // navigation.started
    expect(drawer).toHaveTextContent('driving-to-airport')
    expect(screen.getByText('途中')).toBeInTheDocument()
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

    const drawer = await openControls(user)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await user.clear(screen.getByLabelText('任务输入'))
    await user.type(screen.getByLabelText('任务输入'), 'MU5102')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(drawer).toHaveTextContent('preparing'))
    await user.click(screen.getByRole('button', { name: '开始导航' }))
    await waitFor(() => expect(drawer).toHaveTextContent('driving-to-airport'))

    const advance = screen.getByRole('button', { name: /推进下一事件/ })
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
    await screen.findByText('准备接机')
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
    await screen.findByText('准备接机')
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
    await screen.findByText('准备出发')
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
    const drawer = await openControls(user)
    await user.click(screen.getByRole('button', { name: /推进下一事件/ }))
    // An invalid step must leave the task untouched, so the revision does not move.
    expect(drawer).toHaveTextContent('taskRevision 1')
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
    expect(document.querySelector('[data-component-type="status-banner"]')).toBeInTheDocument()
    // A degraded surface must not explain itself in schema terms.
    expect(screen.queryByText('status-banner')).not.toBeInTheDocument()
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
    expect(screen.getByText('途中')).toBeInTheDocument()
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

  describe('trip brief shell', () => {
    const phaseLabels: Array<[AirportPickupTaskState['phase'], string]> = [
      ['collecting-information', '准备接机'],
      ['preparing', '准备出发'],
      ['driving-to-airport', '途中'],
      ['approaching-airport', '即将到达'],
      ['waiting-for-passengers', '等待家人'],
      ['returning-home', '家人已上车'],
      ['completed', '行程结束'],
      ['cancelled', '行程已取消'],
    ]

    it.each(phaseLabels)('shows %s to the driver as %s and never as the raw phase', (phase, label) => {
      render(<App initialTask={{ ...createInitialTask(), phase }} />)

      const brief = screen.getByRole('region', { name: '当前行程' })
      expect(brief).toHaveAttribute('data-phase-label', label)
      // Query the header's phase element specifically: a card may legitimately
      // repeat the same words as its own supplied copy.
      expect(brief.querySelector('[data-phase-identity]')).toHaveTextContent(label)
      // The raw enum is engineering vocabulary; it belongs in the drawer only.
      expect(brief.textContent).not.toContain(phase)
    })

    it('keeps engineering metadata out of the brief and inside the drawer', async () => {
      const user = userEvent.setup()
      render(<App initialTask={{ ...createInitialTask(), phase: 'preparing' }} />)

      const brief = screen.getByRole('region', { name: '当前行程' })
      for (const term of ['taskRevision', 'uiRevision', 'pickup-001', 'preparing', 'full', 'normal']) {
        expect(brief.textContent).not.toContain(term)
      }

      const drawer = await openControls(user)
      expect(drawer).toHaveTextContent('preparing')
      expect(drawer).toHaveTextContent('taskRevision')
      expect(drawer).toHaveTextContent('uiRevision')
      expect(drawer).toHaveTextContent('pickup-001')
    })

    it('traps focus in the drawer, closes on Escape, and restores focus to its trigger', async () => {
      const user = userEvent.setup()
      render(<App initialTask={createInitialTask()} />)

      const trigger = screen.getByRole('button', { name: '打开演示控制' })
      await user.click(trigger)

      const drawer = screen.getByRole('dialog', { name: '演示控制' })
      const close = screen.getByRole('button', { name: '关闭演示控制' })
      expect(close).toHaveFocus()

      // Tabbing forward from the last control wraps to the first rather than
      // escaping into the brief behind the modal.
      const advance = screen.getByRole('button', { name: /推进下一事件/ })
      advance.focus()
      await user.tab()
      expect(drawer).toContainElement(document.activeElement as HTMLElement)
      await user.tab({ shift: true })
      expect(drawer).toContainElement(document.activeElement as HTMLElement)

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '打开演示控制' })).toHaveFocus()
    })

    it('reports the drawer expanded state on its trigger', async () => {
      const user = userEvent.setup()
      render(<App initialTask={createInitialTask()} />)

      const trigger = screen.getByRole('button', { name: '打开演示控制' })
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')

      await user.click(trigger)
      expect(screen.getByRole('button', { name: '收起演示控制' })).toHaveAttribute('aria-expanded', 'true')

      await user.click(screen.getByRole('button', { name: '收起演示控制' }))
      expect(screen.getByRole('button', { name: '打开演示控制' })).toHaveAttribute('aria-expanded', 'false')
    })

    it('lets the title step back into trip context once a card carries the conclusion', () => {
      const { unmount } = render(<App initialTask={createInitialTask()} />)
      // While collecting information the instruction is the conclusion, so the
      // page title leads.
      expect(document.querySelector('[data-title-role]')).toHaveAttribute('data-title-role', 'primary')
      unmount()

      // A bare task has no flight, so nothing states a conclusion yet. Give it the
      // flight the driver would have supplied by this phase.
      render(<App initialTask={{
        ...createInitialTask(),
        phase: 'driving-to-airport',
        flight: {
          flightNumber: 'MU5102', trusted: true, status: 'in-air',
          scheduledArrival: '2026-07-22T20:30:00+08:00',
          estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
        },
      }} />)
      // A flight card now states the conclusion, so the title becomes context.
      expect(document.querySelector('[data-title-role]')).toHaveAttribute('data-title-role', 'context')
      // It stays the one semantic page title either way.
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    })

    it('surfaces a failed request as an alert without turning it into a trip card', async () => {
      const user = userEvent.setup()
      const api = {
        create: vi.fn().mockRejectedValue(new Error('网关不可用')),
        event: vi.fn(),
        action: vi.fn(),
        confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('网关不可用')
      // A failure is not a journey fact, so it must not appear as a rendered card.
      expect(alert.closest('[data-component-type]')).toBeNull()
    })

    it('shows effect receipts in the drawer rather than on the brief', async () => {
      const user = userEvent.setup()
      const created = apiResponse(createInitialTask())
      const api = {
        create: vi.fn().mockResolvedValue({
          ...created,
          effects: [{ type: 'navigation.start' as const, status: 'succeeded' as const }],
        }),
        event: vi.fn(),
        action: vi.fn(),
        confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByText('准备接机')

      const brief = screen.getByRole('region', { name: '当前行程' })
      expect(brief.textContent).not.toContain('navigation.start')

      const drawer = await openControls(user)
      expect(drawer).toHaveTextContent('navigation.start:succeeded')
    })
  })

  describe('voice input', () => {
    /** Fake engine callbacks reach React from outside its event system. */
    const emit = (fn: () => void) => act(() => { fn() })

    function spokenResponse(task: AirportPickupTaskState, text: string): AgentResponse {
      return { ...apiResponse(task), assistant: { text, shouldSpeak: true } }
    }

    it('sends a confirmed transcript through the Agent API and speaks the reply', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const created = spokenResponse(createInitialTask(), '好的，请告诉我她们的航班号。')
      const create = vi.fn().mockResolvedValue(created)
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('我现在要去机场接妈妈和豆豆', true, 0.94))

      // The transcript opens the field, ready to correct.
      const input = screen.getByLabelText('任务输入')
      expect(input).toHaveValue('我现在要去机场接妈妈和豆豆')
      expect(screen.getByRole('status', { name: '语音状态' })).toHaveTextContent('已转写，确认或编辑后发送。')
      // The driver did not ask for this field, but it is theirs now: the toggle
      // reports what is on screen, so it never offers to open a second one.
      expect(screen.getByRole('button', { name: '收起文字输入' })).toHaveAttribute('aria-pressed', 'true')

      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByText('准备接机')

      // Source and confidence are reported; the meaning of the words is not.
      expect(create).toHaveBeenCalledWith('我现在要去机场接妈妈和豆豆', {
        vehicleContext: expect.anything(),
        source: 'voice',
        confidence: 0.94,
      })
      await waitFor(() => expect(speech.synthesis.spoken).toHaveLength(1))
      expect(screen.getByRole('status', { name: '语音状态' })).toHaveTextContent('好的，请告诉我她们的航班号。')
      // Nothing is waiting to be confirmed any more, so the keyboard gives the
      // space back rather than sitting there holding an empty field.
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
    })

    it('will not let the keyboard reach the previous turn while the microphone is capturing', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))

      // The captured words have not been handed back yet, so there is nothing to
      // confirm and no field to confirm it in. Opening one now would show the
      // *previous* turn's words, which 发送 would then submit as this turn.
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '改用文字输入' })).toBeDisabled()
      // With no field and no way to open one, there is no keyboard route into
      // the turn at all, so nothing can be submitted by hand.
      expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()
      expect(create).not.toHaveBeenCalled()

      // Ending the turn hands the words back, and the field arrives with them.
      emit(() => speech.engine().emit('去机场接妈妈和豆豆', true))
      const input = screen.getByLabelText('任务输入')
      expect(input).toBeEnabled()
      expect(input).toHaveValue('去机场接妈妈和豆豆')

      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByText('准备接机')
      expect(create).toHaveBeenCalledWith('去机场接妈妈和豆豆', {
        vehicleContext: expect.anything(),
        source: 'voice',
      })
    })

    it('keeps the text path closed until a submitted transcript comes back', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      let release: (value: AgentResponse) => void = () => {}
      const create = vi.fn().mockReturnValue(new Promise<AgentResponse>((resolve) => { release = resolve }))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈和豆豆', true))
      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByRole('button', { name: '正在提交语音内容' })

      // Submitting is not a reason to take the words away: they stay on screen
      // until the Gateway has actually accepted them.
      const input = screen.getByLabelText('任务输入')
      expect(input).toHaveValue('去机场接妈妈和豆豆')
      expect(screen.getByRole('form', { name: 'Agent input' }))
        .toHaveAttribute('data-voice-state', 'submitting')
      // A second 发送 mid-flight would send the same words twice.
      expect(input).toBeDisabled()
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()

      await act(async () => { release(apiResponse(createInitialTask())) })
      await screen.findByText('准备接机')
      expect(create).toHaveBeenCalledOnce()
    })

    it('treats answering by hand during playback as a barge-in', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const task = createInitialTask()
      const event = vi.fn().mockResolvedValue(apiResponse(applyEvent(task, {
        eventId: 'demo-typed-answer',
        type: 'user.input',
        text: 'MU5102',
        timestamp: new Date().toISOString(),
      })))
      const api = {
        create: vi.fn().mockResolvedValue(spokenResponse(task, '好的，请告诉我她们的航班号。')),
        event,
        action: vi.fn(),
        confirmation: vi.fn(),
      }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈和豆豆', true))
      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByRole('button', { name: '打断语音播报并重新输入' })
      const cancelledBefore = speech.synthesis.cancelled

      // Reaching for the keyboard mid-playback is allowed: voice is never the
      // only way to answer, even while the assistant still holds the turn.
      await user.click(screen.getByRole('button', { name: '改用文字输入' }))
      // Typing an answer while the car is still talking must stop the playback,
      // not talk over it.
      const input = screen.getByLabelText('任务输入')
      await user.clear(input)
      await user.type(input, 'MU5102')
      await user.click(screen.getByRole('button', { name: '发送' }))

      await waitFor(() => expect(event).toHaveBeenCalledOnce())
      expect(speech.synthesis.cancelled).toBeGreaterThan(cancelledBefore)
      expect(await screen.findByRole('button', { name: '开始语音输入' })).toBeInTheDocument()
    })

    it('sends a corrected transcript and drops the engine confidence', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接马麻', true, 0.41))

      const input = screen.getByLabelText('任务输入')
      await user.clear(input)
      await user.type(input, '去机场接妈妈')
      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByText('准备接机')

      // A hand-edited transcript is no longer the engine's guess, so no
      // confidence is claimed for it.
      expect(create).toHaveBeenCalledWith('去机场接妈妈', {
        vehicleContext: expect.anything(),
        source: 'voice',
      })
    })

    it('barges in on playback and starts a fresh recognition turn', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const api = {
        create: vi.fn().mockResolvedValue(spokenResponse(createInitialTask(), '好的，请告诉我她们的航班号。')),
        event: vi.fn(),
        action: vi.fn(),
        confirmation: vi.fn(),
      }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈和豆豆', true))
      await user.click(screen.getByRole('button', { name: '发送' }))
      const bargeIn = await screen.findByRole('button', { name: '打断语音播报并重新输入' })
      const cancelledBefore = speech.synthesis.cancelled

      await user.click(bargeIn)
      expect(speech.synthesis.cancelled).toBeGreaterThan(cancelledBefore)
      expect(speech.engines).toHaveLength(2)
      expect(speech.engine().started).toBe(1)
      expect(screen.getByRole('button', { name: '停止语音输入' })).toBeInTheDocument()
    })

    it('abandons a transcript on a second press but keeps the words in the field', async () => {
      const user = userEvent.setup()
      const create = vi.fn()
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      const speech = createFakeSpeech()
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈', true))
      await user.click(screen.getByRole('button', { name: '放弃这次语音输入' }))

      expect(screen.getByRole('button', { name: '开始语音输入' })).toBeInTheDocument()
      expect(screen.getByLabelText('任务输入')).toHaveValue('去机场接妈妈')
      expect(create).not.toHaveBeenCalled()
    })

    it('keeps a rejected transcript in the field so it can be retried as text', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const create = vi.fn()
        .mockRejectedValueOnce(new Error('temporary create failure'))
        .mockResolvedValueOnce(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈和豆豆', true))
      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByRole('alert')

      const input = screen.getByLabelText('任务输入')
      expect(input).toHaveValue('去机场接妈妈和豆豆')
      expect(speech.synthesis.spoken).toHaveLength(0)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByText('准备接机')
      expect(create).toHaveBeenCalledTimes(2)
    })

    it('explains a denied microphone and leaves the text path working', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().fail('not-allowed'))

      expect(screen.getByRole('status', { name: '语音状态' })).toHaveTextContent('麦克风权限未开启')
      expect(screen.getByRole('button', { name: '重试语音输入' })).toHaveTextContent('语音出错')

      // The text field never became unusable, so the turn can still be completed.
      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByText('准备接机')
      expect(create).toHaveBeenCalledWith('我现在要去机场接妈妈和豆豆', { vehicleContext: expect.anything() })
    })

    it('reports an empty recognition result instead of submitting nothing', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const create = vi.fn()
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().onend?.())

      expect(screen.getByRole('status', { name: '语音状态' })).toHaveTextContent('没有听到内容')
      expect(create).not.toHaveBeenCalled()
    })

    it('disables the entry point without a speech engine and keeps the text path', async () => {
      const user = userEvent.setup()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      // No `speech` prop: jsdom exposes no Web Speech API, which is the same
      // situation as a browser without it.
      render(<App api={api} />)

      const mic = screen.getByRole('button', { name: '语音入口暂不可用' })
      expect(mic).toBeDisabled()
      expect(mic).toHaveTextContent('语音不可用')

      await user.click(screen.getByRole('button', { name: '发送' }))
      await screen.findByText('准备接机')
      expect(create).toHaveBeenCalledOnce()
    })

    it('keeps the keyboard out of the way until the turn needs it', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      // A working microphone carries the turn, so the journey content keeps the
      // space the input row used to occupy.
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()

      // Voice is never the only way in: the keyboard is one press away, and
      // pressing it lands the caret in the field rather than merely revealing it.
      await user.click(screen.getByRole('button', { name: '改用文字输入' }))
      const input = screen.getByLabelText('任务输入')
      expect(input).toHaveFocus()
      expect(screen.getByRole('button', { name: '收起文字输入' })).toHaveAttribute('aria-pressed', 'true')

      // A keyboard the driver opened themselves is the one they may close again.
      await user.click(screen.getByRole('button', { name: '收起文字输入' }))
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
    })

    it('refuses to take away the only input path a failed voice turn has left', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().fail('not-allowed'))

      // The microphone is refused, so the field is the turn's only remaining
      // path. Taking it away would strand the driver, so the toggle reports
      // itself as unable to rather than silently doing nothing.
      expect(screen.getByLabelText('任务输入')).toBeEnabled()
      const toggle = screen.getByRole('button', { name: '收起文字输入' })
      expect(toggle).toBeDisabled()

      await user.click(toggle)
      expect(screen.getByLabelText('任务输入')).toBeInTheDocument()
    })

    it('states why the keyboard is the only path when voice cannot run at all', () => {
      const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      // No `speech` prop: jsdom exposes no Web Speech API at all.
      render(<App api={api} />)

      // With no voice to fail, nothing else would explain the field, so the
      // composer says why it is there instead of appearing without a reason.
      const composer = screen.getByRole('form', { name: 'Agent input' })
      expect(composer).toHaveAttribute('data-composer-reason', 'unavailable')
      expect(composer).toHaveTextContent('当前浏览器不支持语音识别，请改用文字输入。')
      // Text is the only path there is, so it cannot be dismissed.
      expect(screen.getByLabelText('任务输入')).toBeEnabled()
      expect(screen.getByRole('button', { name: '收起文字输入' })).toBeDisabled()
    })

    it('keeps an abandoned transcript on screen instead of parking it out of sight', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈', true))
      await user.click(screen.getByRole('button', { name: '放弃这次语音输入' }))

      // Leaving the voice turn keeps the words; hiding the field would keep them
      // somewhere the driver cannot see, correct, or send.
      expect(screen.getByLabelText('任务输入')).toHaveValue('去机场接妈妈')

      // Choosing to speak again is a decision to stop typing, so the field goes.
      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
    })

    it('releases the microphone when the surface unmounts', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      const rendered = render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      expect(speech.engine().started).toBe(1)

      rendered.unmount()
      expect(speech.engine().aborted).toBeGreaterThan(0)
      expect(speech.engine().onresult).toBeNull()
    })
  })
})
