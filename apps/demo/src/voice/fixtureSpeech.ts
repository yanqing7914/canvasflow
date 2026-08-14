import type { SpeechRecognitionLike } from '@canvasflow/voice'
import transcripts from '../../../../fixtures/airport-pickup/voice/transcripts.json'
import checkWeatherWav from '../../../../fixtures/airport-pickup/voice/check-weather.wav?url'
import checkChargingWav from '../../../../fixtures/airport-pickup/voice/check-charging.wav?url'
import createAirportPickupWav from '../../../../fixtures/airport-pickup/voice/create-airport-pickup.wav?url'
import dismissWeatherAdvisoryWav from '../../../../fixtures/airport-pickup/voice/dismiss-weather-advisory.wav?url'
import flightNumberWav from '../../../../fixtures/airport-pickup/voice/flight-number.wav?url'
import noisyCreateWav from '../../../../fixtures/airport-pickup/voice/noisy-create.wav?url'
import selectFirstFlightWav from '../../../../fixtures/airport-pickup/voice/select-first-flight.wav?url'
import sendWeatherReminderWav from '../../../../fixtures/airport-pickup/voice/send-weather-reminder.wav?url'
import startNavigationWav from '../../../../fixtures/airport-pickup/voice/start-navigation.wav?url'
import chooseHongqiaoWav from '../../../../fixtures/airport-pickup/voice/choose-hongqiao.wav?url'
import selectThirdFlightWav from '../../../../fixtures/airport-pickup/voice/select-third-flight.wav?url'
import refreshFlightsWav from '../../../../fixtures/airport-pickup/voice/refresh-flights.wav?url'
import checkCalendarWav from '../../../../fixtures/airport-pickup/voice/check-calendar.wav?url'
import checkFlightDetailWav from '../../../../fixtures/airport-pickup/voice/check-flight-detail.wav?url'
import checkVehicleStatusWav from '../../../../fixtures/airport-pickup/voice/check-vehicle-status.wav?url'
import speedUpWav from '../../../../fixtures/airport-pickup/voice/speed-up.wav?url'
import speedDownWav from '../../../../fixtures/airport-pickup/voice/speed-down.wav?url'
import hideHudWav from '../../../../fixtures/airport-pickup/voice/hide-hud.wav?url'
import showHudWav from '../../../../fixtures/airport-pickup/voice/show-hud.wav?url'
import keepCalendarPlanWav from '../../../../fixtures/airport-pickup/voice/keep-calendar-plan.wav?url'
import passengersOnboardWav from '../../../../fixtures/airport-pickup/voice/passengers-onboard.wav?url'
import requestReturnWav from '../../../../fixtures/airport-pickup/voice/request-return.wav?url'
import startReturnWav from '../../../../fixtures/airport-pickup/voice/start-return.wav?url'
import resetTripWav from '../../../../fixtures/airport-pickup/voice/reset-trip.wav?url'
import confirmResetWav from '../../../../fixtures/airport-pickup/voice/confirm-reset.wav?url'
import cancelResetWav from '../../../../fixtures/airport-pickup/voice/cancel-reset.wav?url'
import savePreferencesWav from '../../../../fixtures/airport-pickup/voice/save-preferences.wav?url'
import rejectPreferencesWav from '../../../../fixtures/airport-pickup/voice/reject-preferences.wav?url'

/**
 * The offline voice fallback: each fixture sample pairs a pre-recorded WAV with
 * its canonical transcript from `transcripts.json`. The recording is what the
 * audience hears; the transcript is the payload the task actually receives, so
 * a broken speaker or a blocked autoplay never blocks the demo.
 */
export type VoiceFixtureSample = {
  id: string
  /** Canonical transcript delivered as the recognition result. */
  text: string
  /** Confidence recorded with the sample; travels with the submit meta. */
  confidence: number
  /** The sample must stop at the transcript-confirmation step. */
  requiresConfirmation: boolean
  /** Chinese label shown on the demo drawer's replay button. */
  label: string
  /** Human-readable precondition shown while a state-bound sample is disabled. */
  unavailableHint?: string
  audioUrl: string
}

/** The slice of `HTMLAudioElement` the fixture engine drives. */
export type FixtureAudioLike = {
  play: () => void | Promise<void>
  pause: () => void
  onended: (() => void) | null
  onerror: (() => void) | null
}

