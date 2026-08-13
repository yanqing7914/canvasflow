import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..')
export const DEFAULT_MANIFEST_PATH = resolve(SCRIPT_DIR, 'voice-assets-manifest.json')

export const KEYWORD_TEXT = '小南'
export const KEYWORD_SPEC = 'x iǎo n án @小南'
export const KEYWORD_TOKENS = ['x', 'iǎo', 'n', 'án']

export const KWS_ARCHIVE = Object.freeze({
  id: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
  kind: 'kws-archive',
  source:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2',
  sha256: 'b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f',
  size: 32654866,
  license: 'Apache-2.0',
  files: [
    'apps/demo/public/voice/kws/encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    'apps/demo/public/voice/kws/decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
    'apps/demo/public/voice/kws/joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
    'apps/demo/public/voice/kws/tokens.txt',
  ],
})

export const SILERO_VAD = Object.freeze({
  id: 'silero-vad',
  kind: 'silero-vad',
  source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  size: 643854,
  license: 'MIT',
  files: ['apps/demo/public/voice/models/silero_vad.onnx'],
})

export const KWS_RUNTIME = Object.freeze({
  id: 'sherpa-onnx-kws-wasm',
  kind: 'kws-runtime',
  source:
    'https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/e1edbfee666116b6c2c0129b377055b4e096b3c9',
  sha256: '1533d492419a10bed385518780d892cc175fbabdf0a1ab78d0b02b786c16138f',
  size: 11451251,
  license: 'Apache-2.0',
  files: [
    'apps/demo/public/voice/kws/sherpa-onnx-kws.js',
    'apps/demo/public/voice/kws/sherpa-onnx-wasm-kws-main.js',
    'apps/demo/public/voice/kws/sherpa-onnx-wasm-kws-main.wasm',
    'apps/demo/public/voice/kws/sherpa-onnx-wasm-kws-main.data',
  ],
})

export const PINNED_ASSETS = Object.freeze([KWS_ARCHIVE, SILERO_VAD, KWS_RUNTIME])

export const EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID_MANIFEST: 2,
  MODEL_MISSING: 3,
  INTEGRITY_FAILURE: 4,
  KEYWORD_OOV: 5,
})

export const RESULT_STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  CHECKSUM_MISMATCH: 'checksum_mismatch',
  KEYWORD_OOV: 'keyword_oov',
  INVALID_MANIFEST: 'invalid_manifest',
})

export const RECOMMENDED_GITIGNORE_RULES = Object.freeze([
  'apps/demo/public/voice/**/*.onnx',
  'apps/demo/public/voice/**/*.wasm',
  'apps/demo/public/voice/**/*.data',
])

const SHA256_RE = /^[0-9a-f]{64}$/

function error(code, message, details = {}) {
  return { code, message, ...details }
}

function asAssetList(manifest) {
  if (!manifest || typeof manifest !== 'object') return []
  if (Array.isArray(manifest.assets)) return manifest.assets
  if (manifest.assets && typeof manifest.assets === 'object') {
    return Object.entries(manifest.assets).map(([id, asset]) => ({ id, ...asset }))
  }
  return []
}

function filePath(entry) {
  return typeof entry === 'string' ? entry : entry?.path
}

function fileExpectation(entry) {
  if (typeof entry === 'string') return {}
  return entry && typeof entry === 'object' ? entry : {}
}

export function parseKeywordSpec(spec = KEYWORD_SPEC) {
  const text = String(spec).trim()
  const at = text.indexOf('@')
  const tokenPart = (at === -1 ? text : text.slice(0, at)).trim()
  return tokenPart ? tokenPart.split(/\s+/u) : []
}

export function readTokens(tokensPath) {
  const text = readFileSync(tokensPath, 'utf8').replace(/^\uFEFF/u, '')
  const tokens = new Set()
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const token = trimmed.split(/\s+/u, 1)[0]
    if (token) tokens.add(token)
  }
  return tokens
}

