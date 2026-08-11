import { normalizeTranscript } from './transcript'
import type { VoiceSubmitMeta } from './types'

export type NavigationVoiceCommand<TIntent extends string = string, TPayload = unknown> = {
  /** Intent classification happens outside the voice package. */
  intent: TIntent
  transcript: string
  meta: VoiceSubmitMeta
  payload?: TPayload
}

export type NavigationSystemUtterance = {
  id: string
  text: string
}

export type NavigationSpeechFilterContext = {
  activeUtterance?: NavigationSystemUtterance
  knownSystemTexts: readonly string[]
  isKnownSystemText: (text: string) => boolean
}

export type NavigationSpeechCoordinatorSnapshot<TCommand> = {
  activeUtterance?: NavigationSystemUtterance
  pendingUtterances: readonly NavigationSystemUtterance[]
  pendingCommands: readonly TCommand[]
  executingCommand?: TCommand
  /** ASR is independent from playback and remains available by contract. */
  asrAllowed: true
}

export type NavigationSpeechCoordinatorDeps<
  TCommand extends NavigationVoiceCommand = NavigationVoiceCommand,
> = {
  speak: (utterance: NavigationSystemUtterance) => boolean | void
  stopSpeaking?: () => void
  executeCommand: (command: TCommand) => void | Promise<void>
  commandKey?: (command: TCommand) => string
  /** Return false to reject a recognition result before it reaches the queue. */
  filterRecognition?: (
    command: TCommand,
    context: NavigationSpeechFilterContext,
  ) => boolean
  onSpeakError?: (utterance: NavigationSystemUtterance, error?: unknown) => void
  onCommandError?: (command: TCommand, error: unknown) => void
  onChange?: (snapshot: NavigationSpeechCoordinatorSnapshot<TCommand>) => void
}

export type CommandEnqueueResult = 'accepted' | 'coalesced' | 'filtered' | 'disposed'

type QueuedCommand<TCommand> = {
  command: TCommand
  utteranceScope?: number
}

/**
 * Coordinates navigation prompts and voice commands without coupling ASR to
 * TTS. System utterances take the next dispatch slot and are never interrupted;
 * commands heard during an utterance wait in FIFO order. Intent de-duplication
 * is scoped to the utterance that was playing when the command was heard.
 */
export function createNavigationSpeechCoordinator<
  TCommand extends NavigationVoiceCommand = NavigationVoiceCommand,
