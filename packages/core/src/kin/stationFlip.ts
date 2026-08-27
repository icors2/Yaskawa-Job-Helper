/**
 * Data-driven station mirror flip (S1 ↔ S2).
 * Ported from `kinematics/station_flip.py`.
 */

import {
  HOME_PULSES,
  defaultParams,
  defaultTool,
  forwardKinematics,
  type Ar2010Params
} from "./fk"
import { inverseKinematics, type IkResult } from "./ik"
import {
  assertRightHanded,
  composePoses,
  identity4,
  matrixToPose,
  multiply3,
  poseToMatrix,
  relativePose,
  rotationGeodesicDeg,
  rotationOf,
  type Mat3
} from "./pose"
import { det3, svd3 } from "./solve/svd3"
import type {
  CartesianPose,
  StationFlipRecipe,
  ToolAxisOption,
  ToolAxisPreference
} from "./types"

export const MIRROR_X: Mat3 = [
  [-1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
]

export const TOOL_Y_FLIP: Mat3 = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, 1]
]

export const INLIER_FRACTION_MIN = 0.6
export const RESIDUAL_MEDIAN_MULT = 3
export const MIN_FIT_POINTS = 3

/** Every selectable preference, `"auto"` first, in picker order. */
export const TOOL_AXIS_PREFERENCES: readonly ToolAxisPreference[] = ["auto", "X", "Y", "XY", "Z"]

const TOOL_AXIS_SIGNS: Record<
  Exclude<ToolAxisPreference, "auto">,
  readonly [number, number, number]
> = {
  X: [-1, 1, 1],
  Y: [1, -1, 1],
  XY: [-1, -1, 1],
  Z: [1, 1, -1]
}

export interface FlipRecipe {
  mirrorAxis: string
  offset: [number, number, number]
  mirrorMatrix: Mat3
  toolCorrection: Mat3
  toolAxisPreference: ToolAxisPreference
  positionRmsMm: number
  orientationRmsDeg: number
  inliers: number
  total: number
  detR: number
  sourceFrameId: number | null
  targetFrameId: number | null
  sourceJobName: string
  targetJobName: string
  jobFamily: string
}

export interface FlipFitResult {
  accepted: boolean
  message: string
  recipe: FlipRecipe | null
  positionRmsMm: number
  orientationRmsDeg: number
  inliers: number
  total: number
  detR: number
  inlierIndices: number[]
  /** Orientation cost of each preference against this same fit. Empty when rejected. */
  toolAxisOptions: ToolAxisOption[]
}

export interface FlipPointResult {
  index: number
  pose: CartesianPose
  ik: IkResult
}

const mat3ToList = (matrix: Mat3): number[][] => [
  [...matrix[0]],
  [...matrix[1]],
  [...matrix[2]]
]

const mat3FromUnknown = (value: unknown): Mat3 | null => {
  if (!Array.isArray(value)) {
    return null
  }
  const flat: number[] = []
  for (const row of value) {
    if (Array.isArray(row)) {
      for (const cell of row) {
        flat.push(Number(cell))
      }
    } else {
      flat.push(Number(row))
    }
  }
  if (flat.length !== 9 || flat.some((n) => !Number.isFinite(n))) {
    return null
  }
  return [
    [flat[0], flat[1], flat[2]],
    [flat[3], flat[4], flat[5]],
    [flat[6], flat[7], flat[8]]
  ]
}

const optionalInt = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null
  }
  return Number.parseInt(String(value), 10)
}

export const normalizeToolAxisPreference = (value: unknown): ToolAxisPreference => {
  const upper = String(value ?? "").toUpperCase()
  if (upper === "X" || upper === "Y" || upper === "XY" || upper === "Z") {
    return upper
  }
  return "auto"
}

const axisToMatrix = (axis: string): Mat3 => {
  const upper = axis.toUpperCase()
  if (upper === "Y") {
    return [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, 1]
    ]
  }
  if (upper === "Z") {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1]
    ]
  }
  return [
    [...MIRROR_X[0]],
    [...MIRROR_X[1]],
    [...MIRROR_X[2]]
  ]
}

