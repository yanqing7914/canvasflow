import { describe, expect, it, vi } from 'vitest'
import {
  createNavigationSpeechCoordinator,
  type NavigationSystemUtterance,
  type NavigationVoiceCommand,
} from './command-queue'

type Intent = 'speed-up' | 'slow-down' | 'weather' | 'calendar'
type Command = NavigationVoiceCommand<Intent>

function command(
  intent: Intent,
  transcript: string = intent,
  recognitionSource: Command['meta']['recognitionSource'] = 'microphone',
): Command {
  return { intent, transcript, meta: { source: 'voice', recognitionSource } }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function harness(overrides: Partial<Parameters<typeof createNavigationSpeechCoordinator<Command>>[0]> = {}) {
  const spoken: NavigationSystemUtterance[] = []
  const executed: Command[] = []
  const coordinator = createNavigationSpeechCoordinator<Command>({
    speak: (utterance) => { spoken.push(utterance) },
    executeCommand: (entry) => { executed.push(entry) },
    ...overrides,
  })
  return { coordinator, spoken, executed }
}

describe('navigation speech coordinator', () => {
  it('does not interrupt a system utterance and runs commands FIFO afterward', async () => {
    const h = harness()
    h.coordinator.enqueueSystemUtterance({ id: 'turn-1', text: '前方三百米右转' })
    h.coordinator.enqueueCommand(command('speed-up', '跑快点'))
    h.coordinator.enqueueCommand(command('weather', '查天气'))

    expect(h.spoken.map(({ id }) => id)).toEqual(['turn-1'])
    expect(h.executed).toEqual([])
    expect(h.coordinator.snapshot().asrAllowed).toBe(true)

    h.coordinator.utteranceEnd()
    await settle()

    expect(h.executed.map(({ intent }) => intent)).toEqual(['speed-up', 'weather'])
  })

  it('coalesces the same intent once during one utterance', async () => {
    const h = harness()
    h.coordinator.enqueueSystemUtterance('前方三百米右转')

    expect(h.coordinator.enqueueCommand(command('speed-up', '跑快点'))).toBe('accepted')
    expect(h.coordinator.enqueueCommand(command('speed-up', '快一点'))).toBe('coalesced')
    h.coordinator.utteranceEnd()
    await settle()

    expect(h.executed.map(({ intent }) => intent)).toEqual(['speed-up'])
  })

  it('preserves different intents and prioritizes queued system speech', async () => {
    const h = harness()
    h.coordinator.enqueueSystemUtterance({ id: 'turn-1', text: '前方右转' })
    h.coordinator.enqueueCommand(command('speed-up'))
    h.coordinator.enqueueCommand(command('weather'))
    h.coordinator.enqueueSystemUtterance({ id: 'turn-2', text: '即将进入高架' })

    h.coordinator.utteranceEnd()
    expect(h.spoken.map(({ id }) => id)).toEqual(['turn-1', 'turn-2'])
    expect(h.executed).toEqual([])

    h.coordinator.utteranceEnd()
    await settle()
    expect(h.executed.map(({ intent }) => intent)).toEqual(['speed-up', 'weather'])
  })

  it('filters trusted TTS recognition without dropping a matching microphone utterance', async () => {
    const h = harness()
    h.coordinator.enqueueSystemUtterance('查天气')

    expect(h.coordinator.enqueueCommand(command('weather', '查天气', 'system-tts'))).toBe('filtered')
    expect(h.coordinator.enqueueCommand(command('weather', '查天气', 'microphone'))).toBe('accepted')
    h.coordinator.utteranceEnd()
    await settle()

    expect(h.executed).toHaveLength(1)
    expect(h.executed[0]?.meta.recognitionSource).toBe('microphone')
  })

  it('exposes known prompt text to an injectable self-recognition filter', () => {
    const filterRecognition = vi.fn((entry: Command, context) => (
      !context.isKnownSystemText(entry.transcript)
    ))
    const h = harness({ filterRecognition })
    h.coordinator.enqueueSystemUtterance('前方三百米右转')

    expect(h.coordinator.enqueueCommand(command('weather', '前方三百米右转'))).toBe('filtered')
    expect(filterRecognition).toHaveBeenCalledOnce()
    expect(h.coordinator.isKnownSystemText(' 前方三百米右转 ')).toBe(true)
  })

  it('continues draining commands after a TTS failure', async () => {
    const onSpeakError = vi.fn()
    const h = harness({ onSpeakError })
    h.coordinator.enqueueSystemUtterance('前方右转')
    h.coordinator.enqueueCommand(command('slow-down'))

    h.coordinator.utteranceError(new Error('speaker unavailable'))
    await settle()

    expect(onSpeakError).toHaveBeenCalledOnce()
    expect(h.executed.map(({ intent }) => intent)).toEqual(['slow-down'])
  })

  it('treats an unavailable synchronous TTS start as non-blocking', async () => {
    const onSpeakError = vi.fn()
    const h = harness({ speak: () => false, onSpeakError })
    h.coordinator.enqueueSystemUtterance('前方右转')
    h.coordinator.enqueueCommand(command('calendar'))
    await settle()

    expect(onSpeakError).toHaveBeenCalledOnce()
    expect(h.executed.map(({ intent }) => intent)).toEqual(['calendar'])
  })

  it('clears playback, queued commands, known text, and stale async completions at task end', async () => {
    let resolveCommand: (() => void) | undefined
    const stopSpeaking = vi.fn()
    const executed: Command[] = []
    const coordinator = createNavigationSpeechCoordinator<Command>({
      speak: () => undefined,
      stopSpeaking,
      executeCommand: (entry) => {
        executed.push(entry)
        return new Promise<void>((resolve) => { resolveCommand = resolve })
      },
    })

    coordinator.enqueueCommand(command('weather'))
    coordinator.enqueueSystemUtterance('前方右转')
    coordinator.enqueueCommand(command('speed-up'))
    coordinator.clear()

    expect(coordinator.snapshot()).toEqual({
      pendingUtterances: [],
      pendingCommands: [],
      asrAllowed: true,
    })
    expect(coordinator.isKnownSystemText('前方右转')).toBe(false)
    expect(stopSpeaking).not.toHaveBeenCalled()

    resolveCommand?.()
    await settle()
    expect(executed.map(({ intent }) => intent)).toEqual(['weather'])
  })

  it('stops an active utterance when task cleanup runs', () => {
    const stopSpeaking = vi.fn()
    const h = harness({ stopSpeaking })
    h.coordinator.enqueueSystemUtterance('前方右转')
    h.coordinator.enqueueCommand(command('weather'))

    h.coordinator.clear()

    expect(stopSpeaking).toHaveBeenCalledOnce()
    expect(h.coordinator.snapshot().pendingCommands).toEqual([])
  })
})
