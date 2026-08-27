import type { InstLine, JobFile } from "./model"
import { parseJob } from "./parse"
import { serializeJob } from "./serialize"
import {
  inventoryHas,
  inventoryLabel,
  type WeldConditionInventory,
  type WeldKind
} from "./cnd"

export type SpeedKind = "V" | "VJ"

/** Which motion lines to touch when editing speeds. */
export type SpeedScope = "all" | "weld" | "travel"

export type MotionSpeedClass = "joint" | "linear" | "other"

export interface EditResult {
  text: string
  changes: number
  notes: string[]
}

const speedTokenRe = (): RegExp => /\b(VJ|V)=([0-9]+(?:\.[0-9]+)?)/g
const weldTokenRe = (): RegExp => /\b(ASF|AEF|WEV)#\((\d+)\)/g
const posRefRe = (): RegExp => /\b(C|BC|EC|P|BP|EX)(\d+)\b/gi
const motionOpcodeRe = (): RegExp => /^\s*(MOVJ|MOVL|MOVC|SMOVL)\b/i
const arconRe = (): RegExp => /^\s*ARCON\b/i
const arcofRe = (): RegExp => /^\s*ARCOF\b/i

const classifyInst = (raw: string): InstLine["kind"] => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return "blank"
  }
  if (trimmed.startsWith("'")) {
    return "comment"
  }
  if (trimmed.startsWith("*")) {
    return "label"
  }
  return "instruction"
}

const cloneJob = (job: JobFile): JobFile => ({
  ...job,
  headers: job.headers.map((header) => ({ ...header })),
  posGroups: job.posGroups,
  instHeaders: job.instHeaders.map((header) => ({ ...header })),
  instLines: job.instLines.map((line) => ({ ...line }))
})

const posKey = (kind: string, index: number): string =>
  `${kind.toUpperCase()}:${index}`

const collectDefinedPositions = (job: JobFile): Map<string, string> => {
  const defined = new Map<string, string>()
  for (const group of job.posGroups) {
    for (const posVar of group.vars) {
      const key = posKey(posVar.kind, posVar.index)
      const label = posVar.raw.split("=")[0] ?? `${posVar.kind}${posVar.index}`
      defined.set(key, label)
    }
  }
  return defined
}

const collectReferencedPositions = (job: JobFile): Set<string> => {
  const refs = new Set<string>()
  for (const line of job.instLines) {
    for (const match of line.raw.matchAll(posRefRe())) {
      refs.add(posKey(match[1], Number.parseInt(match[2], 10)))
    }
  }
  return refs
}

export const findUnreferencedPositions = (job: JobFile): string[] => {
  const defined = collectDefinedPositions(job)
  const refs = collectReferencedPositions(job)
  const orphaned: string[] = []
  for (const [key, label] of defined) {
    if (!refs.has(key)) {
      orphaned.push(label)
    }
  }
  return orphaned
}

const normalizeIndices = (indices: number[], length: number): number[] => {
  if (indices.length === 0) {
    return Array.from({ length }, (_, i) => i)
  }
  const unique = [...new Set(indices)].filter((i) => i >= 0 && i < length)
  return unique.sort((a, b) => a - b)
}

export const insertInstLine = (
  job: JobFile,
  index: number,
  raw: string
): JobFile => {
  const next = cloneJob(job)
  const at = Math.max(0, Math.min(index, next.instLines.length))
  next.instLines.splice(at, 0, { raw, kind: classifyInst(raw) })
  return next
}

export const deleteInstLines = (
  job: JobFile,
  indices: number[]
): { job: JobFile; removed: number; unreferenced: string[] } => {
  const next = cloneJob(job)
  const remove = new Set(normalizeIndices(indices, next.instLines.length))
  if (remove.size === 0) {
    return { job: next, removed: 0, unreferenced: findUnreferencedPositions(next) }
  }
  next.instLines = next.instLines.filter((_, i) => !remove.has(i))
  return {
    job: next,
    removed: remove.size,
    unreferenced: findUnreferencedPositions(next)
  }
}

export const moveInstLine = (
  job: JobFile,
  from: number,
  to: number
): JobFile | null => {
  const next = cloneJob(job)
  if (from < 0 || from >= next.instLines.length) {
    return null
  }
  const target = Math.max(0, Math.min(to, next.instLines.length - 1))
  if (from === target) {
    return next
  }
  const [line] = next.instLines.splice(from, 1)
  next.instLines.splice(target, 0, line)
  return next
}

export const reorderInstLines = (
  job: JobFile,
  from: number,
  direction: "up" | "down"
): JobFile | null => {
  const delta = direction === "up" ? -1 : 1
  return moveInstLine(job, from, from + delta)
}

