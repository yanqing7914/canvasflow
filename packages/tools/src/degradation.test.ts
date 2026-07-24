import { describe, expect, it } from 'vitest'
import { uiSpecSchema, type AirportPickupEvent, type AirportPickupTaskState } from '@canvasflow/schema'
import { applyEvent, planEffects } from '@canvasflow/agent'
import { composeFallbackSpec, composePickupSpec } from '@canvasflow/ui'
import { TIMEOUT_DESTINATION_ID } from './data'
import { getFlightStatus } from './flight'
import { planRoute } from './navigation'
import { FAILING_CONTACT_ID, issueAutoNotifyAuthorization, issueSendMessageConfirmation, prepareMessage } from './message'
import { createSideEffectRuntime } from './idempotency'
import { createProviderRegistry } from './registry'
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

describe('无授权落地联系人：不进入 scheduled 死胡同', () => {
  it('乘客均未授权时不计划发送，状态保持 idle，UI 不展示落地通知卡片', () => {
    const state = drivingState({
      passengers: { memberIds: ['doubao'], names: ['豆豆'], confirmedOnboard: false },
    })
    const landed = landedEvent('landed-unauthorized', '2026-07-22T20:40:00+08:00')
    expect(planEffects(state, landed, {})).toEqual([])
    const next = applyEvent(state, landed)
    expect(next.flight?.status).toBe('landed')
    expect(next.message.status).toBe('idle')
    expect(next.message.pendingContactId).toBeUndefined()
    expect(next.message.pendingMessageId).toBeUndefined()
    const spec = composePickupSpec(next)
    expect(spec.title).not.toBe('落地通知')
    expect(spec.components.some((component) => component.type === 'message-preview')).toBe(false)
    expect(spec.actions).toEqual([])
  })
})

