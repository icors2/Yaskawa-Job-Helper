import { NavLink } from "react-router-dom"

const NAV_ITEMS = [
  { to: "/profiles", label: "Profiles" },
  { to: "/calibration", label: "Calibration" },
  { to: "/transform", label: "Transform" },
  { to: "/demo", label: "3D Demo" },
  { to: "/validate", label: "Validate" }
] as const

interface SidebarProps {
  jobCount: number
}

export const Sidebar = ({ jobCount }: SidebarProps) => (
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
      <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-2">Web</p>
    </div>
    <nav className="flex flex-1 flex-col gap-1 p-2">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          aria-label={`${item.label} page`}
          className={({ isActive }) =>
            isActive
              ? "rounded border-l-2 border-accent bg-accent/15 px-3 py-2 text-left text-sm text-accent-fg focus-ring"
              : "rounded border-l-2 border-transparent px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg focus-ring"
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
    <p className="border-t border-border px-4 py-3 font-mono text-[11px] text-muted-2">
      {jobCount} jobs
    </p>
  </aside>
)
