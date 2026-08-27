/**
 * Browser-side transform previews using @yaskawa/core pose + FK.
 * Station flip fit/apply run synchronously through @yaskawa/core/kin/stationFlip.
 */

import { parseJob } from "@yaskawa/core/jbi/parse"
import { serializeJob } from "@yaskawa/core/jbi/serialize"
import { unifiedDiff } from "@yaskawa/core/jbi/diff"
import { defaultTool, fkPulse, type Ar2010Params } from "@yaskawa/core/kin/fk"
import { profileToParams } from "@yaskawa/core/kin/backup"
import {
  applyFlipToWire,
  applyFlipWithIk,
  fitFlip,
  fitFlipToWire,
  flipRecipeFromDict
} from "@yaskawa/core/kin/stationFlip"
import {
  composePoses,
  invertTransform,
  matrixToPose,
  multiply4,
  poseToMatrix,
  relativePose
} from "@yaskawa/core/kin/pose"
import type {
  CartesianPose,
  MirrorPlane,
  RobotProfile,
  StationFlipRecipe,
  ToolAxisPreference,
  UserFrame
} from "@yaskawa/core/kin/types"
import type { FitStationFlipResult } from "@yaskawa/core/kin/protocol"
import { jobFamilyKey } from "@yaskawa/core/robot/profile"
import { parseUframeCnd } from "@yaskawa/core/kin/cnd"

export interface FrameMovePreview {
  before: string
  after: string
  outName: string
  diffText: string
  poseCount: number
  note?: string
}

const formatPose = (pose: CartesianPose): string => {
  const n = (value: number, digits: number) => value.toFixed(digits)
  return `${n(pose.x, 3)},${n(pose.y, 3)},${n(pose.z, 3)},${n(pose.rx, 4)},${n(pose.ry, 4)},${n(pose.rz, 4)}`
}

const parsePoseRow = (raw: string): CartesianPose => {
  const rhs = raw.includes("=") ? raw.split("=")[1] : raw
  const parts = rhs.split(",").map((part) => Number.parseFloat(part.trim()))
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Bad cartesian row: ${raw}`)
  }
  return { x: parts[0], y: parts[1], z: parts[2], rx: parts[3], ry: parts[4], rz: parts[5] }
}

const parsePulseRow = (raw: string): number[] => {
  const rhs = raw.includes("=") ? raw.split("=")[1] : raw
  return rhs.split(",").map((part) => Number.parseFloat(part.trim()))
}

export const jobStem = (label: string): string => {
  const base = label.replace(/\\/g, "/").split("/").pop() ?? label
  return base.replace(/\.jbi$/i, "")
}

const renameJob = (originalText: string, nextName: string): ReturnType<typeof parseJob> => {
  const job = parseJob(originalText)
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  return job
}

const finish = (
  originalText: string,
  job: ReturnType<typeof parseJob>,
  outName: string,
  poseCount: number,
  sourceLabel: string,
  note?: string
): FrameMovePreview => {
  const after = serializeJob(job, { recomputeNpos: true })
  return {
    before: originalText,
    after,
    outName,
    diffText: unifiedDiff(originalText, after, sourceLabel, outName),
    poseCount,
    note
  }
}

/** USER cartesian transfer — relabel ///USER only (identical fixtures). */
export const previewCartesianTransfer = (
  originalText: string,
  sourceFrameId: number,
  targetFrameId: number,
  sourceLabel = "source"
): FrameMovePreview => {
  const nextName = `${jobStem(sourceLabel)}_UF${targetFrameId}`
  const job = renameJob(originalText, nextName)
  let poseCount = 0
  let touched = false
  for (const group of job.posGroups) {
    if (String(group.postype).toUpperCase() !== "USER") {
      continue
    }
    const currentUser = Number.parseInt(String(group.user ?? ""), 10)
    if (Number.isFinite(currentUser) && currentUser !== sourceFrameId) {
      continue
    }
    touched = true
    group.user = String(targetFrameId)
    for (const header of group.headers) {
      if (header.key === "USER") {
        header.value = String(targetFrameId)
        header.raw = `///USER ${targetFrameId}`
      }
    }
    poseCount += group.vars.filter((v) => v.kind === "C" || v.kind === "P").length
  }
  if (!touched || poseCount === 0) {
    throw new Error(
      `No ///USER ${sourceFrameId} cartesian C/P vars found to transfer to UF${targetFrameId}.`
    )
  }
  return finish(originalText, job, `${nextName}.JBI`, poseCount, sourceLabel)
}

