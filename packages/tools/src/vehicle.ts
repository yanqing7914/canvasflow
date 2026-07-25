import { vehicleStatusOutputSchema, type ToolResult, type VehicleStatusOutput } from '@canvasflow/schema'
import { z } from 'zod'
import { DEFAULT_VEHICLE_SNAPSHOT, vehicleSnapshots, type VehicleSnapshotName } from './data'
import { errorResult, okResult, type ToolContext } from './result'

const TOOL = 'vehicle.get-status'

/**
 * Fixture-only control: lets Agent and demo pick a speed/battery/night preset
 * to exercise UI density rules. The tool contract itself has no input; a live
 * provider would ignore this and read the real vehicle state.
 */
const vehicleStatusControlSchema = z
  .union([
    z.object({ snapshot: z.string().min(1) }),
    z.object({
      context: vehicleStatusOutputSchema.omit({ rearOccupied: true }).extend({ rearOccupied: z.boolean().optional() }),
    }),
  ])
  .optional()

export function getVehicleStatus(ctx: ToolContext, input?: unknown): ToolResult<VehicleStatusOutput> {
  const parsed = vehicleStatusControlSchema.safeParse(input)
  if (!parsed.success) {
    return errorResult(ctx, TOOL, 'INVALID_ARGUMENT', '需要有效的车辆快照名称或车辆上下文', false)
  }

  if (parsed.data && 'context' in parsed.data) {
    return okResult(ctx, TOOL, vehicleStatusOutputSchema.parse({ ...parsed.data.context, rearOccupied: parsed.data.context.rearOccupied ?? false }))
  }

  const snapshotName = parsed.data?.snapshot ?? DEFAULT_VEHICLE_SNAPSHOT
  if (!Object.hasOwn(vehicleSnapshots, snapshotName)) {
    return errorResult(ctx, TOOL, 'VEHICLE_STATE_UNAVAILABLE', `未知车辆状态快照：${snapshotName}`, false)
  }
  return okResult(ctx, TOOL, vehicleStatusOutputSchema.parse(vehicleSnapshots[snapshotName as VehicleSnapshotName]))
}
