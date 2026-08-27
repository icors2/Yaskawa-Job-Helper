/**
 * Pulse-per-degree / home-offset calibration fit.
 * Ported from `kinematics/calibrate.py`.
 */

import { findFrame } from "./cnd"
import {
  HOME_CARTESIAN,
  HOME_PULSES,
  defaultParams,
  defaultTool,
  forwardKinematics,
  paramsToRecord,
  pulsesToDegrees,
  type Ar2010Params,
  type SixTuple
} from "./fk"
import {
  poseFromXyzRpy,
  poseToMatrix,
  rotationGeodesicDeg,
  rotationOf,
  xyzErrorMm,
  type Mat3
} from "./pose"
import { leastSquaresLm } from "./solve/lm"
import type { CalibratePair, CartesianPose, ResidualReport, UserFrame } from "./types"

const AXIS_LIMIT_RE =
  /(?:^|[^A-Z])(?<axis>[SLURBT])\s*(?<dir>[+\-]|PLUS|MINUS|_plus|_minus)/i
const AXIS_ORDER = "SLURBT"

export interface CalibPairLocal {
  pulses: number[]
  cartesian: CartesianPose
  weightMm: number
  weightRot: number
  matchOrientation: boolean
  label: string
  frame: string
  userFrameId: number | null
}

export interface CalibrationResult {
  calibrationId: string
  params: Ar2010Params
  residuals: ResidualReport
  success: boolean
  message: string
}

const toLocal = (pair: CalibratePair): CalibPairLocal => ({
  pulses: [...pair.pulses],
  cartesian: { ...pair.cartesian },
  weightMm: 1,
  weightRot: 1,
  matchOrientation: true,
  label: pair.label ?? "",
  frame: (pair.frame ?? "BASE").toUpperCase(),
  userFrameId: pair.userFrameId ?? null
})

const resolveUserFrame = (
  pair: CalibPairLocal,
  frames: readonly UserFrame[] | null | undefined
): CartesianPose | null => {
  if (pair.frame !== "USER") {
    return null
  }
  if (pair.userFrameId === null) {
    throw new Error(`pair ${pair.label || "?"} has frame=USER but no userFrameId`)
  }
  if (!frames || frames.length === 0) {
    throw new Error(
      `pair ${pair.label || "?"} needs loaded UFRAME.CND for USER frame ${pair.userFrameId}`
    )
  }
  return findFrame([...frames], pair.userFrameId).buser
}

export const parseAxisLimitLabel = (label: string): { axis: string; direction: "+" | "-" } | null => {
  if (!label) {
    return null
  }
  const match = AXIS_LIMIT_RE.exec(label.replace(/safe limit/gi, " "))
  if (!match || !match.groups) {
    return null
  }
  const axis = match.groups.axis.toUpperCase()
  const rawDir = match.groups.dir.toUpperCase().replace(/_/g, "")
  const direction: "+" | "-" = rawDir === "+" || rawDir === "PLUS" ? "+" : "-"
  return { axis, direction }
}

const findHomePair = (pairs: readonly CalibPairLocal[]): CalibPairLocal | null => {
  for (const pair of pairs) {
    if (pair.label && pair.label.toLowerCase().includes("home")) {
      return pair
    }
  }
  return null
}

