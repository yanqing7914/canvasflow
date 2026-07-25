import { taskUpdateEnvelopeSchema, type TaskUpdateEnvelope } from '@canvasflow/schema'
import type { StoredTask } from './store'

export function createTaskUpdate(stored: StoredTask, cursor: number): TaskUpdateEnvelope {
  return taskUpdateEnvelopeSchema.parse({
    type: 'task.updated',
    cursor,
    taskId: stored.task.taskId,
    snapshot: { task: stored.task, ui: stored.ui },
  })
}
