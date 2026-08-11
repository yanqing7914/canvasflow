import {
  agentErrorResponseSchema,
  agentResponseSchema,
  type AgentErrorResponse,
  type AgentResponse,
  type AirportPickupEvent,
  type AirportPickupTaskState,
  type CancelTaskRequest,
  type CreateTaskRequest,
  type SubmitActionRequest,
  type SubmitConfirmationRequest,
  type SubmitEventRequest,
  taskUpdateEnvelopeSchema,
  type TaskUpdateEnvelope,
} from '@canvasflow/schema'

type Fetch = typeof fetch

export type TaskUpdateSource = {
  addEventListener(type: 'task.updated', listener: (event: MessageEvent<string>) => void): void
  addEventListener(type: 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'task.updated', listener: (event: MessageEvent<string>) => void): void
  removeEventListener(type: 'error', listener: (event: Event) => void): void
  close(): void
}

export type TaskUpdateSubscription = {
  close(): void
}

export type AgentEventInput = AirportPickupEvent extends infer Event
  ? Event extends AirportPickupEvent
    ? Omit<Event, 'eventId' | 'timestamp'> & Partial<Pick<Event, 'eventId' | 'timestamp'>>
    : never
  : never

export type CreateOptions = {
  source?: 'text' | 'voice'
  confidence?: number
  vehicleContext?: CreateTaskRequest['vehicleContext']
  clientCapabilities?: CreateTaskRequest['clientCapabilities']
  destination?: CreateTaskRequest['destination']
}

export type AgentApiClientOptions = {
  fetch?: Fetch
  createId?: () => string
  now?: () => string
  eventSource?: (url: string) => TaskUpdateSource
  vehicleContext?: CreateTaskRequest['vehicleContext']
  clientCapabilities?: CreateTaskRequest['clientCapabilities']
}

export const defaultDemoVehicleContext: CreateTaskRequest['vehicleContext'] = {
  speedKph: 0,
  batteryPercent: 42,
  remainingRangeKm: 112,
  gear: 'P',
  isNight: false,
}

/**
 * Whether the car is driving in the dark, from the clock alone.
 *
 * A car reads its own light conditions from a sensor; a browser has no such
 * thing, so the honest stand-in is the local hour. It is deliberately not
 * `prefers-color-scheme`: the cabin follows the trip, not the desktop theme
 * somebody set last week, and this trip's 20:25 arrival is a night drive
 * whether or not the laptop is in light mode.
 *
 * The boundary is fixed rather than solar. Real dusk moves with the date and
 * the latitude, and a demo that changed its own boundary by season would be
 * claiming a precision it has no data for.
 */
export function isNightAt(date: Date): boolean {
  const hour = date.getHours()
  return hour < 6 || hour >= 18
}

/**
 * The demo's own vehicle reading, with the light condition resolved.
 *
 * `override` is the demo drawer's switch: `auto` follows {@link isNightAt}, and
 * the two explicit values pin it so a screenshot or a walkthrough can show
 * either state at any hour. Everything else is the same canned reading as
 * {@link defaultDemoVehicleContext}, which stays a fixed literal so callers
 * that want a deterministic context still have one.
 */
export function demoVehicleContext(
  override: 'auto' | 'day' | 'night' = 'auto',
  now: Date = new Date(),
): CreateTaskRequest['vehicleContext'] {
  return {
    ...defaultDemoVehicleContext,
    isNight: override === 'auto' ? isNightAt(now) : override === 'night',
  }
}

const defaultClientCapabilities = {
  uiSchemaVersion: '1.0',
  supportsSse: true,
  supportsTts: true,
  cockpitVersion: '1',
} as CreateTaskRequest['clientCapabilities'] & { cockpitVersion: '1' }

let fallbackId = 0

function browserId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  fallbackId += 1
  return `${Date.now().toString(36)}-${fallbackId.toString(36)}`
}

function generatedId(createId: () => string, kind: string): string {
  return `${kind}-${createId()}`
}

function tasksUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/tasks') ? normalized : `${normalized}/tasks`
}

export class AgentApiError extends Error {
  readonly code: AgentErrorResponse['error']['code']
  readonly retryable: boolean
  readonly requestId: string
  readonly latest: AgentErrorResponse['latest']

  constructor(readonly status: number, readonly response: AgentErrorResponse) {
    super(response.error.message)
    this.name = 'AgentApiError'
    this.code = response.error.code
    this.retryable = response.error.retryable
    this.requestId = response.requestId
    this.latest = response.latest
  }
}

export class AgentApiProtocolError extends Error {
  constructor(message: string, readonly status: number, readonly payload: unknown) {
    super(message)
    this.name = 'AgentApiProtocolError'
  }
}

export class AgentApiClient {
  readonly #tasksUrl: string
  readonly #fetch: Fetch
  readonly #createId: () => string
  readonly #now: () => string
  readonly #eventSource: (url: string) => TaskUpdateSource
  readonly #vehicleContext: CreateTaskRequest['vehicleContext']
  readonly #clientCapabilities: CreateTaskRequest['clientCapabilities']

  constructor(baseUrl = '/v1', options: AgentApiClientOptions = {}) {
    this.#tasksUrl = tasksUrl(baseUrl)
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#createId = options.createId ?? browserId
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#eventSource = options.eventSource ?? ((url) => new EventSource(url))
    this.#vehicleContext = options.vehicleContext ?? defaultDemoVehicleContext
    this.#clientCapabilities = options.clientCapabilities ?? defaultClientCapabilities
  }