const axisFromMatrix = (rotation: Mat3): string => {
  try {
    // Nullspace of (R + I) ≈ eigenvector for eigenvalue −1.
    const rPlusI: Mat3 = [
      [rotation[0][0] + 1, rotation[0][1], rotation[0][2]],
      [rotation[1][0], rotation[1][1] + 1, rotation[1][2]],
      [rotation[2][0], rotation[2][1], rotation[2][2] + 1]
    ]
    const { v, s } = svd3(rPlusI)
    let best = 0
    for (let i = 1; i < 3; i += 1) {
      if (s[i] < s[best]) {
        best = i
      }
    }
    const axisVec = [Math.abs(v[0][best]), Math.abs(v[1][best]), Math.abs(v[2][best])]
    const names = ["X", "Y", "Z"] as const
    let maxIdx = 0
    if (axisVec[1] > axisVec[maxIdx]) {
      maxIdx = 1
    }
    if (axisVec[2] > axisVec[maxIdx]) {
      maxIdx = 2
    }
    return names[maxIdx]
  } catch {
    const diag = [
      Math.abs(rotation[0][0] + 1),
      Math.abs(rotation[1][1] + 1),
      Math.abs(rotation[2][2] + 1)
    ]
    let minIdx = 0
    if (diag[1] < diag[minIdx]) {
      minIdx = 1
    }
    if (diag[2] < diag[minIdx]) {
      minIdx = 2
    }
    return (["X", "Y", "Z"] as const)[minIdx]
  }
}

export const flipRecipeToStation = (recipe: FlipRecipe): StationFlipRecipe => ({
  mirrorAxis: recipe.mirrorAxis,
  offset: [...recipe.offset],
  mirrorMatrix: mat3ToList(recipe.mirrorMatrix),
  toolCorrection: mat3ToList(recipe.toolCorrection),
  toolAxisPreference: recipe.toolAxisPreference,
  positionRmsMm: recipe.positionRmsMm,
  orientationRmsDeg: recipe.orientationRmsDeg,
  inliers: recipe.inliers,
  total: recipe.total,
  detR: recipe.detR,
  sourceFrameId: recipe.sourceFrameId,
  targetFrameId: recipe.targetFrameId,
  sourceJobName: recipe.sourceJobName,
  targetJobName: recipe.targetJobName,
  jobFamily: recipe.jobFamily
})

export const flipRecipeFromDict = (data: Record<string, unknown> | StationFlipRecipe): FlipRecipe => {
  const offsetRaw = (data.offset as number[] | undefined) ?? [0, 0, 0]
  const offsetVals = [...offsetRaw].slice(0, 3).map(Number)
  while (offsetVals.length < 3) {
    offsetVals.push(0)
  }
  let mirror =
    mat3FromUnknown(data.mirrorMatrix) ?? mat3FromUnknown((data as { mirror_matrix?: unknown }).mirror_matrix)
  if (!mirror) {
    const axis = String(
      data.mirrorAxis ?? (data as { mirror_axis?: unknown }).mirror_axis ?? "X"
    ).toUpperCase()
    mirror = axisToMatrix(axis)
  }
  let tool =
    mat3FromUnknown(data.toolCorrection) ??
    mat3FromUnknown((data as { tool_correction?: unknown }).tool_correction)
  if (!tool) {
    tool = [
      [...TOOL_Y_FLIP[0]],
      [...TOOL_Y_FLIP[1]],
      [...TOOL_Y_FLIP[2]]
    ]
  }
  return {
    mirrorAxis: String(
      data.mirrorAxis ?? (data as { mirror_axis?: unknown }).mirror_axis ?? axisFromMatrix(mirror)
    ),
    offset: [offsetVals[0], offsetVals[1], offsetVals[2]],
    mirrorMatrix: mirror,
    toolCorrection: tool,
    toolAxisPreference: normalizeToolAxisPreference(
      data.toolAxisPreference ?? (data as { tool_axis_preference?: unknown }).tool_axis_preference
    ),
    positionRmsMm: Number(
      data.positionRmsMm ?? (data as { position_rms_mm?: unknown }).position_rms_mm ?? 0
    ),
    orientationRmsDeg: Number(
      data.orientationRmsDeg ??
        (data as { orientation_rms_deg?: unknown }).orientation_rms_deg ??
        0
    ),
    inliers: Number(data.inliers ?? 0),
    total: Number(data.total ?? 0),
    detR: Number(data.detR ?? (data as { det_r?: unknown }).det_r ?? det3(mirror)),
    sourceFrameId: optionalInt(
      data.sourceFrameId ?? (data as { source_frame_id?: unknown }).source_frame_id
    ),
    targetFrameId: optionalInt(
      data.targetFrameId ?? (data as { target_frame_id?: unknown }).target_frame_id
    ),
    sourceJobName: String(
      data.sourceJobName ?? (data as { source_job_name?: unknown }).source_job_name ?? ""
    ),
    targetJobName: String(
      data.targetJobName ?? (data as { target_job_name?: unknown }).target_job_name ?? ""
    ),
    jobFamily: String(data.jobFamily ?? (data as { job_family?: unknown }).job_family ?? "")
  }
}

