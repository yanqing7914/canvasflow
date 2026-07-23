import { describe, expect, it } from 'vitest'
import { DEMO_ORIGIN } from './data'
import { createSideEffectRuntime } from './idempotency'
import { autoNotifyAuthorizationId, FAILING_CONTACT_ID, sendMessageConfirmationId } from './message'
import { createProviderRegistry, type ProviderRegistry } from './registry'
import type { ToolContext } from './result'

const ctx: ToolContext = { taskId: 'pickup-001' }

const airportPlanInput = {
  origin: { ...DEMO_ORIGIN },
  destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
}

const homePlanInput = {
  origin: { ...DEMO_ORIGIN },
  destination: { id: 'destination-home', name: '家' },
}

function planAirportRoute(registry: ProviderRegistry, taskCtx: ToolContext = ctx) {
  const planned = registry['navigation.plan-route'](taskCtx, airportPlanInput)
  expect(planned.ok).toBe(true)
  expect(planned.data?.routeId).toBe('route-airport-001')
  return planned
}

describe('navigation side effects', () => {
  it('start 使用幂等键，重复调用返回同一结果', () => {
    const registry = createProviderRegistry()
    planAirportRoute(registry)
    const input = { routeId: 'route-airport-001', idempotencyKey: 'pickup-001:start-navigation:route-airport-001' }
    const first = registry['navigation.start'](ctx, input)
    const second = registry['navigation.start'](ctx, input)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(first.data?.status).toBe('active')
  })

  it('未知 routeId 返回 ROUTE_EXPIRED', () => {
    const registry = createProviderRegistry()
    const result = registry['navigation.start'](ctx, {
      routeId: 'route-missing',
      idempotencyKey: 'pickup-001:start-missing',
    })
    expect(result.error).toMatchObject({ code: 'ROUTE_EXPIRED', retryable: false })
  })

  it('未在本任务规划的已知 routeId 不能 start', () => {
    const registry = createProviderRegistry()
    const result = registry['navigation.start'](ctx, {
      routeId: 'route-airport-001',
      idempotencyKey: 'pickup-001:start-unplanned',
    })
    expect(result.error).toMatchObject({ code: 'ROUTE_EXPIRED', retryable: false })
    expect(result.error?.message).toContain('尚未在本任务中规划或确认')
  })

  it('本任务 plan-route 后可以 start；其他任务的规划不共享', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    planAirportRoute(registry, { taskId: 'pickup-001' })
    const otherTask = registry['navigation.start'](
      { taskId: 'pickup-002' },
      { routeId: 'route-airport-001', idempotencyKey: 'pickup-002:start-unplanned' },
    )
    expect(otherTask.error).toMatchObject({ code: 'ROUTE_EXPIRED', retryable: false })

    const started = registry['navigation.start'](
      { taskId: 'pickup-001' },
      { routeId: 'route-airport-001', idempotencyKey: 'pickup-001:start-planned' },
    )
    expect(started.ok).toBe(true)
    expect(started.data).toMatchObject({ routeId: 'route-airport-001', status: 'active' })
  })

  it('update-route 可切换到回家路线', () => {
    const registry = createProviderRegistry()
    planAirportRoute(registry)
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
    const registry = createProviderRegistry()
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
    const registry = createProviderRegistry()
    const result = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      temperatureC: 25,
      sourceMemberIds: ['stranger'],
      idempotencyKey: 'pickup-001:apply-denied',
    })
    expect(result.error).toMatchObject({ code: 'POLICY_DENIED', retryable: false })
  })

  it('设置值与来源成员偏好不一致返回 POLICY_DENIED', () => {
    const registry = createProviderRegistry()
    const wrongTemperature = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      temperatureC: 30,
      sourceMemberIds: ['mom'],
      idempotencyKey: 'pickup-001:apply-wrong-temp',
    })
    expect(wrongTemperature.error).toMatchObject({ code: 'POLICY_DENIED', retryable: false })
    const wrongMedia = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      mediaTitle: '轻音乐',
      sourceMemberIds: ['doubao'],
      idempotencyKey: 'pickup-001:apply-wrong-media',
    })
    expect(wrongMedia.error).toMatchObject({ code: 'POLICY_DENIED', retryable: false })
  })

  it('原型属性 memberId（toString/constructor）返回 POLICY_DENIED 且不抛异常', () => {
    const registry = createProviderRegistry()
    for (const memberId of ['toString', 'constructor', '__proto__']) {
      expect(() => {
        const result = registry['vehicle.apply-cabin-profile'](ctx, {
          zone: 'rear',
          temperatureC: 25,
          sourceMemberIds: [memberId],
          idempotencyKey: `pickup-001:apply-proto-${memberId}`,
        })
        expect(result.error).toMatchObject({ code: 'POLICY_DENIED', retryable: false })
        expect(result.ok).toBe(false)
      }).not.toThrow()
    }
  })

  it('memory 确认更新后，cabin 按更新后的偏好授权', () => {
    const registry = createProviderRegistry()
    const proposed = registry['memory.propose-update'](ctx, { memberId: 'mom', changes: { rearTemperatureC: 24 } })
    registry['memory.confirm-update'](ctx, {
      proposalId: proposed.data!.proposalId,
      confirmationId: proposed.data!.confirmationId,
      idempotencyKey: 'pickup-001:confirm-then-cabin',
    })
    const applied = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      temperatureC: 24,
      sourceMemberIds: ['mom'],
      idempotencyKey: 'pickup-001:apply-after-update',
    })
    expect(applied.ok).toBe(true)
    const staleValue = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      temperatureC: 25,
      sourceMemberIds: ['mom'],
      idempotencyKey: 'pickup-001:apply-stale-value',
    })
    expect(staleValue.error?.code).toBe('POLICY_DENIED')
  })

  it('被后续 apply 覆盖的效果不能直接撤销，按逆序撤销可恢复', () => {
    const registry = createProviderRegistry()
    const first = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      temperatureC: 25,
      sourceMemberIds: ['mom'],
      idempotencyKey: 'pickup-001:apply-a',
    })
    const second = registry['vehicle.apply-cabin-profile'](ctx, {
      zone: 'rear',
      mediaTitle: '豆豆故事',
      sourceMemberIds: ['doubao'],
      idempotencyKey: 'pickup-001:apply-b',
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    // A 已被 B 覆盖，直接撤销 A 会丢掉 B 的设置
    const revertStale = registry['vehicle.revert-cabin-profile'](ctx, {
      effectId: first.data!.effectId,
      idempotencyKey: 'pickup-001:revert-a-early',
    })
    expect(revertStale.error?.code).toBe('APPLY_FAILED')

    // 逆序撤销：先 B 后 A，恢复到初始状态
    const revertB = registry['vehicle.revert-cabin-profile'](ctx, {
      effectId: second.data!.effectId,
      idempotencyKey: 'pickup-001:revert-b',
    })
    expect(revertB.ok).toBe(true)
    const revertA = registry['vehicle.revert-cabin-profile'](ctx, {
      effectId: first.data!.effectId,
      idempotencyKey: 'pickup-001:revert-a',
    })
    expect(revertA.ok).toBe(true)
    expect(revertA.data?.current.temperatureC).toBe(22)
  })
})

