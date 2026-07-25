import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentServer, createConfiguredAgentRuntime, serverHost, serverPort } from './server-runtime'

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

  it('serves the health endpoint from the configured runtime', async () => {
    server = createAgentServer()
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    const response = await fetch(`http://127.0.0.1:${address.port}/health`)
    expect(response.status).toBe(200)
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
    await expect(response.text()).resolves.toContain('CanvasFlow')
  })
})
