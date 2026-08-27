/**
 * Readers for Yaskawa YRC1000 UFRAME.CND, TOOL.CND, and RC.PRM.
 * Ported from `kinematics/cnd.py`; takes file text so it works in the browser.
 */

import { RC_PRM_PULSE_LIMITS_NEG, RC_PRM_PULSE_LIMITS_POS } from "./fk"
import { poseFromXyzRpy } from "./pose"
import type { ToolRecord, UserFrame } from "./types"

export interface RcPrmGeometry {
  row1: number[]
  row2: number[]
  linkLengthsMm: Record<string, number>
  pulseLimitsPos: number[]
  pulseLimitsNeg: number[]
  hypothesisHolds: boolean
  notes: string[]
}

const AR2010_LINKS: Record<string, number> = {
  a1: 150,
  a2: 760,
  a3: 200,
  d4: 1082,
  d6: 100
}

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/)

const parseNumbers = (text: string): number[] =>
  text
    .replace(/=/g, " ")
    .split(",")
    .filter((part) => part.trim().length > 0)
    .map((part) => Number.parseFloat(part))
    .filter((value) => Number.isFinite(value))

const firstInt = (token: string): number => {
  const match = token.match(/-?\d+/)
  if (!match) {
    throw new Error(`no integer in ${JSON.stringify(token)}`)
  }
  return Number.parseInt(match[0], 10)
}

const lastToken = (line: string): string => {
  const parts = line.split(/\s+/).filter(Boolean)
  return parts[parts.length - 1] ?? ""
}

const afterEquals = (line: string): string => {
  const index = line.indexOf("=")
  return index >= 0 ? line.slice(index + 1) : line
}

interface PendingFrame {
  id: number
  name: string
  toolId: number
  group: number[]
  rorg: number[] | null
  rxx: number[] | null
  rxy: number[] | null
  buser: UserFrame["buser"] | null
}

const emptyPendingFrame = (id: number): PendingFrame => ({
  id,
  name: "",
  toolId: 0,
  group: [],
  rorg: null,
  rxx: null,
  rxy: null,
  buser: null
})

export const parseUframeCnd = (text: string): UserFrame[] => {
  const frames: UserFrame[] = []
  let current: PendingFrame | null = null

  const flush = (): void => {
    if (!current) {
      return
    }
    if (!current.rorg || !current.buser) {
      throw new Error(`UFRAME ${current.id} is missing RORG/BUSER`)
    }
    frames.push({
      id: current.id,
      name: current.name,
      toolId: current.toolId,
      rorg: current.rorg,
      rxx: current.rxx ?? [],
      rxy: current.rxy ?? [],
      buser: current.buser
    })
  }

  for (const raw of splitLines(text)) {
    const line = raw.trim()
    if (line.startsWith("//UFRAME")) {
      flush()
      current = emptyPendingFrame(firstInt(lastToken(line)))
      continue
    }
    if (!current) {
      continue
    }
    if (line.startsWith("///NAME")) {
      current.name = line.slice(7).trim()
    } else if (line.startsWith("///TOOL")) {
      current.toolId = firstInt(lastToken(line))
    } else if (line.startsWith("///GROUP")) {
      current.group = parseNumbers(line.replace(/^\S+\s*/, "")).map((value) => Math.trunc(value))
    } else if (line.includes("RORG")) {
      current.rorg = parseNumbers(afterEquals(line))
    } else if (line.includes("RXX")) {
      current.rxx = parseNumbers(afterEquals(line))
    } else if (line.includes("RXY")) {
      current.rxy = parseNumbers(afterEquals(line))
    } else if (line.includes("BUSER")) {
      let values = parseNumbers(line.includes("=") ? afterEquals(line) : lastToken(line))
      if (values.length === 0) {
        values = parseNumbers(line.replace("////BUSER", ""))
      }
      if (values.length < 6) {
        values = parseNumbers(line)
      }
      current.buser = poseFromXyzRpy(values)
    }
  }
  flush()
  return frames
}

