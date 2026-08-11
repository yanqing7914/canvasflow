import type { UISpec, VehicleContext } from '@canvasflow/schema'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} onLegComplete={onComplete} />,
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

  it('keeps the map mounted while HUD and windows change', () => {
    const clock = manualClock()
    const first = spec()
    const rendered = render(
      <NavigationWorkspace task={task()} spec={first} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} />,
    )
    const map = screen.getByLabelText('模拟导航地图')
    rendered.rerender(
      <NavigationWorkspace task={{ ...task(), cockpit: { speedMode: 'normal', hudVisible: false } }} spec={first} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: '显示导航信息' })).toBeInTheDocument()
    expect(screen.getByLabelText('最小导航信息')).toHaveTextContent('55')
    expect(screen.getByLabelText('最小导航信息')).toHaveTextContent('72')
    const weatherWindow = {
      id: 'weather-1', kind: 'weather' as const, title: '当前位置天气', componentIds: [], size: 'compact' as const,
      controls: { closable: true, minimizable: true, maximizable: true },
    }
    rendered.rerender(
      <NavigationWorkspace task={{ ...task(), cockpit: { speedMode: 'normal', hudVisible: false } }} spec={spec([weatherWindow])} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} />,
    )
    expect(screen.getByLabelText('模拟导航地图')).toBe(map)
    expect(screen.getByLabelText('当前位置天气窗口')).toBeInTheDocument()
  })

  it('keeps the map mounted when the outbound route is replaced by the return leg', () => {
    const clock = manualClock()
    const rendered = render(
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} />,
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
        onAction={vi.fn()}
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
      <NavigationWorkspace task={backendTask} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} />,
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
      <NavigationWorkspace task={task()} spec={spec()} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} />,
    )
    rendered.unmount()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('renders live vehicle data and accessible window controls', () => {
    const clock = manualClock()
    const statusWindow = {
      id: 'vehicle-1', kind: 'vehicle-status' as const, title: '车辆状态', componentIds: [], size: 'medium' as const,
      controls: { closable: true, minimizable: true, maximizable: true },
    }
    render(
      <NavigationWorkspace task={task()} spec={spec([statusWindow])} initialVehicle={vehicle} clock={clock} pending={false} onAction={vi.fn()} />,
    )
    expect(screen.getByLabelText('实时车辆状态')).toHaveTextContent('55 km/h')
    const minimize = screen.getByRole('button', { name: '最小化车辆状态窗口' })
    fireEvent.click(minimize)
    expect(screen.getByRole('button', { name: '恢复车辆状态窗口' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复车辆状态窗口' }))
    fireEvent.click(screen.getByRole('button', { name: '放大车辆状态窗口' }))
    expect(screen.getByRole('button', { name: '还原车辆状态窗口' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭车辆状态窗口' }))
    expect(screen.queryByLabelText('车辆状态窗口')).not.toBeInTheDocument()
  })
})
