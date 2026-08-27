import { parseJob } from "../jbi/parse"
import { serializeJob } from "../jbi/serialize"
import { unifiedDiff } from "../jbi/diff"
import {
  applyStationFlip,
  fitStationFlip,
  transformFrame,
  transformMirror,
  transformOffset,
  transformFrameFlip,
  type CartesianPose,
  type FitStationFlipResult,
  type MirrorPlane,
  type StationFlipRecipe
} from "../kin/client"
import { jobFamilyKey } from "../robot/profile"
import {
  applyPulseAxisSigns,
  type PulseMirrorAxisSigns
} from "../robot/pulseMirrorPrefs"

const formatPose = (pose: CartesianPose): string => {
  const n = (value: number, digits: number) => value.toFixed(digits)
  return `${n(pose.x, 3)},${n(pose.y, 3)},${n(pose.z, 3)},${n(pose.rx, 4)},${n(pose.ry, 4)},${n(pose.rz, 4)}`
}

const parsePulseRow = (raw: string): number[] => {
  const rhs = raw.includes("=") ? raw.split("=")[1] : raw
  return rhs.split(",").map((part) => Number.parseFloat(part.trim()))
}

const formatPulseRow = (pulses: number[]): string =>
  pulses.map((value) => String(Math.trunc(value))).join(",")

const collectPulseRows = (original: string): number[][] => {
  const job = parseJob(original)
  const pulseRows: number[][] = []
  for (const group of job.posGroups) {
    if (String(group.postype).toUpperCase() !== "PULSE") {
      continue
    }
    for (const posVar of group.vars) {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      pulseRows.push(parsePulseRow(posVar.raw))
    }
  }
  return pulseRows
}

export type StationSide = "left" | "right"

export interface FrameMovePreview {
  before: string
  after: string
  outName: string
  diffText: string
  poseCount: number
}

/**
 * Relabel ///USER on cartesian USER groups (identical fixtures).
 * Keeps pose values — only the frame id / job name change.
 */
