import { describe, expect, it } from 'vitest'
import { uiSpecSchema, type AirportPickupEvent, type AirportPickupTaskState } from '@canvasflow/schema'
import { applyEvent, planEffects } from '@canvasflow/agent'
import { composeFallbackSpec, composePickupSpec } from '@canvasflow/ui'
import { getFlightStatus } from './flight'
import { planRoute } from './navigation'
import { autoNotifyAuthorizationId, FAILING_CONTACT_ID, prepareMessage, sendMessageConfirmationId } from './message'
import { createSideEffectRuntime } from './idempotency'
import { createToolRegistry } from './registry'
import type { ToolContext } from './result'

const ctx: ToolContext = { taskId: 'pickup-001' }

function drivingState(overrides: Partial<AirportPickupTaskState> = {}): AirportPickupTaskState {
  return {
    taskId: 'pickup-001',
    surfaceId: 'airport-pickup-main',
    taskRevision: 3,
    uiRevision: 3,
    phase: 'driving-to-airport',
    passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: false },
    flight: { flightNumber: 'MU5102', status: 'in-air', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
    navigation: { routeId: 'route-airport-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:25:00+08:00', status: 'active' },
    charging: { recommended: false, accepted: false, status: 'none' },
    message: { autoNotifyAuthorized: true, status: 'idle', landingNoticeSent: false },
    processedEventIds: [],
    updatedAt: '2026-07-22T20:35:00+08:00',
    ...overrides,
  }
}

