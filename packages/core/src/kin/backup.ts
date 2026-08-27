/**
 * Robot profile creation from YRC1000 controller backup files.
 * Ported from `kinematics/robot_profile.py`.
 *
 * v1 supports the 6-axis Motoman S-L-U-R-B-T layout with RC.PRM-derived link
 * lengths. Different DH families may need a separate layout later.
 *
 * Filesystem work stays in the shell: `scanBackup` takes a directory listing
 * and `createProfileFromBackup` takes the four file texts, so the same code
 * serves Tauri paths and browser directory handles.
 */

import { joinPath } from "../fs/paths"
import { parseRcPrm, parseToolCnd, parseUframeCnd } from "./cnd"
import {
  DEFAULT_TOOL0,
  HOME_PULSES,
  RC_PRM_DEGREE_RANGES_POS,
  defaultParams,
  type Ar2010Params,
  type SixTuple
} from "./fk"
import { poseFromXyzRpy } from "./pose"
import type { BackupFileStatus, RobotProfile, ScanBackupResult } from "./types"

export const REQUIRED_FILES = ["SYSTEM.SYS", "RC.PRM", "TOOL.CND", "UFRAME.CND"] as const
export const RECOMMENDED_FILES = [
  "RE.PRM",
  "SV.PRM",
  "ARCSRT.CND",
  "ARCEND.CND",
  "WEAV.CND"
] as const

/**
 * Browser File System Access APIs sometimes hide or reject `.SYS` (and a few
 * other “dangerous” suffixes). Accept common renames so a linked backup still
 * scans when the user copies `SYSTEM.SYS` → `SYSTEM.SYS.TXT`.
 */
export const CONTROLLER_FILE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "SYSTEM.SYS": ["SYSTEM.SYS.TXT", "SYSTEM.TXT", "SYSTEM_SYS.TXT"]
}

export const PROFILE_STATUS_TEMPLATE = "template_validated"
export const PROFILE_STATUS_UNVALIDATED = "unvalidated"
export const PROFILE_STATUS_CALIBRATED = "calibrated"

export const DH_LAYOUT_MOTOMAN_6 = "motoman_slurbt_6"

/** Motoman 6-axis default motion ranges used as pulse/deg seeds when unknown. */
export const DEFAULT_DEGREE_RANGES_POS = RC_PRM_DEGREE_RANGES_POS

export interface SystemIdentity {
  rawRobotLine: string
  robotModel: string
  robotTypeCode: string
  displayName: string
  group: string
  application: string
  systemNo: string
  controller: string
  groups: string[]
}

export interface BackupSources {
  systemSys: string
  rcPrm: string
  toolCnd: string
  uframeCnd: string
}

export interface CreateProfileOptions {
  /** Absolute folder the backup was read from; stored on the profile. */
  folder: string
  displayName?: string
  profileId?: string
  /** Per-file digests, computed by the shell (core has no hashing primitive). */
  sourceFiles?: Record<string, { path: string; sha256: string }>
  /** ISO timestamp for createdAt/updatedAt; defaults to now. */
  now?: string
  /** Id factory, defaults to `crypto.randomUUID`. */
  newId?: () => string
}

const afterColon = (line: string): string => {
  const index = line.indexOf(":")
  return (index >= 0 ? line.slice(index + 1) : line).trim()
}

export const utcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

const sanitizeId = (text: string): string => {
  const cleaned = text.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned.slice(0, 48) || "robot"
}

