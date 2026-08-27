import { useEffect, useMemo, useState } from "react"
import type { JbiEntry } from "../../lib/fs/desktop"
import { readTextFile, writeOutputFile } from "../../lib/fs/desktop"
import { unifiedDiff, buildValidationReport, type ValidationIssue } from "@yaskawa/core/jbi/diff"
import { renameJobText } from "@yaskawa/core/jbi/library"
import { parseJob } from "@yaskawa/core/jbi/parse"
import { scaleSpeeds, setSpeeds, setWeldConditions, type SpeedKind, type SpeedScope } from "@yaskawa/core/jbi/edit"
import { serializeJob } from "@yaskawa/core/jbi/serialize"
import { previewFrameMove } from "../../lib/jbi/frameTransform"
import { getCalibrationGate, getEditWriteGate } from "../calibration"
import type { WeldKind } from "@yaskawa/core/jbi/cnd"
import { getRobotInstallGate } from "../../lib/robot/profile"

export type WizardIntent =
  | "rename"
  | "duplicate"
  | "frameMove"
  | "mirror"
  | "offset"
  | "speed"
  | "weld"
  | "findReplace"
  | "manual"

type WizardStep = "select" | "intent" | "params" | "preview" | "write"

interface WizardPageProps {
  sourceFolder: string | null
  outputFolder: string | null
  jobs: JbiEntry[]
  initialJobPath?: string | null
  onOpenManualEditor: (jobPath?: string) => void
  onNavigateTransform: (jobPath?: string | null) => void
  onNavigateCalibration: () => void
  onOpenSourceFolder: () => Promise<void>
  onOpenSetup?: () => void
  onActiveJobChange?: (jobPath: string | null) => void
}

interface PreviewBundle {
  before: string
  after: string
  outName: string
  diffText: string
  notes: string[]
}

const INTENT_OPTIONS: { id: WizardIntent; label: string; needsGate: boolean }[] = [
  { id: "rename", label: "Rename //NAME", needsGate: false },
  { id: "duplicate", label: "Duplicate as new name", needsGate: false },
  { id: "frameMove", label: "Frame move (PULSE→USER)", needsGate: true },
  { id: "mirror", label: "Mirror (via Transform)", needsGate: true },
  { id: "offset", label: "Offset (via Transform)", needsGate: true },
  { id: "speed", label: "Speed (travel V/VJ + weld V=)", needsGate: false },
  { id: "weld", label: "Weld ASF# / AEF# / WEV#", needsGate: false },
  { id: "findReplace", label: "Find / replace", needsGate: false },
  { id: "manual", label: "Manual editing", needsGate: false }
]

const STEPS: WizardStep[] = ["select", "intent", "params", "preview", "write"]

const buttonClass = "btn-secondary"
const primaryClass = "btn-primary"
const inputClass = "input-field font-mono text-sm"

const stepLabel = (step: WizardStep): string => {
  if (step === "select") return "Select job"
  if (step === "intent") return "Choose intent"
  if (step === "params") return "Parameters"
  if (step === "preview") return "Preview diff"
  return "Write output"
}

