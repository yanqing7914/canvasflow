import { describe, expect, it } from 'vitest'
import { createSideEffectRuntime } from './idempotency'
import { FAILING_CONTACT_ID } from './message'
import { createToolRegistry } from './registry'
import type { ToolContext } from './result'

const ctx: ToolContext = { taskId: 'pickup-001' }

describe('navigation side effects', () => {
  it('start 使用幂等键，重复调用返回同一结果', () => {
    const registry = createToolRegistry()
    const input = { routeId: 'route-airport-001', idempotencyKey: 'pickup-001:start-navigation:route-airport-001' }
    const first = registry['navigation.start'](ctx, input)
    const second = registry['navigation.start'](ctx, input)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(first.data?.status).toBe('active')
  })

  it('未知 routeId 返回 ROUTE_EXPIRED', () => {
    const registry = createToolRegistry()
    const result = registry['navigation.start'](ctx, {
      routeId: 'route-missing',
      idempotencyKey: 'pickup-001:start-missing',
    })
    expect(result.error).toMatchObject({ code: 'ROUTE_EXPIRED', retryable: false })
  })

  it('update-route 可切换到回家路线', () => {
    const registry = createToolRegistry()
    const result = registry['navigation.update-route'](ctx, {
      routeId: 'route-airport-001',
      destination: { id: 'destination-home', name: '家' },
      idempotencyKey: 'pickup-001:update-home',
    })
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ routeId: 'route-home-001', destination: '家', status: 'active' })
  })
})

describe('cabin profile side effects', () => {
  it('应用后可撤销，重复撤销不再改变状态', () => {
    const registry = createToolRegistry()
    const applied = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      temperatureC: 25,
      mediaTitle: '豆豆故事',
      sourceMemberIds: ['mom', 'doubao'],
      idempotencyKey: 'pickup-001:apply-cabin',
    })
    expect(applied.ok).toBe(true)
    expect(applied.data?.previous.temperatureC).toBe(22)
    expect(applied.data?.current.temperatureC).toBe(25)

    const effectId = applied.data!.effectId
    const firstRevert = registry['vehicle.revert-cabin-profile'](ctx, {
      effectId,
      idempotencyKey: 'pickup-001:revert-cabin',
    })
    const secondRevert = registry['vehicle.revert-cabin-profile'](ctx, {
      effectId,
      idempotencyKey: 'pickup-001:revert-cabin',
    })
    expect(firstRevert).toEqual(secondRevert)
    expect(firstRevert.data?.current.temperatureC).toBe(22)
  })

  it('未授权成员返回 POLICY_DENIED', () => {
    const registry = createToolRegistry()
    const result = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      temperatureC: 25,
      sourceMemberIds: ['stranger'],
      idempotencyKey: 'pickup-001:apply-denied',
    })
    expect(result.error).toMatchObject({ code: 'POLICY_DENIED', retryable: false })
  })
})

describe('media.play', () => {
  it('幂等播放已知媒体', () => {
    const registry = createToolRegistry()
    const input = { mediaTitle: '豆豆故事', idempotencyKey: 'pickup-001:media' }
    expect(registry['media.play'](ctx, input)).toEqual(registry['media.play'](ctx, input))
  })

  it('未知媒体返回 MEDIA_UNAVAILABLE', () => {
    const registry = createToolRegistry()
    const result = registry['media.play'](ctx, {
      mediaTitle: '未知专辑',
      idempotencyKey: 'pickup-001:media-missing',
    })
    expect(result.error).toMatchObject({ code: 'MEDIA_UNAVAILABLE', retryable: false })
  })

  it('sourceMemberId 与该成员偏好一致时才允许播放', () => {
    const registry = createToolRegistry()
    const authorized = registry['media.play'](ctx, {
      mediaTitle: '豆豆故事',
      sourceMemberId: 'doubao',
      idempotencyKey: 'pickup-001:media-doubao',
    })
    expect(authorized.ok).toBe(true)
    expect(authorized.data).toMatchObject({ title: '豆豆故事', status: 'playing' })
  })

  it('sourceMemberId 未知或与偏好不匹配返回 POLICY_DENIED', () => {
    const registry = createToolRegistry()
    const unknownMember = registry['media.play'](ctx, {
      mediaTitle: '豆豆故事',
      sourceMemberId: 'stranger',
      idempotencyKey: 'pickup-001:media-stranger',
    })
    expect(unknownMember.error).toMatchObject({ code: 'POLICY_DENIED', retryable: false })
    const mismatched = registry['media.play'](ctx, {
      mediaTitle: '豆豆故事',
      sourceMemberId: 'mom',
      idempotencyKey: 'pickup-001:media-mom',
    })
    expect(mismatched.error).toMatchObject({ code: 'POLICY_DENIED', retryable: false })
  })
})

