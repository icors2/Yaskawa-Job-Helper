import { useEffect, useMemo, useState } from "react"
import {
  YMCONNECT_ONLINE_VALIDATION,
  calibrate,
  convertPositionPulseToCartesian,
  getYmConnectBridgeStatus,
  readUframe,
  type CalibratePair,
  type CalibrateResult,
  type UserFrame
} from "../../lib/kin/client"
import { getActiveProfile, loadProfilesStore } from "../../lib/robot/profile"
import { getYmConnectSettings, YMCONNECT_DOCS } from "@yaskawa/core/robot/ymconnectPrefs"
import {
  buildCalibrationReadme,
  buildRelativeCalibrationJob,
  buildStandardCalibrationJob,
  CALIBRATION_README_FILENAME,
  resolveCalibrationJobNames
} from "@yaskawa/core/calibration/jobGenerator"
import {
  buildCalibrationSteps,
  framesFromUframeCnd,
  requiredStepIds,
  sampleIsComplete
} from "@yaskawa/core/calibration/steps"
import {
  clearSessionLocal,
  completeSamplesForFit,
  createEmptySession,
  formatPose,
  formatPulses,
  loadSession,
  parsePose,
  parsePulses,
  removeSample,
  sampleToCalibratePair,
  saveSessionLocal,
  updateSessionFrames,
  upsertSample
} from "@yaskawa/core/calibration/session"
import type {
  CalibFrameType,
  CalibrationSample,
  CalibrationSession,
  CapturePhase,
  ConfiguredUserFrame,
  WizardPhase
} from "@yaskawa/core/calibration/types"
import {
  CALIBRATION_SESSION_FILENAME,
  WIZARD_PHASE_LABELS,
  WIZARD_PHASE_ORDER
} from "@yaskawa/core/calibration/types"
import { joinPath } from "@yaskawa/core/fs/paths"
import type { StoredCalibration } from "./storage"
import { writeOutputFile } from "../../lib/fs/desktop"
import { UploadCalJobsPanel } from "./UploadCalJobs"

const DEFAULT_THRESHOLD_MM = 1.0

interface CalibrationWizardProps {
  outputFolder: string | null
  sourceFolder: string | null
  thresholdMm: number
  onThresholdChange: (value: number) => void
  onApplied: (record: StoredCalibration, result: CalibrateResult) => void
  onEscapeManual: () => void
}

const phaseIndex = (phase: WizardPhase): number => WIZARD_PHASE_ORDER.indexOf(phase)

