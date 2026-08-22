import { useEffect, useState, type KeyboardEvent } from "react"
import type { JbiEntry } from "../../lib/fs/desktop"
import { readTextFile } from "../../lib/fs/desktop"
import { joinPath } from "../../lib/fs/paths"
import {
  indexLibraryFromTexts,
  type LibraryIndex
} from "../../lib/jbi/library"
import {
  getActiveProfile,
  loadProfilesStore,
  systemLineMatchesProfile
} from "../../lib/robot/profile"

interface LibraryPageProps {
  sourceFolder: string | null
  jobs: JbiEntry[]
  activeJobPath?: string | null
  onOpenFolder: () => Promise<void>
  onEditInWizard?: (jobPath: string) => void
  onEditInManualEditor?: (jobPath: string) => void
  onSelectJob?: (jobPath: string | null) => void
  onOpenTransform?: (jobPath: string) => void
}

type JobRow = {
  name: string
  path: string
  folderName?: string
  positionCount?: number
  postypes?: string[]
}

export const LibraryPage = ({
  sourceFolder,
  jobs,
  activeJobPath = null,
  onOpenFolder,
  onEditInWizard,
  onEditInManualEditor,
  onSelectJob,
  onOpenTransform
}: LibraryPageProps) => {
  const [index, setIndex] = useState<LibraryIndex | null>(null)
  const [status, setStatus] = useState("")
  const [profileWarning, setProfileWarning] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(activeJobPath)
  const [editPromptPath, setEditPromptPath] = useState<string | null>(null)

  useEffect(() => {
    if (activeJobPath) {
      setSelectedPath(activeJobPath)
    }
  }, [activeJobPath])

  useEffect(() => {
    const handleBuildIndex = async () => {
      if (!sourceFolder || jobs.length === 0) {
        setIndex(null)
        return
      }
      setStatus("Indexing CALL/PSTART graph…")
      try {
        const files = []
        for (const job of jobs.slice(0, 400)) {
          const text = await readTextFile(job.path)
          files.push({
            path: job.path,
            relativePath: job.relativePath,
            text
          })
        }
        const next = indexLibraryFromTexts(sourceFolder, files)
        setIndex(next)
        setStatus(
          `Indexed ${next.jobs.length} jobs, ${next.graph.length} CALL/PSTART edges` +
            (next.parseErrors.length ? `, ${next.parseErrors.length} parse errors` : "")
        )
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }
    void handleBuildIndex()
  }, [sourceFolder, jobs])

  useEffect(() => {
    const handleCheckSystem = async () => {
      const profile = getActiveProfile(loadProfilesStore())
      if (!sourceFolder || !profile) {
        setProfileWarning(null)
        return
      }
      try {
        const text = await readTextFile(joinPath(sourceFolder, "SYSTEM.SYS"))
        const robotLine =
          text
            .split(/\r?\n/)
            .find((line) => line.trim().startsWith("R1"))
            ?.trim() ?? ""
        if (robotLine && !systemLineMatchesProfile(robotLine, profile)) {
          setProfileWarning(
            `Source SYSTEM.SYS (${robotLine}) does not match active robot “${profile.displayName}” (${profile.robotModel || profile.robotId}). Switch profile or open the matching backup.`
          )
          return
        }
        setProfileWarning(null)
      } catch {
        setProfileWarning(null)
      }
    }
    void handleCheckSystem()
  }, [sourceFolder])

  const handleOpenFolder = () => {
    void onOpenFolder()
  }

  const handleSelectJob = (path: string) => {
    setSelectedPath(path)
    onSelectJob?.(path)
  }

  const handleJobDoubleClick = (path: string) => {
    setSelectedPath(path)
    onSelectJob?.(path)
    setEditPromptPath(path)
  }

  const handleEditInWizard = () => {
    if (!editPromptPath || !onEditInWizard) {
      return
    }
    const path = editPromptPath
    setEditPromptPath(null)
    onEditInWizard(path)
  }

  const handleEditInManualEditor = () => {
    if (!editPromptPath || !onEditInManualEditor) {
      return
    }
    const path = editPromptPath
    setEditPromptPath(null)
    onEditInManualEditor(path)
  }

  const handleCancelEditPrompt = () => {
    setEditPromptPath(null)
  }

  const handleEditPromptKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      handleCancelEditPrompt()
    }
  }

  const rows: JobRow[] =
    index?.jobs ??
    jobs.map((job) => ({
      name: job.name,
      path: job.path,
      folderName: undefined,
      positionCount: 0,
      postypes: [] as string[]
    }))

  const promptJobName =
    jobs.find((entry) => entry.path === editPromptPath)?.name ?? editPromptPath ?? ""

  return (
    <section className="flex h-full flex-col gap-4 p-6" aria-label="Loaded jobs">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-fg">Loaded Jobs</h1>
          <p className="mt-1 font-mono text-xs text-muted-2">
            {sourceFolder ?? "No source folder open"}
          </p>
          <p className="mt-1 text-xs text-muted">
            Single-click selects the active job (used by Transform). Double-click to choose Job
            Editing Wizard or Manual Editor.
          </p>
          {selectedPath ? (
            <p className="mt-1 text-xs text-accent-fg" role="status">
              Active job:{" "}
              <span className="font-mono">
                {jobs.find((j) => j.path === selectedPath)?.name ?? selectedPath}
              </span>
              {onOpenTransform ? (
                <>
                  {" "}
                  <button
                    type="button"
                    aria-label="Open Transform with selected job"
                    onClick={() => onOpenTransform(selectedPath)}
                    className="underline underline-offset-2 focus-ring"
                  >
                    Open in Transform
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          {status ? <p className="mt-1 text-xs text-muted">{status}</p> : null}
          {profileWarning ? (
            <p className="mt-2 max-w-3xl text-xs text-accent-fg" role="status">
              {profileWarning}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Open folder"
          onClick={handleOpenFolder}
          className="btn-primary"
        >
          Open folder
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-bg/60">
        {jobs.length === 0 ? (
          <p className="p-6 text-sm text-muted-2">
            Open a controller backup or USB/CF folder to list .JBI jobs.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">JBI jobs in the opened folder</caption>
            <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Folder</th>
                <th className="px-4 py-2 font-medium">Positions</th>
                <th className="px-4 py-2 font-medium">POSTYPE</th>
                <th className="px-4 py-2 font-medium">Relative path</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((job) => {
                const selected = selectedPath === job.path
                return (
                  <tr
                    key={job.path}
                    tabIndex={0}
                    aria-label={`Job ${job.name}`}
                    aria-selected={selected}
                    onClick={() => handleSelectJob(job.path)}
                    onDoubleClick={() => handleJobDoubleClick(job.path)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        handleJobDoubleClick(job.path)
                      }
                    }}
                    className={
                      selected
                        ? "cursor-pointer border-t border-border/80 bg-accent/15 text-fg"
                        : "cursor-pointer border-t border-border/80 text-fg/90 hover:bg-surface-2"
                    }
                  >
                    <td className="px-4 py-1.5 font-mono">{job.name}</td>
                    <td className="px-4 py-1.5 font-mono text-muted">
                      {job.folderName ?? "—"}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-muted">
                      {job.positionCount ?? "—"}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-muted">
                      {job.postypes?.join(",") || "—"}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-muted">
                      {jobs.find((entry) => entry.path === job.path)?.relativePath ?? job.path}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {index && index.graph.length > 0 ? (
        <details className="rounded border border-border bg-bg/40 p-3 text-xs text-muted">
          <summary className="cursor-pointer text-fg/80">CALL / PSTART graph (first 40)</summary>
          <ul className="mt-2 max-h-40 overflow-auto font-mono">
            {index.graph.slice(0, 40).map((edge, i) => (
              <li key={`${edge.fromJob}-${edge.toJob}-${edge.lineIndex}-${i}`}>
                {edge.fromJob} —{edge.kind}→ {edge.toJob}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editPromptPath ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4"
          role="presentation"
          onClick={handleCancelEditPrompt}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Choose how to edit this job"
            tabIndex={0}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleEditPromptKeyDown}
            className="w-full max-w-md rounded border border-border bg-surface p-5 shadow-lg focus-ring"
          >
            <h2 className="text-base font-semibold text-fg">Edit job</h2>
            <p className="mt-2 font-mono text-sm text-muted">{promptJobName}</p>
            <p className="mt-2 text-sm text-muted">
              Choose where to open this job. Single-click only selects; this dialog appears on
              double-click.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                aria-label="Edit in Job Editing Wizard"
                onClick={handleEditInWizard}
                className="btn-primary w-full justify-center"
              >
                Edit in Job Editing Wizard
              </button>
              <button
                type="button"
                aria-label="Edit in Manual Editor"
                onClick={handleEditInManualEditor}
                className="btn-secondary w-full justify-center"
              >
                Edit in Manual Editor
              </button>
              {onOpenTransform && editPromptPath ? (
                <button
                  type="button"
                  aria-label="Open in Transform"
                  onClick={() => {
                    const path = editPromptPath
                    setEditPromptPath(null)
                    onOpenTransform(path)
                  }}
                  className="btn-secondary w-full justify-center"
                >
                  Open in Transform
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Cancel edit choice"
                onClick={handleCancelEditPrompt}
                className="btn-ghost w-full justify-center"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
