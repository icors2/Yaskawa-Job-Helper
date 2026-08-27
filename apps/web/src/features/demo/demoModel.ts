/**
 * Build station-flip demo geometry from profile/job text or bundled fixtures.
 */

import { parseJob } from "@yaskawa/core/jbi/parse"
import { profileToParams } from "@yaskawa/core/kin/backup"
import { parseUframeCnd } from "@yaskawa/core/kin/cnd"
import { defaultParams, defaultTool } from "@yaskawa/core/kin/fk"
import { composePoses, poseToMatrix, relativePose } from "@yaskawa/core/kin/pose"
import {
  applyFlip,
  applyFlipWithIk,
  flipRecipeFromDict,
  pulsesInUserFrameList,
  recipeFromLx,
  type FlipRecipe
} from "@yaskawa/core/kin/stationFlip"
import type { CartesianPose, RobotProfile, UserFrame } from "@yaskawa/core/kin/types"
import {
  DEMO_DEFAULT_LX,
  DEMO_DEFAULT_LY,
  DEMO_DEFAULT_LZ,
  DEMO_FIXTURE_LABEL,
  DEMO_SOURCE_FRAME_ID,
  DEMO_TARGET_FRAME_ID
} from "./fixtures/meta"
import demoJobText from "./fixtures/DEMO_S1_SHORT.JBI?raw"
import demoUframeText from "./fixtures/UFRAME_S1S2.CND?raw"

export type DemoLayoutMode = "overlay" | "sideBySide"

export interface DemoPoint {
  index: number
  /** Position in the active visualization frame (mm). */
  position: [number, number, number]
  /** Rotation matrix columns as triad axes (unit length). */
  axes: {
    x: [number, number, number]
    y: [number, number, number]
    z: [number, number, number]
  }
  reachable: boolean
  withinLimits: boolean
  failed: boolean
  message: string
}

export interface DemoModel {
  sourceLabel: string
  usingBundledFixtures: boolean
  recipe: FlipRecipe
  lx: number
  sourceFrame: UserFrame
  targetFrame: UserFrame
  sourcePoints: DemoPoint[]
  flippedPoints: DemoPoint[]
  reachableCount: number
  failedCount: number
  pointCount: number
}

const TRIAD_LEN = 80

const parsePulseRow = (raw: string): number[] => {
  const rhs = raw.includes("=") ? raw.split("=")[1] : raw
  return rhs.split(",").map((part) => Number.parseFloat(part.trim())).slice(0, 6)
}

