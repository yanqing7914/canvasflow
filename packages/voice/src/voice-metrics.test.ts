import { createVoiceMetrics } from './voice-metrics'

describe('voice metrics', () => {
  it('records immutable events and aggregate counts', () => {
    let timestamp = 10
    const metrics = createVoiceMetrics(() => timestamp++)
    metrics.record('wake', { source: 'kws' })
    metrics.record('barge-in')
    metrics.record('wake')
    expect(metrics.counts()).toMatchObject({ wake: 2, 'barge-in': 1 })
    const snapshot = metrics.snapshot()
    expect(snapshot[0]).toEqual({ name: 'wake', at: 10, source: 'kws' })
    snapshot[0]!.name = 'asr-error'
    expect(metrics.snapshot()[0]!.name).toBe('wake')
  })
})