export const recipeFromLx = (
  lx: number,
  ly = 0,
  lz = 0,
  options: { sourceFrameId?: number | null; targetFrameId?: number | null } = {}
): FlipRecipe => ({
  mirrorAxis: "X",
  offset: [lx, ly, lz],
  mirrorMatrix: [
    [...MIRROR_X[0]],
    [...MIRROR_X[1]],
    [...MIRROR_X[2]]
  ],
  toolCorrection: [
    [...TOOL_Y_FLIP[0]],
    [...TOOL_Y_FLIP[1]],
    [...TOOL_Y_FLIP[2]]
  ],
  toolAxisPreference: "auto",
  positionRmsMm: 0,
  orientationRmsDeg: 0,
  inliers: 0,
  total: 0,
  detR: -1,
  sourceFrameId: options.sourceFrameId ?? null,
  targetFrameId: options.targetFrameId ?? null,
  sourceJobName: "",
  targetJobName: "",
  jobFamily: ""
})

export const applyFlip = (
  pose: CartesianPose,
  recipe: FlipRecipe | StationFlipRecipe | Record<string, unknown>
): CartesianPose => {
  const resolved = flipRecipeFromDict(recipe as Record<string, unknown>)
  const matrix = poseToMatrix(pose)
  const rotation = rotationOf(matrix)
  const origin: [number, number, number] = [matrix[0][3], matrix[1][3], matrix[2][3]]
  const out = identity4()
  const rotOut = multiply3(resolved.mirrorMatrix, multiply3(rotation, resolved.toolCorrection))
  assertRightHanded(rotOut, `station flip about ${resolved.mirrorAxis}`)
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row][col] = rotOut[row][col]
    }
    out[row][3] =
      resolved.mirrorMatrix[row][0] * origin[0] +
      resolved.mirrorMatrix[row][1] * origin[1] +
      resolved.mirrorMatrix[row][2] * origin[2] +
      resolved.offset[row]
  }
  return matrixToPose(out)
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

export const pulsesInUserFrameList = pulsesInUf

