import {
  calibrationStorageKeyForProfile,
  getActiveProfile,
  loadProfilesStore
} from "@yaskawa/core/robot/profile"
import { syncKeyToIdb } from "../../platform"

export const CALIBRATION_STORAGE_KEY = "yaskawa.calibration.v1"
export const DEFAULT_THRESHOLD_MM = 1.0

export interface StoredCalibration {
  calibrationId: string
  parameters: Record<string, number>
  residuals: { rmsMm: number; worstMm: number }
  thresholdMm: number
  gated: boolean
  updatedAt: string
  source?: "wizard" | "manual" | "imported"
  profileId?: string
}

const storageKeyForActive = (): string => {
  const profile = getActiveProfile(loadProfilesStore())
  if (profile) {
    return calibrationStorageKeyForProfile(profile.id)
  }
  return CALIBRATION_STORAGE_KEY
}

export const loadStored = (): StoredCalibration | null => {
  try {
    const raw = localStorage.getItem(storageKeyForActive())
    if (!raw) {
      const legacy = localStorage.getItem(CALIBRATION_STORAGE_KEY)
      if (!legacy) {
        return null
      }
      return JSON.parse(legacy) as StoredCalibration
    }
    return JSON.parse(raw) as StoredCalibration
  } catch {
    return null
  }
}

export const saveStored = async (record: StoredCalibration): Promise<void> => {
  const profile = getActiveProfile(loadProfilesStore())
  const withProfile: StoredCalibration = {
    ...record,
    profileId: profile?.id ?? record.profileId
  }
  const key = storageKeyForActive()
  localStorage.setItem(key, JSON.stringify(withProfile))
  if (profile) {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(withProfile))
  }
  await syncKeyToIdb(key)
  await syncKeyToIdb(CALIBRATION_STORAGE_KEY)
}

export const clearStored = async (): Promise<void> => {
  const key = storageKeyForActive()
  localStorage.removeItem(key)
  await syncKeyToIdb(key)
}

export const getCalibrationGate = (): {
  allowed: boolean
  reason: string
  calibration: StoredCalibration | null
} => {
  const profile = getActiveProfile(loadProfilesStore())
  if (!profile) {
    return {
      allowed: false,
      reason: "No active robot profile — create one on Profiles.",
      calibration: null
    }
  }
  const calibration = loadStored()
  if (!calibration) {
    return {
      allowed: false,
      reason: "No stored calibration for this robot — complete Guided or Manual calibration.",
      calibration: null
    }
  }
  if (!calibration.gated) {
    return {
      allowed: false,
      reason: `Calibration residuals exceed threshold (${calibration.residuals.worstMm.toFixed(3)} mm).`,
      calibration
    }
  }
  return {
    allowed: true,
    reason: "Calibration gate open.",
    calibration
  }
}

export const getEditWriteGate = (): { allowed: boolean; reason: string } => {
  const calib = getCalibrationGate()
  if (!calib.allowed) {
    return { allowed: false, reason: calib.reason }
  }
  return { allowed: true, reason: "Write allowed." }
}
