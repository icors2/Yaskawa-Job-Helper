/**
 * Domain types shared by every kinematics consumer.
 *
 * Offline sources of truth for frames/tools are UFRAME.CND / TOOL.CND
 * (YMConnect has no GetUFrame/PutUFrame — Motoman ConversionFromMotoCom).
 */

export type MirrorPlane = "XY" | "XZ" | "YZ"

export type ProfileStatus = "template_validated" | "unvalidated" | "calibrated"

export interface CartesianPose {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
}

/**
 * Which tool axes the station-flip correction `F` reverses.
 *
 * `"auto"` searches the wrist conventions plus a polar fit and picks whatever
 * minimises orientation error. An explicit choice pins `F` so an operator whose
 * dress package wraps badly on the mirrored station can override the fit.
 */
export type ToolAxisPreference = "auto" | "X" | "Y" | "XY" | "Z"

/** Orientation cost of one tool-axis choice, for showing the tradeoff in a picker. */
export interface ToolAxisOption {
  preference: ToolAxisPreference
  toolCorrection: number[][]
  orientationRmsDeg: number
}

export interface StationFlipRecipe {
  id?: string
  name?: string
  mirrorAxis: string
  offset: number[]
  mirrorMatrix: number[][]
  toolCorrection: number[][]
  /** Absent on recipes saved before the selector existed — treat as `"auto"`. */
  toolAxisPreference?: ToolAxisPreference
  positionRmsMm: number
  orientationRmsDeg: number
  inliers: number
  total: number
  detR: number
  sourceFrameId?: number | null
  targetFrameId?: number | null
  sourceJobName?: string
  targetJobName?: string
  jobFamily?: string
  fittedAt?: string
}

export interface RobotProfile {
  id: string
  robotId: string
  displayName: string
  controller: string
  robotModel: string
  robotTypeCode: string
  rawSystemLine: string
  application: string
  status: ProfileStatus | string
  linkLengthsMm: Record<string, number>
  pulsePerDeg: number[]
  pulseOffsets: number[]
  pulseLimitsPos: number[]
  pulseLimitsNeg: number[]
  homePulses: number[]
  tool0: CartesianPose
  framesSummary: { id: number; name: string; toolId: number }[]
  toolsSummary: { id: number; name: string; tcp: CartesianPose }[]
  sourceFolder: string
  sourceFiles: Record<string, { path: string; sha256: string }>
  dhLayout: string
  createdAt: string
  updatedAt: string
  calibrationId: string | null
  notes: string[]
  stationFlipRecipes?: StationFlipRecipe[]
}

export interface BackupFileStatus {
  name: string
  required: boolean
  found: boolean
  path: string | null
  count?: number
}

export interface ScanBackupResult {
  folder: string
  required: BackupFileStatus[]
  recommended: BackupFileStatus[]
  missingRequired: string[]
  ready: boolean
}

export type CalibrateFrameType = "BASE" | "USER"

export interface CalibratePair {
  pulses: number[]
  cartesian: CartesianPose
  label?: string
  /** Coordinate frame of `cartesian`. BASE (default) or USER (needs loaded UFRAME). */
  frame?: CalibrateFrameType
  /** Required when frame is USER — matches UFRAME.CND id (e.g. 2 = S1). */
  userFrameId?: number
}

export interface ResidualReport {
  rmsMm: number
  worstMm: number
  perPair?: { xyzMm: number; rotDeg?: number }[]
}

export interface UserFrame {
  id: number
  name: string
  toolId: number
  rorg: number[]
  rxx: number[]
  rxy: number[]
  buser: CartesianPose
}

export interface ToolRecord {
  id: number
  name: string
  tcp: CartesianPose
}