const positionResiduals = (
  src: readonly (readonly number[])[],
  dst: readonly (readonly number[])[],
  rotation: Mat3,
  translation: readonly number[]
): number[] =>
  src.map((point, index) => {
    const pred = [
      rotation[0][0] * point[0] +
        rotation[0][1] * point[1] +
        rotation[0][2] * point[2] +
        translation[0],
      rotation[1][0] * point[0] +
        rotation[1][1] * point[1] +
        rotation[1][2] * point[2] +
        translation[1],
      rotation[2][0] * point[0] +
        rotation[2][1] * point[1] +
        rotation[2][2] * point[2] +
        translation[2]
    ]
    const dx = pred[0] - dst[index][0]
    const dy = pred[1] - dst[index][1]
    const dz = pred[2] - dst[index][2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  })

export const umeyamaWithReflection = (
  source: readonly (readonly number[])[],
  target: readonly (readonly number[])[]
): { rotation: Mat3; translation: [number, number, number] } => {
  const n = source.length
  if (n < MIN_FIT_POINTS || source[0]?.length !== 3 || target.length !== n) {
    throw new Error("umeyamaWithReflection needs Nx3 source and target with N>=3")
  }
  const muS = [0, 0, 0]
  const muT = [0, 0, 0]
  for (let i = 0; i < n; i += 1) {
    muS[0] += source[i][0]
    muS[1] += source[i][1]
    muS[2] += source[i][2]
    muT[0] += target[i][0]
    muT[1] += target[i][1]
    muT[2] += target[i][2]
  }
  muS[0] /= n
  muS[1] /= n
  muS[2] /= n
  muT[0] /= n
  muT[1] /= n
  muT[2] /= n
  const cov: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (let i = 0; i < n; i += 1) {
    const sc = [source[i][0] - muS[0], source[i][1] - muS[1], source[i][2] - muS[2]]
    const tc = [target[i][0] - muT[0], target[i][1] - muT[1], target[i][2] - muT[2]]
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        cov[r][c] += tc[r] * sc[c]
      }
    }
  }
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      cov[r][c] /= n
    }
  }
  const { u, vt } = svd3(cov)
  // Rank-deficient clouds leave the null-space of SVD ambiguous; svd-js and
  // NumPy can return opposite determinants. Try both U@Vt and U@diag(1,1,-1)@Vt
  // and keep the lower residual (preferring reflection on a tie).
  const candidates: Mat3[] = [
    multiply3(u, vt),
    multiply3(u, multiply3([[1, 0, 0], [0, 1, 0], [0, 0, -1]], vt))
  ]
  let best = candidates[0]
  let bestRss = Number.POSITIVE_INFINITY
  let bestDet = det3(best)
  for (const candidate of candidates) {
    const translation: [number, number, number] = [
      muT[0] -
        (candidate[0][0] * muS[0] + candidate[0][1] * muS[1] + candidate[0][2] * muS[2]),
      muT[1] -
        (candidate[1][0] * muS[0] + candidate[1][1] * muS[1] + candidate[1][2] * muS[2]),
      muT[2] -
        (candidate[2][0] * muS[0] + candidate[2][1] * muS[1] + candidate[2][2] * muS[2])
    ]
    const residuals = positionResiduals(source, target, candidate, translation)
    const rss = residuals.reduce((sum, v) => sum + v * v, 0)
    const det = det3(candidate)
    if (
      rss < bestRss - 1e-12 ||
      (Math.abs(rss - bestRss) <= 1e-12 && det < bestDet)
    ) {
      bestRss = rss
      best = candidate
      bestDet = det
    }
  }
  const translation: [number, number, number] = [
    muT[0] - (best[0][0] * muS[0] + best[0][1] * muS[1] + best[0][2] * muS[2]),
    muT[1] - (best[1][0] * muS[0] + best[1][1] * muS[1] + best[1][2] * muS[2]),
    muT[2] - (best[2][0] * muS[0] + best[2][1] * muS[1] + best[2][2] * muS[2])
  ]
  return { rotation: best, translation }
}

