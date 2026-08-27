/**
 * Multi-robot profile store.
 *
 * Profiles are kept in localStorage and optionally mirrored to
 * `<output>/profiles/robot_profiles.json`. Geometry features require an
 * active profile; text edits do not.
 */

import {
  createProfileFromBackup,
  loadProfile,
  scanBackup,
  type RobotProfile,
  type ScanBackupResult,
  type StationFlipRecipe
} from "../kin/client"

export type { StationFlipRecipe }

export const ROBOT_PROFILES_STORAGE_KEY = "yaskawa.robot.profiles.v1"
export const ROBOT_PROFILES_FILENAME = "profiles/robot_profiles.json"

export type ProfileStatus = "template_validated" | "unvalidated" | "calibrated"

export interface RobotProfilesStore {
  version: 1
  activeProfileId: string | null
  profiles: RobotProfile[]
  updatedAt: string
}

export const PROFILE_REQUIRED_FILES = [
  "SYSTEM.SYS",
  "RC.PRM",
  "TOOL.CND",
  "UFRAME.CND"
] as const

export const PROFILE_RECOMMENDED_FILES = [
  "RE.PRM",
  "SV.PRM",
  "ARCSRT.CND",
  "ARCEND.CND",
  "WEAV.CND"
] as const

const emptyStore = (): RobotProfilesStore => ({
  version: 1,
  activeProfileId: null,
  profiles: [],
  updatedAt: new Date().toISOString()
})

export const loadProfilesStore = (): RobotProfilesStore => {
  try {
    const raw = localStorage.getItem(ROBOT_PROFILES_STORAGE_KEY)
    if (!raw) {
      return emptyStore()
    }
    const parsed = JSON.parse(raw) as RobotProfilesStore
    if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
      return emptyStore()
    }
    return {
      version: 1,
      activeProfileId: parsed.activeProfileId ?? null,
      profiles: parsed.profiles,
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    }
  } catch {
    return emptyStore()
  }
}

export const saveProfilesStore = (store: RobotProfilesStore): RobotProfilesStore => {
  const next: RobotProfilesStore = {
    ...store,
    version: 1,
    updatedAt: new Date().toISOString()
  }
  localStorage.setItem(ROBOT_PROFILES_STORAGE_KEY, JSON.stringify(next))
  return next
}

export const getActiveProfile = (
  store: RobotProfilesStore = loadProfilesStore()
): RobotProfile | null => {
  if (!store.activeProfileId) {
    return null
  }
  return store.profiles.find((profile) => profile.id === store.activeProfileId) ?? null
}

export const hasActiveRobotProfile = (
  store: RobotProfilesStore = loadProfilesStore()
): boolean => getActiveProfile(store) !== null

export const getRobotInstallGate = (
  store: RobotProfilesStore = loadProfilesStore()
): { allowed: boolean; reason: string; profile: RobotProfile | null } => {
  const profile = getActiveProfile(store)
  if (!profile) {
    return {
      allowed: false,
      reason: "No active robot profile — complete robot install in Setup Guide.",
      profile: null
    }
  }
  return { allowed: true, reason: "Active robot profile loaded.", profile }
}

export const calibrationStorageKeyForProfile = (profileId: string): string =>
  `yaskawa.calibration.v1.${profileId}`

export const calibrationJobNames = (profile: RobotProfile | null) => {
  const tag = (profile?.robotId || profile?.displayName || "ROBOT")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .toUpperCase()
    .slice(0, 24) || "ROBOT"
  return {
    standardName: `CAL_${tag}_STANDARD`,
    relativeName: `CAL_${tag}_RELATIVE`,
    standardFile: `CAL_${tag}_STANDARD.JBI`,
    relativeFile: `CAL_${tag}_RELATIVE.JBI`
  }
}

export const upsertProfile = (
  store: RobotProfilesStore,
  profile: RobotProfile,
  makeActive = true
): RobotProfilesStore => {
  const existingIndex = store.profiles.findIndex((entry) => entry.id === profile.id)
  const profiles =
    existingIndex >= 0
      ? store.profiles.map((entry, index) => (index === existingIndex ? profile : entry))
      : [...store.profiles, profile]
  return saveProfilesStore({
    ...store,
    profiles,
    activeProfileId: makeActive ? profile.id : store.activeProfileId
  })
}

export const setActiveProfileId = (
  store: RobotProfilesStore,
  profileId: string | null
): RobotProfilesStore => {
  if (profileId && !store.profiles.some((profile) => profile.id === profileId)) {
    throw new Error("Profile not found")
  }
  return saveProfilesStore({
    ...store,
    activeProfileId: profileId
  })
}

export const renameProfile = (
  store: RobotProfilesStore,
  profileId: string,
  displayName: string
): RobotProfilesStore => {
  const name = displayName.trim()
  if (!name) {
    throw new Error("Display name is required")
  }
  return saveProfilesStore({
    ...store,
    profiles: store.profiles.map((profile) =>
      profile.id === profileId
        ? { ...profile, displayName: name, updatedAt: new Date().toISOString() }
        : profile
    )
  })
}

