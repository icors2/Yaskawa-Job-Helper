import type { CartesianPose } from "../kin/types"
import type { CalibrationStepDef, ConfiguredUserFrame } from "./types"
import { CALIBRATION_README_FILENAME } from "./types"
import {
  buildCalibrationSteps,
  defaultConfiguredFrames,
  numberedExportComment,
  rconfForStep
} from "./steps"
import {
  calibrationJobNames,
  getActiveProfile,
  loadProfilesStore
} from "../robot/profile"

const NL = "\r\n"
const MOVL_SPEED = "423.3"
const ZERO_CART: CartesianPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }
const ZERO_PULSES = [0, 0, 0, 0, 0, 0]

export type CalibrationJobNames = {
  standardName: string
  relativeName: string
  standardFile: string
  relativeFile: string
}

export const resolveCalibrationJobNames = (): CalibrationJobNames => {
  return calibrationJobNames(getActiveProfile(loadProfilesStore()))
}

const formatDateLine = (date = new Date()): string => {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  const hh = String(date.getHours()).padStart(2, "0")
  const mi = String(date.getMinutes()).padStart(2, "0")
  return `///DATE ${yyyy}/${mm}/${dd} ${hh}:${mi}`
}

const cVarName = (index: number): string => `C${String(index).padStart(5, "0")}`

const formatPulseRow = (pulses: number[]): string => {
  return pulses
    .slice(0, 6)
    .map((value) => String(Math.round(value)))
    .join(",")
}

const formatCartRow = (pose: CartesianPose): string => {
  const n = (value: number, digits: number) => value.toFixed(digits)
  return `${n(pose.x, 3)},${n(pose.y, 3)},${n(pose.z, 3)},${n(pose.rx, 4)},${n(pose.ry, 4)},${n(pose.rz, 4)}`
}

const pulsesForStep = (step: CalibrationStepDef, homePulses: number[]): number[] => {
  if (step.seedPulses && step.seedPulses.length >= 6) {
    return step.seedPulses.slice(0, 6)
  }
  if (step.kind === "home" && homePulses.length >= 6) {
    return homePulses.slice(0, 6)
  }
  return ZERO_PULSES
}

const cartForStep = (step: CalibrationStepDef): CartesianPose => {
  return step.seedCartesian ?? ZERO_CART
}

/**
 * Stable machine tag used by older CAL jobs. Extract still matches CALSTEP as a
 * fallback when numbered C000nn comments are absent.
 */
export const calStepComment = (stepId: string): string => `' CALSTEP:${stepId}`

const buildPosPreamble = (name: string, count: number): string[] => [
  "/JOB",
  `//NAME ${name}`,
  "//POS",
  `///NPOS ${count},0,0,0,0,0`,
  "///TOOL 0"
]

const buildInstPreamble = (
  date: Date,
  attr: string,
  extraInstHeaders: string[]
): string[] => [
  "//INST",
  formatDateLine(date),
  `///ATTR ${attr}`,
  ...extraInstHeaders,
  "///GROUP1 RB1",
  "NOP"
]

const buildMovlBlock = (steps: CalibrationStepDef[]): string[] => {
  const lines: string[] = []
  steps.forEach((step, index) => {
    lines.push(numberedExportComment(step, index))
    lines.push(`MOVL ${cVarName(index)} V=${MOVL_SPEED}`)
  })
  return lines
}

const joinJob = (lines: string[]): string => `${lines.join(NL)}${NL}`

/**
 * STANDARD (pulse) job — C00000–C000nn integer pulses, POSTYPE PULSE.
 * Default 20-step list byte-matches CALIBRATION_STANDARD.JBI aside from ///DATE.
 */
export const buildStandardCalibrationJob = (
  steps: CalibrationStepDef[],
  date = new Date(),
  names: CalibrationJobNames = resolveCalibrationJobNames(),
  homePulses: number[] = []
): string => {
  const posLines = steps.map(
    (step, index) => `${cVarName(index)}=${formatPulseRow(pulsesForStep(step, homePulses))}`
  )
  const lines: string[] = [
    ...buildPosPreamble(names.standardName, steps.length),
    "///POSTYPE PULSE",
    "///PULSE",
    ...posLines,
    ...buildInstPreamble(date, "SC,RW", []),
    ...buildMovlBlock(steps),
    "END"
  ]
  return joinJob(lines)
}

/**
 * RELATIVE (ROBOT cartesian) job — C vars with interleaved ///RCONF.
 * Default 20-step list byte-matches CALIBRATION_RELATIVE.JBI aside from ///DATE.
 */
