import { describe, expect, it } from 'vitest'
import type { AirportPickupTaskState } from '@canvasflow/schema'
import { recommendedMeetingPoints } from '@canvasflow/tools'
import { composePickupSpec } from './index'

const timestamp = '2026-07-22T20:00:00+08:00'

/**
 * The demo renders this composer on the local-only path, so an arrival state has
 * to reach the same screen the Agent composes. These cases mirror
 * `packages/agent/src/composer.test.ts` one-for-one; if the two ever answer
 * differently again, one of the two suites fails.
 */
describe('Pickup UISpec composer arrival', () => {
  function arrivedTask(phase: 'approaching-airport' | 'waiting-for-passengers', terminal = 'T2'): AirportPickupTaskState {
    return {
      taskId: 'pickup-001',
      surfaceId: 'airport-pickup-main',
      taskRevision: 4,
      uiRevision: 4,
      phase,
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
      flight: {
        flightNumber: 'MU5102',
        status: 'landed',
        scheduledArrival: '2026-07-22T20:30:00+08:00',
        estimatedArrival: '2026-07-22T20:40:00+08:00',
        terminal,
      },
      navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
      // A completed charge stays `completed` for the rest of the trip. It must not
      // keep owning the brief once the car is at the airport.
      charging: { recommended: true, accepted: true, status: 'completed' },
      message: { autoNotifyAuthorized: false, status: 'idle', landingNoticeSent: false },
      processedEventIds: [],
      updatedAt: timestamp,
    }
  }

  it('shows the recommended meeting point once the car reaches the airport', () => {
    for (const [phase, label, status] of [
      ['approaching-airport', '接近接机点', 'landed'],
      ['waiting-for-passengers', '已停稳，等待家人', 'waiting'],
    ] as const) {
      const spec = composePickupSpec(arrivedTask(phase))

      expect(spec.components, phase).toEqual([expect.objectContaining({
        type: 'passenger-status',
        props: { label, status, meetingPoint: recommendedMeetingPoints.T2!.name },
      })])
      // The stale post-charge card is what used to occupy this screen.
      expect(spec.components.map((component) => component.type), phase).not.toContain('charging-recommendation')
    }
  })

  it('omits the meeting point rather than guessing one for an unknown terminal', () => {
    const spec = composePickupSpec(arrivedTask('waiting-for-passengers', 'T9'))

    expect(spec.components).toEqual([expect.objectContaining({
      type: 'passenger-status',
      props: { label: '已停稳，等待家人', status: 'waiting' },
    })])
  })
})
