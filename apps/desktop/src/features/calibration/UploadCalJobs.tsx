import { useMemo, useRef, useState } from "react"
import {
  extractCalibrationPair,
  mergeExtractionIntoSession,
  type CalibrationExtractSummary
} from "@yaskawa/core/calibration/extract"
import { sampleIsComplete } from "@yaskawa/core/calibration/steps"
import { formatPose, formatPulses } from "@yaskawa/core/calibration/session"
import type {
  CalibrationSession,
  CalibrationStepDef
} from "@yaskawa/core/calibration/types"
import {
  listJbiFiles,
  pickJbiFile,
  readTextFile,
  type JbiEntry
} from "../../lib/fs/desktop"
import { joinPath } from "@yaskawa/core/fs/paths"

type LoadSlot = "standard" | "relative"

interface UploadCalJobsPanelProps {
  steps: CalibrationStepDef[]
  session: CalibrationSession
  outputFolder: string | null
  sourceFolder: string | null
  standardFileName?: string
  relativeFileName?: string
  onSessionChange: (session: CalibrationSession) => void
  onStatus: (message: string) => void
}

const readBrowserFile = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.readAsText(file)
  })
}

export const UploadCalJobsPanel = ({
  steps,
  session,
  outputFolder,
  sourceFolder,
  standardFileName,
  relativeFileName,
  onSessionChange,
  onStatus
}: UploadCalJobsPanelProps) => {
  const [standardText, setStandardText] = useState<string | null>(null)
  const [relativeText, setRelativeText] = useState<string | null>(null)
  const [standardLabel, setStandardLabel] = useState("")
  const [relativeLabel, setRelativeLabel] = useState("")
  const [summary, setSummary] = useState<CalibrationExtractSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [browseEntries, setBrowseEntries] = useState<JbiEntry[]>([])
  const [browseRoot, setBrowseRoot] = useState<string | null>(null)
  const standardInputRef = useRef<HTMLInputElement>(null)
  const relativeInputRef = useRef<HTMLInputElement>(null)

  const filledLookup = useMemo(() => {
    const map = new Map(
      (summary?.filled ?? []).map((hit) => [hit.stepId, hit] as const)
    )
    return map
  }, [summary])

  const handleAssignText = (slot: LoadSlot, text: string, label: string) => {
    if (slot === "standard") {
      setStandardText(text)
      setStandardLabel(label)
      setSummary(null)
      onStatus(`Loaded STANDARD: ${label}`)
      return
    }
    setRelativeText(text)
    setRelativeLabel(label)
    setSummary(null)
    onStatus(`Loaded RELATIVE: ${label}`)
  }

  const handlePickPath = async (slot: LoadSlot) => {
    setBusy(true)
    try {
      const path = await pickJbiFile()
      if (!path) {
        onStatus("File pick cancelled.")
        return
      }
      const text = await readTextFile(path)
      const name = path.split(/[/\\]/).pop() ?? path
      handleAssignText(slot, text, name)
    } catch (error) {
      onStatus(
        error instanceof Error
          ? `${error.message} — use Choose file… if the dialog is unavailable.`
          : String(error)
      )
    } finally {
      setBusy(false)
    }
  }

  const handleBrowserFile = async (slot: LoadSlot, file: File | undefined) => {
    if (!file) {
      return
    }
    setBusy(true)
    try {
      const text = await readBrowserFile(file)
      handleAssignText(slot, text, file.name)
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleBrowseFolder = async (root: string | null, label: string) => {
    if (!root) {
      onStatus(`Set ${label} folder first (header / Setup).`)
      return
    }
    setBusy(true)
    try {
      const entries = await listJbiFiles(root)
      const cal = entries.filter((row) => /CAL_.*\.(JBI)$/i.test(row.relativePath))
      setBrowseEntries(cal.length > 0 ? cal : entries)
      setBrowseRoot(root)
      onStatus(
        cal.length > 0
          ? `Browsing ${cal.length} CAL_*.JBI under ${label}.`
          : `No CAL_*.JBI — showing ${entries.length} job(s) under ${label}.`
      )
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleBrowsePick = async (entry: JbiEntry, slot: LoadSlot) => {
    setBusy(true)
    try {
      const text = await readTextFile(entry.path)
      handleAssignText(slot, text, entry.relativePath)
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleLoadSuggested = async (slot: LoadSlot, fileName: string) => {
    const roots = [outputFolder, sourceFolder].filter(Boolean) as string[]
    if (roots.length === 0) {
      onStatus("Set Output or Source folder, or use Pick / Choose file.")
      return
    }
    setBusy(true)
    try {
      for (const root of roots) {
        try {
          const path = joinPath(root, fileName)
          const text = await readTextFile(path)
          handleAssignText(slot, text, fileName)
          return
        } catch {
          // try next root
        }
      }
      onStatus(`Could not find ${fileName} under output/source — browse or pick a file.`)
    } finally {
      setBusy(false)
    }
  }

  const handleExtract = () => {
    if (!standardText && !relativeText) {
      onStatus("Load STANDARD and/or RELATIVE taught jobs first.")
      return
    }
    const nextSummary = extractCalibrationPair(standardText, relativeText, steps)
    const nextSession = mergeExtractionIntoSession(session, nextSummary, steps)
    setSummary(nextSummary)
    onSessionChange(nextSession)
    const pulseN = nextSummary.filled.filter((h) => h.pulses).length
    const cartN = nextSummary.filled.filter((h) => h.cartesian).length
    const warnN = nextSummary.warnings.length
    onStatus(
      `Extracted into session — ${pulseN} pulse / ${cartN} cartesian step(s).` +
        (warnN > 0 ? ` ${warnN} warning(s).` : "") +
        " Manual entry remains for anything still missing."
    )
  }

  const handleClearLoads = () => {
    setStandardText(null)
    setRelativeText(null)
    setStandardLabel("")
    setRelativeLabel("")
    setSummary(null)
    onStatus("Cleared loaded CAL jobs (session samples unchanged).")
  }

  return (
    <div
      className="rounded border border-border bg-surface/40 p-4"
      aria-label="Upload recorded calibration jobs"
    >
      <h2 className="text-sm font-semibold text-fg">Upload recorded calibration jobs</h2>
      <p className="mt-2 text-sm text-fg/80">
        After teaching on the pendant, load the recorded{" "}
        <span className="font-mono text-accent-fg">CAL_*_STANDARD.JBI</span> (pulses) and{" "}
        <span className="font-mono text-accent-fg">CAL_*_RELATIVE.JBI</span> (cartesian). Extract
        maps each <span className="font-mono">CALSTEP:&lt;id&gt;</span> / pause tag to the session.
        Writes never touch the source backup.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded border border-sky-800/50 bg-sky-950/20 p-3">
          <p className="text-xs font-medium text-sky-100">Phase A — STANDARD (PULSE)</p>
          <p className="mt-1 font-mono text-[11px] text-muted-2">
            {standardLabel || "not loaded"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="Load STANDARD calibration job"
              disabled={busy}
              onClick={() => void handlePickPath("standard")}
              className="rounded border border-border-strong px-2.5 py-1 text-xs text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
            >
              Load STANDARD
            </button>
            <button
              type="button"
              aria-label="Choose STANDARD file from disk"
              disabled={busy}
              onClick={() => standardInputRef.current?.click()}
              className="rounded border border-border-strong px-2.5 py-1 text-xs text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
            >
              Choose file…
            </button>
            <input
              ref={standardInputRef}
              type="file"
              accept=".jbi,.JBI,text/plain"
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(event) => {
                void handleBrowserFile("standard", event.target.files?.[0])
                event.target.value = ""
              }}
            />
          </div>
        </div>

        <div className="rounded border border-violet-800/50 bg-violet-950/20 p-3">
          <p className="text-xs font-medium text-violet-100">Phase B — RELATIVE (cartesian)</p>
          <p className="mt-1 font-mono text-[11px] text-muted-2">
            {relativeLabel || "not loaded"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="Load RELATIVE calibration job"
              disabled={busy}
              onClick={() => void handlePickPath("relative")}
              className="rounded border border-border-strong px-2.5 py-1 text-xs text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
            >
              Load RELATIVE
            </button>
            <button
              type="button"
              aria-label="Choose RELATIVE file from disk"
              disabled={busy}
              onClick={() => relativeInputRef.current?.click()}
              className="rounded border border-border-strong px-2.5 py-1 text-xs text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
            >
              Choose file…
            </button>
            <input
              ref={relativeInputRef}
              type="file"
              accept=".jbi,.JBI,text/plain"
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(event) => {
                void handleBrowserFile("relative", event.target.files?.[0])
                event.target.value = ""
              }}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Browse output folder for calibration jobs"
          disabled={busy}
          onClick={() => void handleBrowseFolder(outputFolder, "Output")}
          className="rounded border border-border-strong px-2.5 py-1 text-xs text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
        >
          Browse output
        </button>
        <button
          type="button"
          aria-label="Browse source folder for calibration jobs"
          disabled={busy}
          onClick={() => void handleBrowseFolder(sourceFolder, "Source")}
          className="rounded border border-border-strong px-2.5 py-1 text-xs text-fg/90 hover:border-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
        >
          Browse source
        </button>
        <button
          type="button"
          aria-label="Extract positions into calibration session"
          disabled={busy || (!standardText && !relativeText)}
          onClick={handleExtract}
          className="rounded border border-success/50 bg-success/15 px-3 py-1.5 text-sm text-success hover:bg-success/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-40"
        >
          Extract into session
        </button>
        <button
          type="button"
          aria-label="Clear loaded calibration job files"
          disabled={busy}
          onClick={handleClearLoads}
          className="rounded border border-border-strong px-2.5 py-1 text-xs text-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
        >
          Clear loads
        </button>
      </div>

      {browseEntries.length > 0 ? (
        <div className="mt-3 max-h-40 overflow-auto rounded border border-border bg-bg/50">
          <p className="sticky top-0 border-b border-border bg-surface/90 px-2 py-1 text-[11px] text-muted">
            Browse {browseRoot ?? ""} — click Load STD / Load REL
          </p>
          <ul className="divide-y divide-border" aria-label="Browsable calibration jobs">
            {browseEntries.map((entry) => (
              <li
                key={entry.path}
                className="flex flex-wrap items-center gap-2 px-2 py-1.5 font-mono text-[11px] text-fg/80"
              >
                <span className="min-w-0 flex-1 truncate">{entry.relativePath}</span>
                <button
                  type="button"
                  aria-label={`Load ${entry.name} as STANDARD`}
                  onClick={() => void handleBrowsePick(entry, "standard")}
                  className="rounded border border-sky-800/60 px-1.5 py-0.5 text-sky-100 hover:border-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  → STD
                </button>
                <button
                  type="button"
                  aria-label={`Load ${entry.name} as RELATIVE`}
                  onClick={() => void handleBrowsePick(entry, "relative")}
                  className="rounded border border-violet-800/60 px-1.5 py-0.5 text-violet-100 hover:border-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  → REL
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary ? (
        <div className="mt-4 overflow-auto rounded border border-border">
          <table className="min-w-full text-left text-xs text-muted">
            <caption className="sr-only">Extracted calibration steps summary</caption>
            <thead className="bg-surface/80 text-fg/80">
              <tr>
                <th className="px-2 py-1.5 font-medium">Step</th>
                <th className="px-2 py-1.5 font-medium">Pulse</th>
                <th className="px-2 py-1.5 font-medium">Cartesian</th>
                <th className="px-2 py-1.5 font-medium">Session</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => {
                const hit = filledLookup.get(step.id)
                const sample = session.samples.find((row) => row.stepId === step.id)
                const complete = sampleIsComplete(sample)
                return (
                  <tr key={step.id} className="border-t border-border font-mono">
                    <td className="px-2 py-1.5 text-fg/90">
                      {step.label}
                      <span className="ml-1 text-muted-2">{step.pauseTag}</span>
                    </td>
                    <td className="px-2 py-1.5">
                      {hit?.pulses
                        ? formatPulses(hit.pulses)
                        : sample?.pulses
                          ? `(manual) ${formatPulses(sample.pulses)}`
                          : "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {hit?.cartesian
                        ? formatPose(hit.cartesian)
                        : sample?.cartesian
                          ? `(manual) ${formatPose(sample.cartesian)}`
                          : "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {sample?.skipped
                        ? "skipped"
                        : complete
                          ? "ok"
                          : hit
                            ? "partial"
                            : "missing"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {summary.warnings.length > 0 ? (
            <ul
              className="border-t border-accent/30 bg-accent/10 px-2 py-2 text-[11px] text-accent-fg"
              aria-label="Extraction warnings"
            >
              {summary.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-muted-2">
        Tip: browse the output folder for taught CAL jobs after USB copy-back. Manual capture
        fields stay available for any step still missing.
        {standardFileName ? (
          <button
            type="button"
            className="ml-2 underline hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            aria-label={`Attempt load of ${standardFileName} from folders`}
            onClick={() => void handleLoadSuggested("standard", standardFileName)}
          >
            Try {standardFileName}
          </button>
        ) : null}
        {relativeFileName ? (
          <button
            type="button"
            className="ml-2 underline hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            aria-label={`Attempt load of ${relativeFileName} from folders`}
            onClick={() => void handleLoadSuggested("relative", relativeFileName)}
          >
            Try {relativeFileName}
          </button>
        ) : null}
      </p>
    </div>
  )
}
