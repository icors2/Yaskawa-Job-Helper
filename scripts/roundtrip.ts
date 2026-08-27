import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJob, nposMismatch } from "@yaskawa/core/jbi/parse"
import { serializeJob } from "@yaskawa/core/jbi/serialize"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = join(here, "..")
const fixturesDir = join(repoRoot, "fixtures")
const backupDir = join(repoRoot, "..", "Yaskawa Jobs", "DYNAMIC1")

const collectJbi = (root: string): string[] => {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name.toUpperCase().endsWith(".JBI")) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out.sort()
}

const roundTripFile = (path: string): { ok: boolean; detail: string } => {
  const original = readFileSync(path)
  const text = original.toString("latin1")
  const job = parseJob(text)
  const mismatch = nposMismatch(job)
  const serialized = serializeJob(job)
  const next = Buffer.from(serialized, "latin1")
  if (Buffer.compare(original, next) !== 0) {
    const failPath = `${path}.roundtrip-fail`
    writeFileSync(failPath, next)
    return {
      ok: false,
      detail: `byte mismatch (${original.length} vs ${next.length})${mismatch ? `; ${mismatch}` : ""} -> ${failPath}`
    }
  }
  return {
    ok: true,
    detail: mismatch ? `ok with note: ${mismatch}` : "ok"
  }
}

const run = () => {
  const roots = [fixturesDir]
  if (readdirSync(join(repoRoot, ".."), { withFileTypes: true }).some((e) => e.name === "Yaskawa Jobs")) {
    roots.push(backupDir)
  }

  let failed = 0
  let passed = 0
  for (const root of roots) {
    const files = collectJbi(root)
    console.log(`Round-trip ${files.length} files under ${relative(repoRoot, root) || root}`)
    for (const file of files) {
      const result = roundTripFile(file)
      if (!result.ok) {
        failed += 1
        console.error(`FAIL ${relative(repoRoot, file)}: ${result.detail}`)
      } else {
        passed += 1
      }
    }
  }
  console.log(`Passed ${passed}, failed ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

run()
