import type { CartesianPose } from "../kin/client"
import { parseJob, nposMismatch } from "../jbi/parse"
import type { JobFile, PosGroup, PosVar, PosVarKind } from "../jbi/model"
import type {
  CalibFrameType,
  CalibrationSample,
  CalibrationSession,
  CalibrationStepDef
} from "./types"
import { getStepById } from "./steps"
import { saveSessionLocal } from "./session"

const CALSTEP_RE = /CALSTEP:([a-zA-Z0-9_+-]+)/i
const PAUSE_TAG_RE = /\b(STEP_[A-Z0-9_+-]+)\b/
const MSG_TAG_RE = /MSG\s+"([^"]+)"/i
const MOV_POS_RE =
  /\b(?:MOVJ|MOVL|MOVC|IMOV)\s+((?:C|BC|EC|P|BP|EX)0*\d+)\b/i
const NUMBERED_COMMENT_RE = /^'(\d+)\s+(.+)$/

export type ExtractedStepHit = {
  stepId: string
  pauseTag?: string
  pulses?: number[]
  cartesian?: CartesianPose
  frame?: CalibFrameType
  userFrameId?: number
  posRef?: string
  source: "calstep" | "pause_tag" | "order" | "index"
}

export type JobExtractResult = {
  kind: "standard" | "relative" | "unknown"
  jobName: string
  postype: string
  userFrameId?: number
  hits: ExtractedStepHit[]
  warnings: string[]
  nposWarning: string | null
}

export type CalibrationExtractSummary = {
  standard: JobExtractResult | null
  relative: JobExtractResult | null
  filled: ExtractedStepHit[]
  missingPulseStepIds: string[]
  missingCartStepIds: string[]
  warnings: string[]
}

const parsePosKindIndex = (
  token: string
): { kind: PosVarKind; index: number } | null => {
  const match = /^(C|BC|EC|P|BP|EX)0*(\d+)$/i.exec(token.trim())
  if (!match) {
    return null
  }
  return {
    kind: match[1].toUpperCase() as PosVarKind,
    index: Number.parseInt(match[2], 10)
  }
}

const findPosVar = (
  groups: PosGroup[],
  kind: PosVarKind,
  index: number
): { group: PosGroup; posVar: PosVar } | null => {
  for (const group of groups) {
    for (const posVar of group.vars) {
      if (posVar.kind === kind && posVar.index === index) {
        return { group, posVar }
      }
    }
  }
  return null
}

const findPosVarForIndex = (
  groups: PosGroup[],
  index: number,
  pulseMode: boolean
): { group: PosGroup; posVar: PosVar } | null => {
  const cVar = findPosVar(groups, "C", index)
  if (cVar) {
    return cVar
  }
  if (pulseMode) {
    return findPosVar(groups, "BC", index) ?? findPosVar(groups, "EC", index)
  }
  return findPosVar(groups, "P", index) ?? findPosVar(groups, "BP", index)
}

const parsePulseValues = (values: string[]): number[] | null => {
  const nums = values.map((part) => Number.parseFloat(part.trim()))
  if (nums.length < 6 || nums.some((n) => Number.isNaN(n))) {
    return null
  }
  return nums.slice(0, 6).map((n) => Math.round(n))
}

const parseCartValues = (values: string[]): CartesianPose | null => {
  const nums = values.map((part) => Number.parseFloat(part.trim()))
  if (nums.length < 6 || nums.some((n) => Number.isNaN(n))) {
    return null
  }
  return {
    x: nums[0],
    y: nums[1],
    z: nums[2],
    rx: nums[3],
    ry: nums[4],
    rz: nums[5]
  }
}

const frameFromGroup = (
  group: PosGroup
): { frame: CalibFrameType; userFrameId?: number } => {
  const postype = String(group.postype || "").toUpperCase()
  if (postype === "USER") {
    const id = group.user != null ? Number.parseInt(String(group.user), 10) : NaN
    return {
      frame: "USER",
      userFrameId: Number.isNaN(id) ? undefined : id
    }
  }
  return { frame: "BASE" }
}

const primaryPostype = (job: JobFile): string => {
  for (const group of job.posGroups) {
    if (group.postype) {
      return String(group.postype).toUpperCase()
    }
  }
  return "UNKNOWN"
}

