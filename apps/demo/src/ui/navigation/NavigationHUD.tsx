import type { RuntimeFlight } from './contracts'
import { SPEED_TIERS, type NavigationSnapshot } from './simulator'

export function NavigationHUD({
  snapshot,
  flight,
  expanded,
  alert,
  speedTierLabel,
  onToggle,
}: {
  snapshot: NavigationSnapshot
  flight?: RuntimeFlight
  expanded: boolean
  alert?: string
  speedTierLabel?: string
  onToggle: () => void
}) {
  const arrival = flight?.estimatedArrival ? formatClock(new Date(flight.estimatedArrival).getTime()) : '—'
  const driveEta = snapshot.etaMs ? formatClock(snapshot.etaMs) : snapshot.runState === 'arrived' ? '已到达' : '—'
  const duration = snapshot.runState === 'driving' ? formatDuration(snapshot.remainingSeconds) : '0 分钟'
  const destinationAlert = snapshot.runState === 'arrived'
    ? snapshot.leg === 'return' ? '已到家' : '已到达机场，等待接人'
    : alert
  if (!expanded) {
    return (
      <section className="navigation-hud navigation-hud--minimum" aria-label="最小导航信息">
        <div><span>车速</span><strong>{Math.round(snapshot.speedKph)}</strong><small>km/h</small></div>
        <div><span>电量</span><strong>{Math.round(snapshot.batteryPercent)}</strong><small>%</small></div>
        {destinationAlert && <p role="status">{destinationAlert}</p>}
        <button type="button" onClick={onToggle}>显示导航信息</button>
      </section>
    )
  }
  return (
    <section className="navigation-hud" aria-label="导航信息">
      <header className="navigation-hud__header">
        <div>
          <span className="navigation-hud__eyebrow">{snapshot.leg === 'return' ? '返程导航' : '机场接人'}</span>
          <strong>{snapshot.destination}</strong>
        </div>
        <button type="button" onClick={onToggle}>隐藏导航信息</button>
      </header>
      {destinationAlert && <p className="navigation-hud__alert" role="status">{destinationAlert}</p>}
      <div className="navigation-hud__flight">
        <div><span>航班</span><strong>{flight?.flightNumber ?? '已选航班'}</strong></div>
        <div><span>航班预计到达</span><strong>{arrival}</strong></div>
        <div><span>驾车剩余</span><strong>{duration}</strong></div>
        <div><span>驾车 ETA</span><strong>{driveEta}</strong></div>
      </div>
      <div className="navigation-hud__metrics">
        <div><span>当前车速</span><strong>{Math.round(snapshot.speedKph)}</strong><small>km/h</small></div>
        <div><span>剩余距离</span><strong>{snapshot.remainingDistanceKm.toFixed(1)}</strong><small>km</small></div>
        <div><span>当前电量</span><strong>{Math.round(snapshot.batteryPercent)}</strong><small>%</small></div>
        <div><span>速度档位</span><strong>{speedTierLabel ?? SPEED_TIERS[snapshot.speedTier].label}</strong></div>
      </div>
      <div className="navigation-hud__maneuver">
        <span>当前道路 · {snapshot.road}</span>
        <strong>{snapshot.maneuver}</strong>
      </div>
    </section>
  )
}

function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp))
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(1, Math.ceil(seconds / 60))
  return `${rounded} 分钟`
}
