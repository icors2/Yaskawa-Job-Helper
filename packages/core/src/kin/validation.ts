/**
 * Transform validation harness — score station-flip (and related) transforms
 * against known-good re-taught job pairs.
 *
 * Pure: callers supply job text / pulses / frames. Headless scripts and the
 * web `/validate` page both call into this module.
 */

import { parseJob } from "../jbi/parse"
import type { Ar2010Params } from "./fk"
import { defaultParams, defaultTool } from "./fk"
import { paramsFromProfileFields } from "./ik"
import {
  poseToMatrix,
  rotationGeodesicDeg,
  rotationOf
} from "./pose"
import {
  applyFlip,
  fitFlip,
  pulsesInUserFrameList,
  type FlipFitResult,
  type FlipRecipe
} from "./stationFlip"
import type { CartesianPose, RobotProfile } from "./types"

/** Soft upper bound from measured DYNAMIC1 station-flip residuals (mm). */
export const POSITION_RMS_PASS_MAX_MM = 64

/** Soft lower “typical re-teach” band edge (mm) — below this is still OK if accepted. */
export const POSITION_RMS_BAND_MIN_MM = 2

/** Orientation RMS above this yields WARN on an otherwise accepted mirror. */
export const ORIENTATION_RMS_WARN_DEG = 15

/** Orientation RMS above this fails an expected-mirror pair. */
export const ORIENTATION_RMS_FAIL_DEG = 45

export const INLIER_FRACTION_PASS = 0.6

export type ValidationVerdict = "pass" | "warn" | "fail"

export interface KnownJobPair {
  id: string
  sourceFile: string
  targetFile: string
  /** When true, fit must accept a reflection; when false, must reject as transfer. */
  expectMirror: boolean
  sourceFrameId?: number
  targetFrameId?: number
}

/** Plan §5 DYNAMIC1 pairs — S1→S2 station mirrors that should accept. */
export const DYNAMIC1_MIRROR_PAIRS: readonly KnownJobPair[] = [
  {
    id: "R1_A301-STEP1",
    sourceFile: "R1_A301-STEP1_S1.JBI",
    targetFile: "R1_A301-STEP1_S2.JBI",
    expectMirror: true
  },
  {
    id: "R1_A304-STEP2",
    sourceFile: "R1_A304-STEP2-S1.JBI",
    targetFile: "R1_A304-STEP2-S2.JBI",
    expectMirror: true
  },
  {
    id: "R1_A304-STEP4",
    sourceFile: "R1_A304-STEP4_S1.JBI",
    targetFile: "R1_A304-STEP4_S2.JBI",
    expectMirror: true
  },
  {
    id: "RACK-A402_STEP-2",
    sourceFile: "RACK-A402_STEP-2-S1.JBI",
    targetFile: "RACK-A402_STEP-2-S2.JBI",
    expectMirror: true
  },
  {
    id: "RACK-A403_STEP-1",
    sourceFile: "RACK-A403_STEP-1-S1.JBI",
    targetFile: "RACK-A403_STEP-1-S2.JBI",
    expectMirror: true
  },
  {
    id: "RACK-A403_STEP-2",
    sourceFile: "RACK-A403_STEP-2-S1.JBI",
    targetFile: "RACK-A403_STEP-2-S2.JBI",
    expectMirror: true
  }
]

/** Transfer / same-UF artefacts that must be rejected (det(R) > 0). */
export const DYNAMIC1_TRANSFER_PAIRS: readonly KnownJobPair[] = [
  {
    id: "TUBE_WELD_43_STEP_2_BOLT_SKIP",
    sourceFile: "TUBE_WELD_43_STEP_2_S1_BOLT_SKIP.JBI",
    targetFile: "TUBE_WELD_43_STEP_2_S2_BOLT_SKIP.JBI",
    expectMirror: false
  },
  {
    id: "TUBE_WELD_24_STEP_2_FULL",
    sourceFile: "TUBE_WELD_24_STEP_2_S1_FULL.JBI",
    targetFile: "TUBE_WELD_24_STEP_2_S2_FULL.JBI",
    expectMirror: false
  }
]

export const DYNAMIC1_VALIDATION_SUITE: readonly KnownJobPair[] = [
  ...DYNAMIC1_MIRROR_PAIRS,
  ...DYNAMIC1_TRANSFER_PAIRS
]