describe('重复航班落地事件：消息重复发送率 0%', () => {
  it('同一事件重放和后续重复落地推送都不再计划或发送消息', () => {
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const state = drivingState()
    const first = landedEvent('landed-1', '2026-07-22T20:40:00+08:00')

    expect(planEffects(state, first, {}, runtime.preferences)).toEqual([{ type: 'message.send', status: 'planned', tool: 'message.send' }])
    const scheduled = applyEvent(state, first, runtime.preferences)
    expect(scheduled.message).toMatchObject({
      status: 'scheduled',
      idempotencyKey: 'pickup-001:MU5102:landing',
      pendingContactId: 'contact-mom',
    })

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
      authorizationId: issueAutoNotifyAuthorization(runtime, scheduled.taskId),
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

    // UI 暴露失败预览与显式重试入口，不要求确认弹窗
    const spec = composePickupSpec(failed)
    expect(spec.components).toEqual([
      expect.objectContaining({
        type: 'message-preview',
        props: expect.objectContaining({ status: 'failed', cancellable: false }),
      }),
    ])
    expect(spec.actions).toEqual([
      expect.objectContaining({
        id: 'retry-landing-message',
        label: '重试发送',
        event: { type: 'tool-request', actionToken: 'pickup-001:retry-landing-message' },
      }),
    ])
    expect(spec.meta.requiresConfirm).toBe(false)
  })

  it('返程阶段不再被历史 charging.completed 卡片遮挡座舱偏好', () => {
    const returning = drivingState({
      phase: 'returning-home',
      passengers: { memberIds: ['mom', 'doubao'], names: ['妈妈', '豆豆'], confirmedOnboard: true },
      charging: { recommended: true, accepted: true, status: 'completed' },
      updatedAt: '2026-07-22T20:56:00+08:00',
    })
    const spec = composePickupSpec(returning, {
      toolResults: {
        'memory.get-preferences': {
          ok: true,
          data: { members: [{ memberId: 'mom', rearTemperatureC: 25 }] },
        },
      },
    })
    expect(spec.components.map((component) => component.type)).toContain('cabin-profile')
    expect(spec.components.map((component) => component.type)).not.toContain('charging-recommendation')
  })

  it('失败态优先于残留的 memory.get-preferences 结果，仍展示重试入口', () => {
    const scheduled = applyEvent(drivingState(), landedEvent('landed-1', '2026-07-22T20:40:00+08:00'))
    const failed = applyEvent(scheduled, {
      eventId: 'send-failed',
      type: 'message.failed',
      messageId: scheduled.message.pendingMessageId!,
      errorCode: 'SEND_FAILED',
      timestamp: '2026-07-22T20:41:00+08:00',
    })
    const spec = composePickupSpec(failed, {
      toolResults: {
        'memory.get-preferences': {
          ok: true,
          data: { members: [{ memberId: 'mom', rearTemperatureC: 25 }] },
        },
      },
    })
    expect(spec.actions.some((action) => action.id === 'retry-landing-message')).toBe(true)
    expect(spec.components.map((component) => component.type)).toContain('message-preview')
    expect(spec.components.map((component) => component.type)).not.toContain('cabin-profile')
  })

  it('UI 重试 action → 签发确认 → provider 发送成功（完整显式重试路径）', () => {
    const scheduled = applyEvent(drivingState(), landedEvent('landed-1', '2026-07-22T20:40:00+08:00'))
    const failed = applyEvent(scheduled, {
      eventId: 'send-failed',
      type: 'message.failed',
      messageId: scheduled.message.pendingMessageId!,
      errorCode: 'SEND_FAILED',
      timestamp: '2026-07-22T20:41:00+08:00',
    })

    const spec = composePickupSpec(failed)
    const retryAction = spec.actions.find((action) => action.id === 'retry-landing-message')
    expect(retryAction?.event).toEqual({
      type: 'tool-request',
      actionToken: `${failed.taskId}:retry-landing-message`,
    })

    // Agent 处理 tool-request：重新 prepare、签发一次性确认、用新幂等键发送
    const runtime = createSideEffectRuntime()
    const registry = createProviderRegistry(runtime)
    const prepared = prepareMessage(ctx, { contactId: 'contact-mom', flightNumber: 'MU5102', eta: '20:40' })
    expect(prepared.ok).toBe(true)

    const binding = {
      taskId: failed.taskId,
      contactId: prepared.data!.contactId,
      messageId: prepared.data!.messageId,
      text: prepared.data!.text,
    }
    const confirmationId = issueSendMessageConfirmation(runtime, binding)
    const retried = registry['message.send'](ctx, {
      ...binding,
      confirmationId,
      idempotencyKey: `${failed.taskId}:MU5102:landing:retry-1`,
    })
    expect(retried.ok).toBe(true)
    expect(retried.data).toMatchObject({ status: 'sent', messageId: prepared.data!.messageId })

    // 失败结果不进幂等账本：同一失败联系人可再次尝试（仍失败，且不消耗 token）
    const failingBinding = {
      taskId: failed.taskId,
      contactId: FAILING_CONTACT_ID,
      messageId: prepared.data!.messageId,
      text: prepared.data!.text,
    }
    const failingToken = issueSendMessageConfirmation(runtime, failingBinding)
    expect(
      registry['message.send'](ctx, {
        ...failingBinding,
        confirmationId: failingToken,
        idempotencyKey: `${failed.taskId}:MU5102:landing:retry-fail`,
      }).error?.code,
    ).toBe('SEND_FAILED')
  })
})

