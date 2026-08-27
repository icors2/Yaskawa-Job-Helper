/**
 * Headless transform validation against DYNAMIC1 known-good pairs.
 *
 * Run: npm run test:validate
 *
 * Requires local ../Yaskawa Jobs/DYNAMIC1 (gitignored). Skips with exit 0
 * when the backup is absent so CI without the corpus stays green.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { findFrame, findTool, parseToolCnd, parseUframeCnd } from "@yaskawa/core/kin/cnd"
import { defaultParams } from "@yaskawa/core/kin/fk"
import {
  DYNAMIC1_VALIDATION_SUITE,
  runValidationSuite,
  type SuiteSummary
} from "@yaskawa/core/kin/validation"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = join(here, "..")
const backupDir = join(repoRoot, "..", "Yaskawa Jobs", "DYNAMIC1")

const readBackup = (fileName: string): string | null => {
  const path = join(backupDir, fileName)
  if (!existsSync(path)) {
    return null
  }
  return readFileSync(path, "utf8")
}

const printSummary = (summary: SuiteSummary): void => {
  for (const outcome of summary.outcomes) {
    if (outcome.error) {
      console.error(`FAIL — ${outcome.pair.id}: ${outcome.error}`)
      continue
    }
    const result = outcome.result
    if (!result) {
      console.error(`FAIL — ${outcome.pair.id}: no result`)
      continue
    }
    const tag =
      result.verdict === "pass" ? "ok" : result.verdict === "warn" ? "WARN" : "FAIL"
    const log = result.verdict === "fail" ? console.error : console.log
    log(
      `${tag} — ${result.pairId}: pos RMS ${result.positionRmsMm.toFixed(2)} mm, ` +
        `orient RMS ${result.orientationRmsDeg.toFixed(2)} deg, ` +
        `inliers ${result.inliers}/${result.total}, ` +
        `worst #${result.worstPointIndex} ${result.worstPositionErrorMm.toFixed(2)} mm, ` +
        `det(R)=${result.detR.toFixed(3)} — ${result.message}`
    )
  }
  console.log(
    `\nSummary: ${summary.passed} pass, ${summary.warned} warn, ${summary.failed} fail, ${summary.skipped} skipped`
  )
}

const main = (): number => {
  if (!existsSync(backupDir)) {
    console.log(`skip — DYNAMIC1 backup not found at ${backupDir}`)
    return 0
  }

  const uframeText = readBackup("UFRAME.CND")
  const toolText = readBackup("TOOL.CND")
  if (!uframeText || !toolText) {
    console.error("FAIL — UFRAME.CND / TOOL.CND missing in DYNAMIC1")
    return 1
  }

  const frames = parseUframeCnd(uframeText)
  const tools = parseToolCnd(toolText)
  const uf2 = findFrame(frames, 2).buser
  const uf3 = findFrame(frames, 3).buser
  const tool = findTool(tools, 0).tcp
  if (!uf2 || !uf3) {
    console.error("FAIL — UF2 / UF3 BUSER poses missing")
    return 1
  }

  const summary = runValidationSuite({
    pairs: DYNAMIC1_VALIDATION_SUITE,
    readText: readBackup,
    ufSource: uf2,
    ufTarget: uf3,
    tool,
    params: defaultParams()
  })

  printSummary(summary)

  if (summary.failed > 0 || summary.skipped > 0) {
    return 1
  }
  return 0
}

process.exit(main())
