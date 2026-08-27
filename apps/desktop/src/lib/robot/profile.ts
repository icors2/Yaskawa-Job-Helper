/**
 * Desktop profile store: the platform-agnostic store from `@yaskawa/core`
 * plus the three operations that need the Tauri sidecar (backup scan,
 * profile creation, and pushing the active profile to the sidecar).
 */

import {
  createProfileFromBackup,
  loadProfile,
  scanBackup,
  type ScanBackupResult
} from "../kin/client"
import {
  getActiveProfile,
  loadProfilesStore,
  upsertProfile,
  type RobotProfile,
  type RobotProfilesStore
} from "@yaskawa/core/robot/profile"

export * from "@yaskawa/core/robot/profile"

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
