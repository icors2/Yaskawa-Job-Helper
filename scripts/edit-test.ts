import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJob } from "../src/lib/jbi/parse.ts"
import { serializeJob } from "../src/lib/jbi/serialize.ts"
import {
  buildWeldInventory,
  parseArcsrtNumbers,
  parseArcendNumbers,
  parseWeavNumbers
} from "../src/lib/jbi/cnd.ts"
import {
  deleteInstLines,
  flagInvalidWeldConditions,
  findUnreferencedPositions,
  insertInstLine,
  reorderInstLines,
  sanitizeSpeedModifiers,
  scaleSpeeds,
  setSpeeds,
  setWeldConditions
} from "../src/lib/jbi/edit.ts"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = join(here, "..")
const backup = join(repoRoot, "..", "Yaskawa Jobs", "DYNAMIC1")

let failed = 0

const assert = (cond: boolean, message: string) => {
  if (cond) {
    console.log(`ok — ${message}`)
    return
  }
  failed += 1
  console.error(`FAIL — ${message}`)
}

const sample = `/JOB
//NAME EDIT_TEST
//POS
///NPOS 0,0,0,2,0,0
///TOOL 0
///POSTYPE PULSE
///PULSE
P00001=1,2,3,4,5,6
P00002=7,8,9,10,11,12
//INST
///ATTR SC,RW
///GROUP1 RB1
NOP
MOVJ P001 VJ=50.00
MOVL P002 V=100.0
ARCON ASF#(9)
WVON WEV#(3)
MOVL P002 V=8.0
MOVL P002 V=7.2
ARCOF AEF#(9)
MOVL P002 V=120.0
END
`

