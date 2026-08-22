export type AppPage =
  | "setup"
  | "wizard"
  | "library"
  | "editor"
  | "calibration"
  | "transform"
  | "diff"

interface NavItem {
  id: AppPage
  label: string
}

/** Setup is reachable via header / status / first-run gate — not a permanent nav item. */
const NAV_ITEMS: NavItem[] = [
  { id: "wizard", label: "Job Editing Wizard" },
  { id: "library", label: "Loaded Jobs" },
  { id: "editor", label: "Manual Editor" },
  { id: "calibration", label: "Calibration" },
  { id: "transform", label: "Transform" },
  { id: "diff", label: "Diff" }
]

interface SidebarProps {
  page: AppPage
  onNavigate: (page: AppPage) => void
  jobCount: number
}

export const Sidebar = ({ page, onNavigate, jobCount }: SidebarProps) => {
  const handleNavigate = (next: AppPage) => {
    onNavigate(next)
  }

  return (
    <aside
      className="flex w-52 shrink-0 flex-col border-r border-border bg-surface"
      aria-label="Main navigation"
    >
      <div className="brand-bar" aria-hidden="true" />
      <div className="border-b border-border px-4 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
          Motoman
        </p>
        <h1 className="mt-1 text-sm font-semibold tracking-tight text-fg">
          Yaskawa Job Editor
        </h1>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV_ITEMS.map((item) => {
          const active = page === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`${item.label} page`}
              aria-current={active ? "page" : undefined}
              onClick={() => handleNavigate(item.id)}
              className={
                active
                  ? "rounded border-l-2 border-accent bg-accent/15 px-3 py-2 text-left text-sm text-accent-fg focus-ring"
                  : "rounded border-l-2 border-transparent px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg focus-ring"
              }
            >
              {item.label}
            </button>
          )
        })}
      </nav>
      <p className="border-t border-border px-4 py-3 font-mono text-[11px] text-muted-2">
        {jobCount} jobs
      </p>
    </aside>
  )
}
