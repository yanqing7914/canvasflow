import type { ToolResult } from '@canvasflow/schema'
import { memberPreferences, type MemberPreferenceRecord } from './data'

/**
 * In-memory idempotency ledger for fixture/mock side effects.
 * Duplicate keys return the original ToolResult and do not re-run the effect.
 */
export class IdempotencyStore {
  private readonly results = new Map<string, ToolResult<unknown>>()

  get<T>(idempotencyKey: string): ToolResult<T> | undefined {
    return this.results.get(idempotencyKey) as ToolResult<T> | undefined
  }

  set<T>(idempotencyKey: string, result: ToolResult<T>): void {
    this.results.set(idempotencyKey, result as ToolResult<unknown>)
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
