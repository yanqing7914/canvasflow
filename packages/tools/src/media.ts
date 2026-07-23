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

    const cached = runtime.idempotency.get<MediaPlayOutput>(TOOL, parsed.data.idempotencyKey, parsed.data)
    if (cached.kind === 'hit') return cached.result
    if (cached.kind === 'conflict') {
      return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '同一 idempotencyKey 已被不同请求参数使用', false)
    }

    if (!AVAILABLE_MEDIA_TITLES.has(parsed.data.mediaTitle)) {
      return errorResult(ctx, TOOL, 'MEDIA_UNAVAILABLE', `媒体不可用：${parsed.data.mediaTitle}`, false)
    }

    // sourceMemberId 表示"以某成员的偏好为依据播放"，必须与该成员存储的偏好一致。
    if (parsed.data.sourceMemberId !== undefined) {
      if (
        !Object.hasOwn(runtime.preferences, parsed.data.sourceMemberId) ||
        runtime.preferences[parsed.data.sourceMemberId].mediaTitle !== parsed.data.mediaTitle
      ) {
        return errorResult(
          ctx,
          TOOL,
          'POLICY_DENIED',
          `成员 ${parsed.data.sourceMemberId} 未授权播放：${parsed.data.mediaTitle}`,
          false,
        )
      }
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
    runtime.idempotency.set(TOOL, parsed.data.idempotencyKey, parsed.data, result)
    return result
  }
}