const previewCartesianUserTransfer = (
  originalText: string,
  sourceFrameId: number,
  targetFrameId: number,
  sourceLabel?: string
): FrameMovePreview => {
  const job = parseJob(originalText)
  let poseCount = 0
  let touchedUser = false
  for (const group of job.posGroups) {
    const postype = String(group.postype).toUpperCase()
    if (postype !== "USER") {
      continue
    }
    const currentUser = Number.parseInt(String(group.user ?? ""), 10)
    if (Number.isFinite(currentUser) && currentUser !== sourceFrameId) {
      continue
    }
    touchedUser = true
    group.user = String(targetFrameId)
    group.postype = "USER"
    for (const header of group.headers) {
      if (header.key === "USER") {
        header.value = String(targetFrameId)
        header.raw = `///USER ${targetFrameId}`
      }
      if (header.key === "POSTYPE") {
        header.value = "USER"
        header.raw = "///POSTYPE USER"
      }
    }
    poseCount += group.vars.filter((v) => v.kind === "C" || v.kind === "P").length
  }
  if (!touchedUser || poseCount === 0) {
    throw new Error(
      `No ///USER ${sourceFrameId} cartesian C/P vars found to transfer to UF${targetFrameId}.`
    )
  }
  const nextName = `${job.name}_UF${targetFrameId}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  const after = serializeJob(job, { recomputeNpos: true })
  const outName = `${nextName}.JBI`
  return {
    before: originalText,
    after,
    outName,
    diffText: unifiedDiff(
      originalText,
      after,
      sourceLabel ?? "source",
      outName
    ),
    poseCount
  }
}

/**
 * Preview a frame move:
 * - USER cartesian: identical-fixture relabel (poses unchanged, ///USER → target)
 * - PULSE: FK into source UF → emit ///USER target (sidecar)
 */
export const previewFrameMove = async (args: {
  originalText: string
  sourceFrameId: number
  targetFrameId: number
  sourceLabel?: string
}): Promise<FrameMovePreview> => {
  const jobProbe = parseJob(args.originalText)
  const hasUserCartesianOnSource = jobProbe.posGroups.some((group) => {
    const postype = String(group.postype).toUpperCase()
    if (postype !== "USER") {
      return false
    }
    const uid = Number.parseInt(String(group.user ?? ""), 10)
    if (Number.isFinite(uid) && uid !== args.sourceFrameId) {
      return false
    }
    return group.vars.some((v) => v.kind === "C" || v.kind === "P")
  })
  if (hasUserCartesianOnSource) {
    return previewCartesianUserTransfer(
      args.originalText,
      args.sourceFrameId,
      args.targetFrameId,
      args.sourceLabel
    )
  }

  const job = parseJob(args.originalText)
  const pulseRows = collectPulseRows(args.originalText)
  if (pulseRows.length === 0) {
    throw new Error(
      "No USER cartesian poses on the source UF or PULSE C/P vars found to convert."
    )
  }
  const moved = await transformFrame({
    pulses: pulseRows,
    sourceFrameId: args.sourceFrameId,
    targetFrameId: args.targetFrameId,
    toolId: 0
  })
  const headers = job.posGroups[0]?.headers.filter((h) => h.key === "NPOS" || h.key === "TOOL") ?? []
  job.posGroups = [
    {
      postype: "USER",
      user: String(args.targetFrameId),
      tool: "0",
      headers: [
        ...headers,
        { key: "USER", value: String(args.targetFrameId), raw: `///USER ${args.targetFrameId}` },
        { key: "POSTYPE", value: "USER", raw: "///POSTYPE USER" },
        { key: "RECTAN", value: "", raw: "///RECTAN" },
        {
          key: "RCONF",
          value: "1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0",
          raw: "///RCONF 1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"
        }
      ],
      vars: moved.poses.map((pose, index) => {
        const idx = 100 + index
        const raw = `P${String(idx).padStart(5, "0")}=${formatPose(pose)}`
        return {
          kind: "P" as const,
          index: idx,
          values: formatPose(pose).split(","),
          raw
        }
      })
    }
  ]
  const nextName = `${job.name}_UF${args.targetFrameId}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  const after = serializeJob(job, { recomputeNpos: true })
  const outName = `${nextName}.JBI`
  return {
    before: args.originalText,
    after,
    outName,
    diffText: unifiedDiff(
      args.originalText,
      after,
      args.sourceLabel ?? "source",
      outName
    ),
    poseCount: moved.poses.length
  }
}

const parseCartesianPose = (raw: string): CartesianPose | null => {
  const rhs = raw.includes("=") ? raw.split("=").slice(1).join("=") : raw
  const parts = rhs.split(",").map((part) => Number.parseFloat(part.trim()))
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) {
    return null
  }
  return { x: parts[0], y: parts[1], z: parts[2], rx: parts[3], ry: parts[4], rz: parts[5] }
}

const parseOffsetDelta = (deltaText: string): CartesianPose => {
  const parts = deltaText.split(",").map((p) => Number.parseFloat(p.trim()))
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error("Offset needs dx,dy,dz,drx,dry,drz")
  }
  return {
    x: parts[0],
    y: parts[1],
    z: parts[2],
    rx: parts[3],
    ry: parts[4],
    rz: parts[5]
  }
}

interface CartesianVarRef {
  groupIndex: number
  varIndex: number
  pose: CartesianPose
  kind: "C" | "P"
  index: number
}

/** Collect USER/BASE cartesian C/P vars for in-place mirror/offset. */
export const collectCartesianVars = (original: string): CartesianVarRef[] => {
  const job = parseJob(original)
  const refs: CartesianVarRef[] = []
  job.posGroups.forEach((group, groupIndex) => {
    const postype = String(group.postype).toUpperCase()
    if (postype !== "USER" && postype !== "BASE") {
      return
    }
    group.vars.forEach((posVar, varIndex) => {
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        return
      }
      const pose = parseCartesianPose(posVar.raw)
      if (!pose) {
        return
      }
      refs.push({
        groupIndex,
        varIndex,
        pose,
        kind: posVar.kind,
        index: posVar.index
      })
    })
  })
  return refs
}

const rewriteCartesianVars = (
  original: string,
  refs: CartesianVarRef[],
  poses: CartesianPose[],
  nameSuffix: string
): FrameMovePreview => {
  const job = parseJob(original)
  refs.forEach((ref, i) => {
    const pose = poses[i]
    if (!pose) {
      return
    }
    const formatted = formatPose(pose)
    const label = `${ref.kind}${String(ref.index).padStart(5, "0")}`
    const raw = `${label}=${formatted}`
    job.posGroups[ref.groupIndex].vars[ref.varIndex] = {
      ...job.posGroups[ref.groupIndex].vars[ref.varIndex],
      values: formatted.split(","),
      raw
    }
  })
  const nextName = `${job.name}${nameSuffix}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  const after = serializeJob(job, { recomputeNpos: true })
  const outName = `${nextName}.JBI`
  return {
    before: original,
    after,
    outName,
    diffText: unifiedDiff(original, after, "source", outName),
    poseCount: poses.length
  }
}

