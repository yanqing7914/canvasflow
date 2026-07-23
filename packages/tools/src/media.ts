import {
  mediaPlayInputSchema,
  mediaPlayOutputSchema,
  type MediaPlayOutput,
  type ToolResult,
} from '@canvasflow/schema'
import type { SideEffectRuntime } from './idempotency'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'media.play'

export const AVAILABLE_MEDIA_TITLES = new Set(['豆豆故事', '轻音乐'])

export function createMediaPlayer(runtime: SideEffectRuntime) {
  return function playMedia(ctx: ToolContext, input: unknown): ToolResult<MediaPlayOutput> {
    const parsed = mediaPlayInputSchema.safeParse(input)
    if (!parsed.success) {
      return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要 mediaTitle 和 idempotencyKey', false)
    }

    const cached = runtime.idempotency.get<MediaPlayOutput>(parsed.data.idempotencyKey)
    if (cached) return cached

    if (!AVAILABLE_MEDIA_TITLES.has(parsed.data.mediaTitle)) {
      return errorResult(ctx, TOOL, 'MEDIA_UNAVAILABLE', `媒体不可用：${parsed.data.mediaTitle}`, false)
    }

    const result = okResult(
      ctx,
      TOOL,
      mediaPlayOutputSchema.parse({
        playbackId: `${ctx.taskId}:media:${parsed.data.mediaTitle}`,
        title: parsed.data.mediaTitle,
        status: 'playing',
        reversible: true,
      }),
    )
    runtime.idempotency.set(parsed.data.idempotencyKey, result)
    return result
  }
}
