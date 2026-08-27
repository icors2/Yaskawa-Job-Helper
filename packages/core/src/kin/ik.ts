/**
 * Numeric inverse kinematics, joint-limit checks, and ///RCONF derivation.
 * Ported from `kinematics/ik.py`.
 */

import {
  AXIS_NAMES,
  RC_PRM_PULSE_LIMITS_NEG,
  RC_PRM_PULSE_LIMITS_POS,
  defaultParams,
  defaultTool,
  forwardKinematics,
  pulsesToDegrees,
  type Ar2010Params,
  type SixTuple
} from "./fk"
import { DEG_TO_RAD, poseToMatrix, rotationGeodesicDeg, rotationOf, type Mat4 } from "./pose"
import { leastSquaresLm } from "./solve/lm"
import type { CartesianPose } from "./types"

export const RCONF_LENGTH = 24
export const IK_POSITION_TOL_MM = 1.0
export const IK_ROUNDTRIP_TOL_MM = 0.1
export const ORIENT_WEIGHT = 80.0

export interface IkResult {
  pulses: number[]
  degrees: number[]
  pose: CartesianPose
  reachable: boolean
  withinLimits: boolean
  positionErrorMm: number
  orientationErrorDeg: number
  rconf: number[]
  rconfText: string
  message: string
  limitViolations: string[]
}

export const ikResultToDict = (result: IkResult): Record<string, unknown> => ({
  pulses: result.pulses.map(Number),
  degrees: result.degrees.map(Number),
  pose: { ...result.pose },
  reachable: result.reachable,
  withinLimits: result.withinLimits,
  positionErrorMm: result.positionErrorMm,
  orientationErrorDeg: result.orientationErrorDeg,
  rconf: result.rconf.map((v) => Math.trunc(v)),
  rconfText: result.rconfText,
  message: result.message,
  limitViolations: [...result.limitViolations]
})

export const degreesToPulses = (
  degrees: readonly number[],
  params: Ar2010Params = defaultParams()
): number[] => {
  const raw = [...degrees].slice(0, 6)
  while (raw.length < 6) {
    raw.push(0)
  }
  return raw.map(
    (value, index) => value * params.pulsePerDegree[index] + params.pulseOffsets[index]
  )
}

export const formatRconf = (bits: readonly number[]): string => {
  const padded = [...bits].slice(0, RCONF_LENGTH).map((v) => Math.trunc(v))
  while (padded.length < RCONF_LENGTH) {
    padded.push(0)
  }
  return padded.join(",")
}

export const rTurnNumber = (rDeg: number): number => (Math.abs(rDeg) > 180 ? 1 : 0)

export const tTurnNumber = (tDeg: number): number => (Math.abs(tDeg) > 180 ? 1 : 0)

export const rconfFromDegrees = (
  degrees: readonly number[],
  params: Ar2010Params = defaultParams()
): number[] => {
  const row = [...degrees].slice(0, 6)
  while (row.length < 6) {
    row.push(0)
  }
  const [sDeg, lDeg, , rDeg, bDeg, tDeg] = row
  const bits = Array(RCONF_LENGTH).fill(0)
  const pulses = degreesToPulses(row, params)
  const flange = forwardKinematics(pulses, { tool: null, params }).flange
  const heading =
    flange.x * Math.cos(sDeg * DEG_TO_RAD) + flange.y * Math.sin(sDeg * DEG_TO_RAD)
  bits[0] = heading >= 0 ? 1 : 0
  bits[1] = lDeg > 90 ? 1 : 0
  bits[2] = bDeg > 0 ? 1 : 0
  bits[3] = rTurnNumber(rDeg)
  bits[4] = tTurnNumber(tDeg)
  return bits
}

export const pulsesWithinLimits = (
  pulses: readonly number[],
  pulseLimitsPos: readonly number[] = RC_PRM_PULSE_LIMITS_POS,
  pulseLimitsNeg: readonly number[] = RC_PRM_PULSE_LIMITS_NEG
): { ok: boolean; violations: string[] } => {
  const violations: string[] = []
  for (let index = 0; index < 6; index += 1) {
    const pulse = pulses[index] ?? 0
    const lo = pulseLimitsNeg[index] ?? -1e9
    const hi = pulseLimitsPos[index] ?? 1e9
    if (pulse < lo - 0.5 || pulse > hi + 0.5) {
      const axis = (AXIS_NAMES[index] ?? `j${index + 1}`).toUpperCase()
      violations.push(`${axis} pulse ${pulse.toFixed(0)} outside [${lo.toFixed(0)}, ${hi.toFixed(0)}]`)
    }
  }
  return { ok: violations.length === 0, violations }
}

