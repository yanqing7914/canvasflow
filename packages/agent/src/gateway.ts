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
import { applyEvent, createInitialTask, resolveConfirmation } from './index'
import { normalizeFlightNumber } from './flight-number'
import { composeAgentSpec } from './composer'
import { planEffects } from './effects'
import {
  ReadToolOrchestrationError,
  ReadToolOrchestrator,
  type ReadToolOrchestration,
  type ReadToolResults,
} from './orchestration'
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
  compose?: (task: AirportPickupTaskState, toolResults?: ReadToolResults) => UISpec
  orchestrator?: ReadToolOrchestration
}

export class AgentGateway {
  readonly #store: TaskStore
  readonly #now: () => string
  readonly #createId: () => string
  readonly #compose: (task: AirportPickupTaskState, toolResults?: ReadToolResults) => UISpec
  readonly #orchestrator: ReadToolOrchestration

  constructor(options: AgentGatewayOptions = {}) {
    this.#store = options.store ?? new MemoryTaskStore()
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? (() => crypto.randomUUID())
    this.#compose = options.compose ?? composeAgentSpec
    this.#orchestrator = options.orchestrator ?? new ReadToolOrchestrator()
  }

  createTask(input: CreateTaskRequest): AgentResponse {
    const startedAt = performance.now()
    const request = createTaskRequestSchema.parse(input)
    const existing = this.#store.getByClientRequestId(request.clientRequestId)
    if (existing) return this.#response(request.clientRequestId, existing, [], performance.now() - startedAt)
    const taskId = `pickup-${this.#createId()}`
    const timestamp = this.#now()
    const flightNumber = normalizeFlightNumber(request.input.text)
    try {
      const labels = extractPassengerLabels(request.input.text)
      const passengerReads = this.#orchestrator.resolveInitialPassengers(taskId, request.clientRequestId, labels)
      let task = createInitialTask(taskId, timestamp)
      task = {
        ...task,
        passengers: { ...passengerReads.passengers, confirmedOnboard: false },
        message: { ...task.message, autoNotifyAuthorized: passengerReads.notificationAuthorized },
      }
      task = applyEvent(task, {
        eventId: `${request.clientRequestId}:input`,
        type: 'user.input',
        text: flightNumber ?? request.input.text,
        timestamp,
      })
      let toolResults = passengerReads.toolResults
      if (flightNumber && task.passengers.memberIds.length > 0) {
        const prepared = this.#prepareTask(task, request.clientRequestId, flightNumber)
        task = prepared.task
        toolResults = { ...toolResults, ...prepared.toolResults }
      }
      const stored = this.#store.create(this.#publish(task, toolResults), request.clientRequestId)
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    } catch (error) {
      this.#throwProviderError(error)
    }
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

    const effects = planEffects(current.task, request.event, {})
    let next = applyEvent(current.task, request.event)
    let toolResults = current.toolResults
    const flightNumber = request.event.type === 'user.input' ? normalizeFlightNumber(request.event.text) : undefined
    if (flightNumber && next !== current.task && next.phase === 'preparing' && next.passengers.memberIds.length > 0) {
      try {
        const prepared = this.#prepareTask(next, request.clientRequestId, flightNumber)
        next = prepared.task
        toolResults = { ...toolResults, ...prepared.toolResults }
      } catch (error) {
        this.#throwProviderError(error, current)
      }
    }
    const stored = next === current.task
      ? current
      : this.#store.save(this.#publish(next, toolResults))
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

    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    if (
      current.task.phase !== 'preparing'
      || action?.event.type !== 'tool-request'
      || action.event.actionToken !== 'start-navigation'
      || request.actionId !== 'start-navigation'
      || component?.id !== 'navigation-plan'
      || !component.actions?.includes(request.actionId)
      || !current.toolResults?.['navigation.plan-route']
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Action is not registered for the current task state', false, current)
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const event = {
      eventId: `action:${request.idempotencyKey}`,
      type: 'navigation.started' as const,
      routeId: current.toolResults['navigation.plan-route'].data.routeId,
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
    if (pending?.action !== 'save-memory' || pending.confirmationId !== confirmationId) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current save-memory confirmation is available', false, current)
    }
    if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.parse(this.#now())) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'The save-memory confirmation has expired', false, current)
    }

    // Fixture mode only: both decisions close the prompt without writing long-term memory.
    const resolved = resolveConfirmation(current.task, confirmationId)
    const stored = this.#store.save(this.#publish(
      { ...resolved, updatedAt: this.#eventTimestamp(current.task.updatedAt) },
      current.toolResults,
    ))
    const effects: AgentResponse['effects'] = []
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #publish(task: AirportPickupTaskState, toolResults?: ReadToolResults): StoredTask {
    const ui = this.#compose(task, toolResults)
    const canStartNavigation = task.phase === 'preparing'
      && toolResults?.['navigation.plan-route'] !== undefined
      && ui.components.some((component) => component.id === 'navigation-plan')
    const publishedUi = canStartNavigation
      ? {
          ...ui,
          components: ui.components.map((component) => component.id === 'navigation-plan'
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
    return { task: { ...task, uiRevision: publishedUi.uiRevision }, ui: publishedUi, toolResults }
  }

  #applyAuthorizedEvent(current: StoredTask, event: Parameters<typeof applyEvent>[1]): { stored: StoredTask; effectRecords: AgentResponse['effects'] } {
    const effects = planEffects(current.task, event, {})
    const next = applyEvent(current.task, event)
    const stored = next === current.task ? current : this.#store.save(this.#publish(next, current.toolResults))
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

  #prepareTask(task: AirportPickupTaskState, requestId: string, flightNumber: string) {
    const reads = this.#orchestrator.prepareTrip(task.taskId, requestId, flightNumber)
    return {
      task: {
        ...task,
        flight: {
          flightNumber: reads.flight.flightNumber,
          status: reads.flight.status,
          estimatedArrival: reads.flight.estimatedArrival,
          terminal: reads.flight.terminal,
          baggageClaim: reads.flight.baggageClaim,
        },
        navigation: {
          routeId: reads.route.routeId,
          destination: '虹桥机场 T2',
          eta: reads.route.arrivalTime,
          status: 'planned' as const,
        },
        charging: {
          ...task.charging,
          recommended: reads.charging.recommended,
          status: reads.charging.recommended ? 'planned' as const : 'none' as const,
        },
      },
      toolResults: reads.toolResults,
    }
  }

  #throwProviderError(error: unknown, latest?: StoredTask): never {
    if (error instanceof ReadToolOrchestrationError) {
      throw new AgentGatewayError(error.code, error.message, error.retryable, latest)
    }
    throw error
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

function extractPassengerLabels(text: string): string[] {
  return ['妈妈', '豆豆'].filter((name) => text.includes(name))
}