export const estimateScalesFromJointLimits = (
  pairs: readonly CalibPairLocal[],
  seed: Ar2010Params
): Ar2010Params => {
  const home = findHomePair(pairs)
  if (!home || home.pulses.length < 6) {
    return seed
  }
  const scales = [...seed.pulsePerDegree]
  const byAxis: Record<string, CalibPairLocal[]> = {}
  for (const letter of AXIS_ORDER) {
    byAxis[letter] = []
  }
  for (const pair of pairs) {
    const parsed = parseAxisLimitLabel(pair.label)
    if (!parsed || pair.pulses.length < 6) {
      continue
    }
    byAxis[parsed.axis].push(pair)
  }
  for (const axisLetter of AXIS_ORDER) {
    const limitPairs = byAxis[axisLetter]
    if (!limitPairs.length) {
      continue
    }
    const index = AXIS_ORDER.indexOf(axisLetter)
    const homePulse = home.pulses[index]
    const numerators: number[] = []
    const denominators: number[] = []
    for (const limit of limitPairs) {
      const deltaPulse = limit.pulses[index] - homePulse
      if (Math.abs(deltaPulse) < 50) {
        continue
      }
      const homeDeg = pulsesToDegrees(home.pulses, seed)[index]
      const limitDeg = pulsesToDegrees(limit.pulses, seed)[index]
      let deltaDeg = limitDeg - homeDeg
      if (Math.abs(deltaDeg) < 1e-6) {
        deltaDeg = deltaPulse / seed.pulsePerDegree[index]
      }
      numerators.push(Math.abs(deltaPulse))
      denominators.push(Math.abs(deltaDeg))
    }
    if (!numerators.length) {
      continue
    }
    const est =
      numerators.length >= 2
        ? numerators.reduce((a, b) => a + b, 0) /
          Math.max(
            denominators.reduce((a, b) => a + b, 0),
            1e-9
          )
        : numerators[0] / Math.max(denominators[0], 1e-9)
    if (est >= 200 && est <= 4000) {
      scales[index] = est
    }
  }
  return {
    ...seed,
    pulsePerDegree: scales as SixTuple,
    pulseOffsets: [...seed.pulseOffsets] as SixTuple
  }
}

export const weightJointLimitPairs = (
  pairs: readonly CalibPairLocal[],
  boost = 2
): CalibPairLocal[] =>
  pairs.map((pair) => {
    if (parseAxisLimitLabel(pair.label) === null) {
      return pair
    }
    return {
      ...pair,
      weightMm: pair.weightMm * boost,
      weightRot: pair.weightRot * boost
    }
  })

const frameRotation = (p0: readonly number[], px: readonly number[], py: readonly number[]): Mat3 => {
  const xAxis = [px[0] - p0[0], px[1] - p0[1], px[2] - p0[2]]
  const xNorm = Math.hypot(xAxis[0], xAxis[1], xAxis[2])
  if (xNorm < 1e-9) {
    throw new Error("RXX coincides with RORG")
  }
  const x = [xAxis[0] / xNorm, xAxis[1] / xNorm, xAxis[2] / xNorm]
  const zRaw = [
    x[1] * (py[2] - p0[2]) - x[2] * (py[1] - p0[1]),
    x[2] * (py[0] - p0[0]) - x[0] * (py[2] - p0[2]),
    x[0] * (py[1] - p0[1]) - x[1] * (py[0] - p0[0])
  ]
  const zNorm = Math.hypot(zRaw[0], zRaw[1], zRaw[2])
  if (zNorm < 1e-9) {
    throw new Error("RXY is collinear with RORG/RXX")
  }
  const z = [zRaw[0] / zNorm, zRaw[1] / zNorm, zRaw[2] / zNorm]
  const y = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0]
  ]
  return [
    [x[0], y[0], z[0]],
    [x[1], y[1], z[1]],
    [x[2], y[2], z[2]]
  ]
}

const pack = (params: Ar2010Params): number[] => [
  ...params.pulsePerDegree,
  ...params.pulseOffsets
]

const unpack = (seed: Ar2010Params, values: readonly number[]): Ar2010Params => ({
  a1: seed.a1,
  a2: seed.a2,
  a3: seed.a3,
  d4: seed.d4,
  d6: seed.d6,
  d1: seed.d1,
  pulsePerDegree: [
    values[0],
    values[1],
    values[2],
    values[3],
    values[4],
    values[5]
  ] as SixTuple,
  pulseOffsets: [
    values[6],
    values[7],
    values[8],
    values[9],
    values[10],
    values[11]
  ] as SixTuple,
  reachMm: seed.reachMm
})

const omegaFromRelative = (relative: Mat3): [number, number, number] => [
  relative[2][1] - relative[1][2],
  relative[0][2] - relative[2][0],
  relative[1][0] - relative[0][1]
]