export type FixtureAudioFactory = (url: string) => FixtureAudioLike | null

const audioUrls: Record<string, string> = {
  'check-charging.wav': checkChargingWav,
  'check-weather.wav': checkWeatherWav,
  'create-airport-pickup.wav': createAirportPickupWav,
  'dismiss-weather-advisory.wav': dismissWeatherAdvisoryWav,
  'flight-number.wav': flightNumberWav,
  'noisy-create.wav': noisyCreateWav,
  'select-first-flight.wav': selectFirstFlightWav,
  'send-weather-reminder.wav': sendWeatherReminderWav,
  'start-navigation.wav': startNavigationWav,
  'choose-hongqiao.wav': chooseHongqiaoWav,
  'select-third-flight.wav': selectThirdFlightWav,
  'refresh-flights.wav': refreshFlightsWav,
  'check-calendar.wav': checkCalendarWav,
  'check-flight-detail.wav': checkFlightDetailWav,
  'check-vehicle-status.wav': checkVehicleStatusWav,
  'speed-up.wav': speedUpWav,
  'speed-down.wav': speedDownWav,
  'hide-hud.wav': hideHudWav,
  'show-hud.wav': showHudWav,
  'keep-calendar-plan.wav': keepCalendarPlanWav,
  'passengers-onboard.wav': passengersOnboardWav,
  'request-return.wav': requestReturnWav,
  'start-return.wav': startReturnWav,
  'reset-trip.wav': resetTripWav,
  'confirm-reset.wav': confirmResetWav,
  'cancel-reset.wav': cancelResetWav,
  'save-preferences.wav': savePreferencesWav,
  'reject-preferences.wav': rejectPreferencesWav,
}

const sampleLabels: Record<string, string> = {
  'create-airport-pickup': '模糊接机目标',
  'select-first-flight': '选择第一个航班',
  'select-third-flight': '选择第三个航班',
  'refresh-flights': '刷新航班',
  'choose-hongqiao': '选择虹桥机场',
  'flight-number': '补充航班号',
  'noisy-create': '嘈杂样本（需确认）',
  'check-weather': '查询天气',
  'check-charging': '查看充电',
  'check-calendar': '查看日程',
  'check-flight-detail': '查看航班详情',
  'check-vehicle-status': '查看车辆状态',
  'start-navigation': '开始导航',
  'speed-up': '调快速度',
  'speed-down': '调慢速度',
  'hide-hud': '隐藏导航信息',
  'show-hud': '显示导航信息',
  'send-weather-reminder': '提醒乘客带伞',
  'dismiss-weather-advisory': '暂不处理天气提醒',
  'keep-calendar-plan': '保持当前计划',
  'passengers-onboard': '确认家人上车',
  'request-return': '规划返程',
  'start-return': '开始返程',
  'reset-trip': '重新开始',
  'confirm-reset': '确认重新开始',
  'cancel-reset': '取消重新开始',
  'save-preferences': '保存本次偏好',
  'reject-preferences': '暂不保存',
}

const sampleUnavailableHints: Record<string, string> = {
  'create-airport-pickup': '仅在尚未创建任务时可用',
  'choose-hongqiao': '需先创建接机任务并等待确认机场',
  'select-first-flight': '需先显示到达航班选择窗口',
  'select-third-flight': '需先显示至少三个到达航班',
  'refresh-flights': '需先显示到达航班选择窗口',
  'flight-number': '仅旧版缺少航班号的任务可用',
  'noisy-create': '仅在尚未创建任务时可用',
  'check-weather': '需先创建任务；途中会按模拟位置查询',
  'check-charging': '需先创建任务并生成接机路线；途中会按模拟位置重新规划',
  'check-calendar': '需先创建任务',
  'check-flight-detail': '需先选择航班',
  'check-vehicle-status': '需先创建任务',
  'start-navigation': '需先显示出发确认窗口',
  'speed-up': '需先进入去程或返程导航',
  'speed-down': '需先进入去程或返程导航',
  'hide-hud': '需先进入导航且导航信息可见',
  'show-hud': '需先进入导航且导航信息已隐藏',
  'send-weather-reminder': '需先触发途中小雨提醒',
  'dismiss-weather-advisory': '需先触发天气提醒',
  'keep-calendar-plan': '需先触发日历冲突提醒',
  'passengers-onboard': '需先到达机场并等待家人',
  'request-return': '需先确认家人已经上车',
  'start-return': '需先显示返程确认窗口',
  'reset-trip': '需先存在进行中的任务',
  'confirm-reset': '需先说“重新开始”并等待确认',
  'cancel-reset': '需先说“重新开始”并等待确认',
  'save-preferences': '需先到家并出现偏好确认',
  'reject-preferences': '需先到家并出现偏好确认',
}

