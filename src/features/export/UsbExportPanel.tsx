import { useEffect, useState } from "react"
import {
  ensureDirectory,
  exportToRemovable,
  listRemovableDrives,
  type RemovableDrive
} from "../../lib/fs/desktop"
import { USB_EXPORT_DEFAULT_SUBDIR } from "../../lib/robot/folders"

interface UsbExportPanelProps {
  outputFolder: string | null
  /** Optional single file under output; otherwise exports the whole output folder. */
  sourcePath?: string | null
  disabled?: boolean
  disabledReason?: string
}

export const UsbExportPanel = ({
  outputFolder,
  sourcePath = null,
  disabled = false,
  disabledReason
}: UsbExportPanelProps) => {
  const [drives, setDrives] = useState<RemovableDrive[]>([])
  const [selectedDrive, setSelectedDrive] = useState("")
  const [subdir, setSubdir] = useState(USB_EXPORT_DEFAULT_SUBDIR)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(
    "Export copies from the output folder onto USB — never over the source backup."
  )

  const handleRefresh = async () => {
    setBusy(true)
    try {
      const listed = await listRemovableDrives()
      const removable = listed.filter(
        (drive) => drive.driveType === "removable" || drive.driveType === "cdrom"
      )
      const preferred = removable.length > 0 ? removable : listed
      setDrives(preferred)
      if (preferred.length > 0) {
        setSelectedDrive((prev) =>
          preferred.some((drive) => drive.path === prev) ? prev : preferred[0].path
        )
        setStatus(
          removable.length > 0
            ? `Found ${removable.length} removable drive(s).`
            : `No removable drives detected — showing ${preferred.length} mounted volume(s).`
        )
      } else {
        setSelectedDrive("")
        setStatus("No drives found. Insert a USB stick and refresh.")
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not list drives")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void handleRefresh()
  }, [])

  const handleExport = async () => {
    if (disabled) {
      setStatus(disabledReason ?? "Export locked.")
      return
    }
    if (!outputFolder) {
      setStatus("Set an output folder first (Setup Guide).")
      return
    }
    if (!selectedDrive) {
      setStatus("Select a USB / removable drive.")
      return
    }
    const from = sourcePath || outputFolder
    setBusy(true)
    setStatus("Exporting…")
    try {
      await ensureDirectory(outputFolder)
      const result = await exportToRemovable({
        sourcePath: from,
        usbRoot: selectedDrive,
        destSubdir: subdir.trim() || USB_EXPORT_DEFAULT_SUBDIR
      })
      setStatus(
        `Exported ${result.filesCopied} file(s) (${result.bytesCopied} bytes) → ${result.destination}`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Export failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded border border-border bg-surface p-4"
      aria-label="Export to USB"
    >
      <h2 className="text-sm font-semibold text-fg">Export to USB</h2>
      <p className="mt-1 text-xs text-muted">
        Copies the output folder (or a selected file) to a folder on removable media. Source
        backup stays untouched.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Drive
          <select
            aria-label="Removable drive"
            className="input-field min-w-[10rem] py-1.5 text-sm"
            value={selectedDrive}
            onChange={(event) => setSelectedDrive(event.target.value)}
          >
            {drives.length === 0 ? <option value="">No drives</option> : null}
            {drives.map((drive) => (
              <option key={drive.path} value={drive.path}>
                {drive.path} ({drive.driveType})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Folder on USB
          <input
            aria-label="Destination folder name on USB"
            className="input-field min-w-[10rem] py-1.5 font-mono text-sm"
            value={subdir}
            onChange={(event) => setSubdir(event.target.value)}
          />
        </label>
        <button
          type="button"
          aria-label="Refresh removable drives"
          disabled={busy}
          onClick={() => void handleRefresh()}
          className="btn-secondary"
        >
          Refresh drives
        </button>
        <button
          type="button"
          aria-label="Export output to USB"
          disabled={busy || disabled || !outputFolder}
          onClick={() => void handleExport()}
          className="btn-primary"
        >
          {busy ? "Working…" : "Export to USB"}
        </button>
      </div>
      {disabled && disabledReason ? (
        <p className="mt-2 text-xs text-warn" role="status">
          {disabledReason}
        </p>
      ) : null}
      <p className="mt-2 font-mono text-xs text-muted-2" role="status">
        Source: {sourcePath || outputFolder || "—"}
        {"\n"}
        {status}
      </p>
    </section>
  )
}