const relativeRotation = (a: Mat3, b: Mat3): Mat3 => [
  [
    a[0][0] * b[0][0] + a[1][0] * b[1][0] + a[2][0] * b[2][0],
    a[0][0] * b[0][1] + a[1][0] * b[1][1] + a[2][0] * b[2][1],
    a[0][0] * b[0][2] + a[1][0] * b[1][2] + a[2][0] * b[2][2]
  ],
  [
    a[0][1] * b[0][0] + a[1][1] * b[1][0] + a[2][1] * b[2][0],
    a[0][1] * b[0][1] + a[1][1] * b[1][1] + a[2][1] * b[2][1],
    a[0][1] * b[0][2] + a[1][1] * b[1][2] + a[2][1] * b[2][2]
  ],
  [
    a[0][2] * b[0][0] + a[1][2] * b[1][0] + a[2][2] * b[2][0],
    a[0][2] * b[0][1] + a[1][2] * b[1][1] + a[2][2] * b[2][1],
    a[0][2] * b[0][2] + a[1][2] * b[1][2] + a[2][2] * b[2][2]
  ]
]

export const backupSeedPairs = (): CalibPairLocal[] => [
  {
    pulses: [...HOME_PULSES],
    cartesian: poseFromXyzRpy(HOME_CARTESIAN),
    weightMm: 1,
    weightRot: 1,
    matchOrientation: true,
    label: "home",
    frame: "BASE",
    userFrameId: null
  }
]

export const uframePairs = (frames: readonly UserFrame[]): CalibPairLocal[] =>
  frames.map((frame) => ({
    pulses: [...frame.rorg].slice(0, 6),
    cartesian: { ...frame.buser },
    weightMm: 1,
    weightRot: 1,
    matchOrientation: false,
    label: `${frame.name}-RORG`,
    frame: "BASE",
    userFrameId: null
  }))

export const evaluateResiduals = (
  pairs: readonly CalibPairLocal[],
  params: Ar2010Params,
  options: { tool?: CartesianPose | null; frames?: readonly UserFrame[] | null } = {}
): ResidualReport => {
  const tcp = options.tool ?? defaultTool()
  const frames = options.frames
  const perPair: NonNullable<ResidualReport["perPair"]> = []
  const errors: number[] = []
  for (const pair of pairs) {
    const userFrame = resolveUserFrame(pair, frames)
    const result = forwardKinematics(pair.pulses, { tool: tcp, params, userFrame })
    const err = xyzErrorMm(result.pose, pair.cartesian)
    const rot = rotationGeodesicDeg(
      rotationOf(result.matrix),
      rotationOf(poseToMatrix(pair.cartesian))
    )
    errors.push(err)
    const row: { xyzMm: number; rotDeg?: number; userFrameId?: number } = {
      xyzMm: err,
      rotDeg: rot
    }
    if (pair.userFrameId !== null) {
      row.userFrameId = pair.userFrameId
    }
    perPair.push(row)
  }
  if (frames) {
    for (const frame of frames) {
      const origin = forwardKinematics(frame.rorg, { tool: tcp, params })
      const err = xyzErrorMm(origin.pose, frame.buser)
      let rot = 0
      if (frame.rxx.length >= 6 && frame.rxy.length >= 6) {
        const px = forwardKinematics(frame.rxx, { tool: tcp, params }).matrix
        const py = forwardKinematics(frame.rxy, { tool: tcp, params }).matrix
        const built = frameRotation(
          [origin.matrix[0][3], origin.matrix[1][3], origin.matrix[2][3]],
          [px[0][3], px[1][3], px[2][3]],
          [py[0][3], py[1][3], py[2][3]]
        )
        rot = rotationGeodesicDeg(built, rotationOf(poseToMatrix(frame.buser)))
      }
      errors.push(err)
      perPair.push({ xyzMm: err, rotDeg: rot })
    }
  }
  if (!errors.length) {
    return { rmsMm: 0, worstMm: 0, perPair }
  }
  const meanSq = errors.reduce((sum, v) => sum + v * v, 0) / errors.length
  return {
    rmsMm: Math.sqrt(meanSq),
    worstMm: Math.max(...errors),
    perPair
  }
}

export const isCalibrated = (
  residuals: ResidualReport | CalibrationResult | readonly number[],
  thresholdMm: number
): boolean => {
  let worst: number
  if (Array.isArray(residuals)) {
    worst = residuals.length ? Math.max(...residuals.map((v) => Math.abs(Number(v)))) : 0
  } else if ("params" in residuals || "calibrationId" in residuals) {
    worst = (residuals as CalibrationResult).residuals.worstMm
  } else {
    worst = (residuals as ResidualReport).worstMm
  }
  return worst <= thresholdMm
}

