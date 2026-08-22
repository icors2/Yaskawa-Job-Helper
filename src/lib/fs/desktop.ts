import { invoke } from "@tauri-apps/api/core"

export interface JbiEntry {
  name: string
  path: string
  relativePath: string
}

export interface FolderState {
  sourceFolder: string | null
  outputFolder: string | null
}

export const pickFolder = (): Promise<string | null> => {
  return invoke<string | null>("pick_folder")
}

export const setSourceFolder = (path: string): Promise<FolderState> => {
  return invoke<FolderState>("set_source_folder", { path })
}

export const setOutputFolder = (path: string): Promise<FolderState> => {
  return invoke<FolderState>("set_output_folder", { path })
}

export const getFolders = (): Promise<FolderState> => {
  return invoke<FolderState>("get_folders")
}

export const listJbiFiles = (root: string): Promise<JbiEntry[]> => {
  return invoke<JbiEntry[]>("list_jbi_files", { root })
}

export const readTextFile = (path: string): Promise<string> => {
  return invoke<string>("read_text_file", { path })
}

export const writeOutputFile = (path: string, contents: string): Promise<string> => {
  return invoke<string>("write_output_file", { path, contents })
}

export const listRemovableMedia = (): Promise<string[]> => {
  return invoke<string[]>("list_removable_media")
}

export interface RemovableDrive {
  path: string
  driveType: string
  label: string
}

export interface ExportToUsbResult {
  destination: string
  filesCopied: number
  bytesCopied: number
}

export const listRemovableDrives = (): Promise<RemovableDrive[]> => {
  return invoke<RemovableDrive[]>("list_removable_drives")
}

export const ensureDirectory = (path: string): Promise<string> => {
  return invoke<string>("ensure_directory", { path })
}

export const exportToRemovable = (options: {
  sourcePath: string
  usbRoot: string
  destSubdir: string
}): Promise<ExportToUsbResult> => {
  return invoke<ExportToUsbResult>("export_to_removable", {
    sourcePath: options.sourcePath,
    usbRoot: options.usbRoot,
    destSubdir: options.destSubdir
  })
}
