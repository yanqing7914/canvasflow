import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentSpec, UISpec } from '@canvasflow/schema'
import { UISpecRenderer } from './UISpecRenderer'

function baseSpec(overrides: Partial<UISpec> = {}): UISpec {
  return {
    version: '1.0',
    taskId: 'pickup-001',
    surfaceId: 'airport-pickup-main',
    taskRevision: 1,
    uiRevision: 2,
    phase: 'preparing',
    title: '准备出发',
    presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
    layout: { type: 'stack', gap: 'md', slots: { main: ['overview', 'progress'] } },
    components: [
      {
        id: 'overview',
        type: 'pickup-overview',
        props: { passengers: ['妈妈', '豆豆'], flightNumber: 'MU5102', airport: '虹桥机场', terminal: 'T2', phaseLabel: '准备出发' },
      },
      {
        id: 'progress',
        type: 'task-progress',
        props: { currentPhase: 'preparing', steps: [{ phase: 'preparing', label: '准备出发', status: 'active' }] },
      },
    ],
    actions: [],
    meta: { generatedBy: 'composer', sourceTaskRevision: 1, requiresConfirm: false, generatedAt: '2026-07-22T20:00:00+08:00', traceId: 'trace-1' },
    ...overrides,
  }
}

describe('UISpecRenderer', () => {
  it('renders components in layout slot order and exposes presentation state', () => {
    render(<UISpecRenderer spec={baseSpec({ layout: { type: 'row', gap: 'sm', slots: { main: ['progress', 'overview'] } }, presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'high' } })} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer).toHaveAttribute('data-layout', 'row')
    expect(renderer).toHaveAttribute('data-gap', 'sm')
    expect(renderer).toHaveAttribute('data-density', 'compact')
    expect(renderer).toHaveAttribute('data-theme', 'dark')
    expect(renderer).toHaveAttribute('data-priority', 'high')
    expect(renderer).toHaveAttribute('data-component-count', '2')
    expect(renderer).toHaveAttribute('data-has-actions', 'false')
    const cards = renderer.querySelectorAll('[data-component-type]')
    expect(cards[0]).toHaveAttribute('data-component-type', 'task-progress')
    expect(cards[1]).toHaveAttribute('data-component-type', 'pickup-overview')
    expect(renderer).toHaveAttribute('data-phase', 'preparing')
    expect(renderer.textContent).not.toContain('task-progress')
    expect(renderer.textContent).not.toContain('pickup-overview')
    expect(renderer.textContent).not.toContain('overview')
    expect(renderer.textContent).not.toContain('progress')
    expect(renderer.querySelector('.ui-card__type')).not.toBeInTheDocument()
  })

  it('maps split slots and ratio into deterministic layout hooks', () => {
    const spec = baseSpec({
      layout: {
        type: 'split',
        ratio: [2, 1],
        slots: { primary: ['overview'], secondary: ['progress'] },
      },
    })
    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    const layout = renderer.querySelector('.ui-layout--split')
    expect(layout).toHaveStyle({ '--ui-primary-ratio': '2fr', '--ui-secondary-ratio': '1fr' })
    expect(renderer.querySelector('[data-slot="primary"] [data-component-type]')).toHaveAttribute('data-component-type', 'pickup-overview')
    expect(renderer.querySelector('[data-slot="secondary"] [data-component-type]')).toHaveAttribute('data-component-type', 'task-progress')
  })

  it('marks a single slotted component so the roadbook can give its fact the full task surface', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['overview'] } },
      components: [baseSpec().components[0]],
    })
    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(screen.getByRole('region', { name: 'Generated task interface' })).toHaveAttribute('data-single-component', 'true')
  })

  it('only sends the registered action id and safely renders an invalid slot', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['missing', 'overview'] } },
      actions: [{ id: 'start-navigation', label: '开始导航', style: 'primary', event: { type: 'tool-request', actionToken: 'opaque-token' } }],
      components: [baseSpec().components[0]],
    })
    render(<UISpecRenderer spec={spec} onAction={onAction} pending={false} />)

    expect(screen.getByText('这项信息暂时无法显示')).toBeInTheDocument()
    const action = screen.getByRole('button', { name: '开始导航' })
    expect(action).toHaveClass('ui-action--primary')
    expect(action).toHaveAttribute('data-action-id', 'start-navigation')
    expect(screen.queryByText('opaque-token')).not.toBeInTheDocument()
    await user.click(action)
    // A global action reports the first component the brief actually resolved. 'missing'
    // has no component behind it, so sending it would fail Policy Gate lookup.
    expect(onAction).toHaveBeenCalledWith('start-navigation', 'overview')
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  const layoutCases: Array<[string, UISpec['layout']]> = [
    ['stack', { type: 'stack', gap: 'md', slots: { main: ['overview'] } }],
    ['column', { type: 'column', gap: 'lg', slots: { main: ['overview'] } }],
    ['focus', { type: 'focus', slots: { primary: ['overview'], secondary: ['progress'] } }],
  ]

  it.each(layoutCases)('supports the %s layout contract', (layoutType, layout) => {
    render(<UISpecRenderer spec={baseSpec({ layout })} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer).toHaveAttribute('data-layout', layoutType)
    if (layoutType === 'focus') {
      expect(renderer.querySelector('[data-slot="primary"]')).toBeInTheDocument()
      expect(renderer.querySelector('[data-slot="secondary"]')).toBeInTheDocument()
    }
  })

  it('renders unknown component types and malformed data as safe placeholders', () => {
    const unknownComponent = { id: 'future-card', type: 'future-widget', props: { value: 1 } }
    const malformedComponent = { id: 'broken-flight', type: 'flight-status', props: { flightNumber: 'MU5102' } }
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['future-card', 'broken-flight'] } },
      components: [unknownComponent, malformedComponent],
    } as unknown as Partial<UISpec>)

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(screen.getAllByText('这项信息暂时无法显示')).toHaveLength(2)
    expect(screen.getAllByText('请稍后再试，其他行程信息仍可继续使用。')).toHaveLength(2)
    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer.querySelector('[data-component-type="future-widget"]')).toBeInTheDocument()
    expect(renderer.querySelector('[data-component-type="flight-status"]')).toBeInTheDocument()
    expect(renderer.textContent).not.toContain('future-widget')
    expect(renderer.textContent).not.toContain('flight-status')
    expect(renderer.textContent).not.toContain('future-card')
    expect(renderer.textContent).not.toContain('broken-flight')
    expect(renderer.textContent).not.toContain('安全降级')
    expect(renderer.textContent).not.toContain('组件 ')
  })

  it('renders a human-readable empty state when no slots contain content', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: [] } },
      components: [],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(screen.getByRole('status')).toHaveTextContent('暂时没有可显示的信息')
    expect(screen.queryByText('fallback')).not.toBeInTheDocument()
  })

  it('disables missing component actions instead of dispatching them', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    const component = { ...baseSpec().components[0], actions: ['missing-action'] }
    const spec = baseSpec({ components: [component], layout: { type: 'stack', gap: 'md', slots: { main: ['overview'] } } })

    render(<UISpecRenderer spec={spec} onAction={onAction} pending={false} />)

    const unavailable = screen.getByRole('button', { name: '操作暂不可用 （missing-action）' })
    expect(unavailable).toBeDisabled()
    await user.click(unavailable)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('keeps a component action out of the global bar when its card is not placed in a slot', () => {
    const onAction = vi.fn()
    const orphan = { ...baseSpec().components[0], id: 'orphan', actions: ['orphan-action'] }
    const spec = baseSpec({
      // 'orphan' owns the action but never appears in a slot, so the action has no context to render in.
      layout: { type: 'stack', gap: 'md', slots: { main: ['progress'] } },
      components: [orphan, baseSpec().components[1]],
      actions: [{ id: 'orphan-action', label: '孤立操作', style: 'primary', event: { type: 'dismiss', targetId: 'orphan' } }],
    })

    render(<UISpecRenderer spec={spec} onAction={onAction} pending={false} />)

    expect(screen.queryByRole('button', { name: '孤立操作' })).not.toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('exposes whether the progress route has a next step to connect to', () => {
    const withNext = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['progress'] } },
      components: [{
        id: 'progress',
        type: 'task-progress',
        props: {
          currentPhase: 'preparing',
          steps: [
            { phase: 'collecting-information', label: '收集信息', status: 'completed' },
            { phase: 'preparing', label: '准备出发', status: 'active' },
            { phase: 'driving-to-airport', label: '前往机场', status: 'pending' },
          ],
        },
      }],
    })
    const { unmount } = render(<UISpecRenderer spec={withNext} onAction={vi.fn()} pending={false} />)
    expect(document.querySelector('.ui-progress')).toHaveAttribute('data-has-next', 'true')
    expect(document.querySelector('.ui-progress')).toHaveAttribute('data-active-index', '1')
    expect(document.querySelector('[data-status="active"]')).toHaveAttribute('data-display-status', 'active')
    unmount()

    const terminal = baseSpec({
      phase: 'completed',
      title: '接机任务已完成',
      layout: { type: 'stack', gap: 'md', slots: { main: ['progress'] } },
      components: [{
        id: 'progress',
        type: 'task-progress',
        props: {
          currentPhase: 'completed',
          steps: [
            { phase: 'returning-home', label: '返程回家', status: 'completed' },
            { phase: 'completed', label: '任务完成', status: 'active' },
          ],
        },
      }],
    })
    render(<UISpecRenderer spec={terminal} onAction={vi.fn()} pending={false} />)
    const progress = document.querySelector('.ui-progress')
    const terminalStep = document.querySelector('[data-terminal-step="true"]')

    // Completion is a real terminal state, not an active numbered step with a "now" label.
    expect(progress).toHaveAttribute('data-has-next', 'false')
    expect(progress).toHaveAttribute('data-completion-index', '1')
    expect(progress).toHaveAttribute('data-terminal', 'true')
    expect(terminalStep).toHaveAttribute('data-status', 'active')
    expect(terminalStep).toHaveAttribute('data-display-status', 'completed')
    expect(terminalStep).toHaveTextContent('任务完成已完成')
    expect(terminalStep).not.toHaveTextContent('现在')
    expect(terminalStep?.querySelector('.ui-progress__marker svg')).toBeInTheDocument()
  })

  it('uses the UISpec phase to close a stale progress list without inventing another step', () => {
    const spec = baseSpec({
      phase: 'completed',
      title: '接机任务已完成',
      layout: { type: 'stack', gap: 'md', slots: { main: ['progress'] } },
      components: [{
        id: 'progress',
        type: 'task-progress',
        props: {
          currentPhase: 'returning-home',
          steps: [
            { phase: 'approaching-airport', label: '抵达机场', status: 'completed' },
            { phase: 'returning-home', label: '返程回家', status: 'active' },
            { phase: 'completed', label: '任务完成', status: 'pending' },
          ],
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const progress = document.querySelector('.ui-progress')
    const terminalStep = document.querySelector('[data-terminal-step="true"]')
    expect(progress).toHaveAttribute('data-has-next', 'false')
    expect(progress).toHaveAttribute('data-active-index', '2')
    expect(terminalStep).toHaveTextContent('任务完成已完成')
    expect(terminalStep?.querySelector('.ui-progress__marker svg')).toBeInTheDocument()
    expect(document.querySelector('[data-status="active"]')).toHaveAttribute('data-display-status', 'completed')
  })

  it('renders an explicit empty progress message when a valid progress component has no steps', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['progress'] } },
      components: [{
        id: 'progress',
        type: 'task-progress',
        props: { currentPhase: 'preparing', steps: [] },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const progress = document.querySelector('.ui-progress')
    expect(progress).toHaveAttribute('data-active-index', '-1')
    expect(progress).not.toHaveAttribute('data-completion-index')
    expect(screen.getByText('暂时没有可显示的进度')).toHaveClass('ui-progress__empty')
  })

  it('leads the charging card with the suggested duration when one is supplied', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['charging'] } },
      components: [{
        id: 'charging',
        type: 'charging-recommendation',
        props: {
          recommended: true,
          reason: '完成往返后预计低于安全余量（对比 3 站）',
          currentBatteryPercent: 42,
          estimatedFinalBatteryPercent: 18,
          suggestedDurationMinutes: 12,
          etaImpactMinutes: 15,
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(document.querySelector('.ui-card__lead--recommendation')).toHaveTextContent('补能约 12 分钟')
    expect(screen.getByText('行程增加约 15 分钟')).toBeInTheDocument()
    expect(screen.getByText('完成往返后预计低于安全余量（对比 3 站）')).toBeInTheDocument()
  })

  it('uses dedicated information structures for the supported trip summaries', () => {
    const spec = baseSpec({
      layout: {
        type: 'stack',
        gap: 'md',
        slots: {
          main: ['flight', 'navigation', 'charging', 'message', 'passenger', 'cabin', 'progress', 'alert', 'banner'],
        },
      },
      components: [
        {
          id: 'flight',
          type: 'flight-status',
          props: {
            flightNumber: 'MU5102',
            status: 'landed',
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T20:40:00+08:00',
            terminal: 'T2',
            baggageClaim: '12',
            freshness: 'live',
          },
        },
        {
          id: 'navigation',
          type: 'navigation-summary',
          props: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', distanceKm: 32, estimatedBatteryAtArrival: 27 },
        },
        {
          id: 'charging',
          type: 'charging-recommendation',
          props: { recommended: true, reason: '完成往返后预计低于安全余量', currentBatteryPercent: 42, estimatedFinalBatteryPercent: 18, suggestedDurationMinutes: 12 },
        },
        {
          id: 'message',
          type: 'message-preview',
          props: { contactLabel: '妈妈', textPreview: '我已到达机场，正在接你们。', status: 'sent', cancellable: false },
        },
        {
          id: 'passenger',
          type: 'passenger-status',
          props: { label: '已停稳，等待家人', status: 'waiting', meetingPoint: 'P2 停车场到达层 3 号门' },
        },
        {
          id: 'cabin',
          type: 'cabin-profile',
          props: { zone: 'rear', temperatureC: 25, fanLevel: 2, mediaTitle: '豆豆故事', appliedFromMemory: true, reversible: true },
        },
        {
          id: 'progress',
          type: 'task-progress',
          props: { currentPhase: 'preparing', steps: [{ phase: 'preparing', label: '准备出发', status: 'active' }] },
        },
        { id: 'alert', type: 'alert', props: { level: 'warning', title: '请留意航班动态', message: '预计到达时间已更新。' } },
        { id: 'banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号', message: '补充后可继续安排接机。' } },
      ],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer.querySelector('.ui-flight-brief__arrival time')).toHaveTextContent('20:40')
    expect(renderer.querySelector('.ui-flight-brief__facts')).toHaveTextContent('行李转盘')
    expect(renderer.querySelector('.ui-navigation-brief__route-rule')).toHaveAttribute('aria-hidden', 'true')
    expect(renderer.querySelector('.ui-navigation-brief__route-rule')).toHaveAttribute('data-route-progress', 'unavailable')
    expect(renderer.querySelector('.ui-charge-brief__recommendation')).toHaveTextContent('补能约 12 分钟')
    expect(renderer.querySelector('.ui-message-brief__copy')).toHaveTextContent('我已到达机场，正在接你们。')
    expect(renderer.querySelector('.ui-passenger-brief__meeting-point')).toHaveTextContent('P2 停车场到达层 3 号门')
    expect(renderer.querySelector('.ui-cabin-brief__state')).toHaveTextContent('已应用来自家庭记忆可随时撤销')
    expect(renderer.querySelector('.ui-progress-brief__title')).toHaveTextContent('准备出发')
    expect(renderer.querySelectorAll('.ui-status-card')).toHaveLength(2)
    expect(renderer.querySelector('.ui-card__header')).not.toBeInTheDocument()
    expect(renderer.textContent).not.toContain('navigation-summary')
  })

  it('does not invent optional facts for sparse component props', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['flight', 'charging', 'passenger', 'cabin'] } },
      components: [
        {
          id: 'flight',
          type: 'flight-status',
          props: {
            flightNumber: 'MU5102',
            status: 'scheduled',
            scheduledArrival: '2026-07-22T20:30:00+08:00',
            estimatedArrival: '2026-07-22T20:30:00+08:00',
            terminal: 'T2',
            freshness: 'cached',
          },
        },
        {
          id: 'charging',
          type: 'charging-recommendation',
          props: { recommended: false, reason: '当前电量足够完成行程', currentBatteryPercent: 78, estimatedFinalBatteryPercent: 46 },
        },
        { id: 'passenger', type: 'passenger-status', props: { label: '家人已上车', status: 'confirmed-onboard' } },
        { id: 'cabin', type: 'cabin-profile', props: { zone: 'rear', temperatureC: 25, appliedFromMemory: false, reversible: false } },
      ],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer.querySelector('.ui-flight-brief__facts')).not.toHaveTextContent('行李转盘')
    expect(renderer.textContent).not.toContain('原计划')
    expect(renderer.querySelector('.ui-charge-brief__recommendation')).not.toBeInTheDocument()
    expect(renderer.textContent).not.toContain('行程增加约')
    expect(renderer.querySelector('.ui-passenger-brief__meeting-point')).not.toBeInTheDocument()
    expect(renderer.querySelector('.ui-cabin-brief__facts')).toHaveTextContent('温度')
    expect(renderer.querySelector('.ui-cabin-brief__facts')).not.toHaveTextContent('风量')
    expect(renderer.querySelector('.ui-cabin-brief__facts')).not.toHaveTextContent('媒体')
  })

  it('keeps a component action with its matching summary rather than the global action bar', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['message'] } },
      components: [{
        id: 'message',
        type: 'message-preview',
        props: { contactLabel: '妈妈', textPreview: '我已到达机场，正在接你们。', status: 'failed', cancellable: false },
        actions: ['retry-message'],
      }],
      actions: [{ id: 'retry-message', label: '重试发送', style: 'primary', event: { type: 'agent-message', text: 'retry' } }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    const button = screen.getByRole('button', { name: '重试发送' })
    expect(renderer).toHaveAttribute('data-has-actions', 'true')
    expect(button.closest('.ui-component')).toContainElement(renderer.querySelector('.ui-message-brief'))
    expect(renderer.querySelector('.ui-actions')).not.toBeInTheDocument()
  })

  it('keeps the message send status outside the droppable detail row', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['message'] } },
      components: [{
        id: 'message',
        type: 'message-preview',
        props: { contactLabel: '妈妈', textPreview: '我已到达机场，正在接你们。', status: 'failed', cancellable: false },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    // 'failed' is the conclusion of the card, so it must not sit in the row minimal density hides.
    const status = screen.getByText('发送失败')
    expect(status.closest('.ui-card__status-line')).toBeInTheDocument()
    expect(status.closest('.ui-detail-row')).not.toBeInTheDocument()
    expect(document.querySelector('.ui-detail-row')).not.toBeInTheDocument()
  })

  /**
   * A failed or scheduled message must keep its send status in `minimal` density,
   * which is the density the composer picks for exactly those two states. jsdom
   * does not load the stylesheet, so this pins the structural half of the rule —
   * the status stays rendered and stays out of `.ui-detail-row`, the row minimal
   * density hides. The 1920x720 layout E2E covers it with the real CSS applied.
   */
  it.each([
    { status: 'failed', label: '发送失败', cancellable: false, scheduledAt: undefined },
    { status: 'scheduled', label: '待发送', cancellable: true, scheduledAt: '2026-07-22T20:35:00+08:00' },
  ] as const)('keeps a $status message send status in minimal density', ({ status, label, cancellable, scheduledAt }) => {
    const spec = baseSpec({
      presentation: { mode: 'replace', density: 'minimal', theme: 'dark', priority: 'high' },
      layout: { type: 'stack', gap: 'md', slots: { main: ['message'] } },
      components: [{
        id: 'message',
        type: 'message-preview',
        props: {
          contactLabel: '妈妈',
          textPreview: '我已到达机场，正在接你们。',
          status,
          cancellable,
          ...(scheduledAt ? { scheduledAt } : {}),
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer).toHaveAttribute('data-density', 'minimal')
    const statusLabel = screen.getByText(label)
    expect(statusLabel.closest('.ui-card__status-line')).toBeInTheDocument()
    expect(statusLabel.closest('.ui-detail-row')).not.toBeInTheDocument()
  })

  it('does not expose actions attached to an invalid component', () => {
    const onAction = vi.fn()
    const invalidComponent = { id: 'future-card', type: 'future-widget', props: {}, actions: ['future-action'] }
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['future-card'] } },
      components: [invalidComponent],
      actions: [{ id: 'future-action', label: '执行未来动作', style: 'danger', event: { type: 'dismiss', targetId: 'future-card' } }],
    } as unknown as Partial<UISpec>)

    render(<UISpecRenderer spec={spec} onAction={onAction} pending={false} />)

    expect(screen.getByText('这项信息暂时无法显示')).toBeInTheDocument()
    const renderer = screen.getByRole('region')
    expect(renderer.textContent).not.toContain('future-widget')
    expect(renderer.textContent).not.toContain('future-card')
    expect(screen.queryByRole('button', { name: '执行未来动作' })).not.toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('fails closed for visibility without driving context and filters with explicit context', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['parked', 'driving'] } },
      components: [
        { id: 'parked', type: 'status-banner', visibility: 'parked-only', props: { level: 'info', title: '停车信息' } },
        { id: 'driving', type: 'status-banner', visibility: 'driving-only', props: { level: 'info', title: '驾驶信息' } },
      ],
    })

    const { rerender } = render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)
    // Neither is safe to show until the caller supplies an authoritative signal.
    expect(screen.queryByText('停车信息')).not.toBeInTheDocument()
    expect(screen.queryByText('驾驶信息')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Generated task interface' })).toHaveAttribute('data-component-count', '0')

    rerender(<UISpecRenderer spec={spec} driving onAction={vi.fn()} pending={false} />)
    expect(screen.queryByText('停车信息')).not.toBeInTheDocument()
    expect(screen.getByText('驾驶信息')).toBeInTheDocument()

    rerender(<UISpecRenderer spec={spec} driving={false} onAction={vi.fn()} pending={false} />)
    expect(screen.getByText('停车信息')).toBeInTheDocument()
    expect(screen.queryByText('驾驶信息')).not.toBeInTheDocument()
  })

  it('counts only the components the driving context leaves on screen', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['overview', 'driving'] } },
      components: [
        baseSpec().components[0],
        { id: 'driving', type: 'status-banner', visibility: 'driving-only', props: { level: 'info', title: '驾驶信息' } },
      ],
    })

    render(<UISpecRenderer spec={spec} driving={false} onAction={vi.fn()} pending={false} />)

    // One hidden component leaves a single visible fact, which earns the full task surface.
    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer).toHaveAttribute('data-component-count', '1')
    expect(renderer).toHaveAttribute('data-single-component', 'true')
  })

  it('does not dispatch an action belonging to a component the driving context hides', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['driving'] } },
      components: [{
        id: 'driving',
        type: 'status-banner',
        visibility: 'driving-only',
        props: { level: 'info', title: '驾驶信息' },
        actions: ['driving-action'],
      }],
      actions: [{ id: 'driving-action', label: '行驶中操作', style: 'primary', event: { type: 'dismiss', targetId: 'driving' } }],
    })

    render(<UISpecRenderer spec={spec} driving={false} onAction={onAction} pending={false} />)

    expect(screen.queryByRole('button', { name: /行驶中操作/ })).not.toBeInTheDocument()
    // The action is bound to the hidden card, so it must not reappear in the global bar.
    expect(screen.getByRole('region', { name: 'Generated task interface' })).toHaveAttribute('data-has-actions', 'false')
    await user.click(screen.getByRole('region', { name: 'Generated task interface' }))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('disables every action while a turn is already in flight', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    const component = { ...baseSpec().components[0], actions: ['start-navigation'] }
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['overview'] } },
      components: [component],
      actions: [
        { id: 'start-navigation', label: '开始导航', style: 'primary', event: { type: 'tool-request', actionToken: 'opaque-token' } },
        { id: 'cancel-trip', label: '取消任务', style: 'danger', event: { type: 'dismiss', targetId: 'task' } },
      ],
    })

    const { rerender } = render(<UISpecRenderer spec={spec} onAction={onAction} pending />)

    const bound = screen.getByRole('button', { name: /开始导航/ })
    const global = screen.getByRole('button', { name: /取消任务/ })
    expect(bound).toBeDisabled()
    expect(global).toBeDisabled()
    await user.click(bound)
    await user.click(global)
    expect(onAction).not.toHaveBeenCalled()

    rerender(<UISpecRenderer spec={spec} onAction={onAction} pending={false} />)
    await user.click(screen.getByRole('button', { name: /开始导航/ }))
    expect(onAction).toHaveBeenCalledWith('start-navigation', 'overview')
  })

  it('pairs a global action with the first component the brief resolved', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['overview', 'progress'] } },
      actions: [{ id: 'cancel-trip', label: '取消任务', style: 'danger', event: { type: 'dismiss', targetId: 'task' } }],
    })

    render(<UISpecRenderer spec={spec} onAction={onAction} pending={false} />)

    await user.click(screen.getByRole('button', { name: /取消任务/ }))
    expect(onAction).toHaveBeenCalledWith('cancel-trip', 'overview')
  })

  it('projects light and dark themes as distinct surfaces without recoloring state', () => {
    const component: ComponentSpec = { id: 'banner', type: 'status-banner', props: { level: 'error', title: '航班已取消' } }
    const dark = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['banner'] } },
      components: [component],
      presentation: { mode: 'replace', density: 'full', theme: 'dark', priority: 'normal' },
    })
    const light = { ...dark, presentation: { ...dark.presentation, theme: 'light' as const } }

    const { rerender } = render(<UISpecRenderer spec={dark} onAction={vi.fn()} pending={false} />)
    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer).toHaveAttribute('data-theme', 'dark')
    const darkSurface = getComputedStyle(renderer)
    const darkColors = { background: darkSurface.backgroundColor, ink: darkSurface.color }

    rerender(<UISpecRenderer spec={light} onAction={vi.fn()} pending={false} />)
    expect(renderer).toHaveAttribute('data-theme', 'light')
    const lightSurface = getComputedStyle(renderer)
    expect(lightSurface.backgroundColor).not.toBe(darkColors.background)
    expect(lightSurface.color).not.toBe(darkColors.ink)
    // A night theme dims the surface only. The failure state keeps its own meaning.
    expect(renderer.querySelector('[data-level="error"]')).toBeInTheDocument()
  })

  it('announces safety and degradation states through a live region', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['warn-banner', 'error-banner', 'info-banner', 'alert', 'missing'] } },
      components: [
        { id: 'warn-banner', type: 'status-banner', props: { level: 'warning', title: '航班已延误' } },
        { id: 'error-banner', type: 'status-banner', props: { level: 'error', title: '航班已取消' } },
        { id: 'info-banner', type: 'status-banner', props: { level: 'info', title: '请补充航班号' } },
        { id: 'alert', type: 'alert', props: { level: 'warning', title: '请留意航班动态' } },
      ],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    // A driver who is not looking at the screen still has to learn about these.
    // A failure interrupts; everything else waits its turn.
    const alerts = screen.getAllByRole('alert')
    expect(alerts.map((node) => node.getAttribute('data-component-id'))).toEqual(['error-banner', 'alert'])

    const statuses = screen.getAllByRole('status')
    expect(statuses.map((node) => node.getAttribute('data-component-id'))).toEqual([
      'warn-banner',
      'info-banner',
      // An unresolvable component is a degradation the driver must hear about too.
      'missing',
    ])
  })

  it('announces an empty brief through a live region', () => {
    const spec = baseSpec({ layout: { type: 'stack', gap: 'md', slots: { main: [] } }, components: [] })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(screen.getByRole('status')).toHaveTextContent('暂时没有可显示的信息')
  })

  it('exposes presentation priority without turning it into a task title', () => {
    const spec = baseSpec({ presentation: { mode: 'replace', density: 'minimal', theme: 'dark', priority: 'critical' } })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    expect(renderer).toHaveAttribute('data-priority', 'critical')
    expect(renderer).toHaveAttribute('data-density', 'minimal')
    expect(renderer).toHaveAttribute('data-title', '准备出发')
    expect(renderer.textContent).not.toContain('critical')
    expect(renderer.textContent).not.toContain('minimal')
  })
})
