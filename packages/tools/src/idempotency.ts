import type { ToolResult } from '@canvasflow/schema'
import { memberPreferences, type MemberPreferenceRecord } from './data'

/** Deterministic fingerprint of a tool input: JSON with recursively sorted keys. */
export function canonicalFingerprint(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortValue(record[key])]))
  }
  return value
}

export type IdempotencyLookup<T> =
  | { kind: 'miss' }
  | { kind: 'hit'; result: ToolResult<T> }
  | { kind: 'conflict' }

/**
 * In-memory idempotency ledger for fixture/mock side effects.
 * Duplicate keys with the same request fingerprint return the original
 * ToolResult and do not re-run the effect; the same key with a different
 * request payload is a caller bug and is reported as a conflict instead of
 * silently replaying a success that belongs to another request.
 * Entries are namespaced per taskId + tool so reusing one idempotencyKey
 * across tasks or tools can never return a cached result of the wrong scope.
 */
export class IdempotencyStore {
  private readonly results = new Map<string, { fingerprint: string; result: ToolResult<unknown> }>()

  private key(taskId: string, tool: string, idempotencyKey: string): string {
    return `${taskId}\u0000${tool}\u0000${idempotencyKey}`
  }

  get<T>(taskId: string, tool: string, idempotencyKey: string, input: unknown): IdempotencyLookup<T> {
    const entry = this.results.get(this.key(taskId, tool, idempotencyKey))
    if (!entry) return { kind: 'miss' }
    if (entry.fingerprint !== canonicalFingerprint(input)) return { kind: 'conflict' }
    return { kind: 'hit', result: entry.result as ToolResult<T> }
  }

  set<T>(taskId: string, tool: string, idempotencyKey: string, input: unknown, result: ToolResult<T>): void {
    this.results.set(this.key(taskId, tool, idempotencyKey), {
      fingerprint: canonicalFingerprint(input),
      result: result as ToolResult<unknown>,
    })
  }
}

export type CabinProfileValues = {
  temperatureC?: number
  fanLevel?: number
  mediaTitle?: string
}

export type CabinEffectRecord = {
  effectId: string
  previous: CabinProfileValues
  current: CabinProfileValues
  reverted: boolean
}

export type MemoryProposalRecord = {
  proposalId: string
  memberId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** Credential that memory.confirm-update must present to apply this proposal. */
  confirmationId: string
  confirmed: boolean
  expiresAtMs: number
}

/** Mutable fixture runtime shared by side-effect providers in one registry. */
export type SideEffectRuntime = {
  idempotency: IdempotencyStore
  cabinEffects: Map<string, CabinEffectRecord>
  cabinCurrent: CabinProfileValues
  memoryProposals: Map<string, MemoryProposalRecord>
  preferences: Record<string, MemberPreferenceRecord>
  nowMs: () => number
}

export function createSideEffectRuntime(nowMs: () => number = () => Date.parse('2026-07-22T12:00:00+08:00')): SideEffectRuntime {
  // Null-prototype map so `in` / accidental prototype lookups cannot treat
  // Object.prototype keys as family members.
  const preferences = Object.create(null) as Record<string, MemberPreferenceRecord>
  for (const [memberId, record] of Object.entries(memberPreferences)) {
    preferences[memberId] = { ...record }
  }
  return {
    idempotency: new IdempotencyStore(),
    cabinEffects: new Map(),
    cabinCurrent: { temperatureC: 22, fanLevel: 2 },
    memoryProposals: new Map(),
    preferences,
    nowMs,
  }
}
