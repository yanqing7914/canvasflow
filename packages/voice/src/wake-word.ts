import { normalizeTranscript } from './transcript'

export const WAKE_WORD = '小南'
export const WAKE_WORD_ALIASES = ['小南', '小楠', '晓南', '小蓝'] as const
export type WakeWordAlias = (typeof WAKE_WORD_ALIASES)[number]

export type WakeWordMatch = {
  matched: boolean
  alias?: WakeWordAlias
  /** Text after the wake word, with the separating punctuation removed. */
  command: string
}

const SEPARATOR = /^[\s，,、。.!！?？:：；;：\-—]+/u

/**
 * Matches Xiaonan only at the start, optionally after "你好". Chinese ASR
 * commonly omits punctuation between a name and command, so the entire exact
 * alias is the conservative boundary rather than a fuzzy phonetic search.
 */
export function matchWakeWord(input: string): WakeWordMatch {
  const text = normalizeTranscript(input)
  if (!text) return { matched: false, command: '' }

  let rest = text
  if (rest.startsWith('你好')) {
    rest = rest.slice(2).replace(SEPARATOR, '')
  }

  const alias = WAKE_WORD_ALIASES.find((candidate) => rest.startsWith(candidate))
  if (!alias) return { matched: false, command: '' }

  const tail = rest.slice(alias.length)
  if (!tail) return { matched: true, alias, command: '' }
  // A single unseparated character is usually part of another word (for
  // example, 小南门), not a spoken command. Longer contiguous commands remain
  // supported for ASR engines that omit punctuation.
  if (!SEPARATOR.test(tail) && [...tail].length < 2) return { matched: false, command: '' }
  return { matched: true, alias, command: tail.replace(SEPARATOR, '') }
}

export function stripWakeWord(input: string): string | undefined {
  const match = matchWakeWord(input)
  return match.matched ? match.command : undefined
}
