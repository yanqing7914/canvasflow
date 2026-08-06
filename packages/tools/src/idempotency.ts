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

  clearTask(taskId: string): void {
    const prefix = `${taskId}\u0000`
    for (const key of this.results.keys()) {
      if (key.startsWith(prefix)) this.results.delete(key)
    }
  }

  exportState(): IdempotencyState {
    return [...this.results.entries()].map(([key, entry]) => ({
      key,
      fingerprint: entry.fingerprint,
      result: structuredClone(entry.result),
    }))
  }

  importState(state: IdempotencyState): void {
    this.results.clear()
    for (const entry of state) {
      this.results.set(entry.key, {
        fingerprint: entry.fingerprint,
        result: structuredClone(entry.result),
      })
    }
  }
}

export type IdempotencyState = Array<{
  key: string
  fingerprint: string
  result: ToolResult<unknown>
}>

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

/** Auto-notify grants bind to the same payload fields as an explicit send. */
export type AutoNotifyBinding = MessageSendBinding

type ConfirmationRecord =
  | { kind: 'send-message'; binding: MessageSendBinding; consumed: boolean }
  | { kind: 'confirm-memory'; binding: MemoryConfirmBinding; consumed: boolean }
  | { kind: 'auto-notify'; binding: AutoNotifyBinding; consumed: boolean }

/**
 * Opaque, runtime-issued confirmation / authorization tokens. Callers cannot
 * compute a valid token from task/message/proposal fields; they must obtain
 * one via issue* and present it. Send-message, memory, and auto-notify tokens
 * are all one-shot; auto-notify is additionally bound to a prepared
 * landing-message payload (taskId + contactId + messageId + text).
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

  issueAutoNotifyAuthorization(binding: AutoNotifyBinding): string {
    const authorizationId = this.mint()
    this.grants.set(authorizationId, { kind: 'auto-notify', binding: { ...binding }, consumed: false })
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

  /**
   * Irrevocably invalidates a send-message confirmation after reject / abandon /
   * supersede. Does not require a payload match — the confirmation boundary is gone.
   */
  revokeSendMessageConfirmation(confirmationId: string): boolean {
    const grant = this.grants.get(confirmationId)
    if (!grant || grant.kind !== 'send-message') return false
    grant.consumed = true
    return true
  }

  /** Invalidates an auto-notify capability after cancellation or supersession. */
  revokeAutoNotifyAuthorization(authorizationId: string, taskId: string): boolean {
    const grant = this.grants.get(authorizationId)
    if (!grant || grant.kind !== 'auto-notify' || grant.binding.taskId !== taskId) return false
    grant.consumed = true
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

  /** Invalidates a pending memory proposal after an explicit reject. */
  revokeMemoryConfirmation(confirmationId: string): boolean {
    const grant = this.grants.get(confirmationId)
    if (!grant || grant.kind !== 'confirm-memory') return false
    grant.consumed = true
    return true
  }

  memoryConfirmationState(confirmationId: string): 'active' | 'consumed' | 'missing' {
    const grant = this.grants.get(confirmationId)
    if (!grant || grant.kind !== 'confirm-memory') return 'missing'
    return grant.consumed ? 'consumed' : 'active'
  }

  memoryConfirmationBinding(confirmationId: string): MemoryConfirmBinding | undefined {
    const grant = this.grants.get(confirmationId)
    if (!grant || grant.kind !== 'confirm-memory') return undefined
    return grant.binding
  }

  /** Capability grant for a prepared payload; must still be unconsumed. */
  matchesAutoNotifyAuthorization(authorizationId: string, binding: AutoNotifyBinding): boolean {
    const grant = this.grants.get(authorizationId)
    if (!grant || grant.kind !== 'auto-notify' || grant.consumed) return false
    return (
      grant.binding.taskId === binding.taskId &&
      grant.binding.contactId === binding.contactId &&
      grant.binding.messageId === binding.messageId &&
      grant.binding.text === binding.text
    )
  }

  /**
   * Validates and consumes an auto-notify grant. Returns false for unknown,
   * wrong-kind, already-consumed, or binding-mismatched tokens.
   */
  consumeAutoNotifyAuthorization(authorizationId: string, binding: AutoNotifyBinding): boolean {
    if (!this.matchesAutoNotifyAuthorization(authorizationId, binding)) return false
    this.grants.get(authorizationId)!.consumed = true
    return true
  }

  clearTask(taskId: string): void {
    for (const [confirmationId, grant] of this.grants) {
      if (grant.binding.taskId === taskId) this.grants.delete(confirmationId)
    }
  }

  exportState(): ConfirmationState {
    return {
      counter: this.counter,
      grants: [...this.grants.entries()].map(([confirmationId, grant]) => [
        confirmationId,
        structuredClone(grant),
      ]),
    }
  }

  importState(state: ConfirmationState): void {
    this.counter = state.counter
    this.grants.clear()
    for (const [confirmationId, grant] of state.grants) {
      this.grants.set(confirmationId, structuredClone(grant))
    }
  }
}

