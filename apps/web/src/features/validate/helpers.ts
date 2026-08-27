import { defaultParams, defaultTool } from "@yaskawa/core/kin/fk"
import { paramsFromProfileFields } from "@yaskawa/core/kin/ik"
import type { CartesianPose } from "@yaskawa/core/kin/types"
import {
  getActiveProfile,
  type RobotProfile
} from "../../lib/profile"

export { getActiveProfile }

export const paramsFromProfileReady = (profile: RobotProfile | null | undefined) => {
  if (!profile) {
    return { params: defaultParams(), tool: defaultTool() as CartesianPose }
  }
  return {
    params: paramsFromProfileFields({
      linkLengthsMm: profile.linkLengthsMm,
      pulsePerDeg: profile.pulsePerDeg,
      pulseOffsets: profile.pulseOffsets
    }),
    tool: (profile.tool0 ?? defaultTool()) as CartesianPose
  }
}
