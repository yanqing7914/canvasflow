import { createPcmCommandRecognizer, pcm16le } from './pcmCommandRecognizer'

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeWebSocket.CONNECTING
  binaryType = ''
  sent: unknown[] = []
  constructor(readonly url: URL) { super() }
  send(data: unknown) { this.sent.push(data) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  open() { this.readyState = FakeWebSocket.OPEN; this.dispatchEvent(new Event('open')) }
  receive(body: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(body) }))
  }
}

function capture() {
  const listeners = new Set<(samples: Float32Array) => void>()
  return {
    preRoll: vi.fn(() => new Float32Array([0.25])),
    subscribe: vi.fn((listener: (samples: Float32Array) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit(samples: Float32Array) { for (const listener of listeners) listener(samples) },
  }
}

describe('PCM command recognizer', () => {
  it('streams PCM immediately and forwards provider partial and final text', async () => {
    const mic = capture()
    const sockets: FakeWebSocket[] = []
    const WebSocketFactory = class extends FakeWebSocket {
      constructor(url: URL) { super(url); sockets.push(this) }
    }
    const partial = vi.fn()
    const final = vi.fn()
    const recognizer = createPcmCommandRecognizer({
      capture: mic,
      webSocket: WebSocketFactory as never,
      fetch: vi.fn() as never,
    })
    const session = await recognizer.start({ onPartial: partial, onFinal: final, onError: vi.fn() }, {
      generation: 8, source: 'wake', speechAlreadyStarted: true,
    })
    const socket = sockets[0]!
    socket.open()
    mic.emit(new Float32Array([0.5]))
    socket.receive({ type: 'partial', text: '选第', generation: 8 })
    session.endUtterance()
    socket.receive({ type: 'final', text: '选择第三个', generation: 8 })
    expect(partial).toHaveBeenCalledWith('选第')
    expect(final).toHaveBeenCalledWith('选择第三个')
    expect(socket.sent[0]).toBe(JSON.stringify({ type: 'start', generation: 8 }))
    expect([...new Uint8Array(socket.sent[1] as ArrayBuffer)]).toEqual([...pcm16le(new Float32Array([0.5]))])
    expect(socket.sent[2]).toBe(JSON.stringify({ type: 'stop' }))
  })

  it('serializes wake PCM without replaying the keyword and emits the provider final', async () => {
    const mic = capture()
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ text: '查天气', confidence: 0.91 }), { status: 200 })
    })
    const final = vi.fn()
    const recognizer = createPcmCommandRecognizer({ capture: mic, fetch: fetchMock as never })
    const session = await recognizer.start({ onPartial: vi.fn(), onFinal: final, onError: vi.fn() }, {
      generation: 3, source: 'wake', speechAlreadyStarted: true,
    })
    mic.emit(new Float32Array([-0.5]))
    session.endUtterance()
    await vi.waitFor(() => expect(final).toHaveBeenCalledWith('查天气', 0.91))
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const init = call[1]
    expect(init.headers).toMatchObject({ 'content-type': 'audio/pcm;format=s16le;rate=16000;channels=1' })
    expect([...new Uint8Array(await new Response(init.body).arrayBuffer())]).toEqual([...pcm16le(new Float32Array([-0.5]))])
    expect(mic.preRoll).not.toHaveBeenCalled()
  })

  it('includes pre-roll for a follow-up that began before ASR opened', async () => {
    const mic = capture()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: '选第三个' }), { status: 200 }))
    const recognizer = createPcmCommandRecognizer({ capture: mic, fetch: fetchMock as never })
    const session = await recognizer.start({ onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() }, {
      generation: 4, source: 'follow-up', speechAlreadyStarted: true,
    })
    mic.emit(new Float32Array([-0.5]))
    session.endUtterance()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect([...new Uint8Array(await new Response(call[1].body).arrayBuffer())]).toEqual([
      ...pcm16le(new Float32Array([0.25, -0.5])),
    ])
    expect(mic.preRoll).toHaveBeenCalledWith(3200)
  })

  it('reports non-2xx responses and aborts a stopped request', async () => {
    const mic = capture()
    const error = vi.fn()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }))
    const recognizer = createPcmCommandRecognizer({ capture: mic, fetch: fetchMock as never })
    const session = await recognizer.start({ onPartial: vi.fn(), onFinal: vi.fn(), onError: error }, {
      generation: 1, source: 'wake', speechAlreadyStarted: false,
    })
    session.endUtterance()
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
    session.stop()
  })
})
