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

  const fs: FileSystemPort = {
    pickSourceFolder: async () => {
      const list = await pickDirectoryFiles()
      return ingest(list, "source")
    },
    pickOutputFolder: async () => {
      // Fallback cannot grant a writable directory; mark Downloads as the sink.
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
    const upper = basename.toUpperCase()
    const hit =
      sourceFiles.find((entry) => entry.name.toUpperCase() === upper) ??
      sourceFiles.find((entry) =>
        entry.relativePath.toUpperCase().endsWith(`/${upper}`)
      )
    if (!hit) {
      throw new Error(`Missing ${basename} in uploaded folder`)
    }
    return hit.file.text()
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
    mirrorProfilesJson,
    refreshPermissionState: async () => folders()
  }
}

export type FallbackFsApi = ReturnType<typeof createFallbackFs>
