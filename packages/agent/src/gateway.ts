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
  createProviderRegistry,
  createSideEffectRuntime,
  type MemberPreferenceRecord,
  type ProviderRegistry,
  type SideEffectRuntime,
} from '@canvasflow/tools'
import { applyEvent, createInitialTask, resolveConfirmation } from './index'
import { normalizeFlightNumber } from './flight-number'
import { mergePassengers, parsePassengerLabels, parsePassengers } from './passengers'
import { composeAgentSpec } from './composer'
import { planEffects } from './effects'
import { EffectExecutor, type PolicyGate } from './effect-executor'
import {
  armLandingMessageRetry,
  resolveLandingMessageRetry,
  RETRY_LANDING_MESSAGE_ACTION_ID,
  retryLandingMessageActionToken,
} from './landing-message-retry'
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
  compose?: (
    task: AirportPickupTaskState,
    toolResults?: ReadToolResults,
    preferences?: Record<string, MemberPreferenceRecord>,
  ) => UISpec
  orchestrator?: ReadToolOrchestration
  providers?: ProviderRegistry
  policyGate?: PolicyGate
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
  readonly #compose: (
    task: AirportPickupTaskState,
    toolResults?: ReadToolResults,
    preferences?: Record<string, MemberPreferenceRecord>,
  ) => UISpec
  readonly #orchestrator: ReadToolOrchestration
  readonly #effectExecutor: EffectExecutor
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
    this.#compose = options.compose ?? composeAgentSpec
    const providers = options.providers ?? createProviderRegistry(runtime)
    this.#orchestrator = options.orchestrator ?? new ReadToolOrchestrator({
      registry: providers,
    })
    this.#effectExecutor = new EffectExecutor(providers, options.policyGate)
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
      const labels = parsePassengerLabels(request.input.text)
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
        text: request.input.text,
        timestamp,
      }, this.#preferences)
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
    if (request.event.type === 'navigation.started') {
      throw new AgentGatewayError('POLICY_DENIED', 'Navigation must be started through a registered action', false, current)
    }
    const previous = this.#store.getEventResult(taskId, request.event.eventId)
    if (previous) return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    if (request.expectedTaskRevision !== current.task.taskRevision) {
      throw new AgentGatewayError(
        'TASK_REVISION_CONFLICT',
        `Expected task revision ${request.expectedTaskRevision}, received ${current.task.taskRevision}`,
        false,
        current,
      )
    }

    const effects = planEffects(current.task, request.event, current.toolResults ?? {}, this.#preferences)
    let next = applyEvent(current.task, request.event, this.#preferences)
    let toolResults = current.toolResults
    const flightNumber = request.event.type === 'user.input' ? normalizeFlightNumber(request.event.text) : undefined
    const parsedPassengers = request.event.type === 'user.input' ? parsePassengers(request.event.text) : undefined
    const shouldPrepare = request.event.type === 'user.input'
      && next !== current.task
      && next.phase === 'preparing'
      && next.passengers.memberIds.length > 0
      && (
        current.task.phase !== 'preparing'
        || current.task.passengers.memberIds.length !== next.passengers.memberIds.length
        || current.task.flight?.flightNumber !== next.flight?.flightNumber
        || flightNumber !== undefined
      )
    if (shouldPrepare) {
      try {
        let passengerToolResults: ReadToolResults = {}
        if (parsedPassengers) {
          const mergedPassengers = mergePassengers(current.task.passengers, parsedPassengers)
          const passengerReads = this.#orchestrator.resolveInitialPassengers(
            taskId,
            request.clientRequestId,
            mergedPassengers.names,
          )
          next.passengers = mergePassengers(current.task.passengers, passengerReads.passengers)
          next.message = { ...next.message, autoNotifyAuthorized: passengerReads.notificationAuthorized }
          passengerToolResults = passengerReads.toolResults
        }
        const prepared = this.#prepareTask(next, request.clientRequestId, next.flight!.flightNumber)
        next = prepared.task
        toolResults = { ...toolResults, ...passengerToolResults, ...prepared.toolResults }
      } catch (error) {
        this.#throwProviderError(error, current)
      }
    }
    if (
      request.event.type === 'user.confirmed-passengers-onboard'
      && (current.task.phase === 'waiting-for-passengers' || current.task.phase === 'returning-home')
      && next.phase === 'returning-home'
    ) {
      try {
        const preferences = this.#orchestrator.resolveReturnTripPreferences(
          taskId,
          request.clientRequestId,
          next.passengers.memberIds,
        )
        toolResults = { ...toolResults, 'memory.get-preferences': preferences }
        const records = preferences.data.members
        const homeDestinationId = records.find((member) => member.homeDestinationId)?.homeDestinationId
        const cabinMember = records.find((member) => member.rearTemperatureC !== undefined || member.mediaTitle !== undefined)
        const mediaMember = records.find((member) => member.mediaTitle !== undefined)
        const execution = this.#effectExecutor.executeReturnTrip({
          task: next,
          memberIds: next.passengers.memberIds,
          preferences: {
            homeDestinationId,
            temperatureC: cabinMember?.rearTemperatureC,
            mediaTitle: mediaMember?.mediaTitle,
            mediaMemberId: mediaMember?.memberId,
          },
          idempotencyKey: request.event.eventId,
          effectIdPrefix: `${request.event.eventId}:effect`,
        })
        if (execution.navigation) {
          next.navigation = {
            routeId: execution.navigation.routeId,
            destination: execution.navigation.destination,
            eta: execution.navigation.eta,
            status: 'active',
          }
        }
        if (!execution.succeeded) {
          // Keep the task aligned with effects that already reached providers.
          // A later event can retry the remaining providers without claiming
          // that passengers are still waiting at the airport.
          const stored = this.#store.save(this.#publish(next, toolResults))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: execution.effect })
          return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
        }
        const stored = this.#store.save(this.#publish(next, toolResults))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: execution.effect })
        return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
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

    if (request.actionId === RETRY_LANDING_MESSAGE_ACTION_ID) {
      return this.#submitRetryLandingMessage(taskId, current, request, operation, startedAt)
    }

    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    if (
      action?.event.type !== 'tool-request'
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
    const execution = this.#effectExecutor.startNavigation({
      task: current.task,
      routeId: event.routeId,
      idempotencyKey: request.idempotencyKey,
      effectId: `${event.eventId}:0`,
    })
    const stored = execution.succeeded
      ? this.#store.save(this.#publish(applyEvent(current.task, event, this.#preferences), current.toolResults))
      : current
    const effectRecords = [execution.effect]
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
    const stored = this.#store.save(this.#publish(
      { ...resolved, updatedAt: this.#eventTimestamp(current.task.updatedAt) },
      current.toolResults,
    ))
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
    const stored = this.#store.save(this.#publish({ ...armed, updatedAt: timestamp }, current.toolResults))
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

    const stored = this.#store.save(this.#publish(nextTask, current.toolResults))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #publish(task: AirportPickupTaskState, toolResults?: ReadToolResults): StoredTask {
    const ui = this.#compose(task, toolResults, this.#preferences)
    const uiWithoutStartNavigation = {
      ...ui,
      components: ui.components.map((component) => component.actions?.includes('start-navigation')
        ? { ...component, actions: component.actions.filter((actionId) => actionId !== 'start-navigation') }
        : component),
      actions: ui.actions.filter((action) => action.id !== 'start-navigation'),
    }
    const trustedRoute = toolResults?.['navigation.plan-route']
    const trustedRouteId = trustedRoute?.ok === true && trustedRoute.data !== null
      ? trustedRoute.data.routeId
      : undefined
    const canStartNavigation = task.phase === 'preparing'
      && task.flight?.status !== 'cancelled'
      && task.navigation?.status === 'planned'
      && trustedRoute?.ok === true
      && trustedRoute.data !== null
      && task.navigation.routeId === trustedRouteId
      && uiWithoutStartNavigation.components.some((component) => component.id === 'navigation-plan')
    const publishedUi = canStartNavigation
      ? {
          ...uiWithoutStartNavigation,
          components: uiWithoutStartNavigation.components.map((component) => component.id === 'navigation-plan'
            ? { ...component, actions: [...(component.actions ?? []), 'start-navigation'] }
            : component),
          actions: [
            ...uiWithoutStartNavigation.actions,
            {
              id: 'start-navigation',
              label: '开始导航',
              style: 'primary' as const,
              event: { type: 'tool-request' as const, actionToken: 'start-navigation' },
            },
          ],
        }
      : uiWithoutStartNavigation
    return { task: { ...task, uiRevision: publishedUi.uiRevision }, ui: publishedUi, toolResults }
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
          scheduledArrival: reads.flight.scheduledArrival,
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
      ? {
          text: stored.task.flight === undefined
            ? '好的，请告诉我她们的航班号。'
            : '好的，请告诉我要接哪位家人。',
          shouldSpeak: true,
        }
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
