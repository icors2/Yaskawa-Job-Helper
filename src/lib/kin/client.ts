/**
 * Kinematics sidecar client (JSON-over-stdio via Tauri).
 *
 * Offline sources of truth for frames/tools: UFRAME.CND / TOOL.CND
 * (YMConnect has no GetUFrame/PutUFrame — Motoman ConversionFromMotoCom).
 *
 * Online path (soft dependency): YMConnect ConvertPosition via
 * `src/lib/kin/ymconnect.ts` + `ymconnect/` bridge. Untested on cell until
 * SDK + Ethernet are available. See docs/MOTOMAN_DEVELOPER_FINDINGS.md.
 */

import { invoke } from "@tauri-apps/api/core"

export const KIN_PROTOCOL_VERSION = "1.0.0"

export {
  YMCONNECT_ONLINE_VALIDATION,
  convertPositionCartesianToPulse,
  convertPositionPulseToCartesian,
  getYmConnectBridgeStatus
} from "./ymconnect"

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

export interface StationFlipRecipe {
  id?: string
  name?: string
  mirrorAxis: string
  offset: number[]
  mirrorMatrix: number[][]
  toolCorrection: number[][]
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

let nextRequestId = 0

const createRequestId = (): string => {
  nextRequestId += 1
  return `kin-${nextRequestId}`
}

const parseResponse = <T>(raw: string): T => {
  const response = JSON.parse(raw) as KinResponse<T>
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response.result
}

export const kinRequest = async <T>(body: KinRequestBody): Promise<T> => {
  const request = { ...body, id: body.id ?? createRequestId() }
  const raw = await invoke<string>("kin_request", {
    request: JSON.stringify(request)
  })
  return parseResponse<T>(raw)
}

export const ping = (): Promise<PingResult> => {
  return kinRequest<PingResult>({ type: "ping" })
}

export const forwardKinematics = (
  body: Omit<ForwardKinematicsRequest, "id" | "type">
): Promise<ForwardKinematicsResult> => {
  return kinRequest<ForwardKinematicsResult>({ type: "forward_kinematics", ...body })
}

export const calibrate = (
  body: Omit<CalibrateRequest, "id" | "type">
): Promise<CalibrateResult> => {
  return kinRequest<CalibrateResult>({ type: "calibrate", ...body })
}

export const transformFrame = (
  body: Omit<TransformFrameRequest, "id" | "type">
): Promise<TransformFrameResult> => {
  return kinRequest<TransformFrameResult>({ type: "transform_frame", ...body })
}

export const transformMirror = (
  body: Omit<TransformMirrorRequest, "id" | "type">
): Promise<TransformMirrorResult> => {
  return kinRequest<TransformMirrorResult>({ type: "transform_mirror", ...body })
}

export const transformOffset = (
  body: Omit<TransformOffsetRequest, "id" | "type">
): Promise<TransformOffsetResult> => {
  return kinRequest<TransformOffsetResult>({ type: "transform_offset", ...body })
}

export const transformFrameFlip = (
  body: Omit<TransformFrameFlipRequest, "id" | "type">
): Promise<TransformFrameFlipResult> => {
  return kinRequest<TransformFrameFlipResult>({ type: "transform_frame_flip", ...body })
}

export const fitStationFlip = (
  body: Omit<FitStationFlipRequest, "id" | "type">
): Promise<FitStationFlipResult> => {
  return kinRequest<FitStationFlipResult>({ type: "fit_station_flip", ...body })
}

export const applyStationFlip = (
  body: Omit<ApplyStationFlipRequest, "id" | "type">
): Promise<ApplyStationFlipResult> => {
  return kinRequest<ApplyStationFlipResult>({ type: "apply_station_flip", ...body })
}

export const readUframe = (path: string): Promise<ReadUframeResult> => {
  return kinRequest<ReadUframeResult>({ type: "read_uframe", path })
}

export const readTool = (path: string): Promise<ReadToolResult> => {
  return kinRequest<ReadToolResult>({ type: "read_tool", path })
}

export const scanBackup = (folder: string): Promise<ScanBackupResult> => {
  return kinRequest<ScanBackupResult>({ type: "scan_backup", folder })
}

export const createProfileFromBackup = (
  body: Omit<CreateProfileFromBackupRequest, "id" | "type">
): Promise<CreateProfileResult> => {
  return kinRequest<CreateProfileResult>({ type: "create_profile_from_backup", ...body })
}

export const loadProfile = (
  body: Omit<LoadProfileRequest, "id" | "type">
): Promise<LoadProfileResult> => {
  return kinRequest<LoadProfileResult>({ type: "load_profile", ...body })
}

export const getProfile = (): Promise<GetProfileResult> => {
  return kinRequest<GetProfileResult>({ type: "get_profile" })
}