const medianOf = (values: readonly number[]): number => {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const rmsOf = (values: readonly number[]): number => {
  if (!values.length) {
    return 0
  }
  const meanSq = values.reduce((sum, v) => sum + v * v, 0) / values.length
  return Math.sqrt(meanSq)
}

const inlierMask = (
  residuals: readonly number[],
  minThreshold = 1
): { mask: boolean[]; threshold: number } => {
  if (!residuals.length) {
    return { mask: [], threshold: 0 }
  }
  const threshold = Math.max(RESIDUAL_MEDIAN_MULT * medianOf(residuals), minThreshold)
  return {
    mask: residuals.map((value) => value <= threshold),
    threshold
  }
}

const robustUmeyama = (
  src: readonly (readonly number[])[],
  dst: readonly (readonly number[])[]
): {
  rotation: Mat3
  translation: [number, number, number]
  residuals: number[]
  inlierIdx: number[]
  threshold: number
} => {
  let inlierIdx = src.map((_, i) => i)
  let rotation: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ]
  let translation: [number, number, number] = [0, 0, 0]
  let residuals = Array(src.length).fill(0)
  let threshold = 0
  for (let iter = 0; iter < 8; iter += 1) {
    if (inlierIdx.length < MIN_FIT_POINTS) {
      break
    }
    const srcIn = inlierIdx.map((i) => src[i])
    const dstIn = inlierIdx.map((i) => dst[i])
    const fit = umeyamaWithReflection(srcIn, dstIn)
    rotation = fit.rotation
    translation = fit.translation
    residuals = positionResiduals(src, dst, rotation, translation)
    const { mask, threshold: thr } = inlierMask(residuals)
    threshold = thr
    const nxt = mask.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0)
    if (nxt.length === inlierIdx.length && nxt.every((v, i) => v === inlierIdx[i])) {
      break
    }
    inlierIdx = nxt
  }
  return { rotation, translation, residuals, inlierIdx, threshold }
}

/**
 * Sign a tool correction so `mirror · R · F` stays right-handed for any proper
 * `R`. `det(mirror · R · F) = det(mirror) · det(F)`, so `F` must carry the same
 * determinant sign as the mirror: an improper (reflection) mirror demands an
 * improper `F`.
 */
const requiredToolDet = (mirror: Mat3): number => (det3(mirror) < 0 ? -1 : 1)

export const svdToolCorrection = (
  srcRot: readonly Mat3[],
  dstRot: readonly Mat3[],
  mirror: Mat3,
  inlierIdx: readonly number[]
): Mat3 => {
  if (!inlierIdx.length) {
    return [
      [...TOOL_Y_FLIP[0]],
      [...TOOL_Y_FLIP[1]],
      [...TOOL_Y_FLIP[2]]
    ]
  }
  const stacked: Mat3[] = []
  for (const index of inlierIdx) {
    // srcᵀ @ mirrorᵀ @ dst
    const srcT: Mat3 = [
      [srcRot[index][0][0], srcRot[index][1][0], srcRot[index][2][0]],
      [srcRot[index][0][1], srcRot[index][1][1], srcRot[index][2][1]],
      [srcRot[index][0][2], srcRot[index][1][2], srcRot[index][2][2]]
    ]
    const mirrorT: Mat3 = [
      [mirror[0][0], mirror[1][0], mirror[2][0]],
      [mirror[0][1], mirror[1][1], mirror[2][1]],
      [mirror[0][2], mirror[1][2], mirror[2][2]]
    ]
    stacked.push(multiply3(srcT, multiply3(mirrorT, dstRot[index])))
  }
  const meanF: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (const mat of stacked) {
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        meanF[r][c] += mat[r][c]
      }
    }
  }
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      meanF[r][c] /= stacked.length
    }
  }
  const { u, s, vt } = svd3(meanF)
  const fitted = multiply3(u, vt)
  const det = det3(fitted)
  if (Math.abs(det) < 1e-8) {
    return [
      [...TOOL_Y_FLIP[0]],
      [...TOOL_Y_FLIP[1]],
      [...TOOL_Y_FLIP[2]]
    ]
  }
  if (det * requiredToolDet(mirror) > 0) {
    return fitted
  }
  // Kabsch sign fix: negating the left singular vector with the smallest
  // singular value flips the determinant at the least cost in fit error. The
  // unsigned polar factor would otherwise hand `applyFlip` a left-handed frame.
  let least = 0
  for (let i = 1; i < 3; i += 1) {
    if (s[i] < s[least]) {
      least = i
    }
  }
  const signed: Mat3 = [
    [...u[0]],
    [...u[1]],
    [...u[2]]
  ]
  for (let row = 0; row < 3; row += 1) {
    signed[row][least] = -signed[row][least]
  }
  return multiply3(signed, vt)
}

