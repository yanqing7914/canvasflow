import {
  agentResponseSchema,
  cancelTaskRequestSchema,
  createTaskRequestSchema,
  resetTaskRequestSchema,
  submitActionRequestSchema,
  submitConfirmationRequestSchema,
  submitEventRequestSchema,
  type AgentErrorCode,
  type AgentResponse,
  type AirportPickupTaskState,
  type CancelTaskRequest,
  type CreateTaskRequest,
  type ResetTaskRequest,
  type SubmitActionRequest,
  type SubmitConfirmationRequest,
  type SubmitEventRequest,
  type ReturnTripState,
  type UISpec,
  type ProviderMode,
} from '@canvasflow/schema'
import {
  buildLandingNotifyContent,
  createProviderRegistry,
  issueAutoNotifyAuthorization,
  resolveAuthorizedLandingContact,
  resetSideEffectRuntimeTask,
  createSideEffectRuntime,
  type MemberPreferenceRecord,
  type ProviderRegistry,
  type SideEffectRuntime,
} from '@canvasflow/tools'
import { applyEvent, createInitialTask } from './index'
import { mergePassengers } from './passengers'
import { applyRequestPresentation, composeAgentSpec, composeFallbackSpec } from './composer'
import { planEffects } from './effects'
import { EffectExecutor, type PolicyGate } from './effect-executor'
import { Planner, type Plan, type PlannerInput } from './planner'
import {
  armLandingMessageRetry,
  resolveLandingMeetingEta,
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
import { MemoryTaskStore, type StoredTask, type TaskStore, type TaskUpdateRead } from './store'

function enforceGatewayProviderMode(registry: ProviderRegistry, mode: ProviderMode): ProviderRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([name, provider]) => [
      name,
      (context: Parameters<typeof provider>[0], input?: unknown) => {
        const result = provider(context, input)
        if (!result || typeof result !== 'object' || result.meta?.provider !== mode) {
          throw Object.assign(new Error(`Provider ${name} returned an unexpected mode`), { code: 'PROVIDER_FAILED' })
        }
        return result
      },
    ]),
  ) as ProviderRegistry
}

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
  planner?: Pick<Planner, 'plan'>
  mode?: ProviderMode
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
  readonly #planner: Pick<Planner, 'plan'>
  readonly #runtime: SideEffectRuntime
  readonly #preferences: Record<string, MemberPreferenceRecord>
  readonly #mode: ProviderMode

  constructor(options: AgentGatewayOptions = {}) {
    this.#store = options.store ?? new MemoryTaskStore()
    this.#mode = options.mode ?? 'fixture'
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
    const providers = enforceGatewayProviderMode(
      options.providers ?? createProviderRegistry(runtime, this.#mode === 'live' ? 'fixture' : this.#mode),
      this.#mode,
    )
    this.#orchestrator = options.orchestrator ?? new ReadToolOrchestrator({
      registry: providers,
    })
    this.#effectExecutor = new EffectExecutor(providers, options.policyGate)
    this.#planner = options.planner ?? new Planner()
  }

  createTask(input: CreateTaskRequest): AgentResponse {
    const startedAt = performance.now()
    const request = createTaskRequestSchema.parse(input)
    const existing = this.#store.getByClientRequestId(request.clientRequestId)
    if (existing) return this.#response(request.clientRequestId, existing, [], performance.now() - startedAt)
    const taskId = `pickup-${this.#createId()}`
    const timestamp = this.#now()
    const requestContext: NonNullable<StoredTask['requestContext']> = {
      vehicle: request.vehicleContext,
      clientCapabilities: request.clientCapabilities,
      destination: request.destination ?? { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      ...(request.input.confidence === undefined ? {} : { inputConfidence: request.input.confidence }),
      updatedAt: timestamp,
    }
    if (request.input.confidence !== undefined && request.input.confidence < 0.6) {
      const stored = this.#store.create(this.#publish(createInitialTask(taskId, timestamp), {}, requestContext), request.clientRequestId)
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    }
    let task = createInitialTask(taskId, timestamp)
    const plan = this.#planUserInput(request.input.text, task, `${request.clientRequestId}:input`, timestamp)
    const flightNumber = plan.slotUpdates.flightNumber
    const parsedPassengers = plan.slotUpdates.passengers
    if (parsedPassengers) {
      task = {
        ...task,
        passengers: parsedPassengers,
        message: { ...task.message, autoNotifyAuthorized: false },
      }
    }
    task = applyEvent(task, {
      eventId: `${request.clientRequestId}:input`,
      type: 'user.input',
      text: request.input.text,
      timestamp,
    }, this.#preferences, { userInputSlots: { passengers: parsedPassengers, flightNumber } })
    let toolResults: ReadToolResults = {}
    try {
      const labels = parsedPassengers?.names ?? []
      const passengerReads = this.#orchestrator.resolveInitialPassengers(taskId, request.clientRequestId, labels)
      task = {
        ...task,
        passengers: { ...passengerReads.passengers, confirmedOnboard: false },
        message: { ...task.message, autoNotifyAuthorized: passengerReads.notificationAuthorized },
      }
      toolResults = passengerReads.toolResults
      if (flightNumber && task.passengers.memberIds.length > 0) {
        const prepared = this.#prepareTask(task, request.clientRequestId, flightNumber, requestContext)
        task = prepared.task
        toolResults = { ...toolResults, ...prepared.toolResults }
      }
      const stored = this.#store.create(this.#publish(task, toolResults, requestContext), request.clientRequestId)
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    } catch (error) {
      if (error instanceof ReadToolOrchestrationError) {
        const stored = this.#store.create(
          this.#publishFallback(task, toolResults, error, undefined, requestContext),
          request.clientRequestId,
        )
        return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
      }
      this.#throwProviderError(error)
    }
  }

  getTask(taskId: string, requestId = this.#createId()): AgentResponse {
    const startedAt = performance.now()
    const stored = this.#requireTask(taskId)
    return this.#response(requestId, stored, [], performance.now() - startedAt)
  }

  getTaskUpdates(taskId: string, afterCursor?: number): TaskUpdateRead {
    this.#requireTask(taskId)
    return this.#store.readTaskUpdates(taskId, afterCursor)
  }

  hasCreateResult(clientRequestId: string): boolean {
    return this.#store.getByClientRequestId(clientRequestId) !== undefined
  }

  cancelTask(taskId: string, input: CancelTaskRequest): AgentResponse {
    const request = cancelTaskRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    return this.submitEvent(taskId, {
      clientRequestId: request.clientRequestId,
      expectedTaskRevision: request.expectedTaskRevision,
      event: {
        eventId: `cancel:${request.eventId}`,
        type: 'user.cancelled-task',
        ...(request.reason ? { reason: request.reason } : {}),
        timestamp: this.#eventTimestamp(current.task.updatedAt),
      },
    })
  }

  resetTask(taskId: string, input: ResetTaskRequest): AgentResponse {
    const startedAt = performance.now()
    const request = resetTaskRequestSchema.parse(input)
    const current = this.#requireTask(taskId)
    const operation = 'task:reset'
    const previous = this.#store.getIdempotencyResult(taskId, operation, request.clientRequestId)
    if (previous) {
      return this.#response(request.clientRequestId, previous.stored, previous.effects, performance.now() - startedAt)
    }
    this.#assertRevisions(current, request.expectedTaskRevision)

    let effects: AgentResponse['effects'] = []
    if (current.task.pendingConfirmation?.action === 'send-message') {
      const revocation = this.#effectExecutor.revokeLandingMessageConfirmation({
        task: current.task,
        confirmationId: current.task.pendingConfirmation.confirmationId,
        idempotencyKey: `${request.clientRequestId}:reset`,
        effectId: `${current.task.pendingConfirmation.confirmationId}:reset`,
      })
      effects = [revocation.effect]
      if (!revocation.succeeded) {
        const reconciled = revocation.ambiguous
          ? this.#store.save(this.#publish({
              ...current.task,
              taskRevision: current.task.taskRevision + 1,
              pendingConfirmation: undefined,
            }, current.toolResults, current.requestContext))
          : current
        this.#store.recordIdempotencyResult(taskId, operation, request.clientRequestId, { stored: reconciled, effects })
        return this.#response(request.clientRequestId, reconciled, effects, performance.now() - startedAt)
      }
    }

    if (current.task.message.authorizationId) {
      const revocation = this.#effectExecutor.revokeLandingMessageAuthorization({
        task: current.task,
        authorizationId: current.task.message.authorizationId,
        idempotencyKey: `${request.clientRequestId}:reset-authorization`,
        effectId: `${current.task.message.authorizationId}:reset-authorization`,
      })
      effects = [...effects, revocation.effect]
      if (!revocation.succeeded) {
        const reconciled = revocation.ambiguous
          ? this.#store.save(this.#publish({
              ...current.task,
              taskRevision: current.task.taskRevision + 1,
              message: { ...current.task.message, authorizationId: undefined },
            }, current.toolResults, current.requestContext))
          : current
        this.#store.recordIdempotencyResult(taskId, operation, request.clientRequestId, { stored: reconciled, effects })
        return this.#response(request.clientRequestId, reconciled, effects, performance.now() - startedAt)
      }
    }

    resetSideEffectRuntimeTask(this.#runtime, taskId)

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const initial = createInitialTask(taskId, timestamp)
    const resetTask: AirportPickupTaskState = {
      ...initial,
      taskRevision: current.task.taskRevision + 1,
      uiRevision: Math.max(current.task.uiRevision, current.ui.uiRevision),
    }
    const requestContext = current.requestContext
      ? {
          ...current.requestContext,
          inputConfidence: undefined,
          updatedAt: Date.parse(current.requestContext.updatedAt ?? timestamp) > Date.parse(timestamp)
            ? current.requestContext.updatedAt
            : timestamp,
        }
      : undefined
    const stored = this.#store.reset(this.#publish(resetTask, undefined, requestContext))
    this.#store.recordIdempotencyResult(taskId, operation, request.clientRequestId, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
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

    const plan = request.event.type === 'user.input'
      ? this.#planUserInput(request.event.text, current.task, request.event.eventId, request.event.timestamp)
      : undefined
    let next = applyEvent(
      current.task,
      request.event,
      this.#preferences,
      plan ? { userInputSlots: {
        passengers: plan.slotUpdates.passengers,
        flightNumber: plan.slotUpdates.flightNumber,
      } } : undefined,
    )
    const taskChanged = JSON.stringify(next) !== JSON.stringify(current.task)
    const accepted = taskChanged
      || this.#acceptsContextOnlyEvent(current.task, current.requestContext, request.event)
    if (!accepted) {
      const stored = current
      this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    }

    // Only revoke live capabilities after freshness and reducer acceptance checks.
    // A stale terminal event must not consume a credential that remains visible in state.
    let preEffects: AgentResponse['effects'] = []
    let cleanupTask = current.task
    const terminalEvent = request.event.type === 'user.cancelled-task'
      || (request.event.type === 'flight.updated' && request.event.flight.status === 'cancelled')
      || (request.event.type === 'message.failed' && current.task.message.pendingMessageId === request.event.messageId)
    if (terminalEvent && current.task.message.authorizationId) {
      const revocation = this.#effectExecutor.revokeLandingMessageAuthorization({
        task: current.task,
        authorizationId: current.task.message.authorizationId,
        idempotencyKey: `${request.event.eventId}:landing-authorization`,
        effectId: `${request.event.eventId}:landing-authorization`,
      })
      preEffects = [revocation.effect]
      if (!revocation.succeeded) {
        const reconciled = revocation.ambiguous
          ? this.#store.save(this.#publish({
              ...current.task,
              taskRevision: current.task.taskRevision + 1,
              message: { ...current.task.message, authorizationId: undefined },
            }, current.toolResults, current.requestContext))
          : current
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: reconciled, effects: preEffects })
        return this.#response(request.clientRequestId, reconciled, preEffects, performance.now() - startedAt)
      }
      cleanupTask = {
        ...cleanupTask,
        taskRevision: cleanupTask.taskRevision + 1,
        message: { ...cleanupTask.message, authorizationId: undefined },
      }
    }
    if (terminalEvent && current.task.pendingConfirmation?.action === 'send-message') {
      const revocation = this.#effectExecutor.revokeLandingMessageConfirmation({
        task: current.task,
        confirmationId: current.task.pendingConfirmation.confirmationId,
        idempotencyKey: `${request.event.eventId}:terminal-message`,
        effectId: `${current.task.pendingConfirmation.confirmationId}:terminal-message`,
      })
      preEffects = [...preEffects, revocation.effect]
      if (!revocation.succeeded) {
        const reconciledTask = revocation.ambiguous
          ? { ...cleanupTask, taskRevision: cleanupTask.taskRevision + 1, pendingConfirmation: undefined }
          : cleanupTask
        const stored = reconciledTask === current.task
          ? current
          : this.#store.save(this.#publish(reconciledTask, current.toolResults, current.requestContext))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: preEffects })
        return this.#response(request.clientRequestId, stored, preEffects, performance.now() - startedAt)
      }
      cleanupTask = { ...cleanupTask, taskRevision: cleanupTask.taskRevision + 1, pendingConfirmation: undefined }
    }
    if (terminalEvent && preEffects.length > 0) next = { ...next, pendingConfirmation: undefined }
    if (request.event.type === 'flight.updated' && request.event.flight.status === 'cancelled') {
      next = {
        ...next,
        message: {
          ...next.message,
          status: next.message.status === 'scheduled' ? 'cancelled' : next.message.status,
          pendingMessageId: undefined,
          pendingText: undefined,
          authorizationId: undefined,
        },
      }
    }
    const requestContext = this.#contextAfterEvent(current.requestContext, request.event)
    const effects = [
      ...preEffects,
      ...planEffects(current.task, request.event, current.toolResults ?? {}, this.#preferences),
    ]
    if (
      request.event.type === 'user.input'
      && current.task.phase === 'returning-home'
      && plan?.intent === 'apply-cabin-preferences'
    ) {
      let preferences: ReadToolResults['memory.get-preferences']
      try {
        preferences = this.#orchestrator.resolveReturnTripPreferences(
          taskId,
          request.clientRequestId,
          current.task.passengers.memberIds,
        )
      } catch (error) {
        if (error instanceof ReadToolOrchestrationError) {
          const stored = this.#store.save(this.#publishFallback(
            current.task,
            current.toolResults,
            error,
            undefined,
            current.requestContext,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
          return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
        }
        this.#throwProviderError(error, current)
      }
      const records = preferences.data.members
      const cabinMember = records.find((member) => member.rearTemperatureC !== undefined || member.mediaTitle !== undefined)
      const mediaMember = records.find((member) => member.mediaTitle !== undefined)
      const execution = this.#effectExecutor.applyCabinPreferences({
        task: current.task,
        memberIds: current.task.passengers.memberIds,
        temperatureC: cabinMember?.rearTemperatureC,
        mediaTitle: mediaMember?.mediaTitle,
        idempotencyKey: request.event.eventId,
        effectId: `${request.event.eventId}:0`,
      })
      if (!execution.succeeded) {
        const executionEffects = [execution.effect, ...(execution.compensationEffect ? [execution.compensationEffect] : [])]
        const residualTask = execution.residualApplied
          ? {
              ...current.task,
              returnTrip: {
                workflowId: request.event.eventId,
                homeDestinationId: current.task.returnTrip?.homeDestinationId,
                route: current.task.returnTrip?.route ?? { status: 'succeeded' as const, routeId: current.task.navigation?.routeId, eta: current.task.navigation?.eta },
                cabin: { status: 'succeeded' as const, errorCode: 'COMPENSATION_FAILED' },
                media: current.task.returnTrip?.media ?? { status: 'pending' as const },
              },
            }
          : current.task
        const stored = this.#store.save(this.#publishFallback(
          residualTask,
          current.toolResults,
          new ReadToolOrchestrationError(
            execution.effect.errorCode === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_FAILED',
            `vehicle.apply-cabin-profile: ${execution.effect.errorCode ?? 'PROVIDER_FAILED'}`,
            execution.effect.errorCode === 'PROVIDER_TIMEOUT',
          ),
          undefined,
          current.requestContext,
        ))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: executionEffects })
        return this.#response(request.clientRequestId, stored, executionEffects, performance.now() - startedAt)
      }
      const previousCabin = next.returnTrip?.cabin
      const cabinChanged = previousCabin?.status !== 'succeeded' || previousCabin.errorCode !== undefined
      const successfulTask = {
        ...next,
        ...(next.returnTrip ? {
          taskRevision: next.taskRevision + (cabinChanged ? 1 : 0),
          returnTrip: { ...next.returnTrip, cabin: { status: 'succeeded' as const } },
        } : {}),
      }
      const stored = this.#store.save(this.#publish(successfulTask, {
        ...current.toolResults,
        'memory.get-preferences': preferences,
      }, requestContext))
      this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [execution.effect] })
      return this.#response(request.clientRequestId, stored, [execution.effect], performance.now() - startedAt)
    }
    if (request.event.type === 'message.sent') {
      if (current.task.message.pendingMessageId !== request.event.messageId) {
        throw new AgentGatewayError('INVALID_REQUEST', 'Message is not pending for this task', false, current)
      }
      const execution = this.#effectExecutor.sendLandingMessage({ task: current.task, idempotencyKey: current.task.message.idempotencyKey ?? request.event.eventId, effectId: `${request.event.eventId}:0` })
      if (!execution.succeeded) {
        const revokeAuthorization = current.task.message.authorizationId
          ? this.#effectExecutor.revokeLandingMessageAuthorization({
              task: current.task,
              authorizationId: current.task.message.authorizationId,
              idempotencyKey: `${request.event.eventId}:send-failed`,
              effectId: `${request.event.eventId}:send-failed`,
            })
          : undefined
        if (revokeAuthorization && !revokeAuthorization.succeeded && !execution.ambiguousApplied) {
          const failedEffects = [execution.effect, revokeAuthorization.effect]
          const reconciled = revokeAuthorization.ambiguous
            ? this.#store.save(this.#publish(applyEvent(current.task, {
                eventId: request.event.eventId,
                type: 'message.failed',
                messageId: request.event.messageId,
                errorCode: execution.effect.errorCode ?? 'SEND_FAILED',
                timestamp: request.event.timestamp,
              }, this.#preferences), current.toolResults, requestContext))
            : current
          this.#store.recordEventResult(taskId, request.event.eventId, { stored: reconciled, effects: failedEffects })
          return this.#response(request.clientRequestId, reconciled, failedEffects, performance.now() - startedAt)
        }
        if (execution.ambiguousApplied) {
          const unknown = this.#store.save(this.#publish(applyEvent(current.task, {
            eventId: request.event.eventId,
            type: 'message.failed',
            messageId: request.event.messageId,
            errorCode: 'PROVIDER_FAILED',
            timestamp: request.event.timestamp,
          }, this.#preferences), current.toolResults, requestContext))
          const ambiguousEffects = [execution.effect, ...(revokeAuthorization ? [revokeAuthorization.effect] : [])]
          this.#store.recordEventResult(taskId, request.event.eventId, { stored: unknown, effects: ambiguousEffects })
          return this.#response(request.clientRequestId, unknown, ambiguousEffects, performance.now() - startedAt)
        }
        const failed = this.#store.save(this.#publish(applyEvent(current.task, {
          eventId: request.event.eventId,
          type: 'message.failed',
          messageId: request.event.messageId,
          errorCode: execution.effect.errorCode ?? 'SEND_FAILED',
          timestamp: request.event.timestamp,
        }, this.#preferences), current.toolResults, requestContext))
        const failedEffects = [execution.effect, ...(revokeAuthorization ? [revokeAuthorization.effect] : [])]
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: failed, effects: failedEffects })
        return this.#response(request.clientRequestId, failed, failedEffects, performance.now() - startedAt)
      }
      const sent = this.#store.save(this.#publish(next, current.toolResults, requestContext))
      this.#store.recordEventResult(taskId, request.event.eventId, { stored: sent, effects: [execution.effect] })
      return this.#response(request.clientRequestId, sent, [execution.effect], performance.now() - startedAt)
    }
    if (request.event.type === 'flight.updated' && request.event.flight.status === 'landed' && next.message.pendingContactId && next.message.pendingMessageId) {
      next.message.authorizationId = issueAutoNotifyAuthorization(this.#runtime, {
        taskId,
        contactId: next.message.pendingContactId,
        messageId: next.message.pendingMessageId,
        text: `我已到达机场接机点，航班 ${request.event.flight.flightNumber}，预计 ${next.navigation?.eta ?? request.event.flight.estimatedArrival} 会合。`,
      })
    }
    let toolResults = current.toolResults
    const flightNumber = plan?.slotUpdates.flightNumber
    const parsedPassengers = plan?.slotUpdates.passengers
    try {
      if (request.event.type === 'user.input' && parsedPassengers) {
        const mergedPassengers = mergePassengers(current.task.passengers, parsedPassengers)
        const passengerReads = this.#orchestrator.resolveInitialPassengers(
          taskId,
          request.clientRequestId,
          mergedPassengers.names,
        )
        const resolvedPassengers = mergePassengers(current.task.passengers, passengerReads.passengers)
        const changedByResolution = JSON.stringify(next.passengers) !== JSON.stringify(resolvedPassengers)
          || next.message.autoNotifyAuthorized !== passengerReads.notificationAuthorized
        next.passengers = resolvedPassengers
        next.message = { ...next.message, autoNotifyAuthorized: passengerReads.notificationAuthorized }
        toolResults = { ...toolResults, ...passengerReads.toolResults }
        if (next.flight && next.phase === 'collecting-information') next.phase = 'preparing'
        if (changedByResolution && next.taskRevision === current.task.taskRevision) {
          next.taskRevision += 1
        }
      }
    } catch (error) {
      if (error instanceof ReadToolOrchestrationError) {
        const stored = this.#store.save(this.#publishFallback(
          current.task,
          current.toolResults,
          error,
          undefined,
          current.requestContext,
        ))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
        return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
      }
      this.#throwProviderError(error, current)
    }
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
        const prepared = this.#prepareTask(next, request.clientRequestId, next.flight!.flightNumber, requestContext)
        next = prepared.task
        toolResults = { ...toolResults, ...prepared.toolResults }
      } catch (error) {
        if (error instanceof ReadToolOrchestrationError) {
          const stored = this.#store.save(this.#publishFallback(
            current.task,
            current.toolResults,
            error,
            undefined,
            current.requestContext,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
          return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
        }
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
          rollbackNavigation: this.#rollbackNavigation(current),
          idempotencyKey: request.event.eventId,
          effectIdPrefix: `${request.event.eventId}:effect`,
          completed: next.returnTrip ? {
            route: next.returnTrip.route.status === 'succeeded',
            cabin: next.returnTrip.cabin.status === 'succeeded',
            media: next.returnTrip.media.status === 'succeeded',
          } : undefined,
        })
        const policyDenied = !execution.succeeded
          && execution.effect.length === 1
          && execution.effect[0]?.type === 'return-trip'
          && execution.effect[0]?.errorCode === 'FLIGHT_CANCELLED'
        if (policyDenied) {
          this.#store.recordEventResult(taskId, request.event.eventId, { stored: current, effects: execution.effect })
          return this.#response(request.clientRequestId, current, execution.effect, performance.now() - startedAt)
        }
        if (!execution.succeeded) {
          const failedTask = execution.rolledBack
            ? current.task
            : this.#applyReturnTripExecution(next, request.event.eventId, homeDestinationId, execution)
          const stored = this.#store.save(this.#publishReturnTripFailure(
            current,
            current.toolResults,
            request.event.eventId,
            undefined,
            failedTask,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: execution.effect })
          return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
        }
        next = this.#applyReturnTripExecution(next, request.event.eventId, homeDestinationId, execution)
        next.uiRevision = Math.max(next.uiRevision, current.ui.uiRevision)
        const stored = this.#store.save(this.#publish(next, toolResults, requestContext))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: execution.effect })
        return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
      } catch (error) {
        if (error instanceof ReadToolOrchestrationError) {
          const stored = this.#store.save(this.#publishReturnTripFailure(
            current,
            current.toolResults,
            request.event.eventId,
            error,
          ))
          this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [] })
          return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
        }
        this.#throwProviderError(error, current)
      }
    }
    if (request.event.type === 'destination.arrived' && current.task.phase === 'returning-home' && next.phase === 'completed') {
      const memberId = next.passengers.memberIds.find((candidate) => this.#preferences[candidate]?.rearTemperatureC !== undefined)
      if (!memberId) {
        next.pendingConfirmation = undefined
        next.memoryProposal = { status: 'skipped', errorCode: 'PREFERENCE_UNAVAILABLE' }
        const stored = this.#store.save(this.#publish(next, toolResults, requestContext))
        const skipped: AgentResponse['effects'] = [{ effectId: `${request.event.eventId}:0`, type: 'memory.propose-update', status: 'cancelled', tool: 'memory.propose-update', errorCode: 'PREFERENCE_UNAVAILABLE' }]
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: skipped })
        return this.#response(request.clientRequestId, stored, skipped, performance.now() - startedAt)
      }
      const proposal = this.#effectExecutor.proposeMemoryUpdate({
        task: next,
        memberId,
        changes: { rearTemperatureC: this.#preferences[memberId]!.rearTemperatureC! },
        requestId: request.event.eventId,
        effectId: `${request.event.eventId}:0`,
      })
      if (!proposal.succeeded || !proposal.proposal) {
        const stored = this.#store.save(this.#publish({
          ...next,
          memoryProposal: { status: 'failed', errorCode: proposal.effect.errorCode ?? 'PROVIDER_FAILED' },
          pendingConfirmation: undefined,
        }, toolResults, requestContext))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [proposal.effect] })
        return this.#response(request.clientRequestId, stored, [proposal.effect], performance.now() - startedAt)
      }
      next.memoryProposal = {
        proposalId: proposal.proposal.proposalId,
        memberId: proposal.proposal.memberId,
        confirmationId: proposal.proposal.confirmationId,
        expiresAt: proposal.proposal.expiresAt,
        changes: { rearTemperatureC: this.#preferences[memberId]!.rearTemperatureC! },
        status: 'pending',
      }
      next.pendingConfirmation = {
        confirmationId: proposal.proposal.confirmationId,
        action: 'save-memory',
        expiresAt: proposal.proposal.expiresAt,
      }
      const stored = this.#store.save(this.#publish(next, toolResults, requestContext))
      this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [proposal.effect] })
      return this.#response(request.clientRequestId, stored, [proposal.effect], performance.now() - startedAt)
    }
    const stored = this.#store.save(this.#publish(next, toolResults, requestContext))
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

    if (request.actionId === 'retry-return-trip') {
      return this.#submitRetryReturnTrip(taskId, current, request, operation, startedAt)
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
      vehicle: current.requestContext?.vehicle ?? current.toolResults?.['vehicle.get-status']?.data,
    })
    const stored = execution.succeeded
      ? this.#store.save(this.#publish(applyEvent(current.task, event, this.#preferences), current.toolResults, current.requestContext))
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
    if (pending.action === 'send-message') {
      if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.parse(this.#now())) {
        throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'The confirmation has expired', false, current)
      }
      return this.#submitSendMessageConfirmation(taskId, confirmationId, current, request, operation, startedAt)
    }

    if (pending.action !== 'save-memory') {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current save-memory confirmation is available', false, current)
    }

    const proposal = current.task.memoryProposal
    if (!proposal?.proposalId || proposal.confirmationId !== confirmationId || proposal.status !== 'pending') {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current memory proposal is available', false, current)
    }
    if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.parse(this.#now())) {
      const expiration = this.#effectExecutor.rejectMemoryUpdate({
        task: current.task,
        proposalId: proposal.proposalId,
        confirmationId,
        idempotencyKey: `${request.idempotencyKey}:expired`,
        effectId: `${confirmationId}:expired`,
      })
      if (!expiration.succeeded) {
        const effects = [expiration.effect]
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      const expired = {
        ...current.task,
        memoryProposal: { ...proposal, status: 'expired' as const, errorCode: 'PROPOSAL_EXPIRED' },
        pendingConfirmation: undefined,
        taskRevision: current.task.taskRevision + 1,
        updatedAt: this.#eventTimestamp(current.task.updatedAt),
      }
      const effects: AgentResponse['effects'] = [{ ...expiration.effect, status: 'failed', errorCode: 'PROPOSAL_EXPIRED' }]
      const stored = this.#store.save(this.#publish(expired, current.toolResults, current.requestContext))
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
      return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
    }

    let effects: AgentResponse['effects']
    let next: AirportPickupTaskState
    if (request.decision === 'reject') {
      const rejection = this.#effectExecutor.rejectMemoryUpdate({
        task: current.task,
        proposalId: proposal.proposalId,
        confirmationId,
        idempotencyKey: request.idempotencyKey,
        effectId: `${confirmationId}:reject`,
      })
      if (!rejection.succeeded) {
        effects = [rejection.effect]
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      next = {
        ...current.task,
        memoryProposal: { ...proposal, status: 'rejected' },
        pendingConfirmation: undefined,
        taskRevision: current.task.taskRevision + 1,
        updatedAt: this.#eventTimestamp(current.task.updatedAt),
      }
      effects = [rejection.effect]
    } else {
      const execution = this.#effectExecutor.confirmMemoryUpdate({
        task: current.task,
        proposalId: proposal.proposalId,
        confirmationId,
        memberId: proposal.memberId ?? '',
        changes: proposal.changes ?? {},
        idempotencyKey: request.idempotencyKey,
        effectId: `${confirmationId}:confirm`,
      })
      if (!execution.succeeded) {
        const errorCode = execution.errorCode ?? 'PROVIDER_FAILED'
        const expired = errorCode === 'PROPOSAL_EXPIRED'
        const failed = {
          ...current.task,
          memoryProposal: { ...proposal, status: expired ? 'expired' as const : 'pending' as const, errorCode },
          ...(expired ? { pendingConfirmation: undefined } : {}),
          taskRevision: current.task.taskRevision + 1,
          updatedAt: this.#eventTimestamp(current.task.updatedAt),
        }
        effects = [execution.effect]
        const stored = this.#store.save(this.#publish(failed, current.toolResults, current.requestContext))
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
        return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
      }
      next = {
        ...current.task,
        memoryProposal: { ...proposal, status: 'accepted', errorCode: undefined },
        pendingConfirmation: undefined,
        taskRevision: current.task.taskRevision + 1,
        updatedAt: this.#eventTimestamp(current.task.updatedAt),
      }
      effects = [execution.effect]
    }
    const stored = this.#store.save(this.#publish(next, current.toolResults, current.requestContext))
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

    const contactId = resolveAuthorizedLandingContact(current.task.passengers.memberIds, this.#preferences)
    if (!contactId) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Landing-message retry is not available for the current authorization state', false, current)
    }

    const execution = this.#effectExecutor.prepareLandingMessageRetry({
      task: current.task,
      contactId,
      idempotencyKey: request.idempotencyKey,
      effectId: `action:${request.idempotencyKey}:0`,
    })
    if (!execution.succeeded || !execution.prepared) {
      const effects = [execution.effect]
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
      return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
    }

    const armed = armLandingMessageRetry(current.task, execution.prepared)
    if (!armed) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Landing-message retry is not available for the current task state', false, current)
    }

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const stored = this.#store.save(this.#publish({ ...armed, updatedAt: timestamp }, current.toolResults, current.requestContext))
    const effects: AgentResponse['effects'] = [execution.effect]
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #submitRetryReturnTrip(
    taskId: string,
    current: StoredTask,
    request: SubmitActionRequest,
    operation: string,
    startedAt: number,
  ): AgentResponse {
    const action = current.ui.actions.find((candidate) => candidate.id === request.actionId)
    const component = current.ui.components.find((candidate) => candidate.id === request.componentId)
    const actionToken = action?.event.type === 'tool-request' ? action.event.actionToken : undefined
    const workflowId = actionToken?.startsWith(`${current.task.taskId}:retry-return-trip:`)
      ? actionToken.slice(`${current.task.taskId}:retry-return-trip:`.length)
      : current.task.returnTrip?.workflowId
    if (
      (current.task.phase !== 'waiting-for-passengers' && current.task.phase !== 'returning-home')
      || !workflowId
      || action?.event.type !== 'tool-request'
      || (
        action.event.actionToken !== this.#returnTripRetryActionToken(current.task.taskId, workflowId)
        && action.event.actionToken !== `${current.task.taskId}:retry-return-trip`
      )
      || !component?.actions?.includes('retry-return-trip')
    ) {
      throw new AgentGatewayError('INVALID_REQUEST', 'Retry return-trip action is not registered for the current task state', false, current)
    }

    let preferences
    try {
      preferences = this.#orchestrator.resolveReturnTripPreferences(taskId, request.clientRequestId, current.task.passengers.memberIds)
    } catch (error) {
      if (error instanceof ReadToolOrchestrationError) {
        const stored = this.#store.save(this.#publishReturnTripFailure(
          current,
          current.toolResults,
          workflowId,
          error,
        ))
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: [] })
        return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
      }
      this.#throwProviderError(error, current)
    }
    const executionTask = current.task.phase === 'waiting-for-passengers'
      ? applyEvent(current.task, {
          eventId: workflowId,
          type: 'user.confirmed-passengers-onboard',
          timestamp: this.#eventTimestamp(current.task.updatedAt),
        }, this.#preferences)
      : current.task
    const records = preferences.data.members
    const homeDestinationId = records.find((member) => member.homeDestinationId)?.homeDestinationId ?? current.task.returnTrip?.homeDestinationId
    const cabinMember = records.find((member) => member.rearTemperatureC !== undefined || member.mediaTitle !== undefined)
    const mediaMember = records.find((member) => member.mediaTitle !== undefined)
    const execution = this.#effectExecutor.executeReturnTrip({
      task: executionTask,
      memberIds: executionTask.passengers.memberIds,
      preferences: {
        homeDestinationId,
        temperatureC: cabinMember?.rearTemperatureC,
        mediaTitle: mediaMember?.mediaTitle,
        mediaMemberId: mediaMember?.memberId,
      },
      rollbackNavigation: this.#rollbackNavigation(current),
      idempotencyKey: `${workflowId}:retry:${request.idempotencyKey}`,
      effectIdPrefix: `${workflowId}:retry:${request.idempotencyKey}`,
      completed: current.task.returnTrip ? {
        route: current.task.returnTrip.route.status === 'succeeded',
        cabin: current.task.returnTrip.cabin.status === 'succeeded',
        media: current.task.returnTrip.media.status === 'succeeded',
      } : undefined,
    })
    if (!execution.succeeded) {
      const failedTask = execution.rolledBack
        ? current.task
        : this.#applyReturnTripExecution(executionTask, workflowId, homeDestinationId, execution)
      const stored = this.#store.save(this.#publishReturnTripFailure(
        current,
        current.toolResults,
        workflowId,
        undefined,
        failedTask,
      ))
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: execution.effect })
      return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
    }
    const executedTask = this.#applyReturnTripExecution(executionTask, workflowId, homeDestinationId, execution)
    const next = {
      ...executedTask,
      uiRevision: Math.max(executionTask.uiRevision, current.ui.uiRevision),
    }
    const stored = this.#store.save(this.#publish(next, { ...current.toolResults, 'memory.get-preferences': preferences }, current.requestContext))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects: execution.effect })
    return this.#response(request.clientRequestId, stored, execution.effect, performance.now() - startedAt)
  }

  #returnTripState(
    task: AirportPickupTaskState,
    workflowId: string,
    homeDestinationId: string | undefined,
    execution: ReturnType<EffectExecutor['executeReturnTrip']>,
  ): ReturnTripState {
    const existing = task.returnTrip
    const failed = (tool: string) => execution.effect.find((effect) => effect.tool === tool && effect.status === 'failed')?.errorCode
    return {
      workflowId,
      homeDestinationId: homeDestinationId ?? existing?.homeDestinationId,
      route: execution.residual.route && execution.navigation
        ? { status: 'succeeded', routeId: execution.navigation.routeId, eta: execution.navigation.eta }
        : { ...(existing?.route ?? { status: 'pending' }), ...(failed('navigation.update-route') ? { status: 'failed' as const, errorCode: failed('navigation.update-route') } : {}) },
      cabin: { status: execution.applied.cabin ? 'succeeded' : (failed('vehicle.apply-cabin-profile') ? 'failed' : 'pending'), ...(failed('vehicle.apply-cabin-profile') ? { errorCode: failed('vehicle.apply-cabin-profile') } : {}) },
      media: { status: execution.applied.media ? 'succeeded' : (failed('media.play') ? 'failed' : 'pending'), ...(failed('media.play') ? { errorCode: failed('media.play') } : {}) },
    }
  }

  #applyReturnTripExecution(
    task: AirportPickupTaskState,
    workflowId: string,
    homeDestinationId: string | undefined,
    execution: ReturnType<EffectExecutor['executeReturnTrip']>,
  ): AirportPickupTaskState {
    return {
      ...task,
      returnTrip: this.#returnTripState(task, workflowId, homeDestinationId, execution),
      ...(execution.residual.route && execution.navigation
        ? {
            navigation: {
              routeId: execution.navigation.routeId,
              destination: execution.navigation.destination,
              eta: execution.navigation.eta,
              status: 'active' as const,
            },
          }
        : {}),
    }
  }

  #rollbackNavigation(current: StoredTask) {
    const navigation = current.task.navigation
    const route = current.toolResults?.['navigation.plan-route']?.data
    const destination = route?.waypoints?.at(-1)
    if (!navigation || !destination) return undefined
    return {
      routeId: navigation.routeId,
      destination: { id: destination.id, name: destination.name },
      eta: navigation.eta,
    }
  }

  #returnTripRetryActionToken(taskId: string, workflowId: string): string {
    return `${taskId}:retry-return-trip:${workflowId}`
  }

  #publishReturnTripFailure(
    current: StoredTask,
    toolResults: ReadToolResults | undefined,
    workflowId: string,
    error?: ReadToolOrchestrationError,
    task: AirportPickupTaskState = current.task,
  ): StoredTask {
    const taskChanged = JSON.stringify(task) !== JSON.stringify(current.task)
    const uiBase = {
      ...task,
      uiRevision: Math.max(task.uiRevision, current.ui.uiRevision),
    }
    const ui = applyRequestPresentation(composeFallbackSpec(
      uiBase,
      error?.code === 'PROVIDER_TIMEOUT' ? '返程设置暂时不可用' : '返程设置失败',
      taskChanged
        ? '部分返程操作仍在生效，当前状态已同步显示。请检查路线和座舱后重试未完成的设置。'
        : '返程操作已撤销，任务状态未改变。可以安全重试返程路线、座舱和媒体设置。',
      error?.code === 'PROVIDER_TIMEOUT' ? 'warning' : 'error',
      {
        actionId: 'retry-return-trip',
        label: '重试返程设置',
        componentId: 'return-trip-provider-fallback',
        actionToken: this.#returnTripRetryActionToken(current.task.taskId, workflowId),
      },
    ), current.requestContext)
    return { task, ui, toolResults, requestContext: current.requestContext }
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
    const pendingMessageId = current.task.message.pendingMessageId
    const pendingContactId = current.task.message.pendingContactId
    const flight = current.task.flight
    if (!pendingMessageId || !pendingContactId || !flight) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current send-message confirmation is available', false, current)
    }

    const content = current.task.message.pendingText
      ? { contactId: pendingContactId, messageId: pendingMessageId, text: current.task.message.pendingText }
      : buildLandingNotifyContent(
          current.task.taskId,
          pendingContactId,
          flight.flightNumber,
          resolveLandingMeetingEta(current.task) ?? '即将到达',
        )
    const execution = request.decision === 'accept'
      ? this.#effectExecutor.sendConfirmedLandingMessage({
          task: current.task,
          contactId: pendingContactId,
          messageId: content.messageId,
          text: content.text,
          confirmationId,
          idempotencyKey: request.idempotencyKey,
          effectId: `${confirmationId}:send`,
        })
      : this.#effectExecutor.revokeLandingMessageConfirmation({
          task: current.task,
          confirmationId,
          idempotencyKey: request.idempotencyKey,
          effectId: `${confirmationId}:revoke`,
        })

    if (request.decision === 'reject' && !execution.succeeded) {
      const effects = [execution.effect]
      this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
      return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
    }

    let cleanupEffect: AgentResponse['effects'][number] | undefined
    if (request.decision === 'accept' && !execution.succeeded) {
      const revocation = this.#effectExecutor.revokeLandingMessageConfirmation({
        task: current.task,
        confirmationId,
        idempotencyKey: `${request.idempotencyKey}:failed-send`,
        effectId: `${confirmationId}:revoke`,
      })
      if (!revocation.succeeded) {
        const effects = [execution.effect, revocation.effect]
        this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored: current, effects })
        return this.#response(request.clientRequestId, current, effects, performance.now() - startedAt)
      }
      cleanupEffect = revocation.effect
    }

    const resolved = resolveLandingMessageRetry(
      current.task,
      {
        confirmationId,
        decision: request.decision,
        timestamp,
        sendSucceeded: request.decision === 'reject' ? true : execution.succeeded,
        errorCode: execution.effect.errorCode,
      },
    )
    if (!resolved) {
      throw new AgentGatewayError('CONFIRMATION_EXPIRED', 'No current send-message confirmation is available', false, current)
    }

    let nextTask: AirportPickupTaskState
    let effects: AgentResponse['effects'] = []
    if (resolved.decision === 'reject') {
      nextTask = resolved.task
      effects = [execution.effect]
    } else {
      nextTask = applyEvent(resolved.task, resolved.event, this.#preferences)
      effects = cleanupEffect ? [execution.effect, cleanupEffect] : [execution.effect]
    }

    const stored = this.#store.save(this.#publish(nextTask, current.toolResults, current.requestContext))
    this.#store.recordIdempotencyResult(taskId, operation, request.idempotencyKey, { stored, effects })
    return this.#response(request.clientRequestId, stored, effects, performance.now() - startedAt)
  }

  #publish(
    task: AirportPickupTaskState,
    toolResults?: ReadToolResults,
    requestContext?: StoredTask['requestContext'],
  ): StoredTask {
    const ui = applyRequestPresentation(this.#compose(task, toolResults, this.#preferences), requestContext)
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
    return { task: { ...task, uiRevision: publishedUi.uiRevision }, ui: publishedUi, toolResults, requestContext }
  }

  #publishFallback(
    task: AirportPickupTaskState,
    toolResults: ReadToolResults | undefined,
    error: ReadToolOrchestrationError,
    retry?: { actionId: string; label: string; componentId: string; actionToken: string },
    requestContext?: StoredTask['requestContext'],
  ): StoredTask {
    const timeout = error.code === 'PROVIDER_TIMEOUT'
    const ui = composeFallbackSpec(
      task,
      timeout ? '数据暂时不可用' : '数据源暂时不可用',
      timeout ? '正在保留当前任务信息，请稍后重试。' : '已保留当前任务信息，请稍后重试。',
      timeout ? 'warning' : 'error',
      retry,
    )
    return {
      task: { ...task, uiRevision: ui.uiRevision },
      ui: applyRequestPresentation(ui, requestContext),
      toolResults,
      requestContext,
    }
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

  #contextAfterEvent(
    context: StoredTask['requestContext'],
    event: SubmitEventRequest['event'],
  ): StoredTask['requestContext'] {
    if (!context) return undefined
    if (event.type === 'user.input') return { ...context, inputConfidence: undefined }
    const eventTimestamp = Date.parse(event.timestamp)
    const contextTimestamp = context.updatedAt ? Date.parse(context.updatedAt) : undefined
    const equalTimestampParkedWouldClearMoving = event.type === 'vehicle.parked'
      && contextTimestamp === eventTimestamp
      && (context.vehicle.speedKph > 0 || context.vehicle.gear !== 'P')
    const contextEventIsCurrent = (contextTimestamp === undefined || eventTimestamp >= contextTimestamp)
      && !equalTimestampParkedWouldClearMoving
    if (!contextEventIsCurrent) return context
    if (event.type === 'vehicle.moving') {
      return {
        ...context,
        vehicle: {
          ...context.vehicle,
          speedKph: event.speedKph,
          gear: event.speedKph > 0 ? 'D' : context.vehicle.gear,
        },
        updatedAt: event.timestamp,
      }
    }
    if (event.type === 'vehicle.parked') {
      return { ...context, vehicle: { ...context.vehicle, speedKph: 0, gear: 'P' }, updatedAt: event.timestamp }
    }
    if (event.type === 'charging.completed') {
      return {
        ...context,
        vehicle: { ...context.vehicle, batteryPercent: event.batteryPercent },
        updatedAt: event.timestamp,
      }
    }
    return context
  }

  #acceptsContextOnlyEvent(
    task: AirportPickupTaskState,
    context: StoredTask['requestContext'],
    event: SubmitEventRequest['event'],
  ): boolean {
    if (task.phase === 'completed' || task.phase === 'cancelled') return false
    if (Date.parse(event.timestamp) < Date.parse(task.updatedAt)) return false
    if (context?.updatedAt && Date.parse(event.timestamp) < Date.parse(context.updatedAt)) return false
    return event.type === 'vehicle.moving'
      || event.type === 'vehicle.parked'
      || event.type === 'charging.completed'
  }

  #prepareTask(
    task: AirportPickupTaskState,
    requestId: string,
    flightNumber: string,
    requestContext?: StoredTask['requestContext'],
  ) {
    const reads = this.#orchestrator.prepareTrip(task.taskId, requestId, flightNumber, requestContext ? {
      vehicle: requestContext.vehicle,
      destination: requestContext.destination,
    } : undefined)
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
          destination: requestContext?.destination.name ?? reads.route.waypoints?.at(-1)?.name ?? '虹桥机场 T2',
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

  #planUserInput(text: string, state: AirportPickupTaskState, eventId: string, timestamp: string): Plan {
    const input: PlannerInput = { text, state, eventId, timestamp }
    return this.#planner.plan(input)
  }

  #response(
    requestId: string,
    stored: StoredTask,
    effects: AgentResponse['effects'],
    durationMs: number,
  ): AgentResponse {
    const assistant = stored.task.phase === 'collecting-information'
      ? {
          text: stored.requestContext?.inputConfidence !== undefined && stored.requestContext.inputConfidence < 0.6
            ? '我不太确定刚才的内容，请确认或编辑后再试一次。'
            : stored.task.flight === undefined
            ? '好的，请告诉我她们的航班号。'
            : '好的，请告诉我要接哪位家人。',
          shouldSpeak: stored.requestContext?.clientCapabilities.supportsTts ?? true,
        }
      : undefined
    return agentResponseSchema.parse({
      requestId,
      task: stored.task,
      ui: stored.ui,
      assistant,
      effects,
      meta: { mode: this.#mode, durationMs, fallbackUsed: stored.ui.meta.generatedBy === 'fallback' },
    })
  }
}
