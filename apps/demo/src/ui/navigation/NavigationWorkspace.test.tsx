import type { UISpec, VehicleContext } from '@canvasflow/schema'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NavigationWorkspace } from './NavigationWorkspace'
import type { CockpitUISpec, RuntimeNavigationTask } from './contracts'
import type { NavigationClock } from './simulator'

function manualClock(startAt = 1_000): NavigationClock & { advance(ms: number): void } {
  let now = startAt
  let callback: (() => void) | undefined
  return {
    now: () => now,
    schedule: (next) => {
      callback = next
      return () => { callback = undefined }
    },
    advance: (ms) => {
      now += ms
      callback?.()
    },
  }
}

const vehicle: VehicleContext = {
  speedKph: 0,
  batteryPercent: 72,
  remainingRangeKm: 302,
  gear: 'P',
  isNight: true,
}

function task(phase: RuntimeNavigationTask['phase'] = 'outbound-driving'): RuntimeNavigationTask {
  return {
    taskId: 'cockpit-1',
    phase,
    pickupAirport: { label: '虹桥机场 T2', code: 'SHA' },
    flight: {
      flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都',
      estimatedArrival: '2026-08-11T15:30:00+08:00', terminal: 'T2', statusLabel: '飞行中',
    },
    navigation: { routeId: 'outbound-1', destination: '虹桥机场 T2', eta: '2026-08-11T15:10:00+08:00', status: 'active' },
    cockpit: { speedMode: 'normal', hudVisible: true },
  }
}

function spec(windows: CockpitUISpec['windows'] = []): UISpec {
  return {
    version: '1.0', taskId: 'cockpit-1', surfaceId: 'airport-pickup-main', taskRevision: 1, uiRevision: 1,
    phase: 'driving-to-airport', title: '去虹桥机场接人',
    presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'normal' },
    layout: { type: 'stack', gap: 'md', slots: { main: [] } },
    components: [], actions: [],
    meta: { generatedBy: 'composer', sourceTaskRevision: 1, requiresConfirm: false, generatedAt: '2026-08-11T14:00:00+08:00', traceId: 'trace-cockpit' },
    windows,
  } as CockpitUISpec
}

