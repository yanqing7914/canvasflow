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
} from '@canvasflow/schema'
import {
  createProviderRegistry,
  issueAutoNotifyAuthorization,
  resetSideEffectRuntimeTask,
  createSideEffectRuntime,
  type MemberPreferenceRecord,
  type ProviderRegistry,
  type SideEffectRuntime,
} from '@canvasflow/tools'
import { applyEvent, createInitialTask } from './index'
import { normalizeFlightNumber } from './flight-number'
import { mergePassengers, parsePassengerLabels, parsePassengers } from './passengers'
import { composeAgentSpec, composeFallbackSpec } from './composer'
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
    const parsedPassengers = parsePassengers(request.input.text)
    let task = createInitialTask(taskId, timestamp)
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
    }, this.#preferences)
    let toolResults: ReadToolResults = {}
    try {
      const labels = parsePassengerLabels(request.input.text)
      const passengerReads = this.#orchestrator.resolveInitialPassengers(taskId, request.clientRequestId, labels)
      task = {
        ...task,
        passengers: { ...passengerReads.passengers, confirmedOnboard: false },
        message: { ...task.message, autoNotifyAuthorized: passengerReads.notificationAuthorized },
      }
      toolResults = passengerReads.toolResults
      if (flightNumber && task.passengers.memberIds.length > 0) {
        const prepared = this.#prepareTask(task, request.clientRequestId, flightNumber)
        task = prepared.task
        toolResults = { ...toolResults, ...prepared.toolResults }
      }
      const stored = this.#store.create(this.#publish(task, toolResults), request.clientRequestId)
      return this.#response(request.clientRequestId, stored, [], performance.now() - startedAt)
    } catch (error) {
      if (error instanceof ReadToolOrchestrationError) {
        const stored = this.#store.create(
          this.#publishFallback(task, toolResults, error),
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

    resetSideEffectRuntimeTask(this.#runtime, taskId)

    const timestamp = this.#eventTimestamp(current.task.updatedAt)
    const initial = createInitialTask(taskId, timestamp)
    const resetTask: AirportPickupTaskState = {
      ...initial,
      taskRevision: current.task.taskRevision + 1,
      uiRevision: Math.max(current.task.uiRevision, current.ui.uiRevision),
    }
    const stored = this.#store.reset(this.#publish(resetTask))
    const effects: AgentResponse['effects'] = []
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

    const effects = planEffects(current.task, request.event, current.toolResults ?? {}, this.#preferences)
    if (request.event.type === 'message.sent') {
      if (current.task.message.pendingMessageId !== request.event.messageId) {
        throw new AgentGatewayError('INVALID_REQUEST', 'Message is not pending for this task', false, current)
      }
      const execution = this.#effectExecutor.sendLandingMessage({ task: current.task, idempotencyKey: current.task.message.idempotencyKey ?? request.event.eventId, effectId: `${request.event.eventId}:0` })
      if (!execution.succeeded) {
        const failed = this.#store.save(this.#publish(applyEvent(current.task, {
          eventId: request.event.eventId,
          type: 'message.failed',
          messageId: request.event.messageId,
          errorCode: execution.effect.errorCode ?? 'SEND_FAILED',
          timestamp: request.event.timestamp,
        }, this.#preferences), current.toolResults))
        this.#store.recordEventResult(taskId, request.event.eventId, { stored: failed, effects: [execution.effect] })
        return this.#response(request.clientRequestId, failed, [execution.effect], performance.now() - startedAt)
      }
      const sent = this.#store.save(this.#publish(applyEvent(current.task, request.event, this.#preferences), current.toolResults))
      this.#store.recordEventResult(taskId, request.event.eventId, { stored: sent, effects: [execution.effect] })
      return this.#response(request.clientRequestId, sent, [execution.effect], performance.now() - startedAt)
    }
    let next = applyEvent(current.task, request.event, this.#preferences)
    if (request.event.type === 'flight.updated' && request.event.flight.status === 'landed' && next.message.pendingContactId && next.message.pendingMessageId) {
      next.message.authorizationId = issueAutoNotifyAuthorization(this.#runtime, {
        taskId,
        contactId: next.message.pendingContactId,
        messageId: next.message.pendingMessageId,
        text: `我已到达机场接机点，航班 ${request.event.flight.flightNumber}，预计 ${next.navigation?.eta ?? request.event.flight.estimatedArrival} 会合。`,
      })
    }
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
        if (error instanceof ReadToolOrchestrationError) {
          const stored = this.#store.save(this.#publishFallback(next, current.toolResults, error))
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
        const stored = this.#store.save(this.#publish(next, toolResults))
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
        const stored = this.#store.save(this.#publish(next, toolResults))
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
        }, toolResults))
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
      const stored = this.#store.save(this.#publish(next, toolResults))
      this.#store.recordEventResult(taskId, request.event.eventId, { stored, effects: [proposal.effect] })
      return this.#response(request.clientRequestId, stored, [proposal.effect], performance.now() - startedAt)
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
      const stored = this.#store.save(this.#publish(expired, current.toolResults))
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
        const stored = this.#store.save(this.#publish(failed, current.toolResults))
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
    const stored = this.#store.save(this.#publish(next, current.toolResults))
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
    const stored = this.#store.save(this.#publish(next, { ...current.toolResults, 'memory.get-preferences': preferences }))
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
    const uiBase = {
      ...task,
      uiRevision: Math.max(task.uiRevision, current.ui.uiRevision),
    }
    const ui = composeFallbackSpec(
      uiBase,
      error?.code === 'PROVIDER_TIMEOUT' ? '返程设置暂时不可用' : '返程设置失败',
      '任务状态未改变，可以安全重试返程路线、座舱和媒体设置。',
      error?.code === 'PROVIDER_TIMEOUT' ? 'warning' : 'error',
      {
        actionId: 'retry-return-trip',
        label: '重试返程设置',
        componentId: 'return-trip-provider-fallback',
        actionToken: this.#returnTripRetryActionToken(current.task.taskId, workflowId),
      },
    )
    return { task, ui, toolResults }
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

  #publishFallback(
    task: AirportPickupTaskState,
    toolResults: ReadToolResults | undefined,
    error: ReadToolOrchestrationError,
    retry?: { actionId: string; label: string; componentId: string; actionToken: string },
  ): StoredTask {
    const timeout = error.code === 'PROVIDER_TIMEOUT'
    const ui = composeFallbackSpec(
      task,
      timeout ? '数据暂时不可用' : '数据源暂时不可用',
      timeout ? '正在保留当前任务信息，请稍后重试。' : '已保留当前任务信息，请稍后重试。',
      timeout ? 'warning' : 'error',
      retry,
    )
    return { task: { ...task, uiRevision: ui.uiRevision }, ui, toolResults }
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