/** PULSE → USER via local FK into the source frame, emit target USER id. */
export const previewPulseTransfer = (
  originalText: string,
  sourceFrameId: number,
  targetFrameId: number,
  profile: RobotProfile,
  sourceUf: CartesianPose,
  sourceLabel = "source"
): FrameMovePreview => {
  const nextName = `${jobStem(sourceLabel)}_UF${targetFrameId}`
  const job = renameJob(originalText, nextName)
  const params = profileToParams(profile)
  let poseCount = 0

  for (const group of job.posGroups) {
    if (String(group.postype).toUpperCase() !== "PULSE") {
      continue
    }
    group.postype = "USER"
    group.user = String(targetFrameId)
    for (const header of group.headers) {
      if (header.key === "POSTYPE") {
        header.value = "USER"
        header.raw = "///POSTYPE USER"
      }
      if (header.key === "USER") {
        header.value = String(targetFrameId)
        header.raw = `///USER ${targetFrameId}`
      }
    }
    const hasUser = group.headers.some((h) => h.key === "USER")
    if (!hasUser) {
      group.headers.push({
        key: "USER",
        value: String(targetFrameId),
        raw: `///USER ${targetFrameId}`
      })
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      const pulses = parsePulseRow(posVar.raw)
      const basePose = fkPulse(pulses, null, params)
      const inSourceUf = relativePose(basePose, sourceUf)
      const formatted = formatPose(inSourceUf)
      const eq = posVar.raw.indexOf("=")
      const lhs = eq >= 0 ? posVar.raw.slice(0, eq + 1) : `${posVar.kind}${String(posVar.index).padStart(5, "0")}=`
      posVar.raw = `${lhs}${formatted}`
      poseCount += 1
    }
  }
  if (poseCount === 0) {
    throw new Error("No PULSE C/P vars found for FK transfer.")
  }
  return finish(
    originalText,
    job,
    `${nextName}.JBI`,
    poseCount,
    sourceLabel,
    `FK transfer via source UF${sourceFrameId} → USER ${targetFrameId}`
  )
}

export const previewFrameMove = (
  originalText: string,
  sourceFrameId: number,
  targetFrameId: number,
  profile: RobotProfile | null,
  sourceUf: CartesianPose | null,
  sourceLabel = "source"
): FrameMovePreview => {
  const job = parseJob(originalText)
  const hasUser = job.posGroups.some((group) => {
    if (String(group.postype).toUpperCase() !== "USER") {
      return false
    }
    const uid = Number.parseInt(String(group.user ?? ""), 10)
    if (Number.isFinite(uid) && uid !== sourceFrameId) {
      return false
    }
    return group.vars.some((v) => v.kind === "C" || v.kind === "P")
  })
  if (hasUser) {
    return previewCartesianTransfer(originalText, sourceFrameId, targetFrameId, sourceLabel)
  }
  if (!profile || !sourceUf) {
    throw new Error("PULSE transfer needs an active profile and source user-frame pose.")
  }
  return previewPulseTransfer(
    originalText,
    sourceFrameId,
    targetFrameId,
    profile,
    sourceUf,
    sourceLabel
  )
}

const mirrorPose = (pose: CartesianPose, plane: MirrorPlane): CartesianPose => {
  const next = { ...pose }
  if (plane === "YZ") {
    next.x = -pose.x
    next.ry = -pose.ry
    next.rz = -pose.rz
  } else if (plane === "XZ") {
    next.y = -pose.y
    next.rx = -pose.rx
    next.rz = -pose.rz
  } else {
    next.z = -pose.z
    next.rx = -pose.rx
    next.ry = -pose.ry
  }
  return next
}

export const previewMirrorJob = (
  originalText: string,
  plane: MirrorPlane,
  sourceLabel = "source"
): FrameMovePreview => {
  const nextName = `${jobStem(sourceLabel)}_M${plane}`
  const job = renameJob(originalText, nextName)
  let poseCount = 0
  for (const group of job.posGroups) {
    const postype = String(group.postype).toUpperCase()
    if (postype !== "USER" && postype !== "BASE") {
      continue
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      const pose = parsePoseRow(posVar.raw)
      const mirrored = mirrorPose(pose, plane)
      const eq = posVar.raw.indexOf("=")
      const lhs = eq >= 0 ? posVar.raw.slice(0, eq + 1) : `${posVar.kind}${String(posVar.index).padStart(5, "0")}=`
      posVar.raw = `${lhs}${formatPose(mirrored)}`
      poseCount += 1
    }
  }
  if (poseCount === 0) {
    throw new Error("No USER/BASE cartesian poses to mirror. Convert PULSE via Transfer first.")
  }
  return finish(originalText, job, `${nextName}.JBI`, poseCount, sourceLabel)
}

