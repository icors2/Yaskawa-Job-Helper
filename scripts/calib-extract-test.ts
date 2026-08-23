/**
 * Calibration JBI extract regression:
 * fixtures/calibration/CAL_MINI_STANDARD.JBI + CAL_MINI_RELATIVE.JBI
 * → expected pulses/cartesians for home, S+, and UF#2 RORG.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  extractCalibrationPair,
  mergeExtractionIntoSession
} from "../src/lib/calibration/extract.ts"
import { buildCalibrationSteps, defaultConfiguredFrames } from "../src/lib/calibration/steps.ts"
import { createEmptySession } from "../src/lib/calibration/session.ts"

const here = fileURLToPath(new URL(".", import.meta.url))
const fixtures = join(here, "..", "fixtures", "calibration")

const assert = (cond: unknown, message: string): void => {
  if (!cond) {
    throw new Error(message)
  }
}

const nearlyEqual = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps

const run = () => {
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

  // NPOS on mini fixtures is intentional (counts match); ensure no hard failure
  console.log(
    `OK extract: filled=${summary.filled.length} warnings=${summary.warnings.length}`
  )
  if (summary.warnings.length > 0) {
    for (const warning of summary.warnings) {
      console.log(`  warn: ${warning}`)
    }
  }
}

try {
  run()
} catch (error) {
  console.error("FAIL", error instanceof Error ? error.message : error)
  process.exit(1)
}
