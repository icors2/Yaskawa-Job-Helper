import { ROBOT_PROFILES_FILENAME } from "@yaskawa/core/robot/profile"
import { idbClearHandle, idbGetHandle, idbSetHandle, type HandleRole } from "../idb"
import type { FileSystemPort, JbiEntry, LinkedFolders } from "../types"

const hasDirectoryPicker = (): boolean =>
  typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker ===
  "function"

const showDirectoryPicker = (mode: "read" | "readwrite"): Promise<FileSystemDirectoryHandle> => {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (options?: {
        mode?: "read" | "readwrite"
      }) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker
  return picker({ mode })
}

type FsPermissionState = "granted" | "denied" | "prompt"

const queryPermission = async (
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite"
): Promise<FsPermissionState> => {
  const withPerms = handle as FileSystemDirectoryHandle & {
    queryPermission?: (descriptor: {
      mode: "read" | "readwrite"
    }) => Promise<FsPermissionState>
    requestPermission?: (descriptor: {
      mode: "read" | "readwrite"
    }) => Promise<FsPermissionState>
  }
  if (typeof withPerms.queryPermission !== "function") {
    return "granted"
  }
  return withPerms.queryPermission({ mode })
}

const requestPermission = async (
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite"
): Promise<boolean> => {
  const withPerms = handle as FileSystemDirectoryHandle & {
    requestPermission?: (descriptor: {
      mode: "read" | "readwrite"
    }) => Promise<FsPermissionState>
  }
  const current = await queryPermission(handle, mode)
  if (current === "granted") {
    return true
  }
  if (typeof withPerms.requestPermission !== "function") {
    return true
  }
  const next = await withPerms.requestPermission({ mode })
  return next === "granted"
}

const walkJbi = async (
  dir: FileSystemDirectoryHandle,
  prefix = ""
): Promise<JbiEntry[]> => {
  const entries: JbiEntry[] = []
  // @ts-expect-error — async iterator on FileSystemDirectoryHandle
  for await (const [name, handle] of dir.entries()) {
    const relative = prefix ? `${prefix}/${name}` : name
    if (handle.kind === "directory") {
      entries.push(...(await walkJbi(handle as FileSystemDirectoryHandle, relative)))
      continue
    }
    if (handle.kind === "file" && name.toUpperCase().endsWith(".JBI")) {
      entries.push({
        name,
        path: relative,
        relativePath: relative
      })
    }
  }
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

const listBasenames = async (dir: FileSystemDirectoryHandle): Promise<string[]> => {
  const names: string[] = []
  // @ts-expect-error — async iterator
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file") {
      names.push(name)
    } else if (handle.kind === "directory") {
      const nested = await listBasenames(handle as FileSystemDirectoryHandle)
      for (const child of nested) {
        names.push(`${name}/${child}`)
      }
      names.push(name)
    }
  }
  return names
}

const resolveFile = async (
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<FileSystemFileHandle> => {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length === 0) {
    throw new Error("Empty path")
  }
  let dir = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    dir = await dir.getDirectoryHandle(parts[index])
  }
  return dir.getFileHandle(parts[parts.length - 1])
}

const ensureDirPath = async (
  root: FileSystemDirectoryHandle,
  relativeDir: string
): Promise<FileSystemDirectoryHandle> => {
  const parts = relativeDir.replace(/\\/g, "/").split("/").filter(Boolean)
  let dir = root
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  return dir
}

const writeRelative = async (
  root: FileSystemDirectoryHandle,
  relativePath: string,
  contents: string
): Promise<string> => {
  const normalized = relativePath.replace(/\\/g, "/")
  const parts = normalized.split("/").filter(Boolean)
  const fileName = parts[parts.length - 1]
  const dirParts = parts.slice(0, -1)
  const dir =
    dirParts.length > 0 ? await ensureDirPath(root, dirParts.join("/")) : root
  const fileHandle = await dir.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(contents)
  await writable.close()
  return normalized
}

const findBasename = async (
  root: FileSystemDirectoryHandle,
  basename: string,
  prefix = ""
): Promise<string | null> => {
  const upper = basename.toUpperCase()
  // @ts-expect-error — async iterator
  for await (const [name, handle] of root.entries()) {
    const relative = prefix ? `${prefix}/${name}` : name
    if (handle.kind === "file" && name.toUpperCase() === upper) {
      return relative
    }
    if (handle.kind === "directory") {
      const found = await findBasename(
        handle as FileSystemDirectoryHandle,
        basename,
        relative
      )
      if (found) {
        return found
      }
    }
  }
  return null
}

export interface ChromiumFsState {
  source: FileSystemDirectoryHandle | null
  output: FileSystemDirectoryHandle | null
  sourceLabel: string | null
  outputLabel: string | null
  sourceGranted: boolean
  outputGranted: boolean
}

