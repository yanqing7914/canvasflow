import type { ProviderMode, ToolResult } from '@canvasflow/schema'

/** Fixed timestamp so fixture results are byte-for-byte reproducible. */
export const FIXTURE_GENERATED_AT = '2026-07-22T12:00:00+08:00'

export type ToolContext = {
  taskId: string
  requestId?: string
  provider?: ProviderMode
}

function buildMeta(ctx: ToolContext, tool: string) {
  return {
    requestId: ctx.requestId ?? `${ctx.taskId}:${tool}`,
    taskId: ctx.taskId,
    tool,
    provider: ctx.provider ?? ('fixture' as const),
    durationMs: 1,
    generatedAt: FIXTURE_GENERATED_AT,
  }
}

export function okResult<T>(ctx: ToolContext, tool: string, data: T): ToolResult<T> {
  return { ok: true, data, error: null, meta: buildMeta(ctx, tool) }
}

export function errorResult<T>(
  ctx: ToolContext,
  tool: string,
  code: string,
  message: string,
  retryable: boolean,
): ToolResult<T> {
  return { ok: false, data: null, error: { code, message, retryable }, meta: buildMeta(ctx, tool) }
}