export const parseToolCnd = (text: string): ToolRecord[] => {
  const tools: ToolRecord[] = []
  let currentId: number | null = null
  let currentName = ""
  let pendingNumeric = false

  for (const raw of splitLines(text)) {
    const line = raw.trim()
    if (line.startsWith("//TOOL")) {
      currentId = firstInt(lastToken(line))
      currentName = ""
      pendingNumeric = true
      continue
    }
    if (currentId === null) {
      continue
    }
    if (line.startsWith("///NAME")) {
      currentName = line.slice(7).trim()
      continue
    }
    if (line.startsWith("///")) {
      continue
    }
    if (pendingNumeric && line.length > 0 && /[\d+-]/.test(line[0])) {
      tools.push({
        id: currentId,
        name: currentName,
        tcp: poseFromXyzRpy(parseNumbers(line))
      })
      pendingNumeric = false
    }
  }
  return tools
}

/** Find soft-limit rows inside ///RC1G (six large pulse values each). */
const extractPulseLimits = (dataRows: number[][]): [number[], number[]] => {
  for (let index = 0; index < dataRows.length - 1; index += 1) {
    const pos = dataRows[index].slice(0, 6)
    const neg = dataRows[index + 1].slice(0, 6)
    if (pos.length < 6 || neg.length < 6) {
      continue
    }
    if (!pos.every((value) => Math.abs(value) > 10_000)) {
      continue
    }
    if (!neg.every((value) => Math.abs(value) > 10_000)) {
      continue
    }
    // Soft limits: positive row mostly +, negative row mostly -
    if (pos.filter((value) => value > 0).length < 4) {
      continue
    }
    if (neg.filter((value) => value < 0).length < 4) {
      continue
    }
    return [pos, neg]
  }
  return [[...RC_PRM_PULSE_LIMITS_POS], [...RC_PRM_PULSE_LIMITS_NEG]]
}

export const parseRcPrm = (text: string): RcPrmGeometry => {
  const dataRows: number[][] = []
  let inRc1g = false
  for (const raw of splitLines(text)) {
    const line = raw.trim()
    if (line.startsWith("///RC1G")) {
      inRc1g = true
      continue
    }
    if (inRc1g && line.startsWith("///")) {
      break
    }
    if (inRc1g && line.length > 0 && (/\d/.test(line[0]) || line.startsWith("-"))) {
      dataRows.push(parseNumbers(line))
    }
  }
  const row1 = dataRows[0] ?? []
  const row2 = dataRows[1] ?? []

  const microns: Record<string, number | null> = {
    a1: row1.length > 1 ? row1[1] / 1000 : null,
    a2: row1.length > 3 ? row1[3] / 1000 : null,
    a3: row1.length > 5 ? row1[5] / 1000 : null,
    d4: row1.length > 8 ? row1[8] / 1000 : null,
    d6: row2.length > 2 ? row2[2] / 1000 : null
  }
  const [pulseLimitsPos, pulseLimitsNeg] = extractPulseLimits(dataRows)
  const notes = [
    "RC1G microns → mm: a1/a2/a3/d4 from row1, d6 from row2 (Motoman S-L-U-R-B-T).",
    "505 mm floor-to-S height is not in RC1G; Yaskawa BASE is the S/L intersection.",
    `Pulse soft-limits decoded from RC1G: +${pulseLimitsPos.join(", ")} / ${pulseLimitsNeg.join(", ")}.`
  ]
  const linkLengthsMm: Record<string, number> = {}
  for (const [name, value] of Object.entries(microns)) {
    if (value !== null) {
      linkLengthsMm[name] = value
    }
  }
  const hypothesisHolds = Object.entries(microns).every(
    ([name, value]) => value !== null && Math.abs(value - AR2010_LINKS[name]) < 1e-6
  )
  notes.push(
    hypothesisHolds
      ? "AR2010 template match: 150/760/200/1082/100 mm from RC1G microns."
      : `Non-AR2010 or unverified geometry. Decoded link lengths (mm): ${JSON.stringify(linkLengthsMm)}`
  )

  return {
    row1,
    row2,
    linkLengthsMm,
    pulseLimitsPos,
    pulseLimitsNeg,
    hypothesisHolds,
    notes
  }
}

export const findFrame = (frames: UserFrame[], frameId: number): UserFrame => {
  const found = frames.find((frame) => frame.id === frameId)
  if (!found) {
    throw new Error(`user frame ${frameId} not found`)
  }
  return found
}

export const findTool = (tools: ToolRecord[], toolId: number): ToolRecord => {
  const found = tools.find((tool) => tool.id === toolId)
  if (!found) {
    throw new Error(`tool ${toolId} not found`)
  }
  return found
}