function landedEvent(eventId: string, timestamp: string): AirportPickupEvent {
  return {
    eventId,
    type: 'flight.updated',
    flight: { flightNumber: 'MU5102', status: 'landed', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
    timestamp,
  }
}

describe('重复航班落地事件：消息重复发送率 0%', () => {
  it('同一事件重放和后续重复落地推送都不再计划或发送消息', () => {
    const registry = createToolRegistry(createSideEffectRuntime())
    const state = drivingState()
    const first = landedEvent('landed-1', '2026-07-22T20:40:00+08:00')

    expect(planEffects(state, first, {})).toEqual([{ type: 'message.send', status: 'planned', tool: 'message.send' }])
    const scheduled = applyEvent(state, first)
    expect(scheduled.message).toMatchObject({ status: 'scheduled', idempotencyKey: 'pickup-001:MU5102:landing' })

    // 同一事件重放：状态不变，不再计划副作用
    expect(applyEvent(scheduled, first)).toEqual(scheduled)
    expect(planEffects(scheduled, first, {})).toEqual([])

    // 不同 eventId 的重复落地推送：也不再计划副作用
    const duplicate = landedEvent('landed-2', '2026-07-22T20:41:00+08:00')
    expect(planEffects(scheduled, duplicate, {})).toEqual([])

    // 完整消息生命周期：message.prepare 生成预览，其 messageId 与任务侧
    // idempotencyKey 同构（`${taskId}:${pendingMessageId}`），不允许手写标识
    const prepared = prepareMessage(ctx, { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:40' })
    expect(prepared.ok).toBe(true)
    expect(prepared.data!.messageId).toBe(scheduled.message.idempotencyKey)
    expect(prepared.data!.messageId).toBe(`${scheduled.taskId}:${scheduled.message.pendingMessageId}`)

    // Provider 层：同一幂等键重复发送返回缓存的同一结果对象，副作用只发生一次
    const sendInput = {
      contactId: prepared.data!.contactId,
      messageId: prepared.data!.messageId,
      text: prepared.data!.text,
      authorizationId: autoNotifyAuthorizationId(scheduled.taskId),
      idempotencyKey: scheduled.message.idempotencyKey!,
    }
    const firstSend = registry['message.send'](ctx, sendInput)
    const secondSend = registry['message.send'](ctx, sendInput)
    expect(firstSend.ok).toBe(true)
    expect(secondSend).toBe(firstSend)

    // 发送回执喂回状态机：状态置为 sent，landingNoticeSent 置位
    const sentEvent: AirportPickupEvent = {
      eventId: 'message-sent-1',
      type: 'message.sent',
      messageId: scheduled.message.pendingMessageId!,
      timestamp: '2026-07-22T20:41:30+08:00',
    }
    const sent = applyEvent(scheduled, sentEvent)
    expect(sent.message).toMatchObject({ status: 'sent', landingNoticeSent: true })
    expect(sent.message.pendingMessageId).toBeUndefined()

    // 发送完成后，重放回执或再次落地推送都不再产生任何副作用
    expect(applyEvent(sent, sentEvent)).toEqual(sent)
    expect(planEffects(sent, landedEvent('landed-3', '2026-07-22T20:42:00+08:00'), {})).toEqual([])
  })
})

describe('message.failed：不自动重试，只允许用户显式重试', () => {
  it('失败后不设 landingNoticeSent，后续落地推送不会自动再计划发送', () => {
    const scheduled = applyEvent(drivingState(), landedEvent('landed-1', '2026-07-22T20:40:00+08:00'))
    const failed = applyEvent(scheduled, {
      eventId: 'send-failed',
      type: 'message.failed',
      messageId: scheduled.message.pendingMessageId!,
      errorCode: 'SEND_FAILED',
      timestamp: '2026-07-22T20:41:00+08:00',
    })
    expect(failed.message).toMatchObject({ status: 'failed', landingNoticeSent: false })
    expect(failed.message.pendingMessageId).toBeUndefined()

    // 后续重复落地推送：message.status 不是 idle，不自动重试
    const retryPush = landedEvent('landed-3', '2026-07-22T20:42:00+08:00')
    expect(planEffects(failed, retryPush, {})).toEqual([])

    // UI 不渲染"已计划发送"的消息卡片，也不要求确认
    const spec = composePickupSpec(failed)
    expect(spec.components.map((component) => component.type)).not.toContain('message-preview')
    expect(spec.meta.requiresConfirm).toBe(false)
  })

  it('Provider 层失败不缓存，显式重试语义 = 新幂等键 + 任务确认凭据', () => {
    // 说明：显式重试的产品入口（重试按钮/语音指令）属于 UI 层，当前 UISpec
    // 不提供 retry action（上面已断言 failed 状态无 message-preview、无确认要求）。
    // 本用例验证的是工具契约侧的重试语义：失败结果不进幂等账本，
    // 携带新幂等键与任务绑定确认凭据的显式重试可以再次尝试。
    const registry = createToolRegistry(createSideEffectRuntime())
    const failingMessage = { contactId: FAILING_CONTACT_ID, messageId: 'pickup-001:MU5102:landing', text: '我已到达机场接机点。' }
    const failingInput = {
      ...failingMessage,
      confirmationId: sendMessageConfirmationId('pickup-001', failingMessage),
      idempotencyKey: 'pickup-001:MU5102:landing:attempt-1',
    }
    expect(registry['message.send'](ctx, failingInput).error?.code).toBe('SEND_FAILED')

    // 重试指向新的联系人/内容时，确认凭据也必须针对新消息重新签发
    const retryMessage = { ...failingMessage, contactId: 'contact-mom' }
    const retried = registry['message.send'](ctx, {
      ...retryMessage,
      confirmationId: sendMessageConfirmationId('pickup-001', retryMessage),
      idempotencyKey: 'pickup-001:MU5102:landing:attempt-2',
    })
    expect(retried.ok).toBe(true)
    expect(retried.data).toMatchObject({ status: 'sent' })
  })
})

describe('charging.completed：恢复前往机场的路线和上下文', () => {
  it('补能完成后导航、航班与乘客上下文保持不变，UI 显示恢复提示', () => {
    const charging = drivingState({
      charging: { recommended: true, accepted: true, status: 'active' },
      navigation: { routeId: 'route-airport-via-charge-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:37:00+08:00', status: 'active' },
      updatedAt: '2026-07-22T20:17:00+08:00',
    })
    const completed = applyEvent(charging, {
      eventId: 'charging-done',
      type: 'charging.completed',
      batteryPercent: 78,
      timestamp: '2026-07-22T20:18:00+08:00',
    })
    expect(completed.charging.status).toBe('completed')
    expect(completed.phase).toBe('driving-to-airport')
    // 途经充电站的路线本身就以机场为终点：补能完成后路线、ETA 与全部上下文原样保留
    expect(completed.navigation).toEqual({
      routeId: 'route-airport-via-charge-001',
      destination: '虹桥机场 T2',
      eta: '2026-07-22T20:37:00+08:00',
      status: 'active',
    })
    expect(completed.flight).toEqual(charging.flight)
    expect(completed.passengers).toEqual(charging.passengers)

    const spec = composePickupSpec(completed)
    expect(spec.title).toBe('去虹桥机场接妈妈和豆豆')
    expect(spec.components).toEqual([
      expect.objectContaining({
        type: 'charging-recommendation',
        props: expect.objectContaining({ recommended: false, reason: '补能完成，已恢复机场路线' }),
      }),
    ])
  })

  it('补能完成后以任务状态为输入显式切回直达机场路线', () => {
    // Planner 侧对 charging.completed 的自动改线不属于工具层；当前契约下该事件
    // 不计划任何副作用，切回直达路线由用户/Planner 显式发起。这里验证：恢复
    // 调用的全部输入都取自补能完成后的任务状态，而不是测试里手写的常量。
    const registry = createToolRegistry(createSideEffectRuntime())
    const charging = drivingState({
      charging: { recommended: true, accepted: true, status: 'active' },
      navigation: { routeId: 'route-airport-via-charge-001', destination: '虹桥机场 T2', eta: '2026-07-22T20:37:00+08:00', status: 'active' },
      updatedAt: '2026-07-22T20:17:00+08:00',
    })
    const completedEvent: AirportPickupEvent = {
      eventId: 'charging-done-resume',
      type: 'charging.completed',
      batteryPercent: 78,
      timestamp: '2026-07-22T20:18:00+08:00',
    }
    expect(planEffects(charging, completedEvent, {})).toEqual([])
    const completed = applyEvent(charging, completedEvent)
    expect(completed.charging.status).toBe('completed')

    const resumed = registry['navigation.update-route'](ctx, {
      routeId: completed.navigation!.routeId,
      destination: { id: 'destination-hongqiao-t2', name: completed.navigation!.destination },
      idempotencyKey: `${completed.taskId}:resume-direct:${completed.navigation!.routeId}`,
    })
    expect(resumed.ok).toBe(true)
    expect(resumed.data).toMatchObject({
      routeId: 'route-airport-001',
      destination: completed.navigation!.destination,
      status: 'active',
    })
  })

  it('经停充电站与直达机场两条 fixture 路线都可确定性规划', () => {
    const direct = planRoute(ctx, {
      origin: { latitude: 31.23, longitude: 121.47 },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
    })
    const viaStation = planRoute(ctx, {
      origin: { latitude: 31.23, longitude: 121.47 },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      via: [{ id: 'station-hongqiao-01', name: '虹桥超充站' }],
    })
    expect(direct.data?.routeId).toBe('route-airport-001')
    expect(viaStation.data?.routeId).toBe('route-airport-via-charge-001')
  })
})

describe('provider.timeout（MU0000）：Agent / UI 降级路径', () => {
  it('MU0000 确定性触发 PROVIDER_TIMEOUT 且可重试', () => {
    const first = getFlightStatus(ctx, { flightNumber: 'MU0000', date: '2026-07-22' })
    const second = getFlightStatus(ctx, { flightNumber: 'MU0000', date: '2026-07-22' })
    expect(first.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
    expect(second).toEqual(first)
  })

  it('超时事件只标记已处理，不改动任务事实，UI 落到警示降级卡片', () => {
    const state = drivingState()
    const timedOut = applyEvent(state, {
      eventId: 'flight-timeout',
      type: 'provider.timeout',
      provider: 'flight-provider',
      timestamp: '2026-07-22T20:36:00+08:00',
    })
    expect(timedOut.taskRevision).toBe(state.taskRevision)
    expect(timedOut.processedEventIds).toContain('flight-timeout')
    expect(timedOut.flight).toEqual(state.flight)

    const spec = composeFallbackSpec(timedOut, '航班数据暂时不可用', '正在使用最近缓存，可稍后重试。')
    expect(spec.meta.generatedBy).toBe('fallback')
    expect(spec.components).toEqual([
      expect.objectContaining({
        type: 'status-banner',
        props: expect.objectContaining({ level: 'warning', title: '航班数据暂时不可用' }),
      }),
    ])
  })
})

describe('invalid-ui-spec：确定性降级卡片，不白屏', () => {
  it('非法 UISpec 被 Schema 拒绝', () => {
    const invalid = uiSpecSchema.safeParse({ version: '1.0', taskId: 'pickup-001', components: 'not-an-array' })
    expect(invalid.success).toBe(false)
  })

  it('降级卡片确定性生成且始终有可渲染内容', () => {
    const state = drivingState()
    const first = composeFallbackSpec(state, '界面暂时降级', '已切换到安全模板。', 'error')
    const second = composeFallbackSpec(state, '界面暂时降级', '已切换到安全模板。', 'error')
    expect(second).toEqual(first)
    expect(() => uiSpecSchema.parse(first)).not.toThrow()
    expect(first.components.length).toBeGreaterThan(0)
    expect(first.layout.slots).toEqual({ main: first.components.map((component) => component.id) })
    expect(first.components[0]).toMatchObject({ type: 'status-banner', props: { level: 'error', title: '界面暂时降级' } })
  })
})