/**
 * Resolve cartesian poses for mirror/offset:
 * - Prefer existing USER/BASE vars
 * - Else FK PULSE rows into sourceFrameId (same as transfer) then transform those poses
 */
const resolveCartesianForJob = async (args: {
  originalText: string
  sourceFrameId: number
}): Promise<{ mode: "user" | "pulse"; refs: CartesianVarRef[]; poses: CartesianPose[] }> => {
  const refs = collectCartesianVars(args.originalText)
  if (refs.length > 0) {
    return { mode: "user", refs, poses: refs.map((r) => r.pose) }
  }
  const pulseRows = collectPulseRows(args.originalText)
  if (pulseRows.length === 0) {
    throw new Error(
      "No USER/BASE cartesian poses or PULSE C/P vars found in this job to transform."
    )
  }
  const moved = await transformFrame({
    pulses: pulseRows,
    sourceFrameId: args.sourceFrameId,
    targetFrameId: args.sourceFrameId,
    toolId: 0
  })
  return { mode: "pulse", refs: [], poses: moved.poses }
}

const emitPulseAsUser = (
  original: string,
  poses: CartesianPose[],
  userFrameId: number,
  nameSuffix: string,
  sourceLabel?: string
): FrameMovePreview => {
  const job = parseJob(original)
  const headers = job.posGroups[0]?.headers.filter((h) => h.key === "NPOS" || h.key === "TOOL") ?? []
  job.posGroups = [
    {
      postype: "USER",
      user: String(userFrameId),
      tool: "0",
      headers: [
        ...headers,
        { key: "USER", value: String(userFrameId), raw: `///USER ${userFrameId}` },
        { key: "POSTYPE", value: "USER", raw: "///POSTYPE USER" },
        { key: "RECTAN", value: "", raw: "///RECTAN" },
        {
          key: "RCONF",
          value: "1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0",
          raw: "///RCONF 1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"
        }
      ],
      vars: poses.map((pose, index) => {
        const idx = 100 + index
        const raw = `P${String(idx).padStart(5, "0")}=${formatPose(pose)}`
        return {
          kind: "P" as const,
          index: idx,
          values: formatPose(pose).split(","),
          raw
        }
      })
    }
  ]
  const nextName = `${job.name}${nameSuffix}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  const after = serializeJob(job, { recomputeNpos: true })
  const outName = `${nextName}.JBI`
  return {
    before: original,
    after,
    outName,
    diffText: unifiedDiff(original, after, sourceLabel ?? "source", outName),
    poseCount: poses.length
  }
}

/**
 * Advanced approximate path: negate selected pulse axes in place.
 * Same ///POSTYPE PULSE and frame — cell-specific and uncalibrated by default.
 */
const previewPulseAxisMirror = (
  originalText: string,
  signs: PulseMirrorAxisSigns,
  nameSuffix: string,
  sourceLabel?: string
): FrameMovePreview => {
  const job = parseJob(originalText)
  let poseCount = 0
  for (const group of job.posGroups) {
    if (String(group.postype).toUpperCase() !== "PULSE") {
      continue
    }
    for (let i = 0; i < group.vars.length; i += 1) {
      const posVar = group.vars[i]
      if (posVar.kind !== "C" && posVar.kind !== "P") {
        continue
      }
      const pulses = parsePulseRow(posVar.raw)
      if (pulses.length < 6) {
        continue
      }
      const flipped = applyPulseAxisSigns(pulses.slice(0, 6), signs)
      const rest = pulses.slice(6)
      const values = [...flipped, ...rest]
      const formatted = formatPulseRow(values)
      const label = `${posVar.kind}${String(posVar.index).padStart(5, "0")}`
      group.vars[i] = {
        ...posVar,
        values: formatted.split(","),
        raw: `${label}=${formatted}`
      }
      poseCount += 1
    }
  }
  if (poseCount === 0) {
    throw new Error("No PULSE C/P vars found for advanced axis-sign mirror.")
  }
  const nextName = `${job.name}${nameSuffix}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  const after = serializeJob(job, { recomputeNpos: true })
  const outName = `${nextName}.JBI`
  return {
    before: originalText,
    after,
    outName,
    diffText: unifiedDiff(originalText, after, sourceLabel ?? "source", outName),
    poseCount
  }
}

