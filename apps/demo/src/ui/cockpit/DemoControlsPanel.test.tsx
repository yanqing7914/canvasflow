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
    onGuideNext: vi.fn(),
    onReplayVoiceFixture: vi.fn(),
    onSelectLighting: vi.fn(),
    onRecoverMap: vi.fn(),
  }
}

describe('DemoControlsPanel', () => {
  it('keeps the first view focused on phase, progress, advance, and voice fallback', async () => {
    const user = userEvent.setup()
    const actions = callbacks()
    render(<DemoControlsPanel viewModel={viewModel()} {...actions} />)

    expect(screen.getByText('准备接机')).toBeInTheDocument()
    expect(screen.getByText('模型 · qwen-plus')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '演示进度' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('2 / 8')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '推进下一事件' }))
    expect(actions.onGuideNext).toHaveBeenCalledOnce()
    expect(screen.getByRole('group', { name: '语音兜底回放' })).toBeInTheDocument()

    expect(screen.getByText('高级工具').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('运行详情').closest('details')).not.toHaveAttribute('open')
  })

  it('keeps advanced tools and runtime details collapsed until requested', async () => {
    const user = userEvent.setup()
    render(<DemoControlsPanel viewModel={viewModel()} {...callbacks()} />)

    await user.click(screen.getByText('高级工具'))
    expect(screen.getByRole('group', { name: '车外光线' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '地图恢复' })).toBeInTheDocument()
    expect(screen.getByText('navigation.start:succeeded')).toBeInTheDocument()

    await user.click(screen.getByText('运行详情'))
    expect(screen.getByText('preparing')).toBeInTheDocument()
    expect(screen.getByText('pickup-001')).toBeInTheDocument()
    expect(screen.getByText('taskRevision 3')).toBeInTheDocument()
    expect(screen.getByText('uiRevision 4')).toBeInTheDocument()
    expect(screen.getByText('qwen-plus')).toBeInTheDocument()
  })

  it('routes lighting, map recovery, and fixture replay through their callbacks', async () => {
    const user = userEvent.setup()
    const actions = callbacks()
    render(<DemoControlsPanel viewModel={viewModel()} {...actions} />)

    await user.click(screen.getByRole('button', { name: '虹桥机场' }))
    expect(actions.onReplayVoiceFixture).toHaveBeenCalledWith('airport')
    expect(screen.getByRole('button', { name: '虹桥机场' })).toHaveClass('voice-fallback-button')
    expect(screen.getByRole('button', { name: 'MU5102' })).toBeDisabled()

    await user.click(screen.getByText('高级工具'))
    await user.click(screen.getByRole('button', { name: '夜间' }))
    expect(actions.onSelectLighting).toHaveBeenCalledWith('night')
    await user.click(screen.getByRole('button', { name: '重新尝试地图' }))
    expect(actions.onRecoverMap).toHaveBeenCalledWith(false)
    expect(screen.getByRole('button', { name: '切换 Key' })).toBeDisabled()
  })

  it('renders an idle state without inventing task metadata', () => {
    render(<DemoControlsPanel viewModel={viewModel({
      phaseLabel: '尚无任务', rawPhase: undefined, currentStep: 0, completedSteps: 0,
      totalSteps: 8, progressPercent: 0, planningSourceLabel: '未规划', planningSourceExact: undefined,
      taskId: undefined, taskRevision: undefined, uiRevision: undefined, density: undefined, priority: undefined,
      advanceDisabled: true, effects: [],
    })} {...callbacks()} />)

    expect(screen.getByText('尚无任务')).toBeInTheDocument()
    expect(screen.getByText('未规划')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '推进下一事件' })).toBeDisabled()
  })

  it('renders a read-only navigation status instead of a fake advance action', () => {
    render(<DemoControlsPanel viewModel={viewModel({
      advanceLabel: '导航模拟中',
      advanceDisabled: true,
      nextHint: '地图会自动更新',
    })} {...callbacks()} />)

    expect(screen.getByRole('button', { name: '导航模拟中' })).toBeDisabled()
    expect(screen.getByText('地图会自动更新')).toBeInTheDocument()
  })
})