const primaryUserFrame = (job: JobFile): number | undefined => {
  for (const group of job.posGroups) {
    if (group.user != null && String(group.user).trim() !== "") {
      const id = Number.parseInt(String(group.user), 10)
      if (!Number.isNaN(id)) {
        return id
      }
    }
  }
  return undefined
}

const resolveStepId = (
  token: string,
  steps: CalibrationStepDef[]
): { stepId: string; pauseTag?: string; source: "calstep" | "pause_tag" } | null => {
  const cal = CALSTEP_RE.exec(token)
  if (cal) {
    const stepId = cal[1]
    const step = getStepById(stepId, steps)
    if (step) {
      return { stepId: step.id, pauseTag: step.pauseTag, source: "calstep" }
    }
    // Accept unknown but well-formed ids from older/custom jobs
    if (/^[a-zA-Z0-9_+-]+$/.test(stepId)) {
      return { stepId, source: "calstep" }
    }
  }
  const pause = PAUSE_TAG_RE.exec(token)
  if (pause) {
    const tag = pause[1]
    const step = steps.find((row) => row.pauseTag === tag)
    if (step) {
      return { stepId: step.id, pauseTag: tag, source: "pause_tag" }
    }
  }
  return null
}

const listReferencedPosKeys = (job: JobFile): Set<string> => {
  const keys = new Set<string>()
  for (const line of job.instLines) {
    const match = MOV_POS_RE.exec(line.raw)
    if (!match) {
      continue
    }
    const parsed = parsePosKindIndex(match[1])
    if (parsed) {
      keys.add(`${parsed.kind}:${parsed.index}`)
    }
  }
  return keys
}

const isTaughtKind = (kind: PosVarKind, pulseMode: boolean): boolean => {
  if (pulseMode) {
    return kind === "C" || kind === "BC" || kind === "EC"
  }
  return kind === "C" || kind === "P" || kind === "BP"
}

const listTaughtPosVars = (job: JobFile, pulseMode: boolean): Array<{
  group: PosGroup
  posVar: PosVar
  key: string
}> => {
  const referenced = listReferencedPosKeys(job)
  const out: Array<{ group: PosGroup; posVar: PosVar; key: string }> = []
  for (const group of job.posGroups) {
    for (const posVar of group.vars) {
      const key = `${posVar.kind}:${posVar.index}`
      if (!isTaughtKind(posVar.kind, pulseMode)) {
        continue
      }
      // Prefer vars actually used in MOV*; else keep all of the right kind
      if (referenced.size > 0 && !referenced.has(key)) {
        continue
      }
      out.push({ group, posVar, key })
    }
  }
  // If nothing referenced (rare), fall back to all matching vars
  if (out.length === 0) {
    for (const group of job.posGroups) {
      for (const posVar of group.vars) {
        if (!isTaughtKind(posVar.kind, pulseMode)) {
          continue
        }
        out.push({ group, posVar, key: `${posVar.kind}:${posVar.index}` })
      }
    }
  }
  return out
}

const countCVars = (job: JobFile): number => {
  let count = 0
  for (const group of job.posGroups) {
    for (const posVar of group.vars) {
      if (posVar.kind === "C") {
        count += 1
      }
    }
  }
  return count
}

const hitFromPos = (
  stepId: string,
  pauseTag: string | undefined,
  source: ExtractedStepHit["source"],
  group: PosGroup,
  posVar: PosVar,
  pulseMode: boolean
): ExtractedStepHit | null => {
  const posRef = `${posVar.kind}${String(posVar.index).padStart(5, "0")}`
  if (pulseMode) {
    const pulses = parsePulseValues(posVar.values)
    if (!pulses) {
      return null
    }
    return { stepId, pauseTag, pulses, posRef, source }
  }
  const cartesian = parseCartValues(posVar.values)
  if (!cartesian) {
    return null
  }
  const { frame, userFrameId } = frameFromGroup(group)
  return { stepId, pauseTag, cartesian, frame, userFrameId, posRef, source }
}

