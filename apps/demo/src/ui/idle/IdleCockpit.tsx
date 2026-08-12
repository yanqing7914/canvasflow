import { useEffect, useState } from 'react'
import type { VehicleContext } from '@canvasflow/schema'
import { IdleMap } from './IdleMap'
import { ControlsIcon, KeyboardIcon, MicIcon } from '../icons'

export type IdleVoiceMode = 'unavailable' | 'needs-authorization' | 'authorizing' | 'waiting-wake' | 'follow-up' | 'reset-confirmation'

const cockpitTimeZone = 'Asia/Shanghai'

export function IdleCockpit({
  vehicle,
  voiceMode,
  voiceStatus,
  voiceRetryable = false,
  onMicrophone,
  onKeyboard,
  onControls,
  mapRetryNonce,
  onMapRuntimeFailure,
}: {
  vehicle: VehicleContext
  voiceMode: IdleVoiceMode
  voiceStatus: string
  voiceRetryable?: boolean
  onMicrophone: () => void
  onKeyboard: () => void
  onControls: () => void
  mapRetryNonce?: number
  onMapRuntimeFailure?: () => void
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: cockpitTimeZone,
  })
  const date = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone: cockpitTimeZone,
  }).format(now)
  const lampLabel = voiceMode === 'waiting-wake' ? '等待唤醒'
    : voiceMode === 'follow-up' ? '正在聆听'
      : voiceMode === 'reset-confirmation' ? '等待确认'
        : voiceMode === 'needs-authorization' ? '点击启用'
          : voiceMode === 'authorizing' ? '正在授权'
          : voiceMode === 'unavailable' ? '语音不可用'
            : '等待唤醒'

  return (
    <section
      className="idle-cockpit"
      aria-label="空闲座舱"
      data-light-condition={vehicle.isNight ? 'night' : 'day'}
    >
      <IdleMap retryNonce={mapRetryNonce} onRuntimeFailure={onMapRuntimeFailure} />
      <header className="idle-cockpit__brand"><strong>pilotflow</strong><span>小南座舱</span></header>
      <dl className="idle-cockpit__facts" aria-label="空闲座舱状态">
        <div><dt>当前时间</dt><dd>{formatter.format(now)}</dd></div>
        <div><dt>当前日期</dt><dd>{date}</dd></div>
        <div><dt>车辆电量</dt><dd>{Math.round(vehicle.batteryPercent)}%</dd></div>
        <div><dt>预计续航</dt><dd>{Math.round(vehicle.remainingRangeKm)} km</dd></div>
        <div className="idle-cockpit__voice"><dt>小南</dt><dd><span className={`wake-lamp wake-lamp--${voiceMode}`} aria-hidden="true" />{lampLabel}</dd></div>
      </dl>
      <div className="idle-cockpit__actions">
        <button
          type="button"
          className="idle-mic"
          aria-label={voiceRetryable
            ? '重试语音唤醒'
            : voiceMode === 'needs-authorization' ? '启用小南语音唤醒' : '小南语音状态'}
          onClick={onMicrophone}
        >
          <MicIcon size={24} /><span>{voiceRetryable ? '重试语音' : lampLabel}</span>
        </button>
        <button type="button" aria-label="改用文字输入" onClick={onKeyboard}><KeyboardIcon size={22} /><span>文字</span></button>
        <button type="button" aria-label="打开演示控制" onClick={onControls}><ControlsIcon size={22} /><span>演示控制</span></button>
      </div>
      <p className="idle-cockpit__voice-status" role="status" aria-live="polite">{voiceStatus}</p>
    </section>
  )
}
