import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { createSideEffectRuntime, issueAutoNotifyAuthorization } from '@canvasflow/tools'
import { ServerResponse } from 'node:http'
import {
  createAgentServer,
  resolveStaticPath,
  resolveAMapServiceUrl,
  proxyAMapService,
  loadLocalEnvironment,
  createConfiguredAgentRuntime,
  createE2eProviderFactory,
  CANVASFLOW_E2E,
  CANVASFLOW_E2E_NOW,
  E2E_FAIL_AUTO_MESSAGE_SEND,
  LOCAL_VOICE_ISOLATION_HEADERS,
  proxyVoiceTranscription,
  e2eClockFromEnvironment,
  serverHost,
  serverPort,
} from './server-runtime'

describe('agent server runtime', () => {
  let server: ReturnType<typeof createAgentServer> | undefined
  let staticDirectory: string | undefined

  afterEach(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    if (staticDirectory) await rm(staticDirectory, { recursive: true, force: true })
    staticDirectory = undefined
  })

  it('binds externally by default and allows a local override', () => {
    expect(serverHost({})).toBe('0.0.0.0')
    expect(serverHost({ AGENT_HOST: '127.0.0.1' })).toBe('127.0.0.1')
    expect(serverPort({ AGENT_PORT: '9876' })).toBe(9876)
  })

  it('creates a persistent fixture runtime from environment configuration', async () => {
    staticDirectory = await mkdtemp(join(tmpdir(), 'canvasflow-runtime-'))
    const runtime = createConfiguredAgentRuntime({
      environment: { AGENT_DATABASE_PATH: join(staticDirectory, 'agent.sqlite'), AGENT_PROVIDER_MODE: 'fixture' },
    })
    const created = runtime.createTask({
      clientRequestId: 'server-create',
      input: { type: 'text', text: '接妈妈，航班 MU5102' },
      vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true },
    })
    expect(created.meta.mode).toBe('fixture')
    runtime.close()
  })

  it('selects the built-in deterministic mock provider mode explicitly', () => {
    const runtime = createConfiguredAgentRuntime({
      environment: { AGENT_DATABASE_PATH: ':memory:', AGENT_PROVIDER_MODE: 'mock' },
    })
    const created = runtime.createTask({
      clientRequestId: 'server-mock-create',
      input: { type: 'text', text: '接妈妈，航班 MU5102' },
      vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
      clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true },
    })
    expect(created.meta.mode).toBe('mock')
    runtime.close()
  })

  it('keeps the default provider factory when the E2E failure scenario is disabled', () => {
    expect(createE2eProviderFactory({})).toBeUndefined()
    expect(createE2eProviderFactory({ [E2E_FAIL_AUTO_MESSAGE_SEND]: '1' })).toBeUndefined()
  })

  it('only accepts a deterministic clock behind the explicit E2E gate', () => {
    const configured = '2026-08-11T09:30:00+08:00'
    expect(e2eClockFromEnvironment({ [CANVASFLOW_E2E_NOW]: configured })).toBeUndefined()
    const clock = e2eClockFromEnvironment({
      [CANVASFLOW_E2E]: '1',
      [CANVASFLOW_E2E_NOW]: configured,
    })
    expect(clock?.now()).toBe(configured)
    expect(clock?.nowMs()).toBe(Date.parse(configured))
  })

  it('rejects an invalid deterministic E2E timestamp', () => {
    expect(() => e2eClockFromEnvironment({
      [CANVASFLOW_E2E]: '1',
      [CANVASFLOW_E2E_NOW]: 'not-a-date',
    })).toThrow(`${CANVASFLOW_E2E_NOW} must be a valid ISO timestamp`)
  })

  it('fails only MU5103 auto-notify sends while allowing confirmed retries', () => {
    const runtime = createSideEffectRuntime()
    const factory = createE2eProviderFactory({
      [CANVASFLOW_E2E]: '1',
      [E2E_FAIL_AUTO_MESSAGE_SEND]: '1',
    })
    if (!factory) throw new Error('expected the E2E provider factory')
    const providers = factory(runtime, 'fixture')

    const failed = providers['message.send'](
      { taskId: 'pickup-e2e', requestId: 'auto-failed' },
      {
        contactId: 'contact-mom',
        messageId: 'MU5103:landing',
        text: '航班 MU5103 已落地',
        authorizationId: 'e2e-auto-authorization',
        idempotencyKey: 'auto-failed',
      },
    )
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'SEND_FAILED' },
      meta: { requestId: 'auto-failed', taskId: 'pickup-e2e', tool: 'message.send', provider: 'fixture' },
    })

    const normalContent = {
      contactId: 'contact-mom',
      messageId: 'pickup-e2e:MU5102:landing',
      text: '航班 MU5102 已落地',
    }
    const normalAuthorization = issueAutoNotifyAuthorization(runtime, {
      taskId: 'pickup-e2e',
      ...normalContent,
    })
    const normalAutoSend = providers['message.send'](
      { taskId: 'pickup-e2e', requestId: 'auto-success' },
      { ...normalContent, authorizationId: normalAuthorization, idempotencyKey: 'auto-success' },
    )
    expect(normalAutoSend).toMatchObject({
      ok: true,
      data: { messageId: 'pickup-e2e:MU5102:landing', status: 'sent' },
      meta: { requestId: 'auto-success', provider: 'fixture' },
    })

    const prepared = providers['message.prepare'](
      { taskId: 'pickup-e2e', requestId: 'prepare-retry' },
      { contactId: 'contact-mom', flightNumber: 'MU5103', eta: '20:40' },
    )
    expect(prepared.ok).toBe(true)
    const confirmed = providers['message.send'](
      { taskId: 'pickup-e2e', requestId: 'confirmed-retry' },
      {
        contactId: prepared.data!.contactId,
        messageId: prepared.data!.messageId,
        text: prepared.data!.text,
        confirmationId: prepared.data!.confirmationId,
        idempotencyKey: 'confirmed-retry',
      },
    )
    expect(confirmed).toMatchObject({
      ok: true,
      data: { messageId: prepared.data!.messageId, status: 'sent' },
      meta: { requestId: 'confirmed-retry', provider: 'fixture' },
    })
  })

  it('rejects the E2E-only failure scenario in live provider mode', () => {
    expect(() => createConfiguredAgentRuntime({
      environment: {
        AGENT_DATABASE_PATH: ':memory:',
        AGENT_PROVIDER_MODE: 'live',
        [CANVASFLOW_E2E]: '1',
        [E2E_FAIL_AUTO_MESSAGE_SEND]: '1',
      },
    })).toThrow(`${E2E_FAIL_AUTO_MESSAGE_SEND} is unavailable in live provider mode`)
  })

  it('serves the health endpoint from the configured runtime', async () => {
    server = createAgentServer()
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    const response = await fetch(`http://127.0.0.1:${address.port}/health`)
    expect(response.status).toBe(200)
    expect(Object.fromEntries(
      Object.keys(LOCAL_VOICE_ISOLATION_HEADERS).map((name) => [name, response.headers.get(name)]),
    )).toEqual(LOCAL_VOICE_ISOLATION_HEADERS)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('rejects malformed static URLs without terminating the server', async () => {
    server = createAgentServer({ staticDirectory: 'apps/demo/dist' })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const response = request({ host: '127.0.0.1', port: address.port, path: '/%E0%A4%A' }, (result) => {
        result.resume()
        result.on('end', () => resolve(result.statusCode))
      })
      response.on('error', reject)
      response.end()
    })

    expect(status).toBe(400)
    const health = await fetch(`http://127.0.0.1:${address.port}/health`)
    expect(health.status).toBe(200)
  })

  it('serves the production index from an absolute static directory', async () => {
    staticDirectory = await mkdtemp(join(tmpdir(), 'canvasflow-demo-'))
    await writeFile(join(staticDirectory, 'index.html'), '<h1>CanvasFlow</h1>')
    server = createAgentServer({ staticDirectory })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')

    const response = await fetch(`http://127.0.0.1:${address.port}/`)
    expect(response.status).toBe(200)
    expect(Object.fromEntries(
      Object.keys(LOCAL_VOICE_ISOLATION_HEADERS).map((name) => [name, response.headers.get(name)]),
    )).toEqual(LOCAL_VOICE_ISOLATION_HEADERS)
    await expect(response.text()).resolves.toContain('CanvasFlow')
  })

  it('keeps missing assets as 404 while preserving SPA route fallback', async () => {
    staticDirectory = await mkdtemp(join(tmpdir(), 'canvasflow-demo-'))
    await writeFile(join(staticDirectory, 'index.html'), '<h1>CanvasFlow</h1>')
    server = createAgentServer({ staticDirectory })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')

    const missingScript = await fetch(`http://127.0.0.1:${address.port}/assets/app.js`)
    expect(missingScript.status).toBe(404)

    const spaRoute = await fetch(`http://127.0.0.1:${address.port}/trip/pickup-001`)
    expect(spaRoute.status).toBe(200)
    await expect(spaRoute.text()).resolves.toContain('CanvasFlow')

    const dottedSpaRoute = await fetch(`http://127.0.0.1:${address.port}/trip/v2.1`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    expect(dottedSpaRoute.status).toBe(200)
    await expect(dottedSpaRoute.text()).resolves.toContain('CanvasFlow')
  })
})

