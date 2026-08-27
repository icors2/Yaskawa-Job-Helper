import { useEffect, useMemo, useState } from "react"
import {
  buildCalibrationReadme,
  buildRelativeCalibrationJob,
  buildStandardCalibrationJob,
  resolveCalibrationJobNames
} from "@yaskawa/core/calibration/jobGenerator"
import { extractCalibrationPair } from "@yaskawa/core/calibration/extract"
import { createEmptySession, loadSession, saveSessionLocal } from "@yaskawa/core/calibration/session"
import {
  buildCalibrationSteps,
  defaultConfiguredFrames
} from "@yaskawa/core/calibration/steps"
import { CALIBRATION_README_FILENAME } from "@yaskawa/core/calibration/types"
import { usePlatform } from "../../context/PlatformContext"
import {
  attachCalibrationToActiveProfile,
  getActiveProfile,
  getRobotInstallGate,
  loadProfilesStore
} from "../../lib/profile"
import {
  clearStored,
  DEFAULT_THRESHOLD_MM,
  getCalibrationGate,
  loadStored,
  saveStored,
  type StoredCalibration
} from "./storage"

export const CalibrationPage = () => {
  const { platform, folders, persistProfiles } = usePlatform()
  const [stored, setStored] = useState<StoredCalibration | null>(null)
  const [status, setStatus] = useState(
    "Export CAL jobs, teach on the pendant, then re-import. Least-squares fit lands with the core solvers agent."
  )
  const [busy, setBusy] = useState(false)
  const [thresholdMm, setThresholdMm] = useState(DEFAULT_THRESHOLD_MM)
  const [extractSummary, setExtractSummary] = useState<string | null>(null)

  const jobNames = useMemo(() => resolveCalibrationJobNames(), [])
  const gate = getCalibrationGate()
  const install = getRobotInstallGate()
  const active = getActiveProfile()

  useEffect(() => {
    setStored(loadStored())
  }, [])

  const handleExportJobs = async () => {
    if (!platform) {
      return
    }
    if (!folders.outputReady) {
      setStatus("Link an output folder (or enable Downloads) before exporting CAL jobs.")
      return
    }
    if (!install.allowed) {
      setStatus(install.reason)
      return
    }
    setBusy(true)
    try {
      const frames = defaultConfiguredFrames()
      const steps = buildCalibrationSteps(frames, true)
      const homePulses = getActiveProfile()?.homePulses ?? []
      const standard = buildStandardCalibrationJob(steps, new Date(), jobNames, homePulses)
      const relative = buildRelativeCalibrationJob(steps, new Date(), jobNames)
      const readme = buildCalibrationReadme(steps, frames, jobNames)
      await platform.fs.writeOutput(jobNames.standardFile, standard)
      await platform.fs.writeOutput(jobNames.relativeFile, relative)
      await platform.fs.writeOutput(CALIBRATION_README_FILENAME, readme)
      const session = loadSession() ?? createEmptySession("guided")
      saveSessionLocal(session)
      setStatus(
        `Wrote ${jobNames.standardFile}, ${jobNames.relativeFile}, and ${CALIBRATION_README_FILENAME} to output.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Export failed")
    } finally {
      setBusy(false)
    }
  }

  const handleImportCalJobs = async () => {
    if (!platform || !folders.sourceReady) {
      setStatus("Link a source folder that contains the taught CAL STANDARD / RELATIVE jobs.")
      return
    }
    setBusy(true)
    try {
      const jobs = await platform.fs.listJbi()
      const standardEntry = jobs.find((job) =>
        job.name.toUpperCase().includes("STANDARD")
      )
      const relativeEntry = jobs.find((job) =>
        job.name.toUpperCase().includes("RELATIVE")
      )
      if (!standardEntry && !relativeEntry) {
        setStatus("No CAL_*_STANDARD / RELATIVE jobs found in the linked source.")
        return
      }
      const standardText = standardEntry
        ? await platform.fs.readText(standardEntry.path)
        : null
      const relativeText = relativeEntry
        ? await platform.fs.readText(relativeEntry.path)
        : null
      const steps = buildCalibrationSteps(defaultConfiguredFrames(), true)
      const summary = extractCalibrationPair(standardText, relativeText, steps, {
        standardHint: jobNames.standardName,
        relativeHint: jobNames.relativeName
      })
      setExtractSummary(
        `Filled ${summary.filled.length} step hit(s). Missing pulses: ${summary.missingPulseStepIds.length}. Missing cart: ${summary.missingCartStepIds.length}.`
      )
      setStatus(
        "Extracted taught CAL jobs into session data. Run the least-squares fit once core solvers are available (sibling agent)."
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed")
    } finally {
      setBusy(false)
    }
  }

  const handleMarkGatedDemo = async () => {
    if (!install.allowed) {
      setStatus(install.reason)
      return
    }
    const record: StoredCalibration = {
      calibrationId: crypto.randomUUID(),
      parameters: {},
      residuals: { rmsMm: 0.1, worstMm: 0.2 },
      thresholdMm,
      gated: true,
      updatedAt: new Date().toISOString(),
      source: "imported"
    }
    await saveStored(record)
    const next = attachCalibrationToActiveProfile(
      loadProfilesStore(),
      record.calibrationId
    )
    await persistProfiles(next)
    setStored(record)
    setStatus(
      "Demo gate opened (placeholder residuals). Replace with real LM fit when core solvers land."
    )
  }

  const handleClear = async () => {
    await clearStored()
    setStored(null)
    setStatus("Cleared stored calibration for the active profile.")
  }

  return (
    <div className="page-shell">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold text-fg">Calibration</h2>
        <p className="text-sm text-muted">
          Guided CAL job export / re-import for{" "}
          <span className="font-mono text-fg">{active?.displayName ?? "no robot"}</span>.
          Geometry fit uses the TypeScript LM solver from the core ports agent when available.
        </p>
      </header>

      <section className="panel flex flex-col gap-2 p-4" aria-label="Calibration gate">
        <h3 className="text-sm font-semibold text-fg">Write gate</h3>
        <p className="text-sm text-muted">
          {gate.allowed ? (
            <span className="text-success">Open — transforms may write.</span>
          ) : (
            <span className="text-warn">{gate.reason}</span>
          )}
        </p>
        {stored ? (
          <p className="font-mono text-[11px] text-muted-2">
            Stored worst {stored.residuals.worstMm.toFixed(3)} mm · threshold{" "}
            {stored.thresholdMm.toFixed(2)} mm · gated={String(stored.gated)}
          </p>
        ) : (
          <p className="font-mono text-[11px] text-muted-2">No stored calibration.</p>
        )}
        <label className="flex items-center gap-2 text-xs text-muted" htmlFor="calib-threshold">
          Threshold (mm)
          <input
            id="calib-threshold"
            type="number"
            step="0.1"
            min="0.1"
            className="input-field w-24"
            value={thresholdMm}
            onChange={(event) => setThresholdMm(Number.parseFloat(event.target.value) || DEFAULT_THRESHOLD_MM)}
            aria-label="Calibration threshold millimetres"
          />
        </label>
      </section>

      <section className="panel flex flex-col gap-3 p-4" aria-label="CAL jobs">
        <h3 className="text-sm font-semibold text-fg">CAL STANDARD / RELATIVE</h3>
        <p className="text-xs text-muted">
          Export seeds home + UF + joint-limit steps, teach on the pendant, then re-import from the
          linked source folder.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            aria-label="Export calibration jobs to output"
            disabled={busy || !platform}
            onClick={() => void handleExportJobs()}
          >
            Export CAL jobs
          </button>
          <button
            type="button"
            className="btn-secondary"
            aria-label="Import taught calibration jobs"
            disabled={busy || !platform}
            onClick={() => void handleImportCalJobs()}
          >
            Import taught CAL jobs
          </button>
          <button
            type="button"
            className="btn-ghost"
            aria-label="Open calibration gate with demo residuals"
            disabled={busy}
            onClick={() => void handleMarkGatedDemo()}
          >
            Open gate (demo)
          </button>
          <button
            type="button"
            className="btn-ghost"
            aria-label="Clear stored calibration"
            disabled={busy}
            onClick={() => void handleClear()}
          >
            Clear
          </button>
        </div>
        {extractSummary ? (
          <p className="font-mono text-[11px] text-muted-2">{extractSummary}</p>
        ) : null}
      </section>

      <p className="text-sm text-muted" role="status">
        {status}
      </p>
    </div>
  )
}
