import { StrictMode, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppComponent from './App'
import { advanceMainFlowStep, mainFlowTimeline } from './main-flow'
import { applyEvent, createCockpitTask, createInitialTask } from '@canvasflow/agent'
import type { AgentResponse, AirportPickupEvent, AirportPickupTaskState, TaskUpdateEnvelope, UISpec, VehicleContext } from '@canvasflow/schema'
import { estimateFinalBatteryPercent, vehicleSnapshots } from '@canvasflow/tools'
import { composePickupSpec } from '@canvasflow/ui'
import { createFakeSpeech } from './test/speech'
import type { CockpitUISpec } from './ui/navigation/contracts'
import type { NavigationClock } from './ui/navigation/simulator'
import { AgentApiError } from './agent-client'
import type { LocalHandsFreeControllerOptions } from './voice/localHandsFreeController'

// Legacy cases intentionally start from the historical typed draft. Production
// and the dedicated empty-input test below render AppComponent directly.
function App(props: ComponentProps<typeof AppComponent>) {
  return <AppComponent initialText="我现在要去机场接妈妈和豆豆" voiceAutoSubmit={false} wakeWordEnabled={false} {...props} />
}

describe('demo integration', () => {
  it('arms the local KWS/VAD runtime instead of opening always-on Web Speech', async () => {
    const enable = vi.fn(async () => true)
    const dispose = vi.fn()
    const localHandsFreeFactory = vi.fn(() => ({
      enable,
      disable: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ state: 'ARMED' as const, enabled: true, speechActive: false })),
      turnEnded: vi.fn(),
      ttsStarted: vi.fn(),
      ttsEnded: vi.fn(),
      dispose,
    }))
    render(<AppComponent localHandsFreeFactory={localHandsFreeFactory} />)

    screen.getByRole('button', { name: '启用小南语音唤醒' }).click()

    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: '小南语音状态' })).toHaveTextContent('等待唤醒')
  })

  it('keeps local reset controls on the reset-confirmation path', async () => {
    let localOptions: LocalHandsFreeControllerOptions | undefined
    const localHandsFreeFactory = vi.fn((options: LocalHandsFreeControllerOptions) => {
      localOptions = options
      return {
        enable: vi.fn(async () => true),
        disable: vi.fn(async () => undefined),
        snapshot: vi.fn(() => ({ state: 'ARMED' as const, enabled: true, speechActive: false })),
        turnEnded: vi.fn(),
        ttsStarted: vi.fn(),
        ttsEnded: vi.fn(),
        dispose: vi.fn(),
      }
    })
    const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} localHandsFreeFactory={localHandsFreeFactory} />)

    screen.getByRole('button', { name: '启用小南语音唤醒' }).click()
    await waitFor(() => expect(localOptions).toBeDefined())
    act(() => { localOptions?.onWake?.() })

    await act(async () => {
      await expect(localOptions?.onSubmit('重新开始', {
        source: 'voice',
        recognitionSource: 'microphone',
      })).resolves.toBe(true)
    })

    expect(api.create).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '小南语音状态' })).toHaveTextContent('等待确认')
  })

  it('starts in a quiet idle cockpit without creating a task or showing a large composer', async () => {
    const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} />)
    const workspace = screen.getByTestId('cockpit-workspace')
    const map = screen.getByTestId('persistent-map-layer')
    expect(workspace).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(map).toHaveAttribute('data-mode', 'idle')
    expect(map).toHaveAttribute('data-session-key', 'cockpit-session')
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(map).toBeInTheDocument()
    // Voice-unavailable mode keeps the explicit text path open inside the
    // persistent entry slot; the idle shell must still contain no task content.
    expect(screen.getByLabelText('任务输入')).toHaveValue('')
    expect(screen.queryByText('等待创建任务')).not.toBeInTheDocument()
    expect(screen.queryByText(/航班/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('语音不可用，请用文字告诉我。')
    expect(api.create).not.toHaveBeenCalled()
  })

  it('updates the idle cockpit after shared controls change pre-task vehicle state', async () => {
    const user = userEvent.setup()
    render(<AppComponent voiceEnabled={false} initialVehicleContext={{
      speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: false,
    }} />)

    expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'light')
    expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-theme', 'light')

    await user.click(screen.getByRole('button', { name: '打开演示控制' }))
    expect(screen.getByRole('button', { name: '白天' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '夜间' }))
    expect(screen.getByRole('button', { name: '夜间' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'dark')
    expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-theme', 'dark')
  })

  it('requires Xiaonan for speech but lets explicit text send create the task', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    const created = apiResponse(createCockpitTask('wake-created'))
    const api = { create: vi.fn().mockResolvedValue(created), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.() })
    expect(screen.getAllByText('等待唤醒').length).toBeGreaterThan(0)
    act(() => { speech.engine().emit('我要去机场接人', true, 0.9) })
    expect(api.create).not.toHaveBeenCalled()
    act(() => { speech.engine().emit('小南，我要去机场接人', true, 0.51) })
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('我要去机场接人', expect.objectContaining({ source: 'voice', confidence: 0.51 })))

    const typedApi = { ...api, create: vi.fn().mockResolvedValue(created) }
    const typed = render(<AppComponent api={typedApi} voiceEnabled={false} />)
    await user.click(screen.getAllByRole('button', { name: '改用文字输入' }).at(-1)!)
    await user.type(screen.getAllByLabelText('任务输入').at(-1)!, '查天气')
    await user.click(screen.getAllByRole('button', { name: '发送' }).at(-1)!)
    typed.unmount()
    expect(typedApi.create).toHaveBeenCalledWith('查天气', expect.objectContaining({ vehicleContext: expect.anything() }))
  })

  it('accepts Chrome pinyin output for the Xiaonan wake word', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    const created = apiResponse(createCockpitTask('wake-pinyin'))
    const api = { create: vi.fn().mockResolvedValue(created), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.() })
    act(() => { speech.engine().emit('xiao n，查天气', true, 0.88) })

    await waitFor(() => expect(api.create).toHaveBeenCalledWith('查天气', expect.objectContaining({ source: 'voice' })))
  })

  it('explains that fixture replay is blocked while the wake session owns the turn', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    render(<AppComponent api={{ create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.(); speech.engine().emit('小南', true, 0.9) })
    await waitFor(() => expect(screen.getByRole('button', { name: '小南语音状态' })).toHaveTextContent('正在聆听'))

    const controls = await openControls(user)
    const replay = fixtureReplayControls().getByRole('button', { name: '模糊接机目标' })
    expect(replay).toBeDisabled()
    expect(controls).toHaveTextContent('语音回合正在进行')
    expect(controls).not.toHaveTextContent('仅在尚未创建任务时可用')
  })

  it('gives reset confirmation priority over ordinary wake command handling', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    const active = apiResponse(createCockpitTask('reset-active'))
    const cancelled = apiResponse({ ...active.task, phase: 'cancelled' })
    const api = {
      create: vi.fn().mockResolvedValue(active), event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
      cancel: vi.fn().mockResolvedValue(cancelled),
    }
    render(<AppComponent api={api} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.() })
    act(() => { speech.engine().emit('小南，我要去机场接人', true, 0.9) })
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce())
    const controls = await openControls(user)
    expect(controls).toHaveTextContent('确认机场')

    act(() => { speech.engine().emit('小南，重新开始', true, 0.9) })
    expect(screen.getAllByText('等待确认').length).toBeGreaterThan(0)
    act(() => { speech.engine().emit('小南，确定', true, 0.9) })

    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'reset-active' }), '用户确认重新开始'))
    expect(api.event).not.toHaveBeenCalled()
    expect(await screen.findByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(screen.queryByLabelText('机场接人任务')).not.toBeInTheDocument()
    expect(controls).toBeVisible()
    expect(controls).toHaveTextContent('尚无任务')
    expect(screen.getByRole('button', { name: '聚焦演示控制' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps an invalid typed reset decision available for correction', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    const active = apiResponse(createCockpitTask('reset-typed-invalid'))
    const api = {
      create: vi.fn().mockResolvedValue(active), event: vi.fn(), action: vi.fn(), confirmation: vi.fn(), cancel: vi.fn(),
    }
    render(<AppComponent api={api} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.(); speech.engine().emit('小南，我要去机场接人', true, 0.9) })
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce())
    act(() => { speech.engine().emit('小南，重新开始', true, 0.9) })

    await user.click(screen.getByRole('button', { name: '改用文字输入' }))
    const input = screen.getByLabelText('任务输入')
    await user.type(input, '稍后再说')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(input).toHaveValue('稍后再说')
    expect(screen.getAllByText('等待确认').length).toBeGreaterThan(0)
    expect(api.cancel).not.toHaveBeenCalled()
    expect(screen.getByTestId('cockpit-workspace').querySelector(
      '[data-trip-brief][data-window-title="机场接人任务"]',
    )).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, '取消')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
    expect(screen.getAllByText('等待唤醒').length).toBeGreaterThan(0)
  })

  it('retries a reset revision conflict and releases a stuck wake drain for the next task', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    const active = apiResponse(createCockpitTask('reset-pending'))
    const latest = apiResponse({ ...active.task, taskRevision: active.task.taskRevision + 1 })
    const cancelled = apiResponse({ ...latest.task, phase: 'cancelled', taskRevision: latest.task.taskRevision + 1 })
    const restarted = apiResponse(createCockpitTask('reset-restarted'))
    const event = vi.fn().mockImplementation(() => new Promise<AgentResponse>(() => {}))
    const cancel = vi.fn()
      .mockRejectedValueOnce(new AgentApiError(409, {
        requestId: 'reset-conflict',
        error: { code: 'TASK_REVISION_CONFLICT', message: '任务版本已更新', retryable: false },
        latest: { task: latest.task, ui: latest.ui },
      }))
      .mockResolvedValueOnce(cancelled)
    const api = {
      create: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(restarted),
      event, action: vi.fn(), confirmation: vi.fn(), cancel,
    }
    render(<AppComponent api={api} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.() })
    act(() => { speech.engine().emit('小南，我要去机场接人', true, 0.9) })
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce())
    act(() => { speech.engine().emit('小南，查天气', true, 0.9) })
    await waitFor(() => expect(event).toHaveBeenCalledOnce())

    act(() => { speech.engine().emit('小南，重新开始', true, 0.9) })
    act(() => { speech.engine().emit('确定', true, 0.9) })

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2))
    expect(cancel).toHaveBeenNthCalledWith(1, active.task, '用户确认重新开始')
    expect(cancel).toHaveBeenNthCalledWith(2, latest.task, '用户确认重新开始')
    expect(await screen.findByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(screen.queryByLabelText('机场接人任务')).not.toBeInTheDocument()

    act(() => { speech.engine().emit('小南，我要去机场接爸爸', true, 0.9) })
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2))
    expect(api.create).toHaveBeenLastCalledWith('我要去机场接爸爸', expect.objectContaining({ source: 'voice' }))
  })

  it('restarts continuous wake recognition after a browser-ended session', async () => {
    vi.useFakeTimers()
    const speech = createFakeSpeech()
    render(<AppComponent api={{ create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }} speech={speech.deps} />)

    act(() => { screen.getByRole('button', { name: '启用小南语音唤醒' }).click() })
    act(() => { speech.engine().onstart?.() })
    const first = speech.engine()
    act(() => { first.onend?.(); vi.advanceTimersByTime(180) })
    expect(speech.engines).toHaveLength(2)
    expect(speech.engine().started).toBe(1)
    await act(async () => {})
    vi.useRealTimers()
  })

  it('re-arms the microphone when a continuous wake restart fails', async () => {
    vi.useFakeTimers()
    try {
      const speech = createFakeSpeech()
      render(<AppComponent api={{ create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }} speech={speech.deps} />)

      act(() => { screen.getByRole('button', { name: '启用小南语音唤醒' }).click() })
      act(() => { speech.engine().onstart?.() })
      const first = speech.engine()
      speech.failNextRecognitionStarts()
      act(() => { first.onend?.(); vi.advanceTimersByTime(180) })

      const retry = screen.getByRole('button', { name: '重试语音唤醒' })
      expect(retry).toBeEnabled()
      expect(screen.getByRole('status')).toHaveTextContent('语音监听已中断')

      act(() => { retry.click() })
      expect(speech.engines).toHaveLength(2)
      act(() => { speech.engine().onstart?.() })
      expect(screen.getAllByText('等待唤醒').length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts when Chrome reports a transient network error without onend', async () => {
    vi.useFakeTimers()
    try {
      const speech = createFakeSpeech()
      render(<AppComponent api={{ create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }} speech={speech.deps} />)

      act(() => { screen.getByRole('button', { name: '启用小南语音唤醒' }).click() })
      act(() => { speech.engine().onstart?.() })
      act(() => { speech.engine().fail('network'); vi.advanceTimersByTime(180) })

      expect(speech.engines).toHaveLength(2)
      expect(speech.engine().started).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues a second wake command while the first Agent request is pending', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    let finishCreate: ((response: AgentResponse) => void) | undefined
    const created = apiResponse(createCockpitTask('queued-wake'))
    const create = vi.fn().mockImplementation(() => new Promise<AgentResponse>((resolve) => { finishCreate = resolve }))
    const event = vi.fn().mockResolvedValue(created)
    const api = { create, event, action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.() })
    act(() => { speech.engine().emit('小南，我要去机场接人', true, 0.9) })
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    act(() => { speech.engine().emit('小南，查天气', true, 0.9) })
    expect(screen.getByRole('status')).toHaveTextContent('已记住「查天气」')
    expect(event).not.toHaveBeenCalled()

    act(() => { finishCreate?.(created) })
    await waitFor(() => expect(event).toHaveBeenCalledOnce())
    expect(event.mock.calls[0]?.[1]).toMatchObject({ text: '查天气', source: 'voice' })
  })

  it('parks a rejected wake command instead of losing it', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    const recovered = apiResponse(createCockpitTask('wake-retry'))
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('语音请求失败'))
      .mockResolvedValueOnce(recovered)
    const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} speech={speech.deps} />)

    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.() })
    act(() => { speech.engine().emit('小南，我要去机场接人', true, 0.51) })

    expect(await screen.findByLabelText('任务输入')).toHaveValue('我要去机场接人')
    expect(screen.getByRole('status')).toHaveTextContent('原话已保留')
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create).toHaveBeenLastCalledWith('我要去机场接人', expect.objectContaining({
      source: 'voice', confidence: 0.51,
    }))
  })

  it('does not enable fixture replay while wake follow-up is active', async () => {
    const user = userEvent.setup()
    const speech = createFakeSpeech()
    const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} speech={speech.deps} />)
    await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
    act(() => { speech.engine().onstart?.(); speech.engine().emit('小南', true) })
    await openControls(user)
    expect(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' })).toBeDisabled()
  })

  it('keeps the flight chooser in the primary cockpit window instead of an auxiliary floating window', async () => {
    const user = userEvent.setup()
    const task = {
      ...createInitialTask(), phase: 'choosing-flight', pickupAirport: { label: '虹桥机场', code: 'SHA' },
    } as unknown as AirportPickupTaskState
    const flightComponent = {
      id: 'flight-choices-cockpit', type: 'flight-choices' as const, actions: ['pick-cockpit-MU5102'], props: {
        arrivalCityName: '虹桥机场', dateLabel: '今天', freshness: 'fixture' as const,
        choices: [
          { flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都', status: 'in-air' as const, statusLabel: '飞行中', arrivalTimeLabel: '15:30', terminal: 'T2', airportName: '虹桥机场', actionId: 'pick-cockpit-MU5102' },
          { flightNumber: 'HO1252', airlineName: '吉祥航空', originName: '广州白云', status: 'scheduled' as const, statusLabel: '计划中', arrivalTimeLabel: '16:10', terminal: 'T2', airportName: '虹桥机场', actionId: 'pick-cockpit-HO1252' },
        ],
      },
    }
    const ui = {
      ...composePickupSpec(createInitialTask()), taskId: task.taskId, taskRevision: task.taskRevision, phase: 'choosing-flight',
      layout: { type: 'stack' as const, gap: 'md' as const, slots: { main: [] } },
      components: [flightComponent],
      actions: [{ id: 'pick-cockpit-MU5102', label: '选择 MU5102', style: 'primary' as const, event: { type: 'tool-request' as const, actionToken: 'pick-cockpit-MU5102' } }],
      windows: [{ id: 'flight-list-1', kind: 'flight-list' as const, title: '虹桥机场到达航班', componentIds: [flightComponent.id], actionIds: ['pick-cockpit-MU5102'], size: 'large' as const, controls: { closable: true, minimizable: true, maximizable: true } }],
    } as unknown as CockpitUISpec
    const response = {
      requestId: 'request-cockpit-window', task, ui, effects: [],
      meta: { mode: 'fixture' as const, durationMs: 1, fallbackUsed: false },
    }
    const api = { create: vi.fn().mockResolvedValue(response), event: vi.fn(), action: vi.fn().mockResolvedValue(response), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} initialText="去机场接人" />)
    await user.click(screen.getByRole('button', { name: '发送' }))
    const surface = screen.getByRole('region', { name: '当前行程' })
    expect(surface).toContainElement(screen.getByLabelText('虹桥机场到达航班窗口'))
    expect(screen.queryByLabelText('辅助信息窗口')?.querySelector('.cockpit-window')).toBeNull()
    expect(surface).toHaveTextContent('MU5102')
    const choice = surface.querySelector<HTMLButtonElement>('[data-action-id="pick-cockpit-MU5102"]')
    expect(choice).not.toBeNull()
    await user.click(choice!)
    expect(api.action).toHaveBeenCalledWith(expect.anything(), 'pick-cockpit-MU5102', 'flight-choices-cockpit')
  })

  it('renders the outbound confirmation summary in the primary cockpit window without an auxiliary window', async () => {
    const user = userEvent.setup()
    const task = {
      ...createCockpitTask('confirm-outbound'), phase: 'confirming-outbound',
      pickupAirport: { label: '虹桥机场', code: 'SHA' },
      flight: {
        flightNumber: 'MU4490', airlineName: '东方航空', originName: '北京首都', status: 'in-air',
        scheduledArrival: '2026-08-11T15:20:00+08:00', estimatedArrival: '2026-08-11T15:30:00+08:00',
        arrivalAirport: 'SHA', arrivalAirportName: '虹桥机场', terminal: 'T2', trusted: true,
      },
      navigation: { routeId: 'outbound-route', destination: '虹桥机场', eta: '2026-08-11T14:40:00+08:00', status: 'planned' },
      navigationSimulation: {
        leg: 'outbound', routeId: 'outbound-route', distanceKm: 32, initialBatteryPercent: 42,
        estimatedBatteryAtArrival: 29, profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const composed = composePickupSpec(task) as CockpitUISpec
    const confirmationComponent = {
      id: 'outbound-confirmation', type: 'route-confirmation' as const,
      props: {
        leg: 'outbound' as const, destination: '虹桥机场', flightNumber: 'MU4490',
        flightEstimatedArrival: '2026-08-11T15:30:00+08:00', durationMinutes: 20,
        arrivalTime: '2026-08-11T14:40:00+08:00', distanceKm: 32,
        currentBatteryPercent: 42, estimatedBatteryAtArrival: 29, simulated: true as const,
      },
    }
    const ui = {
      ...composed,
      components: [...composed.components, confirmationComponent],
      actions: [{ id: 'start-outbound', label: '现在出发', style: 'primary' as const, event: { type: 'tool-request' as const, actionToken: 'start-outbound' } }],
      windows: [{ id: 'outbound-confirmation-1', kind: 'outbound-confirmation' as const, title: '现在出发', componentIds: [confirmationComponent!.id], actionIds: ['start-outbound'], size: 'medium' as const, controls: { closable: true, minimizable: true, maximizable: true } }],
    } as CockpitUISpec
    const response = { requestId: 'confirm-response', task, ui, effects: [], meta: { mode: 'fixture' as const, durationMs: 1, fallbackUsed: false } }
    const api = { create: vi.fn().mockResolvedValue(response), event: vi.fn(), action: vi.fn().mockResolvedValue(response), confirmation: vi.fn() }

    render(<AppComponent api={api} voiceEnabled={false} initialText="选择航班" />)
    await user.click(screen.getByRole('button', { name: '发送' }))

    const confirmation = screen.getByRole('region', { name: '当前行程' })
    expect(confirmation).toContainElement(screen.getByLabelText('现在出发窗口'))
    expect(screen.queryByLabelText('辅助信息窗口')?.querySelector('.cockpit-window')).toBeNull()
    expect(confirmation).toHaveTextContent('MU4490')
    expect(confirmation).toHaveTextContent('虹桥机场')
    expect(confirmation).toHaveTextContent('32.0 km')
    expect(confirmation).toHaveTextContent('42%')
    expect(confirmation).toHaveTextContent('29%')
    expect(confirmation).toHaveTextContent('20 分钟')
    expect(confirmation.querySelector('[data-action-id="start-outbound"]')).not.toBeNull()
  })

  it('disables the legacy timeline advance for a cockpit task', async () => {
    const user = userEvent.setup()
    const task = {
      ...createCockpitTask('cockpit-advance-guard'),
      phase: 'outbound-driving' as const,
      taskRevision: 4,
      pickupAirport: { label: '浦东机场', code: 'PVG' },
      flight: {
        flightNumber: 'HO9272', trusted: true, status: 'in-air' as const,
        scheduledArrival: '2026-08-14T14:18:00+08:00',
        estimatedArrival: '2026-08-14T14:18:00+08:00', terminal: 'T2',
      },
      navigation: { routeId: 'cockpit-route', destination: '浦东机场', eta: '2026-08-14T14:18:00+08:00', status: 'active' as const },
      navigationSimulation: {
        leg: 'outbound' as const, routeId: 'cockpit-route', distanceKm: 48.2,
        initialBatteryPercent: 40, estimatedBatteryAtArrival: 32,
        profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 },
          normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const response = apiResponse(task)
    const api = { create: vi.fn().mockResolvedValue(response), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }

    render(<AppComponent api={api} voiceEnabled={false} initialText="去浦东机场接人" />)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await openControls(user)

    expect(screen.getByRole('button', { name: '推进下一事件' })).toBeDisabled()
    expect(api.event).not.toHaveBeenCalled()
    expect(api.action).not.toHaveBeenCalled()
  })

  it('keeps the waiting-for-passengers HUD inside the persistent cockpit workspace', () => {
    render(<App initialTask={{ ...createInitialTask(), phase: 'waiting-for-passengers' }} />)
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'navigation')
    expect(screen.getByTestId('persistent-map-layer')).toBeInTheDocument()
    expect(document.querySelector('.task-surface')).not.toBeInTheDocument()
    expect(screen.getByLabelText('导航层')).toBeInTheDocument()
  })

  it('keeps the completed feedback until a new input creates a fresh task', async () => {
    const user = userEvent.setup()
    const completed = { ...createCockpitTask('completed-task'), phase: 'completed' } as AirportPickupTaskState
    const fresh = apiResponse(createCockpitTask('fresh-task'))
    const api = {
      create: vi.fn().mockResolvedValueOnce(apiResponse(completed)).mockResolvedValueOnce(fresh),
      event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
    }
    render(<AppComponent api={api} voiceEnabled={false} initialText="完成第一趟" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('已到家')).toBeInTheDocument()
    const input = screen.getByLabelText('任务输入')
    await user.clear(input)
    await user.type(input, '下一趟去浦东机场接人')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(api.create).toHaveBeenNthCalledWith(2, '下一趟去浦东机场接人', expect.objectContaining({ vehicleContext: expect.anything() }))
  })

  it('returns a cleaned cockpit completion to idle with one arrival notice', async () => {
    const user = userEvent.setup()
    const completed = apiResponse({ ...createCockpitTask('completed-cockpit'), phase: 'completed' } as AirportPickupTaskState)
    const response: AgentResponse = {
      ...completed,
      assistant: { text: '已到家', shouldSpeak: false },
    }
    const api = {
      create: vi.fn().mockResolvedValue(response),
      event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
    }
    render(<AppComponent api={api} voiceEnabled={false} initialText="完成返程" />)

    const map = screen.getByTestId('persistent-map-layer')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('已到家')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(screen.getByTestId('persistent-map-layer')).toBe(map)
    expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-mode', 'idle')
    expect(screen.queryByText('行程结束')).not.toBeInTheDocument()
    expect(document.querySelector('.cockpit-window')).not.toBeInTheDocument()
  })

  it('piggybacks only the latest active navigation snapshot on user input', async () => {
    const user = userEvent.setup()
    let nowMs = 1_000
    let tick: (() => void) | undefined
    const navigationClock: NavigationClock = {
      now: () => nowMs,
      schedule: (callback) => {
        tick = callback
        return () => { tick = undefined }
      },
    }
    const task: AirportPickupTaskState = {
      ...createCockpitTask('snapshot-task'),
      phase: 'outbound-driving',
      pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-08-11T15:30:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'route-snapshot-1', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
      navigationSimulation: {
        leg: 'outbound', routeId: 'route-snapshot-1', distanceKm: 32, initialBatteryPercent: 72,
        estimatedBatteryAtArrival: 58,
        profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 },
          normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const returnTask = {
      ...task,
      phase: 'confirming-return',
      navigation: { routeId: 'route-return-2', destination: '家', eta: '2026-08-11T16:20:00+08:00', status: 'planned' },
      navigationSimulation: {
        ...task.navigationSimulation!,
        leg: 'return',
        routeId: 'route-return-2',
      },
      cockpit: { ...task.cockpit!, activeLeg: 'return' },
    } as AirportPickupTaskState
    const response = apiResponse(task)
    const returnResponse = apiResponse(returnTask)
    const event = vi.fn().mockResolvedValueOnce(returnResponse).mockResolvedValue(returnResponse)
    const api = { create: vi.fn().mockResolvedValue(response), event, action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} navigationClock={navigationClock} initialText="接着走" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(event).not.toHaveBeenCalled()
    nowMs = 2_000
    act(() => { tick?.() })
    expect(event).not.toHaveBeenCalled()

    const input = screen.getByLabelText('任务输入')
    await user.clear(input)
    await user.type(input, '到达天气怎么样')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(event).toHaveBeenCalledOnce())
    expect(event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'user.input',
      text: '到达天气怎么样',
      navigationSnapshot: expect.objectContaining({ routeId: 'route-snapshot-1' }),
    }))
    expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-progress', '0')

    event.mockClear()
    await user.clear(input)
    await user.type(input, '开始回家')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(event).toHaveBeenCalledOnce())
    expect(event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'user.input', text: '开始回家',
    }))
    expect(event.mock.calls[0]?.[1]).not.toHaveProperty('navigationSnapshot')
  })

  it('submits the terminal simulator snapshot with the arrival event', async () => {
    let nowMs = 1_000
    let tick: (() => void) | undefined
    const navigationClock: NavigationClock = {
      now: () => nowMs,
      schedule: (callback) => {
        tick = callback
        return () => { tick = undefined }
      },
    }
    const task: AirportPickupTaskState = {
      ...createCockpitTask('arrival-proof-task'), phase: 'outbound-driving',
      pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
      flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-08-11T15:30:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'arrival-route', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
      navigationSimulation: {
        leg: 'outbound', routeId: 'arrival-route', distanceKm: 32,
        initialBatteryPercent: 72, estimatedBatteryAtArrival: 58,
        profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 },
          normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const waiting = apiResponse({
      ...task, phase: 'waiting-for-passengers',
      navigation: { ...task.navigation!, status: 'arrived' },
    } as AirportPickupTaskState)
    const event = vi.fn().mockResolvedValue(waiting)
    const api = { create: vi.fn().mockResolvedValue(apiResponse(task)), event, action: vi.fn(), confirmation: vi.fn() }
    const user = userEvent.setup()
    render(<AppComponent api={api} voiceEnabled={false} navigationClock={navigationClock} initialText="开始" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    nowMs += 90_000
    act(() => { tick?.() })

    await waitFor(() => expect(event).toHaveBeenCalledWith(task, expect.objectContaining({
      type: 'navigation.outbound-arrived',
      navigationSnapshot: expect.objectContaining({
        routeId: 'arrival-route', leg: 'outbound', progress: 1, speedKph: 0,
        batteryPercent: 58, remainingDistanceKm: 0,
      }),
    })))
  })

  it('keeps a return-arrival preference confirmation until the driver resolves it', async () => {
    let nowMs = 1_000
    let tick: (() => void) | undefined
    const navigationClock: NavigationClock = {
      now: () => nowMs,
      schedule: (callback) => { tick = callback; return () => { tick = undefined } },
    }
    const returningTask = {
      ...createCockpitTask('return-confirmation-task'), phase: 'return-driving',
      pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: true },
      navigation: { routeId: 'return-confirmation-route', destination: '家', eta: '2026-08-11T16:10:00+08:00', status: 'active' },
      navigationSimulation: {
        leg: 'return', routeId: 'return-confirmation-route', distanceKm: 29, initialBatteryPercent: 58,
        estimatedBatteryAtArrival: 47, profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
      cockpit: { speedMode: 'normal', hudVisible: true, routeProgress: 0, activeLeg: 'return', currentRoad: '机场出发通道' },
    } as AirportPickupTaskState
    const completedTask = {
      ...returningTask, phase: 'completed', taskRevision: returningTask.taskRevision + 1,
      flight: undefined, pickupAirport: undefined, navigation: undefined, navigationSimulation: undefined, cockpit: undefined,
      pendingConfirmation: { confirmationId: 'save-return-preference', action: 'save-memory' },
      memoryProposal: {
        proposalId: 'return-preference', memberId: 'mom', confirmationId: 'save-return-preference',
        changes: { rearTemperatureC: 25 }, status: 'pending',
      },
    } as AirportPickupTaskState
    const completed = apiResponse(completedTask)
    const event = vi.fn().mockResolvedValue(completed)
    const api = { create: vi.fn().mockResolvedValue(apiResponse(returningTask)), event, action: vi.fn(), confirmation: vi.fn() }
    const user = userEvent.setup()
    render(<AppComponent api={api} voiceEnabled={false} navigationClock={navigationClock} initialText="开始返程" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    nowMs += 90_000
    act(() => { tick?.() })

    await waitFor(() => expect(event).toHaveBeenCalledWith(returningTask, expect.objectContaining({
      type: 'navigation.return-arrived',
      navigationSnapshot: expect.objectContaining({ leg: 'return', progress: 1, speedKph: 0 }),
    })))
    expect(screen.getByRole('button', { name: '保存本次偏好' })).toBeInTheDocument()
  })

  it('uses the stopped outbound snapshot when the passenger button prepares the return', async () => {
    const user = userEvent.setup()
    let nowMs = 1_000
    let tick: (() => void) | undefined
    const navigationClock: NavigationClock = {
      now: () => nowMs,
      schedule: (callback) => { tick = callback; return () => { tick = undefined } },
    }
    const outboundTask = {
      ...createCockpitTask('onboard-return-task'), phase: 'outbound-driving',
      pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
      passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
      navigation: { routeId: 'outbound-route', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
      navigationSimulation: {
        leg: 'outbound', routeId: 'outbound-route', distanceKm: 32, initialBatteryPercent: 72,
        estimatedBatteryAtArrival: 58, profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const waitingTask = {
      ...outboundTask, phase: 'waiting-for-passengers',
      navigation: { ...outboundTask.navigation!, status: 'arrived' },
    } as AirportPickupTaskState
    const waiting = apiResponse(waitingTask)
    const onboardComponent = {
      id: 'passenger-status', type: 'passenger-status' as const, actions: ['confirm-passengers-onboard'],
      props: { label: '已停稳，等待家人', status: 'waiting' as const },
    }
    waiting.ui = {
      ...waiting.ui,
      layout: { type: 'stack', gap: 'md', slots: { main: [onboardComponent.id] } },
      components: [onboardComponent],
      actions: [{ id: 'confirm-passengers-onboard', label: '乘客已上车', style: 'primary', event: { type: 'agent-message', text: '家人上车' } }],
      windows: [{ id: 'onboard-window', kind: 'passenger-onboard', title: '等待乘客上车', componentIds: [onboardComponent.id], actionIds: ['confirm-passengers-onboard'], size: 'compact', controls: { closable: true, minimizable: true, maximizable: true } }],
    }
    const returnTask = {
      ...waitingTask, phase: 'confirming-return', taskRevision: waitingTask.taskRevision + 1,
      passengers: { ...waitingTask.passengers, confirmedOnboard: true },
      navigation: { routeId: 'return-route', destination: '家', eta: '2026-08-11T16:10:00+08:00', status: 'planned' },
      navigationSimulation: { ...waitingTask.navigationSimulation!, leg: 'return', routeId: 'return-route', initialBatteryPercent: 58, estimatedBatteryAtArrival: 47 },
      cockpit: { ...waitingTask.cockpit!, activeLeg: 'return' },
    } as AirportPickupTaskState
    const returned = apiResponse(returnTask)
    const event = vi.fn().mockResolvedValueOnce(waiting).mockResolvedValueOnce(returned)
    const api = { create: vi.fn().mockResolvedValue(apiResponse(outboundTask)), event, action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} navigationClock={navigationClock} initialText="开始" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    nowMs += 90_000
    act(() => { tick?.() })
    await screen.findByRole('button', { name: '乘客已上车' })
    await user.click(screen.getByRole('button', { name: '乘客已上车' }))

    await waitFor(() => expect(event).toHaveBeenLastCalledWith(waitingTask, expect.objectContaining({
      type: 'user.input', text: '家人上车',
      navigationSnapshot: expect.objectContaining({ routeId: 'outbound-route', leg: 'outbound', progress: 1, speedKph: 0 }),
    })))
    expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-progress', '0')
  })

  it('keeps a stable arrival event id and retries a 200 no-op handoff from the error window', async () => {
    let nowMs = 1_000
    let tick: (() => void) | undefined
    const navigationClock: NavigationClock = {
      now: () => nowMs,
      schedule: (callback) => { tick = callback; return () => { tick = undefined } },
    }
    const task = {
      ...createCockpitTask('arrival-retry-task'), phase: 'outbound-driving',
      pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
      flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-08-11T15:30:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'arrival-retry-route', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
      navigationSimulation: {
        leg: 'outbound', routeId: 'arrival-retry-route', distanceKm: 32, initialBatteryPercent: 72,
        estimatedBatteryAtArrival: 58, profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const waiting = apiResponse({ ...task, phase: 'waiting-for-passengers', navigation: { ...task.navigation!, status: 'arrived' } } as AirportPickupTaskState)
    const event = vi.fn().mockResolvedValueOnce(apiResponse(task)).mockResolvedValueOnce(waiting)
    const api = { create: vi.fn().mockResolvedValue(apiResponse(task)), event, action: vi.fn(), confirmation: vi.fn() }
    const user = userEvent.setup()
    render(<AppComponent api={api} voiceEnabled={false} navigationClock={navigationClock} initialText="开始" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    nowMs += 90_000
    act(() => { tick?.() })
    expect(await screen.findByLabelText('操作未完成窗口')).toHaveTextContent('到达确认未推进任务')
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByLabelText('导航信息')).toHaveTextContent('已到达机场，等待接人'))
    expect(event).toHaveBeenCalledTimes(2)
    expect(event.mock.calls[0]?.[1]).toMatchObject({ eventId: 'navigation-outbound-arrived-arrival-retry-task' })
    expect(event.mock.calls[1]?.[1]).toMatchObject({ eventId: 'navigation-outbound-arrived-arrival-retry-task' })
  })

  it('does not let an older HTTP response roll back a newer SSE task or UI revision', async () => {
    const initial = apiResponse(createInitialTask('pickup-race', '2026-07-22T12:00:00+08:00'))
    let releaseEvent: ((value: AgentResponse) => void) | undefined
    let onUpdate: ((value: TaskUpdateEnvelope) => void) | undefined
    const stale = { ...initial, ui: { ...initial.ui, uiRevision: initial.ui.uiRevision + 1 } }
    const newerTask = { ...initial.task, taskRevision: initial.task.taskRevision + 2, phase: 'preparing' as const }
    const newerUi = { ...composePickupSpec(newerTask), uiRevision: initial.ui.uiRevision + 3 }
    const api = {
      create: vi.fn().mockResolvedValue(initial),
      event: vi.fn(() => new Promise<AgentResponse>((resolve) => { releaseEvent = resolve })), action: vi.fn(), confirmation: vi.fn(),
      subscribeTaskUpdates: vi.fn((_taskId: string, callback: (value: TaskUpdateEnvelope) => void) => { onUpdate = callback; return { close: vi.fn() } }),
    }
    const user = userEvent.setup()
    render(<AppComponent api={api} voiceEnabled={false} initialText="开始" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onUpdate).toBeTypeOf('function'))
    const input = screen.getByLabelText('任务输入')
    await user.clear(input)
    await user.type(input, '补充信息')
    await user.click(screen.getByRole('button', { name: '发送' }))
    act(() => onUpdate?.({ type: 'task.updated', cursor: 2, taskId: 'pickup-race', snapshot: { task: newerTask, ui: newerUi } }))
    await act(async () => { releaseEvent?.(stale) })

    const drawer = await openControls(user)
    expect(drawer).toHaveTextContent(`taskRevision ${newerTask.taskRevision}`)
    expect(drawer).toHaveTextContent(`uiRevision ${newerUi.uiRevision}`)
  })

  it('keeps the live initial navigation reminder after StrictMode effect replay', async () => {
    const speech = createFakeSpeech()
    const task = {
      ...createCockpitTask('reminder-task'), phase: 'outbound-driving',
      pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
      flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-08-11T15:30:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'reminder-route', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
      navigationSimulation: {
        leg: 'outbound', routeId: 'reminder-route', distanceKm: 32, initialBatteryPercent: 72,
        estimatedBatteryAtArrival: 58, profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const api = { create: vi.fn().mockResolvedValue(apiResponse(task)), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<StrictMode><AppComponent api={api} speech={speech.deps} initialTask={task} initialNavigationReminder="前方 300 米右转" /></StrictMode>)

    await waitFor(() => expect(speech.synthesis.spoken.length).toBeGreaterThan(0))
    const active = speech.synthesis.spoken.at(-1)
    expect(active).toBeDefined()
    act(() => { active?.onend?.() })
  })

  it('shows cockpit processing and retry windows without replacing the map', async () => {
    const user = userEvent.setup()
    let finishWeather: ((response: AgentResponse) => void) | undefined
    const task: AirportPickupTaskState = {
      ...createCockpitTask('operation-task'), phase: 'outbound-driving',
      pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
      flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-08-11T15:30:00+08:00', terminal: 'T2' },
      navigation: { routeId: 'operation-route', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
      navigationSimulation: {
        leg: 'outbound', routeId: 'operation-route', distanceKm: 32,
        initialBatteryPercent: 72, estimatedBatteryAtArrival: 58,
        profiles: {
          slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
          fast: { durationSeconds: 45, displaySpeedKph: 75 },
        },
      },
    } as AirportPickupTaskState
    const response = apiResponse(task)
    const weatherResponse = {
      ...response,
      ui: {
        ...response.ui,
        uiRevision: response.ui.uiRevision + 1,
        components: [...response.ui.components, { id: 'weather-result', type: 'weather-card' as const, props: { location: '延安西路', timeLabel: '现在', temperatureC: 29, condition: 'cloudy' as const, conditionLabel: '多云', freshness: 'fixture' as const } }],
        windows: [{ id: 'weather-result-window', kind: 'weather' as const, title: '当前位置天气', componentIds: ['weather-result'], size: 'compact' as const, controls: { closable: true, minimizable: true, maximizable: true } }],
      },
    }
    const event = vi.fn()
      .mockImplementationOnce(() => new Promise<AgentResponse>((resolve) => { finishWeather = resolve }))
      .mockRejectedValueOnce(Object.assign(new Error('天气服务暂时不可用'), { retryable: true }))
      .mockResolvedValueOnce(weatherResponse)
    const api = { create: vi.fn().mockResolvedValue(response), event, action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} initialText="开始" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    const map = await screen.findByLabelText('模拟导航地图')
    const input = screen.getByLabelText('任务输入')
    await user.clear(input)
    await user.type(input, '查天气')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByLabelText('正在查询天气窗口')).toBeInTheDocument()
    expect(screen.getByLabelText('模拟导航地图')).toBe(map)
    await act(async () => { finishWeather?.(response) })

    await user.clear(input)
    await user.type(input, '查天气')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByLabelText('操作未完成窗口')).toHaveTextContent('天气服务暂时不可用')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByLabelText('当前位置天气窗口')).toBeInTheDocument()
    expect(event).toHaveBeenCalledTimes(3)
    expect(screen.getByLabelText('模拟导航地图')).toBe(map)
  })

  /**
   * Engineering metadata and the demo player live in the controls drawer, never on
   * the driver-facing brief. Tests that assert a raw phase or press 推进下一事件
   * have to open it first, exactly as an engineer would.
   */
  async function openControls(user: ReturnType<typeof userEvent.setup>) {
    const dialog = screen.queryByRole('dialog', { name: '演示控制' })
    if (dialog?.getAttribute('data-mode') === 'minimized') {
      await user.click(screen.getByRole('button', { name: '恢复演示控制' }))
    } else if (!dialog) {
      await user.click(screen.getByRole('button', { name: /打开演示控制|聚焦演示控制/ }))
    }
    return screen.getByRole('dialog', { name: '演示控制' })
  }

  async function findPrimaryPhase(label: string) {
    return within(screen.getByRole('region', { name: '当前行程' }))
      .findByText(label, { selector: '[data-phase-identity]' })
  }

  function fixtureReplayControls() {
    return within(screen.getByRole('group', { name: '语音兜底回放' }))
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

    // Before creation the persistent shell owns the empty state; no synthetic
    // task phase or legacy task surface should be fabricated.
    expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-mode', 'idle')
    expect(screen.queryByText('等待创建任务')).not.toBeInTheDocument()
    expect(screen.queryByText('告诉我接谁，我来安排这趟行程。')).not.toBeInTheDocument()
    expect(document.querySelector('.task-surface')).not.toBeInTheDocument()
    expect(screen.queryByText('status-banner')).not.toBeInTheDocument()

    const drawer = await openControls(user)
    expect(drawer).toHaveTextContent('尚无任务')
    expect(screen.getByRole('button', { name: /推进下一事件/ })).toBeDisabled()
  })

  it('uses the selected light condition for task creation and locks it afterwards', async () => {
    const user = userEvent.setup()
    const created = apiResponse(createInitialTask())
    const api = {
      create: vi.fn().mockResolvedValue(created),
      event: vi.fn(),
      action: vi.fn(),
      confirmation: vi.fn(),
    }
    render(<App api={api} />)

    let drawer = await openControls(user)
    const night = screen.getByRole('button', { name: '夜间' })
    await user.click(night)
    expect(night).toHaveAttribute('aria-pressed', 'true')
    expect(drawer).toHaveTextContent('选择创建任务时车辆上报的光线')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(
      '我现在要去机场接妈妈和豆豆',
      { vehicleContext: expect.objectContaining({ isNight: true }) },
    ))

    drawer = await openControls(user)
    expect(screen.getByRole('button', { name: '跟随时间' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '白天' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '夜间' })).toBeDisabled()
    expect(drawer).toHaveTextContent('光线条件已随任务固定')
  })

  it('locks the selected light condition while task creation is pending', async () => {
    const user = userEvent.setup()
    let resolveCreate: ((value: AgentResponse) => void) | undefined
    const create = vi.fn().mockImplementation(() => new Promise<AgentResponse>((resolve) => {
      resolveCreate = resolve
    }))
    const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<App api={api} />)

    await openControls(user)
    await user.click(screen.getByRole('button', { name: '夜间' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await openControls(user)
    expect(screen.getByRole('button', { name: '跟随时间' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '白天' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '夜间' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '夜间' })).toHaveAttribute('aria-pressed', 'true')

    resolveCreate!(apiResponse(createInitialTask()))
    await findPrimaryPhase('准备接机')
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
    expect(await findPrimaryPhase('准备出发')).toBeInTheDocument()
    rendered.unmount()
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'parked',
      vehicle: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 112, gear: 'P', isNight: true } satisfies VehicleContext,
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
        task = applyEvent({
          ...current.task,
          navigation: current.task.navigation ?? {
            routeId: 'route-airport-001', destination: '虹桥机场 T2',
            eta: '2026-07-22T20:25:00+08:00', status: 'planned',
          },
        }, { ...mainFlowTimeline.steps[3]!.event, timestamp: '2026-07-22T20:11:00+08:00' })
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
    await user.click(within(screen.getByRole('region', { name: '当前行程' })).getByRole('button', { name: '开始导航' }))
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
      flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', arrivalAirport: 'SHA', terminal: 'T2', baggageClaim: '12' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    })
    expect(approaching.components[0]).toMatchObject({
      type: 'passenger-status',
      props: { status: 'landed', meetingPoint: '虹桥 T2 P2 停车场到达层 3 号门' },
    })

    const waiting = composePickupSpec({
      ...createInitialTask(),
      phase: 'waiting-for-passengers',
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', arrivalAirport: 'SHA', terminal: 'T2', baggageClaim: '12' },
    })
    expect(waiting.components[0]).toMatchObject({
      type: 'passenger-status',
      props: { status: 'waiting', meetingPoint: '虹桥 T2 P2 停车场到达层 3 号门' },
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
    expect(await findPrimaryPhase('准备接机')).toBeInTheDocument()

    await user.click(advance) // passengers
    await user.click(advance) // flight → preparing
    expect(drawer).toHaveTextContent('preparing')
    expect(await findPrimaryPhase('准备出发')).toBeInTheDocument()

    await user.click(advance) // charging recommend
    // The card is identified by what the driver reads, not by its component type: the
    // renderer no longer prints schema vocabulary on the task surface.
    expect(document.querySelector('[data-component-type="charging-recommendation"]')).toBeInTheDocument()
    expect(screen.getByLabelText('电量从 42% 到 18%')).toBeInTheDocument()
    expect(screen.getByText('18%')).toBeInTheDocument()

    await user.click(advance) // navigation.started
    expect(drawer).toHaveTextContent('driving-to-airport')
    expect(await findPrimaryPhase('途中')).toBeInTheDocument()
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
    await user.click(within(screen.getByRole('region', { name: '当前行程' })).getByRole('button', { name: '开始导航' }))
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

  it('keeps a failed navigation advance on the same timeline step for retry', async () => {
    const user = userEvent.setup()
    const collectingTask = createInitialTask()
    const preparedTask: AirportPickupTaskState = {
      ...collectingTask,
      phase: 'preparing',
      taskRevision: 1,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: {
        flightNumber: 'MU5102', trusted: true, status: 'scheduled',
        scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2',
      },
      charging: { recommended: true, accepted: false, status: 'planned' },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' },
    }
    const startedTask: AirportPickupTaskState = {
      ...preparedTask,
      phase: 'driving-to-airport',
      taskRevision: 2,
      navigation: { ...preparedTask.navigation!, status: 'active' },
    }
    const failed = {
      ...apiResponse(preparedTask),
      effects: [{ effectId: 'nav:advance-failed', type: 'navigation.start' as const, status: 'failed' as const, tool: 'navigation.start', errorCode: 'PROVIDER_TIMEOUT' }],
    }
    const event = vi.fn()
      .mockResolvedValueOnce(apiResponse(preparedTask))
      .mockResolvedValue(apiResponse(preparedTask))
    const action = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(apiResponse(startedTask))
    const api = {
      create: vi.fn().mockResolvedValue(apiResponse(collectingTask)),
      event,
      action,
      confirmation: vi.fn(),
    }
    render(<App api={api} />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    const input = screen.getByLabelText('任务输入')
    await user.clear(input)
    await user.type(input, 'MU5102')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await findPrimaryPhase('准备出发')

    const drawer = await openControls(user)
    const advance = screen.getByRole('button', { name: /推进下一事件/ })
    await user.click(advance) // charging recommendation
    await user.click(advance) // navigation fails, cursor must stay here
    await findPrimaryPhase('准备出发')
    expect(action).toHaveBeenCalledTimes(1)

    await user.click(advance) // retry the same navigation step
    await waitFor(() => expect(drawer).toHaveTextContent('driving-to-airport'))
    expect(action).toHaveBeenCalledTimes(2)
    expect(await findPrimaryPhase('途中')).toBeInTheDocument()
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
    await findPrimaryPhase('准备接机')
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
    await findPrimaryPhase('准备接机')
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
    await findPrimaryPhase('准备出发')
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

  it('offers declining the completion confirmation and clears it too', async () => {
    const user = userEvent.setup()
    render(<App initialTask={{ ...createInitialTask(), phase: 'completed', pendingConfirmation: { confirmationId: 'pickup-001:save-memory', action: 'save-memory' } }} />)
    // A confirmation the driver can only accept is not a confirmation. Declining
    // has to clear the pending state as well, or the prompt never goes away.
    await user.click(screen.getByRole('button', { name: '暂不保存' }))
    expect(screen.queryByRole('button', { name: '暂不保存' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存本次偏好' })).not.toBeInTheDocument()
  })

  it.each([
    ['保存本次偏好！', 'accept' as const],
    ['暂不保存？', 'reject' as const],
  ])('routes spoken completion choice "%s" through confirmation instead of creating a task', async (utterance, decision) => {
    const user = userEvent.setup()
    const completedTask: AirportPickupTaskState = {
      ...createCockpitTask(`voice-memory-${decision}`),
      phase: 'completed',
      taskRevision: 8,
      pendingConfirmation: { confirmationId: `cnf-${decision}`, action: 'save-memory' },
      memoryProposal: {
        proposalId: `proposal-${decision}`,
        memberId: 'mom',
        confirmationId: `cnf-${decision}`,
        changes: { rearTemperatureC: 25 },
        status: 'pending',
      },
    }
    const current = apiResponse(completedTask)
    const resolved = apiResponse({
      ...completedTask,
      taskRevision: 9,
      pendingConfirmation: undefined,
      memoryProposal: { ...completedTask.memoryProposal!, status: decision === 'accept' ? 'accepted' : 'rejected' },
    })
    const api = {
      create: vi.fn().mockResolvedValue(current),
      event: vi.fn(),
      action: vi.fn(),
      confirmation: vi.fn().mockResolvedValue(resolved),
    }
    render(<AppComponent api={api} voiceEnabled={false} initialText="建立任务" />)
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByRole('button', { name: '保存本次偏好' })).toBeInTheDocument()

    const input = screen.getByLabelText('任务输入')
    await user.type(input, utterance)
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(api.confirmation).toHaveBeenCalledWith(completedTask, `cnf-${decision}`, decision))
    expect(await screen.findByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(screen.getByText('已到家', { selector: '[role="status"]' })).toBeInTheDocument()
    expect(screen.queryByLabelText('机场接人任务')).not.toBeInTheDocument()
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.event).not.toHaveBeenCalled()
  })

  it.each([
    ['保存本次偏好', 'accept' as const],
    ['暂不保存', 'reject' as const],
  ])('returns to the idle cockpit after the completion button "%s" resolves', async (label, decision) => {
    const user = userEvent.setup()
    const completedTask: AirportPickupTaskState = {
      ...createCockpitTask(`button-memory-${decision}`),
      phase: 'completed',
      taskRevision: 8,
      pendingConfirmation: { confirmationId: `button-cnf-${decision}`, action: 'save-memory' },
      memoryProposal: {
        proposalId: `button-proposal-${decision}`,
        memberId: 'mom',
        confirmationId: `button-cnf-${decision}`,
        changes: { rearTemperatureC: 25 },
        status: 'pending',
      },
    }
    const resolved = apiResponse({
      ...completedTask,
      taskRevision: 9,
      pendingConfirmation: undefined,
      memoryProposal: { ...completedTask.memoryProposal!, status: decision === 'accept' ? 'accepted' : 'rejected' },
    })
    const api = {
      create: vi.fn().mockResolvedValue(apiResponse(completedTask)),
      event: vi.fn(),
      action: vi.fn(),
      confirmation: vi.fn().mockResolvedValue(resolved),
    }
    render(<AppComponent api={api} voiceEnabled={false} initialText="建立任务" />)
    await user.click(screen.getByRole('button', { name: '发送' }))

    await user.click(screen.getByRole('button', { name: label }))

    await waitFor(() => expect(api.confirmation).toHaveBeenCalledWith(completedTask, `button-cnf-${decision}`, decision))
    expect(await screen.findByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
    expect(screen.getByText('已到家', { selector: '[role="status"]' })).toBeInTheDocument()
    expect(screen.queryByLabelText('机场接人任务')).not.toBeInTheDocument()
  })

  it('gates preference replay on the renderer first-wins confirmation action', async () => {
    const user = userEvent.setup()
    const completedTask: AirportPickupTaskState = {
      ...createCockpitTask('voice-memory-first-wins'),
      phase: 'completed',
      pendingConfirmation: { confirmationId: 'cnf-first-wins', action: 'save-memory' },
    }
    const current = apiResponse(completedTask)
    current.ui = {
      ...current.ui,
      actions: [
        // The renderer resolves duplicate action ids to this first entry.
        { id: 'save-trip-preferences', label: '错误保存动作', style: 'primary', event: { type: 'agent-message', text: '保存本次偏好' } },
        { id: 'save-trip-preferences', label: '保存本次偏好', style: 'primary', event: { type: 'confirmation', confirmationId: 'cnf-first-wins', decision: 'accept' } },
        { id: 'reject-trip-preferences', label: '暂不保存', style: 'secondary', event: { type: 'confirmation', confirmationId: 'cnf-first-wins', decision: 'reject' } },
      ],
    }
    const api = { create: vi.fn().mockResolvedValue(current), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} initialText="建立任务" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    await openControls(user)

    expect(fixtureReplayControls().getByRole('button', { name: '保存本次偏好' })).toBeDisabled()
    expect(fixtureReplayControls().getByRole('button', { name: '暂不保存' })).toBeEnabled()
    expect(api.confirmation).not.toHaveBeenCalled()
  })

  it('does not expose preference replay for a stale confirmation id', async () => {
    const user = userEvent.setup()
    const completedTask: AirportPickupTaskState = {
      ...createCockpitTask('voice-memory-stale-id'),
      phase: 'completed',
      pendingConfirmation: { confirmationId: 'cnf-current', action: 'save-memory' },
    }
    const current = apiResponse(completedTask)
    current.ui = {
      ...current.ui,
      actions: current.ui.actions.map((action) => action.event.type === 'confirmation'
        ? { ...action, event: { ...action.event, confirmationId: 'cnf-expired' } }
        : action),
    }
    const api = { create: vi.fn().mockResolvedValue(current), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} initialText="建立任务" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    await openControls(user)
    expect(fixtureReplayControls().getByRole('button', { name: '保存本次偏好' })).toBeDisabled()
    expect(fixtureReplayControls().getByRole('button', { name: '暂不保存' })).toBeDisabled()
  })

  it('keeps a stale spoken preference choice instead of creating a new task', async () => {
    const user = userEvent.setup()
    const completedTask: AirportPickupTaskState = {
      ...createCockpitTask('voice-memory-stale-spoken'),
      phase: 'completed',
      pendingConfirmation: { confirmationId: 'cnf-current', action: 'save-memory' },
    }
    const current = apiResponse(completedTask)
    current.ui = {
      ...current.ui,
      actions: current.ui.actions.map((action) => action.event.type === 'confirmation'
        ? { ...action, event: { ...action.event, confirmationId: 'cnf-expired' } }
        : action),
    }
    const create = vi.fn().mockResolvedValue(current)
    const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
    render(<AppComponent api={api} voiceEnabled={false} initialText="建立任务" />)

    await user.click(screen.getByRole('button', { name: '发送' }))
    const input = screen.getByLabelText('任务输入')
    await user.type(input, '保存本次偏好！')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(input).toHaveValue('保存本次偏好！')
    expect(create).toHaveBeenCalledTimes(1)
    expect(api.confirmation).not.toHaveBeenCalled()
    expect(api.event).not.toHaveBeenCalled()
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
          flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', arrivalAirport: 'SHA', terminal: 'T2' },
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
    expect(await findPrimaryPhase('途中')).toBeInTheDocument()
  })

  it('shows unavailable state instead of retry when no authorized contact remains', () => {
    render(
      <App
        initialTask={{
          ...createInitialTask(),
          phase: 'driving-to-airport',
          passengers: { memberIds: ['doubao'], names: ['豆豆'], confirmedOnboard: false },
          flight: { flightNumber: 'MU5102', status: 'landed', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', arrivalAirport: 'SHA', terminal: 'T2' },
          message: { autoNotifyAuthorized: true, status: 'failed', landingNoticeSent: false },
          updatedAt: '2026-07-22T20:41:00+08:00',
        }}
      />,
    )
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument()
    expect(screen.getByText('无法重试发送')).toBeInTheDocument()
    expect(screen.getByText('没有已授权的落地通知联系人')).toBeInTheDocument()
  })

  /**
   * The offline route panel through the whole demo shell: task state → composer →
   * UISpec → renderer, on the same App the browser mounts. The shipped timeline
   * leads the charging-completed and return-leg briefs with other cards, so the
   * detour, the reroute and the way home are driven from injected task state here
   * rather than left unrendered until a phase happens to show a navigation card.
   */
  describe('offline route panel', () => {
    const returnTrip: NonNullable<AirportPickupTaskState['returnTrip']> = {
      workflowId: 'pickup-001:return',
      route: { status: 'succeeded', routeId: 'route-home-001', eta: '2026-07-22T21:35:00+08:00' },
      cabin: { status: 'pending' },
      media: { status: 'pending' },
    }

    function tripTask(overrides: Partial<AirportPickupTaskState> = {}): AirportPickupTaskState {
      return {
        ...createInitialTask(),
        phase: 'driving-to-airport',
        passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
        flight: { flightNumber: 'MU5102', status: 'in-air', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
        charging: { recommended: false, accepted: false, status: 'none' },
        updatedAt: '2026-07-22T20:35:00+08:00',
        ...overrides,
      }
    }

    const drawnLine = () => document.querySelector('.persistent-map-layer__route')?.getAttribute('d')
    const stops = () => [...document.querySelectorAll('.persistent-map-layer__stops li')].map((stop) => stop.textContent)

    it('draws the active route and marks the staged progress on it', () => {
      render(<App initialTask={tripTask()} />)

      expect(screen.getByRole('img', { name: '前往虹桥机场 T2的路线示意' })).toBeInTheDocument()
      expect(stops()).toEqual(['出发地', '虹桥机场 T2'])
      expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-progress', '0.08')
      expect(document.querySelector('.persistent-map-layer__vehicle')).toBeInTheDocument()
      // One route, drawn once by the persistent map rather than a companion card.
      expect(document.querySelector('.ui-route-sketch')).toBeNull()
    })

    it('draws the charging detour and the ring-road reroute instead of the direct line', () => {
      const direct = render(<App initialTask={tripTask()} />)
      const directLine = drawnLine()
      direct.unmount()

      const detour = render(<App initialTask={tripTask({
        navigation: { routeId: 'route-airport-via-charge-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:37:00+08:00', status: 'active' },
        charging: { recommended: true, accepted: true, status: 'active' },
      })} />)
      expect(stops()).toEqual(['出发地', '虹桥枢纽超充站', '虹桥机场 T2'])
      expect(drawnLine()).not.toBe(directLine)
      // The detour is under way, so the marker sits further along than departure.
      expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-progress', '0.4')
      detour.unmount()

      render(<App initialTask={tripTask({
        navigation: { routeId: 'route-airport-bypass-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:35:00+08:00', status: 'active' },
      })} />)
      expect(stops()).toEqual(['出发地', '外环快速路', '虹桥机场 T2'])
      expect(drawnLine()).not.toBe(directLine)
    })

    it('draws the way home on the return leg rather than the airport route again', () => {
      const outbound = render(<App initialTask={tripTask()} />)
      const outboundLine = drawnLine()
      outbound.unmount()

      render(<App initialTask={tripTask({
        phase: 'returning-home',
        navigation: { routeId: 'route-home-001', destination: '家', eta: '2026-07-22T21:35:00+08:00', status: 'active' },
        returnTrip,
      })} />)

      expect(screen.getByRole('img', { name: '前往家的路线示意' })).toBeInTheDocument()
      expect(stops()).toEqual(['出发地', '家'])
      expect(drawnLine()).not.toBe(outboundLine)
      // A new leg restarts near its own origin instead of continuing the outbound value.
      expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-progress', '0.08')
    })

    it('keeps the whole navigation brief when the route has no sketch geometry', () => {
      render(<App initialTask={tripTask({
        navigation: { routeId: 'route-not-in-fixtures', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
      })} />)

      expect(document.querySelector('.ui-route-sketch')).toBeNull()
      // Nothing to draw means no panel and no second column to put it in: the
      // card owns the frame alone rather than sharing it with an empty box.
      expect(document.querySelector('.ui-card--route-map')).toBeNull()
      expect(document.querySelector('.ui-layout--split')).toBeNull()
      expect(screen.getByTestId('persistent-map-layer')).toHaveAttribute('data-mode', 'route')
      expect(screen.getByTestId('persistent-map-layer')).not.toHaveAttribute('data-progress')
      expect(document.querySelector('.persistent-map-layer__route')).toBeInTheDocument()
      expect(stops()).toEqual(['当前位置', '机场接人点'])
      // Losing the drawing costs the drawing alone: the conclusion and its
      // supporting facts are all still on the brief, and no error takes its place.
      expect(screen.getByRole('heading', { name: '虹桥机场 T2' })).toBeInTheDocument()
      expect(screen.getByLabelText('预计到达')).toBeInTheDocument()
      expect(screen.getByText('32.0 km')).toBeInTheDocument()
      expect(screen.getByText('27%')).toBeInTheDocument()
      expect(screen.queryByText('这项信息暂时无法显示')).not.toBeInTheDocument()
      // Nothing names the route the sketch could not draw.
      expect(screen.getByTestId('cockpit-workspace').textContent).not.toContain('route-not-in-fixtures')
    })
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

      const brief = screen.getByTestId('cockpit-workspace')
      expect(within(screen.getByRole('region', { name: '座舱状态' })).getByText(label)).toBeInTheDocument()
      if (phase === 'completed' || phase === 'cancelled') {
        expect(brief.querySelector('[data-trip-brief]')).toBeNull()
        expect(brief).toHaveAttribute('data-cockpit-mode', 'terminal')
      } else {
        expect(brief.querySelector('[data-phase-label]')).toHaveAttribute('data-phase-label', label)
        // Query the header's phase element specifically: a card may legitimately
        // repeat the same words as its own supplied copy.
        expect(brief.querySelector('[data-phase-identity]')).toHaveTextContent(label)
      }
      // The raw enum is engineering vocabulary; it belongs in the drawer only.
      expect(brief.textContent).not.toContain(phase)
    })

    it.each<AirportPickupTaskState['phase']>([
      'collecting-airport',
      'choosing-flight',
      'confirming-outbound',
      'waiting-for-passengers',
      'confirming-return',
      'outbound-driving',
      'return-driving',
    ])('keeps %s focused on the current decision instead of a numbered journey rail', (phase) => {
      render(<App initialTask={{ ...createInitialTask(), phase }} />)

      expect(screen.queryByRole('list', { name: '接机行程阶段' })).not.toBeInTheDocument()
      expect(screen.queryByText('准备', { selector: '[data-journey-label]' })).not.toBeInTheDocument()
    })

    it('keeps engineering metadata out of the brief and inside the drawer', async () => {
      const user = userEvent.setup()
      render(<App initialTask={{ ...createInitialTask(), phase: 'preparing' }} />)

      const brief = screen.getByTestId('cockpit-workspace')
      for (const term of ['taskRevision', 'uiRevision', 'pickup-001', 'preparing', 'full', 'normal']) {
        expect(brief.querySelector('[data-trip-brief]')?.textContent).not.toContain(term)
      }

      const drawer = await openControls(user)
      expect(drawer).toHaveTextContent('preparing')
      expect(drawer).toHaveTextContent('taskRevision')
      expect(drawer).toHaveTextContent('uiRevision')
      expect(drawer).toHaveTextContent('pickup-001')
    })

    it('keeps model participation in the engineering drawer only', async () => {
      const user = userEvent.setup()
      const created = apiResponse(createInitialTask())
      const withModel: AgentResponse = {
        ...created,
        meta: { ...created.meta, modelUsed: 'qwen-plus' },
      }
      const api = { create: vi.fn().mockResolvedValue(withModel), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备接机')

      expect(screen.queryByLabelText('模型参与说明')).not.toBeInTheDocument()

      // The drawer states the planning source for an engineer.
      const drawer = await openControls(user)
      expect(drawer).toHaveTextContent('规划来源')
      expect(drawer).toHaveTextContent('qwen-plus')
    })

    it('stays silent about the model on rules-only turns', async () => {
      const user = userEvent.setup()
      const api = { create: vi.fn().mockResolvedValue(apiResponse(createInitialTask())), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备接机')

      // No meta.modelUsed means the rules planned this turn; claiming otherwise
      // would overstate the model's role, so the disclosure never renders.
      expect(screen.queryByLabelText('模型参与说明')).not.toBeInTheDocument()

      const drawer = await openControls(user)
      expect(drawer).toHaveTextContent('规划来源')
      expect(drawer).toHaveTextContent('规则')
    })

    it('keeps the tool window non-modal, closes on Escape, and restores focus to its trigger', async () => {
      const user = userEvent.setup()
      render(<App initialTask={createInitialTask()} />)

      const trigger = screen.getByRole('button', { name: '打开演示控制' })
      await user.click(trigger)

      const toolWindow = screen.getByRole('dialog', { name: '演示控制' })
      expect(toolWindow).toHaveFocus()
      expect(toolWindow).not.toHaveAttribute('aria-modal')
      expect(document.querySelector('.drawer-scrim')).not.toBeInTheDocument()

      // The final disclosure can tab into the persistent cockpit entry because
      // this is an auxiliary tool, not a modal focus scope.
      const disclosures = toolWindow.querySelectorAll('summary')
      ;(disclosures.item(disclosures.length - 1) as HTMLElement).focus()
      await user.tab()
      expect(toolWindow).not.toContainElement(document.activeElement as HTMLElement)

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: '演示控制' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '打开演示控制' })).toHaveFocus()
    })

    it('opens, focuses, and restores the tool window from the persistent trigger', async () => {
      const user = userEvent.setup()
      render(<App initialTask={createInitialTask()} />)

      const trigger = screen.getByRole('button', { name: '打开演示控制' })
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')

      await user.click(trigger)
      const toolWindow = screen.getByRole('dialog', { name: '演示控制' })
      const focusTrigger = screen.getByRole('button', { name: '聚焦演示控制' })
      expect(focusTrigger).toHaveAttribute('aria-expanded', 'true')
      await user.click(focusTrigger)
      expect(toolWindow).toHaveFocus()

      await user.click(screen.getByRole('button', { name: '最小化演示控制窗口' }))
      expect(screen.getByRole('button', { name: '恢复演示控制' })).toHaveAttribute('aria-expanded', 'true')
      await user.click(screen.getByRole('button', { name: '恢复演示控制' }))
      expect(toolWindow).toHaveAttribute('data-mode', 'normal')

      await user.click(screen.getByRole('button', { name: '关闭演示控制窗口' }))
      expect(screen.getByRole('button', { name: '打开演示控制' })).toHaveAttribute('aria-expanded', 'false')
    })

    it('lets the title step back into trip context once a card carries the conclusion', () => {
      const { unmount } = render(<App initialTask={createInitialTask()} />)
      // While collecting information the instruction is the conclusion, so the
      // page title leads.
      expect(document.querySelector('[data-trip-brief]')).toBeInTheDocument()
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
      expect(document.querySelector('[data-trip-brief]')).toBeInTheDocument()
      // The persistent shell owns the landmark; navigation content may collapse
      // the legacy page heading into the compact HUD without losing the trip brief.
      expect(screen.getByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'navigation')
      expect(screen.getByTestId('cockpit-workspace').querySelector('[data-trip-brief]')).toBeInTheDocument()
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
      await findPrimaryPhase('准备接机')

      const brief = screen.getByTestId('cockpit-workspace').querySelector('[data-trip-brief]') as HTMLElement
      expect(brief.textContent).not.toContain('navigation.start')

      const drawer = await openControls(user)
      expect(drawer).toHaveTextContent('navigation.start:succeeded')
    })

    it('sends a picked arrivals row as the driver saying that flight number', async () => {
      const user = userEvent.setup()
      const task = createInitialTask()
      const base = composePickupSpec(task)
      const ui: UISpec = {
        ...base,
        layout: { type: 'stack', gap: 'md', slots: { main: ['flight-choices'] } },
        components: [{
          id: 'flight-choices',
          type: 'flight-choices',
          actions: ['pick-MU5102', 'pick-MU5103'],
          props: {
            arrivalCityName: '上海',
            dateLabel: '今天',
            choices: [
              { flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都', status: 'scheduled', statusLabel: '计划中', arrivalTimeLabel: '20:30', terminal: 'T2', airportName: '虹桥机场', actionId: 'pick-MU5102' },
              { flightNumber: 'MU5103', airlineName: '东方航空', originName: '深圳宝安', status: 'delayed', statusLabel: '延误', arrivalTimeLabel: '20:30', revisedTimeLabel: '预计 21:10', terminal: 'T1', airportName: '虹桥机场', actionId: 'pick-MU5103' },
            ],
            freshness: 'fixture',
          },
        }],
        actions: [
          { id: 'pick-MU5102', label: '接 MU5102', style: 'primary', event: { type: 'agent-message', text: '航班号 MU5102' } },
          { id: 'pick-MU5103', label: '接 MU5103', style: 'secondary', event: { type: 'agent-message', text: '航班号 MU5103' } },
        ],
      }
      const api = {
        create: vi.fn().mockResolvedValue({ ...apiResponse(task), ui }),
        event: vi.fn().mockResolvedValue({ ...apiResponse(task), ui }),
        action: vi.fn(),
        confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      const rows = await screen.findAllByRole('button', { name: /MU510/ })
      await user.click(rows[1]!)

      // The pick travels as user input, not as a tool action: the row is a faster
      // way to say the number, so the Agent sees the same event either way.
      expect(api.event).toHaveBeenCalledWith(expect.anything(), { type: 'user.input', text: '航班号 MU5103' })
      expect(api.action).not.toHaveBeenCalled()
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
      await findPrimaryPhase('准备接机')

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

    it('auto-submits a normal microphone transcript after five seconds of silence', async () => {
      vi.useFakeTimers()
      try {
        const speech = createFakeSpeech()
        const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
        const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
        render(<AppComponent api={api} speech={speech.deps} wakeWordEnabled={false} />)

        act(() => { screen.getByRole('button', { name: '开始语音输入' }).click() })
        emit(() => speech.engine().emit('去虹桥机场接人', true, 0.9))
        expect(create).not.toHaveBeenCalled()

        await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
        expect(create).toHaveBeenCalledWith('去虹桥机场接人', {
          vehicleContext: expect.anything(), source: 'voice', confidence: 0.9,
        })
        await act(async () => {})
      } finally {
        vi.useRealTimers()
      }
    })

    it('uses the latest cockpit input path for navigation voice commands', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const task = {
        ...createCockpitTask('voice-cockpit-task'), phase: 'outbound-driving',
        pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
        flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-08-11T15:30:00+08:00', terminal: 'T2' },
        navigation: { routeId: 'voice-cockpit-route', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
        navigationSimulation: {
          leg: 'outbound', routeId: 'voice-cockpit-route', distanceKm: 32,
          initialBatteryPercent: 72, estimatedBatteryAtArrival: 58,
          profiles: {
            slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
            fast: { durationSeconds: 45, displaySpeedKph: 75 },
          },
        },
      } as AirportPickupTaskState
      const event = vi.fn().mockRejectedValue(new Error('天气服务暂时不可用'))
      const api = { create: vi.fn().mockResolvedValue(apiResponse(task)), event, action: vi.fn(), confirmation: vi.fn() }
      render(<AppComponent api={api} speech={speech.deps} initialText="开始" initialNavigationReminder="前方 300 米右转" voiceAutoSubmit={false} wakeWordEnabled={false} />)

      await user.click(screen.getByRole('button', { name: '改用文字输入' }))
      await user.click(screen.getByRole('button', { name: '发送' }))
      expect(screen.getByLabelText('模拟导航地图')).toBeInTheDocument()
      await waitFor(() => expect(speech.synthesis.spoken.length).toBeGreaterThan(0))
      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('查天气', true, 0.9))
      await user.click(screen.getByRole('button', { name: '发送' }))

      expect(event).not.toHaveBeenCalled()
      act(() => { speech.synthesis.spoken.at(-1)?.onend?.() })
      await waitFor(() => expect(event).toHaveBeenCalledOnce())
      expect(await screen.findByLabelText('操作未完成窗口')).toHaveTextContent('天气服务暂时不可用')
    })

    it('parks a punctuation-only match to the active navigation TTS for confirmation', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const task = {
        ...createCockpitTask('voice-echo-task'), phase: 'outbound-driving',
        pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
        navigation: { routeId: 'voice-echo-route', destination: '虹桥机场 T2', eta: '2026-08-11T15:30:00+08:00', status: 'active' },
        navigationSimulation: {
          leg: 'outbound', routeId: 'voice-echo-route', distanceKm: 32,
          initialBatteryPercent: 72, estimatedBatteryAtArrival: 58,
          profiles: {
            slow: { durationSeconds: 150, displaySpeedKph: 35 }, normal: { durationSeconds: 90, displaySpeedKph: 55 },
            fast: { durationSeconds: 45, displaySpeedKph: 75 },
          },
        },
      } as AirportPickupTaskState
      const event = vi.fn()
      const api = { create: vi.fn().mockResolvedValue(apiResponse(task)), event, action: vi.fn(), confirmation: vi.fn() }
      render(<AppComponent api={api} speech={speech.deps} initialText="开始" initialNavigationReminder="前方 300 米右转" voiceAutoSubmit={false} wakeWordEnabled={false} />)

      await user.click(screen.getByRole('button', { name: '改用文字输入' }))
      await user.click(screen.getByRole('button', { name: '发送' }))
      await waitFor(() => expect(speech.synthesis.spoken.length).toBeGreaterThan(0))
      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('前方300米右转。', true, 0.88))
      await user.click(screen.getByRole('button', { name: '发送' }))

      expect(event).not.toHaveBeenCalled()
      expect(screen.getByLabelText('任务输入')).toHaveValue('前方300米右转。')
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
      await findPrimaryPhase('准备接机')
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
      await findPrimaryPhase('准备接机')
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
      await findPrimaryPhase('准备接机')

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
      expect(screen.getByRole('button', { name: '取消聆听' })).toBeInTheDocument()
    })

    it('cancels a confirmed transcript without retaining or submitting its words', async () => {
      const user = userEvent.setup()
      const create = vi.fn()
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      const speech = createFakeSpeech()
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈', true))
      await user.click(screen.getByRole('button', { name: '放弃这次语音输入' }))

      expect(screen.getByRole('button', { name: '开始语音输入' })).toBeInTheDocument()
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
      expect(create).not.toHaveBeenCalled()
    })

    it('cancels listening immediately, clears partial words, and never calls the Agent', async () => {
      const user = userEvent.setup()
      const create = vi.fn()
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      const speech = createFakeSpeech()
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去虹桥机场', false))
      expect(screen.getByRole('status', { name: '语音状态' })).toHaveTextContent('去虹桥机场')
      await user.click(screen.getByRole('button', { name: '取消聆听' }))

      expect(speech.engine().aborted).toBeGreaterThan(0)
      expect(screen.getByRole('button', { name: '开始语音输入' })).toBeInTheDocument()
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
      expect(screen.getByRole('status', { name: '语音状态' })).toHaveTextContent('')
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
      await findPrimaryPhase('准备接机')
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
      await findPrimaryPhase('准备接机')
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
      await findPrimaryPhase('准备接机')
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

    it('gives the space back once a typed message has actually been sent', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const create = vi.fn()
        .mockRejectedValueOnce(new Error('网关不可用'))
        .mockResolvedValueOnce(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '改用文字输入' }))
      await user.clear(screen.getByLabelText('任务输入'))
      await user.type(screen.getByLabelText('任务输入'), '去机场接妈妈')
      await user.click(screen.getByRole('button', { name: '发送' }))

      // A refused send keeps the field: the words are still in it, waiting to be
      // retried, so taking it away would strand them.
      await screen.findByRole('alert')
      expect(screen.getByLabelText('任务输入')).toHaveValue('去机场接妈妈')

      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备接机')

      // Now the words are gone, so the field that held them has done its job.
      // Leaving it open would restore the permanent empty input row.
      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '改用文字输入' })).toBeEnabled()
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

    it('clears an abandoned transcript before starting another voice turn', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const api = { create: vi.fn(), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} />)

      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      emit(() => speech.engine().emit('去机场接妈妈', true))
      await user.click(screen.getByRole('button', { name: '放弃这次语音输入' }))

      expect(screen.queryByLabelText('任务输入')).not.toBeInTheDocument()

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

  describe('voice fixture replay', () => {
    /** Fixture audio the test finishes by hand, standing in for a played WAV. */
    function createFakeFixtureAudio() {
      const instances: Array<{
        url: string
        played: number
        onended: (() => void) | null
        onerror: (() => void) | null
        play: () => Promise<void>
        pause: () => void
      }> = []
      const factory = (url: string) => {
        const instance = {
          url,
          played: 0,
          onended: null as (() => void) | null,
          onerror: null as (() => void) | null,
          play() { instance.played += 1; return Promise.resolve() },
          pause() {},
        }
        instances.push(instance)
        return instance
      }
      return {
        factory,
        current: () => {
          const instance = instances.at(-1)
          if (!instance) throw new Error('no fixture audio has been created yet')
          return instance
        },
      }
    }

    const emit = (fn: () => void) => act(() => { fn() })
    const flush = () => act(async () => {})

    it('replays a recorded sample as a normal voice turn, confirmation included', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const audio = createFakeFixtureAudio()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} fixtureAudio={audio.factory} />)

      const drawer = await openControls(user)
      expect(drawer).toHaveTextContent('语音兜底回放')
      await user.click(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' }))
      await flush()

      // The tool stays open while the recording enters the ordinary listening
      // path; the driver-facing entry remains independently usable.
      expect(drawer).toBeVisible()
      expect(screen.getByRole('button', { name: /改用文字输入|收起文字输入/ })).toBeVisible()
      expect(audio.current().played).toBe(1)
      expect(screen.getByRole('button', { name: '取消聆听' })).toBeInTheDocument()

      // The recording ends; its canonical transcript waits in the field like
      // any other turn's words. Nothing has been submitted.
      emit(() => audio.current().onended?.())
      expect(screen.getByLabelText('任务输入')).toHaveValue('我现在要去机场接妈妈和豆豆')
      expect(screen.getByRole('status', { name: '语音状态' })).toHaveTextContent('已转写，确认或编辑后发送。')
      expect(create).not.toHaveBeenCalled()

      // 发送 confirms it with the sample's recorded source and confidence.
      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备接机')
      expect(create).toHaveBeenCalledWith('我现在要去机场接妈妈和豆豆', {
        vehicleContext: expect.anything(),
        source: 'voice',
        confidence: 0.96,
      })

      // The armed sample was consumed: the next press listens for real again.
      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      expect(speech.engines.length).toBeGreaterThan(0)
    })

    it('holds the noisy sample at the confirmation step instead of auto-submitting', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const audio = createFakeFixtureAudio()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} fixtureAudio={audio.factory} />)

      await openControls(user)
      await user.click(screen.getByRole('button', { name: '嘈杂样本（需确认）' }))
      await flush()
      emit(() => audio.current().onended?.())

      // fixtures/airport-pickup/voice/transcripts.json marks this sample
      // `requiresConfirmation`; the turn must stop here until 发送.
      expect(screen.getByRole('button', { name: '放弃这次语音输入' })).toBeInTheDocument()
      expect(create).not.toHaveBeenCalled()

      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备接机')
      expect(create).toHaveBeenCalledWith('我现在要去机场接妈妈和豆豆', {
        vehicleContext: expect.anything(),
        source: 'voice',
        confidence: 0.51,
      })
    })

    it('still plays and parks the transcript when there is no speech engine at all', async () => {
      const user = userEvent.setup()
      const audio = createFakeFixtureAudio()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      // No `speech` prop: jsdom exposes no Web Speech API, the very situation
      // the offline fallback exists for.
      render(<App api={api} fixtureAudio={audio.factory} />)
      expect(screen.getByRole('button', { name: '语音入口暂不可用' })).toBeDisabled()

      await openControls(user)
      await user.click(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' }))

      // The recording still plays for the audience; the transcript is parked in
      // the text field, and only 发送 moves it on.
      expect(audio.current().played).toBe(1)
      const input = screen.getByLabelText('任务输入')
      expect(input).toHaveValue('我现在要去机场接妈妈和豆豆')
      expect(create).not.toHaveBeenCalled()

      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备接机')
      // Without a recognition turn there is no honest voice meta to claim.
      expect(create).toHaveBeenCalledWith('我现在要去机场接妈妈和豆豆', { vehicleContext: expect.anything() })
    })

    it('refuses to replay over an unsent draft the driver typed', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const audio = createFakeFixtureAudio()
      const create = vi.fn()
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<App api={api} speech={speech.deps} fixtureAudio={audio.factory} />)

      // The driver opens the keyboard and starts writing their own request.
      await user.click(screen.getByRole('button', { name: '改用文字输入' }))
      await user.clear(screen.getByLabelText('任务输入'))
      await user.type(screen.getByLabelText('任务输入'), '先去公司拿电脑')

      // Those words are theirs; replay must not silently replace them.
      let drawer = await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' })).toBeDisabled()
      expect(drawer).toHaveTextContent('输入框里还有未发送的内容')
      await user.keyboard('{Escape}')

      // Clearing the field by hand releases it, and replay is available again.
      await user.clear(screen.getByLabelText('任务输入'))
      drawer = await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' })).toBeEnabled()
      expect(create).not.toHaveBeenCalled()
    })

    it('will not let a second replay overwrite a parked, unconfirmed transcript', async () => {
      const user = userEvent.setup()
      const audio = createFakeFixtureAudio()
      const create = vi.fn().mockResolvedValue(apiResponse(createInitialTask()))
      const api = { create, event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      // Degraded path: no speech engine, so the transcript parks in the field.
      render(<App api={api} fixtureAudio={audio.factory} />)

      await openControls(user)
      await user.click(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' }))
      expect(screen.getByLabelText('任务输入')).toHaveValue('我现在要去机场接妈妈和豆豆')

      // The parked words are unconfirmed; another sample may not clobber them.
      await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' })).toBeDisabled()
      await user.keyboard('{Escape}')

      // Sending them releases the field, and replay opens up again.
      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备接机')
      await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '补充航班号' })).toBeEnabled()
      expect(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' })).toBeDisabled()
    })

    it('routes a fixture through the live wake queue without opening a fixture recognition engine', async () => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const audio = createFakeFixtureAudio()
      const created = apiResponse(createCockpitTask('wake-fixture-created'))
      const api = { create: vi.fn().mockResolvedValue(created), event: vi.fn(), action: vi.fn(), confirmation: vi.fn() }
      render(<AppComponent api={api} speech={speech.deps} fixtureAudio={audio.factory} />)

      await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
      act(() => { speech.engine().onstart?.() })
      const liveEngine = speech.engine()
      await openControls(user)
      await user.click(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' }))
      expect(speech.engines).toHaveLength(1)
      expect(liveEngine.aborted).toBeGreaterThan(0)
      expect(api.create).not.toHaveBeenCalled()

      act(() => { audio.current().onended?.() })
      await waitFor(() => expect(api.create).toHaveBeenCalledWith(
        '我现在要去机场接妈妈和豆豆',
        expect.objectContaining({ source: 'voice', confidence: 0.96 }),
      ))
      expect(speech.engines).toHaveLength(2)
      expect(speech.engine()).not.toBe(liveEngine)
    })

    it.each([
      ['确认重新开始', true],
      ['取消重新开始', false],
    ])('keeps only the reset decision fixture "%s" available during wake confirmation', async (label, confirmsReset) => {
      const user = userEvent.setup()
      const speech = createFakeSpeech()
      const audio = createFakeFixtureAudio()
      const active = apiResponse(createCockpitTask(`fixture-reset-${confirmsReset ? 'confirm' : 'cancel'}`))
      const cancelled = apiResponse({ ...active.task, phase: 'cancelled' })
      const api = {
        create: vi.fn().mockResolvedValue(active), event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
        cancel: vi.fn().mockResolvedValue(cancelled),
      }
      render(<AppComponent api={api} speech={speech.deps} fixtureAudio={audio.factory} />)

      await user.click(screen.getByRole('button', { name: '启用小南语音唤醒' }))
      act(() => { speech.engine().onstart?.(); speech.engine().emit('小南，我要去机场接人', true, 0.9) })
      await waitFor(() => expect(api.create).toHaveBeenCalledOnce())
      act(() => { speech.engine().emit('小南，重新开始', true, 0.9) })

      await openControls(user)
      const controls = fixtureReplayControls()
      expect(controls.getByRole('button', { name: label })).toBeEnabled()
      expect(controls.getByRole('button', { name: confirmsReset ? '取消重新开始' : '确认重新开始' })).toBeEnabled()
      expect(controls.getByRole('button', { name: '查询天气' })).toBeDisabled()
      await user.click(controls.getByRole('button', { name: label }))
      act(() => { audio.current().onended?.() })

      if (confirmsReset) {
        await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(active.task, '用户确认重新开始'))
        expect(await screen.findByTestId('cockpit-workspace')).toHaveAttribute('data-cockpit-mode', 'idle')
      } else {
        await waitFor(() => expect(screen.getAllByText('等待唤醒').length).toBeGreaterThan(0))
        expect(api.cancel).not.toHaveBeenCalled()
        expect(screen.getByRole('region', { name: '当前行程' })).toHaveAttribute('data-window-title', '机场接人任务')
      }
      expect(api.event).not.toHaveBeenCalled()
    })

    it('enables state-bound samples only when their matching UI capability is visible', async () => {
      const user = userEvent.setup()
      const initial = {
        ...createCockpitTask('fixture-flight-list'),
        phase: 'choosing-flight' as const,
        pickupAirport: { label: '虹桥机场', code: 'SHA' },
      } as AirportPickupTaskState
      const base = composePickupSpec(initial)
      const arrivalsUi: UISpec = {
        ...base,
        layout: { type: 'stack', gap: 'md', slots: { main: [] } },
        components: [{
          id: 'flight-choices',
          type: 'flight-choices',
          actions: ['pick-MU5102', 'pick-MU5103'],
          props: {
            arrivalCityName: '上海', dateLabel: '今天', freshness: 'fixture',
            choices: [
              { flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都', status: 'scheduled', statusLabel: '计划中', arrivalTimeLabel: '20:30', terminal: 'T2', airportName: '虹桥机场', actionId: 'pick-MU5102' },
              { flightNumber: 'MU5103', airlineName: '东方航空', originName: '深圳宝安', status: 'delayed', statusLabel: '延误', arrivalTimeLabel: '20:30', terminal: 'T1', airportName: '虹桥机场', actionId: 'pick-MU5103' },
            ],
          },
        }],
        actions: [
          { id: 'pick-MU5102', label: '接 MU5102', style: 'primary', event: { type: 'agent-message', text: '航班号 MU5102' } },
          { id: 'pick-MU5103', label: '接 MU5103', style: 'secondary', event: { type: 'agent-message', text: '航班号 MU5103' } },
        ],
        windows: [{
          id: 'fixture-flight-list-window', kind: 'flight-list', title: '虹桥机场到达航班',
          componentIds: ['flight-choices'], actionIds: ['pick-MU5102', 'pick-MU5103'], size: 'large',
          controls: { closable: true, minimizable: true, maximizable: true },
        }],
      }
      const api = {
        create: vi.fn().mockResolvedValue({ ...apiResponse(initial), ui: arrivalsUi }),
        event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
      }
      render(<App api={api} />)

      let drawer = await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '选择第一个航班' })).toBeDisabled()
      expect(fixtureReplayControls().getByRole('button', { name: '开始导航' })).toBeDisabled()
      await user.keyboard('{Escape}')
      await user.click(screen.getByRole('button', { name: '发送' }))

      drawer = await openControls(user)
      expect(drawer).toHaveTextContent('语音兜底回放')
      expect(fixtureReplayControls().getByRole('button', { name: '选择第一个航班' })).toBeEnabled()
      expect(fixtureReplayControls().getByRole('button', { name: '查看充电' })).toBeDisabled()
      expect(fixtureReplayControls().getByRole('button', { name: '模糊接机目标' })).toBeDisabled()
      expect(fixtureReplayControls().getByRole('button', { name: '提醒乘客带伞' })).toBeDisabled()
    })

    it('replays the charging fallback through the Agent generated-UI path', async () => {
      const user = userEvent.setup()
      const audio = createFakeFixtureAudio()
      const initial = {
        ...createCockpitTask('fixture-charging'),
        phase: 'confirming-outbound' as const,
        pickupAirport: { label: '虹桥机场', code: 'SHA' },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场', eta: '2026-07-22T20:25:00+08:00', status: 'planned' as const },
      } as AirportPickupTaskState
      const initialResponse = apiResponse(initial)
      const chargingUi: UISpec = {
        ...initialResponse.ui,
        components: [{
          id: 'charging-fixture-result', type: 'charging-recommendation', props: {
            recommended: false, reason: '当前路线无需额外补能', currentBatteryPercent: 42,
            estimatedFinalBatteryPercent: 30,
          },
        }],
        layout: { type: 'stack', gap: 'md', slots: { main: [] } },
        windows: [{
          id: 'charging-fixture-window', kind: 'charging', title: '充电方案',
          componentIds: ['charging-fixture-result'], size: 'large',
          controls: { closable: true, minimizable: true, maximizable: true },
        }],
      }
      const event = vi.fn().mockResolvedValue({ ...initialResponse, ui: chargingUi })
      const api = {
        create: vi.fn().mockResolvedValue(initialResponse), event, action: vi.fn(), confirmation: vi.fn(),
      }
      render(<App api={api} fixtureAudio={audio.factory} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await openControls(user)
      await user.click(fixtureReplayControls().getByRole('button', { name: '查看充电' }))
      act(() => { audio.current().onended?.() })
      expect(screen.getByLabelText('任务输入')).toHaveValue('查看充电')

      await user.click(screen.getByRole('button', { name: '发送' }))
      await waitFor(() => expect(event).toHaveBeenCalledWith(initial, expect.objectContaining({
        type: 'user.input', text: '查看充电',
      })))
      expect(await screen.findByLabelText('充电方案窗口')).toBeInTheDocument()
      expect(screen.getByText('当前路线无需额外补能')).toBeInTheDocument()
    })

    it('keeps a fixture disabled when its visible card has no matching executable action', async () => {
      const user = userEvent.setup()
      const initial = createInitialTask()
      const base = composePickupSpec(initial)
      const brokenArrivalsUi: UISpec = {
        ...base,
        layout: { type: 'stack', gap: 'md', slots: { main: ['flight-choices'] } },
        components: [{
          id: 'flight-choices',
          type: 'flight-choices',
          actions: ['missing-pick'],
          props: {
            arrivalCityName: '上海', dateLabel: '今天', freshness: 'fixture',
            choices: [
              { flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都', status: 'scheduled', statusLabel: '计划中', arrivalTimeLabel: '20:30', terminal: 'T2', airportName: '虹桥机场', actionId: 'missing-pick' },
              { flightNumber: 'MU5103', airlineName: '东方航空', originName: '深圳宝安', status: 'delayed', statusLabel: '延误', arrivalTimeLabel: '20:30', terminal: 'T1', airportName: '虹桥机场', actionId: 'missing-pick-2' },
            ],
          },
        }],
        actions: [],
      }
      const api = {
        create: vi.fn().mockResolvedValue({ ...apiResponse(initial), ui: brokenArrivalsUi }),
        event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '选择第一个航班' })).toBeDisabled()
    })

    it('uses the renderer first-wins rule when duplicate action ids disagree', async () => {
      const user = userEvent.setup()
      const initial = createInitialTask()
      const base = composePickupSpec(initial)
      const ui: UISpec = {
        ...base,
        layout: { type: 'stack', gap: 'md', slots: { main: ['flight-choices'] } },
        components: [{
          id: 'flight-choices',
          type: 'flight-choices',
          actions: ['pick-MU5102'],
          props: {
            arrivalCityName: '上海', dateLabel: '今天', freshness: 'fixture',
            choices: [
              { flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都', status: 'scheduled', statusLabel: '计划中', arrivalTimeLabel: '20:30', terminal: 'T2', airportName: '虹桥机场', actionId: 'pick-MU5102' },
              { flightNumber: 'MU5103', airlineName: '东方航空', originName: '深圳宝安', status: 'delayed', statusLabel: '延误', arrivalTimeLabel: '20:30', terminal: 'T1', airportName: '虹桥机场', actionId: 'pick-MU5103' },
            ],
          },
        }],
        actions: [
          { id: 'pick-MU5102', label: '第一条不可执行', style: 'secondary', event: { type: 'dismiss', targetId: 'nothing' } },
          { id: 'pick-MU5102', label: '第二条看似可执行', style: 'primary', event: { type: 'agent-message', text: '航班号 MU5102' } },
        ],
      }
      const api = {
        create: vi.fn().mockResolvedValue({ ...apiResponse(initial), ui }),
        event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '选择第一个航班' })).toBeDisabled()
    })

    it('enables the dismiss fixture for the typed advisory action id', async () => {
      const user = userEvent.setup()
      const task: AirportPickupTaskState = {
        ...createInitialTask(),
        phase: 'driving-to-airport',
        taskRevision: 4,
        passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
        flight: { flightNumber: 'MU5102', trusted: true, status: 'in-air', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
        weatherAdvisory: { status: 'active', advisedAt: '2026-07-22T20:10:00+08:00' },
      }
      const base = apiResponse(task)
      const ui: UISpec = {
        ...base.ui,
        layout: { type: 'stack', gap: 'md', slots: { main: ['weather-advisory'] } },
        components: [{
          id: 'weather-advisory',
          type: 'weather-card',
          actions: ['dismiss-advisory-weather'],
          props: {
            location: '虹桥机场 T2', timeLabel: '20:40 到达时', temperatureC: 24,
            condition: 'light-rain', conditionLabel: '小雨', precipitationChance: 70, freshness: 'fixture',
          },
        }],
        actions: [{ id: 'dismiss-advisory-weather', label: '暂不处理', style: 'secondary', event: { type: 'agent-message', text: '暂不处理' } }],
      }
      const api = {
        create: vi.fn().mockResolvedValue({ ...base, ui }),
        event: vi.fn(), action: vi.fn(), confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await openControls(user)
      expect(fixtureReplayControls().getByRole('button', { name: '暂不处理天气提醒' })).toBeEnabled()
    })

    it('advances the demo cursor after any supported arrivals-board ordinal', async () => {
      const user = userEvent.setup()
      const collecting = createInitialTask()
      const prepared: AirportPickupTaskState = {
        ...collecting,
        phase: 'preparing',
        taskRevision: 1,
        passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
        flight: { flightNumber: 'HO1252', trusted: true, status: 'scheduled', scheduledArrival: '2026-07-22T20:55:00+08:00', estimatedArrival: '2026-07-22T20:55:00+08:00', terminal: 'T2' },
        charging: { recommended: true, accepted: false, status: 'planned' },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' },
      }
      const event = vi.fn()
        .mockResolvedValueOnce(apiResponse(prepared))
        .mockResolvedValue(apiResponse(prepared))
      const api = {
        create: vi.fn().mockResolvedValue(apiResponse(collecting)),
        event, action: vi.fn(), confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await user.clear(screen.getByLabelText('任务输入'))
      await user.type(screen.getByLabelText('任务输入'), '选第三个')
      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备出发')

      await openControls(user)
      await user.click(screen.getByRole('button', { name: /推进下一事件/ }))
      await waitFor(() => expect(event).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        eventId: 'event-charging-recommended',
      })))
    })

    it('advances after a normalized flight number with spaces or prose around it', async () => {
      const user = userEvent.setup()
      const task = createInitialTask()
      const prepared = {
        ...task,
        phase: 'preparing' as const,
        taskRevision: 1,
        passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
        flight: { flightNumber: 'MU5102', trusted: true, status: 'scheduled' as const, scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
        charging: { recommended: true, accepted: false, status: 'planned' as const },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' as const },
      }
      const event = vi.fn().mockResolvedValue(apiResponse(prepared))
      const api = {
        create: vi.fn().mockResolvedValue(apiResponse(task)),
        event,
        action: vi.fn(), confirmation: vi.fn(),
      }
      render(<App api={api} />)

      await user.click(screen.getByRole('button', { name: '发送' }))
      await user.clear(screen.getByLabelText('任务输入'))
      await user.type(screen.getByLabelText('任务输入'), '航班是 MU 5102')
      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('准备出发')

      await openControls(user)
      await user.click(screen.getByRole('button', { name: /推进下一事件/ }))
      await waitFor(() => expect(event).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        eventId: 'event-charging-recommended',
      })))
    })

    it('submits the navigation fixture through the registered action and not user.input', async () => {
      const user = userEvent.setup()
      const audio = createFakeFixtureAudio()
      const preparedTask: AirportPickupTaskState = {
        ...createCockpitTask('fixture-outbound-confirmation'),
        phase: 'confirming-outbound',
        taskRevision: 3,
        pickupAirport: { label: '虹桥机场', code: 'SHA' },
        passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
        flight: { flightNumber: 'MU5102', trusted: true, status: 'scheduled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' },
        navigationSimulation: {
          leg: 'outbound', routeId: 'route-airport-001', distanceKm: 32, initialBatteryPercent: 42,
          estimatedBatteryAtArrival: 27,
          profiles: {
            slow: { durationSeconds: 150, displaySpeedKph: 35 },
            normal: { durationSeconds: 90, displaySpeedKph: 55 },
            fast: { durationSeconds: 45, displaySpeedKph: 75 },
          },
        },
      }
      const prepared = apiResponse(preparedTask)
      prepared.ui = {
        ...prepared.ui,
        layout: { type: 'stack', gap: 'md', slots: { main: [] } },
        components: [{
          id: 'outbound-confirmation',
          type: 'route-confirmation',
          actions: ['start-outbound'],
          props: {
            leg: 'outbound', destination: '虹桥机场 T2', flightNumber: 'MU5102',
            flightEstimatedArrival: '2026-07-22T20:40:00+08:00', durationMinutes: 20,
            arrivalTime: '2026-07-22T20:25:00+08:00', distanceKm: 32,
            currentBatteryPercent: 42, estimatedBatteryAtArrival: 27, simulated: true,
          },
        }],
        actions: [{ id: 'start-outbound', label: '现在出发', style: 'primary', event: { type: 'tool-request', actionToken: 'start-outbound' } }],
        windows: [{
          id: 'fixture-outbound-confirmation-window', kind: 'outbound-confirmation', title: '现在出发',
          componentIds: ['outbound-confirmation'], actionIds: ['start-outbound'], size: 'medium',
          controls: { closable: true, minimizable: true, maximizable: true },
        }],
      }
      const startedTask: AirportPickupTaskState = {
        ...preparedTask,
        phase: 'outbound-driving',
        taskRevision: 4,
        navigation: { ...preparedTask.navigation!, status: 'active' },
      }
      const api = {
        create: vi.fn().mockResolvedValue(prepared),
        event: vi.fn(),
        action: vi.fn().mockResolvedValue(apiResponse(startedTask)),
        confirmation: vi.fn(),
      }
      render(<App api={api} fixtureAudio={audio.factory} />)
      await user.click(screen.getByRole('button', { name: '发送' }))

      await openControls(user)
      await user.click(fixtureReplayControls().getByRole('button', { name: '开始导航' }))
      await waitFor(() => expect(audio.current().played).toBe(1))
      emit(() => audio.current().onended?.())
      await waitFor(() => expect(screen.getByLabelText('任务输入')).toHaveValue('开始导航'))
      await user.click(screen.getByRole('button', { name: '发送' }))

      await waitFor(() => expect(api.action).toHaveBeenCalledWith(expect.anything(), 'start-outbound', 'outbound-confirmation'))
      expect(api.event).not.toHaveBeenCalled()
      expect(await screen.findByLabelText('导航信息')).toBeInTheDocument()
    })

    it('keeps spoken outbound confirmation executable when it is a primary surface', async () => {
      const user = userEvent.setup()
      const preparedTask: AirportPickupTaskState = {
        ...createCockpitTask('fixture-primary-outbound-voice'),
        phase: 'confirming-outbound',
        taskRevision: 3,
        pickupAirport: { label: '虹桥机场', code: 'SHA' },
        passengers: { memberIds: ['mom'], names: ['妈妈'], confirmedOnboard: false },
        flight: { flightNumber: 'MU5102', trusted: true, status: 'scheduled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' },
        navigationSimulation: {
          leg: 'outbound', routeId: 'route-airport-001', distanceKm: 32, initialBatteryPercent: 42,
          estimatedBatteryAtArrival: 27,
          profiles: {
            slow: { durationSeconds: 150, displaySpeedKph: 35 },
            normal: { durationSeconds: 90, displaySpeedKph: 55 },
            fast: { durationSeconds: 45, displaySpeedKph: 75 },
          },
        },
      }
      const prepared = apiResponse(preparedTask)
      prepared.ui = {
        ...prepared.ui,
        layout: { type: 'stack', gap: 'md', slots: { main: ['outbound-confirmation'] } },
        components: [{
          id: 'outbound-confirmation', type: 'route-confirmation', actions: ['start-outbound'],
          props: {
            leg: 'outbound', destination: '虹桥机场 T2', flightNumber: 'MU5102',
            flightEstimatedArrival: '2026-07-22T20:40:00+08:00', durationMinutes: 20,
            arrivalTime: '2026-07-22T20:25:00+08:00', distanceKm: 32,
            currentBatteryPercent: 42, estimatedBatteryAtArrival: 27, simulated: true,
          },
        }],
        actions: [{ id: 'start-outbound', label: '现在出发', style: 'primary', event: { type: 'tool-request', actionToken: 'start-outbound' } }],
        // Primary confirmation intentionally has no floating window metadata.
        windows: [],
      }
      const api = {
        create: vi.fn().mockResolvedValue(prepared),
        event: vi.fn(),
        action: vi.fn().mockResolvedValue(apiResponse({ ...preparedTask, phase: 'outbound-driving', taskRevision: 4, navigation: { ...preparedTask.navigation!, status: 'active' } })),
        confirmation: vi.fn(),
      }
      render(<App api={api} />)
      await user.click(screen.getByRole('button', { name: '发送' }))
      await user.clear(screen.getByLabelText('任务输入'))
      await user.type(screen.getByLabelText('任务输入'), '现在出发')
      await user.click(screen.getByRole('button', { name: '发送' }))
      await waitFor(() => expect(api.action).toHaveBeenCalledWith(expect.anything(), 'start-outbound', 'outbound-confirmation'))
      expect(api.event).not.toHaveBeenCalled()
    })

    it('does not consume the navigation timeline step when the registered action fails', async () => {
      const user = userEvent.setup()
      const audio = createFakeFixtureAudio()
      const preparedTask: AirportPickupTaskState = {
        ...createCockpitTask('fixture-outbound-failure'),
        phase: 'confirming-outbound',
        taskRevision: 3,
        pickupAirport: { label: '虹桥机场', code: 'SHA' },
        passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
        flight: { flightNumber: 'MU5102', trusted: true, status: 'scheduled', scheduledArrival: '2026-07-22T20:30:00+08:00', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
        navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'planned' },
        navigationSimulation: {
          leg: 'outbound', routeId: 'route-airport-001', distanceKm: 32, initialBatteryPercent: 42,
          estimatedBatteryAtArrival: 27,
          profiles: {
            slow: { durationSeconds: 150, displaySpeedKph: 35 },
            normal: { durationSeconds: 90, displaySpeedKph: 55 },
            fast: { durationSeconds: 45, displaySpeedKph: 75 },
          },
        },
      }
      const prepared = apiResponse(preparedTask)
      prepared.ui = {
        ...prepared.ui,
        layout: { type: 'stack', gap: 'md', slots: { main: [] } },
        components: [{
          id: 'outbound-confirmation',
          type: 'route-confirmation',
          actions: ['start-outbound'],
          props: {
            leg: 'outbound', destination: '虹桥机场 T2', flightNumber: 'MU5102',
            flightEstimatedArrival: '2026-07-22T20:40:00+08:00', durationMinutes: 20,
            arrivalTime: '2026-07-22T20:25:00+08:00', distanceKm: 32,
            currentBatteryPercent: 42, estimatedBatteryAtArrival: 27, simulated: true,
          },
        }],
        actions: [{ id: 'start-outbound', label: '现在出发', style: 'primary', event: { type: 'tool-request', actionToken: 'start-outbound' } }],
        windows: [{
          id: 'fixture-outbound-confirmation-window', kind: 'outbound-confirmation', title: '现在出发',
          componentIds: ['outbound-confirmation'], actionIds: ['start-outbound'], size: 'medium',
          controls: { closable: true, minimizable: true, maximizable: true },
        }],
      }
      const failed = {
        ...prepared,
        effects: [{ effectId: 'nav:0', type: 'navigation.start' as const, status: 'failed' as const, tool: 'navigation.start', errorCode: 'PROVIDER_TIMEOUT' }],
      }
      const event = vi.fn().mockResolvedValue(prepared)
      const action = vi.fn().mockResolvedValue(failed)
      const api = {
        create: vi.fn().mockResolvedValue(prepared),
        event,
        action,
        confirmation: vi.fn(),
      }
      render(<App api={api} fixtureAudio={audio.factory} />)
      await user.click(screen.getByRole('button', { name: '发送' }))

      await openControls(user)
      await user.click(fixtureReplayControls().getByRole('button', { name: '开始导航' }))
      await waitFor(() => expect(audio.current().played).toBe(1))
      emit(() => audio.current().onended?.())
      await user.click(screen.getByRole('button', { name: '发送' }))
      await findPrimaryPhase('确认出发')

      // The action response is unchanged, so the confirmation phase and its
      // timeline cursor remain in place even though this path clears the draft.
      expect(screen.getByRole('region', { name: '当前行程' })).toHaveAttribute('data-phase', 'confirming-outbound')

      await openControls(user)
      expect(screen.getByRole('button', { name: '推进下一事件' })).toBeDisabled()
      expect(event).not.toHaveBeenCalled()
      expect(action).toHaveBeenCalledWith(expect.anything(), 'start-outbound', 'outbound-confirmation')
    })
  })
})
