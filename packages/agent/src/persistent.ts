import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import type {
  AgentResponse,
  CancelTaskRequest,
  CreateTaskRequest,
  ProviderMode,
  ResetTaskRequest,
  SubmitActionRequest,
  SubmitConfirmationRequest,
  SubmitEventRequest,
  TaskUpdateEnvelope,
} from '@canvasflow/schema'
import { createTaskRequestSchema, submitEventRequestSchema } from '@canvasflow/schema'
import {
  createProviderRegistry,
  createSideEffectRuntime,
  restoreSideEffectRuntime,
  snapshotSideEffectRuntime,
  type ProviderRegistry,
  type SideEffectRuntime,
  type SideEffectRuntimeSnapshot,
} from '@canvasflow/tools'
import { AgentGateway, type AgentGatewayOptions } from './gateway'
import type { AgentHttpGateway } from './http'
import { ModelGateway } from './model-gateway'
import type { Plan, PlannerInput } from './planner'
import type { StoredEventResult, StoredIdempotencyResult, StoredTask, TaskStore, TaskUpdateRead } from './store'
import { createTaskUpdate } from './task-updates'

type SqlRow = Record<string, unknown>

function parseJson<T>(value: unknown): T {
  if (typeof value !== 'string') throw new Error('Persistent runtime contains a non-text JSON value')
  return JSON.parse(value) as T
}

function statementRow(statement: StatementSync, ...params: SQLInputValue[]): SqlRow | undefined {
  return statement.get(...params) as SqlRow | undefined
}

function enforceProviderMode(registry: ProviderRegistry, mode: ProviderMode): ProviderRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([name, provider]) => [
      name,
      (context: Parameters<typeof provider>[0], input?: unknown) => {
        const result = provider(context, input)
        if (!result || typeof result !== 'object' || result.meta?.provider !== mode) {
          throw new Error(`Provider ${name} returned mode ${String(result?.meta?.provider)}, expected ${mode}`)
        }
        return result
      },
    ]),
  ) as ProviderRegistry
}

export class SqliteTaskStore implements TaskStore {
  readonly #database: DatabaseSync
  readonly #maxTaskUpdatesPerTask: number

  constructor(database: DatabaseSync, maxTaskUpdatesPerTask = 1_000) {
    if (!Number.isSafeInteger(maxTaskUpdatesPerTask) || maxTaskUpdatesPerTask <= 0) {
      throw new TypeError('maxTaskUpdatesPerTask must be a positive safe integer')
    }
    this.#database = database
    this.#maxTaskUpdatesPerTask = maxTaskUpdatesPerTask
  }

