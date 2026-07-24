import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { createInitialTask } from '@canvasflow/agent'
import { composePickupSpec } from '@canvasflow/ui'

describe('demo integration', () => {
  it('composes a valid UI from task state', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.surfaceId).toBe('airport-pickup-main')
    expect(spec.meta.sourceTaskRevision).toBe(spec.taskRevision)
  })

  it('shows the information request for the initial phase', () => {
    const spec = composePickupSpec(createInitialTask())
    expect(spec.components[0]).toMatchObject({ type: 'status-banner', props: { title: '请补充航班号' } })
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
      props: { recommended: true, reason: '完成往返后预计低于安全余量（对比 3 站）' },
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
      { speedKph: 0, density: 'full', stations: 3 },
      { speedKph: 35, density: 'compact', stations: 2 },
      { speedKph: 80, density: 'minimal', stations: 1 },
    ] as const

    for (const { speedKph, density, stations } of cases) {
      const fromVehicle = composePickupSpec(chargingTask, { vehicle: { speedKph } })
      expect(fromVehicle).toMatchObject({
        presentation: { density },
        components: [{
          type: 'charging-recommendation',
          props: { reason: `完成往返后预计低于安全余量（对比 ${stations} 站）` },
        }],
      })

      const fromToolResult = composePickupSpec(chargingTask, {
        toolResults: {
          'vehicle.get-status': {
            ok: true,
            data: { speedKph, batteryPercent: 18, remainingRangeKm: 46, gear: 'D', isNight: true, rearOccupied: false },
          },
        },
      })
      expect(fromToolResult.presentation.density).toBe(density)
      expect(fromToolResult.components[0]).toMatchObject({
        props: { reason: `完成往返后预计低于安全余量（对比 ${stations} 站）` },
      })
    }
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

  it('advances the rendered demo and disables terminal controls', async () => {
    const user = userEvent.setup()
    render(<App />)
    const advance = screen.getByRole('button', { name: '推进下一事件' })
    expect(screen.getByText(/preparing/)).toBeInTheDocument()
    await user.click(advance)
    expect(screen.getByText(/driving-to-airport/)).toBeInTheDocument()
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

  it('wires the failed-message retry action through prepare → confirm → send', async () => {
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
    // First click only arms an opaque confirmation; send waits for explicit accept.
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认发送' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认发送' }))
    expect(screen.queryByRole('button', { name: '确认发送' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument()
    expect(screen.getByText(/driving-to-airport/)).toBeInTheDocument()
  })

  it('does not retry landing notify when no authorized contact remains', async () => {
    const user = userEvent.setup()
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
    await user.click(screen.getByRole('button', { name: '重试发送' }))
    // No authorized contact → handler no-ops; retry action remains.
    expect(screen.getByRole('button', { name: '重试发送' })).toBeInTheDocument()
  })
})
