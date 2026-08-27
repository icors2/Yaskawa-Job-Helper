import type { FsTier } from "./types"

/** Chromium (Chrome / Edge) expose showDirectoryPicker; Firefox / Safari do not. */
export const detectFsTier = (): FsTier => {
  if (typeof window === "undefined") {
    return "upload-download"
  }
  const picker = (
    window as Window & {
      showDirectoryPicker?: (options?: unknown) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker
  return typeof picker === "function" ? "directory-picker" : "upload-download"
}

export const tierLabel = (tier: FsTier): string =>
  tier === "directory-picker"
    ? "Chromium folder link (File System Access API)"
    : "Upload / download fallback (Firefox / Safari)"

export const tierHint = (tier: FsTier): string =>
  tier === "directory-picker"
    ? "Link a controller backup and a writable output folder. Handles persist in IndexedDB."
    : "Pick a folder via the file picker (read) and download rewritten jobs (write). Prefer Chrome or Edge for full folder linking."