export const voiceFixtureSamples: VoiceFixtureSample[] = transcripts.samples.map((sample) => ({
  id: sample.id,
  text: sample.text,
  confidence: sample.confidence,
  requiresConfirmation: sample.requiresConfirmation,
  label: sampleLabels[sample.id] ?? sample.id,
  unavailableHint: sampleUnavailableHints[sample.id],
  audioUrl: audioUrls[sample.file] ?? '',
}))

function defaultAudioFactory(url: string): FixtureAudioLike | null {
  if (typeof Audio === 'undefined' || !url) return null
  const element = new Audio(url)
  const adapter: FixtureAudioLike = {
    play: () => element.play(),
    pause: () => element.pause(),
    onended: null,
    onerror: null,
  }
  element.onended = () => adapter.onended?.()
  element.onerror = () => adapter.onerror?.()
  return adapter
}

/**
 * A recognition engine backed by one fixture sample instead of a microphone.
 *
 * It honours the `SpeechRecognitionLike` surface, so the existing controller,
 * machine and composer run unchanged: the transcript arrives first as an
 * interim result (a second press keeps it, same as a live turn), and the final
 * result carries the sample's recorded confidence.
 *
 * Playback is presentation only. When the audio cannot start or errors, the
 * transcript is still delivered — the fallback's one job is that the words
 * reach the task deterministically.
 */
export function createFixtureRecognition(
  sample: VoiceFixtureSample,
  createAudio: FixtureAudioFactory = defaultAudioFactory,
): SpeechRecognitionLike {
  let audio: FixtureAudioLike | null = null
  let settled = false

  const engine: SpeechRecognitionLike = {
    lang: 'zh-CN',
    continuous: false,
    interimResults: true,
    onresult: null,
    onerror: null,
    onend: null,
    onstart: null,

    start() {
      const finish = () => {
        if (settled) return
        settled = true
        engine.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: { isFinal: true, length: 1, 0: { transcript: sample.text, confidence: sample.confidence } },
          },
        })
        engine.onend?.()
      }

      // Deliver the words as an interim result up front, mirroring a live
      // engine: the status line shows them while the audio plays, and stopping
      // the turn early still keeps them.
      queueMicrotask(() => {
        if (settled) return
        engine.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: { isFinal: false, length: 1, 0: { transcript: sample.text } },
          },
        })
      })

      try {
        audio = createAudio(sample.audioUrl)
      } catch {
        audio = null
      }
      if (!audio) {
        queueMicrotask(finish)
        return
      }
      audio.onended = finish
      audio.onerror = finish
      try {
        const played = audio.play()
        if (played && typeof played.then === 'function') void played.then(undefined, finish)
      } catch {
        finish()
      }
    },

    stop() {
      settled = true
      try {
        audio?.pause()
      } catch {
        // The element may already be gone; nothing left to silence.
      }
    },

    abort() {
      engine.stop()
    },
  }

  return engine
}

/**
 * Plays a sample's recording without a recognition turn — the degraded path for
 * a browser with no speech engine at all, where the transcript is parked in the
 * text field instead. Failure to play is deliberately silent: the transcript is
 * already on screen.
 */
export function playFixtureSampleAudio(
  sample: VoiceFixtureSample,
  createAudio: FixtureAudioFactory = defaultAudioFactory,
  onSettled?: () => void,
): FixtureAudioLike | null {
  let audio: FixtureAudioLike | null = null
  try {
    audio = createAudio(sample.audioUrl)
  } catch {
    onSettled?.()
    return null
  }
  if (!audio) {
    onSettled?.()
    return null
  }
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    onSettled?.()
  }
  // Attach lifecycle callbacks before starting playback so an immediate
  // playback rejection or a very short fixture cannot race the dispatcher.
  audio.onended = settle
  audio.onerror = settle
  try {
    const played = audio.play()
    if (played && typeof played.then === 'function') void played.then(undefined, settle)
  } catch {
    settle()
  }
  return audio
}