export const parseSystemSys = (text: string): SystemIdentity => {
  let application = ""
  let systemNo = ""
  let robotLine = ""
  const groups: string[] = []
  let inRobot = false

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\s+$/, "")
    if (line.startsWith("//APPLI")) {
      application = afterColon(line)
    } else if (line.startsWith("//SYSTEM NO")) {
      systemNo = afterColon(line)
    } else if (line.startsWith("//ROBOT NAME")) {
      inRobot = true
    } else if (inRobot) {
      if (line.startsWith("//")) {
        inRobot = false
        continue
      }
      const stripped = line.trim()
      if (!stripped) {
        continue
      }
      groups.push(stripped)
      if (stripped.startsWith("R1") && !robotLine) {
        robotLine = stripped
      }
    }
  }

  let group = "R1"
  let typeCode = ""
  let model = ""
  const match = robotLine.match(/^(R\d+)\s*:\s*([^\s*(]+)\s*(?:\(([^)]+)\))?/)
  if (match) {
    group = match[1]
    typeCode = match[2].trim()
    model = (match[3] ?? "").trim()
  }
  if (!model) {
    // Fallback: last token in parentheses anywhere on the line
    const paren = robotLine.match(/\(([^)]+)\)/)
    model = paren ? paren[1].trim() : typeCode || "UNKNOWN"
  }

  return {
    rawRobotLine: robotLine,
    robotModel: model,
    robotTypeCode: typeCode,
    displayName: model || typeCode || "Yaskawa robot",
    group,
    application,
    systemNo,
    controller: "YRC1000",
    groups
  }
}

const baseName = (path: string): string => {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] ?? ""
}

const depthOf = (path: string): number => {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
  return Math.max(0, parts.length - 1)
}

const candidateNames = (name: string): string[] => {
  const aliases = CONTROLLER_FILE_ALIASES[name] ?? []
  return [name, ...aliases]
}

/**
 * Locate a controller file in a backup listing of paths relative to the root.
 * Case-insensitive, any depth; prefers shallower paths (root, then CF/USB,
 * then deeper nests). Also accepts `CONTROLLER_FILE_ALIASES` renames.
 */
export const findEntry = (
  entries: readonly string[],
  name: string
): string | null => {
  const wanted = new Set(candidateNames(name).map((item) => item.toLowerCase()))
  let best: string | null = null
  let bestDepth = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const leaf = baseName(entry)
    if (!leaf || !wanted.has(leaf.toLowerCase())) {
      continue
    }
    const depth = depthOf(entry)
    if (depth < bestDepth) {
      best = entry
      bestDepth = depth
      if (depth === 0) {
        return best
      }
    }
  }
  return best
}

/**
 * Report which controller files a backup folder holds.
 * `entries` are file paths relative to `folder`, at any depth.
 */
export const scanBackup = (folder: string, entries: readonly string[]): ScanBackupResult => {
  const status = (name: string, required: boolean): BackupFileStatus => {
    const found = findEntry(entries, name)
    return {
      name,
      required,
      found: found !== null,
      path: found === null ? null : joinPath(folder, found)
    }
  }

  const required = REQUIRED_FILES.map((name) => status(name, true))
  const recommended: BackupFileStatus[] = RECOMMENDED_FILES.map((name) => status(name, false))

  const jbi = new Set<string>()
  for (const entry of entries) {
    if (entry.toLowerCase().endsWith(".jbi")) {
      jbi.add(entry.replace(/\\/g, "/").toLowerCase())
    }
  }
  recommended.push({
    name: "*.JBI (sample jobs)",
    required: false,
    found: jbi.size > 0,
    path: null,
    count: jbi.size
  })

  const missingRequired = required.filter((item) => !item.found).map((item) => item.name)
  return {
    folder,
    required,
    recommended,
    missingRequired,
    ready: missingRequired.length === 0
  }
}

const seedPulsePerDegree = (limitsPos: readonly number[]): number[] => {
  const seeds: number[] = []
  for (let index = 0; index < 6; index += 1) {
    const limit = index < limitsPos.length ? Math.abs(limitsPos[index]) : 1
    const range = Math.abs(DEFAULT_DEGREE_RANGES_POS[index] ?? 180) || 180
    seeds.push(limit / range)
  }
  return seeds
}

/** Rough horizontal reach heuristic for gate messaging. */
const reachFromLinks = (links: Record<string, number>): number =>
  (links.a1 ?? 0) + (links.a2 ?? 0) + (links.d4 ?? 0) + (links.d6 ?? 0)

