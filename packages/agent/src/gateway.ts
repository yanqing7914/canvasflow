import {
  agentResponseSchema,
  createTaskRequestSchema,
  submitActionRequestSchema,
  submitConfirmationRequestSchema,
  submitEventRequestSchema,
  type AgentErrorCode,
  type AgentResponse,
  type AirportPickupTaskState,
  type CreateTaskRequest,
  type SubmitActionRequest,
  type SubmitConfirmationRequest,
  type SubmitEventRequest,
  type UISpec,
} from '@canvasflow/schema'
import {
  createSideEffectRuntime,
  type MemberPreferenceRecord,
  type SideEffectRuntime,
} from '@canvasflow/tools'
import { applyEvent, createInitialTask, resolveConfirmation } from './index'
import { normalizeFlightNumber } from './flight-number'
import { composeAgentSpec } from './composer'
import { planEffects } from './effects'
import {
  armLandingMessageRetry,
  resolveLandingMessageRetry,
  RETRY_LANDING_MESSAGE_ACTION_ID,
  retryLandingMessageActionToken,
} from './landing-message-retry'
import { MemoryTaskStore, type StoredTask, type TaskStore } from './store'

export class AgentGatewayError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly retryable = false,
    readonly latest?: StoredTask,
  ) {
    super(message)
  }
}

export type AgentGatewayOptions = {
  store?: TaskStore
  now?: () => string
  createId?: () => string
  compose?: (task: AirportPickupTaskState) => UISpec
  /**
   * Side-effect runtime for opaque confirmations and preference-backed notify.
   * When provided, its preferences are authoritative for landing-notify auth.
   */
  runtime?: SideEffectRuntime
  /** @deprecated Prefer `runtime.preferences`; used only when `runtime` is omitted. */
  preferences?: Record<string, MemberPreferenceRecord>
}

export class AgentGateway {
  readonly #store: TaskStore
  readonly #now: () => string
  readonly #createId: () => string
  readonly #compose: (task: AirportPickupTaskState) => UISpec
  readonly #runtime: SideEffectRuntime
  readonly #preferences: Record<string, MemberPreferenceRecord>

  constructor(options: AgentGatewayOptions = {}) {
    this.#store = options.store ?? new MemoryTaskStore()
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? (() => crypto.randomUUID())
    const runtime = options.runtime ?? createSideEffectRuntime()
    if (!options.runtime && options.preferences) {
      for (const key of Object.keys(runtime.preferences)) delete runtime.preferences[key]
      for (const [memberId, record] of Object.entries(options.preferences)) {
        runtime.preferences[memberId] = { ...record }
      }
    }
    this.#runtime = runtime
    this.#preferences = runtime.preferences
    this.#compose = options.compose ?? ((task) => composeAgentSpec(task, this.#preferences))
  }

  createTask(input: CreateTaskRequest): AgentResponse {
    const startedAt = performance.now()
    const request = createTaskRequestSchema.parse(input)
    const existing = this.#store.getByClientRequestId(request.clientRequestId)
    if (existing) return this.#response(request.clientRequestId, existing, [], performance.now() - startedAt)
    const taskId = `pickup-${this.#createId()}`
    const timestamp = this.#now()
    const flightNumber = normalizeFlightNumber(request.input.text)
    let task = createInitialTask(taskId, timestamp)
    task = { ...task, passengers: extractPassengers(request.input.text) }
    task = applyEvent(task, {
      eventId: `${request.clientRequestId}:input`,
      type: 'user.input',
      text: flightNumber ?? request.input.text,
      timestamp,
    }, this.#preferences)
    const stored = this.#store.create(this.#publish(task), request.clientRequestId)
    return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
  }

  getTask(taskId: string, requestId = this.#createId()): AgentResponse {
    const startedAt = performance.now()
    const stored = this.#requireTask(taskId)
    return this.#response(requestId, stored, [], performance.now() - startedAt)
  }

  submitEvent(taskId: string, input: SubmitEventRequest): AgentResponse {
    const startedAt = performance.now()
    const request = submitEventRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    const previous = this.#store.getEventResult(taskId, request.event.eventId)
    if (previous) return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    if (request.event.type === 'navigation.started') {
      throw new AgentGatewayError('POLICY_DENIED', 'Navigation must be started through a registered action', false, current)
    }
    if (request.expectedTaskRevision !== current.task.taskRevision) {
      throw new AgentGatewayError(
        'TASK_REVISION_CONFLICT',
        `Expected task revision ${request.expectedTaskRevision}, received ${current.task.taskRevision}`,
        false,
        current,
      )
    }

    const effects = planEffects(current.task, request.event, {}, this.#preferences)
    const next = applyEvent(current.task, request.event, this.#preferences)
    const stored = next === current.task
      ? current
      : this.#store.save(this.#publish(next))
    const effectRecords = effects.map((effect, index) => ({ ...effect, effectId: `${request.event.eventId}:${index}` }))
    this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: effectRecords })
    return this.#response(
      request.clientRequestId,
      stored,
      effectRecords,
      performance.now() - startedAt,
    )
  }

