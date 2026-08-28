/**
 * Wire format of the kinematics sidecar (JSON-over-stdio).
 *
 * Types only — the transport lives in the shell that owns it
 * (`apps/desktop/src/lib/kin/client.ts` speaks it over Tauri `invoke`).
 */

import type {
  CalibratePair,
  CartesianPose,
  MirrorPlane,
  ResidualReport,
  RobotProfile,
  ScanBackupResult,
  StationFlipRecipe,
  ToolAxisOption,
  ToolRecord,
  UserFrame
} from "./types"

export const KIN_PROTOCOL_VERSION = "1.0.0"

export type KinMethod =
  | "ping"
  | "forward_kinematics"
  | "calibrate"
  | "transform_frame"
  | "transform_mirror"
  | "transform_offset"
  | "transform_frame_flip"
  | "fit_station_flip"
  | "apply_station_flip"
  | "read_uframe"
  | "read_tool"
  | "scan_backup"
  | "create_profile_from_backup"
  | "load_profile"
  | "get_profile"

export interface PingRequest {
  id: string
  type: "ping"
}

export interface ForwardKinematicsRequest {
  id: string
  type: "forward_kinematics"
  pulses: number[]
  toolId?: number
  userFrameId?: number
  calibrationId?: string
}

export interface CalibrateRequest {
  id: string
  type: "calibrate"
  pairs: CalibratePair[]
  seed?: Record<string, number>
  toolId?: number
}

export interface TransformFrameRequest {
  id: string
  type: "transform_frame"
  pulses: number[][]
  sourceFrameId: number
  targetFrameId: number
  toolId?: number
  calibrationId?: string
}

export interface TransformMirrorRequest {
  id: string
  type: "transform_mirror"
  poses: CartesianPose[]
  plane: MirrorPlane
}

export interface TransformOffsetRequest {
  id: string
  type: "transform_offset"
  poses: CartesianPose[]
  delta: CartesianPose
}

export interface TransformFrameFlipRequest {
  id: string
  type: "transform_frame_flip"
  poses: CartesianPose[]
  /** Explicit BUSER of current UF (preferred when UI overrides). */
  sourceUf?: CartesianPose
  /** Explicit BUSER of target UF. */
  targetUf?: CartesianPose
  sourceFrameId?: number
  targetFrameId?: number
  /** Default true — tool Z 180° like Flip.py. */
  applyToolZFlip?: boolean
}

export interface FitStationFlipRequest {
  id: string
  type: "fit_station_flip"
  sourcePulses?: number[][]
  targetPulses?: number[][]
  sourcePoses?: CartesianPose[]
  targetPoses?: CartesianPose[]
  sourceFrameId?: number
  targetFrameId?: number
  sourceUf?: CartesianPose
  targetUf?: CartesianPose
  toolId?: number
  sourceJobName?: string
  targetJobName?: string
  jobFamily?: string
}

export interface ApplyStationFlipRequest {
  id: string
  type: "apply_station_flip"
  recipe: StationFlipRecipe
  pulses?: number[][]
  poses?: CartesianPose[]
  sourceFrameId?: number
  targetFrameId?: number
  sourceUf?: CartesianPose
  targetUf?: CartesianPose
  toolId?: number
}

export interface ReadUframeRequest {
  id: string
  type: "read_uframe"
  path: string
}

export interface ReadToolRequest {
  id: string
  type: "read_tool"
  path: string
}

export interface ScanBackupRequest {
  id: string
  type: "scan_backup"
  folder: string
}

export interface CreateProfileFromBackupRequest {
  id: string
  type: "create_profile_from_backup"
  folder: string
  displayName?: string
  profileId?: string
  savePath?: string
}

export interface LoadProfileRequest {
  id: string
  type: "load_profile"
  path?: string
  profile?: RobotProfile
}

export interface GetProfileRequest {
  id: string
  type: "get_profile"
}

export type KinRequest =
  | PingRequest
  | ForwardKinematicsRequest
  | CalibrateRequest
  | TransformFrameRequest
  | TransformMirrorRequest
  | TransformOffsetRequest
  | TransformFrameFlipRequest
  | FitStationFlipRequest
  | ApplyStationFlipRequest
  | ReadUframeRequest
  | ReadToolRequest
  | ScanBackupRequest
  | CreateProfileFromBackupRequest
  | LoadProfileRequest
  | GetProfileRequest

export interface PingResult {
  pong: true
  version: string
  protocol: string
}

export interface ForwardKinematicsResult {
  pose: CartesianPose
}

export interface CalibrateResult {
  calibrationId: string
  parameters: Record<string, number>
  residuals: ResidualReport
  success?: boolean
  message?: string
}

export interface TransformFrameResult {
  poses: CartesianPose[]
  targetFrameId: number
}

export interface TransformMirrorResult {
  poses: CartesianPose[]
  rconfReviewRequired: true
}

export interface TransformOffsetResult {
  poses: CartesianPose[]
}

export interface TransformFrameFlipResult {
  poses: CartesianPose[]
  targetFrameId: number | null
  applyToolZFlip: boolean
  sourceUf: CartesianPose
  targetUf: CartesianPose
}

export interface FitStationFlipResult {
  accepted: boolean
  message: string
  recipe: StationFlipRecipe | null
  positionRmsMm: number
  orientationRmsDeg: number
  inliers: number
  total: number
  detR: number
  inlierIndices?: number[]
  /** Orientation cost of each tool-axis choice. Absent from the Python oracle, which is auto-only. */
  toolAxisOptions?: ToolAxisOption[]
}

export interface StationFlipPointResult {
  index: number
  pose: CartesianPose
  pulses: number[]
  degrees: number[]
  reachable: boolean
  withinLimits: boolean
  positionErrorMm: number
  orientationErrorDeg: number
  rconf: number[]
  rconfText: string
  message: string
  limitViolations: string[]
}

export interface ApplyStationFlipResult {
  poses: CartesianPose[]
  points: StationFlipPointResult[]
  targetFrameId: number | null
  saveBlocked: boolean
  reachableCount: number
  failedCount: number
  recipe: StationFlipRecipe
}

/** Same-UF mirror apply result (IK + RCONF + write gate). */
export interface ApplyMirrorResult {
  poses: CartesianPose[]
  points: StationFlipPointResult[]
  retainedUserFrameId: number
  saveBlocked: boolean
  reachableCount: number
  failedCount: number
}

export interface ReadUframeResult {
  frames: UserFrame[]
}

export interface ReadToolResult {
  tools: ToolRecord[]
}

export interface CreateProfileResult {
  profile: RobotProfile
  savedPath: string | null
  scan: ScanBackupResult
}

export interface LoadProfileResult {
  profile: RobotProfile
}

export interface GetProfileResult {
  profile: RobotProfile | null
  hasProfile: boolean
  parameters: Record<string, number>
}

export interface KinErrorBody {
  code: string
  message: string
}

export interface KinOk<T> {
  id: string
  ok: true
  result: T
}

export interface KinErr {
  id: string
  ok: false
  error: KinErrorBody
}

export type KinResponse<T = unknown> = KinOk<T> | KinErr

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export type KinRequestBody = DistributiveOmit<KinRequest, "id"> & { id?: string }