export const deleteProfile = (
  store: RobotProfilesStore,
  profileId: string
): RobotProfilesStore => {
  const profiles = store.profiles.filter((profile) => profile.id !== profileId)
  const activeProfileId =
    store.activeProfileId === profileId
      ? profiles[0]?.id ?? null
      : store.activeProfileId
  try {
    localStorage.removeItem(calibrationStorageKeyForProfile(profileId))
  } catch {
    /* ignore */
  }
  return saveProfilesStore({
    ...store,
    profiles,
    activeProfileId
  })
}

export const duplicateProfile = (
  store: RobotProfilesStore,
  profileId: string
): RobotProfilesStore => {
  const source = store.profiles.find((profile) => profile.id === profileId)
  if (!source) {
    throw new Error("Profile not found")
  }
  const copy: RobotProfile = {
    ...source,
    id: crypto.randomUUID(),
    displayName: `${source.displayName} (copy)`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    calibrationId: null
  }
  return upsertProfile(store, copy, false)
}

export const attachCalibrationToActiveProfile = (
  store: RobotProfilesStore,
  calibrationId: string
): RobotProfilesStore => {
  const active = getActiveProfile(store)
  if (!active) {
    return store
  }
  const next: RobotProfile = {
    ...active,
    calibrationId,
    status: "calibrated",
    updatedAt: new Date().toISOString()
  }
  return upsertProfile(store, next, true)
}

export const jobFamilyKey = (name: string): string => {
  const stem = name.replace(/\\/g, "/").split("/").pop() ?? name
  const noExt = stem.replace(/\.jbi$/i, "")
  const noSide = noExt.replace(/[_-]S[12](?=(_|$))/gi, "")
  return noSide.split(/[_-]STEP/i)[0].replace(/[_-]+$/g, "").toUpperCase()
}

export const upsertStationFlipRecipe = (
  store: RobotProfilesStore,
  profileId: string,
  recipe: StationFlipRecipe
): RobotProfilesStore => {
  const profile = store.profiles.find((entry) => entry.id === profileId)
  if (!profile) {
    throw new Error("Profile not found")
  }
  const recipes = [...(profile.stationFlipRecipes ?? [])]
  const idx = recipes.findIndex((entry) => entry.id && entry.id === recipe.id)
  if (idx >= 0) {
    recipes[idx] = recipe
  } else {
    recipes.push(recipe)
  }
  return upsertProfile(
    store,
    {
      ...profile,
      stationFlipRecipes: recipes,
      updatedAt: new Date().toISOString()
    },
    true
  )
}

export const deleteStationFlipRecipe = (
  store: RobotProfilesStore,
  profileId: string,
  recipeId: string
): RobotProfilesStore => {
  const profile = store.profiles.find((entry) => entry.id === profileId)
  if (!profile) {
    throw new Error("Profile not found")
  }
  return upsertProfile(
    store,
    {
      ...profile,
      stationFlipRecipes: (profile.stationFlipRecipes ?? []).filter(
        (entry) => entry.id !== recipeId
      ),
      updatedAt: new Date().toISOString()
    },
    true
  )
}

export const syncActiveProfileToSidecar = async (
  store: RobotProfilesStore = loadProfilesStore()
): Promise<RobotProfile | null> => {
  const profile = getActiveProfile(store)
  if (!profile) {
    return null
  }
  await loadProfile({ profile })
  return profile
}

export const createRobotProfileFromBackup = async (options: {
  folder: string
  displayName?: string
  makeActive?: boolean
}): Promise<{ store: RobotProfilesStore; profile: RobotProfile; scan: ScanBackupResult }> => {
  const result = await createProfileFromBackup({
    folder: options.folder,
    displayName: options.displayName
  })
  const store = upsertProfile(
    loadProfilesStore(),
    result.profile,
    options.makeActive !== false
  )
  return { store, profile: result.profile, scan: result.scan }
}

export const scanRobotBackup = (folder: string): Promise<ScanBackupResult> => {
  return scanBackup(folder)
}

export const profilesStoreJson = (store: RobotProfilesStore): string =>
  JSON.stringify(
    {
      version: store.version,
      activeProfileId: store.activeProfileId,
      profiles: store.profiles
    },
    null,
    2
  ) + "\n"

/** Compare SYSTEM.SYS robot model token against active profile (best-effort). */
export const systemLineMatchesProfile = (
  systemRobotLine: string,
  profile: RobotProfile
): boolean => {
  const line = systemRobotLine.toUpperCase()
  const model = (profile.robotModel || "").toUpperCase()
  const typeCode = (profile.robotTypeCode || "").toUpperCase()
  if (model && line.includes(model)) {
    return true
  }
  if (typeCode && line.includes(typeCode)) {
    return true
  }
  return false
}