export interface MirrorJobPreview extends FrameMovePreview {
  rconfReviewRequired: boolean
  /** True when the approximate pulse-axis path was used. */
  usedPulseAxisFlips?: boolean
  /** USER frame id kept on output (same-station mirror). */
  retainedUserFrameId?: number
}

const mirrorNameSuffix = (
  plane: MirrorPlane,
  side?: StationSide
): string => {
  if (side === "left") {
    return `_SSM_L_${plane}`
  }
  if (side === "right") {
    return `_SSM_R_${plane}`
  }
  return `_M${plane}`
}

/**
 * Mirror the loaded job in the active user frame (same ///USER on output).
 * Primary: cartesian USER/BASE in place, or PULSE→FK→USER then mirror.
 * Optional advanced: pulse-axis sign flips (approximate; warn in UI).
 */
export const previewMirrorJob = async (args: {
  originalText: string
  plane: MirrorPlane
  sourceFrameId?: number
  sourceLabel?: string
  /** When set, names the job as single-side mirror left/right (same math, same UF). */
  side?: StationSide
  /**
   * Advanced approximate path — negate pulse axes per profile knobs.
   * Prefer cartesian; only use when calibrated for this cell.
   */
  usePulseAxisFlips?: boolean
  pulseAxisSigns?: PulseMirrorAxisSigns
}): Promise<MirrorJobPreview> => {
  const sourceFrameId = args.sourceFrameId ?? 2
  const nameSuffix = mirrorNameSuffix(args.plane, args.side)

  if (args.usePulseAxisFlips) {
    const signs = args.pulseAxisSigns ?? [1, 1, 1, 1, 1, 1]
    const preview = previewPulseAxisMirror(
      args.originalText,
      signs,
      `${nameSuffix}_PULSEAX`,
      args.sourceLabel
    )
    return {
      ...preview,
      rconfReviewRequired: true,
      usedPulseAxisFlips: true,
      retainedUserFrameId: sourceFrameId
    }
  }

  const resolved = await resolveCartesianForJob({
    originalText: args.originalText,
    sourceFrameId
  })
  const mirrored = await transformMirror({ poses: resolved.poses, plane: args.plane })
  if (resolved.mode === "user") {
    const preview = rewriteCartesianVars(
      args.originalText,
      resolved.refs,
      mirrored.poses,
      nameSuffix
    )
    return {
      ...preview,
      diffText: unifiedDiff(
        args.originalText,
        preview.after,
        args.sourceLabel ?? "source",
        preview.outName
      ),
      rconfReviewRequired: mirrored.rconfReviewRequired,
      retainedUserFrameId: sourceFrameId
    }
  }
  const preview = emitPulseAsUser(
    args.originalText,
    mirrored.poses,
    sourceFrameId,
    nameSuffix,
    args.sourceLabel
  )
  return {
    ...preview,
    rconfReviewRequired: mirrored.rconfReviewRequired,
    retainedUserFrameId: sourceFrameId
  }
}