/**
 * Pin `F` to one named diagonal. The four explicit preferences cover the whole
 * set of diagonal corrections that keep a reflected pose right-handed, so a
 * two-axis pick like `"XY"` (a proper 180° rotation on its own) gains the third
 * negation rather than silently producing a left-handed flip.
 */
const pinnedToolCorrection = (
  preference: Exclude<ToolAxisPreference, "auto">,
  mirror: Mat3
): Mat3 => {
  const signs = [...TOOL_AXIS_SIGNS[preference]]
  if (signs[0] * signs[1] * signs[2] !== requiredToolDet(mirror)) {
    const untouched = signs.findIndex((sign) => sign > 0)
    signs[untouched >= 0 ? untouched : 2] *= -1
  }
  return [
    [signs[0], 0, 0],
    [0, signs[1], 0],
    [0, 0, signs[2]]
  ]
}

const fitToolCorrection = (
  srcRot: readonly Mat3[],
  dstRot: readonly Mat3[],
  mirror: Mat3,
  inlierIdx: readonly number[],
  preference: ToolAxisPreference = "auto"
): Mat3 => {
  if (preference !== "auto") {
    return pinnedToolCorrection(preference, mirror)
  }
  const svdF = svdToolCorrection(srcRot, dstRot, mirror, inlierIdx)
  const candidates: Mat3[] = [
    [
      [...TOOL_Y_FLIP[0]],
      [...TOOL_Y_FLIP[1]],
      [...TOOL_Y_FLIP[2]]
    ],
    [
      [-1, 0, 0],
      [0, -1, 0],
      [0, 0, 1]
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1]
    ],
    [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, -1]
    ],
    [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ],
    [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1]
    ],
    svdF
  ]
  let best = candidates[0]
  let bestMedian = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const errors = inlierIdx.map((i) =>
      rotationGeodesicDeg(multiply3(mirror, multiply3(srcRot[i], candidate)), dstRot[i])
    )
    const med = errors.length ? medianOf(errors) : Number.POSITIVE_INFINITY
    if (med < bestMedian) {
      bestMedian = med
      best = candidate
    }
  }
  return best
}

const orientationRmsFor = (
  srcRot: readonly Mat3[],
  dstRot: readonly Mat3[],
  mirror: Mat3,
  inlierIdx: readonly number[],
  toolF: Mat3
): number => {
  const errors = inlierIdx.map((i) =>
    rotationGeodesicDeg(multiply3(mirror, multiply3(srcRot[i], toolF)), dstRot[i])
  )
  const { mask } = inlierMask(errors, 8)
  const keep = errors.filter((_, i) => mask[i])
  return keep.length >= MIN_FIT_POINTS ? rmsOf(keep) : rmsOf(errors)
}

