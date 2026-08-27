import type { CartesianPose } from "../kin/types"
import { getStoragePort } from "../ports/storage"
import type {
  CalibrationSample,
  CalibrationSession,
  CalibFrameType,
  ConfiguredUserFrame
} from "./types"
import { SESSION_STORAGE_KEY } from "./types"
import { defaultConfiguredFrames, sampleIsComplete } from "./steps"

export const parseSixNumbers = (text: string, what: string): number[] => {
  const parts = text
    .trim()
    .split(/[,\s]+/)
    .map((part) => Number.parseFloat(part))
    .filter((n) => !Number.isNaN(n))
  if (parts.length < 6) {
    throw new Error(`${what} needs 6 comma-separated values`)
  }
  return parts.slice(0, 6)
}

export const parsePulses = (text: string): number[] => parseSixNumbers(text, "Pulses")

export const parsePose = (text: string): CartesianPose => {
  const parts = parseSixNumbers(text, "Cartesian")
  return { x: parts[0], y: parts[1], z: parts[2], rx: parts[3], ry: parts[4], rz: parts[5] }
}

export const formatPulses = (pulses: number[]): string => pulses.join(", ")

export const formatPose = (pose: CartesianPose): string => {
  return [pose.x, pose.y, pose.z, pose.rx, pose.ry, pose.rz].join(", ")
}

export const createEmptySession = (mode: "guided" | "manual" = "guided"): CalibrationSession => {
  const now = new Date().toISOString()
  return {
    version: 2,
    mode,
    createdAt: now,
    updatedAt: now,
    workspaceLimited: true,
    frames: defaultConfiguredFrames(),
    samples: []
  }
}

const migrateSession = (raw: unknown): CalibrationSession | null => {
  if (!raw || typeof raw !== "object") {
    return null
  }
  const parsed = raw as Partial<CalibrationSession> & { version?: number; samples?: CalibrationSample[] }
  if (!Array.isArray(parsed.samples)) {
    return null
  }
  if (parsed.version === 2) {
    return {
      version: 2,
      mode: parsed.mode === "manual" ? "manual" : "guided",
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      workspaceLimited: parsed.workspaceLimited !== false,
      frames: Array.isArray(parsed.frames) && parsed.frames.length > 0
        ? parsed.frames
        : defaultConfiguredFrames(),
      samples: parsed.samples,
      notes: parsed.notes
    }
  }
  // v1 → v2: keep samples; apply default frames + workspace-limited
  if (parsed.version === 1) {
    const now = new Date().toISOString()
    return {
      version: 2,
      mode: parsed.mode === "manual" ? "manual" : "guided",
      createdAt: parsed.createdAt ?? now,
      updatedAt: now,
      workspaceLimited: true,
      frames: defaultConfiguredFrames(),
      samples: parsed.samples.map((sample) => ({
        ...sample,
        pulses: sample.pulses,
        cartesian: sample.cartesian
      })),
      notes: parsed.notes
        ? `${parsed.notes}\n[migrated from session v1]`
        : "[migrated from session v1]"
    }
  }
  return null
}

export const loadSession = (): CalibrationSession | null => {
  try {
    const raw = getStoragePort().getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }
    return migrateSession(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export const saveSessionLocal = (session: CalibrationSession): CalibrationSession => {
  const next: CalibrationSession = {
    ...session,
    version: 2,
    updatedAt: new Date().toISOString()
  }
  getStoragePort().setItem(SESSION_STORAGE_KEY, JSON.stringify(next))
  return next
}

export const clearSessionLocal = (): void => {
  getStoragePort().removeItem(SESSION_STORAGE_KEY)
}

export const upsertSample = (
  session: CalibrationSession,
  sample: CalibrationSample
): CalibrationSession => {
  const without = session.samples.filter((row) => row.stepId !== sample.stepId)
  return saveSessionLocal({
    ...session,
    samples: [...without, sample]
  })
}

export const removeSample = (session: CalibrationSession, stepId: string): CalibrationSession => {
  return saveSessionLocal({
    ...session,
    samples: session.samples.filter((row) => row.stepId !== stepId)
  })
}

export const updateSessionFrames = (
  session: CalibrationSession,
  frames: ConfiguredUserFrame[],
  workspaceLimited: boolean
): CalibrationSession => {
  return saveSessionLocal({
    ...session,
    frames,
    workspaceLimited
  })
}

export const sampleToCalibratePair = (sample: CalibrationSample) => {
  if (sample.skipped || !sample.pulses || !sample.cartesian) {
    throw new Error(`Sample ${sample.stepId} is incomplete or skipped`)
  }
  return {
    pulses: sample.pulses,
    cartesian: sample.cartesian,
    label: sample.label,
    frame: sample.frame as CalibFrameType,
    userFrameId: sample.userFrameId
  }
}

export const completeSamplesForFit = (session: CalibrationSession) => {
  return session.samples.filter(
    (sample) => !sample.skipped && sample.pulses && sample.cartesian && sampleIsComplete(sample)
  )
}