describe('idempotency store isolation', () => {
  it('不同工具复用同一 idempotencyKey 不会串用缓存结果', () => {
    const registry = createToolRegistry()
    const sharedKey = 'pickup-001:shared-key'
    const navigation = registry['navigation.start'](ctx, { routeId: 'route-airport-001', idempotencyKey: sharedKey })
    const media = registry['media.play'](ctx, { mediaTitle: '轻音乐', idempotencyKey: sharedKey })
    expect(navigation.ok).toBe(true)
    expect(media.ok).toBe(true)
    expect(navigation.meta.tool).toBe('navigation.start')
    expect(media.meta.tool).toBe('media.play')
    expect(media.data).toMatchObject({ title: '轻音乐', status: 'playing' })
  })
})

describe('message.send', () => {
  it('同一 idempotencyKey 最多成功发送一次', () => {
    const registry = createToolRegistry()
    const input = {
      contactId: 'contact-mom',
      messageId: 'pickup-001:MU5102:landing',
      text: '我已到达机场接机点',
      authorizationId: 'auth-landing-once',
      idempotencyKey: 'pickup-001:MU5102:landing',
    }
    const first = registry['message.send'](ctx, input)
    const second = registry['message.send'](ctx, input)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
  })

  it('缺少授权返回 AUTHORIZATION_REQUIRED', () => {
    const registry = createToolRegistry()
    const result = registry['message.send'](ctx, {
      contactId: 'contact-mom',
      messageId: 'msg-1',
      text: 'hello',
      idempotencyKey: 'pickup-001:msg-no-auth',
    })
    expect(result.error).toMatchObject({ code: 'AUTHORIZATION_REQUIRED', retryable: false })
  })

  it('失败联系人返回 SEND_FAILED 且不写入幂等账本', () => {
    const registry = createToolRegistry()
    const input = {
      contactId: FAILING_CONTACT_ID,
      messageId: 'msg-fail',
      text: 'hello',
      authorizationId: 'auth-1',
      idempotencyKey: 'pickup-001:msg-fail',
    }
    expect(registry['message.send'](ctx, input).error?.code).toBe('SEND_FAILED')
    expect(registry['message.send'](ctx, input).error?.code).toBe('SEND_FAILED')
  })
})

describe('memory write side effects', () => {
  it('propose 后 confirm 才写入，且 confirm 幂等', () => {
    const registry = createToolRegistry()
    const proposed = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { rearTemperatureC: 26 },
    })
    expect(proposed.ok).toBe(true)
    expect(proposed.data?.requiresConfirmation).toBe(true)

    const confirmInput = {
      proposalId: proposed.data!.proposalId,
      confirmationId: 'confirm-save-memory',
      idempotencyKey: 'pickup-001:save-memory:confirm-001',
    }
    const first = registry['memory.confirm-update'](ctx, confirmInput)
    const second = registry['memory.confirm-update'](ctx, confirmInput)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(first.data?.applied).toEqual({ rearTemperatureC: 26 })
  })

  it('过期提案返回 PROPOSAL_EXPIRED', () => {
    let now = Date.parse('2026-07-22T12:00:00+08:00')
    const runtime = createSideEffectRuntime(() => now)
    const registry = createToolRegistry(runtime)
    const proposed = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { mediaTitle: '轻音乐' },
    })
    now += 31 * 60 * 1000
    const confirmed = registry['memory.confirm-update'](ctx, {
      proposalId: proposed.data!.proposalId,
      confirmationId: 'confirm-late',
      idempotencyKey: 'pickup-001:save-late',
    })
    expect(confirmed.error).toMatchObject({ code: 'PROPOSAL_EXPIRED', retryable: false })
  })

  it('非白名单字段不能进入提案', () => {
    const registry = createToolRegistry()
    const result = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { secretPhone: '123' },
    })
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })
})
