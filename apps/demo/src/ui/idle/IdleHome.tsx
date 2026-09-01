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
  onWeather,
  onSchedule,
  onVehicleStatus,
}: {
  vehicle: VehicleContext
  onWeather: () => void
  onSchedule: () => void
  onVehicleStatus: () => void
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
    <section className="idle-home" aria-label="空闲座舱">
      <div
        className="idle-home__environment"
        data-testid="idle-natural-environment"
        data-environment="grass-parking-trees"
        aria-hidden="true"
      >
        <span className="idle-home__environment-sky" />
        <span className="idle-home__environment-trees" />
        <span className="idle-home__environment-grass" />
        <span className="idle-home__environment-parking" />
      </div>
      <IdleVehicleVisual />
      <aside className="idle-home__living" aria-label="生活信息">
        <section className="idle-home__clock" aria-label="当前时间">
          <span className="idle-home__eyebrow">上海座舱</span>
          <time dateTime={now.toISOString()}>{timeText(now)}</time>
          <p>{dateText(now)}</p>
        </section>
        <section className="idle-home__widget idle-home__weather" aria-label="模拟天气">
          <header>
            <span className="idle-home__widget-label">人民广场</span>
            <button type="button" onClick={onWeather}>查看天气</button>
          </header>
          <div className="idle-home__weather-main"><strong>多云</strong><b>25°</b></div>
          <p>风力 2 级，降水 20%</p>
        </section>
        <section className="idle-home__widget idle-home__schedule" aria-label="今日日程">
          <header><span>今日日程</span><button type="button" onClick={onSchedule}>查看日程</button></header>
          <ol>{scheduleState.map((item) => <li key={item.time}><time dateTime={`${now.toISOString().slice(0, 10)}T${item.time}:00+08:00`}>{item.time}</time><span>{item.title}</span><em data-status={item.status}>{item.status}</em></li>)}</ol>
        </section>
        <p className="idle-home__location">模拟位置：人民广场 · 非真实 GPS</p>
      </aside>
      <aside className="idle-home__capabilities" aria-label="座舱能力">
        <section className="idle-home__vehicle">
          <header><span>车辆状态</span><button type="button" onClick={onVehicleStatus}>查看车辆状态</button></header>
          <div className="idle-home__vehicle-hero"><strong>{Math.round(vehicle.batteryPercent)}%</strong><span>当前电量</span></div>
          <dl><div><dt>预计续航</dt><dd>{Math.round(vehicle.remainingRangeKm)} km</dd></div><div><dt>当前挡位</dt><dd>{vehicle.gear}</dd></div><div><dt>车辆状态</dt><dd>{vehicle.speedKph > 0 ? '行驶中' : '驻车'}</dd></div><div><dt>当前车速</dt><dd>{Math.round(vehicle.speedKph)} km/h</dd></div></dl>
          <p className="idle-home__vehicle-note">{vehicle.isNight ? '夜间座舱' : '日间座舱'}，{vehicle.speedKph > 0 ? '导航控制中' : '车辆已准备好'}</p>
        </section>
      </aside>
    </section>
  )
}
