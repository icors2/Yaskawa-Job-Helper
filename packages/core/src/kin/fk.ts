/**
 * MOTOMAN AR2010 forward kinematics, ported from `kinematics/ar2010.py`.
 *
 * The chain matches ros-industrial/motoman `ar2010_macro.xacro` (kinetic-devel),
 * expressed in the manufacturer BASE frame (S/L intersection, not the floor).
 *
 * RC.PRM ///RC1G row 1 stores a1/a2/a3/d4 in microns (150/760/200/1082 mm).
 * Row 2 stores d6 = 100 mm. Floor-to-S height 505 mm is ROS base_link only.
 *
 * Pulse-per-degree seeds come from RC.PRM pulse limits divided by the motion
 * range on this controller (S/L/U from the US datasheet, R/B/T from the
 * expanded wrist ranges that make those limits consistent: ±200 / ±150 / ±455).
 */

import {
  DEG_TO_RAD,
  identity4,
  invertTransform,
  matrixToPose,
  multiply4,
  poseFromXyzRpy,
  poseToMatrix,
  rotZ4,
  transform,
  type Mat4
} from "./pose"
import type { CartesianPose } from "./types"

export const AXIS_NAMES = ["s", "l", "u", "r", "b", "t"] as const

export type AxisName = (typeof AXIS_NAMES)[number]

export type SixTuple = [number, number, number, number, number, number]

export const AR2010_REACH_MM = 2010
export const AR2010_BASE_HEIGHT_MM = 505

/** RC.PRM ///RC1G pulse soft-limits (lines 118-119 of the DYNAMIC1 backup). */
export const RC_PRM_PULSE_LIMITS_POS: SixTuple = [
  241449, 295690, 254863, 204573, 147036, 206914
]
export const RC_PRM_PULSE_LIMITS_NEG: SixTuple = [
  -241449, -200306, -136989, -204573, -147036, -206914
]

/**
 * Degree ranges that make those pulse limits a constant pulses/deg per axis.
 * S/L/U match the published AR2010 sheet. R/B/T match the expanded (EU) wrist.
 */
export const RC_PRM_DEGREE_RANGES_POS: SixTuple = [180, 155, 160, 200, 150, 455]
export const RC_PRM_DEGREE_RANGES_NEG: SixTuple = [-180, -105, -86, -200, -150, -455]

export const DEFAULT_TOOL0: SixTuple = [-88.687, 0.981, 463.147, 0, -45, 0]
export const HOME_PULSES: SixTuple = [0, -75310, 1200, 0, -127658, -70]
export const HOME_CARTESIAN: SixTuple = [275, 0, 875, 180, 45, 0]

export interface Ar2010Params {
  /** Geometric link lengths in mm. */
  a1: number
  a2: number
  a3: number
  d4: number
  d6: number
  d1: number
  pulsePerDegree: SixTuple
  pulseOffsets: SixTuple
  reachMm: number
}

export interface KinematicResult {
  pose: CartesianPose
  flange: CartesianPose
  degrees: SixTuple
  matrix: Mat4
  flangeMatrix: Mat4
}

export const seedPulsePerDegree = (): SixTuple =>
  RC_PRM_PULSE_LIMITS_POS.map((limit, index) =>
    Math.abs(limit) / Math.abs(RC_PRM_DEGREE_RANGES_POS[index])
  ) as SixTuple

export const defaultParams = (): Ar2010Params => ({
  a1: 150,
  a2: 760,
  a3: 200,
  d4: 1082,
  d6: 100,
  d1: 0,
  pulsePerDegree: seedPulsePerDegree(),
  pulseOffsets: [0, 0, 0, 0, 0, 0],
  reachMm: AR2010_REACH_MM
})

export const defaultTool = (): CartesianPose => poseFromXyzRpy(DEFAULT_TOOL0)

/** Flatten params to the sidecar's `parameters` record. */
export const paramsToRecord = (params: Ar2010Params): Record<string, number> => {
  const values: Record<string, number> = {
    a1: params.a1,
    a2: params.a2,
    a3: params.a3,
    d4: params.d4,
    d6: params.d6,
    d1: params.d1,
    reach_mm: params.reachMm
  }
  AXIS_NAMES.forEach((name, index) => {
    values[`pulse_per_degree_${name}`] = params.pulsePerDegree[index]
    values[`pulse_offset_${name}`] = params.pulseOffsets[index]
  })
  return values
}