export const previewOffsetJob = (
  originalText: string,
  delta: CartesianPose,
  sourceLabel = "source"
): FrameMovePreview => {
  const nextName = `${jobStem(sourceLabel)}_OFF`
  const job = renameJob(originalText, nextName)
  let poseCount = 0
  for (const group of job.posGroups) {
    const postype = String(group.postype).toUpperCase()
    if (postype !== "USER" && postype !== "BASE") {
      continue
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      const pose = parsePoseRow(posVar.raw)
      // XYZ frame add; RPY as fixed-frame rotation via compose on orientation only.
      const translated: CartesianPose = {
        x: pose.x + delta.x,
        y: pose.y + delta.y,
        z: pose.z + delta.z,
        rx: pose.rx,
        ry: pose.ry,
        rz: pose.rz
      }
      const rotated =
        delta.rx === 0 && delta.ry === 0 && delta.rz === 0
          ? translated
          : composePoses(
              { x: 0, y: 0, z: 0, rx: delta.rx, ry: delta.ry, rz: delta.rz },
              translated
            )
      const nextPose: CartesianPose = {
        x: translated.x,
        y: translated.y,
        z: translated.z,
        rx: rotated.rx,
        ry: rotated.ry,
        rz: rotated.rz
      }
      const eq = posVar.raw.indexOf("=")
      const lhs = eq >= 0 ? posVar.raw.slice(0, eq + 1) : `${posVar.kind}${String(posVar.index).padStart(5, "0")}=`
      posVar.raw = `${lhs}${formatPose(nextPose)}`
      poseCount += 1
    }
  }
  if (poseCount === 0) {
    throw new Error("No USER/BASE cartesian poses to offset.")
  }
  return finish(originalText, job, `${nextName}.JBI`, poseCount, sourceLabel)
}

/** Frame convert (Flip): P_new = inv(UF_new) @ UF_old @ P_old (+ optional tool Z 180°). */
export const previewFrameFlipJob = (
  originalText: string,
  sourceUf: CartesianPose,
  targetUf: CartesianPose,
  targetFrameId: number,
  applyToolZFlip: boolean,
  sourceLabel = "source"
): FrameMovePreview => {
  const nextName = `${jobStem(sourceLabel)}_FLIP_UF${targetFrameId}`
  const job = renameJob(originalText, nextName)
  const tOld = poseToMatrix(sourceUf)
  const tNewInv = invertTransform(poseToMatrix(targetUf))
  const toolZ180 = poseToMatrix({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 180 })
  let poseCount = 0

  for (const group of job.posGroups) {
    if (String(group.postype).toUpperCase() !== "USER") {
      continue
    }
    group.user = String(targetFrameId)
    for (const header of group.headers) {
      if (header.key === "USER") {
        header.value = String(targetFrameId)
        header.raw = `///USER ${targetFrameId}`
      }
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      const pose = parsePoseRow(posVar.raw)
      let world = multiply4(tOld, poseToMatrix(pose))
      if (applyToolZFlip) {
        world = multiply4(world, toolZ180)
      }
      const inNew = matrixToPose(multiply4(tNewInv, world))
      const eq = posVar.raw.indexOf("=")
      const lhs = eq >= 0 ? posVar.raw.slice(0, eq + 1) : `${posVar.kind}${String(posVar.index).padStart(5, "0")}=`
      posVar.raw = `${lhs}${formatPose(inNew)}`
      poseCount += 1
    }
  }
  if (poseCount === 0) {
    throw new Error("No USER cartesian poses for frame flip. Integer PULSE rows are skipped.")
  }
  return finish(originalText, job, `${nextName}.JBI`, poseCount, sourceLabel)
}

const parsePoseRowSafe = (raw: string): CartesianPose | null => {
  const rhs = raw.includes("=") ? raw.split("=").slice(1).join("=") : raw
  const parts = rhs.split(",").map((part) => Number.parseFloat(part.trim()))
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) {
    return null
  }
  return { x: parts[0], y: parts[1], z: parts[2], rx: parts[3], ry: parts[4], rz: parts[5] }
}

