import type { AirportPickupTaskState, EffectRecord, UISpec } from '@canvasflow/schema'

export type StoredTask = {
  task: AirportPickupTaskState
  ui: UISpec
}

export type StoredEventResult = {
  stored: StoredTask
  effects: EffectRecord[]
}

export type StoredIdempotencyResult = StoredEventResult

export interface TaskStore {
  create(value: StoredTask, clientRequestId?: string): StoredTask
  get(taskId: string): StoredTask | undefined
  getByClientRequestId(clientRequestId: string): StoredTask | undefined
  getEventResult(taskId: string, eventId: string): StoredEventResult | undefined
  recordEventResult(taskId: string, eventId: string, result: StoredEventResult): void
  getIdempotencyResult(taskId: string, operation: string, idempotencyKey: string): StoredIdempotencyResult | undefined
  recordIdempotencyResult(taskId: string, operation: string, idempotencyKey: string, result: StoredIdempotencyResult): void
  save(value: StoredTask): StoredTask
  clear(): void
}

export class MemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, StoredTask>()
  readonly #createResults = new Map<string, StoredTask>()
  readonly #eventResults = new Map<string, StoredEventResult>()
  readonly #idempotencyResults = new Map<string, StoredIdempotencyResult>()

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
    this.#tasks.set(value.task.taskId, snapshot)
    return structuredClone(snapshot)
  }

  clear(): void {
    this.#tasks.clear()
    this.#createResults.clear()
    this.#eventResults.clear()
    this.#idempotencyResults.clear()
  }
}
