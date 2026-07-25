import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentSpec, UISpec } from '@canvasflow/schema'
import { UISpecRenderer } from './UISpecRenderer'

const generatedAt = '2026-07-22T20:00:00+08:00'

function specWith(
  components: ComponentSpec[],
  options: Partial<Pick<UISpec, 'layout' | 'actions' | 'presentation'>> = {},
): UISpec {
  return {
    version: '1.0',
    taskId: 'pickup-renderer',
    surfaceId: 'airport-pickup-main',
    taskRevision: 2,
    uiRevision: 3,
    phase: 'preparing',
    title: '机场接人任务',
    presentation: options.presentation ?? { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
    layout: options.layout ?? { type: 'stack', gap: 'md', slots: { main: components.map((component) => component.id) } },
    components,
    actions: options.actions ?? [],
    meta: {
      generatedBy: 'composer', sourceTaskRevision: 2, requiresConfirm: false, generatedAt, traceId: 'trace-renderer',
    },
  }
}

describe('UISpecRenderer', () => {
  it('renders components in slot order rather than component array order', () => {
    const primary: ComponentSpec = {
      id: 'primary-flight', type: 'flight-status',
      props: {
        flightNumber: 'MU5102', status: 'in-air', scheduledArrival: generatedAt,
        estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2', freshness: 'fixture',
      },
    }
    const secondary: ComponentSpec = {
      id: 'secondary-passenger', type: 'passenger-status',
      props: { label: '妈妈已落地', status: 'landed', meetingPoint: 'P2 到达层' },
    }
    const spec = specWith([secondary, primary], {
      layout: { type: 'split', ratio: [2, 1], slots: { primary: [primary.id], secondary: [secondary.id] } },
    })

    const { container } = render(<UISpecRenderer onAction={() => undefined} pending={false} spec={spec} />)

    const slots = container.querySelectorAll('[data-slot]')
    expect(slots).toHaveLength(2)
    expect(slots[0]).toHaveAttribute('data-slot', 'primary')
    expect(within(slots[0] as HTMLElement).getByText('MU5102')).toBeInTheDocument()
    expect(slots[1]).toHaveAttribute('data-slot', 'secondary')
    expect(within(slots[1] as HTMLElement).getByText('妈妈已落地')).toBeInTheDocument()
    expect(container.querySelector('.layout-split')).toHaveStyle({ gridTemplateColumns: '2fr 1fr' })
  })

  it.each([
    ['row', 'layout-row'],
    ['column', 'layout-column'],
  ] as const)('maps the %s layout to a distinct renderer class', (type, className) => {
    const components: ComponentSpec[] = [
      { id: 'one', type: 'status-banner', props: { level: 'info', title: '第一项' } },
      { id: 'two', type: 'status-banner', props: { level: 'info', title: '第二项' } },
    ]
    const spec = specWith(components, { layout: { type, gap: 'sm', slots: { main: ['one', 'two'] } } })
    const { container } = render(<UISpecRenderer onAction={() => undefined} pending={false} spec={spec} />)
    expect(container.querySelector(`.${className}`)).toBeInTheDocument()
  })

  it('projects light and dark themes as distinct surface contracts', () => {
    const component: ComponentSpec = {
      id: 'theme-banner', type: 'status-banner', props: { level: 'info', title: '主题提示' },
    }
    const dark = specWith([component], {
      presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
    })
    const light = specWith([component], {
      presentation: { mode: 'replace', density: 'full', theme: 'light', priority: 'normal' },
    })
    const { container, rerender } = render(<UISpecRenderer onAction={() => undefined} pending={false} spec={dark} />)
    const surface = container.querySelector('.ui-surface')
    expect(surface).toHaveAttribute('data-theme', 'dark')
    const darkStyle = getComputedStyle(surface as Element)
    const darkColors = { background: darkStyle.backgroundColor, foreground: darkStyle.color }

    rerender(<UISpecRenderer onAction={() => undefined} pending={false} spec={light} />)
    expect(surface).toHaveAttribute('data-theme', 'light')
    const lightStyle = getComputedStyle(surface as Element)
    expect(lightStyle.backgroundColor).not.toBe(darkColors.background)
    expect(lightStyle.color).not.toBe(darkColors.foreground)

    const critical = { ...light, presentation: { ...light.presentation, priority: 'critical' as const } }
    rerender(<UISpecRenderer onAction={() => undefined} pending={false} spec={critical} />)
    expect(surface).toHaveClass('priority-critical')
    expect((surface as HTMLElement).style.borderColor).toBe('')
  })

  it('renders focus primary and secondary slots without flattening their order', () => {
    const components: ComponentSpec[] = [
      { id: 'secondary', type: 'status-banner', props: { level: 'info', title: '次要内容' } },
      { id: 'primary', type: 'status-banner', props: { level: 'info', title: '焦点内容' } },
    ]
    const spec = specWith(components, {
      layout: { type: 'focus', slots: { primary: ['primary'], secondary: ['secondary'] } },
    })
    const { container } = render(<UISpecRenderer onAction={() => undefined} pending={false} spec={spec} />)
    expect(within(container.querySelector('[data-slot="primary"]') as HTMLElement).getByText('焦点内容')).toBeInTheDocument()
    expect(within(container.querySelector('[data-slot="secondary"]') as HTMLElement).getByText('次要内容')).toBeInTheDocument()
  })

  it('renders the complete UISpec component catalog with semantic details', () => {
    const components: ComponentSpec[] = [
      { id: 'overview', type: 'pickup-overview', props: { passengers: ['妈妈', '豆豆'], flightNumber: 'MU5102', airport: '虹桥机场', terminal: 'T2', phaseLabel: '准备出发' } },
      { id: 'flight', type: 'flight-status', props: { flightNumber: 'MU5102', status: 'delayed', scheduledArrival: generatedAt, estimatedArrival: '2026-07-22T21:00:00+08:00', terminal: 'T1', baggageClaim: '12', freshness: 'live' } },
      { id: 'route', type: 'navigation-summary', props: { routeId: 'route-1', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', distanceKm: 32, estimatedBatteryAtArrival: 27 } },
      { id: 'charge', type: 'charging-recommendation', props: { recommended: true, reason: '往返电量不足', currentBatteryPercent: 42, estimatedFinalBatteryPercent: 18, suggestedDurationMinutes: 10, etaImpactMinutes: 12 } },
      { id: 'message', type: 'message-preview', props: { contactLabel: '妈妈', textPreview: '我已到达机场。', status: 'scheduled', cancellable: true } },
      { id: 'passenger', type: 'passenger-status', props: { label: '妈妈和豆豆已上车', status: 'confirmed-onboard', meetingPoint: 'P2 到达层' } },
      { id: 'cabin', type: 'cabin-profile', props: { zone: 'rear', temperatureC: 25, fanLevel: 2, mediaTitle: '豆豆故事', appliedFromMemory: true, reversible: true } },
      { id: 'progress', type: 'task-progress', props: { currentPhase: 'preparing', steps: [{ phase: 'collecting-information', label: '收集信息', status: 'completed' }, { phase: 'preparing', label: '准备出发', status: 'active' }] } },
      { id: 'alert', type: 'alert', props: { level: 'warning', title: '航班延误', message: '预计晚到 20 分钟' } },
      { id: 'banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号', message: '支持 MU5102' } },
    ]

    const { container } = render(<UISpecRenderer onAction={() => undefined} pending={false} spec={specWith(components)} />)

    for (const component of components) {
      expect(container.querySelector(`[data-component-type="${component.type}"]`)).toBeInTheDocument()
    }
    expect(screen.getByText('妈妈和豆豆')).toBeInTheDocument()
    expect(screen.getAllByText('MU5102').length).toBeGreaterThan(0)
    expect(screen.getByText('32 km')).toBeInTheDocument()
    expect(screen.getByLabelText('当前电量 42%')).toBeInTheDocument()
    expect(screen.getByText('我已到达机场。')).toBeInTheDocument()
    expect(screen.getByText('豆豆故事')).toBeInTheDocument()
    expect(screen.getByText('此设置支持撤销')).toBeInTheDocument()
    expect(container.querySelector('[aria-current="step"]')).toHaveTextContent('准备出发')
    expect(screen.getByRole('alert')).toHaveTextContent('航班延误')
    expect(screen.getByRole('status')).toHaveTextContent('请补充航班号')
  })

  it('routes component and global actions through the supplied callback and supports keyboard activation', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    const component: ComponentSpec = {
      id: 'flight', type: 'flight-status', actions: ['start-navigation'],
      props: { flightNumber: 'MU5102', status: 'scheduled', scheduledArrival: generatedAt, estimatedArrival: generatedAt, terminal: 'T2', freshness: 'fixture' },
    }
    const spec = specWith([component], {
      actions: [
        { id: 'start-navigation', label: '开始导航', style: 'primary', event: { type: 'tool-request', actionToken: 'opaque-token' } },
        { id: 'cancel-trip', label: '取消任务', style: 'danger', event: { type: 'dismiss', targetId: 'task' } },
      ],
    })

    render(<UISpecRenderer onAction={onAction} pending={false} spec={spec} />)
    const start = screen.getByRole('button', { name: /开始导航/ })
    start.focus()
    await user.keyboard('{Enter}')
    expect(onAction).toHaveBeenCalledWith('start-navigation', 'flight')
    await user.click(screen.getByRole('button', { name: /取消任务/ }))
    expect(onAction).toHaveBeenCalledWith('cancel-trip', 'flight')
  })

  it('fails closed for visibility without driving context and filters with explicit context', () => {
    const components: ComponentSpec[] = [
      { id: 'parked', type: 'status-banner', visibility: 'parked-only', props: { level: 'info', title: '停车信息' } },
      { id: 'driving', type: 'status-banner', visibility: 'driving-only', props: { level: 'info', title: '驾驶信息' } },
    ]
    const spec = specWith(components)
    const { rerender } = render(<UISpecRenderer onAction={() => undefined} pending={false} spec={spec} />)
    expect(screen.queryByText('停车信息')).not.toBeInTheDocument()
    expect(screen.queryByText('驾驶信息')).not.toBeInTheDocument()

    rerender(<UISpecRenderer driving onAction={() => undefined} pending={false} spec={spec} />)
    expect(screen.queryByText('停车信息')).not.toBeInTheDocument()
    expect(screen.getByText('驾驶信息')).toBeInTheDocument()

    rerender(<UISpecRenderer driving={false} onAction={() => undefined} pending={false} spec={spec} />)
    expect(screen.getByText('停车信息')).toBeInTheDocument()
    expect(screen.queryByText('驾驶信息')).not.toBeInTheDocument()
  })

  it('renders a defensive fallback for an unknown component instead of executing its action', () => {
    const unsafeComponent = { id: 'future', type: 'future-widget', props: { payload: 'ignored' }, actions: ['unsafe'] }
    const unsafeSpec = {
      ...specWith([]),
      layout: { type: 'stack', gap: 'md', slots: { main: ['future'] } },
      components: [unsafeComponent],
      actions: [{ id: 'unsafe', label: '不要执行', style: 'danger', event: { type: 'tool-request', actionToken: 'secret' } }],
    } as unknown as UISpec
    const onAction = vi.fn()

    render(<UISpecRenderer onAction={onAction} pending={false} spec={unsafeSpec} />)
    expect(screen.getByText('暂不支持的组件')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /不要执行/ })).not.toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('disables a component action that is absent from the action catalog', () => {
    const component: ComponentSpec = {
      id: 'message', type: 'message-preview', actions: ['missing-action'],
      props: { contactLabel: '妈妈', textPreview: '我到了', status: 'failed', cancellable: false },
    }
    render(<UISpecRenderer onAction={() => undefined} pending={false} spec={specWith([component])} />)
    expect(screen.getByRole('button', { name: '操作不可用' })).toBeDisabled()
  })
})
