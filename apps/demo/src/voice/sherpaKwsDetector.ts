import type {
  WakeDetector,
  WakeDetectorFrame,
  WakeDetectorMatch,
} from './localWakeRuntime'

const KWS_BASE_URL = '/voice/kws/'
const KWS_WRAPPER_URL = `${KWS_BASE_URL}sherpa-onnx-kws.js`
const KWS_RUNTIME_URL = `${KWS_BASE_URL}sherpa-onnx-wasm-kws-main.js`

export const XIAONAN_KEYWORD = 'x iǎo n án @小南'

type SherpaKeywordResult = {
  keyword?: string
  tokens?: string[]
  timestamps?: number[]
}

type SherpaKeywordStream = {
  acceptWaveform: (sampleRate: number, samples: Float32Array) => void
  free?: () => void
}

type SherpaKeywordSpotter = {
  createStream: () => SherpaKeywordStream
  isReady: (stream: SherpaKeywordStream) => boolean
  decode: (stream: SherpaKeywordStream) => void
  getResult: (stream: SherpaKeywordStream) => SherpaKeywordResult
  reset: (stream: SherpaKeywordStream) => void
  free?: () => void
}

type SherpaModule = Record<string, unknown> & {
  onRuntimeInitialized?: () => void
  locateFile?: (path: string) => string
  setStatus?: (status: string) => void
}

type SherpaScope = typeof globalThis & {
  Module?: SherpaModule
  createKws?: (module: SherpaModule, config: ReturnType<typeof keywordConfig>) => SherpaKeywordSpotter
}

export type SherpaKwsDetectorOptions = {
  keywordSpec?: string
  keywordLabel?: string
  baseUrl?: string
  score?: number
  threshold?: number
  injectScript?: (url: string) => Promise<void>
  scope?: SherpaScope
  requireCrossOriginIsolation?: boolean
}

const modulePromises = new WeakMap<object, Map<string, Promise<SherpaModule>>>()

function keywordConfig(
  keywordSpec: string,
  score: number,
  threshold: number,
) {
  return {
    featConfig: { samplingRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: './encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
        decoder: './decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
        joiner: './joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
      },
      tokens: './tokens.txt',
      provider: 'cpu',
      modelType: '',
      numThreads: 1,
      debug: 0,
      modelingUnit: 'cjkchar',
      bpeVocab: '',
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: score,
    keywordsThreshold: threshold,
    keywords: keywordSpec,
  }
}

function defaultInjectScript(url: string): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('KWS scripts require a browser document'))
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-canvasflow-kws="${url}"]`)
    if (existing?.dataset.loaded === 'true') {
      resolve()
      return
    }
    const script = existing ?? document.createElement('script')
    if (!existing) {
      script.src = url
      script.async = true
      script.dataset.canvasflowKws = url
      document.head.appendChild(script)
    }
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      resolve()
    }, { once: true })
    script.addEventListener('error', () => reject(new Error(`KWS script failed to load: ${url}`)), { once: true })
  })
}

async function loadSherpaModule(
  scope: SherpaScope,
  injectScript: (url: string) => Promise<void>,
  baseUrl: string,
): Promise<SherpaModule> {
  let byBaseUrl = modulePromises.get(scope)
  if (!byBaseUrl) {
    byBaseUrl = new Map()
    modulePromises.set(scope, byBaseUrl)
  }
  const existing = byBaseUrl.get(baseUrl)
  if (existing) return existing
  const promise = (async () => {
    await injectScript(`${baseUrl}sherpa-onnx-kws.js`)
    const createKws = scope.createKws
    if (typeof createKws !== 'function') {
      throw new Error(`KWS wrapper loaded without createKws: ${KWS_WRAPPER_URL}`)
    }

    return await new Promise<SherpaModule>((resolve, reject) => {
      const module: SherpaModule = {
        locateFile: (path) => `${baseUrl}${path}`,
        setStatus: () => undefined,
        onRuntimeInitialized: () => resolve(module),
      }
      scope.Module = module
      injectScript(`${baseUrl}sherpa-onnx-wasm-kws-main.js`).catch(reject)
    })
  })()
  byBaseUrl.set(baseUrl, promise)
  try {
    return await promise
  } catch (error) {
    byBaseUrl.delete(baseUrl)
    throw error
  }
}

/** Local sherpa-onnx keyword detector. PCM stays in-browser before wake. */
export function createSherpaKwsDetector(options: SherpaKwsDetectorOptions = {}): WakeDetector {
  const keywordSpec = options.keywordSpec ?? XIAONAN_KEYWORD
  const keywordLabel = options.keywordLabel ?? '小南'
  const baseUrl = options.baseUrl ?? KWS_BASE_URL
  const score = options.score ?? 2
  const threshold = options.threshold ?? 0.2
  const injectScript = options.injectScript ?? defaultInjectScript
  const scope = options.scope ?? globalThis as SherpaScope
  const requireIsolation = options.requireCrossOriginIsolation ?? true

  let disposed = false
  let spotter: SherpaKeywordSpotter | null = null
  let stream: SherpaKeywordStream | null = null
  let onMatch: ((match: WakeDetectorMatch) => void) | null = null

  async function load() {
    if (disposed) throw new Error('KWS detector is disposed')
    if (requireIsolation && scope.crossOriginIsolated !== true) {
      throw new Error('KWS requires cross-origin isolation (COOP/COEP)')
    }
    if (spotter) return
    const module = await loadSherpaModule(scope, injectScript, baseUrl)
    const createKws = scope.createKws
    if (typeof createKws !== 'function') throw new Error('KWS wrapper is unavailable')
    spotter = createKws(module, keywordConfig(keywordSpec, score, threshold))
  }

  async function start(next: (match: WakeDetectorMatch) => void) {
    await load()
    if (disposed || !spotter) throw new Error('KWS detector is unavailable')
    try { stream?.free?.() } catch { /* stale stream */ }
    stream = spotter.createStream()
    onMatch = next
  }

  function pushFrame(frame: WakeDetectorFrame) {
    if (disposed || !spotter || !stream || !onMatch) return
    stream.acceptWaveform(frame.sampleRate, frame.samples)
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const keyword = spotter.getResult(stream).keyword?.trim()
      if (!keyword) continue
      spotter.reset(stream)
      onMatch({ keyword: keyword || keywordLabel })
      return
    }
  }

  function stop() {
    onMatch = null
    try { stream?.free?.() } catch { /* already released */ }
    stream = null
  }

  function dispose() {
    if (disposed) return
    disposed = true
    stop()
    try { spotter?.free?.() } catch { /* already released */ }
    spotter = null
  }

  return { load, start, pushFrame, stop, dispose }
}

export const sherpaKwsAssets = {
  wrapper: KWS_WRAPPER_URL,
  runtime: KWS_RUNTIME_URL,
} as const
