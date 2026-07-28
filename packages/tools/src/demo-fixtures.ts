import {
  demoTimelineSchema,
  vehicleStatusOutputSchema,
  voiceFixtureManifestSchema,
  type DemoTimeline,
} from '@canvasflow/schema'
import { vehicleSnapshots } from './data'
import flightCancelledJson from '../../../fixtures/airport-pickup/timelines/flight-cancelled.json'
import flightDelayedJson from '../../../fixtures/airport-pickup/timelines/flight-delayed.json'
import chargingCompletedJson from '../../../fixtures/airport-pickup/timelines/charging-completed.json'
import mainFlowJson from '../../../fixtures/airport-pickup/timelines/main-flow.json'
import messageFailedJson from '../../../fixtures/airport-pickup/timelines/message-failed.json'
import providerTimeoutJson from '../../../fixtures/airport-pickup/timelines/provider-timeout.json'
import routeRerouteJson from '../../../fixtures/airport-pickup/timelines/route-reroute.json'
import voiceManifestJson from '../../../fixtures/airport-pickup/voice/transcripts.json'

function parseTimeline<TId extends string>(id: TId, raw: unknown): DemoTimeline & { id: TId } {
  const timeline = demoTimelineSchema.parse(raw)
  if (timeline.id !== id) throw new Error(`Demo timeline id mismatch: expected ${id}, received ${timeline.id}`)
  return timeline as DemoTimeline & { id: TId }
}

export const demoTimelines = {
  'main-flow': parseTimeline('main-flow', mainFlowJson),
  'provider-timeout': parseTimeline('provider-timeout', providerTimeoutJson),
  'flight-delayed': parseTimeline('flight-delayed', flightDelayedJson),
  'flight-cancelled': parseTimeline('flight-cancelled', flightCancelledJson),
  'route-reroute': parseTimeline('route-reroute', routeRerouteJson),
  'message-failed': parseTimeline('message-failed', messageFailedJson),
  'charging-completed': parseTimeline('charging-completed', chargingCompletedJson),
} as const

export type DemoTimelineId = keyof typeof demoTimelines

/** Ordered catalog for a Demo scenario picker or offline replay runner. */
export const demoScenarioCatalog = (Object.entries(demoTimelines) as Array<
  [DemoTimelineId, (typeof demoTimelines)[DemoTimelineId]]
>).map(([id, timeline]) => ({
  id,
  title: timeline.title,
  description: timeline.description,
  mode: timeline.mode,
  stepCount: timeline.steps.length,
}))

export const voiceFallbackManifest = voiceFixtureManifestSchema.parse(voiceManifestJson)

export const demoVehicleSnapshots = Object.fromEntries(
  Object.entries(vehicleSnapshots).map(([name, snapshot]) => [name, vehicleStatusOutputSchema.parse(snapshot)]),
) as typeof vehicleSnapshots

export function getDemoTimeline(id: DemoTimelineId): DemoTimeline {
  return demoTimelines[id]
}
