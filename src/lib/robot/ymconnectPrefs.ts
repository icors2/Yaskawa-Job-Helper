/**
 * Per-profile YMConnect connection settings (online kinematics path).
 * Soft dependency — bridge may be missing until YMConnect SDK is installed.
 */

export const YMCONNECT_PREFS_STORAGE_KEY = "yaskawa.ymconnect.v1"

export interface YmConnectConnectionSettings {
  host: string
  /** Optional display label for the controller */
  controllerLabel: string
  controlGroup: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8"
  updatedAt: string
}

export interface YmConnectPrefsStore {
  version: 1
  byProfileId: Record<string, YmConnectConnectionSettings>
}

const defaultSettings = (): YmConnectConnectionSettings => ({
  host: "192.168.1.31",
  controllerLabel: "YRC1000",
  controlGroup: "R1",
  updatedAt: new Date().toISOString()
})

const emptyStore = (): YmConnectPrefsStore => ({
  version: 1,
  byProfileId: {}
})

export const loadYmConnectPrefsStore = (): YmConnectPrefsStore => {
  try {
    const raw = localStorage.getItem(YMCONNECT_PREFS_STORAGE_KEY)
    if (!raw) {
      return emptyStore()
    }
    const parsed = JSON.parse(raw) as YmConnectPrefsStore
    if (parsed.version !== 1 || typeof parsed.byProfileId !== "object") {
      return emptyStore()
    }
    return { version: 1, byProfileId: parsed.byProfileId ?? {} }
  } catch {
    return emptyStore()
  }
}

export const getYmConnectSettings = (
  profileId: string | null
): YmConnectConnectionSettings => {
  if (!profileId) {
    return defaultSettings()
  }
  const store = loadYmConnectPrefsStore()
  return store.byProfileId[profileId] ?? defaultSettings()
}

export const saveYmConnectSettings = (
  profileId: string,
  settings: Partial<YmConnectConnectionSettings>
): YmConnectConnectionSettings => {
  const store = loadYmConnectPrefsStore()
  const prev = store.byProfileId[profileId] ?? defaultSettings()
  const next: YmConnectConnectionSettings = {
    host: (settings.host ?? prev.host).trim() || prev.host,
    controllerLabel: (settings.controllerLabel ?? prev.controllerLabel).trim() || prev.controllerLabel,
    controlGroup: settings.controlGroup ?? prev.controlGroup,
    updatedAt: new Date().toISOString()
  }
  localStorage.setItem(
    YMCONNECT_PREFS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      byProfileId: {
        ...store.byProfileId,
        [profileId]: next
      }
    } satisfies YmConnectPrefsStore)
  )
  return next
}

export const YMCONNECT_DOCS = {
  home: "https://developer.motoman.com/en/YMConnect",
  kinematics: "https://developer.motoman.com/en/YMConnect/KinematicsInterface",
  releases: "https://github.com/Yaskawa-Global/YMConnect/releases",
  note:
    "Motion and Kinematics interfaces require YRC1000 or newer, plus Ethernet setup per the YMConnect quick start."
} as const
