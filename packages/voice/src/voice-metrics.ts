export type VoiceMetricName = 'wake' | 'false-wake' | 'speech-start' | 'speech-end' | 'barge-in' | 'asr-submit' | 'asr-error'
export type VoiceMetric = { name: VoiceMetricName; at: number; value?: number; source?: string }

export function createVoiceMetrics(now: () => number = () => Date.now()) {
  const entries: VoiceMetric[] = []
  return {
    record(name: VoiceMetricName, details: Omit<VoiceMetric, 'name' | 'at'> = {}) {
      entries.push({ name, at: now(), ...details })
    },
    snapshot(): readonly VoiceMetric[] { return entries.map((entry) => ({ ...entry })) },
    counts(): Readonly<Record<VoiceMetricName, number>> {
      const counts = {} as Record<VoiceMetricName, number>
      for (const entry of entries) counts[entry.name] = (counts[entry.name] ?? 0) + 1
      return counts
    },
    clear() { entries.length = 0 },
  }
}
