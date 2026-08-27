import { useEffect, useMemo, useState, type SyntheticEvent } from "react"
import { getCalibrationGate, getEditWriteGate } from "../calibration"
import {
  previewFrameMove,
  previewFrameFlipJob,
  previewMirrorJob,
  previewOffsetJob,
  previewStationFlipJob,
  fitStationFlipFromPair,
  paramsFromProfileFields,
  type StationFlipPreview,
  type StationSide
} from "../../lib/jbi/frameTransform"
import { readTextFile, writeOutputFile, type JbiEntry } from "../../lib/fs/desktop"
import {
  readUframe,
  type CartesianPose,
  type FitStationFlipResult,
  type MirrorPlane,
  type StationFlipRecipe,
  type ToolAxisPreference,
  type UserFrame
} from "../../lib/kin/client"
import {
  getActiveProfile,
  getRobotInstallGate,
  jobFamilyKey,
  loadProfilesStore,
  upsertStationFlipRecipe
} from "../../lib/robot/profile"
import {
  DEFAULT_PULSE_MIRROR_SIGNS,
  loadPulseMirrorPrefs,
  PULSE_AXIS_ORDER,
  savePulseMirrorPrefs,
  type PulseMirrorAxisSigns,
  type PulseMirrorPrefs
} from "@yaskawa/core/robot/pulseMirrorPrefs"
import { TOOL_AXIS_PREFERENCES } from "@yaskawa/core/kin/stationFlip"
import { FlipAssistDemo } from "./FlipAssistDemo"

/**
 * Offline frame-move / transfer = FK into source UF → emit ///USER <target> with the same
 * relative XYZRxRyRz. CNVRT / SFTON / MFRAME are on-controller alternatives,
 * not this rewrite path (docs/MOTOMAN_DEVELOPER_FINDINGS.md).
 *
 * Single-side mirror keeps the same ///USER and reflects in that frame.
 * Prefer cartesian USER/BASE (or PULSE→FK→USER). Pulse-axis flips are advanced/approximate.
 *
 * Frame convert (Flip) remaps cartesian poses between two BUSER frames via
 * P_new = inv(UF_new) @ UF_old @ P_old (+ optional tool Z 180°).
 *
 * Station flip (mirror) learns Lx + tool correction from a known-good S1/S2
 * pair, reflects in station UF (x′ = Lx − x), IK-checks reach, and writes
 * per-point ///RCONF. Unreachable points block save.
 *
 * After Preview, Write to output folder uses writeOutputFile (output tree only; never source).
 */

type TransformMode =
  | "mirror"
  | "transfer"
  | "offset"
  | "singleSide"
  | "frameFlip"
  | "stationFlip"

const ZERO_POSE: CartesianPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }

const TOOL_AXIS_LABELS: Record<ToolAxisPreference, string> = {
  auto: "Auto (best RMS)",
  X: "Tool X",
  Y: "Tool Y",
  XY: "Tool X+Y",
  Z: "Tool Z"
}

const formatUfPoseText = (pose: CartesianPose): string =>
  `${pose.x},${pose.y},${pose.z},${pose.rx},${pose.ry},${pose.rz}`

const parseUfPoseText = (text: string): CartesianPose | null => {
  const parts = text.split(",").map((p) => Number.parseFloat(p.trim()))
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) {
    return null
  }
  return {
    x: parts[0],
    y: parts[1],
    z: parts[2],
    rx: parts[3],
    ry: parts[4],
    rz: parts[5]
  }
}

const poseFromBuser = (buser: CartesianPose | undefined): CartesianPose =>
  buser ? { ...buser } : { ...ZERO_POSE }

interface TransformPageProps {
  jobs?: JbiEntry[]
  activeJobPath?: string | null
  onActiveJobChange?: (path: string | null) => void
  onOpenSetup?: () => void
  onOpenLibrary?: () => void
  onOpenDiff?: () => void
  outputFolder?: string | null
}

const jobBaseName = (path: string): string => {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}

const jobStem = (pathOrName: string): string =>
  jobBaseName(pathOrName).replace(/\.jbi$/i, "")

const ensureJbiExtension = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) {
    return trimmed
  }
  return trimmed.toLowerCase().endsWith(".jbi") ? trimmed : `${trimmed}.JBI`
}

const deriveOutName = (args: {
  mode: TransformMode
  sourceLabel: string
  targetFrameId: number
  mirrorPlane: MirrorPlane
  singleSidePlane: MirrorPlane
  stationSide: StationSide
}): string => {
  const stem = jobStem(args.sourceLabel) || "TRANSFORM"
  if (args.mode === "transfer") {
    return `${stem}_UF${args.targetFrameId}.JBI`
  }
  if (args.mode === "frameFlip") {
    return `${stem}_FLIP_UF${args.targetFrameId}.JBI`
  }
  if (args.mode === "stationFlip") {
    return `${stem}_STFLIP_UF${args.targetFrameId}.JBI`
  }
  if (args.mode === "mirror") {
    return `${stem}_M${args.mirrorPlane}.JBI`
  }
  if (args.mode === "singleSide") {
    const side = args.stationSide === "left" ? "L" : "R"
    return `${stem}_SSM_${side}.JBI`
  }
  return `${stem}_OFF.JBI`
}

