import { describe, expect, it, vi } from 'vitest'
import type { ModelPlanningRequest } from '@canvasflow/schema'
import { ModelGateway } from './model-gateway'
import {
  ModelAdapterConfigurationError,
  ModelAdapterError,
  OpenAICompatibleModelAdapter,
  modelAdapterOptionsFromEnvironment,
} from './openai-compatible-model-adapter'
import { planAirportPickup } from './planner'

const endpoint = 'https://model.example.test/v1/chat/completions'
const allowedHosts = ['model.example.test']
const apiKey = 'secret-model-key'
const modelId = 'planning-model-v1'
const request: ModelPlanningRequest = {
  text: '劳驾替我去航站楼把妈妈接回来',
  context: { phase: 'collecting-information', knownSlots: { passengers: false } },
}
const planningOutput = {
  confidence: 0.93,
  canonicalInput: '去机场接妈妈',
  intentHint: 'create-airport-pickup',
  evidence: { passengers: ['妈妈'] },
}

function completion(content: unknown = JSON.stringify(planningOutput), overrides: Record<string, unknown> = {}) {
  return {
    id: 'completion-001',
    model: 'untrusted-provider-model',
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content },
    }],
    ...overrides,
  }
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  })
}

function adapterWithFetch(fetch: typeof globalThis.fetch, maxResponseBytes?: number) {
  return new OpenAICompatibleModelAdapter({ endpoint, allowedHosts, apiKey, modelId, fetch, maxResponseBytes })
}

function safeErrorText(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error)
  return JSON.stringify({ name: error.name, message: error.message, code: (error as { code?: unknown }).code })
}

