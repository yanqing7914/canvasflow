import { gunzipSync, gzipSync } from 'node:zlib'
import {
  createDoubaoAudioRequest,
  createDoubaoFullRequest,
  doubaoMessageFromResponse,
  parseDoubaoResponse,
} from './doubao-asr'

function response(payload: unknown, sequence = 3, last = false) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)))
  const frame = Buffer.alloc(12 + compressed.length)
  frame.set([0x11, 0x90 | (last ? 0x3 : 0x1), 0x11, 0x00])
  frame.writeInt32BE(last ? -sequence : sequence, 4)
  frame.writeUInt32BE(compressed.length, 8)
  compressed.copy(frame, 12)
  return frame
}

describe('Doubao bidirectional ASR protocol', () => {
  it('builds the SeedASR 2.0 full request with two-pass finalization', () => {
    const frame = createDoubaoFullRequest(1)
    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x11, 0x11, 0x00])
    expect(frame.readInt32BE(4)).toBe(1)
    const payload = JSON.parse(gunzipSync(frame.subarray(12)).toString())
    expect(payload.audio).toEqual({ format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 })
    expect(payload.request).toMatchObject({
      model_name: 'bigmodel',
      enable_nonstream: true,
      show_utterances: true,
      end_window_size: 800,
    })
  })

  it('marks the last PCM packet with a negative sequence', () => {
    const packet = createDoubaoAudioRequest(7, Buffer.from([1, 2]), true)
    expect([...packet.subarray(0, 4)]).toEqual([0x11, 0x23, 0x01, 0x00])
    expect(packet.readInt32BE(4)).toBe(-7)
    expect([...gunzipSync(packet.subarray(12))]).toEqual([1, 2])
  })

  it('parses partial and final transcripts including definite two-pass utterances', () => {
    expect(doubaoMessageFromResponse(parseDoubaoResponse(response({ result: { text: '选第' } })))).toMatchObject({
      text: '选第', final: false,
    })
    expect(doubaoMessageFromResponse(parseDoubaoResponse(response({
      result: { text: '选择第三个', utterances: [{ text: '选择第三个', definite: true }] },
    }, 9, true)))).toEqual({ text: '选择第三个', final: true, definite: true, sequence: -9 })
  })
})