export const WizardPage = ({
  sourceFolder,
  outputFolder,
  jobs,
  initialJobPath = null,
  onOpenManualEditor,
  onNavigateTransform,
  onNavigateCalibration,
  onOpenSourceFolder,
  onOpenSetup,
  onActiveJobChange
}: WizardPageProps) => {
  const [step, setStep] = useState<WizardStep>("select")
  const [selectedPath, setSelectedPath] = useState<string | null>(initialJobPath)
  const [filter, setFilter] = useState("")
  const [intent, setIntent] = useState<WizardIntent | null>(null)
  const [newName, setNewName] = useState("")
  const [sourceFrameId, setSourceFrameId] = useState(2)
  const [targetFrameId, setTargetFrameId] = useState(3)
  const [speedKind, setSpeedKind] = useState<SpeedKind>("V")
  const [speedMode, setSpeedMode] = useState<"set" | "scale">("scale")
  const [speedValue, setSpeedValue] = useState("50")
  const [speedScale, setSpeedScale] = useState("0.5")
  const [speedScope, setSpeedScope] = useState<SpeedScope>("all")
  const [weldKind, setWeldKind] = useState<WeldKind>("ASF")
  const [weldNumber, setWeldNumber] = useState("9")
  const [findText, setFindText] = useState("")
  const [replaceText, setReplaceText] = useState("")
  const [preview, setPreview] = useState<PreviewBundle | null>(null)
  const [dryRun, setDryRun] = useState(true)
  const [status, setStatus] = useState(
    "Select a job from Loaded Jobs, or jump to Manual Editor anytime."
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!initialJobPath) {
      return
    }
    setSelectedPath(initialJobPath)
    onActiveJobChange?.(initialJobPath)
    const job = jobs.find((entry) => entry.path === initialJobPath)
    if (job) {
      setNewName(job.name.replace(/\.JBI$/i, ""))
      setStatus(`Selected ${job.name} from Loaded Jobs. Choose an edit intent.`)
      setStep("intent")
    }
  }, [initialJobPath, jobs])

  const gate = getCalibrationGate()
  const writeGate = getEditWriteGate()
  const installGate = getRobotInstallGate()
  const geometryBlocked = !installGate.allowed || !gate.allowed

  const filteredJobs = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) {
      return jobs
    }
    return jobs.filter(
      (job) =>
        job.name.toLowerCase().includes(q) ||
        job.relativePath.toLowerCase().includes(q)
    )
  }, [jobs, filter])

  const selectedJob = jobs.find((job) => job.path === selectedPath) ?? null

  const handleManual = () => {
    onOpenManualEditor(selectedPath ?? undefined)
  }

  const handleSelectJob = (path: string) => {
    setSelectedPath(path)
    onActiveJobChange?.(path)
    const job = jobs.find((entry) => entry.path === path)
    if (job) {
      setNewName(job.name.replace(/\.JBI$/i, ""))
    }
    setPreview(null)
  }

  const handleChooseIntent = (next: WizardIntent) => {
    setIntent(next)
    setPreview(null)
    if (next === "manual") {
      onOpenManualEditor(selectedPath ?? undefined)
      return
    }
    if (next === "mirror" || next === "offset") {
      onActiveJobChange?.(selectedPath)
      setStatus(
        `${next === "mirror" ? "Mirror" : "Offset"} uses the Transform page. Passing the current job into Transform.`
      )
      onNavigateTransform(selectedPath)
      return
    }
    setStep("params")
  }

  const buildPreview = async (): Promise<PreviewBundle> => {
    if (!selectedPath || !intent) {
      throw new Error("Select a job and an intent first.")
    }
    const before = await readTextFile(selectedPath)
    const baseName = selectedJob?.name.replace(/\.JBI$/i, "") ?? "JOB"
    const notes: string[] = []

    if (intent === "rename") {
      if (!newName.trim()) {
        throw new Error("Enter a new job name.")
      }
      const after = renameJobText(before, newName.trim())
      const outName = `${newName.trim()}.JBI`
      return {
        before,
        after,
        outName,
        diffText: unifiedDiff(before, after, selectedPath, outName),
        notes: ["Rename changes //NAME only in this file."]
      }
    }

    if (intent === "duplicate") {
      if (!newName.trim()) {
        throw new Error("Enter a name for the duplicate.")
      }
      const after = renameJobText(before, newName.trim())
      const outName = `${newName.trim()}.JBI`
      return {
        before,
        after,
        outName,
        diffText: unifiedDiff(before, after, selectedPath, outName),
        notes: ["Duplicate writes a new file under the output folder — source stays untouched."]
      }
    }

    if (intent === "frameMove") {
      if (!installGate.allowed) {
        throw new Error(installGate.reason)
      }
      if (!gate.allowed) {
        throw new Error(gate.reason)
      }
      const result = await previewFrameMove({
        originalText: before,
        sourceFrameId,
        targetFrameId,
        sourceLabel: selectedPath
      })
      notes.push(`Converted ${result.poseCount} PULSE poses to ///USER ${targetFrameId}.`)
      return {
        before: result.before,
        after: result.after,
        outName: result.outName,
        diffText: result.diffText,
        notes
      }
    }

    if (intent === "speed") {
      const job = parseJob(before)
      if (speedMode === "set") {
        const value = Number.parseFloat(speedValue)
        if (!Number.isFinite(value) || value < 0) {
          throw new Error("Enter a valid non-negative speed value.")
        }
        const result = setSpeeds(job, [], speedKind, value, speedScope)
        const after = serializeJob(result.job)
        notes.push(
          `Set ${speedKind}=${value} on ${result.changes} line(s) (scope: ${speedScope}). VJ= only on MOVJ; V= only on MOVL/MOVC/SMOVL.`
        )
        if (speedScope === "weld") {
          notes.push("Weld scope: only motion lines between ARCON and ARCOF.")
        }
        if (speedScope === "travel") {
          notes.push("Travel scope: motion lines outside ARCON/ARCOF segments.")
        }
        const outName = `${baseName}_SPEED.JBI`
        return {
          before,
          after,
          outName,
          diffText: unifiedDiff(before, after, selectedPath, outName),
          notes
        }
      }
      const factor = Number.parseFloat(speedScale)
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error("Enter a positive scale factor.")
      }
      const result = scaleSpeeds(job, [], speedKind, factor, speedScope)
      const after = serializeJob(result.job)
      notes.push(
        `Scaled ${speedKind} by ${factor} on ${result.changes} line(s) (scope: ${speedScope}).`
      )
      const outName = `${baseName}_SPEED.JBI`
      return {
        before,
        after,
        outName,
        diffText: unifiedDiff(before, after, selectedPath, outName),
        notes
      }
    }

    if (intent === "weld") {
      const n = Number.parseInt(weldNumber, 10)
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("Enter a valid weld condition number.")
      }
      const job = parseJob(before)
      const result = setWeldConditions(job, [], weldKind, n)
      const after = serializeJob(result.job)
      notes.push(`Set ${weldKind}#(${n}) on ${result.changes} matching line(s).`)
      notes.push("Validate against ARCSRT/ARCEND/WEAV.CND on the Editor page if needed.")
      const outName = `${baseName}_WELD.JBI`
      return {
        before,
        after,
        outName,
        diffText: unifiedDiff(before, after, selectedPath, outName),
        notes
      }
    }

    if (intent === "findReplace") {
      if (!findText) {
        throw new Error("Enter find text.")
      }
      const after = before.split(findText).join(replaceText)
      const outName = `${baseName}_EDIT.JBI`
      notes.push("Find/replace is literal text — review the diff carefully.")
      return {
        before,
        after,
        outName,
        diffText: unifiedDiff(before, after, selectedPath, outName),
        notes
      }
    }

    throw new Error("Unsupported intent for wizard preview.")
  }

  const handleBuildPreview = async () => {
    setBusy(true)
    try {
      const bundle = await buildPreview()
      setPreview(bundle)
      setStep("preview")
      setStatus("Diff ready — review before writing.")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const issues = useMemo((): ValidationIssue[] => {
    const list: ValidationIssue[] = []
    if (!preview) {
      return list
    }
    if (!preview.after.trim()) {
      list.push({ severity: "warning", message: "After buffer is empty." })
    }
    if (preview.before === preview.after) {
      list.push({ severity: "info", message: "No textual changes." })
    }
    if (!outputFolder) {
      list.push({ severity: "error", message: "Output folder is not set — choose one in the header or Setup Guide." })
    }
    if (!writeGate.allowed) {
      list.push({ severity: "error", message: writeGate.reason })
    }
    if (!dryRun) {
      list.push({
        severity: "warning",
        message: "Dry-run is off — Write will create a new file under the output folder (never in-place)."
      })
    }
    return list
  }, [preview, outputFolder, dryRun, writeGate.allowed, writeGate.reason])

  const handleWrite = async () => {
    if (!preview) {
      setStatus("Build a preview first.")
      return
    }
    if (dryRun) {
      setStatus("Dry-run: diff and validation only — no file written.")
      setStep("write")
      return
    }
    if (!writeGate.allowed) {
      setStatus(writeGate.reason)
      return
    }
    if (!outputFolder) {
      setStatus("Set an output folder before writing.")
      return
    }
    setBusy(true)
    try {
      const written = await writeOutputFile(preview.outName, preview.after)
      setStatus(`Wrote ${written}`)
      setStep("write")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleRestart = () => {
    setStep("select")
    setIntent(null)
    setPreview(null)
    setStatus("Select a job from Loaded Jobs, or jump to Manual Editor anytime.")
  }

  const stepIndex = STEPS.indexOf(step)

  return (
    <section className="flex h-full flex-col gap-4 overflow-auto p-6" aria-label="Job editing wizard">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Job Editing Wizard</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Guided edit session with a mandatory diff preview. Position transforms stay behind the
            calibration gate. Jump to Manual Editor at any time.
          </p>
        </div>
        <button
          type="button"
          aria-label="Open manual editor"
          onClick={handleManual}
          className={primaryClass}
        >
          Manual editing
        </button>
      </header>

      <ol className="flex flex-wrap gap-2" aria-label="Wizard steps">
        {STEPS.map((id, index) => {
          const active = id === step
          const done = index < stepIndex
          return (
            <li key={id}>
              <span
                className={
                  active
                    ? "rounded border border-accent/60 bg-accent/15 px-2.5 py-1 text-xs text-accent-fg"
                    : done
                      ? "rounded border border-success/40 bg-success/10 px-2.5 py-1 text-xs text-success"
                      : "rounded border border-border-strong px-2.5 py-1 text-xs text-muted-2"
                }
              >
                {index + 1}. {stepLabel(id)}
              </span>
            </li>
          )
        })}
      </ol>

      {!sourceFolder || jobs.length === 0 ? (
        <div className="rounded border border-border bg-bg/50 p-4">
          <p className="text-sm text-muted">
            Open a source folder on Loaded Jobs / Setup Guide first so jobs are available here.
          </p>
          <button
            type="button"
            aria-label="Open source folder"
            onClick={() => void onOpenSourceFolder()}
            className={`mt-3 ${primaryClass}`}
          >
            Choose source folder
          </button>
        </div>
      ) : null}

      {step === "select" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-fg/80">
            Filter jobs
            <input
              aria-label="Filter jobs"
              className={inputClass}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Name or relative path"
            />
          </label>
          <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-bg/60">
            <ul aria-label="Job list for wizard">
              {filteredJobs.map((job) => {
                const active = job.path === selectedPath
                return (
                  <li key={job.path} className="border-b border-border/60">
                    <button
                      type="button"
                      aria-label={`Select job ${job.name}`}
                      aria-pressed={active}
                      onClick={() => handleSelectJob(job.path)}
                      className={
                        active
                          ? "flex w-full flex-col gap-0.5 bg-accent/15 px-3 py-2 text-left"
                          : "flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface"
                      }
                    >
                      <span className="font-mono text-sm text-fg">{job.name}</span>
                      <span className="font-mono text-[11px] text-muted-2">{job.relativePath}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="Continue to intent"
              disabled={!selectedPath}
              onClick={() => setStep("intent")}
              className={primaryClass}
            >
              Next: choose intent
            </button>
            <button type="button" aria-label="Open manual editor now" onClick={handleManual} className={buttonClass}>
              Manual editing instead
            </button>
          </div>
        </div>
      ) : null}

      {step === "intent" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Selected:{" "}
            <span className="font-mono text-fg/90">{selectedJob?.name ?? "—"}</span>
          </p>
          {!installGate.allowed ? (
            <p className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent-fg">
              {installGate.reason} Text edits (rename, speed, weld) stay available.
              {onOpenSetup ? (
                <button
                  type="button"
                  aria-label="Complete robot install from wizard"
                  onClick={onOpenSetup}
                  className="ml-2 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  Complete robot install
                </button>
              ) : null}
            </p>
          ) : !gate.allowed ? (
            <p className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent-fg">
              Calibration gate closed — frame/mirror/offset intents are blocked until residuals pass.
              <button
                type="button"
                aria-label="Open calibration from wizard"
                onClick={onNavigateCalibration}
                className="ml-2 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              >
                Open Calibration
              </button>
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {INTENT_OPTIONS.map((option) => {
              const blocked = option.needsGate && geometryBlocked
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-label={option.label}
                  disabled={blocked}
                  onClick={() => handleChooseIntent(option.id)}
                  className={
                    blocked
                      ? "rounded border border-border px-3 py-3 text-left text-sm text-muted-2"
                      : "rounded border border-border-strong px-3 py-3 text-left text-sm text-fg/90 hover:border-accent/50 hover:bg-accent/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                  }
                >
                  {option.label}
                  {option.needsGate ? (
                    <span className="mt-1 block text-[11px] text-muted-2">
                      Requires robot profile + calibration
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <button type="button" aria-label="Back to job select" onClick={() => setStep("select")} className={buttonClass}>
            Back
          </button>
        </div>
      ) : null}

      {step === "params" ? (
        <div className="flex flex-col gap-4 rounded border border-border bg-bg/50 p-4">
          <h2 className="text-sm font-medium text-fg/90">
            Parameters — {INTENT_OPTIONS.find((item) => item.id === intent)?.label ?? intent}
          </h2>

          {intent === "rename" || intent === "duplicate" ? (
            <label className="flex flex-col gap-1 text-sm text-fg/80">
              New job name
              <input
                aria-label="New job name"
                className={inputClass}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
          ) : null}

          {intent === "frameMove" ? (
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm text-fg/80">
                Source UF#
                <input
                  type="number"
                  aria-label="Source user frame"
                  className={`w-24 ${inputClass}`}
                  value={sourceFrameId}
                  onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-fg/80">
                Target UF#
                <input
                  type="number"
                  aria-label="Target user frame"
                  className={`w-24 ${inputClass}`}
                  value={targetFrameId}
                  onChange={(event) => setTargetFrameId(Number.parseInt(event.target.value, 10) || 3)}
                />
              </label>
            </div>
          ) : null}

          {intent === "speed" ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted">
                Rules: <span className="font-mono">VJ=</span> only on{" "}
                <span className="font-mono">MOVJ</span>; <span className="font-mono">V=</span> only
                on <span className="font-mono">MOVL</span> / <span className="font-mono">MOVC</span>{" "}
                / <span className="font-mono">SMOVL</span>. Weld scope edits{" "}
                <span className="font-mono">V=</span> between ARCON and ARCOF only.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm text-fg/80">
                  Kind
                  <select
                    aria-label="Speed kind"
                    className={inputClass}
                    value={speedKind}
                    onChange={(event) => {
                      const next = event.target.value as SpeedKind
                      setSpeedKind(next)
                      if (next === "VJ" && speedScope === "weld") {
                        setSpeedScope("travel")
                      }
                    }}
                  >
                    <option value="V">V= (linear)</option>
                    <option value="VJ">VJ= (joint)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-fg/80">
                  Scope
                  <select
                    aria-label="Speed scope"
                    className={inputClass}
                    value={speedScope}
                    onChange={(event) => setSpeedScope(event.target.value as SpeedScope)}
                  >
                    <option value="all">All matching motions</option>
                    <option value="weld" disabled={speedKind === "VJ"}>
                      Weld speed (ARCON…ARCOF)
                    </option>
                    <option value="travel">Travel speed (outside weld)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-fg/80">
                  Mode
                  <select
                    aria-label="Speed mode"
                    className={inputClass}
                    value={speedMode}
                    onChange={(event) => setSpeedMode(event.target.value as "set" | "scale")}
                  >
                    <option value="scale">Scale</option>
                    <option value="set">Set absolute</option>
                  </select>
                </label>
                {speedMode === "set" ? (
                  <label className="flex flex-col gap-1 text-sm text-fg/80">
                    Value
                    <input
                      aria-label="Speed value"
                      className={inputClass}
                      value={speedValue}
                      onChange={(event) => setSpeedValue(event.target.value)}
                    />
                  </label>
                ) : (
                  <label className="flex flex-col gap-1 text-sm text-fg/80">
                    Scale factor
                    <input
                      aria-label="Speed scale"
                      className={inputClass}
                      value={speedScale}
                      onChange={(event) => setSpeedScale(event.target.value)}
                    />
                  </label>
                )}
              </div>
            </div>
          ) : null}

          {intent === "weld" ? (
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm text-fg/80">
                Kind
                <select
                  aria-label="Weld kind"
                  className={inputClass}
                  value={weldKind}
                  onChange={(event) => setWeldKind(event.target.value as WeldKind)}
                >
                  <option value="ASF">ASF#</option>
                  <option value="AEF">AEF#</option>
                  <option value="WEV">WEV#</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-fg/80">
                Condition #
                <input
                  aria-label="Weld number"
                  className={inputClass}
                  value={weldNumber}
                  onChange={(event) => setWeldNumber(event.target.value)}
                />
              </label>
            </div>
          ) : null}

          {intent === "findReplace" ? (
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm text-fg/80">
                Find
                <input
                  aria-label="Find text"
                  className={inputClass}
                  value={findText}
                  onChange={(event) => setFindText(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-fg/80">
                Replace
                <input
                  aria-label="Replace text"
                  className={inputClass}
                  value={replaceText}
                  onChange={(event) => setReplaceText(event.target.value)}
                />
              </label>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-label="Build diff preview"
              disabled={busy}
              onClick={() => void handleBuildPreview()}
              className={primaryClass}
            >
              {busy ? "Building…" : "Preview diff"}
            </button>
            <button type="button" aria-label="Back to intent" onClick={() => setStep("intent")} className={buttonClass}>
              Back
            </button>
            <button type="button" aria-label="Open manual editor" onClick={handleManual} className={buttonClass}>
              Manual editing
            </button>
          </div>
        </div>
      ) : null}

      {step === "preview" || step === "write" ? (
        <div className="flex flex-col gap-3">
          {preview ? (
            <>
              <p className="font-mono text-xs text-muted-2">Output name: {preview.outName}</p>
              {preview.notes.map((note) => (
                <p key={note} className="text-sm text-muted">
                  {note}
                </p>
              ))}
              <pre className="max-h-72 overflow-auto rounded border border-border bg-bg/80 p-3 text-xs text-fg/80">
                {preview.diffText || "(empty diff)"}
              </pre>
              <pre className="text-xs text-muted">{buildValidationReport(issues)}</pre>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-fg/80">
                  <input
                    type="checkbox"
                    aria-label="Dry run mode"
                    checked={dryRun}
                    onChange={(event) => setDryRun(event.target.checked)}
                  />
                  Dry-run
                </label>
                <button
                  type="button"
                  aria-label="Write or dry-run check"
                  disabled={busy || (!dryRun && !writeGate.allowed)}
                  onClick={() => void handleWrite()}
                  className={primaryClass}
                >
                  {dryRun ? "Dry-run check" : "Write to output folder"}
                </button>
                <button
                  type="button"
                  aria-label="Back to parameters"
                  onClick={() => setStep("params")}
                  className={buttonClass}
                >
                  Back
                </button>
                <button type="button" aria-label="Start another edit" onClick={handleRestart} className={buttonClass}>
                  Start over
                </button>
                <button type="button" aria-label="Open manual editor" onClick={handleManual} className={buttonClass}>
                  Manual editing
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-2">No preview yet.</p>
          )}
        </div>
      ) : null}

      <p className="text-sm text-fg/80" role="status">
        {status}
        {outputFolder ? ` · out: ${outputFolder}` : " · output folder not set"}
      </p>
    </section>
  )
}