/** Classify motion opcode for speed modifier rules. */
export const motionSpeedClass = (raw: string): MotionSpeedClass => {
  const match = raw.match(motionOpcodeRe())
  if (!match) {
    return "other"
  }
  const op = match[1].toUpperCase()
  if (op === "MOVJ") {
    return "joint"
  }
  if (op === "MOVL" || op === "MOVC" || op === "SMOVL") {
    return "linear"
  }
  return "other"
}

/** VJ= only on MOVJ; V= only on MOVL / MOVC / SMOVL. */
export const speedKindAllowedOnLine = (raw: string, kind: SpeedKind): boolean => {
  const cls = motionSpeedClass(raw)
  if (kind === "VJ") {
    return cls === "joint"
  }
  return cls === "linear"
}

/**
 * Strip illegal speed modifiers (V on MOVJ, VJ on linear, or dual tokens).
 * Returns the cleaned line and whether anything was removed.
 */
export const sanitizeSpeedModifiers = (raw: string): { raw: string; changed: boolean } => {
  const cls = motionSpeedClass(raw)
  if (cls === "other") {
    return { raw, changed: false }
  }
  let changed = false
  const next = raw.replace(speedTokenRe(), (full, tokenKind: string) => {
    if (cls === "joint" && tokenKind === "V") {
      changed = true
      return ""
    }
    if (cls === "linear" && tokenKind === "VJ") {
      changed = true
      return ""
    }
    return full
  })
  if (!changed) {
    return { raw, changed: false }
  }
  const cleaned = next.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, "").replace(/[ \t]+\//g, " /")
  return { raw: cleaned, changed: true }
}

/**
 * Indices of instruction lines that sit strictly between ARCON and ARCOF
 * (weld path). Nested ARCON/ARCOF pairs are handled with a depth counter.
 */
export const weldSegmentLineIndices = (job: JobFile): Set<number> => {
  const inWeld = new Set<number>()
  let depth = 0
  job.instLines.forEach((line, index) => {
    if (arconRe().test(line.raw)) {
      depth += 1
      return
    }
    if (arcofRe().test(line.raw)) {
      if (depth > 0) {
        depth -= 1
      }
      return
    }
    if (depth > 0) {
      inWeld.add(index)
    }
  })
  return inWeld
}

const lineMatchesScope = (
  index: number,
  weldLines: Set<number>,
  scope: SpeedScope
): boolean => {
  if (scope === "all") {
    return true
  }
  const isWeld = weldLines.has(index)
  if (scope === "weld") {
    return isWeld
  }
  return !isWeld
}

const formatSpeedValue = (value: number, template: string): string => {
  const dot = template.indexOf(".")
  const decimals = dot === -1 ? 0 : template.length - dot - 1
  const place = 10 ** decimals
  // toPrecision clears binary float noise (e.g. 211.7 * 0.5 → 105.85).
  const cleaned = Number.parseFloat(value.toPrecision(12))
  const rounded = Math.round(cleaned * place) / place
  if (decimals === 0) {
    return String(Math.round(rounded))
  }
  return rounded.toFixed(decimals)
}

