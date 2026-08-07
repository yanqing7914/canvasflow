import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import {
  airportPickupTaskStateSchema,
  demoTimelineSchema,
  type AirportPickupTaskState,
  type DemoTimeline,
  type DemoTimelineStep,
} from '@canvasflow/schema'
import { applyEvent } from '@canvasflow/agent'
import { composeFallbackSpec, composePickupSpec } from '@canvasflow/ui'
import { DEMO_ORIGIN, vehicleSnapshots } from './data'
import {
  demoScenarioCatalog,
  demoTimelines,
  demoVehicleSnapshots,
  getDemoTimeline,
  voiceFallbackManifest,
} from '@canvasflow/tools/demo-fixtures'
import { FAILING_CONTACT_ID } from './message'
import { createProviderRegistry } from './registry'

const FIXTURE_DIR = resolve(process.cwd(), 'fixtures/airport-pickup')
const TIMELINE_DIR = resolve(FIXTURE_DIR, 'timelines')
const VOICE_DIR = resolve(FIXTURE_DIR, 'voice')

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function readTimeline(name: string): DemoTimeline {
  return demoTimelineSchema.parse(readJson(resolve(TIMELINE_DIR, name)))
}

function wavFormat(path: string) {
  const data = readFileSync(path)
  expect(data.subarray(0, 4).toString('ascii'), path).toBe('RIFF')
  expect(data.subarray(8, 12).toString('ascii'), path).toBe('WAVE')
  return {
    channels: data.readUInt16LE(22),
    sampleRateHz: data.readUInt32LE(24),
    bitsPerSample: data.readUInt16LE(34),
  }
}

function flightNumber(step: DemoTimelineStep): string | undefined {
  if (step.event.type === 'flight.updated') return step.event.flight.flightNumber
  if (step.event.type !== 'user.input') return undefined
  return step.event.text.toUpperCase().match(/[A-Z]{2}\s*\d{4}/)?.[0]?.replace(/\s+/g, '')
}