const collectTaggedHits = (
  job: JobFile,
  steps: CalibrationStepDef[],
  pulseMode: boolean,
  warnings: string[]
): Map<string, ExtractedStepHit> => {
  const hitsByStep = new Map<string, ExtractedStepHit>()
  let current: { stepId: string; pauseTag?: string; source: "calstep" | "pause_tag" } | null =
    null

  for (const line of job.instLines) {
    const raw = line.raw
    const fromComment = resolveStepId(raw, steps)
    if (fromComment) {
      current = fromComment
    }
    const msg = MSG_TAG_RE.exec(raw)
    if (msg) {
      const fromMsg = resolveStepId(msg[1], steps)
      if (fromMsg) {
        current = fromMsg
      }
    }
    const mov = MOV_POS_RE.exec(raw)
    if (!mov || !current) {
      continue
    }
    const parsed = parsePosKindIndex(mov[1])
    if (!parsed) {
      continue
    }
    const found = findPosVar(job.posGroups, parsed.kind, parsed.index)
    if (!found) {
      warnings.push(`Position ${mov[1]} referenced but missing from //POS`)
      continue
    }
    const hit = hitFromPos(
      current.stepId,
      current.pauseTag,
      current.source,
      found.group,
      found.posVar,
      pulseMode
    )
    if (hit) {
      hitsByStep.set(hit.stepId, hit)
    }
  }
  return hitsByStep
}

const fillRemainingByOrder = (
  job: JobFile,
  steps: CalibrationStepDef[],
  pulseMode: boolean,
  hitsByStep: Map<string, ExtractedStepHit>,
  warnings: string[]
): void => {
  const missingAfterTags = steps.filter((step) => !hitsByStep.has(step.id))
  if (missingAfterTags.length === 0) {
    return
  }
  const taught = listTaughtPosVars(job, pulseMode)
  const usedKeys = new Set<string>()
  for (const hit of hitsByStep.values()) {
    if (!hit.posRef) {
      continue
    }
    const parsed = parsePosKindIndex(hit.posRef)
    if (parsed) {
      usedKeys.add(`${parsed.kind}:${parsed.index}`)
    }
  }
  let teachIdx = 0
  let usedOrderFallback = false
  for (const step of missingAfterTags) {
    while (teachIdx < taught.length) {
      const row = taught[teachIdx]
      teachIdx += 1
      if (usedKeys.has(row.key)) {
        continue
      }
      const hit = hitFromPos(
        step.id,
        step.pauseTag,
        "order",
        row.group,
        row.posVar,
        pulseMode
      )
      if (hit) {
        hitsByStep.set(step.id, hit)
        usedKeys.add(row.key)
        usedOrderFallback = true
        break
      }
    }
  }
  if (usedOrderFallback) {
    warnings.push(
      "Some steps had no CALSTEP/pause tag match; order-based fill used where possible"
    )
  }
}

const fillByIndex = (
  job: JobFile,
  steps: CalibrationStepDef[],
  pulseMode: boolean,
  hitsByStep: Map<string, ExtractedStepHit>,
  warnings: string[]
): void => {
  const cCount = countCVars(job)
  if (cCount > 0 && cCount !== steps.length) {
    warnings.push(`Position count ${cCount} vs checklist ${steps.length}`)
  }
  steps.forEach((step, index) => {
    if (hitsByStep.has(step.id)) {
      return
    }
    const found = findPosVarForIndex(job.posGroups, index, pulseMode)
    if (!found) {
      return
    }
    const hit = hitFromPos(
      step.id,
      step.pauseTag,
      "index",
      found.group,
      found.posVar,
      pulseMode
    )
    if (hit) {
      hitsByStep.set(step.id, hit)
    }
  })
}

const verifyNumberedComments = (
  job: JobFile,
  steps: CalibrationStepDef[],
  warnings: string[]
): void => {
  let pending: { n: number; text: string } | null = null
  for (const line of job.instLines) {
    const raw = line.raw.trimEnd()
    const comment = NUMBERED_COMMENT_RE.exec(raw)
    if (comment) {
      pending = { n: Number.parseInt(comment[1], 10), text: comment[2].trim() }
      continue
    }
    const mov = MOV_POS_RE.exec(raw)
    if (!mov) {
      if (line.kind !== "comment") {
        pending = null
      }
      continue
    }
    if (!pending) {
      continue
    }
    const parsed = parsePosKindIndex(mov[1])
    if (!parsed) {
      pending = null
      continue
    }
    const step = steps[parsed.index]
    if (!step) {
      warnings.push(
        `Numbered comment '${pending.n} ${pending.text} maps to missing step index ${parsed.index}`
      )
      pending = null
      continue
    }
    const expectedN = parsed.index + 1
    if (pending.n !== expectedN || pending.text !== step.exportLabel) {
      warnings.push(
        `Comment before ${mov[1]} expected '${expectedN} ${step.exportLabel} but found '${pending.n} ${pending.text}`
      )
    }
    pending = null
  }
}

