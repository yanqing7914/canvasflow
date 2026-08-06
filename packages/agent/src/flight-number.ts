/**
 * Extracts a flight number and stores it in one canonical form, regardless of
 * how the user separates the prefix.
 *
 * The carriers are an explicit allowlist rather than a two-letter wildcard: the
 * arrivals board offers these airlines, and `[A-Z]{2}\d{4}` would read an
 * ordinary word followed by four digits as a flight. Putting a new airline on
 * the board means adding it here too, or its rows become unpickable.
 */
const CARRIERS = ['MU', 'CA', 'CZ', 'HO', 'FM'] as const

const FLIGHT_NUMBER = new RegExp(
  `(?<![A-Za-z0-9])(${CARRIERS.join('|')})(?:[ \\t]*-?[ \\t]*)?(\\d{4})(?![A-Za-z0-9])`,
  'i',
)

export function normalizeFlightNumber(text: string): string | undefined {
  const match = text.match(FLIGHT_NUMBER)
  return match ? `${match[1]!.toUpperCase()}${match[2]}` : undefined
}
