/**
 * Per-profile source/output folder persistence and output naming convention.
 *
 * Convention: when a source jobs folder is chosen, the app creates (if missing)
 *   <sourceParent>/YaskawaJobEditor_Output
 * and uses that as the write target. Never writes into the source tree.
 */

import { joinPath } from "../fs/paths"

export const FOLDER_PREFS_STORAGE_KEY = "yaskawa.folders.v1"
export const OUTPUT_FOLDER_BASENAME = "YaskawaJobEditor_Output"
export const USB_EXPORT_DEFAULT_SUBDIR = "YaskawaJobs"

export interface ProfileFolderPrefs {
  sourceFolder: string | null
  outputFolder: string | null
  updatedAt: string
}

export interface FolderPrefsStore {
  version: 1
  byProfileId: Record<string, ProfileFolderPrefs>
  /** Last used when no profile was active (legacy / bootstrap). */
  global?: ProfileFolderPrefs
}

const emptyStore = (): FolderPrefsStore => ({
  version: 1,
  byProfileId: {}
})

export const loadFolderPrefsStore = (): FolderPrefsStore => {
  try {
    const raw = localStorage.getItem(FOLDER_PREFS_STORAGE_KEY)
    if (!raw) {
      return emptyStore()
    }
    const parsed = JSON.parse(raw) as FolderPrefsStore
    if (parsed.version !== 1 || typeof parsed.byProfileId !== "object") {
      return emptyStore()
    }
    return {
      version: 1,
      byProfileId: parsed.byProfileId ?? {},
      global: parsed.global
    }
  } catch {
    return emptyStore()
  }
}

export const saveFolderPrefsStore = (store: FolderPrefsStore): FolderPrefsStore => {
  const next: FolderPrefsStore = { ...store, version: 1 }
  localStorage.setItem(FOLDER_PREFS_STORAGE_KEY, JSON.stringify(next))
  return next
}

export const getFolderPrefsForProfile = (
  profileId: string | null,
  store: FolderPrefsStore = loadFolderPrefsStore()
): ProfileFolderPrefs | null => {
  if (profileId && store.byProfileId[profileId]) {
    return store.byProfileId[profileId]
  }
  return store.global ?? null
}

export const setFolderPrefsForProfile = (
  profileId: string | null,
  prefs: Partial<ProfileFolderPrefs>
): FolderPrefsStore => {
  const store = loadFolderPrefsStore()
  const prev =
    (profileId ? store.byProfileId[profileId] : store.global) ??
    ({
      sourceFolder: null,
      outputFolder: null,
      updatedAt: new Date().toISOString()
    } satisfies ProfileFolderPrefs)
  const nextPrefs: ProfileFolderPrefs = {
    sourceFolder: prefs.sourceFolder !== undefined ? prefs.sourceFolder : prev.sourceFolder,
    outputFolder: prefs.outputFolder !== undefined ? prefs.outputFolder : prev.outputFolder,
    updatedAt: new Date().toISOString()
  }
  if (profileId) {
    return saveFolderPrefsStore({
      ...store,
      byProfileId: {
        ...store.byProfileId,
        [profileId]: nextPrefs
      }
    })
  }
  return saveFolderPrefsStore({
    ...store,
    global: nextPrefs
  })
}

/** Parent directory of a path (folder or file). */
export const parentDir = (path: string): string => {
  const normalized = path.replace(/[\\/]+$/, "")
  const idx = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"))
  if (idx <= 0) {
    return normalized
  }
  return normalized.slice(0, idx)
}

/**
 * Default output folder beside the source tree:
 * `<sourceParent>/YaskawaJobEditor_Output`
 */
export const defaultOutputFolderForSource = (sourceFolder: string): string => {
  const parent = parentDir(sourceFolder)
  return joinPath(parent, OUTPUT_FOLDER_BASENAME)
}

export const folderConventionHelp = (): string[] => [
  `When you choose a source jobs folder, the app creates ${OUTPUT_FOLDER_BASENAME} next to it:`,
  `  <parent of source>\\${OUTPUT_FOLDER_BASENAME}`,
  "All edited .JBI files, calibration exports, and profile mirrors write there.",
  "The source / pendant backup folder stays read-only — never overwritten in place.",
  `USB export copies from the output folder to a drive folder such as ${USB_EXPORT_DEFAULT_SUBDIR}/.`
]
