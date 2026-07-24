/**
 * Extracts the airport-pickup flight format accepted by the POC and stores it
 * in one canonical form, regardless of how the user separates the prefix.
 */
export function normalizeFlightNumber(text: string): string | undefined {
  const match = text.match(/(?<![A-Za-z0-9])MU(?:[ \t]*-?[ \t]*)?(\d{4})(?![A-Za-z0-9])/i)
  return match ? `MU${match[1]}` : undefined
}
