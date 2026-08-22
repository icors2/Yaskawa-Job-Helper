import type { CalibrationStepDef, ConfiguredUserFrame } from "./types"
import { CALIBRATION_README_FILENAME } from "./types"
import { buildCalibrationSteps, defaultConfiguredFrames } from "./steps"
import {
  calibrationJobNames,
  getActiveProfile,
  loadProfilesStore
} from "../robot/profile"

const NL = "\r\n"

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

const pauseBlock = (
  step: CalibrationStepDef,
  variant: "standard" | "relative"
): string[] => {
  const phase =
    variant === "standard"
      ? "PHASE A — PULSE (standard / pulse job)"
      : "PHASE B — CARTESIAN (relative / USER or BASE display)"
  const hint = variant === "standard" ? step.pulseHint : step.cartesianHint
  const teach =
    step.kind === "joint_limit"
      ? `' Teach ONE position here (prefer MOVL; MOVJ OK). Label ${step.axis ?? "?"}${step.direction ?? ""}`
      : "' Teach ONE position at this PAUSE (prefer MOVL when cartesian-capable)"
  return [
    `MSG "${step.pauseTag}"`,
    `' ${step.pauseTag}`,
    `' ${phase}`,
    `' ${step.label}`,
    `' ${hint}`,
    teach,
    "PAUSE"
  ]
}

const buildHeader = (
  name: string,
  postype: "PULSE" | "USER",
  date: Date,
  homePulses: number[]
): string[] => {
  const lines = [
    "/JOB",
    `//NAME ${name}`,
    "//POS",
    "///NPOS 0,0,0,1,0,0",
    "///TOOL 0"
  ]
  if (postype === "PULSE") {
    lines.push("///POSTYPE PULSE", "///PULSE")
  } else {
    lines.push(
      "///POSTYPE USER",
      "///USER 2",
      "///RECTAN",
      "///RCONF 1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"
    )
  }
  if (postype === "USER") {
    lines.push("P00100=275.000,0.000,875.000,180.0000,45.0000,0.0000")
  } else {
    const pulses =
      homePulses.length >= 6
        ? homePulses.slice(0, 6).map((value) => Math.round(value)).join(",")
        : "0,-75310,1200,0,-127658,-70"
    lines.push(`C00000=${pulses}`)
  }
  lines.push(
    "//INST",
    formatDateLine(date),
    "///ATTR SC,RW",
    "///GROUP1 RB1",
    "NOP"
  )
  return lines
}

/**
 * STANDARD (pulse) job — Phase A capture.
 * One PAUSE (and preferably one taught MOVL/MOVJ) per checklist step.
 */
export const buildStandardCalibrationJob = (
  steps: CalibrationStepDef[],
  date = new Date(),
  names: CalibrationJobNames = resolveCalibrationJobNames(),
  homePulses: number[] = getActiveProfile(loadProfilesStore())?.homePulses ?? []
): string => {
  const lines: string[] = [
    ...buildHeader(names.standardName, "PULSE", date, homePulses),
    "' ============================================",
    `' ${names.standardName} — Phase A pulse capture`,
    `' Pair with ${names.relativeName} (same pause tags).`,
    "' Home is the ANCHOR. Per joint: record S+ and S-",
    "' (… T+/T−) as farthest SAFE limits from home.",
    "' Prefer one MOVL (or MOVJ) taught per PAUSE line.",
    "' Procedure: program/teach as STANDARD first,",
    "' record PULSE at each PAUSE, then convert or",
    "' load RELATIVE job for cartesian at same poses.",
    "' SAFETY: Operator jog/teach only. Cell-limited",
    "' safe range — NOT mechanical max / crash envelope.",
    "' Skip a +/− side only if that direction is unclear.",
    "' Optional MOVJ to home is COMMENTED OUT.",
    "' ============================================",
    "MSG \"STD CAL — Phase A PULSE\"",
    "' Confirm cell clear, then CONTINUE",
    "PAUSE",
    "' --- Optional known-safe home (if path clear) ---",
    "'MOVJ C000 VJ=5.00",
    ...steps.flatMap((step) => pauseBlock(step, "standard")),
    "MSG \"STD CAL DONE — switch to RELATIVE\"",
    `' Next: load ${names.relativeName} (or convert this`,
    "' job to relative/USER) and capture cartesian at",
    "' the SAME physical poses (matching pause tags).",
    "END"
  ]
  return `${lines.join(NL)}${NL}`
}