export const stationFlipSeed = (sourcePulses: readonly number[]): number[] => {
  const row = [...sourcePulses].slice(0, 6)
  while (row.length < 6) {
    row.push(0)
  }
  return [-row[0], row[1], row[2], -row[3], row[4], -row[5]]
}

export const clipPulsesToLimits = (
  pulses: readonly number[],
  pulseLimitsPos: readonly number[] = RC_PRM_PULSE_LIMITS_POS,
  pulseLimitsNeg: readonly number[] = RC_PRM_PULSE_LIMITS_NEG
): number[] => {
  const clipped: number[] = []
  for (let index = 0; index < 6; index += 1) {
    const pulse = pulses[index] ?? 0
    const lo = pulseLimitsNeg[index] ?? -1e9
    const hi = pulseLimitsPos[index] ?? 1e9
    clipped.push(Math.min(hi, Math.max(lo, pulse)))
  }
  return clipped
}

const positionDelta = (actual: Mat4, expected: Mat4): [number, number, number] => [
  actual[0][3] - expected[0][3],
  actual[1][3] - expected[1][3],
  actual[2][3] - expected[2][3]
]

const orientationResidual = (actual: Mat4, expected: Mat4): [number, number, number] => {
  const a = rotationOf(actual)
  const e = rotationOf(expected)
  // relative = Aᵀ @ E
  const relative = [
    [
      a[0][0] * e[0][0] + a[1][0] * e[1][0] + a[2][0] * e[2][0],
      a[0][0] * e[0][1] + a[1][0] * e[1][1] + a[2][0] * e[2][1],
      a[0][0] * e[0][2] + a[1][0] * e[1][2] + a[2][0] * e[2][2]
    ],
    [
      a[0][1] * e[0][0] + a[1][1] * e[1][0] + a[2][1] * e[2][0],
      a[0][1] * e[0][1] + a[1][1] * e[1][1] + a[2][1] * e[2][1],
      a[0][1] * e[0][2] + a[1][1] * e[1][2] + a[2][1] * e[2][2]
    ],
    [
      a[0][2] * e[0][0] + a[1][2] * e[1][0] + a[2][2] * e[2][0],
      a[0][2] * e[0][1] + a[1][2] * e[1][1] + a[2][2] * e[2][1],
      a[0][2] * e[0][2] + a[1][2] * e[1][2] + a[2][2] * e[2][2]
    ]
  ]
  return [
    relative[2][1] - relative[1][2],
    relative[0][2] - relative[2][0],
    relative[1][0] - relative[0][1]
  ]
}