describe('resolveStaticPath', () => {
  // The containment guard must hold for both path flavors regardless of the
  // host the suite runs on, so each case injects an explicit implementation.
  it('maps requests into the static directory on POSIX paths', () => {
    expect(resolveStaticPath('/srv/site', '/assets/app.js', posix)).toBe('/srv/site/assets/app.js')
    expect(resolveStaticPath('/srv/site', '/', posix)).toBe('/srv/site/index.html')
  })

  it('maps requests into the static directory on Windows paths', () => {
    // Regression: resolve() yields backslash paths on Windows, and the previous
    // hard-coded '/' prefix comparison rejected every one of them with a 404.
    expect(resolveStaticPath('C:\\srv\\site', '/assets/app.js', win32)).toBe('C:\\srv\\site\\assets\\app.js')
    expect(resolveStaticPath('C:\\srv\\site', '/', win32)).toBe('C:\\srv\\site\\index.html')
  })

  it('rejects paths that escape the static directory on both platforms', () => {
    expect(resolveStaticPath('/srv/site', '../secret', posix)).toBeNull()
    expect(resolveStaticPath('C:\\srv\\site', '..\\secret', win32)).toBeNull()
    expect(resolveStaticPath('C:\\srv\\site', '../secret', win32)).toBeNull()
  })

  it('keeps sibling directories with a shared prefix out of bounds', () => {
    expect(resolveStaticPath('/srv/site', '../site-secrets/key', posix)).toBeNull()
    expect(resolveStaticPath('C:\\srv\\site', '..\\site-secrets\\key', win32)).toBeNull()
  })
})

