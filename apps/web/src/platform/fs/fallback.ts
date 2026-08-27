import {
  CONTROLLER_FILE_ALIASES
} from "@yaskawa/core/kin/backup"
import { ROBOT_PROFILES_FILENAME } from "@yaskawa/core/robot/profile"
import type { FileSystemPort, JbiEntry, LinkedFolders } from "../types"

interface VirtualFile {
  relativePath: string
  name: string
  file: File
}

const pickDirectoryFiles = (): Promise<FileList | null> =>
  new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.setAttribute("webkitdirectory", "")
    input.setAttribute("directory", "")
    input.style.display = "none"
    const handleChange = () => {
      input.removeEventListener("change", handleChange)
      document.body.removeChild(input)
      resolve(input.files)
    }
    input.addEventListener("change", handleChange)
    document.body.appendChild(input)
    input.click()
  })

const relativeFromFile = (file: File): string => {
  const path =
    (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
  return path.replace(/\\/g, "/")
}

const downloadText = (filename: string, contents: string): void => {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename.replace(/^.*[/\\]/, "")
  anchor.rel = "noopener"
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

const namesFor = (basename: string): string[] => {
  const aliases = CONTROLLER_FILE_ALIASES[basename] ?? []
  return [basename, ...aliases]
}

const pickSingleFile = (accept: string, label: string): Promise<File | null> =>
  new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    if (accept) {
      input.accept = accept
    }
    input.style.display = "none"
    input.setAttribute("aria-label", label)
    const handleChange = () => {
      input.removeEventListener("change", handleChange)
      document.body.removeChild(input)
      resolve(input.files?.item(0) ?? null)
    }
    input.addEventListener("change", handleChange)
    document.body.appendChild(input)
    input.click()
  })

export const createFallbackFs = () => {
  let sourceFiles: VirtualFile[] = []
  let sourceLabel: string | null = null
  let outputLabel: string | null = null
  let outputChosen = false

  const folders = (): LinkedFolders => ({
    sourceLabel,
    outputLabel: outputChosen ? outputLabel ?? "Downloads" : null,
    sourceReady: sourceFiles.length > 0,
    outputReady: outputChosen,
    sourceNeedsReconnect: false,
    outputNeedsReconnect: false
  })

  const ingest = (list: FileList | null, role: "source" | "output"): string | null => {
    if (!list || list.length === 0) {
      return null
    }
    const files: VirtualFile[] = []
    for (let index = 0; index < list.length; index += 1) {
      const file = list.item(index)
      if (!file) {
        continue
      }
      const relativePath = relativeFromFile(file)
      files.push({
        relativePath,
        name: file.name,
        file
      })
    }
    const top =
      files[0]?.relativePath.split("/")[0] ??
      (role === "source" ? "source" : "output")
    if (role === "source") {
      sourceFiles = files
      sourceLabel = top
      return top
    }
    outputLabel = "Downloads"
    outputChosen = true
    return outputLabel
  }

  const findFile = (path: string): VirtualFile | undefined => {
    const normalized = path.replace(/\\/g, "/")
    return (
      sourceFiles.find((entry) => entry.relativePath === normalized) ??
      sourceFiles.find((entry) => entry.relativePath.endsWith(`/${normalized}`)) ??
      sourceFiles.find((entry) => entry.name.toUpperCase() === normalized.toUpperCase())
    )
  }

  const findByBasename = (basename: string): VirtualFile | undefined => {
    const wanted = new Set(namesFor(basename).map((name) => name.toUpperCase()))
    return (
      sourceFiles.find((entry) => wanted.has(entry.name.toUpperCase())) ??
      sourceFiles.find((entry) => {
        const leaf = entry.relativePath.split("/").pop() ?? entry.name
        return wanted.has(leaf.toUpperCase())
      })
    )
  }

  const fs: FileSystemPort = {
    pickSourceFolder: async () => {
      const list = await pickDirectoryFiles()
      return ingest(list, "source")
    },
    pickOutputFolder: async () => {
      outputChosen = true
      outputLabel = "Downloads"
      return outputLabel
    },
    listJbi: async () => {
      if (sourceFiles.length === 0) {
        throw new Error("No source folder uploaded yet.")
      }
      const entries: JbiEntry[] = sourceFiles
        .filter((entry) => entry.name.toUpperCase().endsWith(".JBI"))
        .map((entry) => ({
          name: entry.name,
          path: entry.relativePath,
          relativePath: entry.relativePath
        }))
      return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    },
    readText: async (path) => {
      const hit = findFile(path)
      if (!hit) {
        throw new Error(`File not found in uploaded folder: ${path}`)
      }
      return hit.file.text()
    },
    writeOutput: async (path, contents) => {
      if (!outputChosen) {
        throw new Error("Confirm download output first (Pick output / Downloads).")
      }
      const name = path.replace(/^.*[/\\]/, "") || "output.txt"
      downloadText(name, contents)
      return name
    }
  }

  const listSourceEntries = async (): Promise<string[]> => {
    if (sourceFiles.length === 0) {
      throw new Error("No source folder uploaded yet.")
    }
    return sourceFiles.map((entry) => entry.relativePath)
  }

  const readSourceFile = async (basename: string): Promise<string> => {
    const hit = findByBasename(basename)
    if (!hit) {
      throw new Error(
        `Missing ${basename} in uploaded folder` +
          (basename.toUpperCase() === "SYSTEM.SYS"
            ? " (upload may omit .SYS — pick SYSTEM.SYS manually or rename to SYSTEM.SYS.TXT)"
            : "")
      )
    }
    return hit.file.text()
  }

  const ensureControllerFiles = async (names: readonly string[]): Promise<void> => {
    if (sourceFiles.length === 0) {
      throw new Error("No source folder uploaded yet.")
    }
    for (const name of names) {
      if (findByBasename(name)) {
        continue
      }
      const accept =
        name.toUpperCase() === "SYSTEM.SYS" ? ".sys,.SYS,.txt,.TXT,text/plain" : ""
      const picked = await pickSingleFile(
        accept,
        `Select ${name} (folder upload did not include it)`
      )
      if (!picked) {
        continue
      }
      sourceFiles.push({
        relativePath: picked.name,
        name: picked.name,
        file: picked
      })
    }
  }

  const mirrorProfilesJson = async (json: string): Promise<string | null> => {
    if (!outputChosen) {
      return null
    }
    const name = ROBOT_PROFILES_FILENAME.replace(/^.*[/\\]/, "")
    downloadText(name, json)
    return name
  }

  return {
    fs,
    folders,
    restore: async () => folders(),
    reconnectSource: async () => false,
    reconnectOutput: async () => false,
    listSourceEntries,
    readSourceFile,
    ensureControllerFiles,
    mirrorProfilesJson,
    refreshPermissionState: async () => folders()
  }
}

export type FallbackFsApi = ReturnType<typeof createFallbackFs>