describe('charging.completed：保留机场路线上下文；直达切回由 Planner 显式发起', () => {
  it('补能完成后导航、航班与乘客上下文原样保留，UI 提示上下文保持（非自动恢复直达）', () => {
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
        props: expect.objectContaining({ recommended: false, reason: '补能完成，机场路线上下文保持' }),
      }),
    ])
  })

  it('charging.completed 不计划改线；Planner 可基于完成后状态显式切回直达机场路线', () => {
    // 自动改线不属于 reducer；当前契约下该事件不计划副作用。
    const registry = createProviderRegistry(createSideEffectRuntime())
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
    expect(completed.navigation?.routeId).toBe('route-airport-via-charge-001')

    // update-route only accepts routes previously planned for this task.
    const viaPlanned = registry['navigation.plan-route'](ctx, {
      origin: { latitude: 31.23, longitude: 121.47 },
      destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      via: [{ id: 'station-hongqiao-01', name: '虹桥超充站' }],
    })
    expect(viaPlanned.ok).toBe(true)
    expect(viaPlanned.data?.routeId).toBe('route-airport-via-charge-001')

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

describe('航班延误 / 取消：不触发落地通知，状态可投影', () => {
  it('延误更新 ETA 与航站楼，且不计划自动消息', () => {
    const preparing = drivingState({
      phase: 'preparing',
      navigation: undefined,
      taskRevision: 1,
      uiRevision: 1,
      flight: { flightNumber: 'MU5102', status: 'scheduled', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
      updatedAt: '2026-07-22T20:01:00+08:00',
    })
    const delayedEvent: AirportPickupEvent = {
      eventId: 'delayed-1',
      type: 'flight.updated',
      flight: { flightNumber: 'MU5102', status: 'delayed', estimatedArrival: '2026-07-22T21:10:00+08:00', terminal: 'T1' },
      timestamp: '2026-07-22T20:15:00+08:00',
    }
    expect(planEffects(preparing, delayedEvent, {})).toEqual([])
    const delayed = applyEvent(preparing, delayedEvent)
    expect(delayed.flight).toEqual(delayedEvent.flight)
    expect(delayed.message).toMatchObject({ status: 'idle', landingNoticeSent: false })
    expect(composePickupSpec(delayed).components).toEqual([
      expect.objectContaining({
        type: 'flight-status',
        props: expect.objectContaining({ status: 'delayed', terminal: 'T1' }),
      }),
    ])
  })

  it('取消航班不计划落地通知，任务保持 preparing', () => {
    const preparing = drivingState({
      phase: 'preparing',
      navigation: undefined,
      taskRevision: 1,
      uiRevision: 1,
      charging: { recommended: true, accepted: false, status: 'planned' },
      updatedAt: '2026-07-22T20:02:00+08:00',
    })
    const cancelledEvent: AirportPickupEvent = {
      eventId: 'cancelled-1',
      type: 'flight.updated',
      flight: { flightNumber: 'MU5102', status: 'cancelled', estimatedArrival: '2026-07-22T20:30:00+08:00', terminal: 'T2' },
      timestamp: '2026-07-22T20:08:00+08:00',
    }
    expect(planEffects(preparing, cancelledEvent, {})).toEqual([])
    const cancelled = applyEvent(preparing, cancelledEvent)
    expect(cancelled.phase).toBe('preparing')
    expect(cancelled.flight?.status).toBe('cancelled')
    expect(cancelled.message.status).toBe('idle')
    // 取消后再次落地推送也不应自动发消息（状态不是 landed）
    expect(planEffects(cancelled, landedEvent('landed-after-cancel', '2026-07-22T20:40:00+08:00'), {})).toEqual([])
  })
})

describe('message.cancelled：用户取消后本次落地不再自动调度', () => {
  it('message.status=cancelled 时后续落地推送不再计划发送', () => {
    const cancelledNotice = drivingState({
      flight: { flightNumber: 'MU5102', status: 'landed', estimatedArrival: '2026-07-22T20:40:00+08:00', terminal: 'T2' },
      message: {
        autoNotifyAuthorized: true,
        status: 'cancelled',
        landingNoticeSent: false,
        idempotencyKey: 'pickup-001:MU5102:landing',
      },
      updatedAt: '2026-07-22T20:41:00+08:00',
    })
    expect(planEffects(cancelledNotice, landedEvent('landed-after-cancel-notice', '2026-07-22T20:42:00+08:00'), {})).toEqual([])
    // reducer 对非 idle 状态也不会再次调度
    const after = applyEvent(cancelledNotice, landedEvent('landed-after-cancel-notice', '2026-07-22T20:42:00+08:00'))
    expect(after.message.status).toBe('cancelled')
    expect(after.message.landingNoticeSent).toBe(false)
  })
})

describe('路线拥堵改线与 plan-route 超时', () => {
  it('途中可通过外环 via 切到拥堵备选路线', () => {
    const registry = createProviderRegistry(createSideEffectRuntime())
    const active = drivingState()
    expect(
      registry['navigation.plan-route'](ctx, {
        origin: { latitude: 31.23, longitude: 121.47 },
        destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      }).ok,
    ).toBe(true)
    const bypassed = registry['navigation.update-route'](ctx, {
      routeId: active.navigation!.routeId,
      destination: { id: 'destination-hongqiao-t2', name: active.navigation!.destination },
      via: [{ id: 'via-ring-road-01', name: '外环快速路' }],
      idempotencyKey: `${active.taskId}:bypass-congestion`,
    })
    expect(bypassed.ok).toBe(true)
    expect(bypassed.data).toMatchObject({
      routeId: 'route-airport-bypass-001',
      destination: '虹桥机场 T2',
      status: 'active',
    })
  })

  it('destination-timeout 确定性触发 PROVIDER_TIMEOUT，可走降级卡片', () => {
    const first = planRoute(ctx, {
      origin: { latitude: 31.23, longitude: 121.47 },
      destination: { id: TIMEOUT_DESTINATION_ID, name: '超时目的地' },
    })
    const second = planRoute(ctx, {
      origin: { latitude: 31.23, longitude: 121.47 },
      destination: { id: TIMEOUT_DESTINATION_ID, name: '超时目的地' },
    })
    expect(first.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
    expect(second).toEqual(first)

    const state = drivingState()
    const timedOut = applyEvent(state, {
      eventId: 'route-timeout',
      type: 'provider.timeout',
      provider: 'navigation-provider',
      timestamp: '2026-07-22T20:36:00+08:00',
    })
    const spec = composeFallbackSpec(timedOut, '路线数据暂时不可用', '正在使用缓存路线或固定降级卡片。')
    expect(spec.meta.generatedBy).toBe('fallback')
    expect(spec.components[0]).toMatchObject({
      type: 'status-banner',
      props: expect.objectContaining({ level: 'warning', title: '路线数据暂时不可用' }),
    })
  })

  it('navigation.update-route 透传 destination-timeout 的 retryable', () => {
    const registry = createProviderRegistry(createSideEffectRuntime())
    expect(
      registry['navigation.plan-route'](ctx, {
        origin: { latitude: 31.23, longitude: 121.47 },
        destination: { id: 'destination-hongqiao-t2', name: '虹桥机场 T2' },
      }).ok,
    ).toBe(true)
    const updated = registry['navigation.update-route'](ctx, {
      routeId: 'route-airport-001',
      destination: { id: TIMEOUT_DESTINATION_ID, name: '超时目的地' },
      idempotencyKey: 'pickup-001:update-timeout',
    })
    expect(updated.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
  })
})

describe('provider.timeout（MU0000）：Agent / UI 降级路径', () => {
  it('MU0000 确定性触发 PROVIDER_TIMEOUT 且可重试', () => {
    const first = getFlightStatus(ctx, { flightNumber: 'MU0000', date: '2026-07-22' })
    const second = getFlightStatus(ctx, { flightNumber: 'MU0000', date: '2026-07-22' })
    expect(first.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
    expect(second).toEqual(first)
  })

  it('超时事件只标记已处理，不改动任务事实；composer 入口可切到警示降级卡片', () => {
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

    // 生产入口是 composePickupSpec + fallback context，不是直接调用 composeFallbackSpec
    const spec = composePickupSpec(timedOut, {
      fallback: { title: '航班数据暂时不可用', message: '正在使用最近缓存，可稍后重试。', level: 'warning' },
    })
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
