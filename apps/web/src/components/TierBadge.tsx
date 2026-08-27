import type { FsTier } from "../platform"

interface TierBadgeProps {
  tier: FsTier
  label: string
}

export const TierBadge = ({ tier, label }: TierBadgeProps) => (
  <div
    className={
      tier === "directory-picker"
        ? "rounded border border-success/40 bg-success/10 px-3 py-2 text-xs text-fg"
        : "rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
    }
    role="status"
    aria-label={`Filesystem tier: ${label}`}
  >
    <span className="font-semibold text-fg">FS tier: </span>
    <span className="text-muted">{label}</span>
  </div>
)
