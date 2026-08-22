import {
  calibrationStorageKeyForProfile,
  getActiveProfile,
  loadProfilesStore
} from "../../lib/robot/profile"

export const CALIBRATION_STORAGE_KEY = "yaskawa.calibration.v1"
export const DEFAULT_THRESHOLD_MM = 1.0

export interface StoredCalibration {
  calibrationId: string
  parameters: Record<string, number>
  residuals: { rmsMm: number; worstMm: number }
  thresholdMm: number
  gated: boolean
  updatedAt: string
  /** Origin of this stored fit when known */
  source?: "wizard" | "manual"
  /** Profile this calibration belongs to */
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
      // Legacy fallback (pre multi-profile)
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

export const saveStored = (record: StoredCalibration): void => {
  const profile = getActiveProfile(loadProfilesStore())
  const withProfile: StoredCalibration = {
    ...record,
    profileId: profile?.id ?? record.profileId
  }
  localStorage.setItem(storageKeyForActive(), JSON.stringify(withProfile))
  // Keep legacy key in sync for older code paths when a profile is active
  if (profile) {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(withProfile))
  }
}

export const clearStored = (): void => {
  localStorage.removeItem(storageKeyForActive())
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
      reason: "No active robot profile — complete robot install in Setup Guide.",
      calibration: null
    }
  }
  const calibration = loadStored()
  if (!calibration) {
    return {
      allowed: false,
      reason: `No calibration for ${profile.displayName} — run Calibration first.`,
      calibration: null
    }
  }
  if (!calibration.gated) {
    return {
      allowed: false,
      reason: `Worst residual ${calibration.residuals.worstMm.toFixed(3)} mm exceeds gate ${calibration.thresholdMm.toFixed(3)} mm.`,
      calibration
    }
  }
  return { allowed: true, reason: "Calibration gate open.", calibration }
}

/**
 * Gate for writing edited jobs (Diff / Wizard export). Library browse stays
 * read-only without this. Setup may continue while this gate is closed.
 */
export const getEditWriteGate = (): {
  allowed: boolean
  reason: string
  calibration: StoredCalibration | null
} => {
  const gate = getCalibrationGate()
  if (gate.allowed) {
    return gate
  }
  return {
    ...gate,
    reason: `${gate.reason} Setup can continue; editing unlocks after calibration is completed and applied for the active robot.`
  }
}