export const TransformPage = ({
  jobs = [],
  activeJobPath = null,
  onActiveJobChange,
  onOpenSetup,
  onOpenLibrary,
  onOpenDiff,
  outputFolder = null
}: TransformPageProps) => {
  const [mode, setMode] = useState<TransformMode>("transfer")
  const [jobPath, setJobPath] = useState(activeJobPath ?? "")
  const [jobFilter, setJobFilter] = useState("")
  const [sourceFrameId, setSourceFrameId] = useState(2)
  const [targetFrameId, setTargetFrameId] = useState(3)
  const [mirrorPlane, setMirrorPlane] = useState<MirrorPlane>("XZ")
  const [singleSidePlane, setSingleSidePlane] = useState<MirrorPlane>("YZ")
  const [stationSide, setStationSide] = useState<StationSide>("left")
  const [offsetText, setOffsetText] = useState("0,0,0,0,0,0")
  const [applyToolZFlip, setApplyToolZFlip] = useState(true)
  const [sourceUfText, setSourceUfText] = useState(formatUfPoseText(ZERO_POSE))
  const [targetUfText, setTargetUfText] = useState(formatUfPoseText(ZERO_POSE))
  const [loadedFrames, setLoadedFrames] = useState<UserFrame[]>([])
  const [ufLoadNote, setUfLoadNote] = useState<string | null>(null)
  const [preview, setPreview] = useState("")
  const [diffText, setDiffText] = useState("")
  const [outName, setOutName] = useState("")
  const [status, setStatus] = useState(
    "Pick a Loaded Job (or inherit the Wizard selection), choose an operation, then preview."
  )
  const [rconfReview, setRconfReview] = useState(false)
  const [usePulseAxisFlips, setUsePulseAxisFlips] = useState(false)
  const [pulsePrefs, setPulsePrefs] = useState<PulseMirrorPrefs>(() => {
    const profile = getActiveProfile()
    return loadPulseMirrorPrefs(profile?.id ?? null)
  })
  const [jobPickerOpen, setJobPickerOpen] = useState(() => {
    try {
      return window.localStorage.getItem("yaskawa.transform.jobPickerOpen") === "true"
    } catch {
      return false
    }
  })
  const [stationRecipeId, setStationRecipeId] = useState("")
  const [stationRecipeName, setStationRecipeName] = useState("")
  const [toolAxisPreference, setToolAxisPreference] = useState<ToolAxisPreference>("auto")
  const [fitSourcePath, setFitSourcePath] = useState("")
  const [fitTargetPath, setFitTargetPath] = useState("")
  const [fitResult, setFitResult] = useState<FitStationFlipResult | null>(null)
  const [reachReport, setReachReport] = useState<StationFlipPreview["reachReport"]>([])
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [familyWarning, setFamilyWarning] = useState<string | null>(null)

  const installGate = getRobotInstallGate()
  const writeGate = getEditWriteGate()
  const activeProfile = getActiveProfile()
  const stationRecipes = activeProfile?.stationFlipRecipes ?? []
  const selectedRecipe =
    stationRecipes.find((recipe) => recipe.id === stationRecipeId) ?? null
  const canSave = Boolean(preview.trim()) && writeGate.allowed && !saveBlocked

  const handleJobPickerToggle = (
    event: SyntheticEvent<HTMLDetailsElement>
  ) => {
    const nextOpen = event.currentTarget.open
    setJobPickerOpen(nextOpen)
    try {
      window.localStorage.setItem(
        "yaskawa.transform.jobPickerOpen",
        nextOpen ? "true" : "false"
      )
    } catch {
      // ignore quota / private-mode failures
    }
  }

  useEffect(() => {
    if (!activeJobPath) {
      return
    }
    setJobPath(activeJobPath)
  }, [activeJobPath])

  useEffect(() => {
    setPulsePrefs(loadPulseMirrorPrefs(activeProfile?.id ?? null))
  }, [activeProfile?.id])

  useEffect(() => {
    const uframePath = activeProfile?.sourceFiles?.["UFRAME.CND"]?.path
    if (!uframePath) {
      setLoadedFrames([])
      setUfLoadNote(
        "No UFRAME.CND on the active profile — enter BUSER X,Y,Z,Rx,Ry,Rz manually or finish Setup."
      )
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const result = await readUframe(uframePath)
        if (cancelled) {
          return
        }
        setLoadedFrames(result.frames)
        setUfLoadNote(`Loaded ${result.frames.length} user frame(s) from profile UFRAME.CND.`)
      } catch (error) {
        if (cancelled) {
          return
        }
        setLoadedFrames([])
        setUfLoadNote(
          error instanceof Error
            ? `Could not read UFRAME.CND: ${error.message}`
            : String(error)
        )
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [activeProfile?.id, activeProfile?.sourceFiles])

  useEffect(() => {
    if (mode !== "frameFlip") {
      return
    }
    const source = loadedFrames.find((f) => f.id === sourceFrameId)
    const target = loadedFrames.find((f) => f.id === targetFrameId)
    if (source?.buser) {
      setSourceUfText(formatUfPoseText(poseFromBuser(source.buser)))
    }
    if (target?.buser) {
      setTargetUfText(formatUfPoseText(poseFromBuser(target.buser)))
    }
  }, [mode, sourceFrameId, targetFrameId, loadedFrames])

  const filteredJobs = useMemo(() => {
    const q = jobFilter.trim().toLowerCase()
    if (!q) {
      return jobs
    }
    return jobs.filter(
      (job) =>
        job.name.toLowerCase().includes(q) ||
        job.relativePath.toLowerCase().includes(q) ||
        job.path.toLowerCase().includes(q)
    )
  }, [jobs, jobFilter])

  const activeJob = jobs.find((job) => job.path === jobPath) ?? null
  const displayName = activeJob?.name ?? (jobPath ? jobBaseName(jobPath) : null)

  const demoPlane = mode === "singleSide" ? singleSidePlane : mode === "stationFlip" ? "YZ" : mirrorPlane

  const clearPreview = () => {
    setPreview("")
    setDiffText("")
    setOutName("")
    setRconfReview(false)
    setReachReport([])
    setSaveBlocked(false)
    setFamilyWarning(null)
  }

  const suggestedOutName = (label?: string): string =>
    deriveOutName({
      mode,
      sourceLabel: label ?? displayName ?? jobPath,
      targetFrameId,
      mirrorPlane,
      singleSidePlane,
      stationSide
    })

  const suggestS2Mate = (sourcePath: string): string => {
    const stem = jobStem(sourcePath)
    const mateStem = stem
      .replace(/([_-])S1(?=([_-]|$))/i, "$1S2")
      .replace(/S1$/i, "S2")
    if (mateStem === stem) {
      return ""
    }
    const mate = jobs.find((job) => jobStem(job.path).toUpperCase() === mateStem.toUpperCase())
    return mate?.path ?? ""
  }

  const handleSelectJob = (path: string) => {
    setJobPath(path)
    onActiveJobChange?.(path)
    clearPreview()
    setStatus(`Transforming: ${jobBaseName(path)}`)
    if (!fitSourcePath) {
      setFitSourcePath(path)
    }
    const mate = suggestS2Mate(path)
    if (mate && !fitTargetPath) {
      setFitTargetPath(mate)
    }
  }

  const ensureGate = (): boolean => {
    if (!installGate.allowed) {
      setStatus(installGate.reason)
      return false
    }
    const gate = getCalibrationGate()
    if (!gate.allowed) {
      setStatus(gate.reason)
      return false
    }
    return true
  }

  const ensureJobPath = (): boolean => {
    if (!jobPath.trim()) {
      setStatus("Select a job from Loaded Jobs first (or open Library and pick one).")
      return false
    }
    return true
  }

  const handleSelectMode = (next: TransformMode) => {
    setMode(next)
    clearPreview()
    setUsePulseAxisFlips(false)
    if (next === "mirror") {
      setStatus("Mirror mode — reflection across the chosen plane; review RCONF on the pendant.")
      return
    }
    if (next === "transfer") {
      setStatus(
        "Transfer mode — identical fixtures on both sides; geometry relative to the fixture stays the same, only ///USER changes."
      )
      return
    }
    if (next === "singleSide") {
      setStatus(
        "Single-side mirror — same station / same ///USER. Prefer cartesian USER poses; PULSE uses FK→USER then mirror."
      )
      return
    }
    if (next === "frameFlip") {
      setStatus(
        "Frame convert (Flip) — remap cartesian poses from current UF BUSER → target UF BUSER (homogeneous). Tool Z 180° on by default."
      )
      return
    }
    if (next === "stationFlip") {
      setStatus(
        "Station flip (mirror) — fit Lx from a known-good S1/S2 pair, then apply. Save is blocked if any point fails IK or joint limits."
      )
      return
    }
    setStatus("Offset mode — apply a cartesian delta sample (preview).")
  }

  const applyPreviewResult = (after: string, nextDiff: string, nextOutName: string) => {
    setPreview(after)
    setDiffText(nextDiff)
    setOutName(nextOutName)
  }

  const handlePulsePrefsChange = (next: PulseMirrorPrefs) => {
    setPulsePrefs(next)
    if (activeProfile?.id) {
      savePulseMirrorPrefs(activeProfile.id, next)
    }
  }

  const handleAxisSignToggle = (axisIndex: number) => {
    const signs = [...pulsePrefs.signs] as PulseMirrorAxisSigns
    signs[axisIndex] = signs[axisIndex] < 0 ? 1 : -1
    handlePulsePrefsChange({ ...pulsePrefs, signs })
  }

  const handleTransferPreview = async () => {
    if (!ensureGate() || !ensureJobPath()) {
      return
    }
    const sourceUf = parseUfPoseText(sourceUfText)
    if (!sourceUf) {
      setStatus("Current UF BUSER needs six numbers: X,Y,Z,Rx,Ry,Rz (required for PULSE transfer).")
      return
    }
    try {
      const original = await readTextFile(jobPath)
      const profile = getActiveProfile()
      const result = await previewFrameMove({
        originalText: original,
        sourceFrameId,
        targetFrameId,
        sourceUf,
        tool: profile?.tool0,
        params: profile ? paramsFromProfileFields(profile) : undefined,
        sourceLabel: jobPath
      })
      const nextOut = suggestedOutName()
      applyPreviewResult(result.after, result.diffText, nextOut)
      setRconfReview(false)
      setStatus(
        `Transfer preview ready: ///USER ${sourceFrameId} → ${targetFrameId} (${result.poseCount} poses). Review the diff, then Write to output folder as ${nextOut}.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleMirrorPreview = async () => {
    if (!ensureGate() || !ensureJobPath()) {
      return
    }
    const sourceUf = parseUfPoseText(sourceUfText)
    try {
      const original = await readTextFile(jobPath)
      const profile = getActiveProfile()
      const mirrored = await previewMirrorJob({
        originalText: original,
        plane: mirrorPlane,
        sourceFrameId,
        sourceUf: sourceUf ?? undefined,
        tool: profile?.tool0,
        params: profile ? paramsFromProfileFields(profile) : undefined,
        sourceLabel: jobPath
      })
      const nextOut = suggestedOutName()
      applyPreviewResult(mirrored.after, mirrored.diffText, nextOut)
      setRconfReview(mirrored.rconfReviewRequired)
      setStatus(
        `Mirror ${mirrorPlane} for ${displayName ?? jobPath}: ${mirrored.poseCount} pose(s) reflected. RCONF review required on pendant. Review the diff, then Write to output folder as ${nextOut}.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleSingleSidePreview = async () => {
    if (!ensureGate() || !ensureJobPath()) {
      return
    }
    const sourceUf = parseUfPoseText(sourceUfText)
    try {
      const original = await readTextFile(jobPath)
      const profile = getActiveProfile()
      const mirrored = await previewMirrorJob({
        originalText: original,
        plane: singleSidePlane,
        sourceFrameId,
        sourceUf: sourceUf ?? undefined,
        tool: profile?.tool0,
        params: profile ? paramsFromProfileFields(profile) : undefined,
        sourceLabel: jobPath,
        side: stationSide,
        usePulseAxisFlips: usePulseAxisFlips && pulsePrefs.advancedEnabled,
        pulseAxisSigns: pulsePrefs.signs
      })
      const nextOut = suggestedOutName()
      applyPreviewResult(mirrored.after, mirrored.diffText, nextOut)
      setRconfReview(mirrored.rconfReviewRequired)
      const sideLabel = stationSide === "left" ? "Left" : "Right"
      const pathNote = mirrored.usedPulseAxisFlips
        ? " ADVANCED pulse-axis flips used — approximate; calibrate signs for this cell before production."
        : " Same ///USER retained (cartesian preferred)."
      setStatus(
        `Single-side mirror (${sideLabel}, ${singleSidePlane}) for ${displayName ?? jobPath}: ${mirrored.poseCount} pose(s).${pathNote} RCONF review required. Review the diff, then Write to output folder as ${nextOut}.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleOffsetPreview = async () => {
    if (!ensureGate() || !ensureJobPath()) {
      return
    }
    const sourceUf = parseUfPoseText(sourceUfText)
    try {
      const original = await readTextFile(jobPath)
      const profile = getActiveProfile()
      const result = await previewOffsetJob({
        originalText: original,
        deltaText: offsetText,
        sourceFrameId,
        sourceUf: sourceUf ?? undefined,
        tool: profile?.tool0,
        params: profile ? paramsFromProfileFields(profile) : undefined,
        sourceLabel: jobPath
      })
      const nextOut = suggestedOutName()
      applyPreviewResult(result.after, result.diffText, nextOut)
      setRconfReview(false)
      setStatus(
        `Offset preview for ${displayName ?? jobPath}: ${result.poseCount} pose(s) shifted. Review the diff, then Write to output folder as ${nextOut}.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleFrameFlipPreview = async () => {
    if (!ensureGate() || !ensureJobPath()) {
      return
    }
    const sourceUf = parseUfPoseText(sourceUfText)
    const targetUf = parseUfPoseText(targetUfText)
    if (!sourceUf || !targetUf) {
      setStatus("Current and target UF BUSER need six numbers: X,Y,Z,Rx,Ry,Rz")
      return
    }
    try {
      const original = await readTextFile(jobPath)
      const result = await previewFrameFlipJob({
        originalText: original,
        sourceFrameId,
        targetFrameId,
        sourceUf,
        targetUf,
        applyToolZFlip,
        sourceLabel: jobPath
      })
      const nextOut = suggestedOutName()
      applyPreviewResult(result.after, result.diffText, nextOut)
      setRconfReview(false)
      const warnNote =
        result.warnings.length > 0 ? ` Warnings: ${result.warnings.join(" ")}` : ""
      setStatus(
        `Frame convert preview: UF${sourceFrameId} → UF${targetFrameId} (${result.poseCount} pose(s)` +
          `${applyToolZFlip ? ", tool Z 180°" : ", no tool flip"}). Review the diff, then Write as ${nextOut}.${warnNote}`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleStationFlipFit = async () => {
    if (!ensureGate()) {
      return
    }
    const sourcePath = fitSourcePath.trim() || jobPath
    const targetPath = fitTargetPath.trim()
    if (!sourcePath || !targetPath) {
      setStatus("Pick a known-good S1 job and its S2 counterpart to fit a station-flip recipe.")
      return
    }
    const sourceUf = parseUfPoseText(sourceUfText)
    const targetUf = parseUfPoseText(targetUfText)
    if (!sourceUf || !targetUf) {
      setStatus("Current and target UF BUSER need six numbers: X,Y,Z,Rx,Ry,Rz")
      return
    }
    try {
      const sourceText = await readTextFile(sourcePath)
      const targetText = await readTextFile(targetPath)
      const profile = getActiveProfile()
      const result = await fitStationFlipFromPair({
        sourceText,
        targetText,
        sourceFrameId,
        targetFrameId,
        sourceUf,
        targetUf,
        tool: profile?.tool0,
        params: profile ? paramsFromProfileFields(profile) : undefined,
        sourceJobName: jobStem(sourcePath),
        targetJobName: jobStem(targetPath),
        toolAxisPreference
      })
      setFitResult(result)
      if (result.accepted && result.recipe) {
        const family = result.recipe.jobFamily || jobFamilyKey(sourcePath)
        const lx = result.recipe.offset[0]?.toFixed(1) ?? "?"
        const autoName = `${family || "station"} Lx ${lx} mm`
        setStationRecipeName((prev) => prev.trim() || autoName)
        setStatus(result.message)
      } else {
        setStatus(result.message)
      }
    } catch (error) {
      setFitResult(null)
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleSaveStationRecipe = () => {
    if (!fitResult?.accepted || !fitResult.recipe) {
      setStatus("Fit a valid station-flip recipe before saving it to the profile.")
      return
    }
    const profile = getActiveProfile()
    if (!profile) {
      setStatus("No active robot profile — complete robot install first.")
      return
    }
    const name = stationRecipeName.trim() || `${jobFamilyKey(fitSourcePath || jobPath)} station flip`
    const stored: StationFlipRecipe = {
      ...fitResult.recipe,
      id: crypto.randomUUID(),
      name,
      fittedAt: new Date().toISOString(),
      sourceFrameId: fitResult.recipe.sourceFrameId ?? sourceFrameId,
      targetFrameId: fitResult.recipe.targetFrameId ?? targetFrameId,
      jobFamily: fitResult.recipe.jobFamily || jobFamilyKey(fitSourcePath || jobPath)
    }
    upsertStationFlipRecipe(loadProfilesStore(), profile.id, stored)
    setStationRecipeId(stored.id ?? "")
    setStatus(`Saved recipe “${name}” on profile ${profile.displayName}.`)
  }

  const handleStationFlipPreview = async () => {
    if (!ensureGate() || !ensureJobPath()) {
      return
    }
    const recipe = selectedRecipe ?? (fitResult?.accepted ? fitResult.recipe : null)
    if (!recipe) {
      setStatus("Select a saved recipe or fit one from a reference pair before preview.")
      return
    }
    const sourceUf = parseUfPoseText(sourceUfText)
    const targetUf = parseUfPoseText(targetUfText)
    if (!sourceUf || !targetUf) {
      setStatus("Current and target UF BUSER need six numbers: X,Y,Z,Rx,Ry,Rz")
      return
    }
    try {
      const original = await readTextFile(jobPath)
      const profile = getActiveProfile()
      const result = await previewStationFlipJob({
        originalText: original,
        recipe,
        sourceFrameId,
        targetFrameId,
        sourceUf,
        targetUf,
        tool: profile?.tool0,
        params: profile ? paramsFromProfileFields(profile) : undefined,
        pulseLimitsPos: profile?.pulseLimitsPos,
        pulseLimitsNeg: profile?.pulseLimitsNeg,
        sourceLabel: jobPath,
        toolAxisPreference
      })
      const nextOut = suggestedOutName()
      applyPreviewResult(result.after, result.diffText, nextOut)
      setReachReport(result.reachReport)
      setSaveBlocked(result.saveBlocked)
      setFamilyWarning(result.familyWarning)
      setRconfReview(false)
      const failNote = result.saveBlocked
        ? ` ${result.failedCount} point(s) failed IK or joint limits — save is blocked.`
        : ` All ${result.reachableCount} point(s) reachable.`
      const familyNote = result.familyWarning ? ` ${result.familyWarning}` : ""
      setStatus(
        `Station flip preview: UF${sourceFrameId} → UF${targetFrameId}, ${result.poseCount} pose(s).${failNote}${familyNote} Review the diff, then Write as ${nextOut}.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleSave = async () => {
    if (!preview.trim()) {
      setStatus("Run Preview first — Save stays disabled until a transform preview exists.")
      return
    }
    if (saveBlocked) {
      setStatus("Save is blocked — one or more flipped points failed IK or a joint limit. See the reach report.")
      return
    }
    if (!writeGate.allowed) {
      setStatus(writeGate.reason)
      return
    }
    if (!outputFolder) {
      setStatus("Set an output folder before writing (Setup Guide or header).")
      return
    }
    const name = ensureJbiExtension(outName.trim() || suggestedOutName())
    if (!name) {
      setStatus("Enter an output file name before writing.")
      return
    }
    try {
      const written = await writeOutputFile(name, preview)
      setOutName(name)
      setStatus(
        `Wrote ${written} (output folder only — source backup untouched).`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleUseActiveFromApp = () => {
    if (!activeJobPath) {
      setStatus("No current job from Wizard / Loaded Jobs yet — pick one below.")
      return
    }
    handleSelectJob(activeJobPath)
    setStatus(`Using current job from Wizard / app: ${jobBaseName(activeJobPath)}`)
  }

  return (
    <section className="flex h-full flex-col gap-4 overflow-auto p-6" aria-label="Job transforms">
      <header>
        <h1 className="text-lg font-semibold text-fg">Transform</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Station operations: <span className="text-fg/90">Transfer</span> (identical fixtures),{" "}
          <span className="text-fg/90">Station flip (mirror)</span> (S1↔S2 reflection fitted from a
          pair), <span className="text-fg/90">Frame convert (Flip)</span> (remap cartesian between UF
          BUSER poses), <span className="text-fg/90">Mirror</span> (mirrored fixtures),{" "}
          <span className="text-fg/90">Single-side mirror</span> (same ///USER), and{" "}
          <span className="text-fg/90">Offset</span>. Prefer cartesian USER/BASE jobs for Flip and
          mirrors. Preview, then <span className="text-fg/90">Write to output folder</span> (never
          the source backup). Uses the <span className="text-fg/80">active robot profile</span>.
        </p>
        {!installGate.allowed ? (
          <p className="mt-2 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent-fg" role="status">
            {installGate.reason}{" "}
            {onOpenSetup ? (
              <button
                type="button"
                aria-label="Complete robot install"
                onClick={onOpenSetup}
                className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                Complete robot install
              </button>
            ) : null}
          </p>
        ) : null}
      </header>

      <details
        className="rounded border border-accent/40 bg-accent/10 px-4 py-3"
        open={jobPickerOpen}
        onToggle={handleJobPickerToggle}
        aria-label="Active job for transform"
      >
        <summary className="cursor-pointer list-none text-sm font-semibold text-accent-fg focus-ring [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-2">
            <span>
              Transforming: {displayName ?? "— no job selected —"}
            </span>
            <span aria-hidden="true" className="text-accent-fg/80">
              {jobPickerOpen ? "▴" : "▾"}
            </span>
          </span>
        </summary>
        <div className="mt-2" role="status">
          <p className="break-all font-mono text-[11px] text-muted">
            {jobPath || "Pick a job below, from Loaded Jobs, or open Transform from the Wizard."}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted">
              Filter Loaded Jobs
              <input
                aria-label="Filter loaded jobs for transform"
                className="input-field font-mono text-xs"
                value={jobFilter}
                onChange={(event) => setJobFilter(event.target.value)}
                placeholder="Type to filter…"
              />
            </label>
            <label className="flex min-w-[14rem] flex-[2] flex-col gap-1 text-xs text-muted">
              Select from Loaded Jobs
              <select
                aria-label="Select job to transform"
                className="input-field font-mono text-xs"
                value={jobPath}
                onChange={(event) => handleSelectJob(event.target.value)}
              >
                <option value="">— choose a job —</option>
                {filteredJobs.map((job) => (
                  <option key={job.path} value={job.path}>
                    {job.name} ({job.relativePath})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label="Use current job from Wizard"
              onClick={handleUseActiveFromApp}
              disabled={!activeJobPath}
              className="btn-secondary self-end text-xs"
            >
              Use current job from Wizard
            </button>
            {onOpenLibrary ? (
              <button
                type="button"
                aria-label="Open Loaded Jobs library"
                onClick={onOpenLibrary}
                className="btn-ghost self-end text-xs"
              >
                Loaded Jobs
              </button>
            ) : null}
          </div>
          <label className="mt-2 flex flex-col gap-1 text-xs text-muted">
            Path (optional override)
            <input
              aria-label="Job file path override"
              className="input-field font-mono text-xs"
              value={jobPath}
              onChange={(event) => {
                setJobPath(event.target.value)
                onActiveJobChange?.(event.target.value || null)
              }}
              placeholder="Or paste a full .JBI path"
            />
          </label>
        </div>
      </details>

      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label="Transform operation"
      >
        {(
          [
            { id: "transfer" as const, label: "Transfer to new userframe" },
            { id: "stationFlip" as const, label: "Station flip (mirror)" },
            { id: "frameFlip" as const, label: "Frame convert (Flip)" },
            { id: "mirror" as const, label: "Mirror" },
            { id: "singleSide" as const, label: "Single-side mirror" },
            { id: "offset" as const, label: "Offset" }
          ] as const
        ).map((item) => {
          const active = mode === item.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={item.label}
              onClick={() => handleSelectMode(item.id)}
              className={
                active
                  ? "rounded border border-accent/60 bg-accent/15 px-3 py-1.5 text-sm text-accent-fg focus-ring"
                  : "rounded border border-border-strong px-3 py-1.5 text-sm text-muted hover:border-muted hover:text-fg focus-ring"
              }
            >
              {item.label}
            </button>
          )
        })}
      </div>

      <FlipAssistDemo
        mode={mode}
        mirrorPlane={demoPlane}
        sourceUf={sourceFrameId}
        targetUf={targetFrameId}
        stationSide={stationSide}
      />

      {mode === "transfer" ? (
        <div className="rounded border border-border bg-bg/50 p-4">
          <h2 className="text-sm font-semibold text-fg">Transfer job to new userframe</h2>
          <p className="mt-1 text-sm text-muted">
            Use when fixturing on both sides of the robot is <span className="text-fg/90">identical</span>{" "}
            (not mirrored). The weld path stays the same relative to the fixture; only the target
            userframe number changes. USER cartesian jobs relabel in place; PULSE jobs use
            PULSE→USER frame-move.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Source UF#
              <input
                type="number"
                aria-label="Source user frame"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={sourceFrameId}
                onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Target UF#
              <input
                type="number"
                aria-label="Target user frame"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={targetFrameId}
                onChange={(event) => setTargetFrameId(Number.parseInt(event.target.value, 10) || 3)}
              />
            </label>
            <button
              type="button"
              aria-label="Preview transfer to new userframe"
              onClick={() => void handleTransferPreview()}
              className="btn-primary self-end"
            >
              Preview transfer
            </button>
          </div>
        </div>
      ) : null}

      {mode === "stationFlip" ? (
        <div className="rounded border border-border bg-bg/50 p-4">
          <h2 className="text-sm font-semibold text-fg">Station flip (mirror)</h2>
          <p className="mt-1 text-sm text-muted">
            Learn the S1↔S2 reflection from a known-good pair, then apply it to the loaded job.
            In station UF coords:{" "}
            <span className="font-mono text-xs text-fg/80">x′ = Lx − x</span>, with a fitted
            tool-axis correction. Output is{" "}
            <span className="font-mono text-fg/80">///POSTYPE USER</span> on the target frame with
            per-point <span className="font-mono text-fg/80">///RCONF</span>. Unreachable or
            limit-violating points block save. A recipe is only valid for the fixture family it was
            fitted on.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Source UF#
              <input
                type="number"
                aria-label="Source user frame for station flip"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={sourceFrameId}
                onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Target UF#
              <input
                type="number"
                aria-label="Target user frame for station flip"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={targetFrameId}
                onChange={(event) => setTargetFrameId(Number.parseInt(event.target.value, 10) || 3)}
              />
            </label>
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm text-fg/80">
              Saved recipe
              <select
                aria-label="Saved station flip recipe"
                className="rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs"
                value={stationRecipeId}
                onChange={(event) => {
                  const nextId = event.target.value
                  setStationRecipeId(nextId)
                  const next = stationRecipes.find((recipe) => recipe.id === nextId)
                  if (next?.toolAxisPreference) {
                    setToolAxisPreference(next.toolAxisPreference)
                  }
                }}
              >
                <option value="">— none (fit a pair first) —</option>
                {stationRecipes.map((recipe) => (
                  <option key={recipe.id ?? recipe.name} value={recipe.id ?? ""}>
                    {recipe.name || recipe.jobFamily || "untitled"}
                    {typeof recipe.offset?.[0] === "number"
                      ? ` (Lx ${recipe.offset[0].toFixed(1)} mm)`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-[10rem] flex-col gap-1 text-sm text-fg/80">
              Tool axis correction
              <select
                aria-label="Tool axis correction preference"
                className="rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs"
                value={toolAxisPreference}
                onChange={(event) =>
                  setToolAxisPreference(event.target.value as ToolAxisPreference)
                }
              >
                {TOOL_AXIS_PREFERENCES.map((preference) => (
                  <option key={preference} value={preference}>
                    {TOOL_AXIS_LABELS[preference]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-2 text-xs text-muted">
            Dress package / cable routing may prefer a different tool axis than the lowest-RMS pick
            — re-fit after changing this.
          </p>

          <div className="mt-4 rounded border border-border-strong/70 bg-bg/40 p-3">
            <h3 className="text-sm font-semibold text-fg">Fit from reference pair</h3>
            <p className="mt-1 text-xs text-muted">
              Choose a re-taught S1 job and its S2 counterpart (same point order). Transfer-only
              copies and same-UF jobs are rejected.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted">
                S1 reference (source)
                <select
                  aria-label="Station flip S1 reference job"
                  className="input-field font-mono text-xs"
                  value={fitSourcePath}
                  onChange={(event) => {
                    const next = event.target.value
                    setFitSourcePath(next)
                    const mate = suggestS2Mate(next)
                    if (mate) {
                      setFitTargetPath(mate)
                    }
                  }}
                >
                  <option value="">— choose S1 job —</option>
                  {filteredJobs.map((job) => (
                    <option key={`s1-${job.path}`} value={job.path}>
                      {job.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted">
                S2 reference (taught counterpart)
                <select
                  aria-label="Station flip S2 reference job"
                  className="input-field font-mono text-xs"
                  value={fitTargetPath}
                  onChange={(event) => setFitTargetPath(event.target.value)}
                >
                  <option value="">— choose S2 job —</option>
                  {filteredJobs.map((job) => (
                    <option key={`s2-${job.path}`} value={job.path}>
                      {job.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                aria-label="Fit station flip from reference pair"
                onClick={() => void handleStationFlipFit()}
                className="btn-secondary self-end text-xs"
              >
                Fit from reference pair
              </button>
            </div>
            {fitResult ? (
              <div className="mt-3 text-sm" role="status">
                <p className={fitResult.accepted ? "text-fg/90" : "text-warn"}>
                  {fitResult.message}
                </p>
                {fitResult.accepted && fitResult.recipe ? (
                  <ul className="mt-1 font-mono text-xs text-muted">
                    <li>
                      Lx,Ly,Lz: {fitResult.recipe.offset.map((v) => v.toFixed(1)).join(", ")} mm
                    </li>
                    <li>
                      RMS {fitResult.positionRmsMm.toFixed(2)} mm /{" "}
                      {fitResult.orientationRmsDeg.toFixed(2)} deg · inliers {fitResult.inliers}/
                      {fitResult.total} · det(R) {fitResult.detR.toFixed(3)}
                    </li>
                    <li>
                      Tool axis: {TOOL_AXIS_LABELS[fitResult.recipe.toolAxisPreference ?? "auto"]}
                    </li>
                  </ul>
                ) : null}
                {fitResult.toolAxisOptions && fitResult.toolAxisOptions.length > 0 ? (
                  <div
                    className="mt-2 rounded border border-border-strong/60 bg-bg/30 p-2"
                    role="region"
                    aria-label="Tool axis orientation RMS"
                  >
                    <p className="mb-1 text-xs text-muted">
                      Orientation RMS by tool-axis choice (re-fit to apply a different pick):
                    </p>
                    <ul className="font-mono text-xs text-muted">
                      {fitResult.toolAxisOptions.map((option) => (
                        <li
                          key={option.preference}
                          className={
                            option.preference === toolAxisPreference ? "text-fg/90" : undefined
                          }
                        >
                          {TOOL_AXIS_LABELS[option.preference]}:{" "}
                          {option.orientationRmsDeg.toFixed(2)} deg
                          {option.preference === toolAxisPreference ? " ← selected" : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {fitResult.accepted ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted">
                      Recipe name
                      <input
                        aria-label="Station flip recipe name"
                        className="input-field font-mono text-xs"
                        value={stationRecipeName}
                        onChange={(event) => setStationRecipeName(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      aria-label="Save station flip recipe to robot profile"
                      onClick={handleSaveStationRecipe}
                      className="btn-secondary text-xs"
                    >
                      Save recipe to profile
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {selectedRecipe ? (
            <p className="mt-3 text-xs text-muted" role="status">
              Using recipe {selectedRecipe.name ?? "untitled"}
              {selectedRecipe.sourceJobName
                ? ` (fitted from ${selectedRecipe.sourceJobName} → ${selectedRecipe.targetJobName ?? "S2"})`
                : ""}
              {typeof selectedRecipe.offset?.[0] === "number"
                ? ` · Lx ${selectedRecipe.offset[0].toFixed(1)} mm`
                : ""}
              {selectedRecipe.positionRmsMm != null
                ? ` · RMS ${selectedRecipe.positionRmsMm.toFixed(2)} mm / ${selectedRecipe.orientationRmsDeg.toFixed(2)} deg`
                : ""}
            </p>
          ) : null}

          <div className="mt-3">
            <button
              type="button"
              aria-label="Preview station flip"
              onClick={() => void handleStationFlipPreview()}
              className="btn-primary"
            >
              Preview station flip
            </button>
          </div>
        </div>
      ) : null}

      {mode === "frameFlip" ? (
        <div className="rounded border border-border bg-bg/50 p-4">
          <h2 className="text-sm font-semibold text-fg">Frame convert (Flip)</h2>
          <p className="mt-1 text-sm text-muted">
            Remap a <span className="text-fg/90">cartesian USER/BASE</span> job from the current
            user frame into another using BUSER poses from{" "}
            <span className="font-mono text-fg/80">UFRAME.CND</span>:{" "}
            <span className="font-mono text-xs text-fg/80">
              P_new = inv(UF_new) @ UF_old @ P_old
            </span>
            . Distinct from Transfer (relabel only). Integer PULSE rows are not converted.
          </p>
          {ufLoadNote ? (
            <p className="mt-2 text-xs text-muted" role="status">
              {ufLoadNote}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Current UF#
              <input
                type="number"
                aria-label="Current user frame for Flip convert"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={sourceFrameId}
                onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Target UF#
              <input
                type="number"
                aria-label="Target user frame for Flip convert"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={targetFrameId}
                onChange={(event) => setTargetFrameId(Number.parseInt(event.target.value, 10) || 3)}
              />
            </label>
            {loadedFrames.length > 0 ? (
              <>
                <label className="flex flex-col gap-1 text-sm text-fg/80">
                  Current from CND
                  <select
                    aria-label="Pick current UF from UFRAME.CND"
                    className="min-w-[10rem] rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs"
                    value={sourceFrameId}
                    onChange={(event) =>
                      setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)
                    }
                  >
                    {loadedFrames.map((frame) => (
                      <option key={`src-${frame.id}`} value={frame.id}>
                        UF{frame.id} {frame.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-fg/80">
                  Target from CND
                  <select
                    aria-label="Pick target UF from UFRAME.CND"
                    className="min-w-[10rem] rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs"
                    value={targetFrameId}
                    onChange={(event) =>
                      setTargetFrameId(Number.parseInt(event.target.value, 10) || 3)
                    }
                  >
                    {loadedFrames.map((frame) => (
                      <option key={`dst-${frame.id}`} value={frame.id}>
                        UF{frame.id} {frame.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            <label className="flex items-center gap-2 self-end text-sm text-fg/80">
              <input
                type="checkbox"
                aria-label="Apply tool Z 180 degree flip"
                checked={applyToolZFlip}
                onChange={(event) => setApplyToolZFlip(event.target.checked)}
              />
              Apply tool Z 180° flip (default ON)
            </label>
            <button
              type="button"
              aria-label="Preview frame convert Flip"
              onClick={() => void handleFrameFlipPreview()}
              className="btn-primary self-end"
            >
              Preview frame convert
            </button>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Current UF BUSER (X,Y,Z,Rx,Ry,Rz) — editable
              <input
                aria-label="Current user frame BUSER pose"
                className="input-field font-mono text-xs"
                value={sourceUfText}
                onChange={(event) => setSourceUfText(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Target UF BUSER (X,Y,Z,Rx,Ry,Rz) — editable
              <input
                aria-label="Target user frame BUSER pose"
                className="input-field font-mono text-xs"
                value={targetUfText}
                onChange={(event) => setTargetUfText(event.target.value)}
              />
            </label>
          </div>
        </div>
      ) : null}

      {mode === "mirror" ? (
        <div className="rounded border border-border bg-bg/50 p-4">
          <h2 className="text-sm font-semibold text-fg">Mirror</h2>
          <p className="mt-1 text-sm text-muted">
            Use when left and right stations are <span className="text-fg/90">mirrored fixtures</span>.
            Poses are reflected across the chosen plane. Always review RCONF on the pendant after a
            mirror write. Active job:{" "}
            <span className="font-mono text-fg/90">{displayName ?? "none"}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Source UF# (PULSE jobs)
              <input
                type="number"
                aria-label="Source user frame for mirror"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={sourceFrameId}
                onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Mirror plane
              <select
                aria-label="Mirror plane"
                className="rounded border border-border-strong bg-bg px-2 py-1.5 text-sm"
                value={mirrorPlane}
                onChange={(event) => {
                  const plane = event.target.value as MirrorPlane
                  setMirrorPlane(plane)
                  setStatus(
                    `Mirror ${plane} demo updated — reflection across ${plane}; preview still required before write.`
                  )
                }}
              >
                <option value="XZ">XZ (Y flip)</option>
                <option value="YZ">YZ (X flip)</option>
                <option value="XY">XY (Z flip)</option>
              </select>
            </label>
            <button
              type="button"
              aria-label="Preview mirror"
              onClick={() => void handleMirrorPreview()}
              className="btn-primary self-end"
            >
              Preview mirror
            </button>
          </div>
        </div>
      ) : null}

      {mode === "singleSide" ? (
        <div className="rounded border border-border bg-bg/50 p-4">
          <h2 className="text-sm font-semibold text-fg">Single-side mirror (same user frame)</h2>
          <p className="mt-1 text-sm text-muted">
            Mirror a job on the <span className="text-fg/90">same station</span> — output keeps the
            same <span className="font-mono text-fg/80">///USER</span>. Choose Left or Right for the
            demo image. Prefer cartesian USER/BASE backups; PULSE converts via FK then mirrors.
            Active job:{" "}
            <span className="font-mono text-fg/90">{displayName ?? "none"}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <fieldset className="flex flex-col gap-1 text-sm text-fg/80">
              <legend className="text-sm text-fg/80">Station side</legend>
              <div className="flex gap-2" role="radiogroup" aria-label="Station side left or right">
                {(
                  [
                    { id: "left" as const, label: "Left" },
                    { id: "right" as const, label: "Right" }
                  ] as const
                ).map((item) => {
                  const active = stationSide === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={`Station ${item.label}`}
                      onClick={() => {
                        setStationSide(item.id)
                        setStatus(
                          `Single-side demo: ${item.label} station image — same ///USER ${sourceFrameId}.`
                        )
                      }}
                      className={
                        active
                          ? "rounded border border-accent/60 bg-accent/15 px-3 py-1.5 text-sm text-accent-fg focus-ring"
                          : "rounded border border-border-strong px-3 py-1.5 text-sm text-muted hover:border-muted hover:text-fg focus-ring"
                      }
                    >
                      {item.label}
                    </button>
                  )
                })}
              </div>
            </fieldset>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              User frame # (kept)
              <input
                type="number"
                aria-label="User frame kept for single-side mirror"
                className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
                value={sourceFrameId}
                onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Mirror plane
              <select
                aria-label="Single-side mirror plane"
                className="rounded border border-border-strong bg-bg px-2 py-1.5 text-sm"
                value={singleSidePlane}
                onChange={(event) => {
                  const plane = event.target.value as MirrorPlane
                  setSingleSidePlane(plane)
                  setStatus(
                    `Single-side plane ${plane} — same ///USER; preview still required before write.`
                  )
                }}
              >
                <option value="YZ">YZ (X flip) — common left↔right</option>
                <option value="XZ">XZ (Y flip)</option>
                <option value="XY">XY (Z flip)</option>
              </select>
            </label>
            <button
              type="button"
              aria-label="Preview single-side mirror"
              onClick={() => void handleSingleSidePreview()}
              className="btn-primary self-end"
            >
              Preview single-side mirror
            </button>
          </div>

          <details className="mt-4 rounded border border-warn/40 bg-warn/10 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-warn focus-ring">
              Advanced: pulse-axis sign flips (approximate — calibrate first)
            </summary>
            <p className="mt-2 text-xs text-muted">
              Joint-level mirroring is cell-specific and approximate. Defaults are identity (no
              flips) until you calibrate which of S/L/U/R/B/T negate for this robot. Prefer
              cartesian USER backups. Enabling this path skips FK→cartesian mirror.
            </p>
            <label className="mt-2 flex items-center gap-2 text-sm text-fg/80">
              <input
                type="checkbox"
                aria-label="Enable advanced pulse-axis flips for this profile"
                checked={pulsePrefs.advancedEnabled}
                onChange={(event) => {
                  handlePulsePrefsChange({
                    ...pulsePrefs,
                    advancedEnabled: event.target.checked
                  })
                }}
              />
              Enable advanced pulse-axis path for this profile
            </label>
            {pulsePrefs.advancedEnabled ? (
              <>
                <label className="mt-2 flex items-center gap-2 text-sm text-warn">
                  <input
                    type="checkbox"
                    aria-label="Use pulse-axis flips for this preview"
                    checked={usePulseAxisFlips}
                    onChange={(event) => setUsePulseAxisFlips(event.target.checked)}
                  />
                  Use pulse-axis flips for this preview (heavy warning)
                </label>
                <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Pulse axis signs">
                  {PULSE_AXIS_ORDER.map((axis, index) => {
                    const negated = pulsePrefs.signs[index] < 0
                    return (
                      <button
                        key={axis}
                        type="button"
                        aria-label={`Toggle ${axis} axis negate`}
                        aria-pressed={negated}
                        onClick={() => handleAxisSignToggle(index)}
                        className={
                          negated
                            ? "rounded border border-warn/60 bg-warn/20 px-2 py-1 font-mono text-xs text-warn focus-ring"
                            : "rounded border border-border-strong px-2 py-1 font-mono text-xs text-muted focus-ring"
                        }
                      >
                        {axis} {negated ? "×−1" : "×+1"}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    aria-label="Reset pulse axis signs to identity"
                    onClick={() =>
                      handlePulsePrefsChange({
                        ...pulsePrefs,
                        signs: [...DEFAULT_PULSE_MIRROR_SIGNS]
                      })
                    }
                    className="btn-ghost text-xs"
                  >
                    Reset signs
                  </button>
                </div>
              </>
            ) : null}
          </details>
        </div>
      ) : null}

      {mode === "offset" ? (
        <div className="rounded border border-border bg-bg/50 p-4">
          <h2 className="text-sm font-semibold text-fg">Offset</h2>
          <p className="mt-1 text-sm text-muted">
            Apply a small cartesian delta sample to the active job context. Prefer Transfer for
            identical station moves and Mirror / Single-side for reflected fixtures. Active job:{" "}
            <span className="font-mono text-fg/90">{displayName ?? "none"}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Offset dx,dy,dz,drx,dry,drz
              <input
                aria-label="Offset delta"
                className="w-64 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs"
                value={offsetText}
                onChange={(event) => setOffsetText(event.target.value)}
              />
            </label>
            <button
              type="button"
              aria-label="Preview offset"
              onClick={() => void handleOffsetPreview()}
              className="btn-secondary self-end"
            >
              Preview offset
            </button>
          </div>
        </div>
      ) : null}

      <p className="text-sm text-fg/80" role="status">
        {status}
        {rconfReview ? " RCONF must be reviewed on the pendant after mirror." : ""}
      </p>

      {familyWarning ? (
        <p
          className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
          role="status"
        >
          {familyWarning}
        </p>
      ) : null}

      {saveBlocked ? (
        <p
          className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
          role="status"
        >
          Save is blocked until every flipped point is reachable and within pulse limits.
        </p>
      ) : null}

      {reachReport.length > 0 ? (
        <div className="rounded border border-border bg-bg/50 p-3" aria-label="Station flip reach report">
          <h2 className="text-sm font-semibold text-fg">Reach / RCONF report</h2>
          <p className="mt-1 text-xs text-muted">
            {reachReport.filter((row) => row.reachable).length}/{reachReport.length} reachable.
            Consecutive points that share RCONF are grouped in the written job.
          </p>
          <div className="mt-2 max-h-48 overflow-auto">
            <table className="w-full text-left font-mono text-[11px] text-fg/80">
              <thead>
                <tr className="text-muted">
                  <th scope="col" className="pr-2">#</th>
                  <th scope="col" className="pr-2">OK</th>
                  <th scope="col" className="pr-2">err mm</th>
                  <th scope="col" className="pr-2">err deg</th>
                  <th scope="col" className="pr-2">RCONF</th>
                  <th scope="col">note</th>
                </tr>
              </thead>
              <tbody>
                {reachReport.map((row) => (
                  <tr key={row.index} className={row.reachable ? "" : "text-warn"}>
                    <td className="pr-2">{row.index}</td>
                    <td className="pr-2">{row.reachable ? "yes" : "no"}</td>
                    <td className="pr-2">{row.positionErrorMm.toFixed(2)}</td>
                    <td className="pr-2">{row.orientationErrorDeg.toFixed(2)}</td>
                    <td className="pr-2 whitespace-nowrap">
                      {row.rconfText.split(",").slice(0, 5).join(",")}
                    </td>
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {!writeGate.allowed ? (
        <p
          className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
          role="status"
        >
          {writeGate.reason}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm text-fg/80">
          Output file name
          <input
            aria-label="Transform output file name"
            className="rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
            value={outName}
            onChange={(event) => setOutName(event.target.value)}
            disabled={!preview}
            placeholder={preview ? suggestedOutName() : "Run Preview first"}
          />
        </label>
        <button
          type="button"
          aria-label="Write transformed job to output folder"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="btn-primary"
        >
          Write to output folder
        </button>
        {onOpenDiff ? (
          <button
            type="button"
            aria-label="Open Diff page"
            onClick={onOpenDiff}
            className="btn-secondary"
          >
            Open Diff
          </button>
        ) : null}
      </div>
      <p className="text-xs text-muted">
        Writes use the active profile output folder
        {outputFolder ? (
          <>
            : <span className="font-mono text-fg/80">{outputFolder}</span>
          </>
        ) : (
          " (not set yet)"
        )}
        . Source backup stays read-only. Save is disabled until Preview succeeds.
      </p>

      {diffText ? (
        <pre className="min-h-[20rem] max-h-[32rem] flex-1 overflow-auto rounded border border-border bg-bg/80 p-3 text-xs text-muted">
          {diffText}
        </pre>
      ) : null}
      {preview ? (
        <pre className="min-h-[24rem] max-h-[40rem] flex-1 overflow-auto rounded border border-border bg-bg/80 p-3 font-mono text-xs text-fg/80">
          {preview}
        </pre>
      ) : null}
    </section>
  )
}
