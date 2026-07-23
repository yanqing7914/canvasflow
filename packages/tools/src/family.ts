import {
  resolveMembersInputSchema,
  resolveMembersOutputSchema,
  type ResolveMembersOutput,
  type ToolResult,
} from '@canvasflow/schema'
import { familyMembers } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'family.resolve-members'

export function resolveMembers(ctx: ToolContext, input: unknown): ToolResult<ResolveMembersOutput> {
  const parsed = resolveMembersInputSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', 'labels 必须是非空字符串数组', false)
  }

  const members: ResolveMembersOutput['members'] = []
  const unresolvedLabels: string[] = []
  for (const label of parsed.data.labels) {
    const match = familyMembers.find((member) => member.labels.includes(label))
    if (match) {
      members.push({ memberId: match.memberId, displayName: match.displayName, contactId: match.contactId })
    } else {
      unresolvedLabels.push(label)
    }
  }

  if (members.length === 0) {
    return errorResult(ctx, TOOL, 'MEMBER_NOT_FOUND', `无法解析家庭成员：${unresolvedLabels.join('、')}`, false)
  }
  return okResult(ctx, TOOL, resolveMembersOutputSchema.parse({ members, unresolvedLabels }))
}
