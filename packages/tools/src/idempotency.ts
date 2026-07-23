import type { ToolResult } from '@canvasflow/schema'
import { memberPreferences, type MemberPreferenceRecord } from './data'

/**
 * In-memory idempotency ledger for fixture/mock side effects.
 * Duplicate keys return the original ToolResult and do not re-run the effect.
 * Entries are namespaced per tool so reusing one idempotencyKey across
 * different tools can never return a cached result of the wrong type.
 */
export class IdempotencyStore {
  private readonly results = new Map<string, ToolResult<unknown>>()

  get<T>(tool: string, idempotencyKey: string): ToolResult<T> | undefined {
    return this.results.get(`${tool}\u0000${idempotencyKey}`) as ToolResult<T> | undefined
  }

  set<T>(tool: string, idempotencyKey: string, result: ToolResult<T>): void {
    this.results.set(`${tool}\u0000${idempotencyKey}`, result as ToolResult<unknown>)
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
  const preferences = Object.fromEntries(
    Object.entries(memberPreferences).map(([memberId, record]) => [memberId, { ...record }]),
  )
  return {
    idempotency: new IdempotencyStore(),
    cabinEffects: new Map(),
    cabinCurrent: { temperatureC: 22, fanLevel: 2 },
    memoryProposals: new Map(),
    preferences,
    nowMs,
  }
}
