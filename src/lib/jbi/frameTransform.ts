import { parseJob } from "../jbi/parse"
import { serializeJob } from "../jbi/serialize"
import { unifiedDiff } from "../jbi/diff"
import {
  transformFrame,
  transformMirror,
  transformOffset,
  type CartesianPose,
  type MirrorPlane
} from "../kin/client"
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
