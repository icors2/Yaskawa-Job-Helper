/**
 * Web platform port shapes.
 *
 * Align with `@yaskawa/core` FileSystemPort / StoragePort when the sibling
 * ports agent lands them — method names match the plan so adapters can swap.
 */

export type FsTier = "directory-picker" | "upload-download"

export interface JbiEntry {
  name: string
  path: string
  relativePath: string
}

export interface FileSystemPort {
  listJbi: (root?: string) => Promise<JbiEntry[]>
  readText: (path: string) => Promise<string>
  writeOutput: (path: string, contents: string) => Promise<string>
  pickSourceFolder: () => Promise<string | null>
  pickOutputFolder: () => Promise<string | null>
}

export interface StoragePort {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
}

export interface LinkedFolders {
  sourceLabel: string | null
  outputLabel: string | null
  sourceReady: boolean
  outputReady: boolean
  sourceNeedsReconnect: boolean
  outputNeedsReconnect: boolean
}

export interface PlatformApi {
  tier: FsTier
  fs: FileSystemPort
  storage: StoragePort
  folders: () => LinkedFolders
  reconnectSource: () => Promise<boolean>
  reconnectOutput: () => Promise<boolean>
  /** List bare filenames under the linked source (for backup scan). */
  listSourceEntries: () => Promise<string[]>
  /** Read a required backup file by basename from the source link. */
  readSourceFile: (basename: string) => Promise<string>
  /** Mirror profiles JSON into the linked output folder when writable. */
  mirrorProfilesJson: (json: string) => Promise<string | null>
  refreshPermissionState: () => Promise<LinkedFolders>
}