/** Offset the loaded job (USER poses in place, or PULSE→USER then offset). */
export const previewOffsetJob = async (args: {
  originalText: string
  deltaText: string
  sourceFrameId?: number
  sourceLabel?: string
}): Promise<FrameMovePreview> => {
  const sourceFrameId = args.sourceFrameId ?? 2
  const delta = parseOffsetDelta(args.deltaText)
  const resolved = await resolveCartesianForJob({
    originalText: args.originalText,
    sourceFrameId
  })
  const shifted = await transformOffset({ poses: resolved.poses, delta })
  if (resolved.mode === "user") {
    const preview = rewriteCartesianVars(
      args.originalText,
      resolved.refs,
      shifted.poses,
      "_OFF"
    )
    return {
      ...preview,
      diffText: unifiedDiff(
        args.originalText,
        preview.after,
        args.sourceLabel ?? "source",
        preview.outName
      )
    }
  }
  return emitPulseAsUser(
    args.originalText,
    shifted.poses,
    sourceFrameId,
    "_OFF",
    args.sourceLabel
  )
}

export interface FrameFlipPreview extends FrameMovePreview {
  applyToolZFlip: boolean
  warnings: string[]
  skippedPulse: number
}

/**
 * Convert cartesian poses from current UF BUSER → target UF BUSER (Flip math).
 * Updates ///USER to target. Does not treat integer PULSE rows as cartesian —
 * those jobs should use Transfer (FK) instead.
 */