const solveIk = (
  target: CartesianPose,
  seedPulses: readonly number[],
  tool: CartesianPose,
  params: Ar2010Params,
  pulseLimitsPos: readonly number[],
  pulseLimitsNeg: readonly number[],
  positionTolMm: number
): IkResult => {
  const expected = poseToMatrix(target)
  const x0 = clipPulsesToLimits(seedPulses, pulseLimitsPos, pulseLimitsNeg)
  const lo = [...pulseLimitsNeg].slice(0, 6)
  const hi = [...pulseLimitsPos].slice(0, 6)
  while (lo.length < 6) {
    lo.push(-1e9)
  }
  while (hi.length < 6) {
    hi.push(1e9)
  }

  const residual = (values: number[]): number[] => {
    const result = forwardKinematics(values, { tool, params })
    const delta = positionDelta(result.matrix, expected)
    const omega = orientationResidual(result.matrix, expected)
    return [
      delta[0],
      delta[1],
      delta[2],
      omega[0] * ORIENT_WEIGHT,
      omega[1] * ORIENT_WEIGHT,
      omega[2] * ORIENT_WEIGHT
    ]
  }

  const solution = leastSquaresLm(residual, x0, {
    bounds: { lower: lo, upper: hi },
    xtol: 1e-10,
    ftol: 1e-10,
    maxNfev: 400
  })
  const pulses = solution.x.slice(0, 6)
  const fk = forwardKinematics(pulses, { tool, params })
  const delta = positionDelta(fk.matrix, expected)
  const posErr = Math.sqrt(delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2])
  const oriErr = rotationGeodesicDeg(rotationOf(fk.matrix), rotationOf(expected))
  const degrees = [...pulsesToDegrees(pulses, params)]
  const { ok: within, violations } = pulsesWithinLimits(pulses, hi, lo)
  const reachable = solution.success && posErr <= positionTolMm
  const rconf = rconfFromDegrees(degrees, params)
  let message: string
  if (reachable && within) {
    message = `IK ok (${posErr.toFixed(3)} mm, ${oriErr.toFixed(3)} deg)`
  } else if (!reachable) {
    message = `Unreachable: IK residual ${posErr.toFixed(2)} mm (${oriErr.toFixed(2)} deg)`
  } else {
    message = "Joint limit: " + violations.join("; ")
  }
  return {
    pulses,
    degrees,
    pose: fk.pose,
    reachable: reachable && within,
    withinLimits: within,
    positionErrorMm: posErr,
    orientationErrorDeg: oriErr,
    rconf,
    rconfText: formatRconf(rconf),
    message,
    limitViolations: violations
  }
}

export const inverseKinematics = (
  target: CartesianPose,
  seedPulses: readonly number[],
  options: {
    tool?: CartesianPose | null
    params?: Ar2010Params
    pulseLimitsPos?: readonly number[]
    pulseLimitsNeg?: readonly number[]
    positionTolMm?: number
    tryStationFlipSeed?: boolean
  } = {}
): IkResult => {
  const params = options.params ?? defaultParams()
  const tool = options.tool ?? defaultTool()
  const pos = options.pulseLimitsPos ?? RC_PRM_PULSE_LIMITS_POS
  const neg = options.pulseLimitsNeg ?? RC_PRM_PULSE_LIMITS_NEG
  const positionTolMm = options.positionTolMm ?? IK_POSITION_TOL_MM
  const seeds: number[][] = [[...seedPulses].slice(0, 6)]
  if (options.tryStationFlipSeed) {
    seeds.unshift(stationFlipSeed(seedPulses))
  }

  let best: IkResult | null = null
  for (const seed of seeds) {
    const candidate = solveIk(target, seed, tool, params, pos, neg, positionTolMm)
    if (best === null || candidate.positionErrorMm < best.positionErrorMm) {
      best = candidate
    }
    if (candidate.reachable && candidate.withinLimits) {
      return candidate
    }
  }
  return best as IkResult
}

/** Build Ar2010Params from a stored robot profile's numeric fields. */
export const paramsFromProfileFields = (fields: {
  linkLengthsMm?: Record<string, number>
  pulsePerDeg?: readonly number[]
  pulseOffsets?: readonly number[]
  reachMm?: number
}): Ar2010Params => {
  const base = defaultParams()
  const links = fields.linkLengthsMm ?? {}
  return {
    a1: links.a1 ?? base.a1,
    a2: links.a2 ?? base.a2,
    a3: links.a3 ?? base.a3,
    d4: links.d4 ?? base.d4,
    d6: links.d6 ?? base.d6,
    d1: links.d1 ?? base.d1,
    pulsePerDegree: (fields.pulsePerDeg && fields.pulsePerDeg.length >= 6
      ? [
          fields.pulsePerDeg[0],
          fields.pulsePerDeg[1],
          fields.pulsePerDeg[2],
          fields.pulsePerDeg[3],
          fields.pulsePerDeg[4],
          fields.pulsePerDeg[5]
        ]
      : base.pulsePerDegree) as SixTuple,
    pulseOffsets: (fields.pulseOffsets && fields.pulseOffsets.length >= 6
      ? [
          fields.pulseOffsets[0],
          fields.pulseOffsets[1],
          fields.pulseOffsets[2],
          fields.pulseOffsets[3],
          fields.pulseOffsets[4],
          fields.pulseOffsets[5]
        ]
      : base.pulseOffsets) as SixTuple,
    reachMm: fields.reachMm ?? base.reachMm
  }
}
