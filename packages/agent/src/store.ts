import type { AgentDestination, AirportPickupTaskState, ClientCapabilities, EffectRecord, TaskUpdateEnvelope, UISpec, VehicleContext } from '@canvasflow/schema'
import type { ReadToolResults } from './orchestration'
import { createTaskUpdate } from './task-updates'

const DEFAULT_MAX_TASK_UPDATES = 1_000

function validateMaxTaskUpdates(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('maxTaskUpdatesPerTask must be a positive safe integer')
  }
  return value
}

export type StoredTask = {
  task: AirportPickupTaskState
  ui: UISpec
  /** Model provenance for the operation that produced this persisted snapshot. */
  modelUsed?: string
  /**
   * A line this snapshot wants spoken without having been asked anything.
   *
   * Written by the turn that earned it and, because it is set through
   * `#publish`, absent from every snapshot after — so the car volunteers a fact
   * once rather than restating it on each event that follows. That is why it
   * cannot be derived at response time instead: an advisory that is still active
   * looks identical to one that has just been raised, and only the raising turn
   * knows which it is.
   *
   * Distinct from the `assistant` on `StoredEventResult` below, which is a
   * replay record for answers, not a property of the snapshot.
   */
  announcement?: { text: string; shouldSpeak: boolean }
  toolResults?: ReadToolResults
  /** Provider receipts stay private to the Agent and never enter TaskState or UISpec. */
  effectReceipts?: {
    activeCabin?: {
      receiptId: string
      providerEffectId: string
      state: 'applied' | 'deferred' | 'reverted' | 'revert-failed' | 'unknown'
      lastErrorCode?: string
    }
  }
  requestContext?: {
    vehicle: VehicleContext
    clientCapabilities: ClientCapabilities
    /**
     * Where this trip is driving to.
     *
     * Absent until it is actually known. The client may name one up front, but
     * usually nobody has: the destination follows from which flight was picked,
     * and 上海 has two airports on opposite sides of the city. Filling in 虹桥
     * before the flight is read would make every consumer downstream — the
     * navigation label, the weather advisory, the meeting point — confidently
     * agree on an answer nobody chose. `#prepareTask` writes the derived one
     * here once the flight is read, so after that this field means "the airport
     * this trip settled on" rather than "the airport we assumed".
     */
    destination?: AgentDestination
    inputConfidence?: number
    /** Ordering watermark for request-context-only events. */
    updatedAt?: string
  }
}

export type StoredEventResult = {
  stored: StoredTask
  effects: EffectRecord[]
  /**
   * The spoken line the response carried, kept only where replaying an answer
   * means replaying what was said. Ordinary events derive their line from the
   * snapshot they produced, so they leave this unset.
   */
  assistant?: { text: string; shouldSpeak: boolean }
}

export type StoredIdempotencyResult = StoredEventResult

export type TaskUpdateRead = {
  updates: TaskUpdateEnvelope[]
  latestCursor: number
  /** The requested cursor predates retained rows; updates contains one authoritative resync snapshot. */
  staleCursor: boolean
}

export interface TaskStore {
  create(value: StoredTask, clientRequestId?: string): StoredTask
  get(taskId: string): StoredTask | undefined
  getByClientRequestId(clientRequestId: string): StoredTask | undefined
  getEventResult(taskId: string, eventId: string): StoredEventResult | undefined
  recordEventResult(taskId: string, eventId: string, result: StoredEventResult): void
  getIdempotencyResult(taskId: string, operation: string, idempotencyKey: string): StoredIdempotencyResult | undefined
  recordIdempotencyResult(taskId: string, operation: string, idempotencyKey: string, result: StoredIdempotencyResult): void
  save(value: StoredTask): StoredTask
  reset(value: StoredTask): StoredTask
  readTaskUpdates(taskId: string, afterCursor?: number): TaskUpdateRead
  clear(): void
}

