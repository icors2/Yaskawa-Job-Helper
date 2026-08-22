import type { UserFrame } from "../kin/client"
import type {
  CalibrationStepDef,
  ConfiguredUserFrame,
  JointAxis,
  JointLimitDirection
} from "./types"
import { JOINT_AXES } from "./types"

const HOME_PULSES = [0, -75310, 1200, 0, -127658, -70]
const HOME_CART = { x: 275, y: 0, z: 875, rx: 180, ry: 45, rz: 0 }

const AXIS_INDEX: Record<JointAxis, number> = {
  S: 0,
  L: 1,
  U: 2,
  R: 3,
  B: 4,
  T: 5
}

/**
 * Default frames when UFRAME.CND is not loaded yet.
 * S1 (UF#2) required triple; S2 (UF#3) optional RORG only.
 */
export const defaultConfiguredFrames = (): ConfiguredUserFrame[] => [
  {
    id: 2,
    name: "S1",
    includeRorg: true,
    includeRxx: true,
    includeRxy: true,
    required: true
  },
  {
    id: 3,
    name: "S2",
    includeRorg: true,
    includeRxx: false,
    includeRxy: false,
    required: false
  }
]

/** Seed configured frames from loaded UFRAME.CND (keeps S1-style defaults when empty). */
export const framesFromUframeCnd = (frames: UserFrame[]): ConfiguredUserFrame[] => {
  if (frames.length === 0) {
    return defaultConfiguredFrames()
  }
  return frames.map((frame) => {
    const isS1 = frame.id === 2 || /s1/i.test(frame.name)
    return {
      id: frame.id,
      name: frame.name || `UF${frame.id}`,
      includeRorg: true,
      includeRxx: isS1,
      includeRxy: isS1,
      required: isS1
    }
  })
}

const homeStep = (): CalibrationStepDef => ({
  id: "home",
  kind: "home",
  label: "Home / safe pose (anchor)",
  pauseTag: "STEP_HOME",
  description:
    "Known safe home is the anchor for every joint range. Record pulses (STANDARD) then matching cartesian (RELATIVE / BASE) at the same physical pose. Prefer teaching one MOVL (or MOVJ if needed) at this line.",
  pulseHint:
    "STANDARD job → teach/jog to home → CURRENT POSITION → PULSE. Write S,L,U,R,B,T. Seeds match 001-R1-HOME if still valid.",
  cartesianHint:
    "RELATIVE job (or convert STANDARD→relative / USER) → same home pose → BASE (or USER). Write X,Y,Z,Rx,Ry,Rz.",
  defaultFrame: "BASE",
  seedPulses: HOME_PULSES,
  seedCartesian: HOME_CART,
  required: true,
  skippable: false
})

const uframePointStep = (
  frame: ConfiguredUserFrame,
  point: "rorg" | "rxx" | "rxy",
  required: boolean
): CalibrationStepDef => {
  const tag = point.toUpperCase()
  const labels = {
    rorg: "RORG (origin)",
    rxx: "RXX (X-axis)",
    rxy: "RXY (XY plane)"
  } as const
  const kind =
    point === "rorg" ? "uframe_rorg" : point === "rxx" ? "uframe_rxx" : "uframe_rxy"
  return {
    id: `uf${frame.id}_${point}`,
    kind,
    label: `UF#${frame.id} ${frame.name} — ${labels[point]}`,
    pauseTag: `STEP_UF${frame.id}_${tag}`,
    description: `Teach/jog to the ${labels[point]} point for user frame ${frame.id} (${frame.name}). One recorded position per step (prefer MOVL). Phase A: pulses in STANDARD. Phase B: cartesian in RELATIVE / USER ${frame.id} (or BASE/BUSER).`,
    pulseHint: `STANDARD job → PULSE screen at ${tag}. Enter S,L,U,R,B,T into the wizard.`,
    cartesianHint: `RELATIVE / USER-frame job → BASE or USER ${frame.id} screen at the same ${tag} pose. Enter XYZ Rx Ry Rz.`,
    defaultFrame: "BASE",
    userFrameId: frame.id,
    required,
    skippable: !required
  }
}