describe('NavigationWorkspace', () => {
  it('advances continuously with an injected clock and emits one leg completion', () => {
    const clock = manualClock()
    const onComplete = vi.fn()
    const { container } = render(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onLegComplete={onComplete} />,
    )
    const start = container.querySelector('.persistent-route-map__vehicle')?.getAttribute('transform')
    act(() => clock.advance(45_000))
    const halfway = container.querySelector('.persistent-route-map__vehicle')?.getAttribute('transform')
    expect(halfway).not.toBe(start)
    expect(screen.getByText('16.0')).toBeInTheDocument()
    act(() => clock.advance(45_000))
    expect(screen.getByText('已到达机场，等待接人')).toBeInTheDocument()
    expect(onComplete).toHaveBeenCalledOnce()
    act(() => clock.advance(5_000))
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('does not hammer a failed arrival handoff on every simulator tick', async () => {
    const clock = manualClock()
    let finishFirst: ((completed: boolean) => void) | undefined
    const onComplete = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = resolve }))
    render(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onLegComplete={onComplete} />,
    )

    act(() => clock.advance(90_000))
    expect(onComplete).toHaveBeenCalledOnce()
    act(() => clock.advance(45_000))
    expect(onComplete).toHaveBeenCalledOnce()

    await act(async () => { finishFirst?.(false) })
    act(() => clock.advance(1_000))
    expect(onComplete).toHaveBeenCalledOnce()
    act(() => clock.advance(1_000))
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('retries a failed arrival handoff only after an explicit retry signal', async () => {
    const clock = manualClock()
    const onComplete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const rendered = render(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onLegComplete={onComplete} />,
    )

    act(() => clock.advance(90_000))
    await act(async () => {})
    expect(onComplete).toHaveBeenCalledOnce()

    rendered.rerender(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onLegComplete={onComplete} retryLeg={{ leg: 'outbound', nonce: 1 }} />,
    )
    await act(async () => {})
    expect(onComplete).toHaveBeenCalledTimes(2)
  })

  it('continues the simulator on the offline sketch while real map recovery is required', () => {
    const clock = manualClock()
    const onComplete = vi.fn()
    const onSnapshot = vi.fn()
    render(
      <NavigationWorkspace
        task={task()}
        spec={spec()}
        initialVehicle={vehicle}
        clock={clock}
        pending={false}
        initialMapRuntimeFailure
        onLegComplete={onComplete}
        onSnapshot={onSnapshot}
      />,
    )
    expect(screen.getByLabelText('模拟导航地图').closest('.navigation-workspace')).toHaveAttribute('data-map-runtime', 'fallback')

    act(() => clock.advance(45_000))
    expect(screen.getByText('模拟行程进度 50%')).toBeInTheDocument()
    expect(onSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({ progress: 0.5 })
    expect(onSnapshot.mock.calls.at(-1)?.[0].batteryPercent).toBeLessThan(vehicle.batteryPercent)

    act(() => clock.advance(45_000))
    expect(screen.getByText('已到达机场，等待接人')).toBeInTheDocument()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('keeps an arrival alert ahead of the maneuver in the minimum HUD', () => {
    const clock = manualClock()
    render(
      <NavigationWorkspace task={{ ...task(), cockpit: { speedMode: 'normal', hudVisible: false } }} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    act(() => clock.advance(90_000))
    // The alert is produced by the simulator at arrival and remains the primary
    // compact message when the driver folds the HUD.
    const minimumHud = screen.getByLabelText('最小导航信息')
    expect(minimumHud).toHaveTextContent('已到达机场，等待接人')
    expect(minimumHud).not.toHaveTextContent('沿道路向西行驶')
  })

  it('keeps the map mounted while HUD and windows change', () => {
    const clock = manualClock()
    const first = spec()
    const rendered = render(
      <NavigationWorkspace task={task()} spec={first} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    const map = screen.getByLabelText('模拟导航地图')
    rendered.rerender(
      <NavigationWorkspace task={{ ...task(), cockpit: { speedMode: 'normal', hudVisible: false } }} spec={first} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    expect(screen.getByRole('button', { name: '显示导航信息' })).toBeInTheDocument()
    const minimumHud = screen.getByLabelText('最小导航信息')
    expect(minimumHud).toHaveTextContent('虹桥机场 T2')
    expect(minimumHud).toHaveTextContent('当前位置附近道路')
    expect(minimumHud).toHaveTextContent('沿道路向西行驶')
    expect(minimumHud).toHaveTextContent('55')
    expect(minimumHud).toHaveTextContent('72')
    expect(minimumHud).not.toHaveTextContent('当前目的地')
    const weatherWindow = {
      id: 'weather-1', kind: 'weather' as const, title: '当前位置天气', componentIds: [], size: 'compact' as const,
      controls: { closable: true, minimizable: true, maximizable: true },
    }
    rendered.rerender(
      <NavigationWorkspace task={{ ...task(), cockpit: { speedMode: 'normal', hudVisible: false } }} spec={spec([weatherWindow])} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    expect(screen.getByLabelText('模拟导航地图')).toBe(map)
  })

  it('can provide simulator and HUD without mounting a second map', () => {
    const clock = manualClock()
    render(
      <NavigationWorkspace
        task={task()}
        spec={spec()}
        initialVehicle={vehicle}
        clock={clock}
        pending={false}
        renderMap={false}
      />,
    )

    expect(screen.queryByLabelText('模拟导航地图')).not.toBeInTheDocument()
    expect(screen.getByLabelText('导航信息')).toBeInTheDocument()
  })

  it('keeps the map mounted when the outbound route is replaced by the return leg', () => {
    const clock = manualClock()
    const rendered = render(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    const map = screen.getByLabelText('模拟导航地图')
    rendered.rerender(
      <NavigationWorkspace
        task={{
          ...task('return-driving'),
          navigation: { routeId: 'return-1', destination: '家', eta: '2026-08-11T16:30:00+08:00', status: 'active' },
          cockpit: { speedMode: 'normal', hudVisible: true, activeLeg: 'return' },
        }}
        spec={spec()}
        initialVehicle={vehicle}
        clock={clock}
        pending={false}
      />,
    )
    expect(screen.getByLabelText('模拟导航地图')).toBe(map)
    expect(screen.getByLabelText('模拟导航地图').closest('.navigation-workspace')).toHaveAttribute('data-leg', 'return')
  })

  it('uses backend simulation profiles and cockpit speed/HUD state', () => {
    const clock = manualClock()
    const backendTask: RuntimeNavigationTask = {
      ...task(),
      cockpit: { speedMode: 'fast', hudVisible: false },
      navigationSimulation: {
        leg: 'outbound', routeId: 'outbound-1', distanceKm: 10,
        initialBatteryPercent: 80, estimatedBatteryAtArrival: 70,
        profiles: {
          slow: { durationSeconds: 300, displaySpeedKph: 25 },
          normal: { durationSeconds: 200, displaySpeedKph: 45 },
          fast: { durationSeconds: 100, displaySpeedKph: 65 },
        },
      },
    }
    render(
      <NavigationWorkspace task={backendTask} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    expect(screen.getByLabelText('最小导航信息')).toHaveTextContent('65')
    act(() => clock.advance(50_000))
    expect(screen.getByLabelText('最小导航信息')).toHaveTextContent('75')
    expect(screen.getByText('模拟行程进度 50%')).toBeInTheDocument()
  })

  it('releases the injected simulator scheduler on unmount', () => {
    const cancel = vi.fn()
    const clock: NavigationClock = { now: () => 1_000, schedule: () => cancel }
    const rendered = render(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    rendered.unmount()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('shows the flight landing reminder once near 60% and can be closed', () => {
    const clock = manualClock()
    const onReminder = vi.fn()
    render(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onReminder={onReminder} />,
    )

    act(() => clock.advance(45_000))
    expect(screen.queryByRole('status', { name: '航班落地提醒' })).not.toBeInTheDocument()

    act(() => clock.advance(9_000))
    const reminder = screen.getByRole('status', { name: '航班落地提醒' })
    expect(reminder).toHaveTextContent('MU5102')
    expect(reminder).toHaveTextContent('模拟估算')
    expect(onReminder).toHaveBeenCalledOnce()

    act(() => clock.advance(9_000))
    expect(screen.getAllByRole('status', { name: '航班落地提醒' }).length).toBe(1)
    expect(onReminder).toHaveBeenCalledOnce()

    act(() => { screen.getByRole('button', { name: '最小化航班落地提醒' }).click() })
    expect(screen.queryByRole('status', { name: '航班落地提醒' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复航班落地提醒' })).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: '恢复航班落地提醒' }).click() })
    expect(screen.getByRole('status', { name: '航班落地提醒' })).toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: '关闭航班落地提醒' }).click() })
    expect(screen.queryByRole('status', { name: '航班落地提醒' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复航班落地提醒' })).not.toBeInTheDocument()
  })

  it('does not offer the flight reminder when the flight is unknown', () => {
    const clock = manualClock()
    render(
      <NavigationWorkspace task={{ ...task(), flight: undefined }} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} />,
    )
    act(() => clock.advance(54_000))
    expect(screen.queryByRole('status', { name: '航班落地提醒' })).not.toBeInTheDocument()
  })

})
