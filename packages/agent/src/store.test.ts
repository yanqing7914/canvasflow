import { describe, expect, it } from 'vitest'
import type { CreateTaskRequest } from '@canvasflow/schema'
import { AgentGateway } from './gateway'
import { MemoryTaskStore } from './store'

const now = '2026-07-22T12:00:00+08:00'

function request(clientRequestId: string): CreateTaskRequest {
  return {
    clientRequestId,
    input: { type: 'text', text: '接妈妈，航班 MU5102' },
    vehicleContext: { speedKph: 0, batteryPercent: 42, remainingRangeKm: 210, gear: 'P', isNight: true },
    clientCapabilities: { uiSchemaVersion: '1.0', supportsSse: true, supportsTts: true },
  }
}

describe('MemoryTaskStore task updates', () => {
  it('publishes only public snapshots with isolated monotonic task cursors', () => {
    const store = new MemoryTaskStore()
    let id = 0
    const gateway = new AgentGateway({ store, now: () => now, createId: () => String(++id) })
    const first = gateway.createTask(request('first'))
    const second = gateway.createTask(request('second'))

    const firstUpdate = gateway.getTaskUpdates(first.task.taskId).updates[0]!
    expect(firstUpdate).toMatchObject({ type: 'task.updated', cursor: 1, taskId: first.task.taskId })
    expect(firstUpdate.snapshot).toEqual({ task: first.task, ui: first.ui })
    expect(JSON.stringify(firstUpdate)).not.toContain('toolResults')
    expect(JSON.stringify(firstUpdate)).not.toContain('requestContext')
    expect(gateway.getTaskUpdates(second.task.taskId).updates[0]?.cursor).toBe(1)
    expect(gateway.getTaskUpdates(first.task.taskId, 1).updates).toEqual([])
  })

  it('emits context-only UI changes once and suppresses retries and rejected no-ops', () => {
    const store = new MemoryTaskStore()
    const gateway = new AgentGateway({ store, now: () => now, createId: () => 'updates' })
    const created = gateway.createTask(request('create'))
    const movingRequest = {
      clientRequestId: 'moving', expectedTaskRevision: created.task.taskRevision,
      event: { eventId: 'moving', type: 'vehicle.moving' as const, speedKph: 80, timestamp: '2026-07-22T12:01:00+08:00' },
    }
    const moving = gateway.submitEvent(created.task.taskId, movingRequest)
    expect(moving.task.taskRevision).toBe(created.task.taskRevision)
    expect(moving.ui.presentation.density).toBe('minimal')
    expect(gateway.getTaskUpdates(created.task.taskId, 1).updates.map((update) => update.cursor)).toEqual([2])

    gateway.submitEvent(created.task.taskId, { ...movingRequest, clientRequestId: 'moving-retry' })
    gateway.submitEvent(created.task.taskId, {
      clientRequestId: 'ignored', expectedTaskRevision: moving.task.taskRevision,
      event: { eventId: 'ignored', type: 'destination.arrived', destination: '家', timestamp: '2026-07-22T12:02:00+08:00' },
    })
    expect(gateway.getTaskUpdates(created.task.taskId, 2).updates).toEqual([])
  })

  it('retains cursor history through cancellation/reset and resyncs stale cursors without partial replay', () => {
    const store = new MemoryTaskStore({ maxTaskUpdatesPerTask: 2 })
    const gateway = new AgentGateway({ store, now: () => now, createId: () => 'retained' })
    const created = gateway.createTask(request('create'))
    const cancelled = gateway.cancelTask(created.task.taskId, {
      clientRequestId: 'cancel', expectedTaskRevision: created.task.taskRevision, eventId: 'cancel',
    })
    const reset = gateway.resetTask(created.task.taskId, {
      clientRequestId: 'reset', expectedTaskRevision: cancelled.task.taskRevision,
    })

    expect(gateway.getTaskUpdates(created.task.taskId, 2).updates).toEqual([
      expect.objectContaining({ cursor: 3, snapshot: expect.objectContaining({ task: reset.task }) }),
    ])
    expect(gateway.getTaskUpdates(created.task.taskId, 0)).toMatchObject({
      latestCursor: 3, staleCursor: true, updates: [expect.objectContaining({ cursor: 3 })],
    })
    expect(gateway.resetTask(created.task.taskId, {
      clientRequestId: 'reset', expectedTaskRevision: cancelled.task.taskRevision,
    }).task).toEqual(reset.task)
    expect(gateway.getTaskUpdates(created.task.taskId, 3).updates).toEqual([])
  })
})
