/**
 * User-frame convert / Flip — homogeneous transform between USER frames.
 * Ported from `kinematics/frame_flip.py` (math core only; JBI rewrite stays in the shell).
 *
 *   P_new = inv(UF_new) @ UF_old @ P_old
 *   optional tool Z 180°: P_final = P_new @ diag(-1,-1,1)
 */

import {
  identity4,
  invertTransform,
  matrixToPose,
  multiply4,
  poseToMatrix,
  type Mat4
} from "./pose"
import type { CartesianPose } from "./types"

const TOOL_Z_FLIP: Mat4 = [
  [-1, 0, 0, 0],
  [0, -1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1]
]

export const toolZFlipMatrix = (): Mat4 => [
  [...TOOL_Z_FLIP[0]],
  [...TOOL_Z_FLIP[1]],
  [...TOOL_Z_FLIP[2]],
  [...TOOL_Z_FLIP[3]]
]

export const convertPose = (
  pose: CartesianPose,
  ufOld: CartesianPose,
  ufNew: CartesianPose,
  options: { applyToolZFlip?: boolean } = {}
): CartesianPose => {
  const applyToolZFlip = options.applyToolZFlip !== false
  let out = multiply4(
    multiply4(invertTransform(poseToMatrix(ufNew)), poseToMatrix(ufOld)),
    poseToMatrix(pose)
  )
  if (applyToolZFlip) {
    out = multiply4(out, TOOL_Z_FLIP)
  }
  return matrixToPose(out)
}

export const convertPoses = (
  poses: readonly CartesianPose[],
  ufOld: CartesianPose,
  ufNew: CartesianPose,
  options: { applyToolZFlip?: boolean } = {}
): CartesianPose[] =>
  poses.map((pose) => convertPose(pose, ufOld, ufNew, options))

export const transformFrameFlipPoses = (args: {
  poses: readonly CartesianPose[]
  sourceUf: CartesianPose
  targetUf: CartesianPose
  targetFrameId?: number | null
  applyToolZFlip?: boolean
}): {
  poses: CartesianPose[]
  targetFrameId: number | null
  applyToolZFlip: boolean
  sourceUf: CartesianPose
  targetUf: CartesianPose
} => {
  const applyToolZFlip = args.applyToolZFlip !== false
  return {
    poses: convertPoses(args.poses, args.sourceUf, args.targetUf, { applyToolZFlip }),
    targetFrameId: args.targetFrameId ?? null,
    applyToolZFlip,
    sourceUf: { ...args.sourceUf },
    targetUf: { ...args.targetUf }
  }
}

export const formatPoseCoords = (
  pose: CartesianPose,
  xyzDigits = 3,
  rpyDigits = 4
): string => {
  const vals = [pose.x, pose.y, pose.z, pose.rx, pose.ry, pose.rz]
  return vals
    .map((value, index) => value.toFixed(index < 3 ? xyzDigits : rpyDigits))
    .join(",")
}

/** Identity helper kept for callers that need a fresh 4x4. */
export const emptyHomogeneous = (): Mat4 => identity4()