export const fitFlip = (args: {
  sourcePulses?: readonly (readonly number[])[] | null
  targetPulses?: readonly (readonly number[])[] | null
  ufSource?: CartesianPose | null
  ufTarget?: CartesianPose | null
  tool?: CartesianPose | null
  params?: Ar2010Params
  sourcePoses?: readonly CartesianPose[] | null
  targetPoses?: readonly CartesianPose[] | null
  sourceFrameId?: number | null
  targetFrameId?: number | null
  sourceJobName?: string
  targetJobName?: string
  jobFamily?: string
  /** `"auto"` (default) keeps the seven-candidate search; anything else pins `F`. */
  toolAxisPreference?: ToolAxisPreference
}): FlipFitResult => {
  const preference = normalizeToolAxisPreference(args.toolAxisPreference)
  const tcp = args.tool ?? defaultTool()
  const model = args.params ?? defaultParams()
  let srcPoses = args.sourcePoses ? [...args.sourcePoses] : []
  let dstPoses = args.targetPoses ? [...args.targetPoses] : []
  if (!srcPoses.length) {
    if (!args.sourcePulses?.length) {
      throw new Error("fitFlip requires sourcePulses or sourcePoses")
    }
    if (!args.ufSource) {
      throw new Error("fitFlip requires ufSource when fitting from pulses")
    }
    srcPoses = pulsesInUf(args.sourcePulses, args.ufSource, tcp, model)
  }
  if (!dstPoses.length) {
    if (!args.targetPulses?.length) {
      throw new Error("fitFlip requires targetPulses or targetPoses")
    }
    if (!args.ufTarget) {
      throw new Error("fitFlip requires ufTarget when fitting from pulses")
    }
    dstPoses = pulsesInUf(args.targetPulses, args.ufTarget, tcp, model)
  }
  const count = Math.min(srcPoses.length, dstPoses.length)
  if (count < MIN_FIT_POINTS) {
    return {
      accepted: false,
      message: `Need at least ${MIN_FIT_POINTS} corresponding points to fit a station mirror (got ${count}).`,
      recipe: null,
      positionRmsMm: 0,
      orientationRmsDeg: 0,
      inliers: 0,
      total: count,
      detR: 0,
      inlierIndices: [],
      toolAxisOptions: []
    }
  }
  const srcXyz = srcPoses.slice(0, count).map((p) => [p.x, p.y, p.z] as const)
  const dstXyz = dstPoses.slice(0, count).map((p) => [p.x, p.y, p.z] as const)
  const srcRot = srcPoses.slice(0, count).map((p) => rotationOf(poseToMatrix(p)))
  const dstRot = dstPoses.slice(0, count).map((p) => rotationOf(poseToMatrix(p)))
  const { rotation, translation, residuals, inlierIdx, threshold } = robustUmeyama(srcXyz, dstXyz)
  const detR = det3(rotation)
  let nIn = inlierIdx.length
  let posRms = nIn ? rmsOf(inlierIdx.map((i) => residuals[i])) : rmsOf(residuals)

  if (detR > 0) {
    return {
      accepted: false,
      message:
        `Fit is a proper rotation (det(R)=${detR >= 0 ? "+" : ""}${detR.toFixed(3)}), not a reflection. ` +
        "This pair looks like a Transfer or same-UF artifact, not a station mirror.",
      recipe: null,
      positionRmsMm: posRms,
      orientationRmsDeg: 0,
      inliers: nIn,
      total: count,
      detR,
      inlierIndices: [...inlierIdx],
      toolAxisOptions: []
    }
  }

  if (nIn < Math.max(MIN_FIT_POINTS, Math.ceil(INLIER_FRACTION_MIN * count))) {
    return {
      accepted: false,
      message:
        `Too few corresponding points (${nIn}/${count} inliers below ${threshold.toFixed(2)} mm). ` +
        "The pair may not be a re-taught S1/S2 mirror, or points are not in the same order.",
      recipe: null,
      positionRmsMm: posRms,
      orientationRmsDeg: 0,
      inliers: nIn,
      total: count,
      detR,
      inlierIndices: [...inlierIdx],
      toolAxisOptions: []
    }
  }

  const toolF = fitToolCorrection(srcRot, dstRot, rotation, inlierIdx, preference)
  const orientRms = orientationRmsFor(srcRot, dstRot, rotation, inlierIdx, toolF)
  const toolAxisOptions: ToolAxisOption[] = TOOL_AXIS_PREFERENCES.map((choice) => {
    const candidate = fitToolCorrection(srcRot, dstRot, rotation, inlierIdx, choice)
    return {
      preference: choice,
      toolCorrection: mat3ToList(candidate),
      orientationRmsDeg: orientationRmsFor(srcRot, dstRot, rotation, inlierIdx, candidate)
    }
  })
  posRms = rmsOf(inlierIdx.map((i) => residuals[i]))
  nIn = inlierIdx.length
  const axis = axisFromMatrix(rotation)
  const recipe: FlipRecipe = {
    mirrorAxis: axis,
    offset: translation,
    mirrorMatrix: rotation,
    toolCorrection: toolF,
    toolAxisPreference: preference,
    positionRmsMm: posRms,
    orientationRmsDeg: orientRms,
    inliers: nIn,
    total: count,
    detR,
    sourceFrameId: args.sourceFrameId ?? null,
    targetFrameId: args.targetFrameId ?? null,
    sourceJobName: args.sourceJobName ?? "",
    targetJobName: args.targetJobName ?? "",
    jobFamily: args.jobFamily ?? ""
  }
  return {
    accepted: true,
    message:
      `Station mirror about ${axis}: L=(${translation[0].toFixed(1)}, ${translation[1].toFixed(1)}, ` +
      `${translation[2].toFixed(1)}) mm, pos RMS ${posRms.toFixed(2)} mm, orient RMS ${orientRms.toFixed(2)} deg, ` +
      `${nIn}/${count} inliers.` +
      (preference === "auto" ? "" : ` Tool axis pinned to ${preference}.`),
    recipe,
    positionRmsMm: posRms,
    orientationRmsDeg: orientRms,
    inliers: nIn,
    total: count,
    detR,
    inlierIndices: [...inlierIdx],
    toolAxisOptions
  }
}