describe('OpenAICompatibleModelAdapter transport', () => {
  it('sends one fixed Chat Completions request and returns the exact inner JSON object', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(completion()))
    const controller = new AbortController()
    const adapter = adapterWithFetch(fetch as typeof globalThis.fetch)

    await expect(adapter.plan(request, { signal: controller.signal })).resolves.toEqual(planningOutput)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(endpoint)
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
    })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: modelId,
      temperature: 0,
      max_tokens: 300,
      n: 1,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'canvasflow_model_planning_output', strict: true },
      },
      messages: [
        { role: 'system', content: expect.stringContaining('untrusted data') },
        { role: 'user', content: JSON.stringify(request) },
      ],
    })
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('functions')
    const responseFormat = body.response_format as {
      json_schema: { schema: { properties: { evidence: { anyOf: Array<Record<string, unknown>> } } } }
    }
    expect(responseFormat.json_schema.schema.properties.evidence.anyOf).toEqual([
      expect.objectContaining({ required: [], properties: {} }),
      expect.objectContaining({ required: ['passengers'] }),
      expect.objectContaining({ required: ['flightNumber'] }),
      expect.objectContaining({ required: ['passengers', 'flightNumber'] }),
    ])
    for (const branch of responseFormat.json_schema.schema.properties.evidence.anyOf) {
      expect(Object.keys(branch.properties as object)).toEqual(branch.required)
    }
    const messages = body.messages as Array<{ role: string; content: string }>
    const userPayload = messages.find((message) => message.role === 'user')?.content ?? ''
    expect(userPayload).not.toMatch(/taskId|eventId|routeId|authorization/u)
  })

  it('keeps configured model identity authoritative through ModelGateway', async () => {
    const fetch = vi.fn(async () => jsonResponse(completion()))
    const adapter = adapterWithFetch(fetch as typeof globalThis.fetch)

    await expect(new ModelGateway({ adapter }).plan({
      text: request.text, eventId: 'adapter-event', timestamp: '2026-07-25T20:00:00+08:00',
    })).resolves.toMatchObject({ source: 'model', modelUsed: modelId })
  })

  it('instructs the model in the exact dialect the rule planner accepts', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(completion()))
    await adapterWithFetch(fetch as typeof globalThis.fetch).plan(request, { signal: new AbortController().signal })

    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as { messages: Array<{ role: string; content: string }> }
    const system = body.messages.find((message) => message.role === 'system')?.content ?? ''
    // The gateway re-plans canonicalInput with the deterministic rules and
    // grounds evidence in the original text. Losing any of these instructions
    // silently turns every model turn into a rules fallback, so each canonical
    // form the prompt teaches must itself parse to the intent it is taught for.
    expect(system).toContain('我现在要去机场接妈妈和豆豆')
    expect(system).toContain('，航班号是MU5102')
    expect(system).toContain('航班号是MU5102')
    expect(system).toMatch(/妈妈, 爸爸, and 豆豆/u)
    expect(system).toContain('verbatim substring')
    expect(planAirportPickup({ text: '我现在要去机场接妈妈和豆豆' }).intent).toBe('create-airport-pickup')
    expect(planAirportPickup({ text: '航班号是MU5102' }).intent).toBe('provide-flight-number')
    // The taught mixed form must keep both slots in one plan, so a canonicalized
    // pickup that also carries a flight number never degrades into a follow-up
    // question asking for the number again.
    expect(planAirportPickup({ text: '我现在要去机场接妈妈和豆豆，航班号是MU5102' })).toMatchObject({
      intent: 'create-airport-pickup',
      slotUpdates: { passengers: { names: ['妈妈', '豆豆'] }, flightNumber: 'MU5102' },
    })
  })

  it('turns a rules-dialect answer into a model plan and discards an off-dialect answer', async () => {
    // The regression this prompt exists to prevent: a model that canonicalizes
    // into anything the rules cannot parse (observed live: English) must fall
    // back, while the taught dialect must survive every gateway guard.
    const offDialect = {
      confidence: 0.95,
      canonicalInput: 'Pick up mom from the airport',
      intentHint: 'create-airport-pickup',
      evidence: { passengers: ['妈妈'] },
    }
    const gatewayInput = { text: request.text, eventId: 'dialect-event', timestamp: '2026-07-25T20:00:00+08:00' }

    const taught = vi.fn(async () => jsonResponse(completion()))
    await expect(new ModelGateway({ adapter: adapterWithFetch(taught as typeof globalThis.fetch) }).plan(gatewayInput))
      .resolves.toMatchObject({
        source: 'model',
        plan: { intent: 'create-airport-pickup', slotUpdates: { passengers: { names: ['妈妈'] } } },
      })

    const strayed = vi.fn(async () => jsonResponse(completion(JSON.stringify(offDialect))))
    await expect(new ModelGateway({ adapter: adapterWithFetch(strayed as typeof globalThis.fetch) }).plan(gatewayInput))
      .resolves.toMatchObject({ source: 'fallback', plan: { intent: 'unknown' } })
  })

  it.each([301, 302, 307, 308, 400, 401, 403, 429, 500])('rejects HTTP %s without retrying or reading its body', async (status) => {
    const cancel = vi.fn(async () => undefined)
    const response = {
      status,
      headers: new Headers({ location: 'https://attacker.example/collect' }),
      body: { cancel },
    } as unknown as Response
    const fetch = vi.fn(async () => response)

    await expect(adapterWithFetch(fetch as typeof globalThis.fetch).plan(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not wait for response cleanup before returning a fixed failure', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const response = {
      status: 500,
      headers: new Headers(),
      body: { cancel },
    } as unknown as Response
    const fetch = vi.fn(async () => response)

    await expect(adapterWithFetch(fetch as typeof globalThis.fetch).plan(
      request, { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing', {}],
    ['html', { 'content-type': 'text/html' }],
    ['sse', { 'content-type': 'text/event-stream' }],
    ['latin1', { 'content-type': 'application/json; charset=iso-8859-1' }],
  ])('rejects %s response content type', async (_label, headers) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(completion()), { status: 200, headers }))
    await expect(adapterWithFetch(fetch as typeof globalThis.fetch).plan(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' })
  })

  it.each(['-1', '1.5', 'NaN', '999999999999999999999999'])('rejects invalid Content-Length %s', async (length) => {
    const fetch = vi.fn(async () => jsonResponse(completion(), { headers: { 'content-type': 'application/json', 'content-length': length } }))
    await expect(adapterWithFetch(fetch as typeof globalThis.fetch).plan(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' })
  })

  it('rejects declared and chunked responses above the configured byte limit', async () => {
    const declared = vi.fn(async () => jsonResponse(completion(), {
      headers: { 'content-type': 'application/json', 'content-length': '101' },
    }))
    await expect(adapterWithFetch(declared as typeof globalThis.fetch, 100).plan(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'MODEL_RESPONSE_TOO_LARGE' })

    let cancelled = false
    const chunked = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60))
        controller.enqueue(new Uint8Array(41))
      },
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(adapterWithFetch(chunked as typeof globalThis.fetch, 100).plan(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'MODEL_RESPONSE_TOO_LARGE' })
    expect(cancelled).toBe(true)
  })

  it('does not wait for reader cleanup after a response exceeds the byte limit', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const reader = {
      read: vi.fn(async () => ({ done: false, value: new Uint8Array(101) })),
      cancel,
    }
    const response = {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => reader },
    } as unknown as Response
    const fetch = vi.fn(async () => response)

    await expect(adapterWithFetch(fetch as typeof globalThis.fetch, 100).plan(
      request, { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'MODEL_RESPONSE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('accepts a response exactly at the byte boundary', async () => {
    const body = JSON.stringify(completion())
    const bytes = new TextEncoder().encode(body)
    const fetch = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(adapterWithFetch(fetch as typeof globalThis.fetch, bytes.byteLength).plan(
      request, { signal: new AbortController().signal },
    )).resolves.toEqual(planningOutput)
  })

  it('rejects malformed JSON and invalid UTF-8 without exposing response data', async () => {
    const malformed = vi.fn(async () => new Response('provider-body-canary {', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const invalidUtf8 = vi.fn(async () => new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))

    for (const fetch of [malformed, invalidUtf8]) {
      const error = await adapterWithFetch(fetch as typeof globalThis.fetch)
        .plan(request, { signal: new AbortController().signal }).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: 'MODEL_RESPONSE_INVALID' })
      expect(safeErrorText(error)).not.toContain('provider-body-canary')
    }
  })

  it.each([
    ['no choices', { choices: [] }],
    ['many choices', { choices: [completion().choices[0], completion().choices[0]] }],
    ['missing message', { choices: [{ finish_reason: 'stop' }] }],
    ['wrong role', { choices: [{ finish_reason: 'stop', message: { role: 'user', content: '{}' } }] }],
    ['null content', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }] }],
    ['array content', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [] } }] }],
    ['tool calls', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [] } }] }],
    ['refusal', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', refusal: 'no' } }] }],
    ['length finish', { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] }],
    ['content filter', { choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '{}' } }] }],
    ['fenced JSON', completion('```json\n{}\n```')],
    ['prefixed JSON', completion('result: {}')],
    ['suffixed JSON', completion('{} trailing')],
  ])('rejects ambiguous Chat Completions envelope: %s', async (_label, envelope) => {
    const fetch = vi.fn(async () => jsonResponse(envelope))
    await expect(adapterWithFetch(fetch as typeof globalThis.fetch).plan(request, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' })
  })

  it('does not fetch when already aborted', async () => {
    const controller = new AbortController()
    controller.abort('stop')
    const fetch = vi.fn(async () => jsonResponse(completion()))

    await expect(adapterWithFetch(fetch as typeof globalThis.fetch).plan(request, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'MODEL_REQUEST_ABORTED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('settles when fetch or body streaming is aborted and never retries', async () => {
    const fetchController = new AbortController()
    const pendingFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('secret-network-error', 'AbortError')), { once: true })
    }))
    const fetchPlan = adapterWithFetch(pendingFetch as typeof globalThis.fetch)
      .plan(request, { signal: fetchController.signal })
    fetchController.abort()
    await expect(fetchPlan).rejects.toMatchObject({ code: 'MODEL_REQUEST_ABORTED' })
    expect(pendingFetch).toHaveBeenCalledTimes(1)

    const bodyController = new AbortController()
    let cancelled = false
    const pendingBody = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined) },
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const bodyPlan = adapterWithFetch(pendingBody as typeof globalThis.fetch)
      .plan(request, { signal: bodyController.signal })
    await Promise.resolve()
    bodyController.abort()
    await expect(bodyPlan).rejects.toMatchObject({ code: 'MODEL_REQUEST_ABORTED' })
    expect(pendingBody).toHaveBeenCalledTimes(1)
    expect(cancelled).toBe(true)
  })

  it('converts hostile fetch failures to a fixed non-secret error', async () => {
    const fetch = vi.fn(async () => { throw new Error(`${endpoint} ${apiKey} provider-body-canary`) })
    const error = await adapterWithFetch(fetch as typeof globalThis.fetch)
      .plan(request, { signal: new AbortController().signal }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'MODEL_REQUEST_FAILED' })
    expect(safeErrorText(error)).not.toMatch(/secret-model-key|model\.example|provider-body-canary/u)
  })

  it('lets ModelGateway convert adapter failure into the unchanged deterministic fallback', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline') })
    const adapter = adapterWithFetch(fetch as typeof globalThis.fetch)
    const input = { text: '今天天气怎么样', eventId: 'offline', timestamp: '2026-07-25T20:00:00+08:00' }

    await expect(new ModelGateway({ adapter }).plan(input)).resolves.toEqual({
      source: 'fallback', plan: planAirportPickup(input),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('model adapter environment configuration', () => {
  const complete = {
    AGENT_MODEL_MODE: 'openai-compatible',
    AGENT_MODEL_ENDPOINT: endpoint,
    AGENT_MODEL_ALLOWED_HOSTS: allowedHosts.join(','),
    AGENT_MODEL_API_KEY: apiKey,
    AGENT_MODEL_ID: modelId,
  }

  it('is disabled only when no model settings are supplied', () => {
    expect(modelAdapterOptionsFromEnvironment({})).toEqual({})
    expect(modelAdapterOptionsFromEnvironment({ AGENT_MODEL_MODE: 'disabled' })).toEqual({})
  })

  it.each([
    ['endpoint only', { AGENT_MODEL_ENDPOINT: endpoint }],
    ['key only', { AGENT_MODEL_API_KEY: apiKey }],
    ['model only', { AGENT_MODEL_ID: modelId }],
    ['allowed hosts only', { AGENT_MODEL_ALLOWED_HOSTS: allowedHosts.join(',') }],
    ['timeout only', { AGENT_MODEL_TIMEOUT_MS: '5000' }],
    ['disabled with settings', { AGENT_MODEL_MODE: 'disabled', AGENT_MODEL_ID: modelId }],
    ['missing endpoint', { ...complete, AGENT_MODEL_ENDPOINT: undefined }],
    ['missing key', { ...complete, AGENT_MODEL_API_KEY: undefined }],
    ['missing model', { ...complete, AGENT_MODEL_ID: undefined }],
    ['missing allowed hosts', { ...complete, AGENT_MODEL_ALLOWED_HOSTS: undefined }],
  ])('fails closed for partial configuration: %s', (_label, environment) => {
    expect(() => modelAdapterOptionsFromEnvironment(environment)).toThrow(ModelAdapterConfigurationError)
  })

  it('creates an adapter and validates an optional timeout without making a request', () => {
    const fetch = vi.fn()
    const configured = modelAdapterOptionsFromEnvironment(
      { ...complete, AGENT_MODEL_TIMEOUT_MS: '4321' },
      { fetch: fetch as typeof globalThis.fetch },
    )

    expect(configured).toMatchObject({ timeoutMs: 4321, adapter: { modelId } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown mode', { ...complete, AGENT_MODEL_MODE: 'live' }],
    ['blank endpoint', { ...complete, AGENT_MODEL_ENDPOINT: '   ' }],
    ['relative endpoint', { ...complete, AGENT_MODEL_ENDPOINT: '/v1/chat/completions' }],
    ['http endpoint', { ...complete, AGENT_MODEL_ENDPOINT: 'http://model.example/v1/chat/completions' }],
    ['wrong path', { ...complete, AGENT_MODEL_ENDPOINT: 'https://model.example/v1/responses' }],
    ['userinfo', { ...complete, AGENT_MODEL_ENDPOINT: 'https://user:pass@model.example/v1/chat/completions' }],
    ['query', { ...complete, AGENT_MODEL_ENDPOINT: 'https://model.example/v1/chat/completions?key=value' }],
    ['fragment', { ...complete, AGENT_MODEL_ENDPOINT: 'https://model.example/v1/chat/completions#x' }],
    ['host outside allowlist', { ...complete, AGENT_MODEL_ENDPOINT: 'https://other.example/v1/chat/completions' }],
    ['endpoint control', { ...complete, AGENT_MODEL_ENDPOINT: `${endpoint}\nforged` }],
    ['blank key', { ...complete, AGENT_MODEL_API_KEY: '   ' }],
    ['key control', { ...complete, AGENT_MODEL_API_KEY: 'secret\r\nforged' }],
    ['blank model', { ...complete, AGENT_MODEL_ID: '   ' }],
    ['model control', { ...complete, AGENT_MODEL_ID: 'model\nforged' }],
    ['model too long', { ...complete, AGENT_MODEL_ID: 'm'.repeat(101) }],
    ['blank allowed host', { ...complete, AGENT_MODEL_ALLOWED_HOSTS: '   ' }],
    ['allowed host control', { ...complete, AGENT_MODEL_ALLOWED_HOSTS: 'model.example.test\nforged' }],
    ['allowed host with port', { ...complete, AGENT_MODEL_ALLOWED_HOSTS: 'model.example.test:443' }],
    ['zero timeout', { ...complete, AGENT_MODEL_TIMEOUT_MS: '0' }],
    ['float timeout', { ...complete, AGENT_MODEL_TIMEOUT_MS: '1.5' }],
    ['large timeout', { ...complete, AGENT_MODEL_TIMEOUT_MS: '30001' }],
  ])('rejects invalid configuration without exposing values: %s', (_label, environment) => {
    const error = (() => {
      try {
        modelAdapterOptionsFromEnvironment(environment)
      } catch (caught) {
        return caught
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(ModelAdapterConfigurationError)
    expect(safeErrorText(error)).not.toMatch(/secret-model-key|model\.example\.test|user:pass|key=value/u)
  })

  it.each([0, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 1024 * 1024 + 1])(
    'rejects invalid maxResponseBytes %s',
    (maxResponseBytes) => {
      expect(() => new OpenAICompatibleModelAdapter({ endpoint, allowedHosts, apiKey, modelId, maxResponseBytes }))
        .toThrow(ModelAdapterConfigurationError)
    },
  )

  it('does not read generic OPENAI variables used by repository automation', () => {
    expect(modelAdapterOptionsFromEnvironment({
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: endpoint,
    })).toEqual({})
  })
})

describe('adapter error surface', () => {
  it('uses stable non-secret error messages', () => {
    expect(new ModelAdapterError('MODEL_REQUEST_ABORTED').message).toBe('Model request was aborted')
    expect(new ModelAdapterError('MODEL_REQUEST_FAILED').message).toBe('Model request failed')
    expect(new ModelAdapterError('MODEL_RESPONSE_INVALID').message).toBe('Model response was invalid')
    expect(new ModelAdapterError('MODEL_RESPONSE_TOO_LARGE').message).toBe('Model response exceeded the configured limit')
  })
})
