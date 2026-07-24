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
  /** Task that created this cabin effect; revert must stay on the same task. */
  taskId: string
  previous: CabinProfileValues
  current: CabinProfileValues
  reverted: boolean
}

export type MemoryProposalRecord = {
  proposalId: string
  /** Task that issued this proposal; confirm-update must stay on the same task. */
  taskId: string
  memberId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** Opaque credential that memory.confirm-update must present to apply this proposal. */
  confirmationId: string
  confirmed: boolean
  expiresAtMs: number
}

export type MessageSendBinding = {
  taskId: string
  contactId: string
  messageId: string
  text: string
}

export type MemoryConfirmBinding = {
  taskId: string
  proposalId: string
}

export type AutoNotifyBinding = {
  taskId: string
}

type ConfirmationRecord =
  | { kind: 'send-message'; binding: MessageSendBinding; consumed: boolean }
  | { kind: 'confirm-memory'; binding: MemoryConfirmBinding; consumed: boolean }
  | { kind: 'auto-notify'; binding: AutoNotifyBinding; consumed: boolean }

/**
 * Opaque, runtime-issued confirmation / authorization tokens. Callers cannot
 * compute a valid token from task/message/proposal fields; they must obtain
 * one via issue* and present it. Send-message and memory tokens are one-shot;
 * auto-notify is a reusable capability grant for a task (not consumed on use).
 */
export class ConfirmationStore {
  private readonly grants = new Map<string, ConfirmationRecord>()
  private counter = 0

  private mint(): string {
    this.counter += 1
    const entropy =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    return `cnf_${this.counter}_${entropy}`
  }

  issueSendMessageConfirmation(binding: MessageSendBinding): string {
    const confirmationId = this.mint()
    this.grants.set(confirmationId, { kind: 'send-message', binding: { ...binding }, consumed: false })
    return confirmationId
  }

  issueMemoryConfirmation(binding: MemoryConfirmBinding): string {
    const confirmationId = this.mint()
    this.grants.set(confirmationId, { kind: 'confirm-memory', binding: { ...binding }, consumed: false })
    return confirmationId
  }

  issueAutoNotifyAuthorization(taskId: string): string {
    const authorizationId = this.mint()
    this.grants.set(authorizationId, { kind: 'auto-notify', binding: { taskId }, consumed: false })
    return authorizationId
  }

  matchesSendMessageConfirmation(confirmationId: string, binding: MessageSendBinding): boolean {
    const grant = this.grants.get(confirmationId)
    if (!grant || grant.kind !== 'send-message' || grant.consumed) return false
    return (
      grant.binding.taskId === binding.taskId &&
      grant.binding.contactId === binding.contactId &&
      grant.binding.messageId === binding.messageId &&
      grant.binding.text === binding.text
    )
  }

  /**
   * Validates and consumes a send-message confirmation. Returns false for
   * unknown, wrong-kind, already-consumed, or binding-mismatched tokens.
   */
  consumeSendMessageConfirmation(confirmationId: string, binding: MessageSendBinding): boolean {
    if (!this.matchesSendMessageConfirmation(confirmationId, binding)) return false
    this.grants.get(confirmationId)!.consumed = true
    return true
  }

  matchesMemoryConfirmation(confirmationId: string, binding: MemoryConfirmBinding): boolean {
    const grant = this.grants.get(confirmationId)
    if (!grant || grant.kind !== 'confirm-memory' || grant.consumed) return false
    return grant.binding.taskId === binding.taskId && grant.binding.proposalId === binding.proposalId
  }

  consumeMemoryConfirmation(confirmationId: string, binding: MemoryConfirmBinding): boolean {
    if (!this.matchesMemoryConfirmation(confirmationId, binding)) return false
    this.grants.get(confirmationId)!.consumed = true
    return true
  }

  /** Capability grant for a task; not consumed on successful send. */
  matchesAutoNotifyAuthorization(authorizationId: string, taskId: string): boolean {
    const grant = this.grants.get(authorizationId)
    if (!grant || grant.kind !== 'auto-notify' || grant.consumed) return false
    return grant.binding.taskId === taskId
  }
}

/** Mutable fixture runtime shared by side-effect providers in one registry. */
export type SideEffectRuntime = {
  idempotency: IdempotencyStore
  confirmations: ConfirmationStore
  /** Route IDs successfully returned by plan-route / update-route for each task. */
  plannedRouteIdsByTask: Map<string, Set<string>>
  cabinEffects: Map<string, CabinEffectRecord>
  cabinCurrent: CabinProfileValues
  memoryProposals: Map<string, MemoryProposalRecord>
  preferences: Record<string, MemberPreferenceRecord>
  nowMs: () => number
}

/** Live wall clock by default so proposal TTLs elapse; inject a fixed clock in tests. */
export function createSideEffectRuntime(nowMs: () => number = () => Date.now()): SideEffectRuntime {
  // Null-prototype map so `in` / accidental prototype lookups cannot treat
  // Object.prototype keys as family members.
  const preferences = Object.create(null) as Record<string, MemberPreferenceRecord>
  for (const [memberId, record] of Object.entries(memberPreferences)) {
    preferences[memberId] = { ...record }
  }
  return {
    idempotency: new IdempotencyStore(),
    confirmations: new ConfirmationStore(),
    plannedRouteIdsByTask: new Map(),
    cabinEffects: new Map(),
    cabinCurrent: { temperatureC: 22, fanLevel: 2 },
    memoryProposals: new Map(),
    preferences,
    nowMs,
  }
}
