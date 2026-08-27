/**
 * Desktop StoragePort — browser localStorage (Tauri webview).
 */

import type { StoragePort } from "@yaskawa/core/ports/storage"

export const createTauriStoragePort = (): StoragePort => ({
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    window.localStorage.setItem(key, value)
  },
  removeItem: (key) => {
    window.localStorage.removeItem(key)
  }
})

export type { StoragePort }