/**
 * RELATIVE (USER-frame) job — Phase B cartesian capture.
 */
export const buildRelativeCalibrationJob = (
  steps: CalibrationStepDef[],
  date = new Date(),
  names: CalibrationJobNames = resolveCalibrationJobNames()
): string => {
  const lines: string[] = [
    ...buildHeader(names.relativeName, "USER", date, []),
    "' ============================================",
    `' ${names.relativeName} — Phase B cartesian`,
    `' Pair with ${names.standardName} (same tags).`,
    "' Same physical poses as Phase A (home + S+/S− …).",
    "' Display BASE or USER n on the pendant and record",
    "' X Y Z Rx Ry Rz (+ which frame).",
    "' Prefer one MOVL per PAUSE when teaching.",
    "' SAFETY: Full *safe* range from home — not crash max.",
    "' Optional MOVJ P100 COMMENTED OUT.",
    "' ============================================",
    "MSG \"REL CAL — Phase B CART\"",
    "' Confirm cell clear, then CONTINUE",
    "PAUSE",
    "' --- Optional known-safe home (if path clear) ---",
    "'MOVJ P100 VJ=5.00",
    ...steps.flatMap((step) => pauseBlock(step, "relative")),
    "MSG \"REL CAL DONE — enter data in PC\"",
    "END"
  ]
  return `${lines.join(NL)}${NL}`
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
    "CRITICAL: Standard → Relative procedure",
    "--------------------------------------",
    "On Yaskawa, a STANDARD (pulse) job stores joint pulses. To get matching",
    "cartesian for the SAME physical pose, use a RELATIVE / USER-frame job",
    "(or pendant CURRENT POSITION in BASE/USER) at that pose.",
    "",
    "Recommended workflow:",
    `  1. Load ${names.standardFile} (or teach calibration as a standard job).`,
    "  2. At each PAUSE: teach ONE position (prefer MOVL; MOVJ if needed),",
    "     display PULSE → write S,L,U,R,B,T → enter Phase A in PC.",
    `  3. Convert/change the job to relative (USER), OR load ${names.relativeFile}`,
    "     and return to the same physical poses (matching pause tags).",
    "  4. At each PAUSE: display BASE or USER n → write X,Y,Z,Rx,Ry,Rz → Phase B.",
    "",
    "Both jobs share identical pause tags so the wizard pairs Phase A + B.",
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
    "- Jobs are PAUSE-heavy. Prefer jog/teach. No aggressive auto motion.",
    "- Full *safe* range from home — never wall/fixture crashes.",
    "- Workspace-limited mode (default ON): capture the farthest clear ±",
    "  from home; Skip any direction that is not clear.",
    "- Optional MOVJ home lines are COMMENTED OUT. Enable only if path is clear.",
    "- Never overwrite source/backup jobs. PC exports only write to OUTPUT.",
    "",
    "Controller steps",
    "----------------",
    `1. Copy ${names.standardFile} and ${names.relativeFile}`,
    "   from the PC output folder to the controller (CF/USB).",
    "2. Run STANDARD first (Phase A pulses), then RELATIVE (Phase B cartesian)",
    "   — or convert the standard job to relative for the same poses.",
    "3. CONTINUE at each PAUSE; skip skippable +/− limit steps if unsafe.",
    "",
    "PC wizard steps",
    "---------------",
    "1. Set Output folder in the app header. Confirm active robot profile.",
    "2. Calibration → Guided mode → Intro → Configure frames → Export → Capture.",
    "3. Per point: Phase A pulses, then Phase B cartesian (validation before Next).",
    "4. Save session → Review → Run calibrate → Apply (gate if ≤ threshold).",
    "5. Escape to Manual Calibration anytime for free-form pairs.",
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
    "Checklist (matching pause tags in both JBIs)",
    "--------------------------------------------",
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
