/**
 * Key/value persistence port.
 *
 * Preference and session stores in core must not hardcode `localStorage` so
 * the web shell can swap in IndexedDB (or a memory stub in tests).
 */

export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const memoryStore = (): StoragePort => {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    }
  }
}

const browserLocalStorage = (): StoragePort | null => {
  try {
    const store = globalThis.localStorage
    if (!store || typeof store.getItem !== "function") {
      return null
    }
    return {
      getItem: (key) => store.getItem(key),
      setItem: (key, value) => {
        store.setItem(key, value)
      },
      removeItem: (key) => {
        store.removeItem(key)
      }
    }
  } catch {
    return null
  }
}

let active: StoragePort = browserLocalStorage() ?? memoryStore()

export const getStoragePort = (): StoragePort => active

export const setStoragePort = (port: StoragePort): void => {
  active = port
}

/** Reset to browser localStorage when present, else an in-memory map. */
export const resetStoragePort = (): void => {
  active = browserLocalStorage() ?? memoryStore()
}

export const createMemoryStoragePort = (): StoragePort => memoryStore()
