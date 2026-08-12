import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { scenarioFixtureSchema, type UISpec } from '@canvasflow/schema'
import { applyEvent } from './index'
import { composeAgentSpec } from './composer'
import type { ReadToolResults } from './orchestration'

// The airport-pickup fixtures carry an `expectedUISpec` that is authored against
// the UI-side composer, composePickupSpec (see packages/schema/src/fixtures.test.ts).
// The SHIPPED production path renders composeAgentSpec instead. Nothing pinned
// composeAgentSpec to the same fixtures, so the two composers could drift to a
// user-visible degree with every other test still green — exactly the drift
// fixed in PR #81. This suite closes that gap: it asserts composeAgentSpec
// against the same fixtures, locks the two known divergences as deliberate, and
// forces every future fixture to be categorized here.

const FIXTURE_DIR = resolve(process.cwd(), 'fixtures/airport-pickup')

function load(name: string) {
  const parsed = scenarioFixtureSchema.parse(
    JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8')),
  )
  const after = applyEvent(parsed.initialTaskState, parsed.inputEvent)
  const spec = composeAgentSpec(after, parsed.toolResults as unknown as ReadToolResults)
  return { parsed, spec }
}

// uiRevision is bookkeeping (fixture authors pin it independently) and traceId is
// non-deterministic; everything else — title, density, priority, every component
// prop, actions, generatedAt — is asserted verbatim.
function normalize(spec: UISpec, uiRevision: number) {
  return { ...spec, uiRevision, meta: { ...spec.meta, traceId: '<trace>' } }
}

function componentTypes(spec: { components: ReadonlyArray<{ type: string }> }) {
  return spec.components.map((component) => component.type)
}

// Fixtures whose expectedUISpec the shipped composer reproduces byte-for-byte
// (after normalizing uiRevision + traceId). This is the regression lock.
const AGREE = [
  'approaching-airport',
  'charging-completed',
  'charging-recommended',
  'flight-cancelled',
  'flight-delayed',
  'flight-in-air',
  'flight-landed',
  'message-scheduled',
  'passengers-onboard',
  'schedule-checked',
  'task-created',
  'trip-completed',
  'weather-checked',
] as const

// Fixtures that capture composeFallbackSpec (a degraded template), NOT the normal
// composer. composeAgentSpec is unaware of the provider failure and returns the
// full spec; production drives composeFallbackSpec here with different
// titles/component-ids (gateway.ts). They are asserted against composeFallbackSpec
// in packages/schema/src/fixtures.test.ts and are intentionally excluded here.
const FALLBACK = ['provider-timeout', 'invalid-ui-spec'] as const

// Fixtures where the shipped composer legitimately diverges from the UI composer.
// Each is pinned below with the reason and why the fix is out of scope here.
const DIVERGENT = ['route-airport', 'cabin-profile-applied'] as const

describe('composeAgentSpec fixture conformance', () => {
  it.each(AGREE)('%s: shipped composer reproduces the fixture UISpec exactly', (name) => {
    const { parsed, spec } = load(name)
    const uiRevision = parsed.expectedUISpec.uiRevision
    expect(normalize(spec, uiRevision), name).toEqual(
      normalize(parsed.expectedUISpec as UISpec, uiRevision),
    )
  })

  it('route-airport: KNOWN DIVERGENCE — shipped composer is over-eager on charging', () => {
    const { parsed, spec } = load('route-airport')
    // The user has just started driving to the airport (navigation active, no
    // flight fact yet), so the salient card is the route. The fixture / UI
    // composer (composePickupSpec) now give the route its own column: a
    // route-map split beside navigation-summary. composeAgentSpec instead fires
    // its `task.charging.recommended && !task.flight` branch — which sits ahead
    // of the `task.navigation` branch — and shows a charging card, the same
    // class of over-eager charging fixed for the arrival phases in PR #81 ①.
    // Fixing it is a Composer phase-decision change (PRODUCT.md Non-goal) and
    // reorders branches that gateway.test.ts relies on, so it is deferred to a
    // dedicated follow-up. This pins the current shipped output so that follow-up
    // is a deliberate, reviewed change rather than silent drift.
    expect(componentTypes(parsed.expectedUISpec)).toEqual(['route-map', 'navigation-summary'])
    expect(componentTypes(spec)).toEqual(['charging-recommendation'])
  })

  it('cabin-profile-applied: KNOWN DIVERGENCE — shipped composer does not surface the applied cabin profile', () => {
    const { parsed, spec } = load('cabin-profile-applied')
    // composePickupSpec reads the vehicle.apply-cabin-profile / memory.get-preferences
    // tool results and renders a cabin-profile card. composeAgentSpec has no such
    // branch and falls through to a generic returning-home passenger-status. This
    // is a feature GAP in the shipped composer, not a correctness win. Adding the
    // branch is a Composer decision change (Non-goal) — deferred to a follow-up.
    expect(componentTypes(parsed.expectedUISpec)).toEqual(['cabin-profile'])
    expect(componentTypes(spec)).toEqual(['passenger-status'])
  })

  it('waiting-for-passengers: cockpit adds the real passenger-onboard action', () => {
    const { parsed, spec } = load('waiting-for-passengers')
    expect(componentTypes(spec)).toEqual(componentTypes(parsed.expectedUISpec))
    expect(spec.components[0]?.actions).toEqual(['confirm-passengers-onboard'])
    expect(spec.actions).toEqual([expect.objectContaining({
      id: 'confirm-passengers-onboard',
      label: '乘客已上车',
      event: { type: 'agent-message', text: '家人上车' },
    })])
  })

  it('fallback fixtures are not composeAgentSpec targets', () => {
    // Documents why FALLBACK is excluded: composeAgentSpec, unaware of the
    // provider failure, produces a materially different (fuller) spec than the
    // degraded template the fixture pins.
    for (const name of FALLBACK) {
      const { parsed, spec } = load(name)
      expect(componentTypes(spec), name).not.toEqual(componentTypes(parsed.expectedUISpec))
    }
  })

  it('every airport-pickup fixture is categorized by this suite', () => {
    // Anti-drift guard: a new fixture (or a renamed one) must be sorted into
    // AGREE, DIVERGENT, or FALLBACK, forcing a conscious decision about how the
    // shipped composer should treat it. No silent gaps.
    const files = readdirSync(FIXTURE_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
    const categorized = new Set<string>([...AGREE, ...DIVERGENT, ...FALLBACK, 'waiting-for-passengers'])
    expect(files.filter((file) => !categorized.has(file))).toEqual([])
    expect(categorized.size).toBe(files.length)
    expect(files).toHaveLength(18)
  })
})