/**
 * Extract taught positions from one CAL STANDARD or RELATIVE job.
 * Primary: C000nn index → steps[n], verified against numbered comments.
 * Fallback: CALSTEP:<id> → pauseTag (STEP_*) → MOV order (older jobs).
 */
export const extractFromCalibrationJob = (
  text: string,
  steps: CalibrationStepDef[],
  expected: "standard" | "relative" | "auto" = "auto",
  nameHint = "CAL"
): JobExtractResult => {
  const job = parseJob(text, nameHint)
  const warnings: string[] = []
  const npos = nposMismatch(job)
  const postype = primaryPostype(job)
  const userFrameId = primaryUserFrame(job)

  let kind: JobExtractResult["kind"] = "unknown"
  if (expected === "standard") {
    kind = "standard"
  } else if (expected === "relative") {
    kind = "relative"
  } else if (postype === "PULSE") {
    kind = "standard"
  } else if (postype === "USER" || postype === "BASE" || postype === "ROBOT") {
    kind = "relative"
  } else if (/STANDARD/i.test(job.name)) {
    kind = "standard"
  } else if (/RELATIVE/i.test(job.name)) {
    kind = "relative"
  }

  if (kind === "standard" && postype !== "PULSE") {
    warnings.push(
      `STANDARD job expected ///POSTYPE PULSE but found ${postype || "missing"}`
    )
  }
  if (kind === "relative" && postype === "PULSE") {
    warnings.push(
      "RELATIVE job expected USER/BASE/ROBOT cartesian POSTYPE but found PULSE"
    )
  }

  const pulseMode = kind !== "relative"
  const taggedHits = collectTaggedHits(job, steps, pulseMode, warnings)
  const hitsByStep = new Map(taggedHits)

  if (taggedHits.size > 0) {
    fillRemainingByOrder(job, steps, pulseMode, hitsByStep, warnings)
  } else {
    fillByIndex(job, steps, pulseMode, hitsByStep, warnings)
  }
  verifyNumberedComments(job, steps, warnings)

  if (hitsByStep.size === 0) {
    warnings.push(
      "No taught positions matched. Expected C000nn in index order with numbered comments, or ' CALSTEP:<id> on older jobs."
    )
  }

  return {
    kind,
    jobName: job.name,
    postype,
    userFrameId,
    hits: [...hitsByStep.values()],
    warnings,
    nposWarning: npos
  }
}