export const CalibrationWizard = ({
  outputFolder,
  sourceFolder,
  thresholdMm,
  onThresholdChange,
  onApplied,
  onEscapeManual
}: CalibrationWizardProps) => {
  const [session, setSession] = useState<CalibrationSession>(
    () => loadSession() ?? createEmptySession("guided")
  )
  const [phase, setPhase] = useState<WizardPhase>("intro")
  const [captureIndex, setCaptureIndex] = useState(0)
  const [ymBridgeAvailable, setYmBridgeAvailable] = useState(false)
  const [capturePhase, setCapturePhase] = useState<CapturePhase>("pulse")
  const [pulsesText, setPulsesText] = useState("")
  const [cartText, setCartText] = useState("")
  const [frame, setFrame] = useState<CalibFrameType>("BASE")
  const [userFrameIdText, setUserFrameIdText] = useState("")
  const [status, setStatus] = useState(
    "Start with Intro — configure frames, then export the two calibration jobs."
  )
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CalibrateResult | null>(null)
  const [exported, setExported] = useState(false)
  const [importedFromJobs, setImportedFromJobs] = useState(false)
  const [uframeCatalog, setUframeCatalog] = useState<UserFrame[]>([])
  const [newFrameId, setNewFrameId] = useState("4")
  const [newFrameName, setNewFrameName] = useState("")

  useEffect(() => {
    void (async () => {
      const bridge = await getYmConnectBridgeStatus()
      setYmBridgeAvailable(bridge.available)
    })()
  }, [])

  const steps = useMemo(
    () => buildCalibrationSteps(session.frames, session.workspaceLimited),
    [session.frames, session.workspaceLimited]
  )

  const jobNames = useMemo(() => resolveCalibrationJobNames(), [])

  const step = steps[captureIndex] ?? steps[0]
  const sampleForStep = session.samples.find((row) => row.stepId === step?.id)

  useEffect(() => {
    if (!step) {
      return
    }
    const existing = session.samples.find((row) => row.stepId === step.id)
    if (existing) {
      setPulsesText(existing.pulses ? formatPulses(existing.pulses) : "")
      setCartText(existing.cartesian ? formatPose(existing.cartesian) : "")
      setFrame(existing.frame)
      setUserFrameIdText(existing.userFrameId != null ? String(existing.userFrameId) : "")
      return
    }
    setPulsesText(step.seedPulses ? formatPulses(step.seedPulses) : "")
    setCartText(step.seedCartesian ? formatPose(step.seedCartesian) : "")
    setFrame(step.defaultFrame)
    setUserFrameIdText(step.userFrameId != null ? String(step.userFrameId) : "")
  }, [step?.id, session.samples, captureIndex])

  const handleLoadUframes = async () => {
    if (!sourceFolder) {
      setStatus("Open a source folder (Library / Setup) that contains UFRAME.CND.")
      return
    }
    setBusy(true)
    try {
      const path = joinPath(sourceFolder, "UFRAME.CND")
      const { frames } = await readUframe(path)
      setUframeCatalog(frames)
      const next = updateSessionFrames(
        session,
        framesFromUframeCnd(frames),
        session.workspaceLimited
      )
      setSession(next)
      setExported(false)
      setStatus(`Loaded ${frames.length} user frame(s) from UFRAME.CND as defaults.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleWorkspaceLimited = () => {
    const next = updateSessionFrames(session, session.frames, !session.workspaceLimited)
    setSession(next)
    setExported(false)
    setStatus(
      next.workspaceLimited
        ? "Workspace-limited ON — full safe ± from home; skip blocked directions."
        : "Workspace-limited OFF — still stay cell-safe; never crash envelopes."
    )
  }

  const handleUpdateFrame = (id: number, patch: Partial<ConfiguredUserFrame>) => {
    const frames = session.frames.map((row) => (row.id === id ? { ...row, ...patch } : row))
    const next = updateSessionFrames(session, frames, session.workspaceLimited)
    setSession(next)
    setExported(false)
  }

  const handleRemoveFrame = (id: number) => {
    if (session.frames.length <= 1) {
      setStatus("Keep at least one user frame (or clear includes instead).")
      return
    }
    const frames = session.frames.filter((row) => row.id !== id)
    const next = updateSessionFrames(session, frames, session.workspaceLimited)
    setSession(next)
    setExported(false)
    setStatus(`Removed UF#${id} from capture list.`)
  }

  const handleAddFrame = () => {
    const id = Number.parseInt(newFrameId, 10)
    if (Number.isNaN(id) || id < 1 || id > 63) {
      setStatus("User frame id must be 1–63.")
      return
    }
    if (session.frames.some((row) => row.id === id)) {
      setStatus(`UF#${id} is already in the list.`)
      return
    }
    const fromCatalog = uframeCatalog.find((row) => row.id === id)
    const frame: ConfiguredUserFrame = {
      id,
      name: newFrameName.trim() || fromCatalog?.name || `UF${id}`,
      includeRorg: true,
      includeRxx: true,
      includeRxy: true,
      required: false
    }
    const next = updateSessionFrames(session, [...session.frames, frame], session.workspaceLimited)
    setSession(next)
    setExported(false)
    setNewFrameName("")
    setStatus(`Added UF#${id} ${frame.name} (RORG/RXX/RXY).`)
  }

  const handleExportJobs = async () => {
    if (!outputFolder) {
      setStatus("Set an Output folder in the header before exporting (writes never touch source).")
      return
    }
    setBusy(true)
    try {
      const names = resolveCalibrationJobNames()
      const built = buildCalibrationSteps(session.frames, session.workspaceLimited)
      const stdPath = await writeOutputFile(
        names.standardFile,
        buildStandardCalibrationJob(built, new Date(), names)
      )
      const relPath = await writeOutputFile(
        names.relativeFile,
        buildRelativeCalibrationJob(built, new Date(), names)
      )
      const readmePath = await writeOutputFile(
        CALIBRATION_README_FILENAME,
        buildCalibrationReadme(built, session.frames, names)
      )
      setExported(true)
      setStatus(
        `Wrote ${stdPath}, ${relPath}, and ${readmePath}. Load STANDARD first (pulses), then RELATIVE (cartesian).`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleSavePulsePhase = () => {
    try {
      const pulses = parsePulses(pulsesText)
      const existing = session.samples.find((row) => row.stepId === step.id)
      const sample: CalibrationSample = {
        stepId: step.id,
        pulses,
        cartesian: existing?.cartesian,
        frame: existing?.frame ?? step.defaultFrame,
        userFrameId: existing?.userFrameId ?? step.userFrameId,
        label: step.id,
        capturedAt: existing?.capturedAt ?? new Date().toISOString(),
        pulseCapturedAt: new Date().toISOString(),
        cartCapturedAt: existing?.cartCapturedAt,
        skipped: false,
        notes: existing?.notes
      }
      const next = upsertSample(session, sample)
      setSession(next)
      setStatus(`Saved pulses for ${step.label}. Continue to Phase B (cartesian).`)
      setCapturePhase("cartesian")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleCaptureViaYmConnect = async () => {
    if (!ymBridgeAvailable) {
      setStatus(
        `Install YMConnect + build ymconnect/YmConnectBridge, then connect to the controller. Docs: ${YMCONNECT_DOCS.home}`
      )
      return
    }
    const profile = getActiveProfile(loadProfilesStore())
    if (!profile) {
      setStatus("Select an active robot profile first.")
      return
    }
    setBusy(true)
    try {
      const pulses = parsePulses(pulsesText)
      const settings = getYmConnectSettings(profile.id)
      const response = await convertPositionPulseToCartesian({
        settings,
        input: { pulses, toolNumber: 0 }
      })
      if (!response.ok) {
        setStatus(
          "unavailable" in response && response.unavailable
            ? `${response.reason} — ${response.installHint}`
            : "YMConnect convert failed"
        )
        return
      }
      if (!response.pose) {
        setStatus("YMConnect returned no cartesian pose.")
        return
      }
      setCartText(formatPose(response.pose))
      setFrame("BASE")
      setStatus(
        "Captured cartesian via YMConnect ConvertPosition (PulseToCartesianPos) — review then Save cartesian. Untested on cell until SDK linked."
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveCartesianPhase = () => {
    try {
      const cartesian = parsePose(cartText)
      const userFrameId =
        frame === "USER" ? Number.parseInt(userFrameIdText, 10) : step.userFrameId
      if (frame === "USER" && Number.isNaN(userFrameId as number)) {
        throw new Error("USER frame requires a numeric userFrameId")
      }
      const existing = session.samples.find((row) => row.stepId === step.id)
      if (!existing?.pulses) {
        throw new Error("Save Phase A pulses first (or go Back).")
      }
      const sample: CalibrationSample = {
        ...existing,
        cartesian,
        frame,
        userFrameId: frame === "USER" ? userFrameId : step.userFrameId,
        label: step.id,
        capturedAt: new Date().toISOString(),
        cartCapturedAt: new Date().toISOString(),
        skipped: false
      }
      const next = upsertSample(session, sample)
      setSession(next)
      setStatus(`Saved cartesian for ${step.label}. Pair complete.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleSkipStep = () => {
    if (!step.skippable) {
      setStatus("This step is required and cannot be skipped.")
      return
    }
    const sample: CalibrationSample = {
      stepId: step.id,
      frame: step.defaultFrame,
      userFrameId: step.userFrameId,
      label: step.id,
      capturedAt: new Date().toISOString(),
      skipped: true,
      notes: "Skipped — axis/pose not clear in cell"
    }
    const next = upsertSample(session, sample)
    setSession(next)
    setStatus(`Skipped ${step.label}. Fit still works with fewer pairs.`)
    handleAdvanceAfterCapture()
  }

  const handleClearSample = () => {
    const next = removeSample(session, step.id)
    setSession(next)
    setPulsesText(step.seedPulses ? formatPulses(step.seedPulses) : "")
    setCartText(step.seedCartesian ? formatPose(step.seedCartesian) : "")
    setCapturePhase("pulse")
    setStatus(`Cleared sample for ${step.label}`)
  }

  const handleSaveSession = async () => {
    const next = saveSessionLocal({ ...session, mode: "guided" })
    setSession(next)
    if (!outputFolder) {
      setStatus("Session saved to localStorage. Set Output folder to also export JSON.")
      return
    }
    try {
      const path = await writeOutputFile(
        CALIBRATION_SESSION_FILENAME,
        `${JSON.stringify(next, null, 2)}\n`
      )
      setStatus(`Session saved to localStorage and ${path}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleLoadSession = () => {
    const loaded = loadSession()
    if (!loaded) {
      setStatus("No session in localStorage.")
      return
    }
    setSession(loaded)
    setStatus(`Loaded session with ${loaded.samples.length} sample(s).`)
  }

  const handleResetSession = () => {
    clearSessionLocal()
    setSession(createEmptySession("guided"))
    setResult(null)
    setPhase("intro")
    setCaptureIndex(0)
    setCapturePhase("pulse")
    setExported(false)
    setImportedFromJobs(false)
    setStatus("Session cleared.")
  }

  const handleAdvanceAfterCapture = () => {
    if (captureIndex < steps.length - 1) {
      setCaptureIndex((prev) => prev + 1)
      setCapturePhase("pulse")
      return
    }
    setPhase("review")
  }

  const handleCaptureNext = () => {
    const sample = session.samples.find((row) => row.stepId === step.id)
    if (sample?.skipped) {
      handleAdvanceAfterCapture()
      return
    }
    if (capturePhase === "pulse") {
      if (!sample?.pulses) {
        setStatus("Save Phase A pulses (or Skip) before continuing.")
        return
      }
      setCapturePhase("cartesian")
      return
    }
    if (!sampleIsComplete(sample)) {
      setStatus("Save Phase B cartesian (or Skip) before continuing.")
      return
    }
    handleAdvanceAfterCapture()
  }

  const handleCaptureBack = () => {
    if (capturePhase === "cartesian") {
      setCapturePhase("pulse")
      return
    }
    if (captureIndex > 0) {
      setCaptureIndex((prev) => prev - 1)
      setCapturePhase("cartesian")
      return
    }
    setPhase("export")
  }

  const handlePhaseBack = () => {
    const idx = phaseIndex(phase)
    if (phase === "capture") {
      handleCaptureBack()
      return
    }
    if (idx <= 0) {
      return
    }
    const prev = WIZARD_PHASE_ORDER[idx - 1]
    if (prev === "capture") {
      setCaptureIndex(Math.max(0, steps.length - 1))
      setCapturePhase("cartesian")
    }
    setPhase(prev)
  }

  const handlePhaseNext = () => {
    if (phase === "intro") {
      setPhase("configure_frames")
      return
    }
    if (phase === "configure_frames") {
      const requiredFrames = session.frames.filter((row) => row.required && row.includeRorg)
      if (requiredFrames.length === 0) {
        setStatus("Include at least one required frame with RORG (typically S1 / UF#2).")
        return
      }
      setPhase("export")
      return
    }
    if (phase === "export") {
      if (!exported && !importedFromJobs) {
        setStatus(
          "Export both jobs, or upload taught STANDARD/RELATIVE jobs below, before continuing."
        )
        return
      }
      setCaptureIndex(0)
      setCapturePhase("pulse")
      setPhase("capture")
      return
    }
    if (phase === "capture") {
      handleCaptureNext()
      return
    }
    if (phase === "review") {
      setPhase("fit")
      return
    }
    if (phase === "fit") {
      if (!result) {
        setStatus("Run calibrate before Apply.")
        return
      }
      setPhase("apply")
    }
  }

  const buildPairs = (): CalibratePair[] => {
    return completeSamplesForFit(session).map(sampleToCalibratePair)
  }

  const handleRunCalibrate = async () => {
    const missing = requiredStepIds(steps).filter((id) => {
      const sample = session.samples.find((row) => row.stepId === id)
      return !sampleIsComplete(sample) || sample?.skipped
    })
    if (missing.length > 0) {
      setStatus(`Missing required samples: ${missing.join(", ")}`)
      return
    }
    const pairs = buildPairs()
    if (pairs.length < 2) {
      setStatus("Need at least two complete (non-skipped) pairs to fit.")
      return
    }
    setBusy(true)
    setStatus("Running SciPy least_squares via sidecar…")
    try {
      const fitted = await calibrate({ pairs, toolId: 0 })
      setResult(fitted)
      setStatus(
        `Fit done — RMS ${fitted.residuals.rmsMm.toFixed(3)} mm, worst ${fitted.residuals.worstMm.toFixed(3)} mm. Review then Apply.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleApply = async () => {
    if (!result) {
      setStatus("Run calibrate first.")
      return
    }
    const gated = result.residuals.worstMm <= thresholdMm
    const record = {
      calibrationId: result.calibrationId,
      parameters: result.parameters,
      residuals: {
        rmsMm: result.residuals.rmsMm,
        worstMm: result.residuals.worstMm
      },
      thresholdMm,
      gated,
      updatedAt: new Date().toISOString(),
      source: "wizard" as const
    }
    onApplied(record, result)
    if (outputFolder) {
      try {
        const name = `CALIBRATION_RESULT_${result.calibrationId}.json`
        await writeOutputFile(
          name,
          `${JSON.stringify({ record, result, session }, null, 2)}\n`
        )
        setStatus(
          gated
            ? `Gate OPEN — saved ${name}. Worst ${result.residuals.worstMm.toFixed(3)} mm ≤ ${thresholdMm.toFixed(3)} mm`
            : `Gate CLOSED — saved ${name}. Worst ${result.residuals.worstMm.toFixed(3)} mm > ${thresholdMm.toFixed(3)} mm`
        )
        return
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
        return
      }
    }
    setStatus(
      gated
        ? `Gate OPEN — worst ${result.residuals.worstMm.toFixed(3)} mm ≤ ${thresholdMm.toFixed(3)} mm`
        : `Gate CLOSED — worst ${result.residuals.worstMm.toFixed(3)} mm > ${thresholdMm.toFixed(3)} mm`
    )
  }

  const completedCapture = steps.filter((row) =>
    sampleIsComplete(session.samples.find((sample) => sample.stepId === row.id))
  ).length

  const progressPct = Math.round(
    ((phaseIndex(phase) + (phase === "capture" ? (captureIndex + 0.5) / Math.max(steps.length, 1) : 0)) /
      WIZARD_PHASE_ORDER.length) *
      100
  )

  return (
    <div className="flex flex-col gap-4" aria-label="Calibration wizard">
      <aside
        className="rounded border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-fg"
        role="note"
      >
        Robot motion is operator-responsibility. Export is PAUSE-heavy — jog only in free space.
        No full joint rotation. Workspace-limited mode defaults ON. PC writes go only to the output
        folder. Default path is offline pendant transcription. Online path:{" "}
        <span className="font-mono">{YMCONNECT_ONLINE_VALIDATION.api}</span>
        {YMCONNECT_ONLINE_VALIDATION.untestedOnCell ? " (implemented, untested on cell)." : "."}
      </aside>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Save calibration session"
          onClick={() => void handleSaveSession()}
          className="rounded border border-border-strong px-3 py-1.5 text-sm text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        >
          Save session
        </button>
        <button
          type="button"
          aria-label="Load calibration session from local storage"
          onClick={handleLoadSession}
          className="rounded border border-border-strong px-3 py-1.5 text-sm text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        >
          Load session
        </button>
        <button
          type="button"
          aria-label="Reset calibration session"
          onClick={handleResetSession}
          className="rounded border border-border-strong px-3 py-1.5 text-sm text-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        >
          Reset session
        </button>
        <button
          type="button"
          aria-label="Escape to manual calibration"
          onClick={onEscapeManual}
          className="rounded border border-border-strong px-3 py-1.5 text-sm text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        >
          Escape to Manual
        </button>
      </div>

      <div className="flex flex-col gap-2" aria-label="Wizard progress">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-2">
          <span>
            Phase {phaseIndex(phase) + 1}/{WIZARD_PHASE_ORDER.length}: {WIZARD_PHASE_LABELS[phase]}
            {phase === "capture"
              ? ` · point ${captureIndex + 1}/${steps.length} · Phase ${capturePhase === "pulse" ? "A (PULSE)" : "B (CART)"}`
              : ""}
          </span>
          <span>
            Output: {outputFolder ?? "not set"} · Captured {completedCapture}/{steps.length}
          </span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded bg-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.max(0, progressPct))}
          aria-label="Calibration wizard progress"
        >
          <div
            className="h-full bg-accent/80 transition-all"
            style={{ width: `${Math.min(100, Math.max(4, progressPct))}%` }}
          />
        </div>
        <ol className="flex flex-wrap gap-1.5" aria-label="Wizard phases">
          {WIZARD_PHASE_ORDER.map((row) => {
            const active = row === phase
            const done = phaseIndex(row) < phaseIndex(phase)
            return (
              <li key={row}>
                <button
                  type="button"
                  aria-label={`Go to ${WIZARD_PHASE_LABELS[row]}`}
                  aria-current={active ? "step" : undefined}
                  onClick={() => setPhase(row)}
                  className={[
                    "rounded px-2 py-1 text-[11px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
                    active
                      ? "border border-accent/80 bg-accent/20 text-accent-fg"
                      : done
                        ? "border border-success/40 bg-success/10 text-success"
                        : "border border-border-strong text-muted hover:border-muted"
                  ].join(" ")}
                >
                  {WIZARD_PHASE_LABELS[row]}
                </button>
              </li>
            )
          })}
        </ol>
      </div>

      {phase === "intro" ? (
        <div className="rounded border border-border bg-surface/40 p-4">
          <h2 className="text-sm font-semibold text-fg">How cell calibration works</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-fg/80">
            <li>
              <span className="font-medium text-fg">Phase A — Standard / pulse job.</span>{" "}
              Teach or load <span className="font-mono text-accent-fg">{jobNames.standardName}</span>.
              At each PAUSE open the <span className="font-medium">PULSE</span> screen and write
              S,L,U,R,B,T.
            </li>
            <li>
              <span className="font-medium text-fg">Phase B — Relative / USER (or BASE display).</span>{" "}
              Convert that job to relative, or load{" "}
              <span className="font-mono text-accent-fg">{jobNames.relativeName}</span>. Return to the{" "}
              <span className="font-medium">same physical poses</span> (matching pause tags). Open{" "}
              <span className="font-medium">BASE</span> or <span className="font-medium">USER n</span>{" "}
              and write X,Y,Z,Rx,Ry,Rz.
            </li>
            <li>
              <span className="font-medium text-fg">Home-anchored ± safe limits.</span> From
              known home, jog each axis to the farthest <span className="font-medium">safe</span>{" "}
              positive and negative (labels S+, S−, … T+/T−) — not mechanical max. Prefer one
              MOVL per step. Skip a direction only if that side is unclear.
            </li>
            <li>
              <span className="font-medium text-fg">Upload taught jobs (preferred after pendant).</span>{" "}
              Copy STANDARD + RELATIVE back to the PC →{" "}
              <span className="font-medium">Load STANDARD / Load RELATIVE</span> →{" "}
              <span className="font-medium">Extract into session</span>. Manual paste remains for
              missing steps.
            </li>
          </ol>
          <p className="mt-3 text-xs text-muted-2">
            Later: bulk pulse→relative conversion of production jobs will supply regression pairs.
            That import path is stubbed until cell data exists — do not invent fake pairs.
          </p>
        </div>
      ) : null}

      {phase === "export" ? (
        <div className="flex flex-col gap-4">
          <div className="rounded border border-border bg-surface/40 p-4">
            <h2 className="text-sm font-semibold text-fg">Export paired calibration jobs</h2>
            <p className="mt-2 text-sm text-fg/80">
              Writes two JBIs with matching <span className="font-mono">CALSTEP</span> tags plus a
              README that explains the standard→relative procedure.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs text-muted">
              <li>{jobNames.standardFile} — Phase A PULSE</li>
              <li>{jobNames.relativeFile} — Phase B cartesian (USER)</li>
              <li>{CALIBRATION_README_FILENAME}</li>
            </ul>
            <button
              type="button"
              aria-label="Export standard and relative calibration jobs"
              disabled={busy}
              onClick={() => void handleExportJobs()}
              className="mt-4 btn-primary"
            >
              {exported ? "Re-export both jobs" : "Export both jobs + README"}
            </button>
            {exported ? (
              <p className="mt-2 text-xs text-success">
                Exported — teach on the robot, then upload below (or continue to capture to type
                values).
              </p>
            ) : null}
          </div>

          <UploadCalJobsPanel
            steps={steps}
            session={session}
            outputFolder={outputFolder}
            sourceFolder={sourceFolder}
            standardFileName={jobNames.standardFile}
            relativeFileName={jobNames.relativeFile}
            onSessionChange={(next) => {
              setSession(saveSessionLocal(next))
              setImportedFromJobs(true)
            }}
            onStatus={setStatus}
          />
        </div>
      ) : null}

      {phase === "configure_frames" ? (
        <div className="rounded border border-border bg-surface/40 p-4">
          <h2 className="text-sm font-semibold text-fg">Configure user frames & safety</h2>
          <p className="mt-2 text-sm text-fg/80">
            Load frames from UFRAME.CND as defaults, then add extras (e.g. UF#4) with RORG/RXX/RXY
            capture points.
          </p>

          <label className="mt-4 flex items-start gap-2 text-sm text-fg/80">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={session.workspaceLimited}
              onChange={handleToggleWorkspaceLimited}
              aria-label="Workspace-limited mode"
            />
            <span>
              <span className="font-medium text-fg">Workspace-limited mode</span> (recommended
              ON) — capture full <span className="font-medium">safe</span> ± range from home
              (not crash/mechanical max). Goal is both S+/S− … T+/T−; Skip a side if blocked.
              Fit still works with fewer pairs.
            </span>
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="Load user frames from UFRAME.CND"
              disabled={busy}
              onClick={() => void handleLoadUframes()}
              className="rounded border border-border-strong px-3 py-1.5 text-sm text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
            >
              Load from UFRAME.CND
            </button>
          </div>

          <ul className="mt-4 space-y-3" aria-label="Configured user frames">
            {session.frames.map((row) => (
              <li
                key={row.id}
                className="rounded border border-border bg-bg/50 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-accent-fg">
                    UF#{row.id} {row.name}
                  </span>
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={row.required}
                      onChange={(event) =>
                        handleUpdateFrame(row.id, { required: event.target.checked })
                      }
                      aria-label={`Required frame UF${row.id}`}
                    />
                    required
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove user frame ${row.id}`}
                    onClick={() => handleRemoveFrame(row.id)}
                    className="ml-auto text-xs text-muted-2 hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
                  {(
                    [
                      ["includeRorg", "RORG"],
                      ["includeRxx", "RXX"],
                      ["includeRxy", "RXY"]
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={row[key]}
                        onChange={(event) =>
                          handleUpdateFrame(row.id, { [key]: event.target.checked })
                        }
                        aria-label={`${label} for UF${row.id}`}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Frame #
              <input
                type="number"
                min={1}
                max={63}
                aria-label="New user frame id"
                className="w-20 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                value={newFrameId}
                onChange={(event) => setNewFrameId(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Name
              <input
                type="text"
                aria-label="New user frame name"
                className="w-36 rounded border border-border-strong bg-bg px-2 py-1.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                value={newFrameName}
                onChange={(event) => setNewFrameName(event.target.value)}
                placeholder="e.g. FIXTURE"
              />
            </label>
            <button
              type="button"
              aria-label="Add user frame capture steps"
              onClick={handleAddFrame}
              className="rounded border border-success/50 bg-success/15 px-3 py-1.5 text-sm text-success hover:bg-success/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            >
              Add frame (RORG/RXX/RXY)
            </button>
          </div>
        </div>
      ) : null}

      {phase === "capture" && step ? (
        <div className="flex flex-col gap-4">
        <div className="rounded border border-border bg-surface/40 p-4">
          <h2 className="text-sm font-semibold text-fg">
            {captureIndex + 1}. {step.label}
            {!step.required ? (
              <span className="ml-2 text-xs font-normal text-muted-2">
                ({step.skippable ? "skippable" : "optional"})
              </span>
            ) : null}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-muted-2">{step.pauseTag}</p>
          <p className="mt-2 text-sm text-fg/80">{step.description}</p>

          <div
            className={[
              "mt-4 rounded border px-3 py-2 text-sm",
              capturePhase === "pulse"
                ? "border-sky-800/60 bg-sky-950/30 text-sky-100"
                : "border-violet-800/60 bg-violet-950/30 text-violet-100"
            ].join(" ")}
            role="status"
          >
            {capturePhase === "pulse" ? (
              <>
                <p className="font-medium">Phase A — PULSE (standard job)</p>
                <p className="mt-1 text-xs opacity-90">{step.pulseHint}</p>
                <p className="mt-1 text-xs opacity-80">
                  Pendant screen: <span className="font-mono">PULSE</span> · Job:{" "}
                  <span className="font-mono">{jobNames.standardFile}</span>
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">Phase B — Cartesian (relative / USER or BASE)</p>
                <p className="mt-1 text-xs opacity-90">{step.cartesianHint}</p>
                <p className="mt-1 text-xs opacity-80">
                  Pendant screen: <span className="font-mono">BASE</span> or{" "}
                  <span className="font-mono">USER n</span> · Job:{" "}
                  <span className="font-mono">{jobNames.relativeFile}</span>
                </p>
              </>
            )}
          </div>

          {sampleForStep?.skipped ? (
            <p className="mt-3 text-sm text-accent-fg">This step is marked skipped.</p>
          ) : null}

          {capturePhase === "pulse" ? (
            <label className="mt-4 flex flex-col gap-1 text-sm text-fg/80">
              Pulses (S,L,U,R,B,T) — paste OK (or upload taught JBIs below)
              <textarea
                aria-label="Pulse values for current step"
                className="min-h-20 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                value={pulsesText}
                onChange={(event) => setPulsesText(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="mt-4 flex flex-col gap-1 text-sm text-fg/80">
                Cartesian XYZ Rx Ry Rz — paste OK (or upload taught JBIs below)
                <textarea
                  aria-label="Cartesian values for current step"
                  className="min-h-20 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                  value={cartText}
                  onChange={(event) => setCartText(event.target.value)}
                />
              </label>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm text-fg/80">
                  Frame
                  <select
                    aria-label="Cartesian frame type"
                    className="rounded border border-border-strong bg-bg px-2 py-1.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                    value={frame}
                    onChange={(event) => setFrame(event.target.value as CalibFrameType)}
                  >
                    <option value="BASE">BASE</option>
                    <option value="USER">USER</option>
                  </select>
                </label>
                {frame === "USER" ? (
                  <label className="flex flex-col gap-1 text-sm text-fg/80">
                    User frame id
                    <input
                      type="number"
                      min={1}
                      max={63}
                      aria-label="User frame id"
                      className="w-24 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      value={userFrameIdText}
                      onChange={(event) => setUserFrameIdText(event.target.value)}
                    />
                  </label>
                ) : null}
              </div>
            </>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {capturePhase === "pulse" ? (
              <button
                type="button"
                aria-label="Save pulse phase"
                onClick={handleSavePulsePhase}
                className="rounded border border-success/50 bg-success/15 px-3 py-1.5 text-sm text-success hover:bg-success/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                Save pulses → Phase B
              </button>
            ) : (
              <>
                <button
                  type="button"
                  aria-label="Capture cartesian via YMConnect"
                  disabled={busy || !ymBridgeAvailable}
                  onClick={() => void handleCaptureViaYmConnect()}
                  className="rounded border border-border-strong px-3 py-1.5 text-sm text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
                  title={
                    ymBridgeAvailable
                      ? "Call YMConnect ConvertPosition PulseToCartesianPos"
                      : "Install YMConnect + connect to controller"
                  }
                >
                  {ymBridgeAvailable
                    ? busy
                      ? "YMConnect…"
                      : "Capture via YMConnect"
                    : "Capture via YMConnect (install SDK)"}
                </button>
                <button
                  type="button"
                  aria-label="Save cartesian phase"
                  onClick={handleSaveCartesianPhase}
                  className="rounded border border-success/50 bg-success/15 px-3 py-1.5 text-sm text-success hover:bg-success/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  Save cartesian
                </button>
              </>
            )}
            {step.skippable ? (
              <button
                type="button"
                aria-label="Skip this capture step"
                onClick={handleSkipStep}
                className="rounded border border-accent/50 px-3 py-1.5 text-sm text-accent-fg hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                Skip (not clear in cell)
              </button>
            ) : null}
            {sampleForStep ? (
              <button
                type="button"
                aria-label="Clear sample for current step"
                onClick={handleClearSample}
                className="rounded border border-border-strong px-3 py-1.5 text-sm text-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                Clear sample
              </button>
            ) : null}
          </div>

          <ol className="mt-4 flex flex-wrap gap-1.5" aria-label="Capture checklist">
            {steps.map((row, index) => {
              const done = sampleIsComplete(
                session.samples.find((sample) => sample.stepId === row.id)
              )
              const active = index === captureIndex
              const skipped = session.samples.find((sample) => sample.stepId === row.id)?.skipped
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-label={`${row.label}${done ? " done" : ""}${skipped ? " skipped" : ""}`}
                    aria-current={active ? "step" : undefined}
                    onClick={() => {
                      setCaptureIndex(index)
                      setCapturePhase("pulse")
                    }}
                    className={[
                      "rounded px-2 py-1 font-mono text-[11px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
                      active
                        ? "border border-accent/80 bg-accent/20 text-accent-fg"
                        : skipped
                          ? "border border-accent/30 text-accent/80"
                          : done
                            ? "border border-success/40 bg-success/10 text-success"
                            : "border border-border-strong text-muted hover:border-muted"
                    ].join(" ")}
                  >
                    {index + 1}
                  </button>
                </li>
              )
            })}
          </ol>
        </div>

        <details className="rounded border border-border bg-bg/40 open:bg-surface/30">
          <summary
            className="cursor-pointer px-4 py-2 text-sm font-medium text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            tabIndex={0}
          >
            Upload recorded calibration jobs (extract from taught JBIs)
          </summary>
          <div className="border-t border-border p-2">
            <UploadCalJobsPanel
              steps={steps}
              session={session}
              outputFolder={outputFolder}
              sourceFolder={sourceFolder}
              standardFileName={jobNames.standardFile}
              relativeFileName={jobNames.relativeFile}
              onSessionChange={(next) => {
                setSession(saveSessionLocal(next))
                setImportedFromJobs(true)
              }}
              onStatus={setStatus}
            />
          </div>
        </details>
        </div>
      ) : null}

      {phase === "review" ? (
        <div className="rounded border border-border bg-surface/40 p-4">
          <h2 className="text-sm font-semibold text-fg">Review captured pairs</h2>
          <p className="mt-2 text-sm text-fg/80">
            Confirm required points are complete. Skipped ± joint limits are OK in workspace-limited
            mode when that direction is unclear — goal is still both sides when safe.
          </p>
          {session.samples.length > 0 ? (
            <div className="mt-3 overflow-auto rounded border border-border">
              <table className="min-w-full text-left text-xs text-muted">
                <caption className="sr-only">Captured calibration samples</caption>
                <thead className="bg-surface/80 text-fg/80">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Step</th>
                    <th className="px-2 py-1.5 font-medium">Status</th>
                    <th className="px-2 py-1.5 font-medium">Frame</th>
                    <th className="px-2 py-1.5 font-medium">Pulses</th>
                    <th className="px-2 py-1.5 font-medium">Cartesian</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((row) => {
                    const sample = session.samples.find((item) => item.stepId === row.id)
                    return (
                      <tr key={row.id} className="border-t border-border font-mono">
                        <td className="px-2 py-1.5 text-fg/90">{row.label}</td>
                        <td className="px-2 py-1.5">
                          {sample?.skipped
                            ? "skipped"
                            : sampleIsComplete(sample)
                              ? "ok"
                              : "incomplete"}
                        </td>
                        <td className="px-2 py-1.5">
                          {sample
                            ? `${sample.frame}${sample.userFrameId != null ? `#${sample.userFrameId}` : ""}`
                            : "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          {sample?.pulses ? formatPulses(sample.pulses) : "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          {sample?.cartesian ? formatPose(sample.cartesian) : "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-2">No samples yet — go back to Capture.</p>
          )}

          <aside
            className="mt-4 rounded border border-border-strong/80 bg-bg/60 px-3 py-2 text-xs text-muted-2"
            aria-label="Future bulk conversion import"
          >
            <p className="font-medium text-muted">
              Later: Import conversion pairs (coming when cell data available)
            </p>
            <p className="mt-1">
              Bulk pulse→relative conversion of production jobs will feed regression pairs here.
              Disabled until you can provide real paired job JSON — no fake data.
            </p>
            <button
              type="button"
              disabled
              aria-label="Import conversion pairs unavailable"
              className="mt-2 cursor-not-allowed rounded border border-border px-2 py-1 text-muted-2"
            >
              Import conversion pairs — unavailable
            </button>
          </aside>
        </div>
      ) : null}

      {phase === "fit" || phase === "apply" ? (
        <div className="rounded border border-border bg-surface/40 p-4">
          <h2 className="text-sm font-semibold text-fg">
            {phase === "fit" ? "Run least-squares fit" : "Apply calibration gate"}
          </h2>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Gate threshold (mm)
              <input
                type="number"
                step="0.1"
                min="0.1"
                aria-label="Residual gate threshold in millimetres"
                className="w-28 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                value={thresholdMm}
                onChange={(event) =>
                  onThresholdChange(Number.parseFloat(event.target.value) || DEFAULT_THRESHOLD_MM)
                }
              />
            </label>
            {phase === "fit" ? (
              <button
                type="button"
                aria-label="Run calibration fit"
                disabled={busy}
                onClick={() => void handleRunCalibrate()}
                className="btn-primary"
              >
                {busy ? "Fitting…" : "Run calibrate"}
              </button>
            ) : (
              <button
                type="button"
                aria-label="Apply and save calibration"
                disabled={!result}
                onClick={() => void handleApply()}
                className="rounded border border-success/50 bg-success/15 px-3 py-1.5 text-sm text-success hover:bg-success/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-40"
              >
                Apply / save calibration
              </button>
            )}
          </div>

          {result ? (
            <dl className="mt-4 grid max-w-xl grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted">
              <dt>calibrationId</dt>
              <dd className="text-fg/90">{result.calibrationId}</dd>
              <dt>rmsMm</dt>
              <dd className="text-fg/90">{result.residuals.rmsMm.toFixed(4)}</dd>
              <dt>worstMm</dt>
              <dd className="text-fg/90">{result.residuals.worstMm.toFixed(4)}</dd>
              <dt>vs gate</dt>
              <dd
                className={
                  result.residuals.worstMm <= thresholdMm ? "text-success" : "text-danger"
                }
              >
                {result.residuals.worstMm <= thresholdMm ? "would OPEN" : "would CLOSE"}
              </dd>
            </dl>
          ) : null}

          {result?.message ? (
            <pre className="mt-3 overflow-auto rounded border border-border bg-bg/80 p-3 text-xs text-muted">
              {result.message}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Previous wizard step"
          disabled={phase === "intro"}
          onClick={handlePhaseBack}
          className="rounded border border-border-strong px-3 py-1.5 text-sm text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-40"
        >
          Back
        </button>
        {phase !== "apply" ? (
          <button
            type="button"
            aria-label="Next wizard step"
            onClick={handlePhaseNext}
            className="btn-primary"
          >
            Next
          </button>
        ) : null}
      </div>

      <p className="text-sm text-fg/80" role="status">
        {status}
      </p>
    </div>
  )
}
