import { describe, expect, it } from 'vitest'
import {
  graphemeLen,
  isBlankTranscript,
  mergeInterim,
  normalizeConfidence,
  normalizeTranscript,
} from './transcript'

describe('graphemeLen', () => {
  it('counts a CJK character as one', () => {
    expect(graphemeLen('嗯')).toBe(1)
    expect(graphemeLen('接妈妈')).toBe(3)
  })
})

describe('normalizeTranscript', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeTranscript('  MU  5102 \n')).toBe('MU 5102')
  })
})

describe('isBlankTranscript', () => {
  it('treats empty and whitespace-only text as blank', () => {
    expect(isBlankTranscript('')).toBe(true)
    expect(isBlankTranscript('   \n ')).toBe(true)
  })

  it('treats punctuation-only ASR noise as blank', () => {
    expect(isBlankTranscript('。')).toBe(true)
    expect(isBlankTranscript('，。…')).toBe(true)
  })

  it('keeps real content', () => {
    expect(isBlankTranscript('嗯')).toBe(false)
    expect(isBlankTranscript('去机场接妈妈')).toBe(false)
  })
})

describe('mergeInterim', () => {
  it('returns the stable text when there is no partial', () => {
    expect(mergeInterim('去机场', '')).toBe('去机场')
  })

  it('returns the partial when there is no stable text', () => {
    expect(mergeInterim('', '去机场')).toBe('去机场')
  })

  it('drops a partial the stable text already covers', () => {
    expect(mergeInterim('去机场接妈妈', '接妈妈')).toBe('去机场接妈妈')
  })

  it('joins new partial content onto the stable prefix', () => {
    expect(mergeInterim('去机场', '接妈妈')).toBe('去机场 接妈妈')
  })
})

describe('normalizeConfidence', () => {
  it('clamps into [0,1]', () => {
    expect(normalizeConfidence(1.4)).toBe(1)
    expect(normalizeConfidence(-0.2)).toBe(0)
    expect(normalizeConfidence(0.8)).toBe(0.8)
  })

  it('drops non-finite and non-numeric values', () => {
    expect(normalizeConfidence(undefined)).toBeUndefined()
    expect(normalizeConfidence(Number.NaN)).toBeUndefined()
    expect(normalizeConfidence('0.9')).toBeUndefined()
  })
})