export const buildRelativeCalibrationJob = (
  steps: CalibrationStepDef[],
  date = new Date(),
  names: CalibrationJobNames = resolveCalibrationJobNames()
): string => {
  const posLines: string[] = []
  let prevRconf: string | null = null
  steps.forEach((step, index) => {
    const rconf = rconfForStep(step)
    if (rconf !== prevRconf) {
      posLines.push(`///RCONF ${rconf}`)
      prevRconf = rconf
    }
    posLines.push(`${cVarName(index)}=${formatCartRow(cartForStep(step))}`)
  })
  const lines: string[] = [
    ...buildPosPreamble(names.relativeName, steps.length),
    "///POSTYPE ROBOT",
    "///RECTAN",
    ...posLines,
    ...buildInstPreamble(date, "SC,RW,RJ", ["////FRAME ROBOT"]),
    ...buildMovlBlock(steps),
    "END"
  ]
  return joinJob(lines)
}

/** @deprecated Use buildStandardCalibrationJob / buildRelativeCalibrationJob. */
export const buildCalibrationJobContents = (date = new Date()): string => {
  return buildStandardCalibrationJob(
    buildCalibrationSteps(defaultConfiguredFrames(), true),
    date
  )
}

export const buildCalibrationReadme = (
  steps: CalibrationStepDef[] = buildCalibrationSteps(defaultConfiguredFrames(), true),
  frames: ConfiguredUserFrame[] = defaultConfiguredFrames(),
  names: CalibrationJobNames = resolveCalibrationJobNames()
): string => {
  const stepLines = steps.map((step, index) => {
    const req = step.required ? "required" : step.skippable ? "skippable" : "optional"
    return [
      `${index + 1}. [${step.pauseTag}] ${step.label} (${req})`,
      `   Pendant comment: ${numberedExportComment(step, index)}`,
      `   ${step.description}`,
      `   Phase A (STANDARD / PULSE): ${step.pulseHint}`,
      `   Phase B (RELATIVE / CART):  ${step.cartesianHint}`,
      ""
    ].join("\n")
  })

  const frameLines = frames.map(
    (frame) =>
      `- UF#${frame.id} ${frame.name}: RORG=${frame.includeRorg} RXX=${frame.includeRxx} RXY=${frame.includeRxy} (${frame.required ? "required" : "optional"})`
  )

  const profile = getActiveProfile(loadProfilesStore())
  const robotLabel = profile
    ? `${profile.displayName} (${profile.robotModel || profile.robotId})`
    : "active robot profile"

  return [
    `${names.standardName.replace(/_STANDARD$/, "")} — Calibration assist (YRC1000)`,
    "================================================",
    "",
    `Robot: ${robotLabel}`,
    "",
    "Purpose",
    "-------",
    "Collect pulse ↔ cartesian pairs so the Yaskawa Job Editor can fit",
    "pulse-per-degree scales and home offsets (link lengths stay fixed).",
    "Home is the anchor; per-joint S+/S− … T+/T− are full *safe* limits",
    "from home (workspace-limited, not mechanical max). Larger ± spans",
    "condition mirror/shift math far better than tiny deltas.",
    "This is an OFFLINE pendant-transcription workflow.",
    "Online YMConnect ConvertPosition validation is a future path — not used here.",
    "",
    "Job format (matches pendant CALIBRATION_STANDARD / RELATIVE)",
    "----------------------------------------------------------",
    `Both jobs declare ///NPOS ${steps.length},0,0,0,0,0, ///TOOL 0, C00000–C${String(Math.max(steps.length - 1, 0)).padStart(5, "0")},`,
    "then //INST with numbered comments + MOVL C000nn V=423.3 (no PAUSE/MSG scaffold).",
    "STANDARD: ///POSTYPE PULSE, integer pulses, ///ATTR SC,RW.",
    "RELATIVE: ///POSTYPE ROBOT, ///RECTAN, interleaved ///RCONF, cartesian C vars",
    "(xyz 3 dp, angles 4 dp), ///ATTR SC,RW,RJ, ////FRAME ROBOT.",
    "PC extract keys off C index (C00000 = step 1) and checks the numbered comment;",
    "older jobs with ' CALSTEP:<id> still extract via that fallback.",
    "",
    "CRITICAL: Standard → Relative procedure",
    "--------------------------------------",
    "On Yaskawa, a STANDARD (pulse) job stores joint pulses. To get matching",
    "cartesian for the SAME physical pose, use a RELATIVE / ROBOT job",
    "(or pendant CURRENT POSITION in BASE/USER) at that pose.",
    "",
    "Recommended workflow:",
    `  1. Load ${names.standardFile}. Teach each C000nn (prefer MOVL).`,
    "  2. Display PULSE → write S,L,U,R,B,T → enter Phase A in PC, or re-upload.",
    `  3. Load ${names.relativeFile} and return to the same physical poses.`,
    "  4. Display BASE or USER n → write X,Y,Z,Rx,Ry,Rz → Phase B.",
    "",
    "After teaching on the robot",
    "--------------------------",
    "1. Copy the taught STANDARD + RELATIVE jobs back to the PC",
    "   (output folder or USB) — never overwrite the source backup.",
    "2. Calibration → Guided → Upload recorded calibration jobs.",
    "3. Load STANDARD (pulses) + RELATIVE (cartesian) → Extract into session.",
    "4. Review the summary table; type any missing steps manually.",
    "",
    "Joint limits (from home)",
    "-----------------------",
    "- Start every axis excursion from the known safe HOME pose.",
    "- For each axis S,L,U,R,B,T record BOTH directions when safe:",
    "    S+ = farthest safe positive from home",
    "    S- = farthest safe negative from home",
    "  (same pattern for L,U,R,B,T).",
    "- Goal is both sides; workspace-limited mode still allows Skip if one",
    "  direction is blocked by the cell.",
    "- Do NOT drive to hard mechanical stops / crash envelopes.",
    "",
    "Safety (cell / limited joint motion)",
    "------------------------------------",
    "- Robot motion is entirely the operator's responsibility.",
    "- Jobs are 20 taught MOVL points at V=423.3 — jog/teach, no aggressive auto.",
    "- Full *safe* range from home — never wall/fixture crashes.",
    "- Workspace-limited mode (default ON): capture the farthest clear ±",
    "  from home; Skip any direction that is not clear.",
    "- Never overwrite source/backup jobs. PC exports only write to OUTPUT.",
    "",
    "Controller steps",
    "----------------",
    `1. Copy ${names.standardFile} and ${names.relativeFile}`,
    "   from the PC output folder to the controller (CF/USB).",
    "2. Run STANDARD first (Phase A pulses), then RELATIVE (Phase B cartesian).",
    "3. Teach each numbered comment / C var; skip skippable +/− limit steps if unsafe.",
    "",
    "PC wizard steps",
    "---------------",
    "1. Set Output folder in the app header. Confirm active robot profile.",
    "2. Calibration → Guided mode → Intro → Configure frames → Export.",
    "3. Teach on the robot (STANDARD pulses, then RELATIVE cartesian).",
    "4. Upload taught STANDARD + RELATIVE → Extract into session",
    "   (or type Phase A/B per point). Review summary for gaps.",
    "5. Save session → Review → Run calibrate → Apply (gate if ≤ threshold).",
    "6. Escape to Manual Calibration anytime for free-form pairs.",
    "",
    "Later (not available yet)",
    "-------------------------",
    "Bulk pulse→relative conversion of production jobs for regression pairs",
    "will feed richer calibration data. When real cartesian production jobs",
    "arrive, re-validate mirror/shift against those fixtures.",
    "The wizard has a placeholder panel; do not invent fake conversion pairs",
    "until cell data exists.",
    "",
    "Configured user frames (at export time)",
    "---------------------------------------",
    ...frameLines,
    "",
    "Checklist (matching numbered comments in both JBIs)",
    "---------------------------------------------------",
    ...stepLines,
    "Files written to output folder",
    "------------------------------",
    `- ${names.standardFile}`,
    `- ${names.relativeFile}`,
    `- ${CALIBRATION_README_FILENAME}`,
    "- CALIBRATION_SESSION.json (when you export the session)",
    "- CALIBRATION_RESULT_<id>.json (when you apply a fit)",
    ""
  ].join("\n")
}

export {
  CALIBRATION_README_FILENAME
}

/** @deprecated Prefer resolveCalibrationJobNames() for active robot. */
export const CALIBRATION_JOB_FILENAME_STANDARD = "CAL_AR2010_STANDARD.JBI"
/** @deprecated Prefer resolveCalibrationJobNames() for active robot. */
export const CALIBRATION_JOB_FILENAME_RELATIVE = "CAL_AR2010_RELATIVE.JBI"