export function verifyKeywordTokens(tokensPath, keywordSpec = KEYWORD_SPEC) {
  let available
  try {
    available = readTokens(tokensPath)
  } catch (cause) {
    return {
      ok: false,
      tokens: parseKeywordSpec(keywordSpec),
      missing: parseKeywordSpec(keywordSpec),
      error: error('TOKENS_FILE_MISSING', 'KWS tokens.txt could not be read.', {
        path: tokensPath,
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    }
  }
  const tokens = parseKeywordSpec(keywordSpec)
  const missing = [...new Set(tokens.filter((token) => !available.has(token)))]
  return { ok: missing.length === 0, tokens, missing, availableCount: available.size }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function validateManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [error('MANIFEST_SHAPE_INVALID', 'Voice asset manifest must be a JSON object.')]
  }
  if (manifest.schemaVersion !== 1) {
    errors.push(error('MANIFEST_VERSION_UNSUPPORTED', 'Voice asset manifest schemaVersion must be 1.'))
  }
  const assets = asAssetList(manifest)
  if (assets.length === 0) {
    errors.push(error('MANIFEST_ASSETS_MISSING', 'Voice asset manifest must contain at least one asset.'))
  }
  for (const [index, asset] of assets.entries()) {
    const prefix = `assets[${index}]`
    if (!asset || typeof asset !== 'object') {
      errors.push(error('ASSET_SHAPE_INVALID', `${prefix} must be an object.`))
      continue
    }
    for (const field of ['source', 'sha256', 'size', 'license', 'files']) {
      if (!(field in asset)) errors.push(error('ASSET_FIELD_MISSING', `${prefix}.${field} is required.`, { field }))
    }
    if (typeof asset.source !== 'string' || !/^https?:\/\//u.test(asset.source)) {
      errors.push(error('ASSET_SOURCE_INVALID', `${prefix}.source must be an http(s) URL.`))
    }
    if (typeof asset.sha256 !== 'string' || !SHA256_RE.test(asset.sha256)) {
      errors.push(error('ASSET_SHA256_INVALID', `${prefix}.sha256 must be a lowercase SHA-256 digest.`))
    }
    if (!Number.isInteger(asset.size) || asset.size < 1) {
      errors.push(error('ASSET_SIZE_INVALID', `${prefix}.size must be a positive integer.`))
    }
    if (typeof asset.license !== 'string' || asset.license.trim() === '') {
      errors.push(error('ASSET_LICENSE_INVALID', `${prefix}.license must be a non-empty string.`))
    }
    if (!Array.isArray(asset.files) || asset.files.length === 0 || asset.files.some((entry) => !filePath(entry))) {
      errors.push(error('ASSET_FILES_INVALID', `${prefix}.files must contain paths.`))
    }
    for (const [fileIndex, entry] of (Array.isArray(asset.files) ? asset.files : []).entries()) {
      const expected = fileExpectation(entry)
      if (expected.sha256 !== undefined && !SHA256_RE.test(expected.sha256)) {
        errors.push(error('FILE_SHA256_INVALID', `${prefix}.files[${fileIndex}].sha256 is invalid.`))
      }
      if (expected.size !== undefined && (!Number.isInteger(expected.size) || expected.size < 1)) {
        errors.push(error('FILE_SIZE_INVALID', `${prefix}.files[${fileIndex}].size is invalid.`))
      }
    }
  }
  return errors
}

function chooseExitCode(errors) {
  if (errors.some((item) => item.code === 'TOKENS_FILE_MISSING' || item.code === 'ASSET_FILE_MISSING')) {
    return EXIT_CODES.MODEL_MISSING
  }
  if (errors.some((item) => item.code.includes('HASH') || item.code.includes('SIZE'))) {
    return EXIT_CODES.INTEGRITY_FAILURE
  }
  if (errors.some((item) => item.code === 'KEYWORD_TOKEN_OOV')) return EXIT_CODES.KEYWORD_OOV
  if (errors.some((item) => item.code.startsWith('MANIFEST_') || item.code.startsWith('ASSET_'))) {
    return EXIT_CODES.INVALID_MANIFEST
  }
  return EXIT_CODES.INVALID_MANIFEST
}

function chooseStatus(errors) {
  if (errors.some((item) => item.code === 'TOKENS_FILE_MISSING' || item.code === 'ASSET_FILE_MISSING')) {
    return RESULT_STATUS.MISSING
  }
  if (errors.some((item) => item.code.includes('HASH') || item.code.includes('SIZE'))) {
    return RESULT_STATUS.CHECKSUM_MISMATCH
  }
  if (errors.some((item) => item.code === 'KEYWORD_TOKEN_OOV')) return RESULT_STATUS.KEYWORD_OOV
  return RESULT_STATUS.INVALID_MANIFEST
}

function gitignoreWarning(root) {
  const path = resolve(root, '.gitignore')
  let configured = new Set()
  if (existsSync(path)) {
    configured = new Set(
      readFileSync(path, 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    )
  }
  const missing = RECOMMENDED_GITIGNORE_RULES.filter((rule) => !configured.has(rule))
  if (missing.length === 0) return null
  return error(
    'VOICE_BINARY_GITIGNORE_REQUIRED',
    'Generated voice model/runtime binaries must remain untracked; add the recommended ignore rules before committing assets.',
    { path: relative(root, path) || path, rules: missing },
  )
}

export function inspectVoiceAssets({
  root = REPOSITORY_ROOT,
  manifestPath = DEFAULT_MANIFEST_PATH,
  keywordSpec = KEYWORD_SPEC,
  assetIds = [],
} = {}) {
  const result = {
    ok: false,
    status: RESULT_STATUS.INVALID_MANIFEST,
    exitCode: EXIT_CODES.INVALID_MANIFEST,
    manifestPath: relative(root, manifestPath) || manifestPath,
    selectedAssetIds: [...assetIds],
    keyword: { text: KEYWORD_TEXT, spec: keywordSpec, tokens: parseKeywordSpec(keywordSpec) },
    assets: [],
    errors: [],
    warnings: [],
  }

  const ignoreWarning = gitignoreWarning(root)
  if (ignoreWarning) result.warnings.push(ignoreWarning)

  if (!existsSync(manifestPath)) {
    result.errors.push(error('MANIFEST_MISSING', 'Voice asset manifest is missing.', { path: manifestPath }))
    result.status = RESULT_STATUS.MISSING
    result.exitCode = EXIT_CODES.MODEL_MISSING
    return result
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    result.errors.push(error('MANIFEST_JSON_INVALID', 'Voice asset manifest is not valid JSON.', {
      path: manifestPath,
      cause: cause instanceof Error ? cause.message : String(cause),
    }))
    result.exitCode = EXIT_CODES.INVALID_MANIFEST
    return result
  }

  result.errors.push(...validateManifest(manifest))
  const allAssets = asAssetList(manifest)
  const selected = new Set(assetIds)
  const assets = selected.size === 0
    ? allAssets
    : allAssets.filter((asset) => selected.has(asset.id))
  if (selected.size > 0) {
    const available = new Set(allAssets.map((asset) => asset.id))
    for (const id of selected) {
      if (!available.has(id)) {
        result.errors.push(error('ASSET_SELECTION_INVALID', `Requested voice asset is not in the manifest: ${id}`, { id }))
      }
    }
  }
  for (const asset of assets) {
    const inspected = {
      id: asset.id ?? asset.kind ?? 'unnamed',
      source: asset.source,
      expectedSha256: asset.sha256,
      expectedSize: asset.size,
      files: [],
    }
    for (const entry of Array.isArray(asset.files) ? asset.files : []) {
      const path = filePath(entry)
      const expected = fileExpectation(entry)
      const absolute = resolve(root, path ?? '')
      const file = { path, exists: existsSync(absolute) }
      if (file.exists) {
        const stat = statSync(absolute)
        file.size = stat.size
        if (stat.isFile()) file.sha256 = sha256File(absolute)
        if (expected.size !== undefined && file.size !== expected.size) {
          result.errors.push(error('FILE_SIZE_MISMATCH', `Installed voice asset file size does not match: ${path}`, {
            path, expected: expected.size, actual: file.size,
          }))
        }
        if (expected.sha256 !== undefined && file.sha256 !== expected.sha256) {
          result.errors.push(error('FILE_HASH_MISMATCH', `Installed voice asset file hash does not match: ${path}`, {
            path, expected: expected.sha256, actual: file.sha256,
          }))
        }
      } else {
        result.errors.push(error('ASSET_FILE_MISSING', `Installed voice asset file is missing: ${path}`, { path, asset: inspected.id }))
      }
      inspected.files.push(file)
    }
    result.assets.push(inspected)
  }

  const tokensEntry = assets
    .flatMap((asset) => (Array.isArray(asset.files) ? asset.files : []))
    .map(filePath)
    .find((path) => path?.endsWith('/tokens.txt') || path === 'tokens.txt')
  const keywordCheckRequired = selected.size === 0 || Boolean(tokensEntry)
  if (keywordCheckRequired && !tokensEntry) {
    result.errors.push(error('TOKENS_FILE_MISSING', 'Manifest does not identify a KWS tokens.txt file.'))
  } else if (tokensEntry) {
    const tokenResult = verifyKeywordTokens(resolve(root, tokensEntry), keywordSpec)
    result.keyword = { ...result.keyword, ...tokenResult, path: tokensEntry }
    if (!tokenResult.ok && !tokenResult.error) {
      result.errors.push(error('KEYWORD_TOKEN_OOV', 'Wake keyword contains tokens absent from tokens.txt.', {
        path: tokensEntry,
        missing: tokenResult.missing,
      }))
    } else if (tokenResult.error) {
      result.errors.push(tokenResult.error)
    }
  }

  if (result.errors.length === 0) {
    result.ok = true
    result.status = RESULT_STATUS.OK
    result.exitCode = EXIT_CODES.OK
  } else {
    result.exitCode = chooseExitCode(result.errors)
    result.status = chooseStatus(result.errors)
  }
  return result
}

export function refreshManifest({
  root = REPOSITORY_ROOT,
  manifestPath = DEFAULT_MANIFEST_PATH,
} = {}) {
  let manifest
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } else {
    manifest = {
      schemaVersion: 1,
      assets: PINNED_ASSETS.map(({ id, kind, source, sha256, size, license, files }) => ({
        id,
        kind,
        source,
        sha256,
        size,
        license,
        files,
      })),
    }
  }
  const assets = asAssetList(manifest)
  for (const asset of assets) {
    asset.files = (Array.isArray(asset.files) ? asset.files : []).map((entry) => {
      const path = filePath(entry)
      const absolute = resolve(root, path ?? '')
      if (!path || !existsSync(absolute) || !statSync(absolute).isFile()) return entry
      return { path, size: statSync(absolute).size, sha256: sha256File(absolute) }
    })
  }
  manifest.schemaVersion = 1
  manifest.generatedAt = new Date().toISOString()
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function parseArgs(argv) {
  const args = {
    root: REPOSITORY_ROOT,
    manifestPath: DEFAULT_MANIFEST_PATH,
    keywordSpec: KEYWORD_SPEC,
    assetIds: [],
    refresh: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--refresh-manifest') args.refresh = true
    else if (arg === '--root') args.root = resolve(argv[++index])
    else if (arg === '--manifest') args.manifestPath = resolve(argv[++index])
    else if (arg === '--keyword') args.keywordSpec = argv[++index]
    else if (arg === '--asset') args.assetIds.push(argv[++index])
    else if (arg === '--help') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function printHelp() {
  console.log(`Usage: node scripts/voice-assets.mjs [options]\n\nOptions:\n  --root PATH              Repository root (default: current repository)\n  --manifest PATH          Manifest JSON path\n  --keyword SPEC           KWS token spec (default: ${KEYWORD_SPEC})\n  --asset ID               Inspect one asset ID (repeatable)\n  --refresh-manifest       Record installed file sizes and hashes\n  --help                   Show this help`)
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
}

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) printHelp()
    else {
      if (args.refresh) refreshManifest(args)
      const report = inspectVoiceAssets(args)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.exitCode
    }
  } catch (cause) {
    const report = {
      ok: false,
      status: RESULT_STATUS.INVALID_MANIFEST,
      exitCode: EXIT_CODES.INVALID_MANIFEST,
      errors: [error('VOICE_ASSET_PROBE_FAILED', cause instanceof Error ? cause.message : String(cause))],
    }
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.exitCode
  }
}
