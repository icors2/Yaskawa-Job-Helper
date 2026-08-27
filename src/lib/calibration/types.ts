import type { CartesianPose } from "../kin/client"

export type CalibFrameType = "BASE" | "USER"

export type CalibStepKind =
  | "home"
  | "uframe_rorg"
  | "uframe_rxx"
  | "uframe_rxy"
  | "joint_limit"
  | "extra"

/** High-level wizard phases (interactive step machine). */
export type WizardPhase =
  | "intro"
  | "export"
  | "configure_frames"
  | "capture"
  | "review"
  | "fit"
  | "apply"

/** Within a capture point: Phase A = pulses (standard job), Phase B = cartesian (relative). */
export type CapturePhase = "pulse" | "cartesian"

export type JointAxis = "S" | "L" | "U" | "R" | "B" | "T"

/** Safe-limit direction from home (+ = positive joint sense, − = negative). */
export type JointLimitDirection = "+" | "-"

export interface ConfiguredUserFrame {
  id: number
  name: string
  /** Include RORG / RXX / RXY capture points for this frame. */
  includeRorg: boolean
  includeRxx: boolean
  includeRxy: boolean
  /** RORG required when included; RXX/RXY optional unless flagged. */
  required: boolean
}

export interface CalibrationStepDef {
  id: string
  kind: CalibStepKind
  label: string
  /** Shared tag in both STANDARD and RELATIVE jobs so the wizard pairs them. */
  pauseTag: string
  description: string
  /** What to do on the pendant for the pulse (standard) phase. */
  pulseHint: string
  /** What to do on the pendant for the cartesian (relative / coord display) phase. */
  cartesianHint: string
  defaultFrame: CalibFrameType
  userFrameId?: number
  axis?: JointAxis
  /** Present when kind is joint_limit. */
  direction?: JointLimitDirection
  /**
   * Pendant comment body without the leading `'N ` index.
   * Copied from the YRC1000 reference jobs (`HOME POSTION` spelling included).
   */
  exportLabel: string
  seedPulses?: number[]
  seedCartesian?: CartesianPose
  /** ///RCONF payload for RELATIVE export; consecutive equal values are grouped. */
  seedRconf?: string
  required: boolean
  /** Operator may skip one side if the cell blocks that direction. Goal is both ± when safe. */
  skippable: boolean
}

export interface CalibrationSample {
  stepId: string
  pulses?: number[]
  cartesian?: CartesianPose
  frame: CalibFrameType
  userFrameId?: number
  label: string
  capturedAt: string
  skipped?: boolean
  notes?: string
  pulseCapturedAt?: string
  cartCapturedAt?: string
}

export interface CalibrationSession {
  version: 2
  mode: "guided" | "manual"
  createdAt: string
  updatedAt: string
  /**
   * Default ON — capture full *safe* ± range from home (not mechanical max).
   * Skip a direction only when that side is not clear in the cell.
   */
  workspaceLimited: boolean
  frames: ConfiguredUserFrame[]
  samples: CalibrationSample[]
  notes?: string
}

export const SESSION_STORAGE_KEY = "yaskawa.calibration.session.v1"
/** @deprecated Prefer resolveCalibrationJobNames() from jobGenerator / robot profile. */
export const CALIBRATION_JOB_NAME_STANDARD = "CAL_AR2010_STANDARD"
export const CALIBRATION_JOB_NAME_RELATIVE = "CAL_AR2010_RELATIVE"
export const CALIBRATION_JOB_FILENAME_STANDARD = "CAL_AR2010_STANDARD.JBI"
export const CALIBRATION_JOB_FILENAME_RELATIVE = "CAL_AR2010_RELATIVE.JBI"
/** @deprecated Prefer STANDARD / RELATIVE pair. Kept for Setup Guide string searches. */
export const CALIBRATION_JOB_NAME = CALIBRATION_JOB_NAME_STANDARD
export const CALIBRATION_JOB_FILENAME = CALIBRATION_JOB_FILENAME_STANDARD
export const CALIBRATION_README_FILENAME = "CALIBRATION_README.txt"
export const CALIBRATION_SESSION_FILENAME = "CALIBRATION_SESSION.json"

export const JOINT_AXES: JointAxis[] = ["S", "L", "U", "R", "B", "T"]

export const WIZARD_PHASE_LABELS: Record<WizardPhase, string> = {
  intro: "Intro",
  export: "Export jobs",
  configure_frames: "Frames",
  capture: "Capture",
  review: "Review",
  fit: "Fit",
  apply: "Apply"
}

export const WIZARD_PHASE_ORDER: WizardPhase[] = [
  "intro",
  "configure_frames",
  "export",
  "capture",
  "review",
  "fit",
  "apply"
]