const jointLimitStep = (
  axis: JointAxis,
  direction: JointLimitDirection,
  workspaceLimited: boolean
): CalibrationStepDef => {
  const tagDir = direction === "+" ? "PLUS" : "MINUS"
  const sense = direction === "+" ? "positive (+)" : "negative (−)"
  const safeGoal = workspaceLimited
    ? `farthest *safe* ${sense} reach from home in this cell (not mechanical max — stop before walls/fixtures)`
    : `full free-space ${sense} reach from home (still cell-aware; never crash)`
  const short = `${axis}${direction}`
  return {
    id: `joint_limit_${axis}_${direction === "+" ? "plus" : "minus"}`,
    kind: "joint_limit",
    label: `${short} safe limit from home`,
    pauseTag: `STEP_${axis}_${tagDir}`,
    description: `From home, jog *only* ${axis} to the ${safeGoal}. Prefer teaching one MOVL at this pose (MOVJ OK if linear is awkward). Pulse at this pose is what fits pulse-per-degree. Skip only if this direction is not clear.`,
    pulseHint: `STANDARD → from home jog ${axis} ${sense} to safe limit → PULSE. Label ${short}. Skip if unsafe.`,
    cartesianHint: `RELATIVE / BASE at the same ${short} pose → XYZ Rx Ry Rz. Skip if you skipped Phase A.`,
    defaultFrame: "BASE",
    axis,
    direction,
    required: false,
    skippable: true
  }
}

const extraStep = (): CalibrationStepDef => ({
  id: "extra_pose",
  kind: "extra",
  label: "Extra clear pose (optional)",
  pauseTag: "STEP_EXTRA",
  description:
    "Any additional clear mid-workspace pose that mixes a few axes — still within the safe cell envelope.",
  pulseHint: "STANDARD → PULSE at a distinct clear pose (one position per step).",
  cartesianHint: "RELATIVE / BASE → cartesian at the same pose.",
  defaultFrame: "BASE",
  required: false,
  skippable: true
})

/**
 * Build capture checklist: home anchor → user-frame points → per-axis S+/S− … T+/T− safe limits.
 * Replaces the old single “small delta” per axis.
 */
export const buildCalibrationSteps = (
  frames: ConfiguredUserFrame[],
  workspaceLimited = true
): CalibrationStepDef[] => {
  const steps: CalibrationStepDef[] = [homeStep()]

  for (const frame of frames) {
    if (frame.includeRorg) {
      steps.push(uframePointStep(frame, "rorg", frame.required))
    }
    if (frame.includeRxx) {
      steps.push(uframePointStep(frame, "rxx", false))
    }
    if (frame.includeRxy) {
      steps.push(uframePointStep(frame, "rxy", false))
    }
  }

  for (const axis of JOINT_AXES) {
    steps.push(jointLimitStep(axis, "+", workspaceLimited))
    steps.push(jointLimitStep(axis, "-", workspaceLimited))
  }

  steps.push(extraStep())
  return steps
}

/** Static default list for docs / export before session frames are chosen. */
export const CALIBRATION_STEPS: CalibrationStepDef[] = buildCalibrationSteps(
  defaultConfiguredFrames(),
  true
)

export const getStepById = (
  id: string,
  steps: CalibrationStepDef[] = CALIBRATION_STEPS
): CalibrationStepDef | undefined => {
  return steps.find((step) => step.id === id)
}

export const requiredStepIds = (steps: CalibrationStepDef[] = CALIBRATION_STEPS): string[] => {
  return steps.filter((step) => step.required).map((step) => step.id)
}

export const sampleIsComplete = (sample: {
  skipped?: boolean
  pulses?: number[]
  cartesian?: { x: number }
} | undefined): boolean => {
  if (!sample) {
    return false
  }
  if (sample.skipped) {
    return true
  }
  return Boolean(sample.pulses && sample.pulses.length >= 6 && sample.cartesian)
}

export const axisIndex = (axis: JointAxis): number => AXIS_INDEX[axis]
