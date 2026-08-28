/**
 * Frame move, mirror, offset, and reach-envelope helpers.
 * Ported from `kinematics/transform.py`.
 */

import {
  AR2010_REACH_MM,
  HOME_PULSES,
  defaultParams,
  defaultTool,
  forwardKinematics,
  type Ar2010Params
} from "./fk"
import { inverseKinematics, type IkResult } from "./ik"
import {
  composePoses,
  identity4,
  matrixToPose,
  multiply3,
  poseToMatrix,
  relativePose,
  rotationOf,
  type Mat3
} from "./pose"
import type { CartesianPose, MirrorPlane } from "./types"

export interface ReachCheck {
  horizontalMm: number
  radialMm: number
  withinReach: boolean
  heuristic: string
}

/** Identity on pose values — caller relabels ///USER. */
export const frameMove = (
  pose: CartesianPose,
  _sourceFrameId: number,
  _targetFrameId: number
): CartesianPose => ({ ...pose })

export const pulsesInUserFrame = (
  pulses: readonly number[],
  sourceFrame: CartesianPose,
  options: { tool?: CartesianPose | null; params?: Ar2010Params } = {}
): CartesianPose => {
  const result = forwardKinematics(pulses, {
    tool: options.tool === undefined ? defaultTool() : options.tool,
    params: options.params ?? defaultParams()
  })
  return relativePose(result.pose, sourceFrame)
}

export const transformFramePulses = (args: {
  pulses: readonly (readonly number[])[]
  sourceFrame: CartesianPose
  sourceFrameId: number
  targetFrameId: number
  tool?: CartesianPose | null
  params?: Ar2010Params
}): { poses: CartesianPose[]; targetFrameId: number } => {
  const poses = args.pulses.map((row) => {
    const relative = pulsesInUserFrame(row, args.sourceFrame, {
      tool: args.tool,
      params: args.params
    })
    return frameMove(relative, args.sourceFrameId, args.targetFrameId)
  })
  return { poses, targetFrameId: args.targetFrameId }
}

const reflectForPlane = (plane: MirrorPlane): Mat3 => {
  if (plane === "XZ") {
    return [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, 1]
    ]
  }
  if (plane === "YZ") {
    return [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ]
  }
  if (plane === "XY") {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1]
    ]
  }
  throw new Error(`unsupported mirror plane: ${plane}`)
}

export const mirrorPose = (
  pose: CartesianPose,
  plane: MirrorPlane
): { pose: CartesianPose; rconfReviewRequired: true } => {
  const reflect = reflectForPlane(plane)
  const matrix = poseToMatrix(pose)
  const rotation = rotationOf(matrix)
  const origin: [number, number, number] = [matrix[0][3], matrix[1][3], matrix[2][3]]
  const mirrored = identity4()
  const mid = multiply3(reflect, multiply3(rotation, reflect))
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      mirrored[row][col] = mid[row][col]
    }
    mirrored[row][3] =
      reflect[row][0] * origin[0] + reflect[row][1] * origin[1] + reflect[row][2] * origin[2]
  }
  return { pose: matrixToPose(mirrored), rconfReviewRequired: true }
}

export const transformMirrorPoses = (
  poses: readonly CartesianPose[],
  plane: MirrorPlane
): { poses: CartesianPose[]; rconfReviewRequired: true } => ({
  poses: poses.map((pose) => mirrorPose(pose, plane).pose),
  rconfReviewRequired: true
})

export interface MirrorPointResult {
  index: number
  pose: CartesianPose
  ik: IkResult
}

const pulsesInUf = (
  pulseRows: readonly (readonly number[])[],
  userFrame: CartesianPose,
  tool: CartesianPose | null | undefined,
  params: Ar2010Params | undefined
): CartesianPose[] => {
  const tcp = tool ?? defaultTool()
  const model = params ?? defaultParams()
  return pulseRows.map((row) => {
    const result = forwardKinematics(row, { tool: tcp, params: model })
    return relativePose(result.pose, userFrame)
  })
}

/**
 * Same-UF plane mirror with per-point IK for RCONF + reach/limits gating.
 * Mirrors the station-flip safety pattern without changing C/P identity
 * (callers emit vars; this only returns poses + IK).
 */
