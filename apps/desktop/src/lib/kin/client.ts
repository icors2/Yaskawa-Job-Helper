/**
 * Kinematics sidecar client (JSON-over-stdio via Tauri).
 *
 * The wire format and domain types live in `@yaskawa/core/kin/*`; this module
 * is only the desktop transport plus the re-exports its callers already use.
 *
 * Online path (soft dependency): YMConnect ConvertPosition via
 * `./ymconnect.ts` + `ymconnect/` bridge. Untested on cell until
 * SDK + Ethernet are available. See docs/MOTOMAN_DEVELOPER_FINDINGS.md.
 */

import { invoke } from "@tauri-apps/api/core"
import type {
  ApplyStationFlipRequest,
  ApplyStationFlipResult,
  CalibrateRequest,
  CalibrateResult,
  CreateProfileFromBackupRequest,
  CreateProfileResult,
  FitStationFlipRequest,
  FitStationFlipResult,
  ForwardKinematicsRequest,
  ForwardKinematicsResult,
  GetProfileResult,
  KinRequestBody,
  KinResponse,
  LoadProfileRequest,
  LoadProfileResult,
  PingResult,
  ReadToolResult,
  ReadUframeResult,
  TransformFrameFlipRequest,
  TransformFrameFlipResult,
  TransformFrameRequest,
  TransformFrameResult,
  TransformMirrorRequest,
  TransformMirrorResult,
  TransformOffsetRequest,
  TransformOffsetResult
} from "@yaskawa/core/kin/protocol"
import type { ScanBackupResult } from "@yaskawa/core/kin/types"

export * from "@yaskawa/core/kin/protocol"
export * from "@yaskawa/core/kin/types"

export {
  YMCONNECT_ONLINE_VALIDATION,
  convertPositionCartesianToPulse,
  convertPositionPulseToCartesian,
  getYmConnectBridgeStatus
} from "./ymconnect"

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
