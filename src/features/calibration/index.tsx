import { useEffect, useState } from "react"
import {
  YMCONNECT_ONLINE_VALIDATION,
  calibrate,
  type CalibratePair,
  type CalibrateResult,
  type CartesianPose
} from "../../lib/kin/client"
import { CalibrationWizard } from "./wizard"
import {
  clearStored,
  DEFAULT_THRESHOLD_MM,
  loadStored,
  saveStored,
  type StoredCalibration
} from "./storage"
import {
  attachCalibrationToActiveProfile,
  getActiveProfile,
  getRobotInstallGate,
  loadProfilesStore
} from "../../lib/robot/profile"

export type { StoredCalibration }
export { getCalibrationGate, getEditWriteGate } from "./storage"

type CalibrationMode = "choose" | "guided" | "manual"

interface CalibrationPageProps {
  outputFolder: string | null
  sourceFolder?: string | null
}

const parsePose = (text: string): CartesianPose => {
  const parts = text.split(/[,\s]+/).map((part) => Number.parseFloat(part)).filter((n) => !Number.isNaN(n))
  if (parts.length < 6) {
    throw new Error("Cartesian needs X,Y,Z,Rx,Ry,Rz")
  }
  return { x: parts[0], y: parts[1], z: parts[2], rx: parts[3], ry: parts[4], rz: parts[5] }
}

const parsePulses = (text: string): number[] => {
  const parts = text.split(/[,\s]+/).map((part) => Number.parseFloat(part)).filter((n) => !Number.isNaN(n))
  if (parts.length < 6) {
    throw new Error("Pulses need 6 axis values")
  }
  return parts.slice(0, 6)
}