export const applyMirrorWithIk = (args: {
  sourcePulses?: readonly (readonly number[])[]
  sourcePoses?: readonly CartesianPose[] | null
  plane: MirrorPlane
  uf: CartesianPose
  tool?: CartesianPose | null
  params?: Ar2010Params
  pulseLimitsPos?: readonly number[]
  pulseLimitsNeg?: readonly number[]
}): MirrorPointResult[] => {
  const tcp = args.tool ?? defaultTool()
  const model = args.params ?? defaultParams()
  const ufPoses =
    args.sourcePoses && args.sourcePoses.length
      ? [...args.sourcePoses]
      : pulsesInUf(args.sourcePulses ?? [], args.uf, tcp, model)
  const seeds = args.sourcePulses ? [...args.sourcePulses] : []
  const results: MirrorPointResult[] = []
  for (let index = 0; index < ufPoses.length; index += 1) {
    const mirroredUf = mirrorPose(ufPoses[index], args.plane).pose
    const targetBase = composePoses(args.uf, mirroredUf)
    let seed: readonly number[]
    if (index < seeds.length && seeds[index].length >= 6) {
      seed = seeds[index]
    } else {
      const origBase = composePoses(args.uf, ufPoses[index])
      const seedIk = inverseKinematics(origBase, HOME_PULSES, {
        tool: tcp,
        params: model,
        pulseLimitsPos: args.pulseLimitsPos,
        pulseLimitsNeg: args.pulseLimitsNeg
      })
      seed = seedIk.reachable ? seedIk.pulses : HOME_PULSES
    }
    const ikResult = inverseKinematics(targetBase, seed, {
      tool: tcp,
      params: model,
      pulseLimitsPos: args.pulseLimitsPos,
      pulseLimitsNeg: args.pulseLimitsNeg
    })
    results.push({ index, pose: mirroredUf, ik: ikResult })
  }
  return results
}

export const applyMirrorToWire = (points: MirrorPointResult[], retainedUserFrameId: number) => {
  const failed = points.filter((p) => !p.ik.reachable)
  return {
    poses: points.map((p) => p.pose),
    points: points.map((p) => ({
      index: p.index,
      pose: p.pose,
      pulses: p.ik.pulses,
      degrees: p.ik.degrees,
      reachable: p.ik.reachable,
      withinLimits: p.ik.withinLimits,
      positionErrorMm: p.ik.positionErrorMm,
      orientationErrorDeg: p.ik.orientationErrorDeg,
      rconf: p.ik.rconf,
      rconfText: p.ik.rconfText,
      message: p.ik.message,
      limitViolations: p.ik.limitViolations
    })),
    retainedUserFrameId,
    saveBlocked: failed.length > 0,
    reachableCount: points.length - failed.length,
    failedCount: failed.length
  }
}

export const offsetPose = (
  pose: CartesianPose,
  dxyz: readonly [number, number, number],
  drpy: readonly [number, number, number]
): CartesianPose => {
  const translated: CartesianPose = {
    x: pose.x + dxyz[0],
    y: pose.y + dxyz[1],
    z: pose.z + dxyz[2],
    rx: pose.rx,
    ry: pose.ry,
    rz: pose.rz
  }
  if (
    Math.abs(drpy[0]) < 1e-15 &&
    Math.abs(drpy[1]) < 1e-15 &&
    Math.abs(drpy[2]) < 1e-15
  ) {
    return translated
  }
  const matrix = poseToMatrix(translated)
  const deltaRot = rotationOf(
    poseToMatrix({ x: 0, y: 0, z: 0, rx: drpy[0], ry: drpy[1], rz: drpy[2] })
  )
  const rotated = multiply3(deltaRot, rotationOf(matrix))
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      matrix[row][col] = rotated[row][col]
    }
  }
  return matrixToPose(matrix)
}

export const offsetByPose = (pose: CartesianPose, delta: CartesianPose): CartesianPose =>
  offsetPose(pose, [delta.x, delta.y, delta.z], [delta.rx, delta.ry, delta.rz])

export const transformOffsetPoses = (
  poses: readonly CartesianPose[],
  delta: CartesianPose
): { poses: CartesianPose[] } => ({
  poses: poses.map((pose) => offsetByPose(pose, delta))
})

export const reachEnvelope = (
  pose: CartesianPose,
  reachMm: number = AR2010_REACH_MM
): ReachCheck => {
  const horizontal = Math.hypot(pose.x, pose.y)
  const radial = Math.sqrt(pose.x * pose.x + pose.y * pose.y + pose.z * pose.z)
  const within = horizontal <= reachMm
  return {
    horizontalMm: horizontal,
    radialMm: radial,
    withinReach: within,
    heuristic:
      `Horizontal distance ${horizontal.toFixed(1)} mm vs AR2010 reach ${reachMm.toFixed(0)} mm ` +
      "(heuristic only; joint limits are not checked)"
  }
}
