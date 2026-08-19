import type { VehicleContext } from '@canvasflow/schema'

export type CockpitStatusBarProps = {
  vehicle: VehicleContext
  phaseLabel?: string
  /** 小南当前语音状态：待命 / 聆听 / 处理中 / 播报中 */
  assistantStatus?: string
}

/**
 * Persistent top status rail, mounted in every cockpit phase. It carries only
 * the brand, the assistant's current voice state, the current task phase and a
 * compact battery readout; full clock/date/range belong to the living and
 * vehicle cards below so they are not repeated here.
 */
export function CockpitStatusBar({ vehicle, phaseLabel, assistantStatus = '待命' }: CockpitStatusBarProps) {
  return (
    <div className="cockpit-status-bar">
      <span className="cockpit-status-bar__brand">pilotflow</span>
      <span className="cockpit-status-bar__assistant" data-assistant-status>
        <i className="cockpit-status-bar__lamp" aria-hidden="true" />
        小南{assistantStatus}
      </span>
      <span className="cockpit-status-bar__phase" {...(phaseLabel ? { 'data-phase-identity': true } : {})}>{phaseLabel ?? '空闲'}</span>
      <dl className="cockpit-status-bar__facts">
        <div><dt>电量</dt><dd>{Math.round(vehicle.batteryPercent)}%</dd></div>
      </dl>
    </div>
  )
}