  submitAction(taskId: string, input: SubmitActionRequest): AgentResponse {
    const startedAt = performance.now()
    const request = submitActionRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    const operation = `action:${request.actionId}:${request.componentId}`
    const previous = this.#store.getIdempotencyResult(taskId, operation, request.idempotencyKey)
    if (previous) return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    this.#assertRevisions(current, request.expectedTaskRevision, request.expectedUiRevision)

    if (request.actionId === RETRY_LANDING_MESSAGE_ACTION_ID) {
      return this.#submitRetryLandingMessage(taskId, current, request, operation, startedAt)
    }

    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    if (
      current.task.phase !== 'preparing'
      || action?.event.type !== 'tool-request'
      || action.event.actionToken !== 'start-navigation'
      || request.actionId !== 'start-navigation'
      || !component?.actions?.includes(request.actionId)
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Action is not registered for the current task state', false, current)
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const event = {
      eventId: `action:${request.idempotencyKey}`,
      type: 'navigation.started' as const,
      routeId: `route-airport-${current.task.taskId}`,
      timestamp,
    }
    const { stored, effectRecords } = this.#applyAuthorizedEvent(current, event)
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: effectRecords })
    return this.#response(request.clientRequestId, stored, effectRecords, performance.now() - startedAt)
  }

  submitConfirmation(taskId: string, confirmationId: string, input: SubmitConfirmationRequest): AgentResponse {
    const startedAt = performance.now()
    const request = submitConfirmationRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    const operation = `confirmation:${confirmationId}:${request.decision}`
    const previous = this.#store.getIdempotencyResult(taskId, operation, request.idempotencyKey)
    if (previous) return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    this.#assertRevisions(current, request.expectedTaskRevision)

    const pending = current.task.pendingConfirmation
    if (!pending || pending.confirmationId !== confirmationId) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current confirmation is available', false, current)
    }
    if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.parse(this.#now())) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'The confirmation has expired', false, current)
    }

    if (pending.action === 'send-message') {
      return this.#submitSendMessageConfirmation(taskId, confirmationId, current, request, operation, startedAt)
    }

    if (pending.action !== 'save-memory') {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current save-memory confirmation is available', false, current)
    }

    // Fixture mode only: both decisions close the prompt without writing long-term memory.
    const resolved = resolveConfirmation(current.task, confirmationId)
    const stored = this.#store.save(this.#publish({ ...resolved, updatedAt: this.#eventTimestamp(current.task.updatedAt) }))
    const effects: AgentResponse['effects'] = []
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #submitRetryLandingMessage(
    taskId: string,
    current: StoredTask,
    request: SubmitActionRequest,
    operation: string,
    startedAt: number,
  ): AgentResponse {
    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    const expectedToken = retryLandingMessageActionToken(current.task.taskId)
    if (
      current.task.message.status !== 'failed'
      || request.componentId !== 'message-preview'
      || action?.event.type !== 'tool-request'
      || action.event.actionToken !== expectedToken
      || !component?.actions?.includes(RETRY_LANDING_MESSAGE_ACTION_ID)
      || current.task.pendingConfirmation?.action === 'send-message'
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Retry landing-message action is not registered for the current task state', false, current)
    }

    const armed = armLandingMessageRetry(current.task, this.#runtime)
    if (!armed) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Landing-message retry is not available for the current authorization state', false, current)
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const stored = this.#store.save(this.#publish({ ...armed, updatedAt: timestamp }))
    const effects: AgentResponse['effects'] = []
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #submitSendMessageConfirmation(
    taskId: string,
    confirmationId: string,
    current: StoredTask,
    request: SubmitConfirmationRequest,
    operation: string,
    startedAt: number,
  ): AgentResponse {
    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const resolved = resolveLandingMessageRetry(
      current.task,
      this.#runtime,
      confirmationId,
      request.decision,
      timestamp,
    )
    if (!resolved) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current send-message confirmation is available', false, current)
    }

    let nextTask: AirportPickupTaskState
    let effects: AgentResponse['effects'] = []
    if (resolved.decision === 'reject') {
      nextTask = resolved.task
    } else {
      nextTask = applyEvent(resolved.task, resolved.event, this.#preferences)
      effects = [{
        effectId: `${resolved.event.eventId}:0`,
        type: 'message.send',
        status: resolved.sendSucceeded ? 'succeeded' : 'failed',
        tool: 'message.send',
        ...(resolved.sendSucceeded ? {} : { errorCode: resolved.event.type === 'message.failed' ? resolved.event.errorCode : 'SEND_FAILED' }),
      }]
    }

    const stored = this.#store.save(this.#publish(nextTask))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #publish(task: AirportPickupTaskState): StoredTask {
    const ui = this.#compose(task)
    const publishedUi = task.phase === 'preparing'
      ? {
          ...ui,
          components: ui.components.map((component) => component.id === 'flight-status'
            ? { ...component, actions: [...(component.actions ?? []), 'start-navigation'] }
            : component),
          actions: [
            ...ui.actions.filter((action) => action.id !== 'start-navigation'),
            {
              id: 'start-navigation',
              label: '开始导航',
              style: 'primary' as const,
              event: { type: 'tool-request' as const, actionToken: 'start-navigation' },
            },
          ],
        }
      : ui
    return { task: { ...task, uiRevision: publishedUi.uiRevision }, ui: publishedUi }
  }

  #applyAuthorizedEvent(current: StoredTask, event: Parameters<typeof applyEvent>[1]): { stored: StoredTask; effectRecords: AgentResponse['effects'] } {
    const effects = planEffects(current.task, event, {}, this.#preferences)
    const next = applyEvent(current.task, event, this.#preferences)
    const stored = next === current.task ? current : this.#store.save(this.#publish(next))
    const effectRecords = effects.map((effect, index) => ({ ...effect, effectId: `${event.eventId}:${index}` }))
    return { stored, effectRecords }
  }

  #assertRevisions(current: StoredTask, expectedTaskRevision: number, expectedUiRevision?: number): void {
    if (expectedTaskRevision !== current.task.taskRevision) {
      throw new AgentGatewayError(
        'TASK_REVISION_CONFLICT',
        `Expected task revision ${expectedTaskRevision}, received ${current.task.taskRevision}`,
        false,
        current,
      )
    }
    if (expectedUiRevision !== undefined && expectedUiRevision !== current.ui.uiRevision) {
      throw new AgentGatewayError(
        'UI_REVISION_CONFLICT',
        `Expected UI revision ${expectedUiRevision}, received ${current.ui.uiRevision}`,
        false,
        current,
      )
    }
  }

  #eventTimestamp(updatedAt: string): string {
    const now = this.#now()
    return Date.parse(now) < Date.parse(updatedAt) ? updatedAt : now
  }

  #requireTask(taskId: string): StoredTask {
    const stored = this.#store.get(taskId)
    if (!stored) throw new AgentGatewayError('TASK_NOT_FOUND', `Task not found: ${taskId}`)
    return stored
  }

  #response(
    requestId: string,
    stored: StoredTask,
    effects: AgentResponse['effects'],
    durationMs: number,
  ): AgentResponse {
    const assistant = stored.task.phase === 'collecting-information'
      ? { text: '好的，请告诉我她们的航班号。', shouldSpeak: true }
      : undefined
    return agentResponseSchema.parse({
      requestId,
      task: stored.task,
      ui: stored.ui,
      assistant,
      effects,
      meta: { mode: 'fixture', durationMs, fallbackUsed: stored.ui.meta.generatedBy === 'fallback' },
    })
  }
}

function extractPassengers(text: string): AirportPickupTaskState['passengers'] {
  const names = ['妈妈', '豆豆'].filter((name) => text.includes(name))
  return {
    memberIds: names.map((name) => name === '妈妈' ? 'mom' : 'doubao'),
    names,
    confirmedOnboard: false,
  }
}
