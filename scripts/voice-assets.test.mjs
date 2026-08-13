import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  EXIT_CODES,
  KEYWORD_SPEC,
  KWS_ARCHIVE,
  RESULT_STATUS,
  SILERO_VAD,
  inspectVoiceAssets,
  parseKeywordSpec,
  verifyKeywordTokens,
  validateManifest,
} from './voice-assets.mjs'

const rootManifest = JSON.parse(readFileSync('scripts/voice-assets-manifest.json', 'utf8'))

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'canvasflow-voice-assets-'))
}

function writeTokens(root, lines) {
  const directory = join(root, 'voice/kws')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'tokens.txt')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

describe('voice asset contract', () => {
  it('pins source, sha256, size, license and files for every asset', () => {
    expect(validateManifest(rootManifest)).toEqual([])
    for (const asset of rootManifest.assets) {
      expect(asset.source).toMatch(/^https:\/\//)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.size).toBeGreaterThan(0)
      expect(asset.license).toBeTruthy()
      expect(asset.files.length).toBeGreaterThan(0)
    }
    expect(KWS_ARCHIVE.sha256).toBe('b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f')
    expect(SILERO_VAD.sha256).toBe('9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6')
  })

  it('verifies every token in x iǎo n án against tokens.txt', () => {
    expect(parseKeywordSpec(KEYWORD_SPEC)).toEqual(['x', 'iǎo', 'n', 'án'])
    const root = tempRoot()
    const tokens = writeTokens(root, ['x 1', 'iǎo 2', 'n 3', 'án 4'])
    expect(verifyKeywordTokens(tokens)).toMatchObject({ ok: true, missing: [] })
  })

  it('reports the exact OOV tokens instead of silently enabling the keyword', () => {
    const root = tempRoot()
    const tokens = writeTokens(root, ['x 1', 'n 3'])
    expect(verifyKeywordTokens(tokens)).toMatchObject({ ok: false, missing: ['iǎo', 'án'] })
  })

  it('uses a structured non-zero result when models are absent', () => {
    const root = tempRoot()
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      assets: [{
        ...KWS_ARCHIVE,
        files: ['voice/kws/tokens.txt', 'voice/kws/encoder.onnx'],
      }],
    }))
    const result = inspectVoiceAssets({ root, manifestPath })
    expect(result).toMatchObject({
      ok: false,
      status: RESULT_STATUS.MISSING,
      exitCode: EXIT_CODES.MODEL_MISSING,
    })
    expect(result.errors.some((entry) => entry.code === 'ASSET_FILE_MISSING')).toBe(true)
    expect(result.errors.some((entry) => entry.code === 'TOKENS_FILE_MISSING')).toBe(true)
  })

  it('returns the structured missing result from the command line', () => {
    const root = tempRoot()
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      assets: [{ ...KWS_ARCHIVE, files: ['voice/kws/tokens.txt'] }],
    }))
    const command = spawnSync(
      process.execPath,
      [resolve('scripts/voice-assets.mjs'), '--root', root, '--manifest', manifestPath],
      { encoding: 'utf8' },
    )
    expect(command.status).toBe(EXIT_CODES.MODEL_MISSING)
    expect(JSON.parse(command.stdout)).toMatchObject({
      ok: false,
      status: RESULT_STATUS.MISSING,
      exitCode: EXIT_CODES.MODEL_MISSING,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'ASSET_FILE_MISSING' }),
        expect.objectContaining({ code: 'TOKENS_FILE_MISSING' }),
      ]),
    })
  })

  it('classifies a readable tokens.txt with OOV units as a keyword failure', () => {
    const root = tempRoot()
    writeTokens(root, ['x 1', 'n 3'])
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      assets: [{ ...KWS_ARCHIVE, files: ['voice/kws/tokens.txt'] }],
    }))
    const result = inspectVoiceAssets({ root, manifestPath })
    expect(result.exitCode).toBe(EXIT_CODES.KEYWORD_OOV)
    expect(result.status).toBe(RESULT_STATUS.KEYWORD_OOV)
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'KEYWORD_TOKEN_OOV',
      missing: ['iǎo', 'án'],
    }))
  })

  it('classifies installed file corruption as a checksum failure', () => {
    const root = tempRoot()
    const tokens = writeTokens(root, ['x 1', 'iǎo 2', 'n 3', 'án 4'])
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      assets: [{
        ...KWS_ARCHIVE,
        files: [{ path: 'voice/kws/tokens.txt', size: 1, sha256: '0'.repeat(64) }],
      }],
    }))
    expect(tokens).toBeTruthy()
    const result = inspectVoiceAssets({ root, manifestPath })
    expect(result).toMatchObject({
      ok: false,
      status: RESULT_STATUS.CHECKSUM_MISMATCH,
      exitCode: EXIT_CODES.INTEGRITY_FAILURE,
    })
    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'FILE_SIZE_MISMATCH',
      'FILE_HASH_MISMATCH',
    ]))
  })

  it('can validate fetched models before the separately built WASM runtime exists', () => {
    const root = tempRoot()
    const tokens = writeTokens(root, ['x 1', 'iǎo 2', 'n 3', 'án 4'])
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      assets: [
        { ...KWS_ARCHIVE, files: ['voice/kws/tokens.txt'] },
        { ...SILERO_VAD, files: ['voice/models/silero_vad.onnx'] },
        {
          id: 'runtime',
          source: 'https://example.com/runtime.tar.gz',
          sha256: '1'.repeat(64),
          size: 1,
          license: 'Apache-2.0',
          files: ['voice/kws/runtime.wasm'],
        },
      ],
    }))
    mkdirSync(join(root, 'voice/models'), { recursive: true })
    writeFileSync(join(root, 'voice/models/silero_vad.onnx'), 'fixture')
    expect(tokens).toBeTruthy()
    const result = inspectVoiceAssets({
      root,
      manifestPath,
      assetIds: [KWS_ARCHIVE.id, SILERO_VAD.id],
    })
    expect(result).toMatchObject({ ok: true, status: RESULT_STATUS.OK, exitCode: EXIT_CODES.OK })
    expect(result.assets.map((asset) => asset.id)).toEqual([KWS_ARCHIVE.id, SILERO_VAD.id])
  })
})