const newCalibrationId = (): string => {
  const bytes = new Uint8Array(5)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return `cal-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

export const calibrate = (
  pairs: readonly CalibratePair[],
  options: {
    seed?: Ar2010Params
    tool?: CartesianPose | null
    frames?: readonly UserFrame[] | null
  } = {}
): CalibrationResult => {
  let local = pairs.map(toLocal)
  const frames = options.frames
  if (!local.length && (!frames || frames.length === 0)) {
    local = backupSeedPairs()
  }
  let model = options.seed ?? defaultParams()
  const weighted = weightJointLimitPairs(local)
  model = estimateScalesFromJointLimits(weighted, model)
  const tcp = options.tool ?? defaultTool()
  const x0 = pack(model)

  const residual = (values: number[]): number[] => {
    const candidate = unpack(model, values)
    const rows: number[] = []
    for (const pair of weighted) {
      const userFrame = resolveUserFrame(pair, frames)
      const result = forwardKinematics(pair.pulses, {
        tool: tcp,
        params: candidate,
        userFrame
      })
      const expected = poseToMatrix(pair.cartesian)
      rows.push((result.matrix[0][3] - expected[0][3]) * pair.weightMm)
      rows.push((result.matrix[1][3] - expected[1][3]) * pair.weightMm)
      rows.push((result.matrix[2][3] - expected[2][3]) * pair.weightMm)
      if (pair.matchOrientation) {
        const relative = relativeRotation(rotationOf(result.matrix), rotationOf(expected))
        const omega = omegaFromRelative(relative)
        rows.push(omega[0] * 80 * pair.weightRot)
        rows.push(omega[1] * 80 * pair.weightRot)
        rows.push(omega[2] * 80 * pair.weightRot)
      }
    }
    if (frames) {
      for (const frame of frames) {
        const origin = forwardKinematics(frame.rorg, { tool: tcp, params: candidate })
        const expected = poseToMatrix(frame.buser)
        rows.push(origin.matrix[0][3] - expected[0][3])
        rows.push(origin.matrix[1][3] - expected[1][3])
        rows.push(origin.matrix[2][3] - expected[2][3])
        if (frame.rxx.length >= 6 && frame.rxy.length >= 6) {
          const px = forwardKinematics(frame.rxx, { tool: tcp, params: candidate }).matrix
          const py = forwardKinematics(frame.rxy, { tool: tcp, params: candidate }).matrix
          const built = frameRotation(
            [origin.matrix[0][3], origin.matrix[1][3], origin.matrix[2][3]],
            [px[0][3], px[1][3], px[2][3]],
            [py[0][3], py[1][3], py[2][3]]
          )
          const relative = relativeRotation(built, rotationOf(expected))
          const omega = omegaFromRelative(relative)
          rows.push(omega[0] * 80)
          rows.push(omega[1] * 80)
          rows.push(omega[2] * 80)
        }
      }
    }
    return rows
  }

  const solution = leastSquaresLm(residual, x0, {
    bounds: {
      lower: [200, 200, 200, 200, 200, 200, -2e5, -2e5, -2e5, -2e5, -2e5, -2e5],
      upper: [4000, 4000, 4000, 4000, 4000, 4000, 2e5, 2e5, 2e5, 2e5, 2e5, 2e5]
    },
    xtol: 1e-10,
    ftol: 1e-10,
    maxNfev: 800
  })
  const fitted = unpack(model, solution.x)
  const report = evaluateResiduals(weighted, fitted, { tool: tcp, frames })
  return {
    calibrationId: newCalibrationId(),
    params: fitted,
    residuals: report,
    success: solution.success && report.worstMm < 5,
    message:
      `least_squares nfev=${solution.nfev} cost=${solution.cost.toFixed(4)} ` +
      `rms=${report.rmsMm.toFixed(3)} mm worst=${report.worstMm.toFixed(3)} mm`
  }
}

export const calibrationResultToWire = (result: CalibrationResult) => ({
  calibrationId: result.calibrationId,
  parameters: paramsToRecord(result.params),
  residuals: {
    rmsMm: result.residuals.rmsMm,
    worstMm: result.residuals.worstMm,
    perPair: result.residuals.perPair
  },
  success: result.success,
  message: result.message
})
