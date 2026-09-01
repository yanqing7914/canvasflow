import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UISpec } from '@canvasflow/schema'
import { WindowManager } from './WindowManager'
import type { CockpitUISpec, CockpitWindowSpec } from './contracts'
import type { NavigationSnapshot } from './simulator'

const vehicle: NavigationSnapshot = {
  runState: 'driving', leg: 'outbound', progress: 0.25, speedTier: 'normal', speedKph: 55,
  batteryPercent: 72, remainingRangeKm: 320, remainingDistanceKm: 18.4,
  distanceKm: 24.5, travelledKm: 6.1, remainingSeconds: 1_800,
  maneuver: '直行', road: '延安高架路', destination: '虹桥机场 T2', etaMs: 1_800_000,
}

function windowSpec(id: string, title: string, kind: CockpitWindowSpec['kind'] = 'weather'): CockpitWindowSpec {
  return {
    id, kind, title, componentIds: [], size: 'medium',
    controls: { closable: true, minimizable: true, maximizable: true },
  }
}

function spec(windows: CockpitWindowSpec[]): UISpec {
  return {
    version: '1.0', taskId: 'cockpit-1', surfaceId: 'airport-pickup-main', taskRevision: 1, uiRevision: 1,
    phase: 'driving-to-airport', title: '行程辅助信息',
    layout: { type: 'stack', gap: 'sm', slots: { main: [] } },
    components: [], actions: [],
    presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'normal' },
    meta: { generatedBy: 'composer', sourceTaskRevision: 1, requiresConfirm: false, generatedAt: '2026-08-13T09:00:00+08:00', traceId: 'trace-window-manager' },
    windows,
  } as CockpitUISpec
}

function manager(ui: UISpec) {
  return (
    <WindowManager
      spec={ui}
      pending={false}
      driving
      vehicle={vehicle}
      onAction={vi.fn()}
      clear={false}
      preserveMissing={false}
    />
  )
}

function movePointer(clientX: number, clientY: number) {
  window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, clientX, clientY }))
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX, clientY }))
}

function startPointer(target: Element, clientX: number, clientY: number) {
  const event = new Event('pointerdown', { bubbles: true })
  Object.defineProperties(event, { button: { value: 0 }, clientX: { value: clientX }, clientY: { value: clientY } })
  target.dispatchEvent(event)
}

describe('WindowManager component behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('innerHeight', 720)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('automatically folds transient query windows without affecting the spec callback', () => {
    vi.useFakeTimers()
    const weather = windowSpec('weather-1', '当前位置天气')
    const onWindowClose = vi.fn()
    render(<WindowManager {...manager(spec([weather])).props} onWindowClose={onWindowClose} />)
    expect(screen.getByRole('article', { name: '当前位置天气窗口' })).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(12_000) })

    expect(screen.queryByRole('article', { name: '当前位置天气窗口' })).not.toBeInTheDocument()
    expect(onWindowClose).toHaveBeenCalledWith('weather-1')
  })

  it('preserves the dragged position across a server spec refresh', () => {
    const weather = windowSpec('weather-1', '当前位置天气')
    const view = render(manager(spec([weather])))
    const article = screen.getByRole('article', { name: '当前位置天气窗口' })
    const chrome = article.querySelector('.cockpit-window__chrome')!

    act(() => {
      startPointer(chrome, 900, 100)
      movePointer(700, 240)
    })

    expect(article).toHaveStyle({ '--window-x': '616px', '--window-y': '224px' })
    view.rerender(manager({ ...spec([weather]), uiRevision: 2 }))
    expect(screen.getByRole('article', { name: '当前位置天气窗口' })).toHaveStyle({
      '--window-x': '616px', '--window-y': '224px',
    })
  })

  it('minimizes and restores without losing the dragged position', () => {
    const weather = windowSpec('weather-1', '当前位置天气')
    render(manager(spec([weather])))
    const article = screen.getByRole('article', { name: '当前位置天气窗口' })
    const chrome = article.querySelector('.cockpit-window__chrome')!

    act(() => {
      startPointer(chrome, 900, 100)
      movePointer(760, 180)
    })
    expect(article).toHaveStyle({ '--window-x': '676px', '--window-y': '164px' })

    fireEvent.click(screen.getByRole('button', { name: '最小化当前位置天气窗口' }))
    expect(article).toHaveAttribute('data-mode', 'minimized')
    expect(article).toHaveStyle({ '--window-x': '676px', '--window-y': '164px' })

    fireEvent.click(screen.getByRole('button', { name: '恢复当前位置天气窗口' }))
    expect(article).toHaveAttribute('data-mode', 'normal')
    expect(article).toHaveStyle({ '--window-x': '676px', '--window-y': '164px' })
  })

  it('keeps a closed id tombstoned across server sync while opening a new id', () => {
    const weather = windowSpec('weather-1', '当前位置天气')
    const calendar = windowSpec('calendar-1', '今日日历', 'calendar')
    const onWindowClose = vi.fn()
    const view = render(
      <WindowManager {...manager(spec([weather])).props} onWindowClose={onWindowClose} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭当前位置天气窗口' }))
    expect(screen.queryByRole('article', { name: '当前位置天气窗口' })).not.toBeInTheDocument()
    expect(onWindowClose).toHaveBeenCalledWith('weather-1')

    view.rerender(
      <WindowManager {...manager({ ...spec([weather, calendar]), uiRevision: 2 }).props} onWindowClose={onWindowClose} />,
    )
    expect(screen.queryByRole('article', { name: '当前位置天气窗口' })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: '今日日历窗口' })).toBeInTheDocument()
  })
})
