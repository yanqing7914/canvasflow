import {
  getPreferencesInputSchema,
  getPreferencesOutputSchema,
  type GetPreferencesOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { memberPreferences } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'memory.get-preferences'

export function getPreferences(ctx: ToolContext, input: unknown): ToolResult<GetPreferencesOutput> {
  const parsed = getPreferencesInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', 'memberIds 与 scopes 必须是非空数组', false)
  }

  const { memberIds, scopes } = parsed.data
  const unknownIds = memberIds.filter((memberId) => !(memberId in memberPreferences))
  if (unknownIds.length > 0) {
    return errorResult(ctx, TOOL, 'PREFERENCE_UNAVAILABLE', `无可用偏好：${unknownIds.join('、')}`, false)
  }

  const members: GetPreferencesOutput['members'] = memberIds.map((memberId) => {
    const record = memberPreferences[memberId]
    return {
      memberId,
      rearTemperatureC: scopes.includes('cabin') ? record.rearTemperatureC : undefined,
      mediaTitle: scopes.includes('media') ? record.mediaTitle : undefined,
      homeDestinationId: scopes.includes('address') ? record.homeDestinationId : undefined,
      landingNotificationAuthorized: record.landingNotificationAuthorized,
    }
  })
  return okResult(ctx, TOOL, getPreferencesOutputSchema.parse({ members }))
}
