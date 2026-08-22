import { useMemo, useState } from "react"
import { getEditWriteGate } from "../calibration"
import { UsbExportPanel } from "../export/UsbExportPanel"
import { unifiedDiff, buildValidationReport, type ValidationIssue } from "../../lib/jbi/diff"
import { writeOutputFile } from "../../lib/fs/desktop"

interface DiffPageProps {
  outputFolder?: string | null
}

export const DiffPage = ({ outputFolder = null }: DiffPageProps) => {
  const [before, setBefore] = useState("")
  const [after, setAfter] = useState("")
  const [outName, setOutName] = useState("PREVIEW.JBI")
  const [dryRun, setDryRun] = useState(true)
  const [status, setStatus] = useState(
    "Paste before/after text, preview diff, then write to the output folder only."
  )

  const writeGate = getEditWriteGate()

  const diffText = useMemo(() => {
    if (!before && !after) {
      return ""
    }
    return unifiedDiff(before, after, "source", outName)
  }, [before, after, outName])

  const issues = useMemo((): ValidationIssue[] => {
    const list: ValidationIssue[] = []
    if (!after.trim()) {
      list.push({ severity: "warning", message: "After buffer is empty." })
    }
    if (before === after && before.length > 0) {
      list.push({ severity: "info", message: "No textual changes." })
    }
    if (!writeGate.allowed) {
      list.push({
        severity: "error",
        message: writeGate.reason
      })
    }
    if (!dryRun) {
      list.push({
        severity: "warning",
        message: "Dry-run is off — Write will create a new file under the output folder (never in-place)."
      })
    }
    return list
  }, [before, after, dryRun, writeGate.allowed, writeGate.reason])

  const handleWrite = async () => {
    if (!after.trim()) {
      setStatus("Nothing to write.")
      return
    }
    if (dryRun) {
      setStatus("Dry-run: diff and validation only — no file written.")
      return
    }
    if (!writeGate.allowed) {
      setStatus(writeGate.reason)
      return
    }
    try {
      const written = await writeOutputFile(outName, after)
      setStatus(`Wrote ${written}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="flex h-full flex-col gap-4 overflow-auto p-6" aria-label="Diff preview">
      <header>
        <h1 className="text-lg font-semibold text-fg">Diff & safety</h1>
        <p className="mt-1 text-sm text-muted">
          Source folder stays read-only. Writes go only to the chosen output folder, after a
          mandatory unified diff preview. Job writes require calibration open for the active robot.
        </p>
      </header>

      {!writeGate.allowed ? (
        <p className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" role="status">
          {writeGate.reason}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-fg/80">
          Before
          <textarea
            aria-label="Before text"
            className="min-h-[20rem] rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            value={before}
            onChange={(event) => setBefore(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-fg/80">
          After
          <textarea
            aria-label="After text"
            className="min-h-[20rem] rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            value={after}
            onChange={(event) => setAfter(event.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-fg/80">
          Output file name
          <input
            aria-label="Output file name"
            className="rounded border border-border-strong bg-bg px-2 py-1.5 font-mono text-sm"
            value={outName}
            onChange={(event) => setOutName(event.target.value)}
          />
        </label>
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
          aria-label="Write output file"
          onClick={() => void handleWrite()}
          disabled={!writeGate.allowed && !dryRun}
          className="btn-primary"
        >
          {dryRun ? "Dry-run check" : "Write to output folder"}
        </button>
      </div>

      <pre className="text-xs text-muted" role="status">
        {status}
        {"\n"}
        {buildValidationReport(issues)}
      </pre>

      {diffText ? (
        <pre className="min-h-[20rem] max-h-[36rem] overflow-auto rounded border border-border bg-bg/80 p-3 text-xs text-fg/80">
          {diffText}
        </pre>
      ) : null}

      <UsbExportPanel
        outputFolder={outputFolder}
        disabled={!writeGate.allowed}
        disabledReason={
          writeGate.allowed
            ? undefined
            : "USB export of edited jobs requires calibration open for the active profile."
        }
      />
    </section>
  )
}
