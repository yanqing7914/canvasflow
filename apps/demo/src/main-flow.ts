import {
  airportPickupTaskStateSchema,
  demoTimelineSchema,
  type AirportPickupTaskState,
  type DemoTimeline,
} from '@canvasflow/schema'
import { applyEvent } from '@canvasflow/agent'
import { memberPreferences } from '@canvasflow/tools'
import mainFlowJson from '../../../fixtures/airport-pickup/timelines/main-flow.json'

/** Shared 5-minute demo timeline — same fixture the tools replay tests consume. */
export const mainFlowTimeline: DemoTimeline = demoTimelineSchema.parse(mainFlowJson)

/**
 * Advance one non-advisory main-flow step: apply the shared fixture event, then
 * merge any planner/tool `statePatch` so the demo stays coupled to the JSON.
 */
export function advanceMainFlowStep(
  task: AirportPickupTaskState,
  preferences = memberPreferences,
): AirportPickupTaskState {
  for (const step of mainFlowTimeline.steps) {
    if (step.advisory) continue
    if (task.processedEventIds.includes(step.event.eventId)) continue
    const next = applyEvent(task, step.event, preferences)
    if (!next.processedEventIds.includes(step.event.eventId)) continue
    return airportPickupTaskStateSchema.parse({ ...next, ...step.statePatch })
  }
  return task
}