export interface ValidationPointScore {
  index: number
  positionErrorMm: number
  orientationErrorDeg: number
  isInlier: boolean
  sourcePose: CartesianPose
  predictedPose: CartesianPose
  targetPose: CartesianPose
}

export interface TransformValidationResult {
  pairId: string
  sourceName: string
  targetName: string
  expectMirror: boolean
  verdict: ValidationVerdict
  message: string
  fit: FlipFitResult
  positionRmsMm: number
  orientationRmsDeg: number
  worstPointIndex: number
  worstPositionErrorMm: number
  inliers: number
  total: number
  detR: number
  recipe: FlipRecipe | null
  points: ValidationPointScore[]
}

export interface SuitePairOutcome {
  pair: KnownJobPair
  result: TransformValidationResult | null
  error: string | null
  ok: boolean
}

export interface SuiteSummary {
  outcomes: SuitePairOutcome[]
  passed: number
  warned: number
  failed: number
  skipped: number
  ok: boolean
}

const emptyPose = (): CartesianPose => ({
  x: 0,
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0
})

const positionDeltaMm = (a: CartesianPose, b: CartesianPose): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Extract C/P pulse rows from JBI text (PULSE groups only). */
export const parsePulsePointsFromJbi = (text: string): number[][] => {
  const job = parseJob(text)
  const rows: number[][] = []
  for (const group of job.posGroups) {
    if (String(group.postype).toUpperCase() !== "PULSE") {
      continue
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      const rhs = posVar.raw.includes("=") ? posVar.raw.split("=").slice(1).join("=") : posVar.raw
      const nums = rhs.split(",").map((part) => Number.parseFloat(part.trim()))
      if (nums.length >= 6 && nums.slice(0, 6).every((n) => Number.isFinite(n))) {
        rows.push(nums.slice(0, 6))
      }
    }
  }
  return rows
}

export const paramsFromProfile = (profile: RobotProfile | null | undefined): Ar2010Params => {
  if (!profile) {
    return defaultParams()
  }
  return paramsFromProfileFields({
    linkLengthsMm: profile.linkLengthsMm,
    pulsePerDeg: profile.pulsePerDeg,
    pulseOffsets: profile.pulseOffsets,
    reachMm: undefined
  })
}

export const toolFromProfile = (profile: RobotProfile | null | undefined): CartesianPose => {
  if (profile?.tool0) {
    return { ...profile.tool0 }
  }
  return defaultTool()
}

const buildPointScores = (
  sourcePoses: readonly CartesianPose[],
  targetPoses: readonly CartesianPose[],
  recipe: FlipRecipe | null,
  inlierIndices: readonly number[]
): ValidationPointScore[] => {
  const inlierSet = new Set(inlierIndices)
  const count = Math.min(sourcePoses.length, targetPoses.length)
  const points: ValidationPointScore[] = []
  for (let index = 0; index < count; index += 1) {
    const sourcePose = sourcePoses[index]
    const targetPose = targetPoses[index]
    const predictedPose = recipe ? applyFlip(sourcePose, recipe) : { ...sourcePose }
    const positionErrorMm = positionDeltaMm(predictedPose, targetPose)
    const orientationErrorDeg = recipe
      ? rotationGeodesicDeg(
          rotationOf(poseToMatrix(predictedPose)),
          rotationOf(poseToMatrix(targetPose))
        )
      : 0
    points.push({
      index,
      positionErrorMm,
      orientationErrorDeg,
      isInlier: inlierSet.has(index),
      sourcePose,
      predictedPose,
      targetPose
    })
  }
  return points
}