export const flippedPoseInBase = (
  ufPose: CartesianPose,
  recipe: FlipRecipe | StationFlipRecipe,
  ufTarget: CartesianPose
): CartesianPose => composePoses(ufTarget, applyFlip(ufPose, recipe))

export const applyFlipWithIk = (args: {
  sourcePulses?: readonly (readonly number[])[]
  recipe: FlipRecipe | StationFlipRecipe | Record<string, unknown>
  ufSource: CartesianPose
  ufTarget: CartesianPose
  tool?: CartesianPose | null
  params?: Ar2010Params
  pulseLimitsPos?: readonly number[]
  pulseLimitsNeg?: readonly number[]
  sourcePoses?: readonly CartesianPose[] | null
}): FlipPointResult[] => {
  const rec = flipRecipeFromDict(args.recipe as Record<string, unknown>)
  const tcp = args.tool ?? defaultTool()
  const model = args.params ?? defaultParams()
  const ufPoses =
    args.sourcePoses && args.sourcePoses.length
      ? [...args.sourcePoses]
      : pulsesInUf(args.sourcePulses ?? [], args.ufSource, tcp, model)
  const seeds = args.sourcePulses ? [...args.sourcePulses] : []
  const results: FlipPointResult[] = []
  for (let index = 0; index < ufPoses.length; index += 1) {
    const flippedUf = applyFlip(ufPoses[index], rec)
    const targetBase = composePoses(args.ufTarget, flippedUf)
    let seed: readonly number[]
    let tryFlipSeed: boolean
    if (index < seeds.length && seeds[index].length >= 6) {
      seed = seeds[index]
      tryFlipSeed = true
    } else {
      seed = HOME_PULSES
      tryFlipSeed = false
    }
    const ikResult = inverseKinematics(targetBase, seed, {
      tool: tcp,
      params: model,
      pulseLimitsPos: args.pulseLimitsPos,
      pulseLimitsNeg: args.pulseLimitsNeg,
      tryStationFlipSeed: tryFlipSeed
    })
    results.push({ index, pose: flippedUf, ik: ikResult })
  }
  return results
}

export const fitFlipToWire = (result: FlipFitResult) => ({
  accepted: result.accepted,
  message: result.message,
  recipe: result.recipe ? flipRecipeToStation(result.recipe) : null,
  positionRmsMm: result.positionRmsMm,
  orientationRmsDeg: result.orientationRmsDeg,
  inliers: result.inliers,
  total: result.total,
  detR: result.detR,
  inlierIndices: [...result.inlierIndices],
  toolAxisOptions: result.toolAxisOptions.map((option) => ({ ...option }))
})

export const applyFlipToWire = (
  points: FlipPointResult[],
  recipe: FlipRecipe,
  targetFrameId: number | null
) => {
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
    targetFrameId,
    saveBlocked: failed.length > 0,
    reachableCount: points.length - failed.length,
    failedCount: failed.length,
    recipe: flipRecipeToStation(recipe)
  }
}
