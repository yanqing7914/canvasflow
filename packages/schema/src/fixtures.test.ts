import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scenarioFixtureSchema } from './fixture'
import { applyEvent, createInitialTask, planEffects } from '@canvasflow/agent'
import { composeFallbackSpec, composePickupSpec } from '@canvasflow/ui'

describe('airport pickup fixtures', () => {
  it('validates every scenario contract and exercises the reducer/composer', () => {
    const directory = resolve(process.cwd(), 'fixtures/airport-pickup')
    const files = readdirSync(directory).filter((file) => file.endsWith('.json'))
    expect(files).toHaveLength(16)
    for (const file of files) {
      const parsed = scenarioFixtureSchema.safeParse(JSON.parse(readFileSync(resolve(directory, file), 'utf8')))
      expect(parsed.success, file).toBe(true)
      if (!parsed.success) continue
      const afterEvent = applyEvent(parsed.data.initialTaskState, parsed.data.inputEvent)
      expect(afterEvent, file).toEqual(parsed.data.expectedTaskState)
      expect(planEffects(parsed.data.initialTaskState, parsed.data.inputEvent, parsed.data.toolResults), file)
        .toEqual(parsed.data.expectedEffects)
      const composed = file === 'provider-timeout.json'
        ? composeFallbackSpec(afterEvent, '航班数据暂时不可用', '正在使用最近缓存，可稍后重试。')
        : file === 'invalid-ui-spec.json'
          ? composeFallbackSpec(afterEvent, '界面暂时降级', '已切换到安全模板。', 'error')
          : composePickupSpec(afterEvent, { toolResults: parsed.data.toolResults })
      const normalizedComposed = { ...composed, uiRevision: parsed.data.expectedUISpec.uiRevision, meta: { ...composed.meta, traceId: '<trace>' } }
      expect(normalizedComposed, file)
        .toEqual({ ...parsed.data.expectedUISpec, meta: { ...parsed.data.expectedUISpec.meta, traceId: '<trace>' } })
      if (file === 'provider-timeout.json') {
        expect(composeFallbackSpec(afterEvent, '航班数据暂时不可用', '正在使用最近缓存，可稍后重试。'), file)
          .toMatchObject({ ...parsed.data.expectedUISpec, meta: { ...parsed.data.expectedUISpec.meta, traceId: expect.any(String) } })
      }
      if (file === 'invalid-ui-spec.json') {
        expect(composeFallbackSpec(afterEvent, '界面暂时降级', '已切换到安全模板。', 'error'), file)
          .toMatchObject({ ...parsed.data.expectedUISpec, meta: { ...parsed.data.expectedUISpec.meta, traceId: expect.any(String) } })
      }
    }
  })

  it('composer renders a media-only cabin profile without inventing temperature', () => {
    const task = {
      ...createInitialTask(),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['doubao'], names: ['豆豆'], confirmedOnboard: true },
      updatedAt: '2026-07-22T20:56:00+08:00',
    }
    const spec = composePickupSpec(task, {
      toolResults: {
        'memory.get-preferences': {
          ok: true,
          data: { members: [{ memberId: 'doubao', mediaTitle: '豆豆故事' }] },
        },
      },
    })
    expect(spec.components).toEqual([
      expect.objectContaining({
        type: 'cabin-profile',
        props: expect.objectContaining({ mediaTitle: '豆豆故事', appliedFromMemory: true }),
      }),
    ])
    expect(spec.components[0]?.props).not.toHaveProperty('temperatureC')
  })

  it('composer ignores empty mediaTitle and does not emit a blank preference card', () => {
    const task = {
      ...createInitialTask(),
      phase: 'returning-home' as const,
      passengers: { memberIds: ['doubao'], names: ['豆豆'], confirmedOnboard: true },
      updatedAt: '2026-07-22T20:56:00+08:00',
    }
    const spec = composePickupSpec(task, {
      toolResults: {
        'memory.get-preferences': {
          ok: true,
          data: { members: [{ memberId: 'doubao', mediaTitle: '' }] },
        },
      },
    })
    expect(spec.title).toBe('返程回家')
    expect(spec.components.some((component) => component.type === 'cabin-profile')).toBe(false)
    expect(spec.components).toEqual([
      expect.objectContaining({
        type: 'passenger-status',
        props: expect.objectContaining({ status: 'confirmed-onboard' }),
      }),
    ])
  })
})