export const CalibrationPage = ({
  outputFolder,
  sourceFolder = null
}: CalibrationPageProps) => {
  const [mode, setMode] = useState<CalibrationMode>("choose")
  const [pulsesText, setPulsesText] = useState("0, -75310, 1200, 0, -127658, -70")
  const [cartText, setCartText] = useState("275.000, 0.000, 875.000, 180.0000, 45.0000, 0.0000")
  const [extraPairs, setExtraPairs] = useState<CalibratePair[]>([])
  const [thresholdMm, setThresholdMm] = useState(DEFAULT_THRESHOLD_MM)
  const [result, setResult] = useState<CalibrateResult | null>(null)
  const [stored, setStored] = useState<StoredCalibration | null>(null)
  const [status, setStatus] = useState("Choose Guided (robot + JBI) or Manual entry.")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setStored(loadStored())
  }, [])

  const handleApplyRecord = (record: StoredCalibration, fitted: CalibrateResult) => {
    const install = getRobotInstallGate()
    if (!install.allowed) {
      setStatus(install.reason)
      return
    }
    saveStored(record)
    attachCalibrationToActiveProfile(loadProfilesStore(), record.calibrationId)
    setStored(record)
    setResult(fitted)
  }

  const handleAddPair = () => {
    try {
      const pair: CalibratePair = {
        pulses: parsePulses(pulsesText),
        cartesian: parsePose(cartText),
        label: `pair-${extraPairs.length + 1}`,
        frame: "BASE"
      }
      setExtraPairs((prev) => [...prev, pair])
      setStatus(`Added pair ${extraPairs.length + 1}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleFit = async () => {
    const install = getRobotInstallGate()
    if (!install.allowed) {
      setStatus(install.reason)
      return
    }
    setBusy(true)
    setStatus("Running SciPy least_squares via sidecar…")
    try {
      const pairs =
        extraPairs.length > 0
          ? extraPairs
          : [
              {
                pulses: parsePulses(pulsesText),
                cartesian: parsePose(cartText),
                label: "home",
                frame: "BASE" as const
              }
            ]
      const fitted = await calibrate({ pairs, toolId: 0 })
      setResult(fitted)
      const gated = fitted.residuals.worstMm <= thresholdMm
      const record: StoredCalibration = {
        calibrationId: fitted.calibrationId,
        parameters: fitted.parameters,
        residuals: {
          rmsMm: fitted.residuals.rmsMm,
          worstMm: fitted.residuals.worstMm
        },
        thresholdMm,
        gated,
        updatedAt: new Date().toISOString(),
        source: "manual"
      }
      saveStored(record)
      attachCalibrationToActiveProfile(loadProfilesStore(), fitted.calibrationId)
      setStored(record)
      setStatus(
        gated
          ? `Gate OPEN — worst ${fitted.residuals.worstMm.toFixed(3)} mm ≤ ${thresholdMm.toFixed(3)} mm`
          : `Gate CLOSED — worst ${fitted.residuals.worstMm.toFixed(3)} mm > ${thresholdMm.toFixed(3)} mm (position rewrites blocked)`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = () => {
    clearStored()
    setStored(null)
    setResult(null)
    setStatus("Cleared stored calibration — gate closed.")
  }

  const installGate = getRobotInstallGate()
  const activeProfile = getActiveProfile(loadProfilesStore())

  return (
    <section className="flex h-full flex-col gap-4 overflow-auto p-6" aria-label="Kinematics calibration">
      <header>
        <h1 className="text-lg font-semibold text-fg">Calibration</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Fit pulse-per-degree and home offsets for the{" "}
          <span className="text-fg/90">
            {activeProfile ? activeProfile.displayName : "active robot"}
          </span>
          . Link lengths come from the robot profile (RC.PRM). Frames/tools stay offline from
          UFRAME.CND / TOOL.CND.
        </p>
        {!installGate.allowed ? (
          <p className="mt-2 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent-fg" role="status">
            {installGate.reason}
          </p>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Calibration mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "guided"}
          aria-label="Guided calibration with robot job"
          onClick={() => setMode("guided")}
          className={[
            "rounded px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
            mode === "guided"
              ? "border border-accent/70 bg-accent/15 font-medium text-accent-fg"
              : "border border-border-strong text-fg/80 hover:border-muted"
          ].join(" ")}
        >
          Guided (robot + JBI)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "manual"}
          aria-label="Manual calibration entry"
          onClick={() => setMode("manual")}
          className={[
            "rounded px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
            mode === "manual"
              ? "border border-accent/70 bg-accent/15 font-medium text-accent-fg"
              : "border border-border-strong text-fg/80 hover:border-muted"
          ].join(" ")}
        >
          Manual entry
        </button>
      </div>

      {mode === "choose" ? (
        <div className="grid max-w-3xl gap-3 md:grid-cols-2">
          <button
            type="button"
            aria-label="Start guided calibration wizard"
            onClick={() => setMode("guided")}
            className="rounded border border-border-strong bg-surface/50 p-4 text-left hover:border-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >
            <span className="block text-sm font-medium text-fg">Guided (robot + JBI)</span>
            <span className="mt-1 block text-xs text-muted">
              Step-by-step: export STANDARD + RELATIVE jobs, capture Phase A pulses then Phase B
              cartesian at the same poses, capture home→± safe joint limits, then fit and apply.
            </span>
          </button>
          <button
            type="button"
            aria-label="Start manual calibration entry"
            onClick={() => setMode("manual")}
            className="rounded border border-border-strong bg-surface/50 p-4 text-left hover:border-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          >
            <span className="block text-sm font-medium text-fg">Manual entry</span>
            <span className="mt-1 block text-xs text-muted">
              Paste free-form pulse ↔ cartesian pairs without the checklist or generated job.
            </span>
          </button>
        </div>
      ) : null}

      {mode === "guided" ? (
        <CalibrationWizard
          outputFolder={outputFolder}
          sourceFolder={sourceFolder}
          thresholdMm={thresholdMm}
          onThresholdChange={setThresholdMm}
          onApplied={handleApplyRecord}
          onEscapeManual={() => setMode("manual")}
        />
      ) : null}

      {mode === "manual" ? (
        <>
          <aside
            className="rounded border border-border-strong/80 bg-surface/50 px-3 py-2 text-xs text-muted"
            aria-label="YMConnect online validation"
          >
            Online path (soft dependency):{" "}
            <span className="font-mono text-fg/80">{YMCONNECT_ONLINE_VALIDATION.api}</span>{" "}
            ({YMCONNECT_ONLINE_VALIDATION.conversions.join(", ")}) via the YMConnect bridge.
            {YMCONNECT_ONLINE_VALIDATION.untestedOnCell
              ? " Implemented but untested on a live cell until the SDK is linked."
              : ""}{" "}
            Offline SciPy FK + pendant transcription remain the default. Prefer{" "}
            <button
              type="button"
              aria-label="Switch to guided calibration wizard"
              onClick={() => setMode("guided")}
              className="text-accent-fg underline decoration-accent/60 hover:text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            >
              Guided mode
            </button>{" "}
            for the robot-assisted checklist (includes Capture via YMConnect when available).
          </aside>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Pulses (S,L,U,R,B,T)
              <textarea
                aria-label="Pulse values"
                className="min-h-20 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                value={pulsesText}
                onChange={(event) => setPulsesText(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              Cartesian (X,Y,Z,Rx,Ry,Rz)
              <textarea
                aria-label="Cartesian values"
                className="min-h-20 rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                value={cartText}
                onChange={(event) => setCartText(event.target.value)}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-3">
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
                  setThresholdMm(Number.parseFloat(event.target.value) || DEFAULT_THRESHOLD_MM)
                }
              />
            </label>
            <button
              type="button"
              aria-label="Add calibration pair"
              onClick={handleAddPair}
              className="rounded border border-border-strong px-3 py-1.5 text-sm text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            >
              Add pair ({extraPairs.length})
            </button>
            <button
              type="button"
              aria-label="Run calibration fit"
              disabled={busy}
              onClick={() => void handleFit()}
              className="btn-primary"
            >
              {busy ? "Fitting…" : "Fit + apply gate"}
            </button>
            <button
              type="button"
              aria-label="Clear stored calibration"
              onClick={handleClear}
              className="rounded border border-border-strong px-3 py-1.5 text-sm text-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            >
              Clear
            </button>
          </div>

          <p className="text-sm text-fg/80" role="status">
            {status}
          </p>
        </>
      ) : null}

      {stored && mode !== "guided" ? (
        <dl className="grid max-w-xl grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted">
          <dt>calibrationId</dt>
          <dd className="text-fg/90">{stored.calibrationId}</dd>
          <dt>rmsMm</dt>
          <dd className="text-fg/90">{stored.residuals.rmsMm.toFixed(4)}</dd>
          <dt>worstMm</dt>
          <dd className="text-fg/90">{stored.residuals.worstMm.toFixed(4)}</dd>
          <dt>gate</dt>
          <dd className={stored.gated ? "text-success" : "text-danger"}>
            {stored.gated ? "OPEN" : "CLOSED"}
          </dd>
        </dl>
      ) : null}

      {mode === "guided" && stored ? (
        <dl className="grid max-w-xl grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted">
          <dt>stored gate</dt>
          <dd className={stored.gated ? "text-success" : "text-danger"}>
            {stored.gated ? "OPEN" : "CLOSED"} ({stored.calibrationId})
          </dd>
        </dl>
      ) : null}

      {mode === "manual" && result?.message ? (
        <pre className="overflow-auto rounded border border-border bg-bg/80 p-3 text-xs text-muted">
          {result.message}
        </pre>
      ) : null}
    </section>
  )
}