export const paramsFromRecord = (data: Record<string, number>): Ar2010Params => {
  const params = defaultParams()
  const scalars = ["a1", "a2", "a3", "d4", "d6", "d1"] as const
  for (const key of scalars) {
    if (key in data) {
      params[key] = Number(data[key])
    }
  }
  if ("reach_mm" in data) {
    params.reachMm = Number(data.reach_mm)
  }
  AXIS_NAMES.forEach((name, index) => {
    const ppdKey = `pulse_per_degree_${name}`
    const offsetKey = `pulse_offset_${name}`
    if (ppdKey in data) {
      params.pulsePerDegree[index] = Number(data[ppdKey])
    }
    if (offsetKey in data) {
      params.pulseOffsets[index] = Number(data[offsetKey])
    }
  })
  return params
}

const asSix = (values: readonly number[], label: string): SixTuple => {
  if (values.length < 6) {
    throw new Error(`${label} needs at least 6 values`)
  }
  return [values[0], values[1], values[2], values[3], values[4], values[5]]
}

export const pulsesToDegrees = (
  pulses: readonly number[],
  params: Ar2010Params = defaultParams()
): SixTuple => {
  const raw = asSix(pulses, "pulses")
  if (params.pulsePerDegree.some((scale) => Math.abs(scale) < 1e-9)) {
    throw new Error("pulsePerDegree contains a zero scale")
  }
  return raw.map(
    (value, index) => (value - params.pulseOffsets[index]) / params.pulsePerDegree[index]
  ) as SixTuple
}

const HALF_PI = Math.PI / 2

const flangeMatrixOf = (degrees: readonly number[], params: Ar2010Params): Mat4 => {
  const joints = asSix(degrees, "degrees")
  const origins: Mat4[] = [
    transform([0, 0, params.d1], [0, 0, 0]),
    transform([params.a1, 0, 0], [HALF_PI, -HALF_PI, -Math.PI]),
    transform([params.a2, 0, 0], [Math.PI, 0, 0]),
    transform([params.a3, -params.d4, 0], [-HALF_PI, 0, 0]),
    transform([0, 0, 0], [HALF_PI, 0, 0]),
    transform([0, -params.d6, 0], [-HALF_PI, 0, 0])
  ]
  const flange = transform([0, 0, 0], [0, HALF_PI, 0])
  const tool0 = transform([0, 0, 0], [Math.PI, -HALF_PI, 0])
  let world = identity4()
  for (let index = 0; index < 6; index += 1) {
    world = multiply4(multiply4(world, origins[index]), rotZ4(joints[index] * DEG_TO_RAD))
  }
  return multiply4(multiply4(world, flange), tool0)
}

export const forwardKinematics = (
  pulses: readonly number[],
  options: {
    tool?: CartesianPose | null
    params?: Ar2010Params
    userFrame?: CartesianPose | null
  } = {}
): KinematicResult => {
  const params = options.params ?? defaultParams()
  const degrees = pulsesToDegrees(pulses, params)
  let flangeMatrix = flangeMatrixOf(degrees, params)
  let tcpMatrix = options.tool
    ? multiply4(flangeMatrix, poseToMatrix(options.tool))
    : flangeMatrix
  if (options.userFrame) {
    const frameInv = invertTransform(poseToMatrix(options.userFrame))
    flangeMatrix = multiply4(frameInv, flangeMatrix)
    tcpMatrix = multiply4(frameInv, tcpMatrix)
  }
  return {
    pose: matrixToPose(tcpMatrix),
    flange: matrixToPose(flangeMatrix),
    degrees,
    matrix: tcpMatrix,
    flangeMatrix
  }
}

/** Convenience FK returning XYZ + RPY degrees (tool defaults to TOOL 0). */
export const fkPulse = (
  pulses: readonly number[],
  toolXyzRpy?: readonly number[] | null,
  params?: Ar2010Params
): CartesianPose =>
  forwardKinematics(pulses, {
    tool: toolXyzRpy ? poseFromXyzRpy(toolXyzRpy) : defaultTool(),
    params
  }).pose