const run = () => {
  const job = parseJob(sample)
  assert(job.instLines.length === 10, "parsed instruction lines")

  const inserted = insertInstLine(job, 2, "MOVL P002 V=50.0")
  assert(inserted.instLines[2].raw === "MOVL P002 V=50.0", "insert at index 2")
  assert(inserted.instLines.length === 11, "insert grows list")

  const moved = reorderInstLines(inserted, 2, "up")
  assert(moved !== null && moved.instLines[1].raw === "MOVL P002 V=50.0", "reorder up")

  const deleted = deleteInstLines(moved!, [1])
  assert(deleted.removed === 1, "delete one line")
  assert(deleted.job.instLines.length === 10, "delete shrinks list")

  const sped = setSpeeds(job, [1], "VJ", 25)
  assert(sped.job.instLines[1].raw.includes("VJ=25.00"), "set VJ preserves decimals")

  const scaled = scaleSpeeds(job, [2], "V", 0.5)
  assert(scaled.job.instLines[2].raw.includes("V=50.0"), "scale V halves value")

  // VJ must never land on MOVL / linear lines
  const badVjOnMovl = setSpeeds(job, [2], "VJ", 75)
  assert(
    !badVjOnMovl.job.instLines[2].raw.includes("VJ="),
    "VJ= is not applied to MOVL lines"
  )
  assert(badVjOnMovl.changes === 0, "VJ set on MOVL reports zero changes")

  // V must never land on MOVJ
  const badVOnMovj = setSpeeds(job, [1], "V", 10)
  assert(
    !badVOnMovj.job.instLines[1].raw.includes("V="),
    "V= is not applied to MOVJ lines"
  )
  assert(badVOnMovj.changes === 0, "V set on MOVJ reports zero changes")

  // Strip illegal dual modifiers
  const dual = sanitizeSpeedModifiers("MOVL C00000 V=423.3 VJ=75.00")
  assert(
    dual.changed && dual.raw.includes("V=423.3") && !dual.raw.includes("VJ="),
    "sanitize strips VJ= from MOVL"
  )
  const dualJ = sanitizeSpeedModifiers("MOVJ C00000 V=10.0 VJ=50.00")
  assert(
    dualJ.changed && dualJ.raw.includes("VJ=50.00") && !/\bV=/.test(dualJ.raw),
    "sanitize strips V= from MOVJ"
  )

  // Weld scope: only between ARCON and ARCOF
  const weldScaled = scaleSpeeds(job, [], "V", 0.5, "weld")
  assert(
    weldScaled.job.instLines[5].raw.includes("V=4.0") &&
      weldScaled.job.instLines[6].raw.includes("V=3.6"),
    "weld scope scales V= inside ARCON/ARCOF"
  )
  assert(
    weldScaled.job.instLines[2].raw.includes("V=100.0") &&
      weldScaled.job.instLines[8].raw.includes("V=120.0"),
    "weld scope leaves travel V= untouched"
  )

  const travelScaled = scaleSpeeds(job, [], "V", 0.5, "travel")
  assert(
    travelScaled.job.instLines[2].raw.includes("V=50.0") &&
      travelScaled.job.instLines[8].raw.includes("V=60.0"),
    "travel scope scales V= outside weld"
  )
  assert(
    travelScaled.job.instLines[5].raw.includes("V=8.0"),
    "travel scope leaves weld V= untouched"
  )

  // Global V scale skips MOVJ; VJ scale skips MOVL
  const allV = scaleSpeeds(job, [], "V", 0.5)
  assert(
    allV.job.instLines[1].raw.includes("VJ=50.00") &&
      !allV.job.instLines[1].raw.includes("V="),
    "scaling V never adds V= onto MOVJ"
  )

  const welded = setWeldConditions(job, [], "ASF", 12)
  assert(welded.job.instLines[3].raw === "ARCON ASF#(12)", "set ASF on all matching")

  const orphans = findUnreferencedPositions(
    deleteInstLines(job, [1, 2, 5, 6, 8]).job
  )
  assert(orphans.includes("P00001") && orphans.includes("P00002"), "report unreferenced POS")

  const arcsrt = readFileSync(join(backup, "ARCSRT.CND"), "latin1")
  const arcend = readFileSync(join(backup, "ARCEND.CND"), "latin1")
  const weav = readFileSync(join(backup, "WEAV.CND"), "latin1")
  const asf = parseArcsrtNumbers(arcsrt)
  const aef = parseArcendNumbers(arcend)
  const wev = parseWeavNumbers(weav)
  assert(asf.has(9) && asf.has(1000), "ARCSRT numbers include 9 and 1000")
  assert(aef.has(9) && aef.has(1000), "ARCEND numbers include 9 and 1000")
  assert(wev.has(3) && wev.has(255), "WEAV numbers include 3 and 255")

  const inventory = buildWeldInventory({ arcsrt, arcend, weav })
  const badJob = setWeldConditions(job, [], "ASF", 9999).job
  const flags = flagInvalidWeldConditions(badJob, inventory)
  assert(flags.some((line) => line.includes("ASF#(9999)")), "flag invalid ASF")

  const goodFlags = flagInvalidWeldConditions(job, inventory)
  assert(goodFlags.length === 0, "valid sample conditions pass")

  const round = serializeJob(parseJob(sample))
  assert(round === sample.replace(/\n/g, "\r\n"), "sample round-trips with CRLF")

  const rack = readFileSync(join(backup, "TCP_CHECK.JBI"), "latin1")
  const rackJob = parseJob(rack)
  const scaledRack = scaleSpeeds(rackJob, [], "both", 0.5)
  const again = serializeJob(scaledRack.job)
  assert(
    again.includes("VJ=25.00") && again.includes("V=105.9") && again.includes("V=5.3"),
    "scale real job speeds"
  )
  assert(again.endsWith("\r\n"), "edited serialize keeps trailing CRLF")
  assert(
    !again.match(/MOVL\b[^\r\n]*\bVJ=/i) && !again.match(/MOVJ\b[^\r\n]*\bV=/i),
    "scaled real job has no illegal V/VJ on wrong motion types"
  )

  console.log(`Edit tests: ${failed === 0 ? "all passed" : `${failed} failed`}`)
  if (failed > 0) {
    process.exit(1)
  }
}

run()