>(deps: NavigationSpeechCoordinatorDeps<TCommand>) {
  const commandKey = deps.commandKey ?? ((command: TCommand) => command.intent)
  const utteranceQueue: NavigationSystemUtterance[] = []
  const commandQueue: QueuedCommand<TCommand>[] = []
  const intentKeysByScope = new Map<number, Set<string>>()
  const knownSystemTexts = new Set<string>()

  let activeUtterance: (NavigationSystemUtterance & { scope: number }) | undefined
  let executing: QueuedCommand<TCommand> | undefined
  let utteranceSequence = 0
  let generation = 0
  let disposed = false

  function isKnownSystemText(text: string) {
    return knownSystemTexts.has(normalizeTranscript(text))
  }

  function snapshot(): NavigationSpeechCoordinatorSnapshot<TCommand> {
    return {
      ...(activeUtterance
        ? { activeUtterance: { id: activeUtterance.id, text: activeUtterance.text } }
        : {}),
      pendingUtterances: utteranceQueue.map((utterance) => ({ ...utterance })),
      pendingCommands: commandQueue.map(({ command }) => command),
      ...(executing ? { executingCommand: executing.command } : {}),
      asrAllowed: true,
    }
  }

  function notify() {
    deps.onChange?.(snapshot())
  }

  function cleanupScope(scope: number | undefined) {
    if (scope === undefined) return
    if (activeUtterance?.scope === scope) return
    if (executing?.utteranceScope === scope) return
    if (commandQueue.some((entry) => entry.utteranceScope === scope)) return
    intentKeysByScope.delete(scope)
  }

  function completeCommand(entry: QueuedCommand<TCommand>, turn: number, error?: unknown) {
    if (disposed || turn !== generation || executing !== entry) return
    executing = undefined
    if (error !== undefined) deps.onCommandError?.(entry.command, error)
    cleanupScope(entry.utteranceScope)
    notify()
    drain()
  }

  function startCommand(entry: QueuedCommand<TCommand>) {
    executing = entry
    const turn = generation
    notify()
    try {
      const result = deps.executeCommand(entry.command)
      void Promise.resolve(result).then(
        () => completeCommand(entry, turn),
        (error: unknown) => completeCommand(entry, turn, error),
      )
    } catch (error) {
      completeCommand(entry, turn, error)
    }
  }

  function finishUtterance(error?: unknown) {
    const finished = activeUtterance
    if (!finished) return
    activeUtterance = undefined
    if (error !== undefined) {
      deps.onSpeakError?.({ id: finished.id, text: finished.text }, error)
    }
    cleanupScope(finished.scope)
    notify()
    drain()
  }

  function startUtterance(utterance: NavigationSystemUtterance) {
    activeUtterance = { ...utterance, scope: ++utteranceSequence }
    notify()
    try {
      if (deps.speak(utterance) === false) {
        finishUtterance(new Error('speech synthesis unavailable'))
      }
    } catch (error) {
      finishUtterance(error)
    }
  }

  function drain() {
    if (disposed || activeUtterance || executing) return
    const utterance = utteranceQueue.shift()
    if (utterance) {
      startUtterance(utterance)
      return
    }
    const command = commandQueue.shift()
    if (command) startCommand(command)
  }

  function clearInternal(stopActive: boolean) {
    generation += 1
    utteranceQueue.length = 0
    commandQueue.length = 0
    executing = undefined
    intentKeysByScope.clear()
    knownSystemTexts.clear()
    if (activeUtterance && stopActive) {
      try {
        deps.stopSpeaking?.()
      } catch {
        // Task cleanup is complete even if the browser cannot cancel playback.
      }
    }
    activeUtterance = undefined
    notify()
  }

  return {
    snapshot,

    enqueueSystemUtterance(input: string | { id?: string; text: string }): string | undefined {
      if (disposed) return undefined
      const text = normalizeTranscript(typeof input === 'string' ? input : input.text)
      if (!text) return undefined
      const id = typeof input === 'string' || !input.id
        ? `system-${utteranceSequence + utteranceQueue.length + 1}`
        : input.id
      utteranceQueue.push({ id, text })
      knownSystemTexts.add(text)
      notify()
      drain()
      return id
    },

    enqueueCommand(command: TCommand): CommandEnqueueResult {
      if (disposed) return 'disposed'
      // A trusted source marker is stronger than text matching and cannot drop
      // a real microphone utterance that happens to repeat the prompt.
      if (command.meta.recognitionSource === 'system-tts') return 'filtered'

      const context: NavigationSpeechFilterContext = {
        ...(activeUtterance
          ? { activeUtterance: { id: activeUtterance.id, text: activeUtterance.text } }
          : {}),
        knownSystemTexts: [...knownSystemTexts],
        isKnownSystemText,
      }
      if (deps.filterRecognition && !deps.filterRecognition(command, context)) return 'filtered'

      const utteranceScope = activeUtterance?.scope
      if (utteranceScope !== undefined) {
        const key = commandKey(command)
        const seen = intentKeysByScope.get(utteranceScope) ?? new Set<string>()
        if (seen.has(key)) return 'coalesced'
        seen.add(key)
        intentKeysByScope.set(utteranceScope, seen)
      }

      commandQueue.push({ command, ...(utteranceScope !== undefined ? { utteranceScope } : {}) })
      notify()
      drain()
      return 'accepted'
    },

    /** Browser callback for a naturally completed system utterance. */
    utteranceEnd() {
      finishUtterance()
    },

    /** Browser callback for a failed utterance; queued work still drains. */
    utteranceError(error: unknown = new Error('speech synthesis failed')) {
      finishUtterance(error)
    },

    isKnownSystemText,

    /** Task-end cleanup: stop playback and discard all queued voice work. */
    clear() {
      if (disposed) return
      clearInternal(true)
    },

    dispose() {
      if (disposed) return
      clearInternal(true)
      disposed = true
    },
  }
}

export type NavigationSpeechCoordinator<
  TCommand extends NavigationVoiceCommand = NavigationVoiceCommand,
> = ReturnType<typeof createNavigationSpeechCoordinator<TCommand>>
