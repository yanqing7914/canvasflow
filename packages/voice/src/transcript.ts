/**
 * Pure text helpers for the voice layer. Deliberately free of any task
 * knowledge — these only decide whether a transcript is usable at all.
 */

/** Punctuation ASR engines sprinkle in that carries no content on its own. */
const TRIM_ONLY = /^[\s。，、．,.!！?？…~～]+$/u

/** Code-point length, so a single CJK character counts as one. */
export function graphemeLen(text: string): number {
  return [...text].length
}

/** Collapses runs of whitespace and trims — the canonical submit form. */
export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** True when there is nothing worth submitting. */
export function isBlankTranscript(text: string): boolean {
  const normalized = normalizeTranscript(text)
  return normalized.length === 0 || TRIM_ONLY.test(normalized)
}

/**
 * Merges the stable prefix with the in-flight partial for display. Web Speech
 * repeats the final segment in later partials, so drop a partial the stable
 * text already covers.
 */
export function mergeInterim(stable: string, interim: string): string {
  const left = normalizeTranscript(stable)
  const right = normalizeTranscript(interim)
  if (!right) return left
  if (!left) return right
  if (left.endsWith(right)) return left
  return `${left} ${right}`
}

/** Clamps engine confidence into [0,1]; undefined when the engine omits it. */
export function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}
