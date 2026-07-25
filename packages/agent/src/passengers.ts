import type { AirportPickupTaskState } from '@canvasflow/schema'

export type ParsedPassengers = AirportPickupTaskState['passengers']

const passengerCatalog = [
  { name: '妈妈', memberId: 'mom' },
  { name: '爸爸', memberId: 'dad' },
  { name: '豆豆', memberId: 'doubao' },
] as const

const passengerPhonePhrasePattern = /接(?:一下|一趟)?(?:妈妈|爸爸|豆豆)(?:和(?:妈妈|爸爸|豆豆))*(?:的)?电话/gu

/** Remove phone-call phrases so their names do not fill pickup passenger slots. */
export function stripPassengerPhonePhrases(text: string): string {
  return text.replace(passengerPhonePhrasePattern, '')
}

/** Parse only passenger labels with an explicit product mapping. Unknown names stay missing. */
export function parsePassengers(text: string): ParsedPassengers | undefined {
  const actionableText = stripPassengerPhonePhrases(text)
  const matches = passengerCatalog.filter((passenger) => actionableText.includes(passenger.name))
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
