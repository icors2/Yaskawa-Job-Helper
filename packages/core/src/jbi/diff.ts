/** Minimal unified diff for mandatory write preview. */

export const unifiedDiff = (
  before: string,
  after: string,
  fromLabel = "a",
  toLabel = "b"
): string => {
  const a = before.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const b = after.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`]
  const max = Math.max(a.length, b.length)
  let hunkStart = -1
  const hunk: string[] = []

  const flush = () => {
    if (hunk.length === 0) {
      return
    }
    lines.push(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`)
    lines.push(...hunk)
    hunk.length = 0
  }

  for (let i = 0; i < max; i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === right) {
      if (hunk.length > 0) {
        flush()
      }
      continue
    }
    if (hunkStart < 0 || hunk.length === 0) {
      hunkStart = i
    }
    if (left !== undefined && right !== undefined) {
      hunk.push(`-${left}`)
      hunk.push(`+${right}`)
    } else if (left !== undefined) {
      hunk.push(`-${left}`)
    } else if (right !== undefined) {
      hunk.push(`+${right}`)
    }
  }
  flush()
  if (lines.length === 2) {
    lines.push("@@ no changes @@")
  }
  return lines.join("\n")
}

export interface ValidationIssue {
  severity: "error" | "warning" | "info"
  message: string
}

export const buildValidationReport = (issues: ValidationIssue[]): string => {
  if (issues.length === 0) {
    return "Validation: no issues."
  }
  return issues.map((issue) => `[${issue.severity}] ${issue.message}`).join("\n")
}
