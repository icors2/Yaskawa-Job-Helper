import {
  setFileSystemPort,
  type FileSystemPort as CoreFileSystemPort
} from "@yaskawa/core/ports/filesystem"
import { setStoragePort } from "@yaskawa/core/ports/storage"
import { detectFsTier } from "./detect"
import { createChromiumFs } from "./fs/chromium"
import { createFallbackFs } from "./fs/fallback"
import { createIdbStoragePort, migrateLocalStorageToIdb } from "./storage"
import type { PlatformApi } from "./types"

export type { FsTier, FileSystemPort, StoragePort, PlatformApi, JbiEntry, LinkedFolders } from "./types"
export { detectFsTier, tierLabel, tierHint } from "./detect"
export { syncKeyToIdb, migrateLocalStorageToIdb } from "./storage"
export { ROBOT_PROFILES_FILENAME } from "@yaskawa/core/robot/profile"

const wireCorePorts = (
  webFs: PlatformApi["fs"],
  storage: PlatformApi["storage"]
): void => {
  // Core StoragePort is sync; keep localStorage as the live cache and mirror to IDB.
  setStoragePort({
    getItem: (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    setItem: (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, value)
      } catch {
        /* quota */
      }
      void storage.setItem(key, value)
    },
    removeItem: (key) => {
      try {
        globalThis.localStorage?.removeItem(key)
      } catch {
        /* ignore */
      }
      void storage.removeItem(key)
    }
  })

  const coreFs: CoreFileSystemPort = {
    listJbi: async (_root?: string) => webFs.listJbi(),
    readText: (path) => webFs.readText(path),
    writeOutput: (path, contents) => webFs.writeOutput(path, contents),
    pickSourceFolder: () => webFs.pickSourceFolder(),
    pickOutputFolder: () => webFs.pickOutputFolder()
  }
  setFileSystemPort(coreFs)
}

export const createPlatform = async (): Promise<PlatformApi> => {
  await migrateLocalStorageToIdb()
  const tier = detectFsTier()
  const storage = createIdbStoragePort()
  const backend = tier === "directory-picker" ? createChromiumFs() : createFallbackFs()
  await backend.restore()

  wireCorePorts(backend.fs, storage)

  return {
    tier,
    fs: backend.fs,
    storage,
    folders: backend.folders,
    reconnectSource: backend.reconnectSource,
    reconnectOutput: backend.reconnectOutput,
    listSourceEntries: backend.listSourceEntries,
    readSourceFile: backend.readSourceFile,
    mirrorProfilesJson: backend.mirrorProfilesJson,
    refreshPermissionState: backend.refreshPermissionState
  }
}
