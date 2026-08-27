const DB_NAME = "yaskawa-web"
const DB_VERSION = 1
const STORE_KV = "kv"
const STORE_HANDLES = "handles"

export type HandleRole = "source" | "output"

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV)
      }
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES)
      }
    }
  })

const idbRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })

export const idbGet = async (key: string): Promise<string | null> => {
  const db = await openDb()
  try {
    const value = await idbRequest(
      db.transaction(STORE_KV, "readonly").objectStore(STORE_KV).get(key)
    )
    return typeof value === "string" ? value : value == null ? null : String(value)
  } finally {
    db.close()
  }
}

export const idbSet = async (key: string, value: string): Promise<void> => {
  const db = await openDb()
  try {
    await idbRequest(
      db.transaction(STORE_KV, "readwrite").objectStore(STORE_KV).put(value, key)
    )
  } finally {
    db.close()
  }
}

export const idbRemove = async (key: string): Promise<void> => {
  const db = await openDb()
  try {
    await idbRequest(
      db.transaction(STORE_KV, "readwrite").objectStore(STORE_KV).delete(key)
    )
  } finally {
    db.close()
  }
}

export const idbGetHandle = async (
  role: HandleRole
): Promise<FileSystemDirectoryHandle | null> => {
  const db = await openDb()
  try {
    const value = await idbRequest(
      db.transaction(STORE_HANDLES, "readonly").objectStore(STORE_HANDLES).get(role)
    )
    return (value as FileSystemDirectoryHandle | undefined) ?? null
  } finally {
    db.close()
  }
}

export const idbSetHandle = async (
  role: HandleRole,
  handle: FileSystemDirectoryHandle
): Promise<void> => {
  const db = await openDb()
  try {
    await idbRequest(
      db.transaction(STORE_HANDLES, "readwrite").objectStore(STORE_HANDLES).put(handle, role)
    )
  } finally {
    db.close()
  }
}

export const idbClearHandle = async (role: HandleRole): Promise<void> => {
  const db = await openDb()
  try {
    await idbRequest(
      db.transaction(STORE_HANDLES, "readwrite").objectStore(STORE_HANDLES).delete(role)
    )
  } finally {
    db.close()
  }
}
