import { useEffect, useMemo, useState } from 'react'
import type { VehicleContext } from '@canvasflow/schema'
import { IdleVehicleVisual } from './IdleVehicleVisual'

const TIME_ZONE = 'Asia/Shanghai'

const schedule = [
  { time: '10:00', title: 'Her 开发日会' },
  { time: '14:00', title: '新建 Her' },
  { time: '16:30', title: 'A2A 调研' },
]

function timeText(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function dateText(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, month: 'long', day: 'numeric', weekday: 'short' }).format(date)
}

function minutesInShanghai(date: Date) {
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date)
    .filter((part) => part.type === 'hour' || part.type === 'minute')
    .map((part) => Number(part.value))
  return hour * 60 + minute
}

export function IdleHome({
  vehicle,
  voiceStatus,
  onWeather,
  onSchedule,
  onVehicleStatus,
  onSpeedDown,
  onSpeedUp,
}: {
  vehicle: VehicleContext
  voiceStatus: string
  onWeather: () => void
  onSchedule: () => void
  onVehicleStatus: () => void
  onSpeedDown: () => void
  onSpeedUp: () => void
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const scheduleState = useMemo(() => {
    const current = minutesInShanghai(now)
    return schedule.map((item) => {
      const [hour, minute] = item.time.split(':').map(Number)
      const start = hour * 60 + minute
      return { ...item, status: current >= start + 60 ? '已结束' : current >= start ? '进行中' : '即将开始' }
    })
  }, [now])

  return (
    <section className="idle-home" aria-label="空闲座舱首页">
      <IdleVehicleVisual />
      <aside className="idle-home__living" aria-label="生活信息">
        <section className="idle-home__clock" aria-label="当前时间">
          <time>{timeText(now)}</time>
          <p>{dateText(now)}</p>
        </section>
        <section className="idle-home__widget idle-home__weather" aria-label="模拟天气">
          <div><span className="idle-home__widget-label">人民广场 · 模拟天气</span><strong>多云</strong></div>
          <b>25°</b>
          <p>风力 2 级 · 降水 20%</p>
          <button type="button" onClick={onWeather}>查看天气</button>
        </section>
        <section className="idle-home__widget idle-home__schedule" aria-label="今日日程">
          <header><span>今日日程</span><button type="button" onClick={onSchedule}>查看日程</button></header>
          <ol>{scheduleState.map((item) => <li key={item.time}><time>{item.time}</time><span>{item.title}</span><em data-status={item.status}>{item.status}</em></li>)}</ol>
        </section>
        <p className="idle-home__location">模拟位置：人民广场 <span>模拟位置，非真实 GPS</span></p>
        <p className="idle-home__voice"><i aria-hidden="true" />小南 {voiceStatus || '待命中'}</p>
      </aside>
      <aside className="idle-home__capabilities" aria-label="座舱能力">
        <section className="idle-home__vehicle">
          <span>车辆状态</span><strong>{Math.round(vehicle.batteryPercent)}%</strong>
          <dl><div><dt>预计续航</dt><dd>{Math.round(vehicle.remainingRangeKm)} km</dd></div><div><dt>当前挡位</dt><dd>{vehicle.gear}</dd></div><div><dt>光线条件</dt><dd>{vehicle.isNight ? '夜间' : '白天'}</dd></div><div><dt>车辆状态</dt><dd>{vehicle.speedKph > 0 ? '行驶中' : '驻车'}</dd></div></dl>
          <button type="button" onClick={onVehicleStatus}>查看车辆状态</button>
        </section>
        <section className="idle-home__speed" aria-label="车速控制">
          <div><span>车速控制</span><strong>{Math.round(vehicle.speedKph)} km/h</strong></div>
          <p>{vehicle.speedKph > 0 ? '当前速度档位由导航控制' : '导航开始后可用'}</p>
          <div className="idle-home__speed-actions"><button type="button" disabled={vehicle.speedKph === 0} onClick={onSpeedDown}>调慢</button><button type="button" disabled={vehicle.speedKph === 0} onClick={onSpeedUp}>调快</button></div>
        </section>
      </aside>
    </section>
  )
}
