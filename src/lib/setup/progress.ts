export type SetupStepId =
  | "robotInstall"
  | "sourceFolder"
  | "outputFolder"
  | "cndFiles"
  | "calibration"
  | "safety"

export interface SetupProgress {
  version: 3
  dontShowOnStartup: boolean
  dismissedUntilResume: boolean
  currentStep: number
  completed: Record<SetupStepId, boolean>
  /** Setup checklist continued without applying calibration (editing stays locked). */
  calibrationSkippedForNow: boolean
  uframePath: string | null
  toolPath: string | null
  robotProfileId: string | null
  safetyAcknowledgedAt: string | null
  updatedAt: string
}

export const SETUP_STORAGE_KEY = "yaskawa.setup.v1"

export const SETUP_STEP_ORDER: SetupStepId[] = [
  "robotInstall",
  "sourceFolder",
  "outputFolder",
  "cndFiles",
  "calibration",
  "safety"
]

/** Steps required before leaving the forced Setup Guide (calibration may be skipped). */
export const MINIMUM_SETUP_STEPS: SetupStepId[] = [
  "robotInstall",
  "sourceFolder",
  "outputFolder",
  "cndFiles",
  "safety"
]

const defaultProgress = (): SetupProgress => ({
  version: 3,
  dontShowOnStartup: false,
  dismissedUntilResume: false,
  currentStep: 0,
  completed: {
    robotInstall: false,
    sourceFolder: false,
    outputFolder: false,
    cndFiles: false,
    calibration: false,
    safety: false
  },
  calibrationSkippedForNow: false,
  uframePath: null,
  toolPath: null,
  robotProfileId: null,
  safetyAcknowledgedAt: null,
  updatedAt: new Date().toISOString()
})

export const loadSetupProgress = (): SetupProgress => {
  try {
    const raw = localStorage.getItem(SETUP_STORAGE_KEY)
    if (!raw) {
      return defaultProgress()
    }
    const parsed = JSON.parse(raw) as Partial<SetupProgress> & { version?: number }
    const base = defaultProgress()
    const completed = {
      ...base.completed,
      ...(parsed.completed as Partial<Record<SetupStepId, boolean>> | undefined)
    }
    const incomingVersion = Number(parsed.version ?? 1)
    if (incomingVersion < 2) {
      completed.robotInstall = false
    }
    const merged: SetupProgress = {
      ...base,
      ...parsed,
      version: 3,
      completed,
      calibrationSkippedForNow: Boolean(parsed.calibrationSkippedForNow),
      robotProfileId: parsed.robotProfileId ?? null,
      dontShowOnStartup: false,
      dismissedUntilResume: false,
      updatedAt: parsed.updatedAt ?? base.updatedAt
    }
    // Forced setup: ignore dismiss flags until minimum steps are done
    if (isMinimumSetupComplete(merged)) {
      merged.dontShowOnStartup = Boolean(parsed.dontShowOnStartup)
      merged.dismissedUntilResume = Boolean(parsed.dismissedUntilResume)
    }
    return merged
  } catch {
    return defaultProgress()
  }
}

export const saveSetupProgress = (progress: SetupProgress): SetupProgress => {
  const next: SetupProgress = {
    ...progress,
    version: 3,
    updatedAt: new Date().toISOString()
  }
  localStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify(next))
  return next
}

export const isSetupComplete = (progress: SetupProgress): boolean =>
  SETUP_STEP_ORDER.every((step) => progress.completed[step])

export const isMinimumSetupComplete = (progress: SetupProgress): boolean =>
  MINIMUM_SETUP_STEPS.every((step) => progress.completed[step])

/** Calibration step satisfied for checklist (applied OR explicitly skipped for now). */
export const isCalibrationStepSatisfied = (progress: SetupProgress): boolean =>
  progress.completed.calibration || progress.calibrationSkippedForNow

export const shouldForceSetup = (progress: SetupProgress): boolean =>
  !isMinimumSetupComplete(progress)

export const shouldOpenSetupOnStartup = (progress: SetupProgress): boolean => {
  if (shouldForceSetup(progress)) {
    return true
  }
  return !isSetupComplete(progress) && !progress.calibrationSkippedForNow
}

/**
 * True when this profile can skip the Setup Guide and open Loaded Jobs.
 * Requires minimum setup complete, plus folders for this profile when the
 * saved progress belongs to a different robot (new / incomplete profile).
 */
export const isProfileSetupFinished = (
  progress: SetupProgress,
  profileId: string,
  hasFolders: boolean
): boolean => {
  if (!isMinimumSetupComplete(progress)) {
    return false
  }
  if (progress.robotProfileId && progress.robotProfileId !== profileId) {
    return hasFolders
  }
  return true
}

export const markSetupStep = (
  progress: SetupProgress,
  step: SetupStepId,
  done: boolean
): SetupProgress =>
  saveSetupProgress({
    ...progress,
    completed: {
      ...progress.completed,
      [step]: done
    },
    calibrationSkippedForNow:
      step === "calibration" && done ? false : progress.calibrationSkippedForNow
  })

export const skipCalibrationForNow = (progress: SetupProgress): SetupProgress =>
  saveSetupProgress({
    ...progress,
    calibrationSkippedForNow: true,
    completed: {
      ...progress.completed,
      calibration: false
    }
  })

/**
 * Persist current progress and mark the guided setup as finished for this session
 * (caller should navigate to Loaded Jobs). Does not invent missing checklist steps.
 */
export const finishSetup = (progress: SetupProgress): SetupProgress =>
  saveSetupProgress({
    ...progress,
    dismissedUntilResume: true,
    dontShowOnStartup: true
  })