describe('loadLocalEnvironment', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  async function envFile(contents: string): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'canvasflow-env-'))
    const filePath = join(directory, '.env.local')
    await writeFile(filePath, contents)
    return filePath
  }

  it('loads server-only keys the client bundle never receives', async () => {
    // The whole point: AMAP_SECURITY_JS_CODE has no VITE_ prefix, so Vite never
    // hands it to the browser and only this loader can reach the proxy with it.
    const filePath = await envFile('VITE_AMAP_JS_KEY=client-key\nAMAP_SECURITY_JS_CODE=server-code\n')
    const environment: NodeJS.ProcessEnv = {}

    loadLocalEnvironment(filePath, environment)

    expect(environment.AMAP_SECURITY_JS_CODE).toBe('server-code')
    expect(environment.VITE_AMAP_JS_KEY).toBe('client-key')
  })

  it('never overwrites a value the environment already provides', async () => {
    // A deployed environment outranks a developer's file, so a stale local copy
    // cannot quietly replace the real credential.
    const filePath = await envFile('AMAP_SECURITY_JS_CODE=from-file\n')
    const environment: NodeJS.ProcessEnv = { AMAP_SECURITY_JS_CODE: 'from-deployment' }

    loadLocalEnvironment(filePath, environment)

    expect(environment.AMAP_SECURITY_JS_CODE).toBe('from-deployment')
  })

  it('preserves an explicitly empty environment value', async () => {
    // Empty is a deliberate operator choice: it disables the local credential
    // and keeps the supported keyless path even when .env.local has a value.
    const filePath = await envFile('AMAP_SECURITY_JS_CODE=from-file\n')
    const environment: NodeJS.ProcessEnv = { AMAP_SECURITY_JS_CODE: '' }

    loadLocalEnvironment(filePath, environment)

    expect(environment.AMAP_SECURITY_JS_CODE).toBe('')
  })

  it('treats a blank assignment as absent so the keyless default survives', async () => {
    // env.example ships with empty values; reading it must not define the key.
    const filePath = await envFile('VITE_AMAP_JS_KEY=\nAMAP_SECURITY_JS_CODE=\n')
    const environment: NodeJS.ProcessEnv = {}

    loadLocalEnvironment(filePath, environment)

    expect(environment.VITE_AMAP_JS_KEY).toBeUndefined()
    expect(environment.AMAP_SECURITY_JS_CODE).toBeUndefined()
  })

  it('skips comments, blank lines, and malformed entries', async () => {
    const filePath = await envFile([
      '# a comment',
      '',
      'no-separator-here',
      '=leading-separator',
      '9INVALID=nope',
      'GOOD_KEY=kept',
    ].join('\n'))
    const environment: NodeJS.ProcessEnv = {}

    loadLocalEnvironment(filePath, environment)

    expect(environment).toEqual({ GOOD_KEY: 'kept' })
  })

  it('strips a single layer of matching quotes', async () => {
    const filePath = await envFile('QUOTED="value with spaces"\nSINGLE=\'other\'\n')
    const environment: NodeJS.ProcessEnv = {}

    loadLocalEnvironment(filePath, environment)

    expect(environment.QUOTED).toBe('value with spaces')
    expect(environment.SINGLE).toBe('other')
  })

  it('is a no-op when the file does not exist, keeping the keyless path default', () => {
    const environment: NodeJS.ProcessEnv = {}

    expect(() => loadLocalEnvironment('/nonexistent/canvasflow/.env.local', environment)).not.toThrow()
    expect(environment).toEqual({})
  })
})

