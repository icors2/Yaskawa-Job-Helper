import { idbGet, idbRemove, idbSet } from "./idb"
import type { StoragePort } from "./types"

/**
 * Keys migrated from localStorage into IndexedDB on first load.
 * Core preference modules still read/write localStorage until the sibling
 * StoragePort injection lands — we keep both in sync for durability.
 */
export const MIGRATION_KEY_PREFIXES = [
  "yaskawa.robot.profiles.v1",
  "yaskawa.folders.v1",
  "yaskawa.calibration.v1",
  "yaskawa.setup.v1",
  "yaskawa.calibration.session.v1",
  "yaskawa.pulseMirror.v1"
] as const

const MIGRATION_FLAG = "yaskawa.web.idb.migrated.v1"

const shouldMigrateKey = (key: string): boolean =>
  MIGRATION_KEY_PREFIXES.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(prefix)
  )

export const migrateLocalStorageToIdb = async (): Promise<number> => {
  if (typeof localStorage === "undefined") {
    return 0
  }
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === "1") {
      // Still hydrate localStorage from IDB when the browser cache was cleared
      // but IDB retained profiles (folder = eventual source of truth; IDB is cache).
      await hydrateLocalStorageFromIdb()
      return 0
    }
  } catch {
    /* ignore */
  }

  let migrated = 0
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key && shouldMigrateKey(key)) {
      keys.push(key)
    }
  }
  for (const key of keys) {
    const value = localStorage.getItem(key)
    if (value == null) {
      continue
    }
    const existing = await idbGet(key)
    if (existing == null) {
      await idbSet(key, value)
      migrated += 1
    }
  }
  await hydrateLocalStorageFromIdb()
  try {
    localStorage.setItem(MIGRATION_FLAG, "1")
  } catch {
    /* ignore */
  }
  return migrated
}

/** Restore IDB-backed keys into localStorage so @yaskawa/core stores keep working. */
export const hydrateLocalStorageFromIdb = async (): Promise<void> => {
  for (const prefix of MIGRATION_KEY_PREFIXES) {
    const exact = await idbGet(prefix)
    if (exact != null) {
      try {
        if (!localStorage.getItem(prefix)) {
          localStorage.setItem(prefix, exact)
        }
      } catch {
        /* ignore quota */
      }
    }
  }
  // Per-profile calibration keys are discovered via localStorage enumeration
  // after profiles load; also pull any IDB keys that look like calib.*
  // We cannot enumerate IDB keys easily without a cursor — open a one-shot scan.
  await scanIdbCalibrationKeys()
}

const scanIdbCalibrationKeys = async (): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("yaskawa-web", 1)
    request.onerror = () => reject(request.error ?? new Error("IDB open failed"))
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction("kv", "readonly")
      const store = tx.objectStore("kv")
      const cursorReq = store.openCursor()
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error("cursor failed"))
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) {
          return
        }
        const key = String(cursor.key)
        if (key.startsWith("yaskawa.calibration.v1.") || key.startsWith("yaskawa.pulseMirror.v1.")) {
          const value = cursor.value
          if (typeof value === "string") {
            try {
              if (!localStorage.getItem(key)) {
                localStorage.setItem(key, value)
              }
            } catch {
              /* ignore */
            }
          }
        }
        cursor.continue()
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
    }
  })
}

/**
 * StoragePort backed by IndexedDB, mirroring writes to localStorage so core
 * modules that still call localStorage stay consistent.
 */
export const createIdbStoragePort = (): StoragePort => ({
  getItem: async (key) => {
    const fromIdb = await idbGet(key)
    if (fromIdb != null) {
      return fromIdb
    }
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: async (key, value) => {
    await idbSet(key, value)
    try {
      localStorage.setItem(key, value)
    } catch {
      /* quota — IDB still holds the durable copy */
    }
  },
  removeItem: async (key) => {
    await idbRemove(key)
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
})

/** Push a localStorage write into IDB (call after core saveProfilesStore etc.). */
export const syncKeyToIdb = async (key: string): Promise<void> => {
  try {
    const value = localStorage.getItem(key)
    if (value != null) {
      await idbSet(key, value)
    }
  } catch {
    /* ignore */
  }
}
