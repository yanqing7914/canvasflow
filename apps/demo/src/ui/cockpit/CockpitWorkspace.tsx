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
  const renderSlot = (slot: ReactNode, slotClass: string, label: string) => (
    <div className={slotClass} data-cockpit-slot={slotClass.replace('cockpit-workspace__', '')}>
      {slot !== undefined && slot !== null && slot !== false ? <section aria-label={label}>{slot}</section> : null}
    </div>
  )
  return (
    <section
      className={classes}
      data-testid="cockpit-workspace"
      data-cockpit-workspace
      data-cockpit-mode={mode}
      {...(phase ? { 'data-cockpit-phase': phase } : {})}
      aria-label="座舱工作区"
    >
      {renderSlot(map, 'cockpit-workspace__map', '座舱地图')}
      {renderSlot(status, 'cockpit-workspace__status', '座舱状态')}
      {renderSlot(feedback, 'cockpit-workspace__feedback', 'Agent反馈')}
      {renderSlot(primary, 'cockpit-workspace__primary', '主任务窗口')}
      {renderSlot(hud, 'cockpit-workspace__hud', '导航层')}
      {renderSlot(auxiliary, 'cockpit-workspace__auxiliary', '辅助信息窗口')}
      {renderSlot(entry, 'cockpit-workspace__entry', '文字和语音入口')}
    </section>
  )
}

export default CockpitWorkspace
