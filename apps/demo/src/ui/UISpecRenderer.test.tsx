import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
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

  it('lays schedule milestones on one labelled band, keeping task and calendar provenance apart', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['schedule'] } },
      components: [{
        id: 'schedule',
        type: 'schedule-strip',
        props: {
          milestones: [
            { label: 'MU5102 落地', time: '2026-07-22T20:40:00+08:00', kind: 'task', status: 'next' },
            { label: '预计到家', time: '2026-07-22T21:27:00+08:00', kind: 'task', status: 'upcoming' },
            { label: '豆豆的睡前故事', time: '2026-07-22T21:30:00+08:00', kind: 'calendar', status: 'upcoming' },
          ],
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const track = screen.getByRole('list', { name: '任务与日程时间带' })
    const milestones = track.querySelectorAll('.ui-schedule-strip__milestone')
    expect(milestones).toHaveLength(3)
    // Provenance is a data hook, not just a colour: assistive tooling and the
    // stylesheet must agree on which points belong to the task.
    expect(milestones[0]).toHaveAttribute('data-kind', 'task')
    expect(milestones[1]).toHaveAttribute('data-kind', 'task')
    expect(milestones[2]).toHaveAttribute('data-kind', 'calendar')
    // Spec order is display order — the band would lie about the evening if
    // the renderer resorted it.
    expect(track.textContent).toMatch(/MU5102 落地.*预计到家.*豆豆的睡前故事/u)
    expect(screen.getByText('20:40')).toHaveAttribute('dateTime', '2026-07-22T20:40:00+08:00')
    // A quiet calendar entry must not raise the at-risk voice.
    expect(track.textContent).not.toContain('可能赶不上')
  })

  it('raises the at-risk voice only on the milestone that carries it', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['schedule'] } },
      components: [{
        id: 'schedule',
        type: 'schedule-strip',
        props: {
          milestones: [
            { label: 'MU5103 落地', time: '2026-07-22T21:10:00+08:00', kind: 'task', status: 'next' },
            { label: '豆豆的睡前故事', time: '2026-07-22T21:30:00+08:00', kind: 'calendar', status: 'at-risk' },
          ],
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const milestones = document.querySelectorAll('.ui-schedule-strip__milestone')
    expect(milestones[1]).toHaveAttribute('data-status', 'at-risk')
    const risk = screen.getByText('可能赶不上')
    expect(milestones[1]!.contains(risk)).toBe(true)
    expect(milestones[0]!.textContent).not.toContain('可能赶不上')
  })

  it('rejects a schedule strip below the two-point contract as a safe placeholder', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['schedule'] } },
      components: [{
        id: 'schedule',
        type: 'schedule-strip',
        props: {
          milestones: [
            { label: '预计到家', time: '2026-07-22T21:27:00+08:00', kind: 'task', status: 'next' },
          ],
        },
      } as unknown as ComponentSpec],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    // One point is not a band. The schema floor (min 2) must hold at render
    // time too, falling back to the standard unrenderable-component card.
    expect(screen.queryByRole('list', { name: '任务与日程时间带' })).not.toBeInTheDocument()
    expect(screen.getByText('这项信息暂时无法显示')).toBeInTheDocument()
  })

  it('renders the weather answer with its advisory line', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['weather-card'] } },
      components: [{
        id: 'weather-card',
        type: 'weather-card',
        props: {
          location: '虹桥机场 T2',
          timeLabel: '20:40 到达时',
          temperatureC: 24,
          condition: 'light-rain',
          conditionLabel: '小雨',
          windLevel: 3,
          precipitationChance: 70,
          advisory: '到达时段有雨，建议家人在到达层室内等候。',
          freshness: 'fixture',
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(screen.getByText('20:40 到达时 · 虹桥机场 T2')).toBeInTheDocument()
    expect(screen.getByText('小雨')).toBeInTheDocument()
    expect(screen.getByText('24°C')).toBeInTheDocument()
    expect(screen.getByText('风力 3 级')).toBeInTheDocument()
    expect(screen.getByText('降水 70%')).toBeInTheDocument()
    expect(screen.getByText('到达时段有雨，建议家人在到达层室内等候。')).toHaveClass('ui-weather-brief__advisory')
  })

  it('keeps the weather band to one line when the sky needs no advisory', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['weather-card'] } },
      components: [{
        id: 'weather-card',
        type: 'weather-card',
        props: {
          location: '家',
          timeLabel: '现在',
          temperatureC: 26.4,
          condition: 'cloudy',
          conditionLabel: '多云',
          freshness: 'fixture',
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(screen.getByText('现在 · 家')).toBeInTheDocument()
    expect(screen.getByText('26°C')).toBeInTheDocument()
    // No fabricated facts: absent wind/precipitation render nothing, and a calm
    // sky earns no advisory row.
    expect(document.querySelector('.ui-weather-brief__fact')).not.toBeInTheDocument()
    expect(document.querySelector('.ui-weather-brief__advisory')).not.toBeInTheDocument()
  })

  it('lists the schedule answer with time, title, location, and the capped tail', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['schedule-card'] } },
      components: [{
        id: 'schedule-card',
        type: 'schedule-card',
        props: {
          dateLabel: '今天',
          events: [
            { eventId: 'e-1', title: '豆豆的睡前故事', startAt: '2026-07-22T21:30:00+08:00', location: '家' },
            { eventId: 'e-2', title: '家庭电话', startAt: '2026-07-22T22:00:00+08:00' },
          ],
          moreCount: 3,
          freshness: 'fixture',
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const list = screen.getByRole('list', { name: '今日日程列表' })
    expect(list.textContent).toMatch(/21:30.*豆豆的睡前故事.*家.*22:00.*家庭电话/u)
    expect(screen.getByText('还有 3 项')).toBeInTheDocument()
    expect(document.querySelector('.ui-schedule-card__empty')).not.toBeInTheDocument()
  })

  it('answers an empty schedule with its copy instead of an empty list', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['schedule-card'] } },
      components: [{
        id: 'schedule-card',
        type: 'schedule-card',
        props: {
          dateLabel: '今天',
          events: [],
          emptyCopy: '今天没有更多安排了',
          freshness: 'fixture',
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(screen.getByText('今天没有更多安排了')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '今日日程列表' })).not.toBeInTheDocument()
  })

  it('leads the departure answer with the clock time and states what it was worked back from', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['departure-plan'] } },
      components: [{
        id: 'departure-plan',
        type: 'departure-plan',
        props: {
          departAtLabel: '20:10',
          arrivalLabel: 'MU5102 20:40 落地',
          driveMinutes: 20,
          bufferMinutes: 10,
          viaLabel: '直达虹桥机场 T2',
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(document.querySelector('.ui-departure-plan__time')?.textContent).toBe('20:10')
    expect(screen.getByText('MU5102 20:40 落地')).toBeInTheDocument()
    expect(screen.getByText('路上 20 分钟')).toBeInTheDocument()
    // The buffer is stated, never folded into the departure time.
    expect(screen.getByText('提前 10 分钟到')).toBeInTheDocument()
    expect(screen.getByText('直达虹桥机场 T2')).toBeInTheDocument()
    // No reminder standing, so nothing claims one is.
    expect(document.querySelector('.ui-departure-plan__reminder')).not.toBeInTheDocument()
  })

  it('states a standing reminder on the departure answer, with the time it promised', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['departure-plan'] } },
      components: [{
        id: 'departure-plan',
        type: 'departure-plan',
        props: {
          departAtLabel: '20:05',
          arrivalLabel: 'MU5102 20:40 落地',
          driveMinutes: 25,
          bufferMinutes: 10,
          reminderAtLabel: '20:10',
        },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    // Its own clock, deliberately: the route was re-read and the recommendation
    // moved, but the reminder still names the time the driver was promised, and a
    // bare 已设提醒 would hide that.
    expect(document.querySelector('.ui-departure-plan__reminder')).toHaveTextContent('已设提醒 20:10')
    expect(document.querySelector('.ui-departure-plan__time')?.textContent).toBe('20:05')
    // Not a fact the time was derived from, so not in the list it would be read
    // out of order from.
    expect(document.querySelector('.ui-departure-plan__facts')).not.toHaveTextContent('已设提醒')
  })

  it('omits the route line from the departure answer when there is none to name', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['departure-plan'] } },
      components: [{
        id: 'departure-plan',
        type: 'departure-plan',
        props: { departAtLabel: '20:10', arrivalLabel: 'MU5102 20:40 落地', driveMinutes: 20, bufferMinutes: 10 },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    expect(document.querySelector('.ui-departure-plan__fact--via')).not.toBeInTheDocument()
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

  // `.ui-metric__value` is a tabular numeral face at a numeral size. The media title
  // is the one metric value that is prose, and at the figure's size four CJK glyphs
  // overrun the third of `.ui-cabin-grid` the metric gets and hit the ellipsis. The
  // browser-side proof that it now fits lives in the e2e layout spec; this pins the
  // structure that proof depends on — the text face reaches the media title and only
  // the media title.
  it('renders a prose metric value in the text face and leaves the figures on the numeral face', () => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['cabin'] } },
      components: [{
        id: 'cabin',
        type: 'cabin-profile',
        props: { zone: 'rear', temperatureC: 25, fanLevel: 2, mediaTitle: '豆豆故事', appliedFromMemory: true, reversible: true },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    const textValues = [...renderer.querySelectorAll('.ui-metric__value-text')]
    expect(textValues.map((element) => element.textContent)).toEqual(['豆豆故事'])
    // The figures stay bare inside their own leaf, so the numeral face still applies
    // to them directly.
    const metricValue = (label: string) => [...renderer.querySelectorAll('.ui-metric')]
      .find((metric) => metric.querySelector('.ui-metric__label')?.textContent === label)
      ?.querySelector('.ui-metric__value')
    expect(metricValue('温度')).toHaveTextContent('25°C')
    expect(metricValue('温度')?.querySelector('.ui-metric__value-text')).toBeNull()
    expect(metricValue('风量')).toHaveTextContent('2 档')
    expect(metricValue('风量')?.querySelector('.ui-metric__value-text')).toBeNull()
    expect(metricValue('媒体')).toHaveTextContent('豆豆故事')
  })

  // The schema bounds a media title at one character and nothing more, so the length
  // the demo's own preference domain happens to produce is not the length the
  // renderer has to survive. Whether a longer or mixed-script title actually fits its
  // column is a browser question and the e2e layout spec asks it there; what this
  // pins is that the routing does not quietly depend on the title being short — every
  // one of these reaches the text face, and the figures beside it never do.
  it.each([
    ['a longer CJK title', '豆豆的睡前故事'],
    ['a mixed-script title', 'Peppa Pig 第 3 季'],
    ['a title past one line', '小猪佩奇与恐龙世界大冒险'],
    ['an all-Latin title', 'The Very Hungry Caterpillar'],
  ])('routes %s through the prose face intact', (_name, mediaTitle) => {
    const spec = baseSpec({
      layout: { type: 'stack', gap: 'md', slots: { main: ['cabin'] } },
      components: [{
        id: 'cabin',
        type: 'cabin-profile',
        props: { zone: 'rear', temperatureC: 25, fanLevel: 2, mediaTitle, appliedFromMemory: true, reversible: true },
      }],
    })

    render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)

    const renderer = screen.getByRole('region', { name: 'Generated task interface' })
    const textValues = [...renderer.querySelectorAll('.ui-metric__value-text')]
    // Rendered whole, in one node: the fit is the stylesheet's job, and a renderer
    // that truncated or split the string would take that decision away from it.
    expect(textValues.map((element) => element.textContent)).toEqual([mediaTitle])
    const metricValue = (label: string) => [...renderer.querySelectorAll('.ui-metric')]
      .find((metric) => metric.querySelector('.ui-metric__label')?.textContent === label)
      ?.querySelector('.ui-metric__value')
    expect(metricValue('温度')?.querySelector('.ui-metric__value-text')).toBeNull()
    expect(metricValue('风量')?.querySelector('.ui-metric__value-text')).toBeNull()
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

describe('UISpecRenderer offline route sketch', () => {
  const viaCharge = {
    summary: '经虹桥枢纽超充站前往机场',
    waypoints: [
      { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.47 },
      { id: 'station-hongqiao-01', name: '虹桥枢纽超充站', latitude: 31.21, longitude: 121.38 },
      { id: 'destination-hongqiao-t2', name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
    ],
    polyline: [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.22, longitude: 121.43 },
      { latitude: 31.21, longitude: 121.38 },
      { latitude: 31.204, longitude: 121.355 },
      { latitude: 31.198, longitude: 121.336 },
    ],
  }

  const bypass = {
    summary: '经外环快速路改线前往机场',
    waypoints: [
      { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.47 },
      { id: 'via-ring-road-01', name: '外环快速路', latitude: 31.215, longitude: 121.41 },
      { id: 'destination-hongqiao-t2', name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
    ],
    polyline: [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.226, longitude: 121.455 },
      { latitude: 31.215, longitude: 121.41 },
      { latitude: 31.205, longitude: 121.36 },
      { latitude: 31.198, longitude: 121.336 },
    ],
  }

  function navigationSpec(routeSketch?: unknown): UISpec {
    return baseSpec({
      presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'normal' },
      layout: { type: 'stack', gap: 'md', slots: { main: ['navigation'] } },
      components: [{
        id: 'navigation',
        type: 'navigation-summary',
        props: {
          routeId: 'route-airport-via-charge-001',
          destination: '虹桥机场 T2',
          eta: '2026-07-22T20:37:00+08:00',
          distanceKm: 38,
          estimatedBatteryAtArrival: 55,
          ...(routeSketch !== undefined ? { routeSketch } : {}),
        },
      } as ComponentSpec],
    })
  }

  function renderer() {
    return screen.getByRole('region', { name: 'Generated task interface' })
  }

  it('draws the route with its stops and names the sketch for what it is', () => {
    render(<UISpecRenderer spec={navigationSpec(viaCharge)} onAction={vi.fn()} pending={false} />)

    const svg = screen.getByRole('img', { name: '前往虹桥机场 T2的路线示意' })
    expect(svg.querySelector('.ui-route-sketch__line')).toHaveAttribute('d', expect.stringContaining('M'))
    expect(svg.querySelectorAll('.ui-route-sketch__marker')).toHaveLength(3)
    expect(svg.querySelector('.ui-route-sketch__marker[data-role="origin"]')).toBeInTheDocument()
    expect(svg.querySelector('.ui-route-sketch__marker[data-role="via"]')).toBeInTheDocument()
    expect(svg.querySelector('.ui-route-sketch__marker[data-role="destination"]')).toBeInTheDocument()
    // The stops are named in text as well, so the drawing is never the only carrier.
    expect(renderer().querySelector('.ui-route-sketch__stops')).toHaveTextContent('出发地虹桥枢纽超充站虹桥机场 T2')
    // The route prose stays out of the card: the destination heading and the stop
    // names already carry it, and the ETA keeps the room.
    expect(renderer().textContent).not.toContain('经虹桥枢纽超充站前往机场')
  })

  it('shows the staged marker as simulated progress, never as a live position', () => {
    render(<UISpecRenderer spec={navigationSpec({ ...viaCharge, progress: 0.4 })} onAction={vi.fn()} pending={false} />)

    const band = renderer().querySelector('.ui-route-sketch')
    expect(band).toHaveAttribute('data-route-progress', 'simulated')
    expect(band!.querySelector('.ui-route-sketch__vehicle')).toBeInTheDocument()
    expect(band!.querySelector('.ui-route-sketch__progress')).toHaveTextContent('模拟行程进度 40%')
    expect(renderer().textContent).not.toContain('实时位置')
    expect(renderer().textContent).not.toContain('正在此处')
    expect(renderer().textContent).not.toContain('当前位置')
  })

  it('draws the route without a marker when no progress was authored', () => {
    render(<UISpecRenderer spec={navigationSpec(viaCharge)} onAction={vi.fn()} pending={false} />)

    const band = renderer().querySelector('.ui-route-sketch')
    expect(band).toHaveAttribute('data-route-progress', 'route-only')
    expect(band!.querySelector('.ui-route-sketch__vehicle')).not.toBeInTheDocument()
    expect(band!.querySelector('.ui-route-sketch__progress')).not.toBeInTheDocument()
  })

  it('redraws the line and the stops when the route changes', () => {
    const { rerender } = render(<UISpecRenderer spec={navigationSpec({ ...viaCharge, progress: 0.4 })} onAction={vi.fn()} pending={false} />)
    const before = {
      path: renderer().querySelector('.ui-route-sketch__line')!.getAttribute('d'),
      vehicle: renderer().querySelector('.ui-route-sketch__vehicle')!.getAttribute('transform'),
    }

    rerender(<UISpecRenderer spec={navigationSpec({ ...bypass, progress: 0.52 })} onAction={vi.fn()} pending={false} />)

    expect(renderer().querySelector('.ui-route-sketch__line')!.getAttribute('d')).not.toBe(before.path)
    expect(renderer().querySelector('.ui-route-sketch__vehicle')!.getAttribute('transform')).not.toBe(before.vehicle)
    expect(renderer().querySelector('.ui-route-sketch__stops')).toHaveTextContent('外环快速路')
    expect(renderer().querySelector('.ui-route-sketch__progress')).toHaveTextContent('模拟行程进度 52%')
  })

  it('keeps every navigation fact when there is no geometry to draw', () => {
    render(<UISpecRenderer spec={navigationSpec()} onAction={vi.fn()} pending={false} />)

    expect(renderer().querySelector('.ui-route-sketch')).not.toBeInTheDocument()
    expect(renderer().querySelector('.ui-navigation-brief__route-rule')).toHaveAttribute('data-route-progress', 'unavailable')
    expect(renderer().querySelector('.ui-navigation-brief__destination')).toHaveTextContent('虹桥机场 T2')
    expect(renderer().querySelector('.ui-navigation-eta')).toHaveTextContent('20:37')
    expect(renderer().querySelector('.ui-route-facts')).toHaveTextContent('38')
    expect(renderer().querySelector('.ui-route-facts')).toHaveTextContent('55')
  })

  it('survives unusable geometry with the card intact', () => {
    const unusable: unknown[] = [
      { ...viaCharge, polyline: [] },
      { ...viaCharge, polyline: [{ latitude: 31.23, longitude: 121.47 }] },
      { ...viaCharge, polyline: [{ latitude: 'north', longitude: 121.47 }, { latitude: 31.2, longitude: 121.4 }] },
      { ...viaCharge, waypoints: [] },
      { ...viaCharge, waypoints: [{ name: '', latitude: 31.23, longitude: 121.47 }] },
      { ...viaCharge, progress: Number.NaN },
      { ...viaCharge, progress: -1 },
      { ...viaCharge, progress: 2 },
      { ...viaCharge, progress: 'half' },
      'not-a-sketch',
      null,
    ]

    for (const routeSketch of unusable) {
      const { unmount } = render(<UISpecRenderer spec={navigationSpec(routeSketch)} onAction={vi.fn()} pending={false} />)

      // The drawing is what degrades; the destination and the ETA never do.
      expect(renderer().querySelector('.ui-navigation-brief__destination')).toHaveTextContent('虹桥机场 T2')
      expect(renderer().querySelector('.ui-navigation-eta')).toHaveTextContent('20:37')
      expect(renderer().querySelector('.ui-route-sketch__vehicle')).not.toBeInTheDocument()
      unmount()
    }
  })

  it('keeps route ids, fixture names, and prop names out of the sketch', () => {
    render(<UISpecRenderer spec={navigationSpec({ ...viaCharge, progress: 0.4 })} onAction={vi.fn()} pending={false} />)

    for (const internal of ['route-airport-via-charge-001', 'navigation-summary', 'routeSketch', 'route-progress', 'polyline', 'origin-demo', 'station-hongqiao-01', 'latitude']) {
      expect(renderer().textContent).not.toContain(internal)
    }
    expect(renderer().querySelector('.ui-route-sketch')!.textContent).not.toContain('undefined')
  })
})

/**
 * The route as a panel in its own column, which is the shape the composer emits
 * whenever it has geometry. The band above is what a spec without a panel falls
 * back to.
 */
describe('UISpecRenderer route map panel', () => {
  const viaCharge = {
    summary: '经虹桥枢纽超充站前往机场',
    waypoints: [
      { id: 'origin-demo', name: '出发地', latitude: 31.23, longitude: 121.47 },
      { id: 'station-hongqiao-01', name: '虹桥枢纽超充站', latitude: 31.21, longitude: 121.38 },
      { id: 'destination-hongqiao-t2', name: '虹桥机场 T2', latitude: 31.198, longitude: 121.336 },
    ],
    polyline: [
      { latitude: 31.23, longitude: 121.47 },
      { latitude: 31.22, longitude: 121.43 },
      { latitude: 31.21, longitude: 121.38 },
      { latitude: 31.204, longitude: 121.355 },
      { latitude: 31.198, longitude: 121.336 },
    ],
  }

  /** The split the composer emits: map on the left, the trip's cards on the right. */
  function splitSpec(props: Record<string, unknown>): UISpec {
    return baseSpec({
      phase: 'driving-to-airport',
      presentation: { mode: 'replace', density: 'compact', theme: 'dark', priority: 'normal' },
      layout: { type: 'split', ratio: [1.75, 1], slots: { primary: ['route-map'], secondary: ['navigation'] } },
      components: [
        { id: 'route-map', type: 'route-map', props } as ComponentSpec,
        {
          id: 'navigation',
          type: 'navigation-summary',
          props: {
            routeId: 'route-airport-via-charge-001',
            destination: '虹桥机场 T2',
            eta: '2026-07-22T20:37:00+08:00',
            distanceKm: 38,
            estimatedBatteryAtArrival: 55,
          },
        } as ComponentSpec,
      ],
    })
  }

  const followProps = { destination: '虹桥机场 T2', mode: 'follow', routeSketch: { ...viaCharge, progress: 0.4 } }

  /** The card that rides in the rail beside the map, on its own. */
  function navigationCard(id = 'navigation'): ComponentSpec {
    return {
      id,
      type: 'navigation-summary',
      props: {
        routeId: 'route-airport-via-charge-001',
        destination: '虹桥机场 T2',
        eta: '2026-07-22T20:37:00+08:00',
        distanceKm: 38,
        estimatedBatteryAtArrival: 55,
      },
    } as ComponentSpec
  }

  /** A legal state the density trim allows: a map beside two cards, not one. */
  function railOfTwo(): UISpec {
    const spec = splitSpec(followProps)
    return {
      ...spec,
      layout: { type: 'split', ratio: [1.75, 1], slots: { primary: ['route-map'], secondary: ['navigation', 'second'] } },
      components: [...spec.components, navigationCard('second')],
    } as UISpec
  }

  function renderer() {
    return screen.getByRole('region', { name: 'Generated task interface' })
  }

  function panel() {
    return renderer().querySelector('.ui-card--route-map')
  }

  it('draws the route in a column of its own, beside the card that describes it', () => {
    render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)

    expect(renderer().querySelector('.ui-layout--split')).toBeInTheDocument()
    const svg = screen.getByRole('img', { name: '前往虹桥机场 T2的路线示意' })
    expect(svg.querySelector('.ui-route-map__line')).toHaveAttribute('d', expect.stringContaining('M'))
    expect(svg.querySelectorAll('.ui-route-map__marker')).toHaveLength(3)
    expect(svg.querySelector('.ui-route-map__stop[data-role="origin"]')).toHaveTextContent('出发地')
    expect(svg.querySelector('.ui-route-map__stop[data-role="via"]')).toHaveTextContent('虹桥枢纽超充站')
    expect(svg.querySelector('.ui-route-map__stop[data-role="destination"]')).toHaveTextContent('虹桥机场 T2')
    expect(panel()).toHaveAttribute('data-route-map-source', 'sketch')
    expect(panel()).toHaveAttribute('data-route-map-mode', 'follow')
    // The card in the other column keeps its facts and never redraws the line.
    expect(renderer().querySelector('.ui-navigation-eta')).toHaveTextContent('20:37')
    expect(renderer().querySelector('.ui-route-sketch')).not.toBeInTheDocument()
  })

  it('injects no map script and stays on the sketch when no AMap key is configured', () => {
    // CI and the default local build carry no VITE_AMAP_JS_KEY, so the panel
    // must render entirely from the offline sketch with the network untouched.
    render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)

    expect(panel()).toHaveAttribute('data-route-map-source', 'sketch')
    expect(document.getElementById('amap-js-api')).toBeNull()
    expect(panel()!.querySelector('.ui-route-map__basemap')).toHaveAttribute('data-active', 'false')
  })

  it('marks the staged point as simulated progress, never as a live position', () => {
    render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)

    expect(panel()).toHaveAttribute('data-route-progress', 'simulated')
    expect(panel()!.querySelector('.ui-route-map__vehicle')).toBeInTheDocument()
    expect(panel()!.querySelector('.ui-route-map__progress')).toHaveTextContent('模拟行程进度 40%')
    for (const claim of ['实时位置', '正在此处', '当前位置', '实时路况']) {
      expect(renderer().textContent).not.toContain(claim)
    }
  })

  it('draws the route without a marker when the spec authored no progress', () => {
    render(<UISpecRenderer spec={splitSpec({ destination: '虹桥机场 T2', mode: 'overview', routeSketch: viaCharge })} onAction={vi.fn()} pending={false} />)

    expect(panel()).toHaveAttribute('data-route-progress', 'route-only')
    expect(panel()).toHaveAttribute('data-route-map-mode', 'overview')
    expect(panel()!.querySelector('.ui-route-map__vehicle')).not.toBeInTheDocument()
    expect(panel()!.querySelector('.ui-route-map__progress')).not.toBeInTheDocument()
  })

  it('holds the marker where the spec put it when no crawl is authored', () => {
    const { rerender } = render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)
    const before = {
      path: panel()!.querySelector('.ui-route-map__line')!.getAttribute('d'),
      vehicle: panel()!.querySelector('.ui-route-map__vehicle')!.getAttribute('transform'),
    }

    // Same geometry, same progress, no authored span, new render: there is
    // nothing for the component to move between, so the marker has not budged.
    rerender(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)
    expect(panel()!.querySelector('.ui-route-map__vehicle')!.getAttribute('transform')).toBe(before.vehicle)

    rerender(<UISpecRenderer
      spec={splitSpec({ ...followProps, routeSketch: { ...viaCharge, progress: 0.72 } })}
      onAction={vi.fn()}
      pending={false}
    />)

    // A new authored value moves the marker along the same unchanged line.
    expect(panel()!.querySelector('.ui-route-map__vehicle')!.getAttribute('transform')).not.toBe(before.vehicle)
    expect(panel()!.querySelector('.ui-route-map__line')!.getAttribute('d')).toBe(before.path)
    expect(panel()!.querySelector('.ui-route-map__progress')).toHaveTextContent('模拟行程进度 72%')
  })

  /**
   * The crawl, seen from the outside: what the driver actually reads.
   *
   * `crawl.test.ts` covers the interpolation itself. What matters here is that
   * the marker and the percentage are one reading rather than two — a caption
   * that lagged the dot would be the panel contradicting itself — and that the
   * crawl stops at the authored bound instead of running to the destination.
   *
   * Frames are driven by hand through `requestAnimationFrame`, so no test waits
   * on a real one and every assertion lands on an exact position.
   */
  describe('authored crawl', () => {
    const crawlProps = {
      destination: '虹桥机场 T2',
      mode: 'follow',
      routeSketch: { ...viaCharge, progress: 0.4, crawl: { toProgress: 0.6, durationSeconds: 10 } },
    }

    let frames: Array<(timestampMs: number) => void> = []

    beforeEach(() => {
      frames = []
      now = 0
      vi.stubGlobal('requestAnimationFrame', (callback: (timestampMs: number) => void) => {
        frames.push(callback)
        return frames.length
      })
      vi.stubGlobal('cancelAnimationFrame', (handle: number) => { frames[handle - 1] = () => {} })
    })

    afterEach(() => { vi.unstubAllGlobals() })

    let now = 0

    function step(timestampMs: number) {
      now = timestampMs
      const due = frames
      frames = []
      act(() => { for (const frame of due) frame(timestampMs) })
    }

    /**
     * Delivers `durationMs` of frames the way a painting tab does, at 100ms each.
     * The crawl counts the gap between frames rather than the time since it
     * started — a gap wider than a slow frame is a tab that stopped painting, and
     * spending the span through one would be the teleport it exists to avoid — so
     * time only passes here in frames a tab could actually have delivered.
     */
    function advance(durationMs: number) {
      const target = now + durationMs
      while (now < target) step(Math.min(now + 100, target))
    }

    function reading() {
      return {
        vehicle: panel()!.querySelector('.ui-route-map__vehicle')!.getAttribute('transform'),
        percent: panel()!.querySelector('.ui-route-map__progress')!.textContent,
      }
    }

    it('moves the marker and the percentage as one reading', () => {
      render(<UISpecRenderer spec={splitSpec(crawlProps)} onAction={vi.fn()} pending={false} />)

      step(0)
      const start = reading()
      expect(start.percent).toBe('模拟行程进度 40%')

      advance(5000)
      const halfway = reading()
      expect(halfway.percent).toBe('模拟行程进度 50%')
      expect(halfway.vehicle).not.toBe(start.vehicle)
    })

    it('stops at the authored bound rather than at the destination', () => {
      render(<UISpecRenderer spec={splitSpec(crawlProps)} onAction={vi.fn()} pending={false} />)

      step(0)
      advance(11_000)
      expect(reading().percent).toBe('模拟行程进度 60%')

      // The span is spent, so nothing further is scheduled and the marker holds
      // well short of the 100% it would reach if this were a run to the end.
      expect(frames).toHaveLength(0)
      const settled = reading()
      advance(5_000)
      expect(reading()).toEqual(settled)
    })

    it('never schedules a frame for a spec that authored no crawl', () => {
      render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)

      expect(frames).toHaveLength(0)
      expect(panel()!.querySelector('.ui-route-map__progress')).toHaveTextContent('模拟行程进度 40%')
    })

    it('restarts from the new authored value when a new spec arrives mid-crawl', () => {
      const { rerender } = render(<UISpecRenderer spec={splitSpec(crawlProps)} onAction={vi.fn()} pending={false} />)
      step(0)
      advance(5000)
      expect(reading().percent).toBe('模拟行程进度 50%')

      // A new checkpoint is the truth; whatever the last span had crawled to is
      // dropped rather than carried onto it.
      rerender(<UISpecRenderer
        spec={splitSpec({ ...crawlProps, routeSketch: { ...viaCharge, progress: 0.72 } })}
        onAction={vi.fn()}
        pending={false}
      />)
      expect(reading().percent).toBe('模拟行程进度 72%')
    })
  })

  it('costs the panel its own slot when the geometry is unusable, and nothing else', () => {
    const unusable: unknown[] = [
      { ...viaCharge, polyline: [] },
      { ...viaCharge, polyline: [{ latitude: 31.23, longitude: 121.47 }] },
      { ...viaCharge, polyline: [{ latitude: 'north', longitude: 121.47 }, { latitude: 31.2, longitude: 121.4 }] },
      // Plottable and schema-valid, but every point is the same spot: a dot, not a route.
      { ...viaCharge, polyline: [{ latitude: 31.23, longitude: 121.47 }, { latitude: 31.23, longitude: 121.47 }, { latitude: 31.23, longitude: 121.47 }] },
      { ...viaCharge, waypoints: [] },
      { ...viaCharge, progress: 2 },
      { ...viaCharge, progress: 'half' },
      'not-a-sketch',
      undefined,
      null,
    ]

    for (const routeSketch of unusable) {
      const { unmount } = render(<UISpecRenderer
        spec={splitSpec({ destination: '虹桥机场 T2', mode: 'follow', routeSketch })}
        onAction={vi.fn()}
        pending={false}
      />)

      // Per-component degradation: the map's slot takes the fallback and the
      // card in the other column is untouched.
      expect(panel()).toBeNull()
      expect(renderer().querySelector('.ui-card--fallback')).toBeInTheDocument()
      expect(renderer().querySelector('.ui-navigation-brief__destination')).toHaveTextContent('虹桥机场 T2')
      expect(renderer().querySelector('.ui-navigation-eta')).toHaveTextContent('20:37')
      expect(renderer().querySelector('.ui-route-facts')).toHaveTextContent('38')
      unmount()
    }
  })

  /**
   * The fold: the one thing on this surface the driver decides rather than the
   * Agent.
   *
   * What the collapsed state actually looks like is the stylesheet's, and
   * `glass-panel-scope.test.ts` holds it to the same single-card guard as the
   * rest of the panel. What is pinned here is the contract the styles hang off:
   * that the control exists only where a panel does, that `data-panel` reports
   * the driver's choice, and that the choice survives the Agent replacing the
   * spec underneath it.
   */
  describe('minimizing the floating panel', () => {
    function brief() {
      return renderer().querySelector('.ui-card--navigation-summary')
    }

    function fold() {
      return screen.queryByRole('button', { name: /面板$/ })
    }

    it('offers the fold on the panel, and reports which way it is folded', async () => {
      const user = userEvent.setup()
      render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)

      // Open is the state the Agent's spec arrives in; the driver opts out of it.
      expect(brief()).toHaveAttribute('data-panel', 'expanded')
      expect(fold()).toHaveAccessibleName('收起面板')
      expect(fold()).toHaveAttribute('aria-expanded', 'true')

      await user.click(fold()!)
      expect(brief()).toHaveAttribute('data-panel', 'collapsed')
      expect(fold()).toHaveAccessibleName('展开面板')
      expect(fold()).toHaveAttribute('aria-expanded', 'false')

      await user.click(fold()!)
      expect(brief()).toHaveAttribute('data-panel', 'expanded')
    })

    it('names the region it folds away, so the state is not the button alone', () => {
      render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)

      const controls = fold()!.getAttribute('aria-controls')
      expect(controls).toBeTruthy()
      expect(document.getElementById(controls!)).toBeInTheDocument()
    })

    it('keeps the destination and the ETA in the DOM while folded', async () => {
      const user = userEvent.setup()
      render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)
      await user.click(fold()!)

      // The two answers a driver glances down for stay; only the detail region
      // goes, and it goes to a stylesheet rule rather than to an unmount — a
      // window narrowed below the panel's breakpoint has to show a whole card
      // again, not a folded one with no control left to open it.
      expect(brief()!.querySelector('.ui-navigation-brief__destination')).toHaveTextContent('虹桥机场 T2')
      expect(brief()!.querySelector('.ui-navigation-eta')).toHaveTextContent('20:37')
      expect(brief()!.querySelector('.ui-navigation-brief__detail')).toBeInTheDocument()
    })

    it('holds the fold across a new spec for the same trip', async () => {
      const user = userEvent.setup()
      const { rerender } = render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)
      await user.click(fold()!)

      // A newer UISpec is newer trip facts, not a fresh opinion about how much of
      // the panel the driver wanted to see.
      rerender(<UISpecRenderer
        spec={splitSpec({ ...followProps, routeSketch: { ...viaCharge, progress: 0.72 } })}
        onAction={vi.fn()}
        pending={false}
      />)
      expect(brief()).toHaveAttribute('data-panel', 'collapsed')
    })

    it('has no fold where the card is a column rather than a panel', () => {
      // Nothing behind an ordinary card to uncover, so there is nothing to fold
      // it away for. Each of these fails a different clause of the guard.
      const notPanels: UISpec[] = [
        // No map: the split is two ordinary columns.
        baseSpec({
          layout: { type: 'split', ratio: [1, 1], slots: { primary: ['navigation'], secondary: ['navigation'] } },
          components: [navigationCard()],
        }),
        // A map whose geometry will not draw renders the fallback, which the
        // stylesheet's `:has(.ui-card--route-map)` never matches.
        splitSpec({ destination: '虹桥机场 T2', mode: 'follow', routeSketch: { ...viaCharge, polyline: [] } }),
        // Two cards in the rail: the takeover is off, so the panel is off too.
        railOfTwo(),
      ]

      for (const spec of notPanels) {
        const { unmount } = render(<UISpecRenderer spec={spec} onAction={vi.fn()} pending={false} />)
        expect(fold()).toBeNull()
        expect(renderer().querySelector('[data-panel]')).toBeNull()
        unmount()
      }
    })
  })

  it('keeps route ids, fixture names, and prop names out of the panel', () => {
    render(<UISpecRenderer spec={splitSpec(followProps)} onAction={vi.fn()} pending={false} />)

    for (const internal of ['route-airport-via-charge-001', 'route-map', 'routeSketch', 'overview', 'follow', 'polyline', 'origin-demo', 'station-hongqiao-01', 'latitude']) {
      expect(renderer().textContent).not.toContain(internal)
    }
    expect(panel()!.textContent).not.toContain('undefined')
  })
})