  create(value: StoredTask, clientRequestId?: string): StoredTask {
    if (this.get(value.task.taskId)) throw new Error(`Task already exists: ${value.task.taskId}`)
    if (clientRequestId && this.getByClientRequestId(clientRequestId)) {
      throw new Error(`Request already exists: ${clientRequestId}`)
    }
    const stored = this.save(value)
    if (clientRequestId) {
      this.#database.prepare(
        'INSERT INTO agent_create_results (client_request_id, task_id, stored_json) VALUES (?, ?, ?)',
      ).run(clientRequestId, value.task.taskId, JSON.stringify(stored))
    }
    return stored
  }

  get(taskId: string): StoredTask | undefined {
    const row = statementRow(this.#database.prepare('SELECT stored_json FROM agent_tasks WHERE task_id = ?'), taskId)
    return row ? parseJson<StoredTask>(row.stored_json) : undefined
  }

  getByClientRequestId(clientRequestId: string): StoredTask | undefined {
    const row = statementRow(
      this.#database.prepare('SELECT stored_json FROM agent_create_results WHERE client_request_id = ?'),
      clientRequestId,
    )
    return row ? parseJson<StoredTask>(row.stored_json) : undefined
  }

  getEventResult(taskId: string, eventId: string): StoredEventResult | undefined {
    const row = statementRow(
      this.#database.prepare('SELECT result_json FROM agent_event_results WHERE task_id = ? AND event_id = ?'),
      taskId,
      eventId,
    )
    return row ? parseJson<StoredEventResult>(row.result_json) : undefined
  }

  recordEventResult(taskId: string, eventId: string, result: StoredEventResult): void {
    this.#database.prepare(`
      INSERT INTO agent_event_results (task_id, event_id, result_json) VALUES (?, ?, ?)
      ON CONFLICT(task_id, event_id) DO UPDATE SET result_json = excluded.result_json
    `).run(taskId, eventId, JSON.stringify(result))
  }

  getIdempotencyResult(taskId: string, operation: string, idempotencyKey: string): StoredIdempotencyResult | undefined {
    const row = statementRow(
      this.#database.prepare(`
        SELECT result_json FROM agent_idempotency_results
        WHERE task_id = ? AND operation = ? AND idempotency_key = ?
      `),
      taskId,
      operation,
      idempotencyKey,
    )
    return row ? parseJson<StoredIdempotencyResult>(row.result_json) : undefined
  }

  recordIdempotencyResult(
    taskId: string,
    operation: string,
    idempotencyKey: string,
    result: StoredIdempotencyResult,
  ): void {
    this.#database.prepare(`
      INSERT INTO agent_idempotency_results (task_id, operation, idempotency_key, result_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, operation, idempotency_key) DO UPDATE SET result_json = excluded.result_json
    `).run(taskId, operation, idempotencyKey, JSON.stringify(result))
  }

  save(value: StoredTask): StoredTask {
    const snapshot = structuredClone(value)
    const current = this.get(value.task.taskId)
    this.#database.prepare(`
      INSERT INTO agent_tasks (task_id, stored_json) VALUES (?, ?)
      ON CONFLICT(task_id) DO UPDATE SET stored_json = excluded.stored_json
    `).run(value.task.taskId, JSON.stringify(snapshot))
    if (current && JSON.stringify({ task: current.task, ui: current.ui }) === JSON.stringify({ task: snapshot.task, ui: snapshot.ui })) {
      return structuredClone(snapshot)
    }
    const cursorRow = statementRow(this.#database.prepare(`
      INSERT INTO agent_task_update_cursors (task_id, latest_cursor) VALUES (?, 1)
      ON CONFLICT(task_id) DO UPDATE SET latest_cursor = latest_cursor + 1
      RETURNING latest_cursor
    `), value.task.taskId)
    const cursor = Number(cursorRow?.latest_cursor)
    const update = createTaskUpdate(snapshot, cursor)
    this.#database.prepare(`
      INSERT INTO agent_task_updates (task_id, cursor, envelope_json) VALUES (?, ?, ?)
    `).run(value.task.taskId, cursor, JSON.stringify(update))
    this.#database.prepare(`
      DELETE FROM agent_task_updates
      WHERE task_id = ? AND cursor <= ?
    `).run(value.task.taskId, cursor - this.#maxTaskUpdatesPerTask)
    return structuredClone(snapshot)
  }

  reset(value: StoredTask): StoredTask {
    const taskId = value.task.taskId
    this.#database.prepare('DELETE FROM agent_event_results WHERE task_id = ?').run(taskId)
    this.#database.prepare('DELETE FROM agent_idempotency_results WHERE task_id = ?').run(taskId)
    const stored = this.save(value)
    this.#database.prepare('UPDATE agent_create_results SET stored_json = ? WHERE task_id = ?')
      .run(JSON.stringify(stored), taskId)
    return stored
  }

  readTaskUpdates(taskId: string, afterCursor?: number): TaskUpdateRead {
    const cursorRow = statementRow(
      this.#database.prepare('SELECT latest_cursor FROM agent_task_update_cursors WHERE task_id = ?'),
      taskId,
    )
    const latestCursor = Number(cursorRow?.latest_cursor ?? 0)
    const earliestRow = statementRow(
      this.#database.prepare('SELECT MIN(cursor) AS earliest_cursor FROM agent_task_updates WHERE task_id = ?'),
      taskId,
    )
    const earliestCursor = earliestRow?.earliest_cursor === null || earliestRow?.earliest_cursor === undefined
      ? undefined
      : Number(earliestRow.earliest_cursor)
    const staleCursor = afterCursor !== undefined
      && earliestCursor !== undefined
      && afterCursor < earliestCursor - 1
    const rows = staleCursor || afterCursor === undefined
      ? this.#database.prepare(`
          SELECT envelope_json FROM agent_task_updates WHERE task_id = ? ORDER BY cursor DESC LIMIT 1
        `).all(taskId) as SqlRow[]
      : this.#database.prepare(`
          SELECT envelope_json FROM agent_task_updates WHERE task_id = ? AND cursor > ? ORDER BY cursor ASC
        `).all(taskId, afterCursor) as SqlRow[]
    const orderedRows = staleCursor || afterCursor === undefined ? rows.reverse() : rows
    return {
      updates: orderedRows.map((row) => parseJson<TaskUpdateEnvelope>(row.envelope_json)),
      latestCursor,
      staleCursor,
    }
  }

  clear(): void {
    this.#database.exec(`
      DELETE FROM agent_event_results;
      DELETE FROM agent_idempotency_results;
      DELETE FROM agent_create_results;
      DELETE FROM agent_task_updates;
      DELETE FROM agent_task_update_cursors;
      DELETE FROM agent_tasks;
    `)
  }
}

/** Live factories must enforce the durable idempotency keys supplied by EffectExecutor. */
export type ProviderFactory = ((runtime: SideEffectRuntime, mode: ProviderMode) => ProviderRegistry) & {
  durableExternalIdempotency?: true
}

export type PersistentAgentRuntimeOptions = {
  databasePath: string
  mode?: ProviderMode
  providerFactory?: ProviderFactory
  now?: AgentGatewayOptions['now']
  nowMs?: () => number
  createId?: AgentGatewayOptions['createId']
  compose?: AgentGatewayOptions['compose']
  policyGate?: AgentGatewayOptions['policyGate']
  /** Optional rules-first model planner. It is evaluated before SQLite writes. */
  modelGateway?: Pick<ModelGateway, 'plan'>
  /** Maximum retained SSE snapshots for each task; stale cursors receive an authoritative resync snapshot. */
  maxTaskUpdatesPerTask?: number
}

export type CreateTaskExecution = {
  response: AgentResponse
  /** Whether the SQLite transaction replayed an existing create result. */
  replay: boolean
}

export function providerModeFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ProviderMode {
  const mode = environment.AGENT_PROVIDER_MODE ?? 'fixture'
  if (mode === 'fixture' || mode === 'mock' || mode === 'live') return mode
  throw new Error(`Unsupported AGENT_PROVIDER_MODE: ${mode}`)
}

export class PersistentAgentRuntime implements AgentHttpGateway {
  readonly #database: DatabaseSync
  readonly #mode: ProviderMode
  readonly #providerFactory: ProviderFactory
  readonly #options: Omit<PersistentAgentRuntimeOptions, 'databasePath' | 'mode' | 'providerFactory'>
  readonly #modelGateway: Pick<ModelGateway, 'plan'> | undefined
  readonly #inFlightOperations = new Map<string, Promise<unknown>>()
  #closed = false

  constructor(options: PersistentAgentRuntimeOptions) {
    if (!options.databasePath.trim()) throw new TypeError('databasePath must not be empty')
    this.#mode = options.mode ?? 'fixture'
    if (this.#mode === 'live' && options.providerFactory?.durableExternalIdempotency !== true) {
      throw new Error('Live mode requires a providerFactory with durableExternalIdempotency')
    }
    this.#providerFactory = options.providerFactory ?? ((runtime, mode) => {
      if (mode === 'live') throw new Error('Live mode requires an explicit providerFactory')
      return createProviderRegistry(runtime, mode)
    })
    this.#options = {
      now: options.now,
      nowMs: options.nowMs,
      createId: options.createId,
      compose: options.compose,
      policyGate: options.policyGate,
      maxTaskUpdatesPerTask: options.maxTaskUpdatesPerTask,
    }
    this.#modelGateway = options.modelGateway
    if (options.databasePath !== ':memory:') mkdirSync(dirname(resolve(options.databasePath)), { recursive: true })
    this.#database = new DatabaseSync(options.databasePath)
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    if (options.databasePath !== ':memory:') this.#database.exec('PRAGMA journal_mode = WAL;')
    this.#migrate()
    this.#bindMode()
  }

  hasCreateResult(clientRequestId: string): boolean {
    this.#assertOpen()
    return statementRow(
      this.#database.prepare('SELECT 1 AS found FROM agent_create_results WHERE client_request_id = ?'),
      clientRequestId,
    ) !== undefined
  }

  createTask(input: CreateTaskRequest): AgentResponse {
    return this.#run((gateway) => gateway.createTask(input))
  }

  async createTaskAsync(input: CreateTaskRequest): Promise<AgentResponse> {
    return (await this.createTaskWithStatusAsync(input)).response
  }

  async createTaskWithStatusAsync(input: CreateTaskRequest): Promise<CreateTaskExecution> {
    const request = createTaskRequestSchema.parse(input)
    const key = `create:${request.clientRequestId}`
    const existing = this.#inFlightOperations.get(key) as Promise<CreateTaskExecution> | undefined
    // Every caller after the owner is a replay, even when it shares the local preflight promise.
    if (existing) return existing.then(({ response }) => ({ response, replay: true }))
    const pending = (async () => {
      const planned = await this.#planCreate(request)
      return this.#run((gateway) => {
        const replay = gateway.hasCreateResult(request.clientRequestId)
        return { response: gateway.createTask(request), replay }
      }, planned)
    })().finally(() => this.#inFlightOperations.delete(key))
    this.#inFlightOperations.set(key, pending)
    return pending
  }

  getTask(taskId: string, requestId?: string): AgentResponse {
    return this.#read((gateway) => gateway.getTask(taskId, requestId))
  }

  submitEvent(taskId: string, input: SubmitEventRequest): AgentResponse {
    return this.#run((gateway) => gateway.submitEvent(taskId, input))
  }

  async submitEventAsync(taskId: string, input: SubmitEventRequest): Promise<AgentResponse> {
    const request = submitEventRequestSchema.parse(input)
    return this.#coalesceOperation(`event:${taskId}:${request.event.eventId}`, async () => {
      const planned = await this.#planEvent(taskId, request)
      return this.#run((gateway) => gateway.submitEvent(taskId, request), planned)
    })
  }

  submitAction(taskId: string, input: SubmitActionRequest): AgentResponse {
    return this.#run((gateway) => gateway.submitAction(taskId, input))
  }

  submitConfirmation(taskId: string, confirmationId: string, input: SubmitConfirmationRequest): AgentResponse {
    return this.#run((gateway) => gateway.submitConfirmation(taskId, confirmationId, input))
  }

  cancelTask(taskId: string, input: CancelTaskRequest): AgentResponse {
    return this.#run((gateway) => gateway.cancelTask(taskId, input))
  }

  resetTask(taskId: string, input: ResetTaskRequest): AgentResponse {
    return this.#run((gateway) => gateway.resetTask(taskId, input))
  }

  getTaskUpdates(taskId: string, afterCursor?: number): TaskUpdateRead {
    return this.#read((gateway) => gateway.getTaskUpdates(taskId, afterCursor))
  }

  close(): void {
    if (this.#closed) return
    this.#database.close()
    this.#closed = true
  }

  #run<T>(operation: (gateway: AgentGateway) => T, plannedInput?: Plan): T {
    this.#assertOpen()
    // Serializes Gateway calls across processes sharing this SQLite file.
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const runtime = createSideEffectRuntime(this.#options.nowMs)
      const row = statementRow(this.#database.prepare('SELECT snapshot_json FROM agent_runtime_state WHERE id = 1'))
      if (row) restoreSideEffectRuntime(runtime, parseJson<SideEffectRuntimeSnapshot>(row.snapshot_json))
      const providers = enforceProviderMode(this.#providerFactory(runtime, this.#mode), this.#mode)
      const gateway = new AgentGateway({
        store: new SqliteTaskStore(this.#database, this.#options.maxTaskUpdatesPerTask),
        runtime,
        providers,
        mode: this.#mode,
        now: this.#options.now,
        createId: this.#options.createId,
        compose: this.#options.compose,
        policyGate: this.#options.policyGate,
        ...(plannedInput ? { planner: { plan: () => plannedInput } } : {}),
      })
      const result = operation(gateway)
      this.#persistRuntime(runtime)
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Preserve the original operation/commit error.
      }
      throw error
    }
  }

  #read<T>(operation: (gateway: AgentGateway) => T): T {
    this.#assertOpen()
    const runtime = createSideEffectRuntime(this.#options.nowMs)
    const row = statementRow(this.#database.prepare('SELECT snapshot_json FROM agent_runtime_state WHERE id = 1'))
    if (row) restoreSideEffectRuntime(runtime, parseJson<SideEffectRuntimeSnapshot>(row.snapshot_json))
    const providers = enforceProviderMode(this.#providerFactory(runtime, this.#mode), this.#mode)
    return operation(new AgentGateway({
      store: new SqliteTaskStore(this.#database, this.#options.maxTaskUpdatesPerTask), runtime, providers, mode: this.#mode,
      now: this.#options.now, createId: this.#options.createId, compose: this.#options.compose,
      policyGate: this.#options.policyGate,
    }))
  }

  async #planCreate(input: CreateTaskRequest): Promise<Plan | undefined> {
    if (!this.#modelGateway || this.hasCreateResult(input.clientRequestId)) return undefined
    return this.#runModelPlan({
      text: input.input.text,
      eventId: `${input.clientRequestId}:input`,
      timestamp: this.#options.now?.() ?? new Date().toISOString(),
    })
  }

  async #planEvent(taskId: string, input: SubmitEventRequest): Promise<Plan | undefined> {
    if (!this.#modelGateway || input.event.type !== 'user.input') return undefined
    const existing = this.#read((gateway) => {
      try {
        return gateway.getTask(taskId).task
      } catch {
        return undefined
      }
    })
    if (!existing || existing.processedEventIds.includes(input.event.eventId)) return undefined
    return this.#runModelPlan({
      text: input.event.text,
      state: existing,
      eventId: input.event.eventId,
      timestamp: input.event.timestamp,
    })
  }

  async #runModelPlan(input: PlannerInput): Promise<Plan | undefined> {
    const result = await this.#modelGateway!.plan(input)
    return result.plan
  }

  #coalesceOperation<T>(key: string, create: () => Promise<T>): Promise<T> {
    const existing = this.#inFlightOperations.get(key) as Promise<T> | undefined
    if (existing) return existing
    const pending = create().finally(() => this.#inFlightOperations.delete(key))
    this.#inFlightOperations.set(key, pending)
    return pending
  }

  #migrate(): void {
    // Keep schema creation and legacy stream backfill recoverable as one unit.
    this.#database.exec('SAVEPOINT agent_schema_migration')
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS agent_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_tasks (
          task_id TEXT PRIMARY KEY,
          stored_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_create_results (
          client_request_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          stored_json TEXT NOT NULL,
          FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_event_results (
          task_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY(task_id, event_id),
          FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_idempotency_results (
          task_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY(task_id, operation, idempotency_key),
          FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_runtime_state (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          snapshot_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_task_update_cursors (
          task_id TEXT PRIMARY KEY,
          latest_cursor INTEGER NOT NULL CHECK(latest_cursor >= 1),
          FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS agent_task_updates (
          task_id TEXT NOT NULL,
          cursor INTEGER NOT NULL CHECK(cursor >= 1),
          envelope_json TEXT NOT NULL,
          PRIMARY KEY(task_id, cursor),
          FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
        );
      `)
      const missingUpdates = this.#database.prepare(`
        SELECT tasks.stored_json, COALESCE(cursors.latest_cursor, 1) AS cursor
        FROM agent_tasks AS tasks
        LEFT JOIN agent_task_update_cursors AS cursors ON cursors.task_id = tasks.task_id
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_task_updates AS updates
          WHERE updates.task_id = tasks.task_id
            AND updates.cursor = COALESCE(cursors.latest_cursor, 1)
        )
      `).all() as SqlRow[]
      for (const row of missingUpdates) {
        const stored = parseJson<StoredTask>(row.stored_json)
        const cursor = Number(row.cursor)
        const update = createTaskUpdate(stored, cursor)
        this.#database.prepare(`
          INSERT INTO agent_task_update_cursors (task_id, latest_cursor) VALUES (?, ?)
          ON CONFLICT(task_id) DO NOTHING
        `).run(stored.task.taskId, cursor)
        this.#database.prepare(`
          INSERT INTO agent_task_updates (task_id, cursor, envelope_json) VALUES (?, ?, ?)
          ON CONFLICT(task_id, cursor) DO NOTHING
        `).run(stored.task.taskId, cursor, JSON.stringify(update))
      }
      this.#database.exec('RELEASE SAVEPOINT agent_schema_migration')
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK TO SAVEPOINT agent_schema_migration; RELEASE SAVEPOINT agent_schema_migration;')
      } catch {
        // Preserve the migration error.
      }
      throw error
    }
  }

  #persistRuntime(runtime: SideEffectRuntime): void {
    this.#database.prepare(`
      INSERT INTO agent_runtime_state (id, snapshot_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json
    `).run(JSON.stringify(snapshotSideEffectRuntime(runtime)))
  }

  #bindMode(): void {
    const statement = this.#database.prepare('SELECT value FROM agent_metadata WHERE key = ?')
    const row = statementRow(statement, 'provider_mode')
    if (row && row.value !== this.#mode) {
      this.#database.close()
      this.#closed = true
      throw new Error(`Persistent runtime was created for provider mode ${String(row.value)}, not ${this.#mode}`)
    }
    if (!row) {
      this.#database.prepare('INSERT INTO agent_metadata (key, value) VALUES (?, ?)')
        .run('provider_mode', this.#mode)
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Persistent agent runtime is closed')
  }
}
