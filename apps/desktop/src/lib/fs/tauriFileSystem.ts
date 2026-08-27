/**
 * Tauri FileSystemPort adapter — wraps the existing invoke helpers.
 */

import type { FileSystemPort, FolderState, JbiEntry } from "@yaskawa/core/ports/filesystem"
import {
  getFolders,
  listJbiFiles,
  pickFolder,
  readTextFile,
  setOutputFolder,
  setSourceFolder,
  writeOutputFile
} from "./desktop"

export const createTauriFileSystemPort = (): FileSystemPort => ({
  listJbi: (root: string): Promise<JbiEntry[]> => listJbiFiles(root),
  readText: (path: string): Promise<string> => readTextFile(path),
  writeOutput: (path: string, contents: string): Promise<string> =>
    writeOutputFile(path, contents),
  pickSourceFolder: (): Promise<string | null> => pickFolder(),
  pickOutputFolder: (): Promise<string | null> => pickFolder(),
  getFolders: (): Promise<FolderState> => getFolders(),
  setSourceFolder: (path: string): Promise<FolderState> => setSourceFolder(path),
  setOutputFolder: (path: string): Promise<FolderState> => setOutputFolder(path)
})

export type { FileSystemPort, FolderState, JbiEntry }