const collectPulseRows = (originalText: string): number[][] => {
  const job = parseJob(originalText)
  const rows: number[][] = []
  for (const group of job.posGroups) {
    if (String(group.postype).toUpperCase() !== "PULSE") {
      continue
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      rows.push(parsePulseRow(posVar.raw))
    }
  }
  return rows
}

const collectCartesianPoses = (originalText: string): CartesianPose[] => {
  const job = parseJob(originalText)
  const poses: CartesianPose[] = []
  for (const group of job.posGroups) {
    const postype = String(group.postype).toUpperCase()
    if (postype !== "USER" && postype !== "BASE") {
      continue
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      const pose = parsePoseRowSafe(posVar.raw)
      if (pose) {
        poses.push(pose)
      }
    }
  }
  return poses
}

export interface StationFlipReachRow {
  index: number
  reachable: boolean
  withinLimits: boolean
  positionErrorMm: number
  orientationErrorDeg: number
  rconfText: string
  message: string
}

export interface StationFlipPreview extends FrameMovePreview {
  saveBlocked: boolean
  reachableCount: number
  failedCount: number
  reachReport: StationFlipReachRow[]
  familyWarning: string | null
}

const DEFAULT_RCONF = "1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"

/** Rebuild the POS section as ///POSTYPE USER groups split on RCONF changes. */
const emitUserPosesWithRconf = (
  originalText: string,
  poses: CartesianPose[],
  rconfTexts: string[],
  userFrameId: number,
  nameSuffix: string,
  sourceLabel: string
): FrameMovePreview => {
  const job = parseJob(originalText)
  const nposTool =
    job.posGroups[0]?.headers.filter((h) => h.key === "NPOS" || h.key === "TOOL") ?? []
  const groups: typeof job.posGroups = []
  let currentRconf = ""
  for (let i = 0; i < poses.length; i += 1) {
    const rconf = rconfTexts[i] || DEFAULT_RCONF
    const idx = 100 + i
    const formatted = formatPose(poses[i])
    const posVar = {
      kind: "P" as const,
      index: idx,
      values: formatted.split(","),
      raw: `P${String(idx).padStart(5, "0")}=${formatted}`
    }
    if (groups.length === 0 || rconf !== currentRconf) {
      currentRconf = rconf
      const extra = groups.length === 0 ? nposTool : []
      groups.push({
        postype: "USER",
        user: String(userFrameId),
        tool: "0",
        headers: [
          ...extra,
          { key: "USER", value: String(userFrameId), raw: `///USER ${userFrameId}` },
          { key: "POSTYPE", value: "USER", raw: "///POSTYPE USER" },
          { key: "RECTAN", value: "", raw: "///RECTAN" },
          { key: "RCONF", value: rconf, raw: `///RCONF ${rconf}` }
        ],
        vars: [posVar]
      })
    } else {
      groups[groups.length - 1].vars.push(posVar)
    }
  }
  job.posGroups = groups
  const nextName = `${jobStem(sourceLabel)}${nameSuffix}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  return finish(originalText, job, `${nextName}.JBI`, poses.length, sourceLabel)
}

/** Learn the S1↔S2 reflection from a re-taught reference pair (same point order). */
export const fitStationFlipFromPair = (args: {
  sourceText: string
  targetText: string
  sourceFrameId: number
  targetFrameId: number
  sourceJobName?: string
  targetJobName?: string
  sourceUf?: CartesianPose
  targetUf?: CartesianPose
  tool?: CartesianPose | null
  params?: Ar2010Params
  toolAxisPreference?: ToolAxisPreference
}): FitStationFlipResult => {
  const sourcePulses = collectPulseRows(args.sourceText)
  const targetPulses = collectPulseRows(args.targetText)
  const family = jobFamilyKey(args.sourceJobName ?? "")
  const tool = args.tool === undefined ? defaultTool() : args.tool
  const shared = {
    ufSource: args.sourceUf,
    ufTarget: args.targetUf,
    tool,
    params: args.params,
    sourceFrameId: args.sourceFrameId,
    targetFrameId: args.targetFrameId,
    sourceJobName: args.sourceJobName,
    targetJobName: args.targetJobName,
    jobFamily: family,
    toolAxisPreference: args.toolAxisPreference
  }
  if (sourcePulses.length > 0 && targetPulses.length > 0) {
    if (!args.sourceUf || !args.targetUf) {
      throw new Error("Station-flip fit from PULSE needs source and target UF BUSER poses.")
    }
    return fitFlipToWire(fitFlip({ ...shared, sourcePulses, targetPulses }))
  }
  const sourcePoses = collectCartesianPoses(args.sourceText)
  const targetPoses = collectCartesianPoses(args.targetText)
  if (sourcePoses.length > 0 && targetPoses.length > 0) {
    return fitFlipToWire(fitFlip({ ...shared, sourcePoses, targetPoses }))
  }
  throw new Error(
    "Reference pair needs PULSE C/P rows or USER/BASE cartesian poses on both jobs."
  )
}

/** Apply a fitted recipe to a job, with IK per point for RCONF + reach checks. */
export const previewStationFlipJob = (args: {
  originalText: string
  recipe: StationFlipRecipe
  sourceFrameId: number
  targetFrameId: number
  sourceUf?: CartesianPose
  targetUf?: CartesianPose
  tool?: CartesianPose | null
  params?: Ar2010Params
  pulseLimitsPos?: readonly number[]
  pulseLimitsNeg?: readonly number[]
  sourceLabel?: string
  toolAxisPreference?: ToolAxisPreference
}): StationFlipPreview => {
  const pulseRows = collectPulseRows(args.originalText)
  const cartPoses = pulseRows.length === 0 ? collectCartesianPoses(args.originalText) : []
  if (pulseRows.length === 0 && cartPoses.length === 0) {
    throw new Error(
      "Station flip needs PULSE C/P rows or USER/BASE cartesian poses in the source job."
    )
  }
  if (!args.sourceUf || !args.targetUf) {
    throw new Error("Station flip needs source and target UF BUSER poses.")
  }
  const recipe = flipRecipeFromDict({
    ...args.recipe,
    ...(args.toolAxisPreference
      ? { toolAxisPreference: args.toolAxisPreference }
      : {})
  })
  const points = applyFlipWithIk({
    recipe,
    sourcePulses: pulseRows.length > 0 ? pulseRows : undefined,
    sourcePoses: pulseRows.length === 0 ? cartPoses : undefined,
    ufSource: args.sourceUf,
    ufTarget: args.targetUf,
    tool: args.tool === undefined ? defaultTool() : args.tool,
    params: args.params,
    pulseLimitsPos: args.pulseLimitsPos,
    pulseLimitsNeg: args.pulseLimitsNeg
  })
  const applied = applyFlipToWire(points, recipe, args.targetFrameId)
  const sourceLabel = args.sourceLabel ?? "source"
  const preview = emitUserPosesWithRconf(
    args.originalText,
    applied.poses,
    applied.points.map((point) => point.rconfText || DEFAULT_RCONF),
    args.targetFrameId,
    `_STFLIP_UF${args.targetFrameId}`,
    sourceLabel
  )
  const currentFamily = jobFamilyKey(sourceLabel)
  const recipeFamily = (args.recipe.jobFamily ?? "").trim()
  const familyWarning =
    recipeFamily && currentFamily && recipeFamily !== currentFamily
      ? `Recipe was fitted on ${recipeFamily} (from ${args.recipe.sourceJobName ?? "a reference pair"}). ` +
        `This job looks like ${currentFamily} — Lx may not transfer.`
      : null
  return {
    ...preview,
    saveBlocked: applied.saveBlocked,
    reachableCount: applied.reachableCount,
    failedCount: applied.failedCount,
    familyWarning,
    reachReport: applied.points.map((point) => ({
      index: point.index,
      reachable: point.reachable,
      withinLimits: point.withinLimits,
      positionErrorMm: point.positionErrorMm,
      orientationErrorDeg: point.orientationErrorDeg,
      rconfText: point.rconfText,
      message: point.message
    }))
  }
}

export const loadUserFramesFromText = (uframeCndText: string): UserFrame[] =>
  parseUframeCnd(uframeCndText)

export const parseDeltaText = (text: string): CartesianPose => {
  const parts = text.split(",").map((p) => Number.parseFloat(p.trim()))
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error("Needs six numbers: X,Y,Z,Rx,Ry,Rz")
  }
  return { x: parts[0], y: parts[1], z: parts[2], rx: parts[3], ry: parts[4], rz: parts[5] }
}