export class MemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, StoredTask>()
  readonly #createResults = new Map<string, StoredTask>()
  readonly #eventResults = new Map<string, StoredEventResult>()
  readonly #idempotencyResults = new Map<string, StoredIdempotencyResult>()
  readonly #updates = new Map<string, TaskUpdateEnvelope[]>()
  readonly #latestCursors = new Map<string, number>()
  readonly #maxTaskUpdatesPerTask: number

  constructor(options: { maxTaskUpdatesPerTask?: number } = {}) {
    this.#maxTaskUpdatesPerTask = validateMaxTaskUpdates(options.maxTaskUpdatesPerTask ?? DEFAULT_MAX_TASK_UPDATES)
  }

  create(value: StoredTask, clientRequestId?: string): StoredTask {
    if (this.#tasks.has(value.task.taskId)) throw new Error(`Task already exists: ${value.task.taskId}`)
    if (clientRequestId && this.#createResults.has(clientRequestId)) {
      throw new Error(`Request already exists: ${clientRequestId}`)
    }
    const stored = this.save(value)
    if (clientRequestId) this.#createResults.set(clientRequestId, structuredClone(stored))
    return stored
  }

  get(taskId: string): StoredTask | undefined {
    const value = this.#tasks.get(taskId)
    return value ? structuredClone(value) : undefined
  }

  getByClientRequestId(clientRequestId: string): StoredTask | undefined {
    const result = this.#createResults.get(clientRequestId)
    return result ? structuredClone(result) : undefined
  }

  getEventResult(taskId: string, eventId: string): StoredEventResult | undefined {
    const result = this.#eventResults.get(`${taskId}:${eventId}`)
    return result ? structuredClone(result) : undefined
  }

  recordEventResult(taskId: string, eventId: string, result: StoredEventResult): void {
    this.#eventResults.set(`${taskId}:${eventId}`, structuredClone(result))
  }

  getIdempotencyResult(taskId: string, operation: string, idempotencyKey: string): StoredIdempotencyResult | undefined {
    const result = this.#idempotencyResults.get(`${taskId}:${operation}:${idempotencyKey}`)
    return result ? structuredClone(result) : undefined
  }

  recordIdempotencyResult(taskId: string, operation: string, idempotencyKey: string, result: StoredIdempotencyResult): void {
    this.#idempotencyResults.set(`${taskId}:${operation}:${idempotencyKey}`, structuredClone(result))
  }

  save(value: StoredTask): StoredTask {
    const snapshot = structuredClone(value)
    const current = this.#tasks.get(value.task.taskId)
    this.#tasks.set(value.task.taskId, snapshot)
    if (!current || !samePublicSnapshot(current, snapshot)) this.#appendTaskUpdate(snapshot)
    return structuredClone(snapshot)
  }

  reset(value: StoredTask): StoredTask {
    const taskId = value.task.taskId
    for (const key of this.#eventResults.keys()) {
      if (key.startsWith(`${taskId}:`)) this.#eventResults.delete(key)
    }
    for (const key of this.#idempotencyResults.keys()) {
      if (key.startsWith(`${taskId}:`)) this.#idempotencyResults.delete(key)
    }
    // A create key owns its first response for its full retention period.
    return this.save(value)
  }

  readTaskUpdates(taskId: string, afterCursor?: number): TaskUpdateRead {
    const updates = this.#updates.get(taskId) ?? []
    const latestCursor = this.#latestCursors.get(taskId) ?? 0
    if (afterCursor === undefined) {
      return { updates: updates.length > 0 ? [structuredClone(updates.at(-1)!)] : [], latestCursor, staleCursor: false }
    }
    const earliestCursor = updates[0]?.cursor
    const staleCursor = earliestCursor !== undefined && afterCursor < earliestCursor - 1
    const selected = staleCursor
      ? updates.length > 0 ? [updates.at(-1)!] : []
      : updates.filter((update) => update.cursor > afterCursor)
    return { updates: structuredClone(selected), latestCursor, staleCursor }
  }

  clear(): void {
    this.#tasks.clear()
    this.#createResults.clear()
    this.#eventResults.clear()
    this.#idempotencyResults.clear()
    this.#updates.clear()
    this.#latestCursors.clear()
  }

  #appendTaskUpdate(stored: StoredTask): void {
    const taskId = stored.task.taskId
    const cursor = (this.#latestCursors.get(taskId) ?? 0) + 1
    const updates = [...(this.#updates.get(taskId) ?? []), createTaskUpdate(stored, cursor)]
    if (updates.length > this.#maxTaskUpdatesPerTask) {
      updates.splice(0, updates.length - this.#maxTaskUpdatesPerTask)
    }
    this.#latestCursors.set(taskId, cursor)
    this.#updates.set(taskId, updates)
  }
}

function samePublicSnapshot(left: StoredTask, right: StoredTask): boolean {
  return JSON.stringify({ task: left.task, ui: left.ui }) === JSON.stringify({ task: right.task, ui: right.ui })
}
