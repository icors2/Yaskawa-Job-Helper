/**
 * Folder / job file access port.
 *
 * Desktop maps these to Tauri `invoke`s; web maps them to the File System
 * Access API (or an upload/download fallback). Core never imports Tauri.
 */

export interface JbiEntry {
  name: string
  path: string
  relativePath: string
}

export interface FolderState {
  sourceFolder: string | null
  outputFolder: string | null
}

export interface FileSystemPort {
  listJbi(root: string): Promise<JbiEntry[]>
  readText(path: string): Promise<string>
  writeOutput(path: string, contents: string): Promise<string>
  pickSourceFolder(): Promise<string | null>
  pickOutputFolder(): Promise<string | null>
  /** Optional: shells that track a session folder pair. */
  getFolders?(): Promise<FolderState>
  setSourceFolder?(path: string): Promise<FolderState>
  setOutputFolder?(path: string): Promise<FolderState>
}

let active: FileSystemPort | null = null

export const getFileSystemPort = (): FileSystemPort => {
  if (!active) {
    throw new Error(
      "FileSystemPort is not configured. Call setFileSystemPort() from the shell (Tauri or web)."
    )
  }
  return active
}

export const setFileSystemPort = (port: FileSystemPort): void => {
  active = port
}

export const clearFileSystemPort = (): void => {
  active = null
}

export const hasFileSystemPort = (): boolean => active !== null
