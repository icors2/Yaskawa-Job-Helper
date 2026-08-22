import { useEffect, useMemo, useState } from "react"
import { parseJob, nposMismatch } from "../../lib/jbi/parse"
import { serializeJob } from "../../lib/jbi/serialize"
import { renameJobText, rewriteReferencesInText } from "../../lib/jbi/library"
import { readTextFile } from "../../lib/fs/desktop"
import { joinPath } from "../../lib/fs/paths"
import { unifiedDiff } from "../../lib/jbi/diff"
import { buildWeldInventory, type WeldConditionInventory, type WeldKind } from "../../lib/jbi/cnd"
import {
  deleteInstLines,
  flagInvalidWeldConditions,
  findUnreferencedPositions,
  insertInstLine,
  reorderInstLines,
  scaleSpeeds,
  setSpeeds,
  setWeldConditions,
  type SpeedKind,
  type SpeedScope
} from "../../lib/jbi/edit"

interface EditorPageProps {
  sourceFolder?: string | null
  initialPath?: string | null
  onActiveJobChange?: (path: string | null) => void
  onNavigateTransform?: (jobPath?: string | null) => void
}

const toggleIndex = (selected: number[], index: number): number[] => {
  if (selected.includes(index)) {
    return selected.filter((value) => value !== index)
  }
  return [...selected, index].sort((a, b) => a - b)
}

