/**
 * Voice layer contracts. The state union is fixed by the product spec — the
 * machine, the speech controller, and the UI all agree on these six names.
 */
export type VoiceState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'submitting'
  | 'speaking'
  | 'error'

export type VoiceErrorKind =
  | 'unsupported'
  | 'insecure-context'
  | 'permission'
  | 'no-speech'
  | 'recognition'
  | 'timeout'
  | 'speak'

export type VoiceError = {
  kind: VoiceErrorKind
  /** Human-facing copy — the UI renders this verbatim. */
  message: string
  /** Whether the user should be nudged toward the text input instead. */
  suggestTextFallback: boolean
  /** Whether pressing the microphone again is worth trying. */
  retryable: boolean
}

/**
 * One table so error copy never drifts between the machine and the UI.
 * `suggestTextFallback` is true for everything: a voice failure must never
 * leave the user without a way to continue.
 */
const VOICE_ERRORS: Record<VoiceErrorKind, Omit<VoiceError, 'kind'>> = {
  unsupported: {
    message: '当前浏览器不支持语音识别，请改用文字输入。',
    suggestTextFallback: true,
    retryable: false,
  },
  'insecure-context': {
    message: '语音识别需要 HTTPS 或本地环境，请改用文字输入。',
    suggestTextFallback: true,
    retryable: false,
  },
  permission: {
    message: '麦克风权限未开启，请在浏览器设置中允许后重试，或改用文字输入。',
    suggestTextFallback: true,
    retryable: true,
  },
  'no-speech': {
    message: '没有听到内容，可以再说一次或改用文字输入。',
    suggestTextFallback: true,
    retryable: true,
  },
  recognition: {
    message: '语音识别出错了，可以再试一次或改用文字输入。',
    suggestTextFallback: true,
    retryable: true,
  },
  timeout: {
    message: '语音输入超时，可以再试一次或改用文字输入。',
    suggestTextFallback: true,
    retryable: true,
  },
  speak: {
    message: '语音播报失败，内容仍在屏幕上显示。',
    suggestTextFallback: true,
    retryable: true,
  },
}

export function voiceError(kind: VoiceErrorKind): VoiceError {
  return { kind, ...VOICE_ERRORS[kind] }
}

export type VoiceRecognitionSource = 'microphone' | 'fixture' | 'system-tts'

/** Metadata that accompanies every transcript emitted by the voice package. */
export type VoiceSubmitMeta = {
  source: 'voice'
  confidence?: number
  /** Optional trusted provenance for callers that can distinguish their ASR input. */
  recognitionSource?: VoiceRecognitionSource
}

/** What the machine asks the outside world to do. All optional for tests. */
export type VoiceEffects = {
  onState?: (state: VoiceState, previous: VoiceState) => void
  openAsr?: () => void
  closeAsr?: () => void
  /** Submit a confirmed transcript. The machine never inspects the text. */
  submit?: (text: string, meta: VoiceSubmitMeta) => void
  speak?: (text: string) => boolean | void
  stopSpeak?: () => void
  onError?: (error: VoiceError) => void
}

export type VoiceTimerHandle = unknown

export type VoiceMachineConfig = {
  /** Silence window before an empty turn fails or captured speech auto-submits. */
  silenceMs?: number
  /**
   * Compatibility alias for `silenceMs`. It is ignored when `silenceMs` is set;
   * the machine never creates a second listening timer.
   */
  listenMaxMs?: number
  /** Set false to retain the legacy edit-and-confirm transcript step. */
  autoSubmit?: boolean
  /** Hard ceiling on a submit round trip. */
  submitMaxMs?: number
}
