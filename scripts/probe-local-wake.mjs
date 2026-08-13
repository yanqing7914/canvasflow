import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const baseURL = process.env.VOICE_PROBE_URL ?? 'http://127.0.0.1:5173'
const timeoutMs = Number(process.env.VOICE_PROBE_TIMEOUT_MS ?? 20_000)
const suppliedAudio = process.argv[2]

function generateAudio() {
  const directory = mkdtempSync(join(tmpdir(), 'canvasflow-wake-probe-'))
  const aiff = join(directory, 'xiaonan.aiff')
  const wav = join(directory, 'xiaonan.wav')
  const spoken = spawnSync('/usr/bin/say', ['-v', 'Tingting', '-r', '160', '-o', aiff, '小南 小南'])
  if (spoken.status !== 0) throw new Error('macOS say could not generate the Xiaonan probe audio')
  const converted = spawnSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
  if (converted.status !== 0) throw new Error('afconvert could not create 16 kHz PCM probe audio')
  return wav
}

const audio = suppliedAudio ?? generateAudio()
if (!existsSync(audio)) throw new Error(`probe WAV is missing: ${audio}`)

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${audio}`,
  ],
})

try {
  const context = await browser.newContext({ permissions: ['microphone'] })
  const page = await context.newPage()
  const browserErrors = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })

  await page.goto(baseURL)
  if (!await page.evaluate(() => crossOriginIsolated)) {
    throw new Error('page is not cross-origin isolated; KWS requires COOP/COEP')
  }
  await page.getByRole('button', { name: '启用小南语音唤醒' }).click()
  await page.getByRole('button', { name: '小南语音状态' }).filter({ hasText: '正在聆听' }).waitFor({ timeout: timeoutMs })

  console.log(JSON.stringify({
    ok: true,
    status: 'wake-detected',
    baseURL,
    audio,
    crossOriginIsolated: true,
    browserErrors,
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'wake-probe-failed',
    baseURL,
    audio,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
} finally {
  await browser.close()
}