export const EditorPage = ({
  sourceFolder = null,
  initialPath = null,
  onActiveJobChange,
  onNavigateTransform
}: EditorPageProps) => {
  const [path, setPath] = useState(initialPath ?? "")
  const [text, setText] = useState("")
  const [originalText, setOriginalText] = useState("")
  const [renameTo, setRenameTo] = useState("")
  const [findText, setFindText] = useState("")
  const [replaceText, setReplaceText] = useState("")
  const [status, setStatus] = useState("Open a job path to inspect instructions and run safe edits.")
  const [diffText, setDiffText] = useState("")
  const [selected, setSelected] = useState<number[]>([])
  const [insertRaw, setInsertRaw] = useState("MOVL C00000 V=100.0")
  const [speedKind, setSpeedKind] = useState<SpeedKind | "both">("V")
  const [speedValue, setSpeedValue] = useState("50.00")
  const [speedScale, setSpeedScale] = useState("0.5")
  const [speedScope, setSpeedScope] = useState<SpeedScope>("all")
  const [weldKind, setWeldKind] = useState<WeldKind>("ASF")
  const [weldNumber, setWeldNumber] = useState("9")
  const [inventory, setInventory] = useState<WeldConditionInventory | null>(null)
  const [weldFlags, setWeldFlags] = useState<string[]>([])

  useEffect(() => {
    if (!initialPath) {
      return
    }
    setPath(initialPath)
    onActiveJobChange?.(initialPath)
    const handleAutoLoad = async () => {
      try {
        const loaded = await readTextFile(initialPath)
        const parsed = parseJob(loaded)
        const mismatch = nposMismatch(parsed)
        setText(loaded)
        setOriginalText(loaded)
        setRenameTo(parsed.name)
        setSelected([])
        setDiffText("")
        setWeldFlags([])
        setStatus(
          mismatch
            ? `Loaded ${parsed.name} — ${mismatch}`
            : `Loaded ${parsed.name} (${parsed.instLines.length} inst lines, ${parsed.posGroups.length} pos groups)`
        )
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }
    void handleAutoLoad()
  }, [initialPath])

  const job = useMemo(() => {
    if (!text.trim()) {
      return null
    }
    try {
      return parseJob(text)
    } catch {
      return null
    }
  }, [text])

  const applyEdited = (nextText: string, message: string) => {
    const before = originalText || text
    setDiffText(unifiedDiff(before, nextText, "before", "after"))
    setText(nextText)
    setStatus(message)
  }

  const handleLoad = async () => {
    try {
      const loaded = await readTextFile(path)
      const parsed = parseJob(loaded)
      const mismatch = nposMismatch(parsed)
      setText(loaded)
      setOriginalText(loaded)
      setRenameTo(parsed.name)
      setSelected([])
      setDiffText("")
      setWeldFlags([])
      onActiveJobChange?.(path)
      setStatus(
        mismatch
          ? `Loaded ${parsed.name} — ${mismatch}`
          : `Loaded ${parsed.name} (${parsed.instLines.length} inst lines, ${parsed.posGroups.length} pos groups)`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleLoadCnd = async () => {
    if (!sourceFolder) {
      setStatus("Open a source folder first (Loaded Jobs) so ARCSRT/ARCEND/WEAV.CND can be loaded.")
      return
    }
    try {
      const [arcsrt, arcend, weav] = await Promise.all([
        readTextFile(joinPath(sourceFolder, "ARCSRT.CND")),
        readTextFile(joinPath(sourceFolder, "ARCEND.CND")),
        readTextFile(joinPath(sourceFolder, "WEAV.CND"))
      ])
      const next = buildWeldInventory({ arcsrt, arcend, weav })
      setInventory(next)
      setStatus(
        `Loaded CND inventory: ASF ${next.asf.size}, AEF ${next.aef.size}, WEV ${next.wev.size}`
      )
      if (job) {
        setWeldFlags(flagInvalidWeldConditions(job, next))
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleRename = () => {
    if (!text || !renameTo.trim()) {
      return
    }
    const next = renameJobText(text, renameTo.trim())
    applyEdited(next, `Renamed job header to ${renameTo.trim()} (preview in diff).`)
  }

  const handleDuplicate = () => {
    if (!text || !renameTo.trim()) {
      return
    }
    const next = renameJobText(text, renameTo.trim())
    setDiffText(unifiedDiff(originalText || text, next, "source", `${renameTo.trim()}.JBI`))
    setText(next)
    setStatus(
      `Duplicated as ${renameTo.trim()} in the editor buffer — write via Diff page to the output folder.`
    )
  }

  const handleFolderAssign = () => {
    if (!text) {
      return
    }
    const folder = window.prompt("///FOLDERNAME value (blank to remove)", "")
    if (folder === null) {
      return
    }
    const parsed = parseJob(text)
    const existing = parsed.headers.findIndex((header) => header.key === "FOLDERNAME")
    if (!folder.trim()) {
      if (existing >= 0) {
        parsed.headers.splice(existing, 1)
      }
    } else if (existing >= 0) {
      parsed.headers[existing].value = folder.trim()
      parsed.headers[existing].raw = `///FOLDERNAME ${folder.trim()}`
    } else {
      const nameIndex = parsed.headers.findIndex((header) => header.key === "NAME")
      parsed.headers.splice(nameIndex + 1, 0, {
        key: "FOLDERNAME",
        value: folder.trim(),
        raw: `///FOLDERNAME ${folder.trim()}`
      })
    }
    applyEdited(
      serializeJob(parsed),
      folder.trim() ? `Set ///FOLDERNAME ${folder.trim()}` : "Removed ///FOLDERNAME"
    )
  }

  const handleRewriteRefs = () => {
    if (!text || !renameTo.trim()) {
      return
    }
    const parsed = parseJob(text)
    const result = rewriteReferencesInText(text, parsed.name, renameTo.trim())
    applyEdited(
      result.text,
      `Rewrote ${result.changes} CALL/PSTART references toward ${renameTo.trim()}.`
    )
  }

  const handleFindReplace = () => {
    if (!findText) {
      return
    }
    const next = text.split(findText).join(replaceText)
    applyEdited(next, "Find/replace applied (always previewed in diff).")
  }

  const handleRoundTripCheck = () => {
    try {
      const parsed = parseJob(text)
      const again = serializeJob(parsed)
      const ok = again === text || again === text.replace(/\n/g, "\r\n")
      setStatus(ok ? "In-memory round-trip matches." : "Round-trip diverged — inspect diff.")
      setDiffText(unifiedDiff(text, again, "original", "serialized"))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const handleInsertLine = () => {
    if (!job || !insertRaw.trim()) {
      return
    }
    const at = selected.length > 0 ? Math.min(...selected) : job.instLines.length
    const nextJob = insertInstLine(job, at, insertRaw)
    setSelected([at])
    applyEdited(serializeJob(nextJob), `Inserted instruction at line ${at}.`)
  }

  const handleDeleteLines = () => {
    if (!job || selected.length === 0) {
      setStatus("Select one or more instruction lines to delete.")
      return
    }
    const result = deleteInstLines(job, selected)
    setSelected([])
    const orphanNote =
      result.unreferenced.length > 0
        ? ` Unreferenced positions (kept): ${result.unreferenced.join(", ")}.`
        : ""
    applyEdited(
      serializeJob(result.job),
      `Deleted ${result.removed} line(s).${orphanNote}`
    )
  }

  const handleMove = (direction: "up" | "down") => {
    if (!job || selected.length !== 1) {
      setStatus("Select exactly one line to reorder.")
      return
    }
    const from = selected[0]
    const nextJob = reorderInstLines(job, from, direction)
    if (!nextJob) {
      setStatus("Cannot move that line further.")
      return
    }
    const nextIndex = direction === "up" ? from - 1 : from + 1
    setSelected([nextIndex])
    applyEdited(serializeJob(nextJob), `Moved line ${from} ${direction}.`)
  }

  const handleSetSpeed = () => {
    if (!job) {
      return
    }
    const value = Number.parseFloat(speedValue)
    if (!Number.isFinite(value) || value < 0) {
      setStatus("Enter a valid non-negative speed value.")
      return
    }
    if (speedKind === "both") {
      setStatus("Pick V= or VJ= to set an absolute value (use Scale for both).")
      return
    }
    const result = setSpeeds(job, selected, speedKind, value, speedScope)
    applyEdited(
      serializeJob(result.job),
      `Set ${speedKind}=${value} on ${result.changes} line(s)${selected.length === 0 ? " (all in scope)" : ""} [${speedScope}]. VJ=→MOVJ only; V=→MOVL/MOVC/SMOVL only.`
    )
  }

  const handleScaleSpeed = () => {
    if (!job) {
      return
    }
    const factor = Number.parseFloat(speedScale)
    if (!Number.isFinite(factor) || factor <= 0) {
      setStatus("Enter a positive scale factor.")
      return
    }
    const result = scaleSpeeds(job, selected, speedKind, factor, speedScope)
    applyEdited(
      serializeJob(result.job),
      `Scaled ${speedKind} by ${factor} on ${result.changes} line(s)${selected.length === 0 ? " (all in scope)" : ""} [${speedScope}].`
    )
  }

  const handleSetWeld = () => {
    if (!job) {
      return
    }
    const n = Number.parseInt(weldNumber, 10)
    if (!Number.isFinite(n) || n < 0) {
      setStatus("Enter a valid weld condition number.")
      return
    }
    if (inventory) {
      const key = weldKind === "ASF" ? "asf" : weldKind === "AEF" ? "aef" : "wev"
      if (!inventory[key].has(n)) {
        setStatus(
          `${weldKind}#(${n}) is not present in the loaded CND inventory — fix the number or reload CND.`
        )
        return
      }
    }
    const result = setWeldConditions(job, selected, weldKind, n)
    const nextText = serializeJob(result.job)
    const flags = inventory
      ? flagInvalidWeldConditions(parseJob(nextText), inventory)
      : []
    setWeldFlags(flags)
    applyEdited(
      nextText,
      `Set ${weldKind}#(${n}) on ${result.changes} line(s)${selected.length === 0 ? " (all matching)" : ""}.`
    )
  }

  const handleValidateWeld = () => {
    if (!job) {
      return
    }
    if (!inventory) {
      setStatus("Load CND inventory first.")
      return
    }
    const flags = flagInvalidWeldConditions(job, inventory)
    setWeldFlags(flags)
    const orphans = findUnreferencedPositions(job)
    setStatus(
      flags.length === 0
        ? `All weld conditions valid.${orphans.length ? ` Unreferenced POS: ${orphans.join(", ")}.` : ""}`
        : `Found ${flags.length} invalid weld condition reference(s).`
    )
  }

  const handleSelectAll = () => {
    if (!job) {
      return
    }
    setSelected(job.instLines.map((_, i) => i))
  }

  const handleClearSelection = () => {
    setSelected([])
  }

  const buttonClass = "btn-secondary"
  const inputClass = "input-field font-mono text-sm"

  return (
    <section className="flex h-full flex-col gap-4 overflow-auto p-6" aria-label="Job editor">
      <header>
        <h1 className="text-lg font-semibold text-fg">Editor</h1>
        <p className="mt-1 text-sm text-muted">
          Rename, line edit, speed, and weld conditions — always diff-previewed. Write via Diff page
          to the output folder (never in-place).
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Job path"
          className={`min-w-80 flex-1 ${inputClass} text-xs`}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="C:\\…\\job.JBI"
        />
        <button
          type="button"
          aria-label="Load job"
          onClick={() => void handleLoad()}
          className="btn-primary"
        >
          Load
        </button>
        <button
          type="button"
          aria-label="Load weld CND files"
          onClick={() => void handleLoadCnd()}
          className={buttonClass}
        >
          Load CND
        </button>
        <button
          type="button"
          aria-label="Round-trip check"
          onClick={handleRoundTripCheck}
          className={buttonClass}
        >
          Round-trip check
        </button>
        {onNavigateTransform ? (
          <button
            type="button"
            aria-label="Open Transform with this job"
            onClick={() => {
              if (path) {
                onActiveJobChange?.(path)
              }
              onNavigateTransform(path || null)
            }}
            className={buttonClass}
          >
            Open in Transform
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Rename target"
          className={inputClass}
          value={renameTo}
          onChange={(event) => setRenameTo(event.target.value)}
        />
        <button type="button" aria-label="Rename job" onClick={handleRename} className={buttonClass}>
          Rename //NAME
        </button>
        <button
          type="button"
          aria-label="Duplicate job under new name"
          onClick={handleDuplicate}
          className={buttonClass}
        >
          Duplicate as name
        </button>
        <button
          type="button"
          aria-label="Assign folder name"
          onClick={handleFolderAssign}
          className={buttonClass}
        >
          Set ///FOLDERNAME
        </button>
        <button
          type="button"
          aria-label="Rewrite CALL references"
          onClick={handleRewriteRefs}
          className={buttonClass}
        >
          Rewrite CALL/PSTART in this file
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Find text"
          className={inputClass}
          value={findText}
          onChange={(event) => setFindText(event.target.value)}
          placeholder="Find"
        />
        <input
          aria-label="Replace text"
          className={inputClass}
          value={replaceText}
          onChange={(event) => setReplaceText(event.target.value)}
          placeholder="Replace"
        />
        <button
          type="button"
          aria-label="Apply find replace"
          onClick={handleFindReplace}
          className={buttonClass}
        >
          Find/replace
        </button>
      </div>

      <div className="rounded border border-border bg-bg/40 p-3">
        <h2 className="mb-2 text-sm font-medium text-fg/90">Instruction lines</h2>
        <div className="mb-2 flex flex-wrap gap-2">
          <input
            aria-label="New instruction text"
            className={`min-w-64 flex-1 ${inputClass} text-xs`}
            value={insertRaw}
            onChange={(event) => setInsertRaw(event.target.value)}
            placeholder="Instruction to insert"
          />
          <button
            type="button"
            aria-label="Insert instruction line"
            onClick={handleInsertLine}
            className={buttonClass}
          >
            Insert at selection
          </button>
          <button
            type="button"
            aria-label="Delete selected lines"
            onClick={handleDeleteLines}
            className={buttonClass}
          >
            Delete selected
          </button>
          <button
            type="button"
            aria-label="Move line up"
            onClick={() => handleMove("up")}
            className={buttonClass}
          >
            Move up
          </button>
          <button
            type="button"
            aria-label="Move line down"
            onClick={() => handleMove("down")}
            className={buttonClass}
          >
            Move down
          </button>
          <button
            type="button"
            aria-label="Select all instruction lines"
            onClick={handleSelectAll}
            className={buttonClass}
          >
            Select all
          </button>
          <button
            type="button"
            aria-label="Clear line selection"
            onClick={handleClearSelection}
            className={buttonClass}
          >
            Clear selection
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Speed kind
            <select
              aria-label="Speed kind"
              className={inputClass}
              value={speedKind}
              onChange={(event) => {
                const next = event.target.value as SpeedKind | "both"
                setSpeedKind(next)
                if (next === "VJ" && speedScope === "weld") {
                  setSpeedScope("travel")
                }
              }}
            >
              <option value="V">V= (linear)</option>
              <option value="VJ">VJ= (joint)</option>
              <option value="both">V= and VJ= (by motion type)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Scope
            <select
              aria-label="Speed scope"
              className={inputClass}
              value={speedScope}
              onChange={(event) => setSpeedScope(event.target.value as SpeedScope)}
            >
              <option value="all">All matching</option>
              <option value="weld" disabled={speedKind === "VJ"}>
                Weld (ARCON…ARCOF)
              </option>
              <option value="travel">Travel (outside weld)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Set value
            <input
              aria-label="Speed value"
              className={inputClass}
              value={speedValue}
              onChange={(event) => setSpeedValue(event.target.value)}
            />
          </label>
          <button
            type="button"
            aria-label="Set speed on selection"
            onClick={handleSetSpeed}
            className={buttonClass}
          >
            Set speed
          </button>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Scale factor
            <input
              aria-label="Speed scale factor"
              className={inputClass}
              value={speedScale}
              onChange={(event) => setSpeedScale(event.target.value)}
            />
          </label>
          <button
            type="button"
            aria-label="Scale speeds on selection"
            onClick={handleScaleSpeed}
            className={buttonClass}
          >
            Scale speeds
          </button>
          <p className="w-full text-[11px] text-muted">
            VJ= only on MOVJ; V= only on MOVL/MOVC/SMOVL. Illegal dual modifiers are stripped.
          </p>
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Weld kind
            <select
              aria-label="Weld condition kind"
              className={inputClass}
              value={weldKind}
              onChange={(event) => setWeldKind(event.target.value as WeldKind)}
            >
              <option value="ASF">ASF# (ARCSRT)</option>
              <option value="AEF">AEF# (ARCEND)</option>
              <option value="WEV">WEV# (WEAV)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Condition #
            <input
              aria-label="Weld condition number"
              className={inputClass}
              value={weldNumber}
              onChange={(event) => setWeldNumber(event.target.value)}
            />
          </label>
          <button
            type="button"
            aria-label="Set weld condition on selection"
            onClick={handleSetWeld}
            className={buttonClass}
          >
            Set weld condition
          </button>
          <button
            type="button"
            aria-label="Validate weld conditions"
            onClick={handleValidateWeld}
            className={buttonClass}
          >
            Validate vs CND
          </button>
        </div>

        {job ? (
          <ul
            className="max-h-56 overflow-auto rounded border border-border bg-bg/80 font-mono text-xs"
            aria-label="Instruction line list"
          >
            {job.instLines.map((line, index) => {
              const checked = selected.includes(index)
              return (
                <li key={`${index}-${line.raw}`}>
                  <label
                    className={`flex cursor-pointer gap-2 border-b border-border/60 px-2 py-1 ${
                      checked ? "bg-accent/15 text-accent-fg" : "text-fg/80"
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select instruction line ${index}`}
                      checked={checked}
                      onChange={() => setSelected(toggleIndex(selected, index))}
                      className="mt-0.5"
                    />
                    <span className="w-8 shrink-0 text-muted-2">{index}</span>
                    <span className="whitespace-pre-wrap break-all">{line.raw || " "}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-2">Load a job to list instruction lines.</p>
        )}
        <p className="mt-2 text-xs text-muted-2">
          Empty selection = apply speed/weld edits to all matching lines. Delete requires an
          explicit selection. Unreferenced //POS vars are reported, not auto-deleted.
        </p>
      </div>

      <p className="text-sm text-fg/80" role="status">
        {status}
      </p>

      {weldFlags.length > 0 ? (
        <pre
          className="max-h-32 overflow-auto rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger"
          aria-label="Invalid weld conditions"
        >
          {weldFlags.join("\n")}
        </pre>
      ) : null}

      <textarea
        aria-label="Job text"
        className="min-h-40 flex-1 rounded border border-border bg-bg/80 p-3 font-mono text-xs text-fg/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      {diffText ? (
        <pre className="max-h-48 overflow-auto rounded border border-border bg-bg/80 p-3 text-xs text-muted">
          {diffText}
        </pre>
      ) : null}
    </section>
  )
}
