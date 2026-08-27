interface StatusBarProps {
  status: string
  tierName: string
  profileName: string | null
}

export const StatusBar = ({ status, tierName, profileName }: StatusBarProps) => (
  <footer
    className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-surface px-4 py-2 text-xs text-muted"
    role="status"
    aria-live="polite"
  >
    <span className="font-mono text-muted-2">{status}</span>
    <span className="ml-auto font-mono text-[11px] text-muted-2">
      {profileName ? `Robot: ${profileName}` : "No active robot"}
      {" · "}
      FS: {tierName}
    </span>
  </footer>
)