export const mergeJobHits = (
  steps: CalibrationStepDef[],
  standard: JobExtractResult | null,
  relative: JobExtractResult | null
): CalibrationExtractSummary => {
  const warnings: string[] = []
  if (standard?.nposWarning) {
    warnings.push(`STANDARD: ${standard.nposWarning}`)
  }
  if (relative?.nposWarning) {
    warnings.push(`RELATIVE: ${relative.nposWarning}`)
  }
  for (const w of standard?.warnings ?? []) {
    warnings.push(`STANDARD: ${w}`)
  }
  for (const w of relative?.warnings ?? []) {
    warnings.push(`RELATIVE: ${w}`)
  }
  if (standard && standard.kind !== "standard" && standard.kind !== "unknown") {
    warnings.push("Loaded file for STANDARD does not look like a pulse job")
  }
  if (relative && relative.kind !== "relative" && relative.kind !== "unknown") {
    warnings.push("Loaded file for RELATIVE does not look like a cartesian job")
  }

  const pulseById = new Map(
    (standard?.hits ?? []).map((hit) => [hit.stepId, hit] as const)
  )
  const cartById = new Map(
    (relative?.hits ?? []).map((hit) => [hit.stepId, hit] as const)
  )

  const filled: ExtractedStepHit[] = []
  const missingPulseStepIds: string[] = []
  const missingCartStepIds: string[] = []

  for (const step of steps) {
    const pulseHit = pulseById.get(step.id)
    const cartHit = cartById.get(step.id)
    if (!pulseHit?.pulses && !cartHit?.cartesian) {
      continue
    }
    filled.push({
      stepId: step.id,
      pauseTag: step.pauseTag,
      pulses: pulseHit?.pulses,
      cartesian: cartHit?.cartesian,
      frame: cartHit?.frame ?? "BASE",
      userFrameId: cartHit?.userFrameId ?? step.userFrameId,
      posRef: pulseHit?.posRef ?? cartHit?.posRef,
      source: pulseHit?.source ?? cartHit?.source ?? "index"
    })
    if (!pulseHit?.pulses) {
      missingPulseStepIds.push(step.id)
    }
    if (!cartHit?.cartesian) {
      missingCartStepIds.push(step.id)
    }
  }

  // Orphan hits not in current checklist
  for (const hit of standard?.hits ?? []) {
    if (!steps.some((step) => step.id === hit.stepId)) {
      warnings.push(`STANDARD has unexpected step id ${hit.stepId}`)
    }
  }
  for (const hit of relative?.hits ?? []) {
    if (!steps.some((step) => step.id === hit.stepId)) {
      warnings.push(`RELATIVE has unexpected step id ${hit.stepId}`)
    }
  }

  return {
    standard,
    relative,
    filled,
    missingPulseStepIds,
    missingCartStepIds,
    warnings
  }
}

export const extractCalibrationPair = (
  standardText: string | null,
  relativeText: string | null,
  steps: CalibrationStepDef[],
  names?: { standardHint?: string; relativeHint?: string }
): CalibrationExtractSummary => {
  const standard = standardText
    ? extractFromCalibrationJob(
        standardText,
        steps,
        "standard",
        names?.standardHint ?? "CAL_STANDARD"
      )
    : null
  const relative = relativeText
    ? extractFromCalibrationJob(
        relativeText,
        steps,
        "relative",
        names?.relativeHint ?? "CAL_RELATIVE"
      )
    : null
  return mergeJobHits(steps, standard, relative)
}

/** Pure merge of extracted pulses/cartesians into session samples (no I/O). */
export const mergeExtractionIntoSession = (
  session: CalibrationSession,
  summary: CalibrationExtractSummary,
  steps: CalibrationStepDef[]
): CalibrationSession => {
  const now = new Date().toISOString()
  let samples = [...session.samples]

  for (const hit of summary.filled) {
    const step = getStepById(hit.stepId, steps)
    const existing = samples.find((row) => row.stepId === hit.stepId)
    const next: CalibrationSample = {
      stepId: hit.stepId,
      pulses: hit.pulses ?? existing?.pulses,
      cartesian: hit.cartesian ?? existing?.cartesian,
      frame: hit.frame ?? existing?.frame ?? step?.defaultFrame ?? "BASE",
      userFrameId:
        hit.userFrameId ?? existing?.userFrameId ?? step?.userFrameId,
      label: step?.id ?? hit.stepId,
      capturedAt: existing?.capturedAt ?? now,
      pulseCapturedAt: hit.pulses ? now : existing?.pulseCapturedAt,
      cartCapturedAt: hit.cartesian ? now : existing?.cartCapturedAt,
      skipped: false,
      notes: [
        existing?.notes,
        hit.pulses ? `pulse from JBI extract (${hit.source})` : null,
        hit.cartesian ? `cart from JBI extract (${hit.source})` : null
      ]
        .filter(Boolean)
        .join("; ")
    }
    samples = samples.filter((row) => row.stepId !== hit.stepId)
    samples.push(next)
  }

  return {
    ...session,
    version: 2,
    updatedAt: now,
    samples,
    notes: [
      session.notes,
      `Extracted ${summary.filled.length} step(s) from uploaded CAL jobs @ ${now}`
    ]
      .filter(Boolean)
      .join("\n")
  }
}

/** Merge extract hits into session and persist to localStorage. */
export const applyExtractionToSession = (
  session: CalibrationSession,
  summary: CalibrationExtractSummary,
  steps: CalibrationStepDef[]
): CalibrationSession => {
  return saveSessionLocal(mergeExtractionIntoSession(session, summary, steps))
}
