/**
 * YMConnect online ConvertPosition client (soft dependency).
 *
 * Calls a native bridge when present. If YMConnect SDK / bridge is not
 * installed, returns a structured unavailable result with setup links.
 *
 * Docs: https://developer.motoman.com/en/YMConnect/KinematicsInterface
 * Releases: https://github.com/Yaskawa-Global/YMConnect/releases
 */

import { invoke } from "@tauri-apps/api/core"
import { YMCONNECT_DOCS, type YmConnectConnectionSettings } from "../robot/ymconnectPrefs"
import type { CartesianPose } from "./client"

export const YMCONNECT_ONLINE_VALIDATION = {
  planned: false as const,
  implemented: true as const,
  untestedOnCell: true as const,
  api: "YMConnect::KinematicsInterface::ConvertPosition",
  conversions: ["PulseToCartesianPos", "CartesianPosToPulse", "PulseToJointAngle"] as const,
  note:
    "Bridge skeleton ships with the app. Cell test requires YMConnect SDK + YRC1000 Ethernet. Offline SciPy FK + pendant transcription remain the default path."
}

export type YmConvertDirection = "pulseToCartesian" | "cartesianToPulse"

export interface YmConvertPulseInput {
  pulses: number[]
  toolNumber?: number
}

export interface YmConvertCartesianInput {
  pose: CartesianPose
  toolNumber?: number
  userFrameNumber?: number
  /** Figure / RCONF-style flags when using CartesianPosToPulse (Figure mode). */
  figure?: number[]
}

export interface YmConvertResult {
  ok: true
  direction: YmConvertDirection
  pose?: CartesianPose
  pulses?: number[]
  figure?: number[]
  raw?: unknown
}

export interface YmConvertUnavailable {
  ok: false
  unavailable: true
  reason: string
  installHint: string
  docs: typeof YMCONNECT_DOCS
}

export type YmConvertResponse = YmConvertResult | YmConvertUnavailable

export interface YmBridgeStatus {
  available: boolean
  bridgePath: string | null
  message: string
  docs: typeof YMCONNECT_DOCS
}

const unavailable = (reason: string): YmConvertUnavailable => ({
  ok: false,
  unavailable: true,
  reason,
  installHint:
    "Install YMConnect from GitHub releases, build ymconnect/YmConnectBridge, and place the executable where the app can find it (see docs/DEVELOPER_GUIDE.md).",
  docs: YMCONNECT_DOCS
})

export const getYmConnectBridgeStatus = async (): Promise<YmBridgeStatus> => {
  try {
    const status = await invoke<{
      available: boolean
      bridgePath: string | null
      message: string
    }>("ymconnect_bridge_status")
    return {
      available: status.available,
      bridgePath: status.bridgePath,
      message: status.message,
      docs: YMCONNECT_DOCS
    }
  } catch (error) {
    return {
      available: false,
      bridgePath: null,
      message: error instanceof Error ? error.message : String(error),
      docs: YMCONNECT_DOCS
    }
  }
}

const invokeConvert = async (payload: Record<string, unknown>): Promise<YmConvertResponse> => {
  try {
    const result = await invoke<YmConvertResponse>("ymconnect_convert_position", { payload })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message.includes("not found") ||
      message.includes("unavailable") ||
      message.includes("YMCONNECT") ||
      message.includes("bridge")
    ) {
      return unavailable(message)
    }
    return unavailable(message)
  }
}

export const convertPositionPulseToCartesian = async (options: {
  settings: YmConnectConnectionSettings
  input: YmConvertPulseInput
}): Promise<YmConvertResponse> => {
  return invokeConvert({
    host: options.settings.host,
    controlGroup: options.settings.controlGroup,
    direction: "pulseToCartesian",
    pulses: options.input.pulses,
    toolNumber: options.input.toolNumber ?? 0
  })
}

export const convertPositionCartesianToPulse = async (options: {
  settings: YmConnectConnectionSettings
  input: YmConvertCartesianInput
}): Promise<YmConvertResponse> => {
  return invokeConvert({
    host: options.settings.host,
    controlGroup: options.settings.controlGroup,
    direction: "cartesianToPulse",
    pose: options.input.pose,
    toolNumber: options.input.toolNumber ?? 0,
    userFrameNumber: options.input.userFrameNumber ?? 0,
    figure: options.input.figure ?? []
  })
}
