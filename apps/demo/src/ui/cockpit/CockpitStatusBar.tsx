import { useEffect, useState } from 'react'
import type { VehicleContext } from '@canvasflow/schema'

export type CockpitStatusBarProps = {
  vehicle: VehicleContext
  phaseLabel?: string
  now?: () => Date
}

function displayDate(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(value)
}

function displayTime(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}

/** Quiet, persistent vehicle facts; task changes do not replace this layer. */
export function CockpitStatusBar({ vehicle, phaseLabel, now = () => new Date() }: CockpitStatusBarProps) {
  const [current, setCurrent] = useState(now)

  useEffect(() => {
    const timer = window.setInterval(() => setCurrent(now()), 30_000)
    return () => window.clearInterval(timer)
  }, [now])

  return (
    <div className="cockpit-status-bar">
      <span className="cockpit-status-bar__brand">pilotflow</span>
      <span className="cockpit-status-bar__phase" {...(phaseLabel ? { 'data-phase-identity': true } : {})}>{phaseLabel ?? '小南待命'}</span>
      <dl className="cockpit-status-bar__facts">
        <div><dt>时间</dt><dd>{displayTime(current)}</dd></div>
        <div><dt>日期</dt><dd>{displayDate(current)}</dd></div>
        <div><dt>电量</dt><dd>{Math.round(vehicle.batteryPercent)}%</dd></div>
        <div><dt>续航</dt><dd>{Math.round(vehicle.remainingRangeKm)} km</dd></div>
      </dl>
    </div>
  )
}