  create(text: string, options: CreateOptions = {}): Promise<AgentResponse> {
    const input: CreateTaskRequest = {
      clientRequestId: generatedId(this.#createId, 'create'),
      input: {
        type: 'text',
        text,
        ...(options.source ? { source: options.source } : {}),
        ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
      },
      vehicleContext: options.vehicleContext ?? this.#vehicleContext,
      clientCapabilities: options.clientCapabilities ?? this.#clientCapabilities,
      ...(options.destination ? { destination: options.destination } : {}),
    }
    return this.createTask(input)
  }

  get(taskId: string): Promise<AgentResponse> {
    return this.getTask(taskId)
  }

  event(task: AirportPickupTaskState, event: AgentEventInput): Promise<AgentResponse> {
    const eventId = event.eventId ?? generatedId(this.#createId, 'event')
    return this.submitEvent(task.taskId, {
      clientRequestId: generatedId(this.#createId, 'event-request'),
      expectedTaskRevision: task.taskRevision,
      event: {
        ...event,
        eventId,
        timestamp: event.timestamp ?? this.#now(),
      } as AirportPickupEvent,
    })
  }

  action(response: AgentResponse, actionId: string, componentId: string): Promise<AgentResponse> {
    const operationId = generatedId(this.#createId, 'action')
    return this.submitAction(response.task.taskId, {
      clientRequestId: generatedId(this.#createId, 'action-request'),
      expectedTaskRevision: response.task.taskRevision,
      expectedUiRevision: response.ui.uiRevision,
      actionId,
      componentId,
      idempotencyKey: operationId,
    })
  }

  confirmation(
    task: AirportPickupTaskState,
    confirmationId: string,
    decision: SubmitConfirmationRequest['decision'],
  ): Promise<AgentResponse> {
    const operationId = generatedId(this.#createId, 'confirmation')
    return this.submitConfirmation(task.taskId, confirmationId, {
      clientRequestId: generatedId(this.#createId, 'confirmation-request'),
      expectedTaskRevision: task.taskRevision,
      decision,
      idempotencyKey: operationId,
    })
  }

  cancel(task: AirportPickupTaskState, reason?: string): Promise<AgentResponse> {
    const request: CancelTaskRequest = {
      clientRequestId: generatedId(this.#createId, 'cancel-request'),
      expectedTaskRevision: task.taskRevision,
      eventId: generatedId(this.#createId, 'cancel-event'),
      ...(reason ? { reason } : {}),
    }
    return this.cancelTask(task.taskId, request)
  }

  reset(task: AirportPickupTaskState): Promise<AgentResponse> {
    return this.resetTask(task.taskId, {
      clientRequestId: generatedId(this.#createId, 'reset-request'),
      expectedTaskRevision: task.taskRevision,
    })
  }

  createTask(input: CreateTaskRequest): Promise<AgentResponse> {
    return this.#request(this.#tasksUrl, { method: 'POST', body: input, requestId: input.clientRequestId })
  }

  getTask(taskId: string): Promise<AgentResponse> {
    const requestId = generatedId(this.#createId, 'get-request')
    return this.#request(`${this.#tasksUrl}/${encodeURIComponent(taskId)}`, { method: 'GET', requestId })
  }

  submitEvent(taskId: string, input: SubmitEventRequest): Promise<AgentResponse> {
    return this.#post(taskId, 'events', input)
  }

  submitAction(taskId: string, input: SubmitActionRequest): Promise<AgentResponse> {
    return this.#post(taskId, 'actions', input)
  }

  submitConfirmation(taskId: string, confirmationId: string, input: SubmitConfirmationRequest): Promise<AgentResponse> {
    return this.#post(taskId, `confirmations/${encodeURIComponent(confirmationId)}`, input)
  }

  cancelTask(taskId: string, input: CancelTaskRequest): Promise<AgentResponse> {
    return this.#post(taskId, 'cancel', input)
  }

  resetTask(taskId: string, input: { clientRequestId: string; expectedTaskRevision: number }): Promise<AgentResponse> {
    return this.#post(taskId, 'reset', input)
  }

  /**
   * Opens the task's durable SSE stream. Browser EventSource automatically
   * reconnects with the last received event ID, so the server can replay only
   * updates the client has not already observed.
   */
  subscribeTaskUpdates(
    taskId: string,
    onUpdate: (update: TaskUpdateEnvelope) => void,
    onConnectionError?: () => void,
  ): TaskUpdateSubscription {
    const source = this.#eventSource(`${this.#tasksUrl}/${encodeURIComponent(taskId)}/events`)
    const onTaskUpdated = (event: MessageEvent<string>) => {
      let payload: unknown
      try {
        payload = JSON.parse(event.data) as unknown
      } catch {
        return
      }
      const update = taskUpdateEnvelopeSchema.safeParse(payload)
      if (!update.success || update.data.taskId !== taskId) return
      onUpdate(update.data)
    }
    const onError = () => onConnectionError?.()
    source.addEventListener('task.updated', onTaskUpdated)
    source.addEventListener('error', onError)
    return {
      close: () => {
        source.removeEventListener('task.updated', onTaskUpdated)
        source.removeEventListener('error', onError)
        source.close()
      },
    }
  }

  #post(
    taskId: string,
    operation: string,
    input: { clientRequestId: string },
  ): Promise<AgentResponse> {
    return this.#request(`${this.#tasksUrl}/${encodeURIComponent(taskId)}/${operation}`, {
      method: 'POST',
      body: input,
      requestId: input.clientRequestId,
    })
  }

  async #request(
    url: string,
    input: { method: 'GET' | 'POST'; requestId: string; body?: unknown },
  ): Promise<AgentResponse> {
    const response = await this.#fetch(url, {
      method: input.method,
      headers: {
        accept: 'application/json',
        'x-request-id': input.requestId,
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    })

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new AgentApiProtocolError('Agent API returned invalid JSON', response.status, undefined)
    }

    if (!response.ok) {
      const error = agentErrorResponseSchema.safeParse(payload)
      if (error.success) throw new AgentApiError(response.status, error.data)
      throw new AgentApiProtocolError('Agent API returned an invalid error response', response.status, payload)
    }

    const result = agentResponseSchema.safeParse(payload)
    if (!result.success) {
      throw new AgentApiProtocolError('Agent API returned an invalid response', response.status, payload)
    }
    return result.data
  }
}
