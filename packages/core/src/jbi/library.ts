import { parseJob } from "./parse"
import { serializeJob } from "./serialize"
import type { JobFile } from "./model"

export interface JobRef {
  name: string
  path: string
  folderName?: string
  positionCount: number
  postypes: string[]
}

export interface CallEdge {
  fromJob: string
  toJob: string
  kind: "CALL" | "PSTART"
  lineIndex: number
  raw: string
}

export interface LibraryIndex {
  root: string
  jobs: JobRef[]
  graph: CallEdge[]
  byName: Record<string, JobRef>
  parseErrors: { path: string; message: string }[]
}

const CALL_RE = /\b(CALL|PSTART)\s+JOB:([^\s]+)/i

const folderFromJob = (job: JobFile): string | undefined => {
  for (const header of job.headers) {
    if (header.key === "FOLDERNAME") {
      return header.value.trim()
    }
  }
  return undefined
}

const collectEdges = (job: JobFile, fromName: string): CallEdge[] => {
  const edges: CallEdge[] = []
  job.instLines.forEach((line, lineIndex) => {
    const match = CALL_RE.exec(line.raw)
    if (!match) {
      return
    }
    edges.push({
      fromJob: fromName,
      toJob: match[2],
      kind: match[1].toUpperCase() as "CALL" | "PSTART",
      lineIndex,
      raw: line.raw
    })
  })
  return edges
}

export interface IndexedFile {
  path: string
  relativePath: string
  text: string
}

export const indexLibraryFromTexts = (
  root: string,
  files: IndexedFile[]
): LibraryIndex => {
  const jobs: JobRef[] = []
  const graph: CallEdge[] = []
  const byName: Record<string, JobRef> = {}
  const parseErrors: { path: string; message: string }[] = []

  for (const file of files) {
    try {
      const job = parseJob(file.text, file.relativePath.replace(/\.JBI$/i, ""))
      const postypes = [...new Set(job.posGroups.map((group) => String(group.postype)))]
      const positionCount = job.posGroups.reduce((sum, group) => sum + group.vars.length, 0)
      const ref: JobRef = {
        name: job.name,
        path: file.path,
        folderName: folderFromJob(job),
        positionCount,
        postypes
      }
      jobs.push(ref)
      byName[job.name] = ref
      graph.push(...collectEdges(job, job.name))
    } catch (error) {
      parseErrors.push({
        path: file.path,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { root, jobs, graph, byName, parseErrors }
}

export const rewriteReferencesInText = (
  text: string,
  fromName: string,
  toName: string
): { text: string; changes: number } => {
  const job = parseJob(text)
  let changes = 0
  job.instLines = job.instLines.map((line) => {
    const pattern = new RegExp(`\\b(CALL|PSTART)\\s+JOB:${escapeRegExp(fromName)}\\b`, "gi")
    if (!pattern.test(line.raw)) {
      return line
    }
    changes += 1
    return {
      ...line,
      raw: line.raw.replace(
        new RegExp(`\\b(CALL|PSTART)\\s+JOB:${escapeRegExp(fromName)}\\b`, "gi"),
        `$1 JOB:${toName}`
      )
    }
  })
  if (changes === 0) {
    return { text, changes: 0 }
  }
  return { text: serializeJob(job), changes }
}

export const renameJobText = (text: string, toName: string): string => {
  const job = parseJob(text)
  job.name = toName
  for (const header of job.headers) {
    if (header.key === "NAME") {
      header.value = toName
      header.raw = `//NAME ${toName}`
    }
  }
  return serializeJob(job)
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
