import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scenarioFixtureSchema } from './fixture'
import { applyEvent } from '@canvasflow/agent'
import { composePickupSpec } from '@canvasflow/ui'

describe('airport pickup fixtures', () => {
  it('validates every scenario contract and exercises the reducer/composer', () => {
    const directory = resolve(process.cwd(), 'fixtures/airport-pickup')
    const files = readdirSync(directory).filter((file) => file.endsWith('.json'))
    expect(files).toHaveLength(12)
    for (const file of files) {
      const parsed = scenarioFixtureSchema.safeParse(JSON.parse(readFileSync(resolve(directory, file), 'utf8')))
      expect(parsed.success, file).toBe(true)
      if (!parsed.success) continue
      const afterEvent = applyEvent(parsed.data.initialTaskState, parsed.data.inputEvent)
      expect(afterEvent, file).toEqual(parsed.data.expectedTaskState)
      expect(composePickupSpec(afterEvent), file).toMatchObject({
        taskId: parsed.data.expectedUISpec.taskId,
        surfaceId: parsed.data.expectedUISpec.surfaceId,
        taskRevision: parsed.data.expectedUISpec.taskRevision,
        phase: parsed.data.expectedUISpec.phase,
      })
    }
  })
})
