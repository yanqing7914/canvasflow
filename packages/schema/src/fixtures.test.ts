import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scenarioFixtureSchema } from './fixture'

describe('airport pickup fixtures', () => {
  it('validates every scenario contract', () => {
    const directory = resolve(process.cwd(), 'fixtures/airport-pickup')
    const files = readdirSync(directory).filter((file) => file.endsWith('.json'))
    expect(files).toHaveLength(12)
    for (const file of files) {
      const parsed = scenarioFixtureSchema.safeParse(JSON.parse(readFileSync(resolve(directory, file), 'utf8')))
      expect(parsed.success, file).toBe(true)
    }
  })
})
