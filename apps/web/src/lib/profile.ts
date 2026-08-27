/**
 * Web profile helpers: scan / create from a linked backup using core parsers.
 * No Tauri sidecar — filesystem text is supplied by the platform adapters.
 */

import {
  CONTROLLER_FILE_ALIASES,
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

const topLevelSample = (entries: readonly string[], limit = 12): string => {
  const top = entries
    .map((entry) => entry.replace(/\\/g, "/"))
    .filter((entry) => !entry.includes("/"))
    .slice(0, limit)
  if (top.length === 0) {
    return "(no top-level files listed — pick the folder that contains SYSTEM.SYS, or Chrome may be hiding .SYS)"
  }
  const more = entries.length > top.length ? ` … +${entries.length - top.length} more` : ""
  return top.join(", ") + more
}

const missingScanMessage = (
  missing: readonly string[],
  entries: readonly string[]
): string => {
  const aliasHint = missing.includes("SYSTEM.SYS")
    ? " If your browser hides .SYS files, copy SYSTEM.SYS to SYSTEM.SYS.TXT in the backup (or use Upload SYSTEM.SYS)."
    : ""
  return (
    `Missing required files: ${missing.join(", ")}. ` +
    `Top-level in linked folder: ${topLevelSample(entries)}.${aliasHint}`
  )
}

export const scanRobotBackupWeb = async (
  platform: PlatformApi,
  folderLabel: string
): Promise<ScanBackupResult> => {
  if (platform.ensureControllerFiles) {
    await platform.ensureControllerFiles([...REQUIRED])
  }
  const entries = await platform.listSourceEntries()
  return scanBackup(folderLabel, entries)
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
    const entries = await platform.listSourceEntries()
    throw new Error(missingScanMessage(scan.missingRequired, entries))
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

export const controllerFileAliases = CONTROLLER_FILE_ALIASES

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