const verdictForMirror = (
  fit: FlipFitResult,
  positionRmsMm: number,
  orientationRmsDeg: number
): { verdict: ValidationVerdict; message: string } => {
  if (!fit.accepted || !fit.recipe) {
    return {
      verdict: "fail",
      message: `Expected station mirror but fit rejected: ${fit.message}`
    }
  }
  if (fit.detR >= 0) {
    return {
      verdict: "fail",
      message: `Expected reflection (det(R)<0) but got det(R)=${fit.detR.toFixed(3)}`
    }
  }
  const inlierFrac = fit.total > 0 ? fit.inliers / fit.total : 0
  if (inlierFrac < INLIER_FRACTION_PASS) {
    return {
      verdict: "fail",
      message: `Inlier fraction ${inlierFrac.toFixed(2)} below ${INLIER_FRACTION_PASS} (${fit.inliers}/${fit.total})`
    }
  }
  if (positionRmsMm > POSITION_RMS_PASS_MAX_MM) {
    return {
      verdict: "fail",
      message: `Position RMS ${positionRmsMm.toFixed(2)} mm exceeds ${POSITION_RMS_PASS_MAX_MM} mm band`
    }
  }
  if (orientationRmsDeg > ORIENTATION_RMS_FAIL_DEG) {
    return {
      verdict: "fail",
      message: `Orientation RMS ${orientationRmsDeg.toFixed(2)} deg exceeds ${ORIENTATION_RMS_FAIL_DEG} deg`
    }
  }
  const softPosWarnMm = Math.max(POSITION_RMS_BAND_MIN_MM * 20, 40)
  if (orientationRmsDeg > ORIENTATION_RMS_WARN_DEG || positionRmsMm > softPosWarnMm) {
    const notes: string[] = []
    if (orientationRmsDeg > ORIENTATION_RMS_WARN_DEG) {
      notes.push(`orient RMS ${orientationRmsDeg.toFixed(2)} deg > ${ORIENTATION_RMS_WARN_DEG}`)
    }
    if (positionRmsMm > softPosWarnMm) {
      notes.push(
        `pos RMS ${positionRmsMm.toFixed(2)} mm toward upper ${POSITION_RMS_BAND_MIN_MM}–${POSITION_RMS_PASS_MAX_MM} mm band`
      )
    }
    return {
      verdict: "warn",
      message: `Accepted mirror with caveats: ${notes.join("; ")}`
    }
  }
  return {
    verdict: "pass",
    message: fit.message
  }
}

const verdictForTransferReject = (
  fit: FlipFitResult
): { verdict: ValidationVerdict; message: string } => {
  if (fit.accepted) {
    return {
      verdict: "fail",
      message: `Expected transfer rejection but fit accepted: ${fit.message}`
    }
  }
  if (fit.detR > 0) {
    return {
      verdict: "pass",
      message: `Correctly rejected transfer artefact (det(R)=+${fit.detR.toFixed(3)})`
    }
  }
  return {
    verdict: "warn",
    message: `Rejected, but not as a transfer (det(R)=${fit.detR.toFixed(3)}): ${fit.message}`
  }
}

export const scoreStationFlipPair = (args: {
  sourcePulses?: readonly (readonly number[])[] | null
  targetPulses?: readonly (readonly number[])[] | null
  sourcePoses?: readonly CartesianPose[] | null
  targetPoses?: readonly CartesianPose[] | null
  ufSource?: CartesianPose | null
  ufTarget?: CartesianPose | null
  tool?: CartesianPose | null
  params?: Ar2010Params
  sourceFrameId?: number | null
  targetFrameId?: number | null
  sourceJobName?: string
  targetJobName?: string
  pairId?: string
  expectMirror?: boolean
}): TransformValidationResult => {
  const expectMirror = args.expectMirror !== false
  const tool = args.tool ?? defaultTool()
  const params = args.params ?? defaultParams()
  const sourceName = args.sourceJobName ?? "source"
  const targetName = args.targetJobName ?? "target"
  const pairId = args.pairId ?? `${sourceName}→${targetName}`

  const fit = fitFlip({
    sourcePulses: args.sourcePulses,
    targetPulses: args.targetPulses,
    sourcePoses: args.sourcePoses,
    targetPoses: args.targetPoses,
    ufSource: args.ufSource,
    ufTarget: args.ufTarget,
    tool,
    params,
    sourceFrameId: args.sourceFrameId ?? null,
    targetFrameId: args.targetFrameId ?? null,
    sourceJobName: sourceName,
    targetJobName: targetName
  })

  const sourcePoses =
    args.sourcePoses && args.sourcePoses.length
      ? [...args.sourcePoses]
      : pulsesInUserFrameList(
          args.sourcePulses ?? [],
          args.ufSource ?? emptyPose(),
          tool,
          params
        )
  const targetPoses =
    args.targetPoses && args.targetPoses.length
      ? [...args.targetPoses]
      : pulsesInUserFrameList(
          args.targetPulses ?? [],
          args.ufTarget ?? emptyPose(),
          tool,
          params
        )
  const points = buildPointScores(
    sourcePoses,
    targetPoses,
    fit.recipe,
    fit.inlierIndices
  )

  // Fit RMS is the authoritative band metric (robust inliers + tool correction).
  // Per-point rows still use applyFlip vs taught poses for the table.
  const positionRmsMm = fit.positionRmsMm
  const orientationRmsDeg = fit.orientationRmsDeg

  let worstPointIndex = -1
  let worstPositionErrorMm = 0
  if (fit.recipe) {
    for (const point of points) {
      if (!point.isInlier) {
        continue
      }
      if (point.positionErrorMm >= worstPositionErrorMm) {
        worstPositionErrorMm = point.positionErrorMm
        worstPointIndex = point.index
      }
    }
  } else {
    // No accepted recipe — report fit RMS as the summary residual, not raw S1↔S2 gap.
    worstPositionErrorMm = positionRmsMm
    worstPointIndex = fit.inlierIndices[0] ?? (points.length ? 0 : -1)
  }

  const scored = expectMirror
    ? verdictForMirror(fit, positionRmsMm, orientationRmsDeg)
    : verdictForTransferReject(fit)

  return {
    pairId,
    sourceName,
    targetName,
    expectMirror,
    verdict: scored.verdict,
    message: scored.message,
    fit,
    positionRmsMm,
    orientationRmsDeg,
    worstPointIndex,
    worstPositionErrorMm,
    inliers: fit.inliers,
    total: fit.total,
    detR: fit.detR,
    recipe: fit.recipe,
    points
  }
}

