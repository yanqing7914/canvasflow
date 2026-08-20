import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const fetchScript = readFileSync('scripts/fetch-voice-models.sh', 'utf8')
const buildScript = readFileSync('scripts/voice-build-kws-wasm.sh', 'utf8')
const probeScript = readFileSync('scripts/voice-assets.mjs', 'utf8')
const publicManifest = JSON.parse(readFileSync('apps/demo/public/voice/manifest.json', 'utf8'))
const assetManifest = JSON.parse(readFileSync('scripts/voice-assets-manifest.json', 'utf8'))

describe('voice asset reproduction scripts', () => {
  it('pins and verifies both model downloads', () => {
    expect(fetchScript).toContain('b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f')
    expect(fetchScript).toContain('9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6')
    expect(fetchScript).toMatch(/curl -fL -C -/)
    expect(fetchScript).toContain('download_failed')
    expect(fetchScript).toContain('checksum_mismatch')
    expect(fetchScript).toContain('--asset sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01')
    expect(fetchScript).toContain('--asset silero-vad')
  })

  it('pins the sherpa source and emsdk version before building the runtime', () => {
    expect(buildScript).toContain('e1edbfee666116b6c2c0129b377055b4e096b3c9')
    expect(buildScript).toContain('emsdk_version="4.0.23"')
    expect(buildScript).toContain('"$EMSCRIPTEN/emcc" --version')
    expect(buildScript).toContain('-DSHERPA_ONNX_ENABLE_WASM_KWS=ON')
    expect(buildScript).toContain('function getMemoryBuffer(){return wasmMemory.buffer}')
    for (const output of ['sherpa-onnx-kws.js', 'sherpa-onnx-wasm-kws-main.js', 'sherpa-onnx-wasm-kws-main.wasm', 'sherpa-onnx-wasm-kws-main.data']) {
      expect(buildScript).toContain(output)
    }
  })

  it('retries downloads from a clean file after an integrity failure', () => {
    expect(fetchScript).toContain('DOWNLOAD_RETRY_FAILED')
    expect(fetchScript).toContain('rm -f -- "$partial"')
    expect(fetchScript.match(/curl -fL --retry 3 --connect-timeout 20 -o "\$partial" "\$url"/g)).toHaveLength(2)
  })

  it('guards generated asset paths inside the repository root', () => {
    expect(probeScript).toContain('ASSET_PATH_INVALID')
    expect(probeScript).toContain('isSafeAssetPath')
  })

  it('keeps binary voice assets out of git while tracking templates', () => {
    const binaryPaths = assetManifest.assets
      .flatMap((asset) => asset.files)
      .map((entry) => typeof entry === 'string' ? entry : entry.path)
      .filter((path) => /\.(?:onnx|wasm|data)$/u.test(path))
    const tracked = execFileSync('git', ['ls-files', '--', ...binaryPaths], { encoding: 'utf8' }).trim()
    expect(tracked).toBe('')
    expect(probeScript).toContain('VOICE_BINARY_GITIGNORE_REQUIRED')
    expect(publicManifest.gitignoreRequired).toEqual([
      'apps/demo/public/voice/**/*.onnx',
      'apps/demo/public/voice/**/*.wasm',
      'apps/demo/public/voice/**/*.data',
      'apps/demo/public/voice/kws/sherpa-onnx-kws.js',
      'apps/demo/public/voice/kws/sherpa-onnx-wasm-kws-main.js',
      'apps/demo/public/voice/**/tokens.txt',
    ])
  })
})