export const createChromiumFs = () => {
  const state: ChromiumFsState = {
    source: null,
    output: null,
    sourceLabel: null,
    outputLabel: null,
    sourceGranted: false,
    outputGranted: false
  }

  const folders = (): LinkedFolders => ({
    sourceLabel: state.sourceLabel,
    outputLabel: state.outputLabel,
    sourceReady: Boolean(state.source && state.sourceGranted),
    outputReady: Boolean(state.output && state.outputGranted),
    sourceNeedsReconnect: Boolean(state.source && !state.sourceGranted),
    outputNeedsReconnect: Boolean(state.output && !state.outputGranted)
  })

  const attach = async (
    role: HandleRole,
    handle: FileSystemDirectoryHandle,
    mode: "read" | "readwrite"
  ): Promise<boolean> => {
    const granted = await requestPermission(handle, mode)
    if (role === "source") {
      state.source = handle
      state.sourceLabel = handle.name
      state.sourceGranted = granted
    } else {
      state.output = handle
      state.outputLabel = handle.name
      state.outputGranted = granted
    }
    if (granted) {
      await idbSetHandle(role, handle)
    }
    return granted
  }

  const restore = async (): Promise<LinkedFolders> => {
    if (!hasDirectoryPicker()) {
      return folders()
    }
    const source = await idbGetHandle("source")
    const output = await idbGetHandle("output")
    if (source) {
      state.source = source
      state.sourceLabel = source.name
      const perm = await queryPermission(source, "read")
      state.sourceGranted = perm === "granted"
    }
    if (output) {
      state.output = output
      state.outputLabel = output.name
      const perm = await queryPermission(output, "readwrite")
      state.outputGranted = perm === "granted"
    }
    return folders()
  }

  const reconnect = async (role: HandleRole): Promise<boolean> => {
    const handle = role === "source" ? state.source : state.output
    if (!handle) {
      return false
    }
    const mode = role === "source" ? "read" : "readwrite"
    return attach(role, handle, mode)
  }

  const requireSource = (): FileSystemDirectoryHandle => {
    if (!state.source || !state.sourceGranted) {
      throw new Error("Source folder not linked — reconnect or pick a controller backup.")
    }
    return state.source
  }

  const requireOutput = (): FileSystemDirectoryHandle => {
    if (!state.output || !state.outputGranted) {
      throw new Error("Output folder not linked — reconnect or pick a writable output folder.")
    }
    return state.output
  }

  const fs: FileSystemPort = {
    pickSourceFolder: async () => {
      const handle = await showDirectoryPicker("read")
      const ok = await attach("source", handle, "read")
      return ok ? handle.name : null
    },
    pickOutputFolder: async () => {
      const handle = await showDirectoryPicker("readwrite")
      const ok = await attach("output", handle, "readwrite")
      return ok ? handle.name : null
    },
    listJbi: async () => {
      const root = requireSource()
      return walkJbi(root)
    },
    readText: async (path) => {
      const root = requireSource()
      const fileHandle = await resolveFile(root, path)
      const file = await fileHandle.getFile()
      return file.text()
    },
    writeOutput: async (path, contents) => {
      const root = requireOutput()
      // Strip any absolute-looking prefix; web paths are relative to the output handle.
      const relative = path.replace(/^[/\\]+/, "").replace(/\\/g, "/")
      return writeRelative(root, relative, contents)
    }
  }

  const listSourceEntries = async (): Promise<string[]> => {
    const root = requireSource()
    return listBasenames(root)
  }

  const readSourceFile = async (basename: string): Promise<string> => {
    const root = requireSource()
    const relative = await findBasename(root, basename)
    if (!relative) {
      throw new Error(`Missing ${basename} in linked source folder`)
    }
    const fileHandle = await resolveFile(root, relative)
    const file = await fileHandle.getFile()
    return file.text()
  }

  const mirrorProfilesJson = async (json: string): Promise<string | null> => {
    if (!state.output || !state.outputGranted) {
      return null
    }
    return writeRelative(state.output, ROBOT_PROFILES_FILENAME, json)
  }

  const clearRole = async (role: HandleRole): Promise<void> => {
    await idbClearHandle(role)
    if (role === "source") {
      state.source = null
      state.sourceLabel = null
      state.sourceGranted = false
    } else {
      state.output = null
      state.outputLabel = null
      state.outputGranted = false
    }
  }

  return {
    fs,
    folders,
    restore,
    reconnectSource: () => reconnect("source"),
    reconnectOutput: () => reconnect("output"),
    listSourceEntries,
    readSourceFile,
    mirrorProfilesJson,
    clearRole,
    refreshPermissionState: restore
  }
}

export type ChromiumFsApi = ReturnType<typeof createChromiumFs>