describe('resolveAMapServiceUrl', () => {  it('forwards a service path onto restapi.amap.com untouched when no jscode is set', () => {
    expect(resolveAMapServiceUrl('/_AMapService/v3/direction/driving?origin=1,2&destination=3,4', {})).toBe(
      'https://restapi.amap.com/v3/direction/driving?origin=1,2&destination=3,4',
    )
  })

  it('appends the server-only jscode as the last query parameter', () => {
    const url = resolveAMapServiceUrl('/_AMapService/v3/direction/driving?origin=1,2', {
      AMAP_SECURITY_JS_CODE: 'secret-code',
    })
    expect(url).not.toBeNull()
    const parsed = new URL(url!)
    expect(parsed.host).toBe('restapi.amap.com')
    expect(parsed.searchParams.get('jscode')).toBe('secret-code')
  })

  it('rejects requests outside the service prefix', () => {
    expect(resolveAMapServiceUrl('/v3/direction/driving', {})).toBeNull()
    expect(resolveAMapServiceUrl('/_AMapServiceX/foo', {})).toBeNull()
  })

  it('refuses a traversal segment rather than forwarding it', () => {
    expect(resolveAMapServiceUrl('/_AMapService/../evil', {})).toBeNull()
    expect(resolveAMapServiceUrl('/_AMapService/v3/../../evil', {})).toBeNull()
    expect(resolveAMapServiceUrl('/_AMapService/v3/%2e%2e/evil', {})).toBeNull()
  })

  it('cannot be redirected off restapi.amap.com by a protocol-relative path', () => {
    // A `//evil.com/...` request becomes part of restapi.amap.com's path, not a
    // new authority — the pinned origin makes the host un-overridable.
    const url = resolveAMapServiceUrl('/_AMapService//evil.com/steal', {})
    expect(url).not.toBeNull()
    expect(new URL(url!).host).toBe('restapi.amap.com')
  })
})

