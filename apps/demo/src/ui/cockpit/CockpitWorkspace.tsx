import type { ReactNode } from 'react'
import type { CockpitViewMode } from './selectors'

export type CockpitWorkspaceSlots = {
  map?: ReactNode
  status?: ReactNode
  feedback?: ReactNode
  primary?: ReactNode
  hud?: ReactNode
  auxiliary?: ReactNode
  entry?: ReactNode
}

export type CockpitWorkspaceProps = CockpitWorkspaceSlots & {
  mode?: CockpitViewMode
  phase?: string
  className?: string
}

/**
 * Stable seat for every cockpit state. Consumers update slot contents while
 * this outer DOM remains mounted, which lets map implementations preserve
 * their imperative instance across task and UISpec revisions.
 */
export function CockpitWorkspace({
  map,
  status,
  feedback,
  primary,
  hud,
  auxiliary,
  entry,
  mode = 'idle',
  phase,
  className,
}: CockpitWorkspaceProps) {
  const classes = ['cockpit-workspace', className].filter(Boolean).join(' ')
  return (
    <section
      className={classes}
      data-testid="cockpit-workspace"
      data-cockpit-workspace
      data-cockpit-mode={mode}
      {...(phase ? { 'data-cockpit-phase': phase } : {})}
      aria-label="座舱工作区"
    >
      <section className="cockpit-workspace__map" data-cockpit-slot="map" aria-label="座舱地图">
        {map}
      </section>
      <section className="cockpit-workspace__status" data-cockpit-slot="status" aria-label="座舱状态">
        {status}
      </section>
      <section className="cockpit-workspace__feedback" data-cockpit-slot="feedback" aria-label="Agent反馈">
        {feedback}
      </section>
      <section className="cockpit-workspace__primary" data-cockpit-slot="primary" aria-label="主任务窗口">
        {primary}
      </section>
      <section className="cockpit-workspace__hud" data-cockpit-slot="hud" aria-label="导航 HUD 层">
        {hud}
      </section>
      <section className="cockpit-workspace__auxiliary" data-cockpit-slot="auxiliary" aria-label="辅助信息窗口">
        {auxiliary}
      </section>
      <section className="cockpit-workspace__entry" data-cockpit-slot="entry" aria-label="文字和语音入口">
        {entry}
      </section>
    </section>
  )
}

export default CockpitWorkspace