const appendSpeedToken = (raw: string, kind: SpeedKind, formatted: string): string => {
  const token = `${kind}=${formatted}`
  const commentIdx = raw.search(/\s+\/\//)
  if (commentIdx >= 0) {
    return `${raw.slice(0, commentIdx)} ${token}${raw.slice(commentIdx)}`
  }
  return `${raw.trimEnd()} ${token}`
}

const rewriteSpeedOnLine = (
  raw: string,
  kind: SpeedKind,
  mode: { type: "set"; value: number } | { type: "scale"; factor: number }
): { raw: string; changed: boolean } => {
  if (!speedKindAllowedOnLine(raw, kind)) {
    return { raw, changed: false }
  }
  const sanitized = sanitizeSpeedModifiers(raw)
  let working = sanitized.raw
  let changed = sanitized.changed
  let found = false
  const next = working.replace(speedTokenRe(), (full, tokenKind: string, digits: string) => {
    if (tokenKind !== kind) {
      return full
    }
    found = true
    const current = Number.parseFloat(digits)
    if (!Number.isFinite(current)) {
      return full
    }
    const value =
      mode.type === "set" ? mode.value : current * mode.factor
    if (!Number.isFinite(value) || value < 0) {
      return full
    }
    changed = true
    return `${tokenKind}=${formatSpeedValue(value, digits)}`
  })
  working = next
  if (found || mode.type === "scale") {
    return { raw: working, changed }
  }
  if (mode.type === "set" && classifyInst(working) === "instruction") {
    return {
      raw: appendSpeedToken(working, kind, formatSpeedValue(mode.value, mode.value.toFixed(2))),
      changed: true
    }
  }
  return { raw: working, changed }
}

export const setSpeeds = (
  job: JobFile,
  indices: number[],
  kind: SpeedKind,
  value: number,
  scope: SpeedScope = "all"
): { job: JobFile; changes: number } => {
  const next = cloneJob(job)
  const weldLines = weldSegmentLineIndices(next)
  const targets = normalizeIndices(indices, next.instLines.length).filter((i) =>
    lineMatchesScope(i, weldLines, scope)
  )
  let changes = 0
  for (const i of targets) {
    const result = rewriteSpeedOnLine(next.instLines[i].raw, kind, {
      type: "set",
      value
    })
    if (result.changed) {
      next.instLines[i] = {
        ...next.instLines[i],
        raw: result.raw,
        kind: classifyInst(result.raw)
      }
      changes += 1
    }
  }
  return { job: next, changes }
}

export const scaleSpeeds = (
  job: JobFile,
  indices: number[],
  kind: SpeedKind | "both",
  factor: number,
  scope: SpeedScope = "all"
): { job: JobFile; changes: number } => {
  const next = cloneJob(job)
  const weldLines = weldSegmentLineIndices(next)
  const targets = normalizeIndices(indices, next.instLines.length).filter((i) =>
    lineMatchesScope(i, weldLines, scope)
  )
  let changes = 0
  const kinds: SpeedKind[] = kind === "both" ? ["V", "VJ"] : [kind]
  for (const i of targets) {
    let raw = next.instLines[i].raw
    let lineChanged = false
    for (const speedKind of kinds) {
      const result = rewriteSpeedOnLine(raw, speedKind, { type: "scale", factor })
      raw = result.raw
      if (result.changed) {
        lineChanged = true
      }
    }
    if (lineChanged) {
      next.instLines[i] = { ...next.instLines[i], raw, kind: classifyInst(raw) }
      changes += 1
    }
  }
  return { job: next, changes }
}

export const setWeldConditions = (
  job: JobFile,
  indices: number[],
  kind: WeldKind,
  condition: number
): { job: JobFile; changes: number } => {
  const next = cloneJob(job)
  const targets = normalizeIndices(indices, next.instLines.length)
  let changes = 0
  for (const i of targets) {
    let lineChanged = false
    const raw = next.instLines[i].raw.replace(
      weldTokenRe(),
      (full, tokenKind: string) => {
        if (tokenKind !== kind) {
          return full
        }
        lineChanged = true
        return `${tokenKind}#(${condition})`
      }
    )
    if (lineChanged) {
      next.instLines[i] = { ...next.instLines[i], raw }
      changes += 1
    }
  }
  return { job: next, changes }
}

export interface WeldConditionHit {
  lineIndex: number
  kind: WeldKind
  number: number
  raw: string
  valid: boolean | null
}

export const listWeldConditions = (
  job: JobFile,
  inventory?: WeldConditionInventory | null
): WeldConditionHit[] => {
  const hits: WeldConditionHit[] = []
  job.instLines.forEach((line, lineIndex) => {
    for (const match of line.raw.matchAll(weldTokenRe())) {
      const kind = match[1] as WeldKind
      const number = Number.parseInt(match[2], 10)
      const valid =
        inventory == null
          ? null
          : inventoryHas(inventory, kind, number)
      hits.push({
        lineIndex,
        kind,
        number,
        raw: line.raw,
        valid
      })
    }
  })
  return hits
}

export const flagInvalidWeldConditions = (
  job: JobFile,
  inventory: WeldConditionInventory
): string[] => {
  return listWeldConditions(job, inventory)
    .filter((hit) => hit.valid === false)
    .map(
      (hit) =>
        `Line ${hit.lineIndex}: ${hit.kind}#(${hit.number}) not in ${inventoryLabel(hit.kind)}`
    )
}

export const applyJobEdit = (job: JobFile): string => serializeJob(job)

export const editJobText = (
  text: string,
  mutate: (job: JobFile) => { job: JobFile; changes: number; notes?: string[] }
): EditResult => {
  const job = parseJob(text)
  const result = mutate(job)
  if (result.changes === 0 && (result.notes?.length ?? 0) === 0) {
    return { text, changes: 0, notes: result.notes ?? [] }
  }
  return {
    text: serializeJob(result.job),
    changes: result.changes,
    notes: result.notes ?? []
  }
}