describe('UISpecRenderer flight choices board', () => {
  const choices = [
    {
      flightNumber: 'MU5102', airlineName: '东方航空', originName: '北京首都', status: 'scheduled' as const,
      statusLabel: '计划中', arrivalTimeLabel: '20:30', terminal: 'T2', airportName: '虹桥机场', actionId: 'pick-MU5102',
    },
    {
      flightNumber: 'MU5103', airlineName: '东方航空', originName: '深圳宝安', status: 'delayed' as const,
      statusLabel: '延误', arrivalTimeLabel: '20:30', revisedTimeLabel: '预计 21:10', terminal: 'T1', airportName: '虹桥机场', actionId: 'pick-MU5103',
    },
    {
      flightNumber: 'CA1516', airlineName: '中国国际航空', originName: '广州白云', status: 'in-air' as const,
      statusLabel: '飞行中', arrivalTimeLabel: '21:15', revisedTimeLabel: '预计 21:05', terminal: 'T1', airportName: '浦东机场', actionId: 'pick-CA1516',
    },
  ]

  function boardSpec(overrides: {
    choices?: unknown
    actionIds?: string[]
    definedActionIds?: string[]
    refreshActionId?: string
  } = {}): UISpec {
    // `in` rather than `??`: one of the broken cases is a board with no choices
    // key at all, which a default would quietly repair.
    const rows = 'choices' in overrides ? overrides.choices : choices
    const refresh = overrides.refreshActionId
    const declared = overrides.actionIds
      ?? [...choices.map((choice) => choice.actionId), ...(refresh ? [refresh] : [])]
    const defined = overrides.definedActionIds ?? declared
    return baseSpec({
      phase: 'collecting-information',
      title: '选择航班',
      layout: { type: 'stack', gap: 'md', slots: { main: ['flight-choices'] } },
      components: [{
        id: 'flight-choices',
        type: 'flight-choices',
        actions: declared,
        props: {
          arrivalCityName: '上海',
          dateLabel: '今天',
          choices: rows,
          freshness: 'fixture',
          ...(refresh ? { refreshActionId: refresh } : {}),
        },
      } as ComponentSpec],
      actions: defined.map((actionId) => ({
        id: actionId,
        label: `选择 ${actionId}`,
        style: 'secondary' as const,
        event: { type: 'agent-message' as const, text: actionId },
      })),
    })
  }

  const renderer = () => screen.getByRole('region', { name: 'Generated task interface' })
  const rows = () => Array.from(renderer().querySelectorAll<HTMLButtonElement>('.ui-flight-choices__row'))
  const refreshPill = () => renderer().querySelector<HTMLButtonElement>('.ui-flight-choices__refresh')

  it('numbers every arrival and shows what tells two of them apart', () => {
    render(<UISpecRenderer spec={boardSpec()} onAction={vi.fn()} pending={false} />)

    expect(rows()).toHaveLength(3)
    const [first, second, third] = rows()
    expect(first).toHaveAttribute('data-flight-number', 'MU5102')
    expect(first!.querySelector('.ui-flight-choices__rank')).toHaveTextContent('1')
    expect(first).toHaveTextContent('东方航空')
    expect(first).toHaveTextContent('北京首都')
    expect(first).toHaveTextContent('20:30')
    expect(first).toHaveTextContent('T2')
    // The airport, not just the terminal: 虹桥 T2 and 浦东 T2 are an hour apart,
    // and a row that named only the terminal would make them look interchangeable.
    expect(first!.querySelector('.ui-flight-choices__terminal')).toHaveTextContent('虹桥机场 T2')
    expect(third!.querySelector('.ui-flight-choices__terminal')).toHaveTextContent('浦东机场 T1')
    // The two 20:30 arrivals are told apart by the revision, not the schedule.
    expect(first!.querySelector('.ui-flight-choices__revised')).toBeNull()
    expect(second!.querySelector('.ui-flight-choices__revised')).toHaveTextContent('预计 21:10')
    expect(second!.querySelector('.ui-status--delayed')).toHaveTextContent('延误')
  })

  it('keeps the refresh out of the numbered list and out of the action bars', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    render(<UISpecRenderer
      spec={boardSpec({ refreshActionId: 'refresh-flight-options' })}
      onAction={onAction}
      pending={false}
    />)

    // Three rows, not four: a refresh that joined the list would be countable,
    // and 第四个 has to keep meaning the row that is not there.
    expect(rows()).toHaveLength(3)
    // Drawn once, by the card, so it is not also promoted into a button group.
    expect(renderer().querySelectorAll('[data-action-id="refresh-flight-options"]')).toHaveLength(1)
    expect(renderer().querySelector('.ui-card__actions')).toBeNull()
    expect(renderer().querySelector('.ui-actions')).toBeNull()

    await user.click(refreshPill()!)

    expect(onAction).toHaveBeenCalledExactlyOnceWith('refresh-flight-options', 'flight-choices')
  })

  it('offers no refresh when the spec declares one it never defined', () => {
    render(<UISpecRenderer
      spec={boardSpec({ refreshActionId: 'refresh-flight-options', definedActionIds: choices.map((choice) => choice.actionId) })}
      onAction={vi.fn()}
      pending={false}
    />)

    // A pill that cannot reach the Agent is worse than no pill: the rows still
    // work, and the driver is not invited to press something inert.
    expect(refreshPill()).toBeNull()
    expect(rows()).toHaveLength(3)
  })

  it('disables the refresh alongside the rows while an action is in flight', () => {
    render(<UISpecRenderer
      spec={boardSpec({ refreshActionId: 'refresh-flight-options' })}
      onAction={vi.fn()}
      pending
    />)

    expect(refreshPill()).toBeDisabled()
    for (const row of rows()) expect(row).toBeDisabled()
  })

  it('sends the picked row’s own action, dispatched from the board', async () => {
    const onAction = vi.fn()
    const user = userEvent.setup()
    render(<UISpecRenderer spec={boardSpec()} onAction={onAction} pending={false} />)

    await user.click(rows()[2]!)

    expect(onAction).toHaveBeenCalledExactlyOnceWith('pick-CA1516', 'flight-choices')
  })

  it('draws each row’s action once, in the row, and never in the action bars', () => {
    render(<UISpecRenderer spec={boardSpec()} onAction={vi.fn()} pending={false} />)

    // The rows are the controls: no duplicate button group under the card, and
    // nothing promoted into the task-wide bar either.
    expect(renderer().querySelector('.ui-card__actions')).toBeNull()
    expect(renderer().querySelector('.ui-actions')).toBeNull()
    expect(renderer().querySelectorAll('[data-action-id="pick-MU5102"]')).toHaveLength(1)
    // The actions are still on screen, so the surface must not read as actionless.
    expect(renderer()).toHaveAttribute('data-has-actions', 'true')
  })

  it('keeps a row readable but unpressable when the spec never defined its action', () => {
    render(<UISpecRenderer
      spec={boardSpec({ definedActionIds: ['pick-MU5102', 'pick-CA1516'] })}
      onAction={vi.fn()}
      pending={false}
    />)

    const [first, second] = rows()
    expect(second).toBeDisabled()
    expect(second).toHaveTextContent('MU5103')
    expect(second).toHaveTextContent('预计 21:10')
    expect(first).toBeEnabled()
  })

  it('disables every row while a pick is in flight so a second cannot race it', () => {
    render(<UISpecRenderer spec={boardSpec()} onAction={vi.fn()} pending />)

    for (const row of rows()) expect(row).toBeDisabled()
  })

  it('degrades the board to a fallback when the choices are not a real list', () => {
    const unusable: unknown[] = [
      // Nothing to choose between, and one row was an answer rather than a choice.
      [],
      [choices[0]],
      'not-a-list',
      undefined,
      // A row that names no action would be a choice the driver cannot make.
      choices.map((choice) => ({ ...choice, actionId: undefined })),
      // Six rows: past the point where a driver picks rather than reads.
      [...choices, ...choices],
    ]

    for (const broken of unusable) {
      const { unmount } = render(<UISpecRenderer spec={boardSpec({ choices: broken })} onAction={vi.fn()} pending={false} />)

      expect(renderer().querySelector('.ui-flight-choices')).toBeNull()
      expect(renderer().querySelector('.ui-card--fallback')).toBeInTheDocument()
      unmount()
    }
  })

  it('keeps action ids and internal names out of what the driver reads', () => {
    render(<UISpecRenderer spec={boardSpec()} onAction={vi.fn()} pending={false} />)

    for (const internal of ['pick-MU5102', 'flight-choices', 'actionId', 'arrivalCityName', 'fixture', 'agent-message']) {
      expect(renderer().textContent).not.toContain(internal)
    }
  })
})
