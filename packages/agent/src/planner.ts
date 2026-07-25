import type { AirportPickupEvent, AirportPickupTaskState } from '@canvasflow/schema'
import { normalizeFlightNumber } from './flight-number'
import { parsePassengers, stripPassengerPhonePhrases } from './passengers'

export type PlannerIntent =
  | 'create-airport-pickup'
  | 'provide-flight-number'
  | 'start-navigation'
  | 'plan-charging'
  | 'confirm-passengers-onboard'
  | 'cancel-task'
  | 'unknown'

export type PlannerSlot = 'passengers' | 'flightNumber'

export type PlannerSlotUpdates = {
  passengers?: AirportPickupTaskState['passengers']
  flightNumber?: string
  navigation?: { requested: true }
  charging?: Pick<AirportPickupTaskState['charging'], 'recommended' | 'accepted' | 'status'>
  passengersOnboard?: boolean
  cancelled?: boolean
}

export type Plan = {
  intent: PlannerIntent
  confidence: number
  slotUpdates: PlannerSlotUpdates
  missingSlots: PlannerSlot[]
  proposedEvents: AirportPickupEvent[]
  assistantText: string
}

export type PlannerInput = {
  text: string
  state?: AirportPickupTaskState
  eventId?: string
  timestamp?: string
  routeId?: string
}

const fallbackTimestamp = '1970-01-01T00:00:00.000Z'

/** A pure, deterministic parser. Applying events and executing tools are caller responsibilities. */
export class Planner {
  plan(input: string | PlannerInput, state?: AirportPickupTaskState): Plan {
    return planAirportPickup(typeof input === 'string' ? { text: input, state } : input)
  }
}

export function planAirportPickup(input: PlannerInput): Plan {
  const text = input.text.trim()
  const compactText = text.replace(/\s+/g, '')
  const actionableText = stripPassengerPhonePhrases(compactText)
  const state = input.state
  const flightNumber = normalizeFlightNumber(text)
  const passengers = parsePassengers(text)
  const eventBase = {
    eventId: input.eventId ?? `planner-${stableHash(compactText || 'empty')}`,
    timestamp: input.timestamp ?? state?.updatedAt ?? fallbackTimestamp,
  }

  if (isTaskCancellation(compactText)) {
    return {
      intent: 'cancel-task',
      confidence: 0.99,
      slotUpdates: { cancelled: true },
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.cancelled-task', reason: text }],
      assistantText: '好的，已准备取消本次接机任务。',
    }
  }

  if (/已经接到她们|接到她们了|家人(?:已经)?上车|她们(?:已经)?上车/.test(compactText)) {
    if (state?.phase !== 'waiting-for-passengers') {
      return {
        intent: 'confirm-passengers-onboard',
        confidence: 0.99,
        slotUpdates: {},
        missingSlots: [],
        proposedEvents: [],
        assistantText: '请在车辆停稳并到达接机点后，再确认家人已经上车。',
      }
    }
    return {
      intent: 'confirm-passengers-onboard',
      confidence: 0.99,
      slotUpdates: { passengersOnboard: true },
      missingSlots: [],
      proposedEvents: [{ ...eventBase, type: 'user.confirmed-passengers-onboard' }],
      assistantText: '收到，已准备将家人标记为上车并进入返程。',
    }
  }

  if (/先去(?:充电|补能)/.test(compactText)) {
    return {
      intent: 'plan-charging',
      confidence: 0.98,
      slotUpdates: { charging: { recommended: true, accepted: true, status: 'planned' } },
      missingSlots: pickupMissingSlots(state, passengers, flightNumber),
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: '好的，已准备把补能安排在前往机场之前。',
    }
  }

  if (/开始导航/.test(compactText)) {
    const routeId = input.routeId ?? `route-airport-${stableHash(state?.taskId ?? compactText)}`
    return {
      intent: 'start-navigation',
      confidence: 0.98,
      slotUpdates: { navigation: { requested: true } },
      missingSlots: pickupMissingSlots(state, passengers, flightNumber),
      proposedEvents: [{ ...eventBase, type: 'navigation.started', routeId }],
      assistantText: '好的，已准备开始前往机场的导航。',
    }
  }

  const isPickupRequest = /去机场接/.test(actionableText)
    || /机场接(?:人|妈妈|爸爸|豆豆)/.test(actionableText)
    || /接(?:一下|一趟)?(?:妈妈|爸爸|豆豆)/.test(actionableText)
  if (isPickupRequest) {
    const missingSlots = pickupMissingSlots(state, passengers, flightNumber)
    return {
      intent: 'create-airport-pickup',
      confidence: 0.99,
      slotUpdates: {
        ...(passengers ? { passengers } : {}),
        ...(flightNumber ? { flightNumber } : {}),
      },
      missingSlots,
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: missingSlots.includes('flightNumber')
        ? '好的，请告诉我她们的航班号。'
        : '好的，接机信息已齐全，可以继续安排行程。',
    }
  }

  if (flightNumber) {
    const missingSlots = pickupMissingSlots(state, passengers, flightNumber)
    return {
      intent: 'provide-flight-number',
      confidence: 0.99,
      slotUpdates: {
        flightNumber,
        ...(passengers ? { passengers } : {}),
      },
      missingSlots,
      proposedEvents: [{ ...eventBase, type: 'user.input', text }],
      assistantText: missingSlots.includes('passengers')
        ? `收到航班号 ${flightNumber}，请告诉我要接谁。`
        : `收到，航班号是 ${flightNumber}。`,
    }
  }

  return {
    intent: 'unknown',
    confidence: 0.2,
    slotUpdates: {},
    missingSlots: pickupMissingSlots(state, passengers, flightNumber),
    proposedEvents: [],
    assistantText: '我还不能确定你的接机安排，请换一种说法。',
  }
}

function pickupMissingSlots(
  state: AirportPickupTaskState | undefined,
  parsedPassengers: AirportPickupTaskState['passengers'] | undefined,
  parsedFlightNumber: string | undefined,
): PlannerSlot[] {
  const missing: PlannerSlot[] = []
  if (!parsedPassengers && !state?.passengers.names.length) missing.push('passengers')
  if (!parsedFlightNumber && !state?.flight?.flightNumber) missing.push('flightNumber')
  return missing
}

function isTaskCancellation(text: string): boolean {
  return /取消(?:这个|本次)?(?:接机)?任务|取消接机|不去接了|不用接了|别去机场了/.test(text)
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
