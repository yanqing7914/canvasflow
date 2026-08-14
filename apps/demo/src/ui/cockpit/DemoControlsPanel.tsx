export type DemoControlsLighting = 'auto' | 'day' | 'night'

export type DemoControlsVoiceFixture = {
  id: string
  label: string
  available: boolean
  unavailableReason?: string
}

export type DemoControlsViewModel = {
  phaseLabel: string
  rawPhase?: string
  currentStep: number
  completedSteps: number
  totalSteps: number
  progressPercent: number
  planningSourceLabel: string
  planningSourceExact?: string
  advanceLabel: string
  advanceDisabled: boolean
  /** Explains the current legal next step without impersonating an Agent action. */
  nextHint?: string
  voiceFixtures: DemoControlsVoiceFixture[]
  lighting: DemoControlsLighting
  lightingDisabled: boolean
  lightingHint: string
  mapStatus: string
  mapRecoverDisabled: boolean
  mapRotateDisabled: boolean
  effects: string[]
  taskId?: string
  taskRevision?: number
  uiRevision?: number
  density?: string
  priority?: string
  safetyNote: string
}

export type DemoControlsPanelProps = {
  viewModel: DemoControlsViewModel
  onGuideNext: () => void
  onReplayVoiceFixture: (fixtureId: string) => void
  onSelectLighting: (lighting: DemoControlsLighting) => void
  onRecoverMap: (rotate: boolean) => void
}

const lightingOptions = [
  { id: 'auto', label: '跟随时间' },
  { id: 'day', label: '白天' },
  { id: 'night', label: '夜间' },
] as const

export function DemoControlsPanel({
  viewModel,
  onGuideNext,
  onReplayVoiceFixture,
  onSelectLighting,
  onRecoverMap,
}: DemoControlsPanelProps) {
  return (
    <section className="demo-controls-panel">
      <div className="demo-controls-panel__summary">
        <div>
          <span>当前阶段</span>
          <strong>{viewModel.phaseLabel}</strong>
        </div>
        <span className="demo-controls-panel__source">{viewModel.planningSourceLabel}</span>
      </div>

      <div className="demo-controls-panel__progress">
        <div className="demo-controls-panel__progress-copy">
          <span>{viewModel.currentStep > 0 ? `第 ${viewModel.currentStep} 步` : '演示进度'}</span>
          <strong>{viewModel.completedSteps} / {viewModel.totalSteps}</strong>
        </div>
        <div
          className="demo-controls-panel__progress-track"
          role="progressbar"
          aria-label="演示进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(viewModel.progressPercent)}
        >
          <span style={{ width: `${viewModel.progressPercent}%` }} />
        </div>
      </div>

      <button
        className="demo-controls-panel__advance"
        type="button"
        disabled={viewModel.advanceDisabled}
        onClick={onGuideNext}
      >
        <span>{viewModel.advanceLabel}</span><span aria-hidden="true">→</span>
      </button>
      {viewModel.nextHint ? <p className="demo-controls-panel__next-hint" role="status">{viewModel.nextHint}</p> : null}

      <div className="demo-controls-panel__fixtures" role="group" aria-label="语音兜底回放">
        <span>语音兜底回放</span>
        <div>
          {viewModel.voiceFixtures.map((fixture) => {
            const hintId = `voice-fixture-${fixture.id}-hint`
            return (
              <span key={fixture.id}>
                <button
                  className="voice-fallback-button"
                  type="button"
                  disabled={!fixture.available}
                  aria-describedby={!fixture.available && fixture.unavailableReason ? hintId : undefined}
                  title={fixture.available ? undefined : fixture.unavailableReason}
                  onClick={() => onReplayVoiceFixture(fixture.id)}
                >
                  {fixture.label}
                </button>
                {!fixture.available && fixture.unavailableReason
                  ? <span id={hintId} className="sr-only">{fixture.unavailableReason}</span>
                  : null}
              </span>
            )
          })}
        </div>
      </div>

      <details className="demo-controls-panel__details">
        <summary>高级工具</summary>
        <div className="demo-controls-panel__details-body">
          <div className="demo-controls-panel__lighting" role="group" aria-label="车外光线">
            <div><span>车外光线</span><strong>{viewModel.lighting === 'auto' ? '跟随时间' : viewModel.lighting === 'day' ? '白天' : '夜间'}</strong></div>
            <div>
              {lightingOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={viewModel.lighting === option.id}
                  disabled={viewModel.lightingDisabled}
                  onClick={() => onSelectLighting(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p>{viewModel.lightingHint}</p>
          </div>

          <div className="demo-controls-panel__map" role="group" aria-label="地图恢复">
            <div><span>地图服务</span><strong>{viewModel.mapStatus}</strong></div>
            <div>
              <button type="button" disabled={viewModel.mapRecoverDisabled} onClick={() => onRecoverMap(false)}>重新尝试地图</button>
              <button type="button" disabled={viewModel.mapRotateDisabled} onClick={() => onRecoverMap(true)}>切换 Key</button>
            </div>
          </div>

          <div className="demo-controls-panel__effects">
            <span>Effect receipts</span>
            <p aria-label="Effect receipts" data-empty={viewModel.effects.length === 0 || undefined}>
              {viewModel.effects.length > 0 ? viewModel.effects.join(' · ') : '暂无回执'}
            </p>
          </div>
        </div>
      </details>

      <details className="demo-controls-panel__details">
        <summary>运行详情</summary>
        <dl className="demo-controls-panel__runtime">
          <div><dt>Raw phase</dt><dd>{viewModel.rawPhase ?? '—'}</dd></div>
          <div><dt>任务 ID</dt><dd>{viewModel.taskId ?? '—'}</dd></div>
          <div><dt>任务版本</dt><dd>{viewModel.taskRevision === undefined ? '—' : `taskRevision ${viewModel.taskRevision}`}</dd></div>
          <div><dt>界面版本</dt><dd>{viewModel.uiRevision === undefined ? '—' : `uiRevision ${viewModel.uiRevision}`}</dd></div>
          <div><dt>信息密度</dt><dd>{viewModel.density ?? '—'}</dd></div>
          <div><dt>优先级</dt><dd>{viewModel.priority ?? '—'}</dd></div>
          <div><dt>规划来源</dt><dd>{viewModel.planningSourceExact ?? '—'}</dd></div>
        </dl>
      </details>

      <p className="demo-controls-panel__safety">{viewModel.safetyNote}</p>
    </section>
  )
}

export default DemoControlsPanel
