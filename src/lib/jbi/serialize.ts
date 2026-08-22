import type { JobFile } from "./model"
import { countPosKinds } from "./parse"
import type { PosGroup, PosVarKind } from "./model"

const NL = "\r\n"

const formatNpos = (groups: PosGroup[]): string => {
  const counts = countPosKinds(groups)
  const order: PosVarKind[] = ["C", "BC", "EC", "P", "BP", "EX"]
  return order.map((kind) => String(counts[kind])).join(",")
}

const rewriteNposRaw = (raw: string, npos: string): string => {
  const match = /^(\/\/\/NPOS\s+)/.exec(raw)
  if (!match) {
    return `///NPOS ${npos}`
  }
  return `${match[1]}${npos}`
}

export const serializeJob = (
  job: JobFile,
  options?: { recomputeNpos?: boolean }
): string => {
  const recomputeNpos = options?.recomputeNpos === true
  const nposValue = recomputeNpos ? formatNpos(job.posGroups) : null
  const lines: string[] = ["/JOB"]

  for (const header of job.headers) {
    if (recomputeNpos && header.key === "NAME") {
      lines.push(`//NAME ${job.name}`)
      continue
    }
    lines.push(header.raw)
  }

  lines.push("//POS")
  let nposEmitted = false
  for (const group of job.posGroups) {
    for (const header of group.headers) {
      if (header.key === "NPOS" && nposValue !== null) {
        lines.push(rewriteNposRaw(header.raw, nposValue))
        nposEmitted = true
        continue
      }
      if (header.key === "NPOS") {
        nposEmitted = true
      }
      lines.push(header.raw)
    }
    for (const posVar of group.vars) {
      lines.push(posVar.raw)
    }
  }

  if (recomputeNpos && !nposEmitted) {
    const posIndex = lines.indexOf("//POS")
    lines.splice(posIndex + 1, 0, `///NPOS ${nposValue}`)
  }

  lines.push("//INST")
  for (const header of job.instHeaders) {
    lines.push(header.raw)
  }
  for (const inst of job.instLines) {
    lines.push(inst.raw)
  }

  return `${lines.join(NL)}${NL}`
}

export const recomputeNposLine = (job: JobFile): string => `///NPOS ${formatNpos(job.posGroups)}`