const parseCartesianRow = (raw: string): CartesianPose => {
  const rhs = raw.includes("=") ? raw.split("=")[1] : raw
  const parts = rhs.split(",").map((part) => Number.parseFloat(part.trim()))
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Bad cartesian row: ${raw}`)
  }
  return { x: parts[0], y: parts[1], z: parts[2], rx: parts[3], ry: parts[4], rz: parts[5] }
}

const extractJobMotion = (
  jobText: string
): { pulses: number[][]; cartesians: CartesianPose[]; postype: string } => {
  const job = parseJob(jobText)
  const pulses: number[][] = []
  const cartesians: CartesianPose[] = []
  let postype = "PULSE"
  for (const group of job.posGroups) {
    postype = String(group.postype ?? "PULSE").toUpperCase()
    for (const variable of group.vars) {
      const raw = variable.raw ?? ""
      if (!raw.includes("=")) {
        continue
      }
      if (postype === "PULSE") {
        const row = parsePulseRow(raw)
        if (row.length >= 6 && row.every((n) => Number.isFinite(n))) {
          pulses.push(row)
        }
      } else if (postype === "USER" || postype === "BASE") {
        cartesians.push(parseCartesianRow(raw))
      }
    }
  }
  return { pulses, cartesians, postype }
}

const triadFromPose = (pose: CartesianPose) => {
  const matrix = poseToMatrix(pose)
  const scale = (col: number): [number, number, number] => [
    matrix[0][col] * TRIAD_LEN,
    matrix[1][col] * TRIAD_LEN,
    matrix[2][col] * TRIAD_LEN
  ]
  return {
    position: [pose.x, pose.y, pose.z] as [number, number, number],
    axes: { x: scale(0), y: scale(1), z: scale(2) }
  }
}

const resolveRecipe = (profile: RobotProfile | null): FlipRecipe => {
  const stored = profile?.stationFlipRecipes?.[0]
  if (stored) {
    return flipRecipeFromDict(stored)
  }
  return recipeFromLx(DEMO_DEFAULT_LX, DEMO_DEFAULT_LY, DEMO_DEFAULT_LZ, {
    sourceFrameId: DEMO_SOURCE_FRAME_ID,
    targetFrameId: DEMO_TARGET_FRAME_ID
  })
}

const pickFrame = (frames: UserFrame[], id: number, label: string): UserFrame => {
  const found = frames.find((frame) => frame.id === id)
  if (!found?.buser) {
    throw new Error(`Missing ${label} (UF${id}) BUSER in UFRAME data`)
  }
  return found
}

export const buildDemoModel = (args: {
  uframeText: string
  jobText: string
  jobLabel: string
  profile: RobotProfile | null
  usingBundledFixtures: boolean
  layout: DemoLayoutMode
}): DemoModel => {
  const frames = parseUframeCnd(args.uframeText)
  const sourceFrame = pickFrame(frames, DEMO_SOURCE_FRAME_ID, "S1")
  const targetFrame = pickFrame(frames, DEMO_TARGET_FRAME_ID, "S2")
  const recipe = resolveRecipe(args.profile)
  const lx = recipe.offset[0]
  const params = args.profile ? profileToParams(args.profile) : defaultParams()
  const tool = args.profile?.tool0 ?? defaultTool()
  const motion = extractJobMotion(args.jobText)

  let sourceUfPoses: CartesianPose[]
  let sourcePulses: number[][] | undefined

  if (motion.pulses.length > 0) {
    sourcePulses = motion.pulses
    sourceUfPoses = pulsesInUserFrameList(motion.pulses, sourceFrame.buser, tool, params)
  } else if (motion.cartesians.length > 0) {
    sourceUfPoses =
      motion.postype === "BASE"
        ? motion.cartesians.map((pose) => relativePose(pose, sourceFrame.buser))
        : [...motion.cartesians]
  } else {
    throw new Error("Job has no usable PULSE or USER/BASE poses for the demo")
  }

  const ikResults = applyFlipWithIk({
    sourcePulses,
    sourcePoses: sourceUfPoses,
    recipe,
    ufSource: sourceFrame.buser,
    ufTarget: targetFrame.buser,
    tool,
    params,
    pulseLimitsPos: args.profile?.pulseLimitsPos,
    pulseLimitsNeg: args.profile?.pulseLimitsNeg
  })

  const toVizPose = (ufPose: CartesianPose, station: "source" | "flipped"): CartesianPose => {
    if (args.layout === "sideBySide") {
      // Keep UF-local axes, but separate S1/S2 decks along local Y so both paths read clearly.
      const deckY = station === "source" ? -420 : 420
      return { ...ufPose, y: ufPose.y + deckY }
    }
    const frame = station === "source" ? sourceFrame.buser : targetFrame.buser
    return composePoses(frame, ufPose)
  }

  const sourcePoints: DemoPoint[] = sourceUfPoses.map((ufPose, index) => {
    const viz = toVizPose(ufPose, "source")
    const triad = triadFromPose(viz)
    return {
      index,
      position: triad.position,
      axes: triad.axes,
      reachable: true,
      withinLimits: true,
      failed: false,
      message: "source"
    }
  })

  const flippedPoints: DemoPoint[] = ikResults.map((result) => {
    const viz = toVizPose(result.pose, "flipped")
    const triad = triadFromPose(viz)
    const failed = !result.ik.reachable || !result.ik.withinLimits
    return {
      index: result.index,
      position: triad.position,
      axes: triad.axes,
      reachable: result.ik.reachable,
      withinLimits: result.ik.withinLimits,
      failed,
      message: result.ik.message || (failed ? "IK / joint limit fail" : "ok")
    }
  })

  const failedCount = flippedPoints.filter((point) => point.failed).length

  return {
    sourceLabel: args.jobLabel,
    usingBundledFixtures: args.usingBundledFixtures,
    recipe,
    lx,
    sourceFrame,
    targetFrame,
    sourcePoints,
    flippedPoints,
    reachableCount: flippedPoints.length - failedCount,
    failedCount,
    pointCount: flippedPoints.length
  }
}

export const loadBundledDemoInputs = () => ({
  uframeText: demoUframeText,
  jobText: demoJobText,
  jobLabel: DEMO_FIXTURE_LABEL,
  usingBundledFixtures: true as const
})

export const previewFlippedUfPose = (pose: CartesianPose, recipe: FlipRecipe): CartesianPose =>
  applyFlip(pose, recipe)

/** Sample triad indices: current scrub step plus evenly spaced markers. */
export const sampleTriadIndices = (count: number, current: number, maxMarkers = 5): number[] => {
  if (count <= 0) {
    return []
  }
  const set = new Set<number>([Math.min(Math.max(current, 0), count - 1)])
  const step = Math.max(1, Math.floor((count - 1) / Math.max(1, maxMarkers - 1)))
  for (let index = 0; index < count; index += step) {
    set.add(index)
  }
  set.add(count - 1)
  return [...set].sort((a, b) => a - b)
}
