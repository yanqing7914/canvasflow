import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DemoControlsPanel, type DemoControlsViewModel } from './DemoControlsPanel'

function viewModel(overrides: Partial<DemoControlsViewModel> = {}): DemoControlsViewModel {
  return {
    phaseLabel: '准备接机',
    rawPhase: 'preparing',
    currentStep: 3,
    completedSteps: 2,
    totalSteps: 8,
    progressPercent: 25,
    planningSourceLabel: '模型 · qwen-plus',
    planningSourceExact: 'qwen-plus',
    advanceLabel: '推进下一事件',
    advanceDisabled: false,
    voiceFixtures: [
      { id: 'airport', label: '虹桥机场', available: true },
      { id: 'flight', label: 'MU5102', available: false, unavailableReason: '输入框里还有未发送的内容' },
    ],
    lighting: 'auto',
    lightingDisabled: false,
    lightingHint: '选择创建任务时车辆上报的光线',
    mapStatus: '运行中 · Key 1',
    mapRecoverDisabled: false,
    mapRotateDisabled: true,
    effects: ['navigation.start:succeeded'],
    taskId: 'pickup-001',
    taskRevision: 3,
    uiRevision: 4,
    density: 'compact',
    priority: 'normal',
    safetyNote: '此面板仅用于演示，不会改变行程事实或跳过操作确认。',
    ...overrides,
  }
}

function callbacks() {
  return {
    onAdvance: vi.fn(),
    onReplayVoiceFixture: vi.fn(),
    onSelectLighting: vi.fn(),
    onRecoverMap: vi.fn(),
  }
}

describe('DemoControlsPanel', () => {
  it('keeps the competition view focused on phase, progress, advance, and recovery', async () => {
    const user = userEvent.setup()
    const actions = callbacks()
    render(<DemoControlsPanel viewModel={viewModel()} {...actions} />)

    expect(screen.getByText('准备接机')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '演示进度' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('2 / 8')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '推进下一事件' }))
    expect(actions.onAdvance).toHaveBeenCalledOnce()
    expect(screen.getByText('故障恢复').closest('details')).not.toHaveAttribute('open')
  })

  it('does not expose developer metadata, voice fixtures, or key switching in competition mode', () => {
    render(<DemoControlsPanel viewModel={viewModel()} {...callbacks()} />)

    expect(screen.queryByText('模型 · qwen-plus')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '语音兜底回放' })).not.toBeInTheDocument()
    expect(screen.queryByText('pickup-001')).not.toBeInTheDocument()
    expect(screen.queryByText('taskRevision 3')).not.toBeInTheDocument()
    expect(screen.queryByText('uiRevision 4')).not.toBeInTheDocument()
    expect(screen.queryByText('compact')).not.toBeInTheDocument()
    expect(screen.queryByText('navigation.start:succeeded')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '切换 Key' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Key 1/i)).not.toBeInTheDocument()
  })

  it('routes the formal recovery action without exposing its key index', async () => {
    const user = userEvent.setup()
    const actions = callbacks()
    render(<DemoControlsPanel viewModel={viewModel()} {...actions} />)

    await user.click(screen.getByText('故障恢复'))
    expect(screen.getByRole('group', { name: '地图恢复' })).toBeInTheDocument()
    expect(screen.getByText('运行中')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新尝试地图' }))
    expect(actions.onRecoverMap).toHaveBeenCalledWith(false)
  })

  it('opens recovery immediately when the map is unavailable', () => {
    render(<DemoControlsPanel viewModel={viewModel({ mapStatus: '暂时不可用 · Key 1' })} {...callbacks()} />)

    expect(screen.getByText('故障恢复').closest('details')).toHaveAttribute('open')
    expect(screen.getByText('暂时不可用')).toBeInTheDocument()
    expect(screen.queryByText(/Key 1/i)).not.toBeInTheDocument()
  })

  it('preserves diagnostic callbacks behind the explicit developer mode', async () => {
    const user = userEvent.setup()
    const actions = callbacks()
    render(<DemoControlsPanel mode="developer" viewModel={viewModel()} {...actions} />)

    await user.click(screen.getByRole('button', { name: '虹桥机场' }))
    expect(actions.onReplayVoiceFixture).toHaveBeenCalledWith('airport')
    expect(screen.getByRole('button', { name: '虹桥机场' })).toHaveClass('voice-fallback-button')
    expect(screen.getByRole('button', { name: 'MU5102' })).toBeDisabled()

    await user.click(screen.getByText('开发诊断'))
    await user.click(screen.getByRole('button', { name: '夜间' }))
    expect(actions.onSelectLighting).toHaveBeenCalledWith('night')
    expect(screen.getByRole('button', { name: '切换 Key' })).toBeDisabled()
    expect(screen.getByText('pickup-001')).toBeInTheDocument()
    expect(screen.getByText('navigation.start:succeeded')).toBeInTheDocument()
  })

  it('offers the developer tools to the full app through an explicit query mode', () => {
    const originalLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`
    window.history.replaceState({}, '', '/?demoControls=developer')
    try {
      render(<DemoControlsPanel viewModel={viewModel()} {...callbacks()} />)
      expect(screen.getByRole('group', { name: '语音兜底回放' })).toBeInTheDocument()
      expect(screen.getByText('开发诊断')).toBeInTheDocument()
    } finally {
      window.history.replaceState({}, '', originalLocation)
    }
  })

  it('renders an idle state without inventing task metadata', () => {
    render(<DemoControlsPanel viewModel={viewModel({
      phaseLabel: '尚无任务', rawPhase: undefined, currentStep: 0, completedSteps: 0,
      totalSteps: 8, progressPercent: 0, planningSourceLabel: '未规划', planningSourceExact: undefined,
      taskId: undefined, taskRevision: undefined, uiRevision: undefined, density: undefined, priority: undefined,
      advanceDisabled: true, effects: [],
    })} {...callbacks()} />)

    expect(screen.getByText('尚无任务')).toBeInTheDocument()
    expect(screen.queryByText('未规划')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '推进下一事件' })).toBeDisabled()
  })

  it('clamps invalid progress values before exposing or painting them', () => {
    const { rerender } = render(<DemoControlsPanel viewModel={viewModel({ progressPercent: 125 })} {...callbacks()} />)

    expect(screen.getByRole('progressbar', { name: '演示进度' })).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByRole('progressbar', { name: '演示进度' }).firstElementChild).toHaveStyle({ width: '100%' })

    rerender(<DemoControlsPanel viewModel={viewModel({ progressPercent: Number.NaN })} {...callbacks()} />)
    expect(screen.getByRole('progressbar', { name: '演示进度' })).toHaveAttribute('aria-valuenow', '0')
  })
})
