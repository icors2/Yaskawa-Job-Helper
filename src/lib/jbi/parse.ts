import type {
  HeaderLine,
  InstLine,
  JobFile,
  PosGroup,
  PosType,
  PosVar,
  PosVarKind
} from "./model"
import { emptyJob } from "./model"

const POS_VAR_RE = /^(C|BC|EC|P|BP|EX)(\d+)=(.*)$/

const splitLines = (text: string): { lines: string[]; newline: "\r\n" | "\n" } => {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const endsWithNewline = normalized.endsWith("\n")
  const body = endsWithNewline ? normalized.slice(0, -1) : normalized
  return { lines: body.length === 0 ? [] : body.split("\n"), newline }
}

const parseHeader = (raw: string): HeaderLine => {
  const trimmed = raw.trimEnd()
  if (trimmed.startsWith("///")) {
    const rest = trimmed.slice(3)
    const space = rest.search(/\s/)
    if (space === -1) {
      return { key: rest, value: "", raw }
    }
    return {
      key: rest.slice(0, space),
      value: rest.slice(space + 1).trimStart(),
      raw
    }
  }
  if (trimmed.startsWith("//")) {
    const rest = trimmed.slice(2)
    const space = rest.search(/\s/)
    if (space === -1) {
      return { key: rest, value: "", raw }
    }
    return {
      key: rest.slice(0, space),
      value: rest.slice(space + 1).trimStart(),
      raw
    }
  }
  return { key: "", value: trimmed, raw }
}

const parsePosVar = (raw: string): PosVar | null => {
  const match = POS_VAR_RE.exec(raw.trimEnd())
  if (!match) {
    return null
  }
  return {
    kind: match[1] as PosVarKind,
    index: Number.parseInt(match[2], 10),
    values: match[3].split(","),
    raw
  }
}

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

const emptyGroup = (): PosGroup => ({
  postype: "PULSE",
  headers: [],
  vars: []
})

const finalizeGroup = (group: PosGroup): PosGroup => {
  for (const header of group.headers) {
    if (header.key === "POSTYPE") {
      group.postype = header.value.trim() as PosType
    }
    if (header.key === "USER") {
      group.user = header.value.trim()
    }
    if (header.key === "TOOL") {
      group.tool = header.value.trim()
    }
  }
  return group
}

export const parseJob = (text: string, nameHint = "UNNAMED"): JobFile => {
  const { lines, newline } = splitLines(text)
  const job = emptyJob(nameHint)
  job.newline = newline === "\r\n" ? "\r\n" : "\r\n"

  let section: "pre" | "pos" | "inst" = "pre"
  let current = emptyGroup()
  let posStarted = false

  const pushGroup = () => {
    if (!posStarted && current.headers.length === 0 && current.vars.length === 0) {
      return
    }
    job.posGroups.push(finalizeGroup(current))
    current = emptyGroup()
    posStarted = true
  }

  for (const line of lines) {
    if (section === "pre") {
      if (line === "//POS") {
        section = "pos"
        continue
      }
      if (line === "/JOB") {
        continue
      }
      const header = parseHeader(line)
      job.headers.push(header)
      if (header.key === "NAME" && header.value) {
        job.name = header.value.trim()
      }
      continue
    }

    if (section === "pos") {
      if (line === "//INST") {
        pushGroup()
        section = "inst"
        continue
      }
      const posVar = parsePosVar(line)
      if (posVar) {
        current.vars.push(posVar)
        posStarted = true
        continue
      }
      if (line.startsWith("///")) {
        if (current.vars.length > 0) {
          pushGroup()
        }
        current.headers.push(parseHeader(line))
        posStarted = true
        continue
      }
      // Unexpected POS line — keep as a synthetic header so we do not drop bytes.
      current.headers.push({ key: "", value: line, raw: line })
      posStarted = true
      continue
    }

    // INST section
    if (line.startsWith("///")) {
      job.instHeaders.push(parseHeader(line))
      continue
    }
    job.instLines.push({ raw: line, kind: classifyInst(line) })
  }

  if (section === "pos") {
    pushGroup()
  }

  return job
}

export const countPosKinds = (
  groups: PosGroup[]
): Record<PosVarKind, number> => {
  const counts: Record<PosVarKind, number> = {
    C: 0,
    BC: 0,
    EC: 0,
    P: 0,
    BP: 0,
    EX: 0
  }
  for (const group of groups) {
    for (const posVar of group.vars) {
      counts[posVar.kind] += 1
    }
  }
  return counts
}

export const storedNpos = (groups: PosGroup[]): number[] | null => {
  for (const group of groups) {
    for (const header of group.headers) {
      if (header.key === "NPOS") {
        return header.value.split(",").map((part) => Number.parseInt(part.trim(), 10))
      }
    }
  }
  return null
}

export const nposMismatch = (job: JobFile): string | null => {
  const stored = storedNpos(job.posGroups)
  if (!stored || stored.length !== 6) {
    return null
  }
  const counts = countPosKinds(job.posGroups)
  const expected = [counts.C, counts.BC, counts.EC, counts.P, counts.BP, counts.EX]
  for (let i = 0; i < 6; i += 1) {
    if (stored[i] !== expected[i]) {
      return `NPOS mismatch: stored ${stored.join(",")} vs counted ${expected.join(",")}`
    }
  }
  return null
}