export const previewFrameFlipJob = async (args: {
  originalText: string
  sourceFrameId: number
  targetFrameId: number
  sourceUf: CartesianPose
  targetUf: CartesianPose
  applyToolZFlip?: boolean
  sourceLabel?: string
}): Promise<FrameFlipPreview> => {
  const applyToolZFlip = args.applyToolZFlip !== false
  const refs = collectCartesianVars(args.originalText)
  const pulseRows = collectPulseRows(args.originalText)
  const warnings: string[] = []

  if (refs.length === 0) {
    if (pulseRows.length > 0) {
      throw new Error(
        "Frame convert (Flip) needs USER/BASE cartesian poses (decimal X,Y,Z,Rx,Ry,Rz). " +
          "This job looks like PULSE — use Transfer (FK→USER) or teach/convert to USER first."
      )
    }
    throw new Error(
      "No USER/BASE cartesian C/P poses found to convert between user frames."
    )
  }

  if (pulseRows.length > 0) {
    warnings.push(
      `Skipped ${pulseRows.length} PULSE row(s) — Flip converts cartesian only.`
    )
  }

  const converted = await transformFrameFlip({
    poses: refs.map((r) => r.pose),
    sourceUf: args.sourceUf,
    targetUf: args.targetUf,
    sourceFrameId: args.sourceFrameId,
    targetFrameId: args.targetFrameId,
    applyToolZFlip
  })

  const job = parseJob(args.originalText)
  refs.forEach((ref, i) => {
    const pose = converted.poses[i]
    if (!pose) {
      return
    }
    const formatted = formatPose(pose)
    const label = `${ref.kind}${String(ref.index).padStart(5, "0")}`
    job.posGroups[ref.groupIndex].vars[ref.varIndex] = {
      ...job.posGroups[ref.groupIndex].vars[ref.varIndex],
      values: formatted.split(","),
      raw: `${label}=${formatted}`
    }
  })

  let touchedUser = false
  for (const group of job.posGroups) {
    const postype = String(group.postype).toUpperCase()
    if (postype !== "USER" && postype !== "BASE") {
      continue
    }
    const currentUser = Number.parseInt(String(group.user ?? ""), 10)
    if (
      Number.isFinite(currentUser) &&
      currentUser !== args.sourceFrameId &&
      postype === "USER"
    ) {
      continue
    }
    touchedUser = true
    group.user = String(args.targetFrameId)
    group.postype = "USER"
    for (const header of group.headers) {
      if (header.key === "USER") {
        header.value = String(args.targetFrameId)
        header.raw = `///USER ${args.targetFrameId}`
      }
      if (header.key === "POSTYPE") {
        header.value = "USER"
        header.raw = "///POSTYPE USER"
      }
    }
  }
  if (!touchedUser) {
    warnings.push(
      `No ///USER ${args.sourceFrameId} header updated — check job frame tags.`
    )
  }

  const nextName = `${job.name}_FLIP_UF${args.targetFrameId}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  const after = serializeJob(job, { recomputeNpos: true })
  const outName = `${nextName}.JBI`
  return {
    before: args.originalText,
    after,
    outName,
    diffText: unifiedDiff(
      args.originalText,
      after,
      args.sourceLabel ?? "source",
      outName
    ),
    poseCount: converted.poses.length,
    applyToolZFlip,
    warnings,
    skippedPulse: pulseRows.length
  }
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

const rconfHeader = (text: string) => ({
  key: "RCONF",
  value: text,
  raw: `///RCONF ${text}`
})

const emitUserPosesWithRconf = (
  original: string,
  poses: CartesianPose[],
  rconfTexts: string[],
  userFrameId: number,
  nameSuffix: string,
  sourceLabel?: string
): FrameMovePreview => {
  const job = parseJob(original)
  const nposTool = job.posGroups[0]?.headers.filter((h) => h.key === "NPOS" || h.key === "TOOL") ?? []
  const groups: typeof job.posGroups = []
  let currentRconf = ""
  for (let i = 0; i < poses.length; i += 1) {
    const pose = poses[i]
    const rconf = rconfTexts[i] || "1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"
    const idx = 100 + i
    const formatted = formatPose(pose)
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
          rconfHeader(rconf)
        ],
        vars: [posVar]
      })
    } else {
      groups[groups.length - 1].vars.push(posVar)
    }
  }
  job.posGroups = groups
  const nextName = `${job.name}${nameSuffix}`
  job.name = nextName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = nextName
      header.raw = `//NAME ${nextName}`
    }
  }
  const after = serializeJob(job, { recomputeNpos: true })
  const outName = `${nextName}.JBI`
  return {
    before: original,
    after,
    outName,
    diffText: unifiedDiff(original, after, sourceLabel ?? "source", outName),
    poseCount: poses.length
  }
}