describe('media.play', () => {
  it('幂等播放已知媒体', () => {
    const registry = createProviderRegistry()
    const input = { mediaTitle: '豆豆故事', idempotencyKey: 'pickup-001:media' }
    expect(registry['media.play'](ctx, input)).toEqual(registry['media.play'](ctx, input))
  })

  it('未知媒体返回 MEDIA_UNAVAILABLE', () => {
    const registry = createProviderRegistry()
    const result = registry['media.play'](ctx, {
      mediaTitle: '未知专辑',
      idempotencyKey: 'pickup-001:media-missing',
    })
    expect(result.error).toMatchObject({ code: 'MEDIA_UNAVAILABLE', retryable: false })
  })

  it('sourceMemberId 与该成员偏好一致时才允许播放', () => {
    const registry = createProviderRegistry()
    const authorized = registry['media.play'](ctx, {
      mediaTitle: '豆豆故事',
      sourceMemberId: 'doubao',
      idempotencyKey: 'pickup-001:media-doubao',
    })
    expect(authorized.ok).toBe(true)
    expect(authorized.data).toMatchObject({ title: '豆豆故事', status: 'playing' })
  })

  it('sourceMemberId 未知或与偏好不匹配返回 POLICY_DENIED', () => {
    const registry = createProviderRegistry()
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
    const registry = createProviderRegistry()
    planAirportRoute(registry)
    const sharedKey = 'pickup-001:shared-key'
    const navigation = registry['navigation.start'](ctx, { routeId: 'route-airport-001', idempotencyKey: sharedKey })
    const media = registry['media.play'](ctx, { mediaTitle: '轻音乐', idempotencyKey: sharedKey })
    expect(navigation.ok).toBe(true)
    expect(media.ok).toBe(true)
    expect(navigation.meta.tool).toBe('navigation.start')
    expect(media.meta.tool).toBe('media.play')
    expect(media.data).toMatchObject({ title: '轻音乐', status: 'playing' })
  })

  it('不同 taskId 复用同一 idempotencyKey 不会串用缓存结果', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const sharedKey = 'shared-across-tasks'
    const input = { routeId: 'route-airport-001', idempotencyKey: sharedKey }
    planAirportRoute(registry, { taskId: 'pickup-001' })
    planAirportRoute(registry, { taskId: 'pickup-002' })
    const first = registry['navigation.start']({ taskId: 'pickup-001' }, input)
    const other = registry['navigation.start']({ taskId: 'pickup-002' }, input)
    expect(first.ok).toBe(true)
    expect(other.ok).toBe(true)
    expect(other).not.toBe(first)
    expect(other.data?.navigationId).toContain('pickup-002')
    expect(first.data?.navigationId).toContain('pickup-001')
  })
})