export const createProfileFromBackup = (
  sources: BackupSources,
  options: CreateProfileOptions
): RobotProfile => {
  const identity = parseSystemSys(sources.systemSys)
  const geometry = parseRcPrm(sources.rcPrm)
  const tools = parseToolCnd(sources.toolCnd)
  const frames = parseUframeCnd(sources.uframeCnd)

  const links = { ...geometry.linkLengthsMm }
  for (const key of ["a1", "a2", "a3", "d4", "d6"]) {
    if (!(key in links)) {
      throw new Error(`RC.PRM did not yield link length ${key}`)
    }
  }

  const tool0 = tools.find((tool) => tool.id === 0)
  const isAr2010 =
    identity.robotModel.toUpperCase().includes("AR2010") || geometry.hypothesisHolds
  const status = isAr2010 ? PROFILE_STATUS_TEMPLATE : PROFILE_STATUS_UNVALIDATED
  const now = options.now ?? utcNow()
  const notes = [...geometry.notes]
  notes.push(
    status === PROFILE_STATUS_UNVALIDATED
      ? "Unvalidated robot: pulse scales are RC.PRM soft-limit seeds. " +
          "Cell calibration is required before trusting geometry transforms."
      : "AR2010 template: geometry matches validated DYNAMIC1 / URDF lengths. " +
          "Still calibrate pulse scales/offsets per cell."
  )

  return {
    id: options.profileId ?? (options.newId ?? (() => crypto.randomUUID()))(),
    robotId: sanitizeId(identity.robotModel || identity.robotTypeCode || "robot"),
    displayName: options.displayName || identity.displayName,
    controller: identity.controller,
    robotModel: identity.robotModel,
    robotTypeCode: identity.robotTypeCode,
    rawSystemLine: identity.rawRobotLine,
    application: identity.application,
    status,
    linkLengthsMm: links,
    pulsePerDeg: seedPulsePerDegree(geometry.pulseLimitsPos),
    pulseOffsets: [0, 0, 0, 0, 0, 0],
    pulseLimitsPos: [...geometry.pulseLimitsPos],
    pulseLimitsNeg: [...geometry.pulseLimitsNeg],
    homePulses: isAr2010 ? [...HOME_PULSES] : [0, 0, 0, 0, 0, 0],
    tool0: tool0 ? tool0.tcp : poseFromXyzRpy(DEFAULT_TOOL0),
    framesSummary: frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      toolId: frame.toolId
    })),
    toolsSummary: tools
      .filter((tool) => tool.id <= 3)
      .map((tool) => ({ id: tool.id, name: tool.name, tcp: tool.tcp })),
    sourceFolder: options.folder,
    sourceFiles: options.sourceFiles ?? {},
    dhLayout: DH_LAYOUT_MOTOMAN_6,
    createdAt: now,
    updatedAt: now,
    calibrationId: null,
    notes,
    stationFlipRecipes: []
  }
}

/** Kinematic parameters for a stored profile, falling back to AR2010 defaults. */
export const profileToParams = (profile: RobotProfile): Ar2010Params => {
  const links = profile.linkLengthsMm ?? {}
  const fallback = defaultParams()
  const ppd = [...(profile.pulsePerDeg ?? [])]
  const offsets = [...(profile.pulseOffsets ?? [])]
  while (ppd.length < 6) {
    ppd.push(fallback.pulsePerDegree[ppd.length])
  }
  while (offsets.length < 6) {
    offsets.push(0)
  }
  return {
    a1: links.a1 ?? 150,
    a2: links.a2 ?? 760,
    a3: links.a3 ?? 200,
    d4: links.d4 ?? 1082,
    d6: links.d6 ?? 100,
    d1: links.d1 ?? 0,
    pulsePerDegree: ppd.slice(0, 6) as SixTuple,
    pulseOffsets: offsets.slice(0, 6) as SixTuple,
    reachMm: reachFromLinks(links) || 2010
  }
}