export const fitStationFlipFromPair = async (args: {
  sourceText: string
  targetText: string
  sourceFrameId: number
  targetFrameId: number
  sourceJobName?: string
  targetJobName?: string
  sourceUf?: CartesianPose
  targetUf?: CartesianPose
}): Promise<FitStationFlipResult> => {
  const sourcePulses = collectPulseRows(args.sourceText)
  const targetPulses = collectPulseRows(args.targetText)
  const sourceCart = collectCartesianVars(args.sourceText)
  const targetCart = collectCartesianVars(args.targetText)
  const family = jobFamilyKey(args.sourceJobName ?? "")
  if (sourcePulses.length > 0 && targetPulses.length > 0) {
    return fitStationFlip({
      sourcePulses,
      targetPulses,
      sourceFrameId: args.sourceFrameId,
      targetFrameId: args.targetFrameId,
      sourceUf: args.sourceUf,
      targetUf: args.targetUf,
      toolId: 0,
      sourceJobName: args.sourceJobName,
      targetJobName: args.targetJobName,
      jobFamily: family
    })
  }
  if (sourceCart.length > 0 && targetCart.length > 0) {
    return fitStationFlip({
      sourcePoses: sourceCart.map((ref) => ref.pose),
      targetPoses: targetCart.map((ref) => ref.pose),
      sourceFrameId: args.sourceFrameId,
      targetFrameId: args.targetFrameId,
      sourceUf: args.sourceUf,
      targetUf: args.targetUf,
      toolId: 0,
      sourceJobName: args.sourceJobName,
      targetJobName: args.targetJobName,
      jobFamily: family
    })
  }
  throw new Error(
    "Reference pair needs PULSE C/P rows or USER/BASE cartesian poses on both jobs."
  )
}

export const previewStationFlipJob = async (args: {
  originalText: string
  recipe: StationFlipRecipe
  sourceFrameId: number
  targetFrameId: number
  sourceUf?: CartesianPose
  targetUf?: CartesianPose
  sourceLabel?: string
}): Promise<StationFlipPreview> => {
  const pulseRows = collectPulseRows(args.originalText)
  const cartRefs = collectCartesianVars(args.originalText)
  if (pulseRows.length === 0 && cartRefs.length === 0) {
    throw new Error(
      "Station flip needs PULSE C/P rows or USER/BASE cartesian poses in the source job."
    )
  }
  const applied = await applyStationFlip({
    recipe: args.recipe,
    pulses: pulseRows.length > 0 ? pulseRows : undefined,
    poses: pulseRows.length === 0 ? cartRefs.map((ref) => ref.pose) : undefined,
    sourceFrameId: args.sourceFrameId,
    targetFrameId: args.targetFrameId,
    sourceUf: args.sourceUf,
    targetUf: args.targetUf,
    toolId: 0
  })
  const rconfTexts = applied.points.map(
    (point) => point.rconfText || "1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"
  )
  const preview = emitUserPosesWithRconf(
    args.originalText,
    applied.poses,
    rconfTexts,
    args.targetFrameId,
    `_STFLIP_UF${args.targetFrameId}`,
    args.sourceLabel
  )
  const currentFamily = jobFamilyKey(args.sourceLabel ?? "")
  const recipeFamily = (args.recipe.jobFamily ?? "").trim()
  let familyWarning: string | null = null
  if (recipeFamily && currentFamily && recipeFamily !== currentFamily) {
    familyWarning =
      `Recipe was fitted on ${recipeFamily} (from ${args.recipe.sourceJobName ?? "a reference pair"}). ` +
      `This job looks like ${currentFamily} — Lx may not transfer.`
  }
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

export const previewMirrorSample = async (plane: MirrorPlane): Promise<{
  sample: string
  rconfReviewRequired: boolean
}> => {
  const sample: CartesianPose = { x: 100, y: 20, z: 50, rx: 180, ry: 0, rz: 10 }
  const mirrored = await transformMirror({ poses: [sample], plane })
  return {
    sample: formatPose(mirrored.poses[0]),
    rconfReviewRequired: mirrored.rconfReviewRequired
  }
}

export const previewOffsetSample = async (deltaText: string): Promise<string> => {
  const delta = parseOffsetDelta(deltaText)
  const sample: CartesianPose = { x: 100, y: 20, z: 50, rx: 180, ry: 0, rz: 10 }
  const shifted = await transformOffset({ poses: [sample], delta })
  return formatPose(shifted.poses[0])
}