function executeReadTool(
  timeline: DemoTimeline,
  step: DemoTimelineStep,
  tool: string,
  state: AirportPickupTaskState,
  registry = createProviderRegistry(),
) {
  const ctx = { taskId: timeline.initialTaskState.taskId }
  if (tool === 'family.resolve-members') {
    const labels = ['妈妈', '爸爸', '豆豆'].filter((label) =>
      step.event.type === 'user.input' && step.event.text.includes(label),
    )
    return registry[tool](ctx, { labels })
  }
  if (tool === 'flight.get-status') {
    return registry[tool](ctx, {
      flightNumber: flightNumber(step) ?? state.flight?.flightNumber ?? (timeline.id === 'provider-timeout' ? 'MU0000' : undefined),
      date: '2026-07-22',
    })
  }
  if (tool === 'navigation.plan-route') {
    return registry[tool](ctx, {
      origin: { ...DEMO_ORIGIN },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    })
  }
  if (tool === 'navigation.start') {
    return registry[tool](ctx, {
      routeId: state.navigation?.routeId ?? 'route-airport-001',
      idempotencyKey: `${timeline.id}:navigation-start`,
    })
  }
  if (tool === 'navigation.update-route') {
    const via = timeline.id === 'route-reroute'
      ? [{ id: 'via-ring-road-01', name: '外环快速路' }]
      : step.event.type === 'charging.started'
        ? [{ id: 'station-hongqiao-01', name: '虹桥超充站' }]
        : undefined
    const returningHome = step.event.type === 'user.confirmed-passengers-onboard'
    const destination = returningHome
      ? { id: 'destination-home', name: '家' }
      : { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' }
    const currentRouteId = state.navigation?.routeId ?? 'route-airport-001'
    if (currentRouteId === 'route-airport-via-charge-001') {
      const prior = registry['navigation.plan-route'](ctx, {
        origin: { ...DEMO_ORIGIN },
        destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
        via: [{ id: 'station-hongqiao-01', name: '虹桥超充站' }],
      })
      if (!prior.ok) return prior
    }
    const planned = registry['navigation.plan-route'](ctx, {
      origin: { ...DEMO_ORIGIN },
      destination,
      ...(via ? { via } : {}),
    })
    if (!planned.ok || !planned.data) return planned
    return registry[tool](ctx, {
      routeId: currentRouteId,
      destination,
      ...(via ? { via } : {}),
      idempotencyKey: `${timeline.id}:${step.event.eventId}:navigation-update`,
    })
  }
  if (tool === 'vehicle.get-status') {
    return registry[tool](ctx, {
      snapshot: timeline.id === 'charging-completed' ? 'post-charge' : 'parked',
    })
  }
  if (tool === 'charging.recommend') {
    const vehicle = timeline.id === 'charging-completed' ? vehicleSnapshots['post-charge'] : vehicleSnapshots.parked
    return registry[tool](ctx, {
      batteryPercent: vehicle.batteryPercent,
      remainingRangeKm: vehicle.remainingRangeKm,
      outboundDistanceKm: 32,
      returnDistanceKm: 32,
      safetyReservePercent: 20,
    })
  }
  if (tool === 'message.prepare') {
    return registry[tool](ctx, {
      contactId: timeline.id === 'message-failed' ? FAILING_CONTACT_ID : 'contact-mom',
      flightNumber: state.flight?.flightNumber ?? 'MU5102',
      eta: '20:52',
    })
  }
  if (tool === 'message.send') {
    const contactId = timeline.id === 'message-failed' ? FAILING_CONTACT_ID : 'contact-mom'
    const prepared = registry['message.prepare'](ctx, {
      contactId,
      flightNumber: state.flight?.flightNumber ?? 'MU5102',
      eta: '20:52',
    })
    if (!prepared.ok || !prepared.data) return prepared
    return registry[tool](ctx, {
      contactId: prepared.data.contactId,
      messageId: prepared.data.messageId,
      text: prepared.data.text,
      confirmationId: prepared.data.confirmationId,
      idempotencyKey: `${timeline.id}:message-send`,
    })
  }
  if (tool === 'memory.get-preferences') {
    return registry[tool](ctx, {
      memberIds: state.passengers.memberIds,
      scopes: ['cabin', 'media'],
    })
  }
  if (tool === 'vehicle.apply-cabin-profile') {
    const preferences = registry['memory.get-preferences'](ctx, {
      memberIds: state.passengers.memberIds,
      scopes: ['cabin', 'media'],
    })
    if (!preferences.ok || !preferences.data) return preferences
    const temperatureC = preferences.data.members.find((member) => member.rearTemperatureC !== undefined)?.rearTemperatureC
    const mediaTitle = preferences.data.members.find((member) => member.mediaTitle !== undefined)?.mediaTitle
    return registry[tool](ctx, {
      zone: 'rear',
      ...(temperatureC !== undefined ? { temperatureC } : {}),
      ...(mediaTitle !== undefined ? { mediaTitle } : {}),
      sourceMemberIds: state.passengers.memberIds,
      idempotencyKey: `${timeline.id}:cabin-profile`,
    })
  }
  if (tool === 'media.play') {
    const preferences = registry['memory.get-preferences'](ctx, {
      memberIds: state.passengers.memberIds,
      scopes: ['media'],
    })
    if (!preferences.ok || !preferences.data) return preferences
    const mediaTitle = preferences.data.members.find((member) => member.mediaTitle !== undefined)?.mediaTitle
    if (!mediaTitle) return preferences
    return registry[tool](ctx, {
      mediaTitle,
      sourceMemberId: 'doubao',
      idempotencyKey: `${timeline.id}:media-play`,
    })
  }
  if (tool === 'memory.propose-update') {
    return registry[tool](ctx, {
      memberId: state.passengers.memberIds[0] ?? 'mom',
      changes: { rearTemperatureC: 25 },
    })
  }
  throw new Error(`Unsupported demo-readiness tool: ${tool}`)
}

describe('voice fallback fixtures', () => {
  const manifest = voiceFallbackManifest

  it('ships the canonical main-flow and low-confidence samples', () => {
    expect(manifest).toMatchObject({ version: '1.0', language: 'zh-CN', sampleRateHz: 16000, channels: 1 })
    expect(manifest.samples.map((sample) => sample.id)).toEqual([
      'create-airport-pickup',
      'select-first-flight',
      'flight-number',
      'noisy-create',
      'check-weather',
      'start-navigation',
      'send-weather-reminder',
      'dismiss-weather-advisory',
    ])
    expect(manifest.samples.find((sample) => sample.id === 'noisy-create')).toMatchObject({
      requiresConfirmation: true,
    })
    expect(manifest.samples.find((sample) => sample.id === 'noisy-create')!.confidence).toBeLessThan(0.6)
  })

  it('keeps every referenced WAV in the documented browser-ASR format', () => {
    for (const sample of manifest.samples) {
      expect(extname(sample.file)).toBe('.wav')
      expect(sample.file).toBe(basename(sample.file))
      expect(sample.text.trim().length).toBeGreaterThan(0)
      expect(sample.confidence).toBeGreaterThanOrEqual(0)
      expect(sample.confidence).toBeLessThanOrEqual(1)
      expect(wavFormat(resolve(VOICE_DIR, sample.file))).toEqual({
        channels: manifest.channels,
        sampleRateHz: manifest.sampleRateHz,
        bitsPerSample: 16,
      })
      expect(readFileSync(resolve(VOICE_DIR, sample.file)).length).toBeLessThan(10 * manifest.sampleRateHz * manifest.channels * 2 + 1024)
    }
  })

  it('replays the canonical fixed transcripts into a prepared airport task', () => {
    const createSample = manifest.samples.find((sample) => sample.id === 'create-airport-pickup')!
    const flightSample = manifest.samples.find((sample) => sample.id === 'flight-number')!
    let state = demoTimelines['main-flow'].initialTaskState
    state = applyEvent(state, {
      eventId: 'voice-create-airport-pickup',
      type: 'user.input',
      text: createSample.text,
      timestamp: '2026-07-22T20:00:00+08:00',
    })
    state = airportPickupTaskStateSchema.parse({
      ...state,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
    })
    expect(state.phase).toBe('collecting-information')

    state = applyEvent(state, {
      eventId: 'voice-flight-number',
      type: 'user.input',
      text: flightSample.text,
      timestamp: '2026-07-22T20:01:00+08:00',
    })
    expect(state).toMatchObject({
      phase: 'preparing',
      flight: { flightNumber: 'MU5102', trusted: false },
      passengers: { memberIds: ['mom', 'doubao'] },
    })

    const provider = createProviderRegistry()['flight.get-status'](
      { taskId: state.taskId },
      { flightNumber: state.flight!.flightNumber, date: '2026-07-22' },
    )
    expect(provider).toMatchObject({ ok: true, meta: { provider: 'fixture' } })
  })

  it('keeps the low-confidence transcript pending confirmation', () => {
    const noisy = manifest.samples.find((sample) => sample.id === 'noisy-create')!
    expect(noisy).toMatchObject({ requiresConfirmation: true })
    expect(noisy.confidence).toBeLessThan(0.6)
    expect(noisy.text).toBe(manifest.samples.find((sample) => sample.id === 'create-airport-pickup')!.text)
  })
})

describe('replayable exception timelines', () => {
  const names = [
    'main-flow.json',
    'provider-timeout.json',
    'flight-delayed.json',
    'flight-cancelled.json',
    'message-failed.json',
    'charging-completed.json',
    'route-reroute.json',
  ]

  it('parses every timeline and references registered tools', () => {
    const registry = createProviderRegistry()
    expect(readdirSync(TIMELINE_DIR).filter((name) => name.endsWith('.json')).sort()).toEqual([
      'charging-completed.json',
      'flight-cancelled.json',
      'flight-delayed.json',
      'main-flow.json',
      'message-failed.json',
      'provider-timeout.json',
      'route-reroute.json',
    ])
    for (const name of names) {
      const timeline = readTimeline(name)
      for (const step of timeline.steps) {
        for (const tool of step.toolCalls ?? []) {
          expect(Object.hasOwn(registry, tool), `${timeline.id}:${step.event.eventId}:${tool}`).toBe(true)
        }
      }
    }
  })

  it('exports one stable catalog entry per replayable timeline', () => {
    expect(demoScenarioCatalog.map((scenario) => scenario.id)).toEqual([
      'main-flow',
      'provider-timeout',
      'flight-delayed',
      'flight-cancelled',
      'route-reroute',
      'message-failed',
      'charging-completed',
    ])
    expect(Object.keys(demoTimelines)).toEqual(demoScenarioCatalog.map((scenario) => scenario.id))
    for (const scenario of demoScenarioCatalog) {
      expect(getDemoTimeline(scenario.id)).toMatchObject({
        id: scenario.id,
        title: scenario.title,
        mode: scenario.mode,
      })
      expect(getDemoTimeline(scenario.id).steps).toHaveLength(scenario.stepCount)
    }
  })

  it('exports the vehicle speed, battery, gear, occupancy, and night presets', () => {
    expect(demoVehicleSnapshots).toEqual(vehicleSnapshots)
    expect(demoVehicleSnapshots.parked).toMatchObject({ speedKph: 0, gear: 'P', isNight: true })
    expect(demoVehicleSnapshots['highway-driving']).toMatchObject({ speedKph: 80, gear: 'D' })
    expect(demoVehicleSnapshots['rear-occupied']).toMatchObject({ rearOccupied: true })
    expect(demoVehicleSnapshots['low-battery-highway'].batteryPercent).toBeLessThan(20)
  })

  it('replays timeline phase/revision expectations and validates provider errors', () => {
    for (const name of names) {
      const timeline = readTimeline(name)
      const registry = createProviderRegistry()
      let state = timeline.initialTaskState
      for (const step of timeline.steps) {
        const next = applyEvent(state, step.event)
        if (step.advisory) {
          expect(next, `${timeline.id}:${step.event.eventId}`).toEqual(state)
        } else {
          expect(next.processedEventIds, `${timeline.id}:${step.event.eventId}:unhandled event`)
            .toContain(step.event.eventId)
        }

        for (const tool of step.toolCalls ?? []) {
          const result = executeReadTool(timeline, step, tool, next, registry)
          const expectedError = step.expectedToolErrors?.[tool]
          if (expectedError) {
            expect(result.error?.code, `${timeline.id}:${step.event.eventId}:${tool}`).toBe(expectedError)
          } else {
            expect(result, `${timeline.id}:${step.event.eventId}:${tool} ${JSON.stringify(result.error)}`).toMatchObject({ ok: true })
          }
        }

        if (!step.advisory) state = airportPickupTaskStateSchema.parse({ ...next, ...step.statePatch })
        if (step.expectedUI) {
          const expected = step.expectedUI
          const spec = expected.generatedBy === 'fallback'
            ? composeFallbackSpec(state, expected.fallback!.title, expected.fallback!.message, expected.fallback!.level)
            : composePickupSpec(state)
          // A route panel takes the first slot of the split so the density trim
          // eats cards off the end of the brief rather than the map out of its
          // own column. The component the timeline names is the card the brief
          // leads with, which is the one after it.
          const [first, ...rest] = spec.components
          const leadingCard = first?.type === 'route-map' ? rest[0] : first
          expect(rest.some((component) => component.type === 'route-map'), `${timeline.id}:${step.event.eventId}:ui`).toBe(false)
          expect(leadingCard?.type, `${timeline.id}:${step.event.eventId}:ui`).toBe(expected.primaryComponent)
          expect(spec.presentation.priority, `${timeline.id}:${step.event.eventId}:ui`).toBe(expected.priority)
          expect(spec.meta.generatedBy, `${timeline.id}:${step.event.eventId}:ui`).toBe(expected.generatedBy)
        }
        expect(state.phase, `${timeline.id}:${step.event.eventId}:phase`).toBe(step.expectedPhase)
        expect(state.taskRevision, `${timeline.id}:${step.event.eventId}:revision`).toBe(step.expectedTaskRevision)
      }
    }
  })

  it('exposes distinct route geometry for the frontend handoff', () => {
    const registry = createProviderRegistry()
    const ctx = { taskId: 'geometry-handoff' }
    const airport = { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' }
    const direct = registry['navigation.plan-route'](ctx, { origin: { ...DEMO_ORIGIN }, destination: airport })
    const bypass = registry['navigation.plan-route'](ctx, {
      origin: { ...DEMO_ORIGIN },
      destination: airport,
      via: [{ id: 'via-ring-road-01', name: '外环快速路' }],
    })
    expect(direct.data?.summary).not.toBe(bypass.data?.summary)
    expect(direct.data?.polyline).not.toEqual(bypass.data?.polyline)
    expect(bypass.data?.waypoints?.map((point) => point.id)).toContain('via-ring-road-01')
  })
})
