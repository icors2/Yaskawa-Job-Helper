/**
 * Calibration JBI extract + golden export regression:
 * - fixtures/calibration/CAL_MINI_STANDARD.JBI + CAL_MINI_RELATIVE.JBI
 *   (CALSTEP fallback → home, S+, UF#2 RORG)
 * - fixtures/calibration/CALIBRATION_STANDARD.JBI + CALIBRATION_RELATIVE.JBI
 *   (index-order extract + generator DATE-normalized byte match)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  extractCalibrationPair,
  mergeExtractionIntoSession
} from "../src/lib/calibration/extract.ts"
import {
  buildCalibrationSteps,
  CALIBRATION_STEPS,
  defaultConfiguredFrames
} from "../src/lib/calibration/steps.ts"
import {
  buildRelativeCalibrationJob,
  buildStandardCalibrationJob,
  type CalibrationJobNames
} from "../src/lib/calibration/jobGenerator.ts"
import { createEmptySession } from "../src/lib/calibration/session.ts"

const here = fileURLToPath(new URL(".", import.meta.url))
const fixtures = join(here, "..", "fixtures", "calibration")

const GOLDEN_NAMES: CalibrationJobNames = {
  standardName: "CALIBRATION_STANDARD",
  relativeName: "CALIBRATION_RELATIVE",
  standardFile: "CALIBRATION_STANDARD.JBI",
  relativeFile: "CALIBRATION_RELATIVE.JBI"
}

const assert = (cond: unknown, message: string): void => {
  if (!cond) {
    throw new Error(message)
  }
}

const nearlyEqual = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps

const normalizeDate = (text: string): string =>
  text.replace(/\/\/\/DATE [^\r\n]+/g, "///DATE <DATE>")

const firstDiff = (actual: string, expected: string): string => {
  const a = actual.split(/\r?\n/)
  const e = expected.split(/\r?\n/)
  const n = Math.max(a.length, e.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== e[i]) {
      return `line ${i + 1}\n  actual:   ${JSON.stringify(a[i])}\n  expected: ${JSON.stringify(e[i])}`
    }
  }
  return "no line diff (length/newline mismatch)"
}

const runMiniExtract = (): void => {
  const steps = buildCalibrationSteps(defaultConfiguredFrames(), true)
  const standardText = readFileSync(join(fixtures, "CAL_MINI_STANDARD.JBI"), "latin1")
  const relativeText = readFileSync(join(fixtures, "CAL_MINI_RELATIVE.JBI"), "latin1")

  const summary = extractCalibrationPair(standardText, relativeText, steps, {
    standardHint: "CAL_MINI_STANDARD",
    relativeHint: "CAL_MINI_RELATIVE"
  })

  assert(summary.standard?.kind === "standard", "STANDARD kind")
  assert(summary.relative?.kind === "relative", "RELATIVE kind")
  assert(summary.relative?.userFrameId === 2, "RELATIVE USER frame id")

  const byId = new Map(summary.filled.map((hit) => [hit.stepId, hit] as const))

  const home = byId.get("home")
  assert(home?.pulses, "home pulses")
  assert(
    home!.pulses!.join(",") === "0,-75310,1200,0,-127658,-70",
    `home pulses got ${home!.pulses!.join(",")}`
  )
  assert(home?.cartesian, "home cartesian")
  assert(nearlyEqual(home!.cartesian!.x, 275), "home x")
  assert(nearlyEqual(home!.cartesian!.y, 0), "home y")
  assert(nearlyEqual(home!.cartesian!.z, 875), "home z")
  assert(
    home?.source === "calstep" || home?.source === "pause_tag",
    `home tagged fallback got ${home?.source}`
  )

  const sPlus = byId.get("joint_limit_S_plus")
  assert(sPlus?.pulses, "S+ pulses")
  assert(
    sPlus!.pulses!.join(",") === "45000,-75310,1200,0,-127658,-70",
    `S+ pulses got ${sPlus!.pulses!.join(",")}`
  )
  assert(sPlus?.cartesian, "S+ cartesian")
  assert(nearlyEqual(sPlus!.cartesian!.x, 320), "S+ x")
  assert(nearlyEqual(sPlus!.cartesian!.y, 45), "S+ y")

  const rorg = byId.get("uf2_rorg")
  assert(rorg?.pulses, "UF2 RORG pulses")
  assert(
    rorg!.pulses!.join(",") === "100,-80000,5000,0,-100000,200",
    `UF2 RORG pulses got ${rorg!.pulses!.join(",")}`
  )
  assert(rorg?.cartesian, "UF2 RORG cartesian")
  assert(nearlyEqual(rorg!.cartesian!.x, 250), "UF2 RORG x")
  assert(rorg?.frame === "USER", "UF2 RORG frame USER")
  assert(rorg?.userFrameId === 2, "UF2 RORG userFrameId")

  const session = mergeExtractionIntoSession(createEmptySession("guided"), summary, steps)
  assert(
    session.samples.some(
      (row) =>
        row.stepId === "home" &&
        row.pulses &&
        row.cartesian &&
        row.pulses[0] === 0 &&
        row.cartesian.x === 275
    ),
    "session merge home"
  )
  assert(
    session.samples.some((row) => row.stepId === "joint_limit_S_plus" && row.pulses?.[0] === 45000),
    "session merge S+"
  )
  assert(
    session.samples.some((row) => row.stepId === "uf2_rorg" && row.cartesian?.x === 250),
    "session merge uf2_rorg"
  )

  console.log(
    `OK mini extract: filled=${summary.filled.length} warnings=${summary.warnings.length}`
  )
  if (summary.warnings.length > 0) {
    for (const warning of summary.warnings) {
      console.log(`  warn: ${warning}`)
    }
  }
}

const runGoldenExportAndExtract = (): void => {
  assert(CALIBRATION_STEPS.length === 20, `expected 20 steps, got ${CALIBRATION_STEPS.length}`)
  const ids = CALIBRATION_STEPS.map((step) => step.id)
  assert(ids.includes("uf3_rxx"), "UF#3 RXX step")
  assert(ids.includes("uf3_rxy"), "UF#3 RXY step")
  assert(CALIBRATION_STEPS[0].exportLabel === "HOME POSTION", "HOME POSTION spelling")

  const steps = buildCalibrationSteps(defaultConfiguredFrames(), true)
  const date = new Date(2026, 7, 24, 8, 33)
  const generatedStd = buildStandardCalibrationJob(steps, date, GOLDEN_NAMES)
  const generatedRel = buildRelativeCalibrationJob(
    steps,
    new Date(2026, 7, 24, 8, 52),
    GOLDEN_NAMES
  )

  const goldenStd = readFileSync(join(fixtures, "CALIBRATION_STANDARD.JBI"), "latin1")
  const goldenRel = readFileSync(join(fixtures, "CALIBRATION_RELATIVE.JBI"), "latin1")

  const normGenStd = normalizeDate(generatedStd)
  const normGoldStd = normalizeDate(goldenStd)
  assert(
    normGenStd === normGoldStd,
    `STANDARD golden mismatch: ${firstDiff(normGenStd, normGoldStd)}`
  )

  const normGenRel = normalizeDate(generatedRel)
  const normGoldRel = normalizeDate(goldenRel)
  assert(
    normGenRel === normGoldRel,
    `RELATIVE golden mismatch: ${firstDiff(normGenRel, normGoldRel)}`
  )

  const summary = extractCalibrationPair(goldenStd, goldenRel, steps, {
    standardHint: "CALIBRATION_STANDARD",
    relativeHint: "CALIBRATION_RELATIVE"
  })

  assert(summary.standard?.kind === "standard", "golden STANDARD kind")
  assert(summary.relative?.kind === "relative", "golden RELATIVE kind")
  assert(summary.standard?.postype === "PULSE", "golden STANDARD PULSE")
  assert(summary.relative?.postype === "ROBOT", "golden RELATIVE ROBOT")
  assert(summary.filled.length === 20, `golden filled ${summary.filled.length}`)
  assert(summary.missingPulseStepIds.length === 0, "golden missing pulses")
  assert(summary.missingCartStepIds.length === 0, "golden missing cartesian")
  assert(
    summary.warnings.length === 0,
    `golden extract warnings: ${summary.warnings.join(" | ")}`
  )

  const byId = new Map(summary.filled.map((hit) => [hit.stepId, hit] as const))
  const home = byId.get("home")
  assert(home?.source === "index", "golden home source index")
  assert(
    home?.pulses?.join(",") === "208,-75312,1200,1,-127658,-69",
    `golden home pulses ${home?.pulses?.join(",")}`
  )
  assert(home?.cartesian && nearlyEqual(home.cartesian.x, 274.98), "golden home x")
  assert(home?.cartesian && nearlyEqual(home.cartesian.y, -0.008), "golden home y")

  const uf3rxx = byId.get("uf3_rxx")
  assert(uf3rxx?.pulses, "UF#3 RXX pulses")
  assert(
    uf3rxx!.pulses!.join(",") === "75149,-145859,-123958,43122,-68431,-32519",
    `UF#3 RXX pulses ${uf3rxx!.pulses!.join(",")}`
  )
  assert(uf3rxx?.cartesian && nearlyEqual(uf3rxx.cartesian.x, 613.623), "UF#3 RXX x")

  const uf3rxy = byId.get("uf3_rxy")
  assert(uf3rxy?.pulses, "UF#3 RXY pulses")
  assert(
    uf3rxy!.pulses!.join(",") === "42804,-31159,-73294,53963,-32933,-35202",
    `UF#3 RXY pulses ${uf3rxy!.pulses!.join(",")}`
  )
  assert(uf3rxy?.cartesian && nearlyEqual(uf3rxy.cartesian.x, 1163.774), "UF#3 RXY x")

  console.log("OK golden export (DATE-normalized) + index extract: filled=20")
}

try {
  runMiniExtract()
  runGoldenExportAndExtract()
} catch (error) {
  console.error("FAIL", error instanceof Error ? error.message : error)
  process.exit(1)
}
