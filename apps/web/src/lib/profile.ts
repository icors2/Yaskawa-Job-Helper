/**
 * Web profile helpers: scan / create from a linked backup using core parsers.
 * No Tauri sidecar — filesystem text is supplied by the platform adapters.
 */

import {
  createProfileFromBackup,
  scanBackup,
  type BackupSources
} from "@yaskawa/core/kin/backup"
import type { ScanBackupResult } from "@yaskawa/core/kin/types"
import {
  upsertProfile,
  loadProfilesStore,
  type RobotProfile,
  type RobotProfilesStore
} from "@yaskawa/core/robot/profile"
import type { PlatformApi } from "../platform"

const REQUIRED = ["SYSTEM.SYS", "RC.PRM", "TOOL.CND", "UFRAME.CND"] as const

export const scanRobotBackupWeb = async (
  platform: PlatformApi,
  folderLabel: string
): Promise<ScanBackupResult> => {
  const entries = await platform.listSourceEntries()
  const basenames = entries.map((entry) => {
    const parts = entry.replace(/\\/g, "/").split("/")
    return parts[parts.length - 1] ?? entry
  })
  return scanBackup(folderLabel, basenames)
}

export const createRobotProfileFromBackupWeb = async (
  platform: PlatformApi,
  options: {
    folderLabel: string
    displayName?: string
    makeActive?: boolean
  }
): Promise<{ store: RobotProfilesStore; profile: RobotProfile; scan: ScanBackupResult }> => {
  const scan = await scanRobotBackupWeb(platform, options.folderLabel)
  if (!scan.ready) {
    throw new Error(`Missing required files: ${scan.missingRequired.join(", ")}`)
  }
  const sources: BackupSources = {
    systemSys: await platform.readSourceFile(REQUIRED[0]),
    rcPrm: await platform.readSourceFile(REQUIRED[1]),
    toolCnd: await platform.readSourceFile(REQUIRED[2]),
    uframeCnd: await platform.readSourceFile(REQUIRED[3])
  }
  const profile = createProfileFromBackup(sources, {
    folder: options.folderLabel,
    displayName: options.displayName
  })
  const store = upsertProfile(
    loadProfilesStore(),
    profile,
    options.makeActive !== false
  )
  return { store, profile, scan }
}

export {
  getActiveProfile,
  loadProfilesStore,
  setActiveProfileId,
  deleteProfile,
  renameProfile,
  hasActiveRobotProfile,
  getRobotInstallGate,
  attachCalibrationToActiveProfile,
  ROBOT_PROFILES_FILENAME,
  profilesStoreJson,
  type RobotProfilesStore,
  type RobotProfile
} from "@yaskawa/core/robot/profile"