export const scoreStationFlipFromJobText = (args: {
  sourceText: string
  targetText: string
  ufSource: CartesianPose
  ufTarget: CartesianPose
  tool?: CartesianPose | null
  params?: Ar2010Params
  profile?: RobotProfile | null
  sourceFrameId?: number | null
  targetFrameId?: number | null
  sourceJobName?: string
  targetJobName?: string
  pairId?: string
  expectMirror?: boolean
}): TransformValidationResult => {
  const tool = args.tool ?? toolFromProfile(args.profile)
  const params = args.params ?? paramsFromProfile(args.profile)
  return scoreStationFlipPair({
    sourcePulses: parsePulsePointsFromJbi(args.sourceText),
    targetPulses: parsePulsePointsFromJbi(args.targetText),
    ufSource: args.ufSource,
    ufTarget: args.ufTarget,
    tool,
    params,
    sourceFrameId: args.sourceFrameId,
    targetFrameId: args.targetFrameId,
    sourceJobName: args.sourceJobName,
    targetJobName: args.targetJobName,
    pairId: args.pairId,
    expectMirror: args.expectMirror
  })
}

export const runValidationSuite = (args: {
  pairs: readonly KnownJobPair[]
  readText: (fileName: string) => string | null
  ufSource: CartesianPose
  ufTarget: CartesianPose
  tool?: CartesianPose | null
  params?: Ar2010Params
  profile?: RobotProfile | null
}): SuiteSummary => {
  const outcomes: SuitePairOutcome[] = []
  let passed = 0
  let warned = 0
  let failed = 0
  let skipped = 0

  for (const pair of args.pairs) {
    const sourceText = args.readText(pair.sourceFile)
    const targetText = args.readText(pair.targetFile)
    if (sourceText == null || targetText == null) {
      skipped += 1
      outcomes.push({
        pair,
        result: null,
        error: `Missing ${sourceText == null ? pair.sourceFile : pair.targetFile}`,
        ok: false
      })
      continue
    }
    try {
      const result = scoreStationFlipFromJobText({
        sourceText,
        targetText,
        ufSource: args.ufSource,
        ufTarget: args.ufTarget,
        tool: args.tool,
        params: args.params,
        profile: args.profile,
        sourceFrameId: pair.sourceFrameId ?? 2,
        targetFrameId: pair.targetFrameId ?? 3,
        sourceJobName: pair.sourceFile.replace(/\.JBI$/i, ""),
        targetJobName: pair.targetFile.replace(/\.JBI$/i, ""),
        pairId: pair.id,
        expectMirror: pair.expectMirror
      })
      if (result.verdict === "pass") {
        passed += 1
      } else if (result.verdict === "warn") {
        warned += 1
      } else {
        failed += 1
      }
      outcomes.push({
        pair,
        result,
        error: null,
        ok: result.verdict !== "fail"
      })
    } catch (error) {
      failed += 1
      outcomes.push({
        pair,
        result: null,
        error: error instanceof Error ? error.message : String(error),
        ok: false
      })
    }
  }

  return {
    outcomes,
    passed,
    warned,
    failed,
    skipped,
    ok: failed === 0 && skipped === 0
  }
}
