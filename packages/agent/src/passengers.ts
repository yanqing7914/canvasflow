import type { AirportPickupTaskState } from '@canvasflow/schema'

export type ParsedPassengers = AirportPickupTaskState['passengers']

const passengerCatalog = [
  { name: '妈妈', memberId: 'mom' },
  { name: '爸爸', memberId: 'dad' },
  { name: '豆豆', memberId: 'doubao' },
] as const

/** Parse only passenger labels with an explicit product mapping. Unknown names stay missing. */
export function parsePassengers(text: string): ParsedPassengers | undefined {
  const matches = passengerCatalog.filter((passenger) => text.includes(passenger.name))
  if (matches.length === 0) return undefined
  return {
    memberIds: matches.map((passenger) => passenger.memberId),
    names: matches.map((passenger) => passenger.name),
    confirmedOnboard: false,
  }
}

export function parsePassengerLabels(text: string): string[] {
  return parsePassengers(text)?.names ?? []
}

export function mergePassengers(
  current: ParsedPassengers,
  parsed: Pick<ParsedPassengers, 'memberIds' | 'names'> | undefined,
): ParsedPassengers {
  if (!parsed) return current
  const merged = new Map<string, string>()
  current.memberIds.forEach((memberId, index) => merged.set(memberId, current.names[index] ?? memberId))
  parsed.memberIds.forEach((memberId, index) => merged.set(memberId, parsed.names[index] ?? memberId))
  return {
    memberIds: [...merged.keys()],
    names: [...merged.values()],
    confirmedOnboard: current.confirmedOnboard,
  }
}