describe('message.send', () => {
  it('同一 idempotencyKey 最多成功发送一次', () => {
    const registry = createProviderRegistry()
    const input = {
      contactId: 'contact-mom',
      messageId: 'pickup-001:MU5102:landing',
      text: '我已到达机场接机点',
      authorizationId: autoNotifyAuthorizationId('pickup-001'),
      idempotencyKey: 'pickup-001:MU5102:landing',
    }
    const first = registry['message.send'](ctx, input)
    const second = registry['message.send'](ctx, input)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
  })

  it('缺少授权返回 AUTHORIZATION_REQUIRED', () => {
    const registry = createProviderRegistry()
    const result = registry['message.send'](ctx, {
      contactId: 'contact-mom',
      messageId: 'msg-1',
      text: 'hello',
      idempotencyKey: 'pickup-001:msg-no-auth',
    })
    expect(result.error).toMatchObject({ code: 'AUTHORIZATION_REQUIRED', retryable: false })
  })

  it('任意非空凭据不再有效，必须是任务绑定的授权或确认', () => {
    const registry = createProviderRegistry()
    const arbitraryAuth = registry['message.send'](ctx, {
      contactId: 'contact-mom',
      messageId: 'msg-2',
      text: 'hello',
      authorizationId: 'auth-anything',
      idempotencyKey: 'pickup-001:msg-bad-auth',
    })
    expect(arbitraryAuth.error?.code).toBe('AUTHORIZATION_REQUIRED')
    const arbitraryConfirm = registry['message.send'](ctx, {
      contactId: 'contact-mom',
      messageId: 'msg-3',
      text: 'hello',
      confirmationId: 'confirm-anything',
      idempotencyKey: 'pickup-001:msg-bad-confirm',
    })
    expect(arbitraryConfirm.error?.code).toBe('AUTHORIZATION_REQUIRED')
    const wrongTask = registry['message.send'](ctx, {
      contactId: 'contact-mom',
      messageId: 'msg-4',
      text: 'hello',
      authorizationId: autoNotifyAuthorizationId('other-task'),
      idempotencyKey: 'pickup-001:msg-wrong-task',
    })
    expect(wrongTask.error?.code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('预授权路径要求联系人对应成员开启落地通知授权', () => {
    const registry = createProviderRegistry()
    // FAILING_CONTACT_ID 不属于任何成员，auto-notify 预授权不适用
    const result = registry['message.send'](ctx, {
      contactId: FAILING_CONTACT_ID,
      messageId: 'msg-5',
      text: 'hello',
      authorizationId: autoNotifyAuthorizationId('pickup-001'),
      idempotencyKey: 'pickup-001:msg-auto-unknown',
    })
    expect(result.error?.code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('失败联系人返回 SEND_FAILED 且不写入幂等账本', () => {
    const registry = createProviderRegistry()
    const message = { contactId: FAILING_CONTACT_ID, messageId: 'msg-fail', text: 'hello' }
    const input = {
      ...message,
      confirmationId: sendMessageConfirmationId('pickup-001', message),
      idempotencyKey: 'pickup-001:msg-fail',
    }
    expect(registry['message.send'](ctx, input).error?.code).toBe('SEND_FAILED')
    expect(registry['message.send'](ctx, input).error?.code).toBe('SEND_FAILED')
  })

  it('显式确认凭据绑定到具体消息，换联系人或文案后失效', () => {
    const registry = createProviderRegistry()
    const message = { contactId: 'contact-mom', messageId: 'msg-confirm-1', text: '我已到达机场' }
    const confirmationId = sendMessageConfirmationId('pickup-001', message)

    const otherText = registry['message.send'](ctx, {
      ...message,
      text: '换一段完全不同的文案',
      confirmationId,
      idempotencyKey: 'pickup-001:msg-confirm-other-text',
    })
    expect(otherText.error?.code).toBe('AUTHORIZATION_REQUIRED')

    const otherMessageId = registry['message.send'](ctx, {
      ...message,
      messageId: 'msg-confirm-2',
      confirmationId,
      idempotencyKey: 'pickup-001:msg-confirm-other-id',
    })
    expect(otherMessageId.error?.code).toBe('AUTHORIZATION_REQUIRED')

    const bound = registry['message.send'](ctx, {
      ...message,
      confirmationId,
      idempotencyKey: 'pickup-001:msg-confirm-bound',
    })
    expect(bound.ok).toBe(true)
  })

  it('同一 idempotencyKey 换参数不能重放缓存结果', () => {
    const registry = createProviderRegistry()
    const sendInput = {
      contactId: 'contact-mom',
      messageId: 'msg-conflict',
      text: 'hello',
      authorizationId: autoNotifyAuthorizationId('pickup-001'),
      idempotencyKey: 'pickup-001:conflict-key',
    }
    expect(registry['message.send'](ctx, sendInput).ok).toBe(true)
    // 同 key 改文案：不能返回上一次的成功回执
    const conflict = registry['message.send'](ctx, { ...sendInput, text: 'bye' })
    expect(conflict.error).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false })

    // 其他副作用工具同样受保护（以 navigation.start 为代表）
    planAirportRoute(registry)
    expect(registry['navigation.plan-route'](ctx, homePlanInput).ok).toBe(true)
    const started = registry['navigation.start'](ctx, { routeId: 'route-airport-001', idempotencyKey: 'nav-conflict' })
    expect(started.ok).toBe(true)
    const navConflict = registry['navigation.start'](ctx, { routeId: 'route-home-001', idempotencyKey: 'nav-conflict' })
    expect(navConflict.error).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false })
  })
})

describe('memory write side effects', () => {
  it('propose 后 confirm 才写入，confirm 幂等且写入对读取可见', () => {
    const registry = createProviderRegistry()
    const proposed = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { rearTemperatureC: 26 },
    })
    expect(proposed.ok).toBe(true)
    expect(proposed.data?.requiresConfirmation).toBe(true)

    const confirmInput = {
      proposalId: proposed.data!.proposalId,
      confirmationId: proposed.data!.confirmationId,
      idempotencyKey: 'pickup-001:save-memory:confirm-001',
    }
    const first = registry['memory.confirm-update'](ctx, confirmInput)
    const second = registry['memory.confirm-update'](ctx, confirmInput)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(first.data?.applied).toEqual({ rearTemperatureC: 26 })

    // 同一 registry 的读取工具必须能看到确认后的写入
    const readBack = registry['memory.get-preferences'](ctx, { memberIds: ['mom'], scopes: ['cabin'] })
    expect(readBack.data?.members).toEqual([{ memberId: 'mom', rearTemperatureC: 26 }])
  })

  it('拒绝包含未知字段的 preference changes（strict schema）', () => {
    const registry = createProviderRegistry()
    const result = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { rearTemperatureC: 26, secretPhone: '13800000000' },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('确认凭据必须与提案签发的一致', () => {
    const registry = createProviderRegistry()
    const proposed = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { rearTemperatureC: 27 },
    })
    const wrong = registry['memory.confirm-update'](ctx, {
      proposalId: proposed.data!.proposalId,
      confirmationId: 'confirm-anything',
      idempotencyKey: 'pickup-001:confirm-wrong-token',
    })
    expect(wrong.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', retryable: false })
  })

  it('相同变更幂等返回同一提案，不同变更签发新版本并使旧提案失效', () => {
    const registry = createProviderRegistry()
    const first = registry['memory.propose-update'](ctx, { memberId: 'mom', changes: { rearTemperatureC: 26 } })
    const repeated = registry['memory.propose-update'](ctx, { memberId: 'mom', changes: { rearTemperatureC: 26 } })
    expect(repeated.data?.proposalId).toBe(first.data!.proposalId)

    const superseding = registry['memory.propose-update'](ctx, { memberId: 'mom', changes: { rearTemperatureC: 28 } })
    expect(superseding.data?.proposalId).not.toBe(first.data!.proposalId)

    // 被取代的旧提案不能再确认
    const staleConfirm = registry['memory.confirm-update'](ctx, {
      proposalId: first.data!.proposalId,
      confirmationId: first.data!.confirmationId,
      idempotencyKey: 'pickup-001:confirm-stale',
    })
    expect(staleConfirm.error?.code).toBe('PROPOSAL_EXPIRED')

    const confirmed = registry['memory.confirm-update'](ctx, {
      proposalId: superseding.data!.proposalId,
      confirmationId: superseding.data!.confirmationId,
      idempotencyKey: 'pickup-001:confirm-superseding',
    })
    expect(confirmed.ok).toBe(true)
    expect(confirmed.data?.applied).toEqual({ rearTemperatureC: 28 })
  })

  it('过期提案返回 PROPOSAL_EXPIRED', () => {
    let now = Date.parse('2026-07-22T12:00:00+08:00')
    const runtime = createSideEffectRuntime(() => now)
    const registry = createProviderRegistry(runtime)
    const proposed = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { mediaTitle: '轻音乐' },
    })
    now += 31 * 60 * 1000
    const confirmed = registry['memory.confirm-update'](ctx, {
      proposalId: proposed.data!.proposalId,
      confirmationId: proposed.data!.confirmationId,
      idempotencyKey: 'pickup-001:save-late',
    })
    expect(confirmed.error).toMatchObject({ code: 'PROPOSAL_EXPIRED', retryable: false })
  })

  it('非白名单字段不能进入提案', () => {
    const registry = createProviderRegistry()
    const result = registry['memory.propose-update'](ctx, {
      memberId: 'mom',
      changes: { secretPhone: '123' },
    })
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })
})