export type ConfirmationState = {
  counter: number
  grants: Array<[string, ConfirmationRecord]>
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

export type SideEffectRuntimeSnapshot = {
  version: 1
  idempotency: IdempotencyState
  confirmations: ConfirmationState
  plannedRouteIdsByTask: Array<[string, string[]]>
  cabinEffects: Array<[string, CabinEffectRecord]>
  cabinCurrent: CabinProfileValues
  memoryProposals: Array<[string, MemoryProposalRecord]>
  preferences: Record<string, MemberPreferenceRecord>
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

export function snapshotSideEffectRuntime(runtime: SideEffectRuntime): SideEffectRuntimeSnapshot {
  return {
    version: 1,
    idempotency: runtime.idempotency.exportState(),
    confirmations: runtime.confirmations.exportState(),
    plannedRouteIdsByTask: [...runtime.plannedRouteIdsByTask.entries()].map(([taskId, routeIds]) => [taskId, [...routeIds]]),
    cabinEffects: [...runtime.cabinEffects.entries()].map(([effectId, effect]) => [effectId, structuredClone(effect)]),
    cabinCurrent: structuredClone(runtime.cabinCurrent),
    memoryProposals: [...runtime.memoryProposals.entries()].map(([proposalId, proposal]) => [proposalId, structuredClone(proposal)]),
    preferences: structuredClone(runtime.preferences),
  }
}

export function restoreSideEffectRuntime(runtime: SideEffectRuntime, snapshot: SideEffectRuntimeSnapshot): void {
  if (snapshot.version !== 1) throw new Error(`Unsupported side-effect runtime snapshot version: ${String(snapshot.version)}`)
  runtime.idempotency.importState(snapshot.idempotency)
  runtime.confirmations.importState(snapshot.confirmations)

  runtime.plannedRouteIdsByTask.clear()
  for (const [taskId, routeIds] of snapshot.plannedRouteIdsByTask) {
    runtime.plannedRouteIdsByTask.set(taskId, new Set(routeIds))
  }

  runtime.cabinEffects.clear()
  for (const [effectId, effect] of snapshot.cabinEffects) {
    runtime.cabinEffects.set(effectId, structuredClone(effect))
  }

  for (const key of Object.keys(runtime.cabinCurrent)) delete runtime.cabinCurrent[key as keyof CabinProfileValues]
  Object.assign(runtime.cabinCurrent, structuredClone(snapshot.cabinCurrent))

  runtime.memoryProposals.clear()
  for (const [proposalId, proposal] of snapshot.memoryProposals) {
    runtime.memoryProposals.set(proposalId, structuredClone(proposal))
  }

  for (const memberId of Object.keys(runtime.preferences)) delete runtime.preferences[memberId]
  for (const [memberId, preference] of Object.entries(snapshot.preferences)) {
    runtime.preferences[memberId] = structuredClone(preference)
  }
}

export function resetSideEffectRuntimeTask(runtime: SideEffectRuntime, taskId: string): void {
  runtime.idempotency.clearTask(taskId)
  runtime.confirmations.clearTask(taskId)
  runtime.plannedRouteIdsByTask.delete(taskId)
  const taskCabinEffects = [...runtime.cabinEffects.entries()].filter(([, effect]) => effect.taskId === taskId)
  for (const [, effect] of taskCabinEffects) {
    if (effect.reverted) continue
    if (cabinProfilesEqual(runtime.cabinCurrent, effect.current)) replaceCabinProfile(runtime.cabinCurrent, effect.previous)
    for (const other of runtime.cabinEffects.values()) {
      if (other === effect || other.reverted || !cabinProfilesEqual(other.previous, effect.current)) continue
      other.previous = structuredClone(effect.previous)
    }
  }
  for (const [effectId] of taskCabinEffects) {
    runtime.cabinEffects.delete(effectId)
  }
  for (const [proposalId, proposal] of runtime.memoryProposals) {
    if (proposal.taskId === taskId) runtime.memoryProposals.delete(proposalId)
  }
}

function cabinProfilesEqual(left: CabinProfileValues, right: CabinProfileValues): boolean {
  return left.temperatureC === right.temperatureC
    && left.fanLevel === right.fanLevel
    && left.mediaTitle === right.mediaTitle
}

function replaceCabinProfile(target: CabinProfileValues, source: CabinProfileValues): void {
  for (const key of Object.keys(target)) delete target[key as keyof CabinProfileValues]
  Object.assign(target, structuredClone(source))
}
