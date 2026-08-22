import { useEffect, useMemo, useState, type SyntheticEvent } from "react"
import { getCalibrationGate, getEditWriteGate } from "../calibration"
import {
  previewFrameMove,
  previewMirrorJob,
  previewOffsetJob,
  type StationSide
} from "../../lib/jbi/frameTransform"
import { readTextFile, writeOutputFile, type JbiEntry } from "../../lib/fs/desktop"
import type { MirrorPlane } from "../../lib/kin/client"
import { getActiveProfile, getRobotInstallGate } from "../../lib/robot/profile"
import {
  DEFAULT_PULSE_MIRROR_SIGNS,
  loadPulseMirrorPrefs,
  PULSE_AXIS_ORDER,
  savePulseMirrorPrefs,
  type PulseMirrorAxisSigns,
  type PulseMirrorPrefs
} from "../../lib/robot/pulseMirrorPrefs"
import { FlipAssistDemo } from "./FlipAssistDemo"

/**
 * Offline frame-move / transfer = FK into source UF → emit ///USER <target> with the same
 * relative XYZRxRyRz. CNVRT / SFTON / MFRAME are on-controller alternatives,
 * not this rewrite path (docs/MOTOMAN_DEVELOPER_FINDINGS.md).
 *
 * Single-side mirror keeps the same ///USER and reflects in that frame.
 * Prefer cartesian USER/BASE (or PULSE→FK→USER). Pulse-axis flips are advanced/approximate.
 *
 * After Preview, Write to output folder uses writeOutputFile (output tree only; never source).
 */

type TransformMode = "mirror" | "transfer" | "offset" | "singleSide"

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

  const installGate = getRobotInstallGate()
  const writeGate = getEditWriteGate()
  const activeProfile = getActiveProfile()
  const canSave = Boolean(preview.trim()) && writeGate.allowed

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

  const demoPlane = mode === "singleSide" ? singleSidePlane : mirrorPlane

  const clearPreview = () => {
    setPreview("")
    setDiffText("")
    setOutName("")
    setRconfReview(false)
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

  const handleSelectJob = (path: string) => {
    setJobPath(path)
    onActiveJobChange?.(path)
    clearPreview()
    setStatus(`Transforming: ${jobBaseName(path)}`)
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
    try {
      const original = await readTextFile(jobPath)
      const result = await previewFrameMove({
        originalText: original,
        sourceFrameId,
        targetFrameId,
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
    try {
      const original = await readTextFile(jobPath)
      const mirrored = await previewMirrorJob({
        originalText: original,
        plane: mirrorPlane,
        sourceFrameId,
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
    try {
      const original = await readTextFile(jobPath)
      const mirrored = await previewMirrorJob({
        originalText: original,
        plane: singleSidePlane,
        sourceFrameId,
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
    try {
      const original = await readTextFile(jobPath)
      const result = await previewOffsetJob({
        originalText: original,
        deltaText: offsetText,
        sourceFrameId,
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

  const handleSave = async () => {
    if (!preview.trim()) {
      setStatus("Run Preview first — Save stays disabled until a transform preview exists.")
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
          <span className="text-fg/90">Mirror</span> (mirrored fixtures across stations),{" "}
          <span className="text-fg/90">Single-side mirror</span> (same ///USER / same station), and{" "}
          <span className="text-fg/90">Offset</span>. Prefer cartesian USER/BASE jobs for mirrors.
          Preview, then <span className="text-fg/90">Write to output folder</span> (never the source
          backup). Uses the <span className="text-fg/80">active robot profile</span>.
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
