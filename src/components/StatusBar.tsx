interface StatusBarProps {
  message: string
  sidecar: string
  outputFolder: string | null
  activeRobot?: string | null
  onOpenSetup?: () => void
}

export const StatusBar = ({
  message,
  sidecar,
  outputFolder,
  activeRobot,
  onOpenSetup
}: StatusBarProps) => {
  return (
    <footer
      className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-surface px-4 py-1.5 font-mono text-[11px] text-muted"
      role="status"
      aria-live="polite"
    >
      <p className="truncate">{message}</p>
      <div className="flex shrink-0 items-center gap-4">
        {onOpenSetup ? (
          <button
            type="button"
            aria-label="Open setup guide"
            onClick={onOpenSetup}
            className="text-accent underline-offset-2 hover:text-accent-soft hover:underline focus-ring"
          >
            Setup Guide
          </button>
        ) : null}
        <p
          className="truncate"
          title={activeRobot ?? "No active robot profile"}
        >
          robot: {activeRobot ?? "—"}
        </p>
        <p className="truncate" title={outputFolder ?? "No output folder"}>
          out: {outputFolder ?? "—"}
        </p>
        <p>{sidecar}</p>
      </div>
    </footer>
  )
}