describe('proxyAMapService', () => {
  type Capture = { status?: number; headers?: Record<string, string>; body: string }

  function fakeResponse(): { response: ServerResponse; capture: Capture } {
    const capture: Capture = { body: '' }
    const response = {
      headersSent: false,
      writableEnded: false,
      writeHead(status: number, headers?: Record<string, string>) {
        capture.status = status
        capture.headers = headers
        this.headersSent = true
        return this
      },
      end(chunk?: Buffer | string) {
        if (chunk) capture.body += chunk.toString()
        this.writableEnded = true
        return this
      },
    }
    return { response: response as unknown as ServerResponse, capture }
  }

  it('streams the upstream body back and never echoes the jscode into the response', async () => {
    let requestedUrl = ''
    const fetchImpl = (async (url: string | URL) => {
      requestedUrl = url.toString()
      return new Response('{"route":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }) as unknown as typeof fetch
    const { response, capture } = fakeResponse()

    await proxyAMapService('/_AMapService/v3/direction/driving?origin=1,2', response, {
      AMAP_SECURITY_JS_CODE: 'secret-code',
    }, fetchImpl)

    expect(capture.status).toBe(200)
    expect(capture.body).toBe('{"route":"ok"}')
    // The code rides on the upstream URL only; the client never sees it.
    expect(requestedUrl).toContain('jscode=secret-code')
    expect(capture.body).not.toContain('secret-code')
  })

  it('passes through unchanged when no jscode is configured', async () => {
    let requestedUrl = ''
    const fetchImpl = (async (url: string | URL) => {
      requestedUrl = url.toString()
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { response } = fakeResponse()

    await proxyAMapService('/_AMapService/v3/geocode?address=x', response, {}, fetchImpl)

    expect(requestedUrl).toContain('restapi.amap.com/v3/geocode')
    expect(requestedUrl).not.toContain('jscode')
  })

  it('answers a rejected target with 400 and does not call upstream', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const { response, capture } = fakeResponse()

    await proxyAMapService('/_AMapService/../evil', response, {}, fetchImpl)

    expect(called).toBe(false)
    expect(capture.status).toBe(400)
  })

  it('answers 502 without leaking anything when the upstream fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const { response, capture } = fakeResponse()

    await proxyAMapService('/_AMapService/v3/direction/driving', response, {
      AMAP_SECURITY_JS_CODE: 'secret-code',
    }, fetchImpl)

    expect(capture.status).toBe(502)
    expect(capture.body).not.toContain('secret-code')
  })
})

describe('proxyVoiceTranscription', () => {
  function fakeResponse() {
    const capture = { status: 0, body: '', headers: {} as Record<string, string> }
    const response = {
      headersSent: false,
      writableEnded: false,
      writeHead(status: number, headers?: Record<string, string>) {
        capture.status = status
        capture.headers = headers ?? {}
        this.headersSent = true
      },
      end(chunk?: Buffer | string) {
        if (chunk) capture.body += chunk.toString()
        this.writableEnded = true
      },
    }
    return { response: response as never, capture }
  }

  it('fails closed when no ASR provider is configured', async () => {
    const { response, capture } = fakeResponse()
    await proxyVoiceTranscription({
      async *[Symbol.asyncIterator]() { yield Buffer.from([1, 2]) },
      headers: {},
    } as never, response, {}, vi.fn() as never)
    expect(capture.status).toBe(503)
    expect(capture.body).toContain('not configured')
  })

  it('forwards PCM bytes and preserves provider response', async () => {
    const { response, capture } = fakeResponse()
    let body = new Uint8Array()
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = new Uint8Array(await new Response(init.body).arrayBuffer())
      return new Response('{"text":"查天气","confidence":0.9}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await proxyVoiceTranscription({
      async *[Symbol.asyncIterator]() { yield Buffer.from([1, 2, 3]) },
      headers: { 'content-type': 'audio/pcm', 'x-voice-generation': '4' },
    } as never, response, { CANVASFLOW_ASR_URL: 'http://asr.test/transcribe' }, fetchImpl as never)
    expect(fetchImpl).toHaveBeenCalledWith('http://asr.test/transcribe', expect.objectContaining({ method: 'POST' }))
    expect([...body]).toEqual([1, 2, 3])
    expect(capture.status).toBe(200)
    expect(capture.body).toContain('查天气')
  })
})
