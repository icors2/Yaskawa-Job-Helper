import { useEffect, useState } from "react"
import {
  getMotoRos2Settings,
  MOTOROS2_CELL_CHECKLIST,
  MOTOROS2_DOCS,
  saveMotoRos2Settings,
  type MotoRos2Settings
} from "../../lib/robot/motoros2Prefs"

interface MotoRos2SetupPanelProps {
  profileId: string | null
  /** When true, omit outer title (parent provides a disclosure summary). */
  hideTitle?: boolean
}

/**
 * Optional setup assist — does not gate install or editing.
 * Stores connection hints for a future joint_states / TF calibration feed.
 */
export const MotoRos2SetupPanel = ({ profileId, hideTitle = false }: MotoRos2SetupPanelProps) => {
  const [settings, setSettings] = useState<MotoRos2Settings>(() =>
    getMotoRos2Settings(profileId)
  )
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState("")

  useEffect(() => {
    setSettings(getMotoRos2Settings(profileId))
  }, [profileId])

  const handleSave = () => {
    if (!profileId) {
      setStatus("Select a robot profile first.")
      return
    }
    const next = saveMotoRos2Settings(profileId, settings)
    setSettings(next)
    setStatus("Saved MotoROS2 preferences for this profile (optional — not required for offline editing).")
  }

  const handleToggleCheck = (id: string) => {
    setChecks((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <section
      className={hideTitle ? "p-4" : "rounded border border-border bg-bg/40 p-4"}
      aria-label="Optional MotoROS2 setup"
    >
      {hideTitle ? null : (
        <h3 className="text-sm font-semibold text-fg">Optional: MotoROS2</h3>
      )}
      <p className={hideTitle ? "text-xs text-muted" : "mt-1 text-xs text-muted"}>
        MotoROS2 is a ROS 2 node that runs <span className="font-medium text-fg/80">on the
        controller</span> (MotoPlus + micro-ROS). A micro-ROS Agent on a PC bridges it into the
        ROS 2 graph. It can publish <span className="font-mono">joint_states</span>,{" "}
        <span className="font-mono">robot_status</span>, and <span className="font-mono">tf</span>{" "}
        for diagnostics.{" "}
        <span className="text-warn">Not required for offline job editing or this app&apos;s
        install checklist.</span>
      </p>

      <div className="mt-3 grid gap-2 text-xs text-muted sm:grid-cols-2">
        <div className="rounded border border-border/80 bg-surface/50 p-2">
          <p className="font-medium text-fg/90">Use MotoROS2 when…</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>You already run ROS 2 / MoveIt on the cell</li>
            <li>You want live joint / TF topics for diagnostics</li>
            <li>Later: auto-capture calibration pairs from topic streams</li>
          </ul>
        </div>
        <div className="rounded border border-border/80 bg-surface/50 p-2">
          <p className="font-medium text-fg/90">Prefer YMConnect when…</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>You need PC-side <span className="font-mono">ConvertPosition</span> (pulse↔cartesian)</li>
            <li>Validating offline FK against controller kinematics</li>
            <li>No ROS 2 stack on the shop PC</li>
          </ul>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted">
        Links:{" "}
        <a
          className="text-accent-fg underline underline-offset-2"
          href={MOTOROS2_DOCS.github}
          target="_blank"
          rel="noreferrer"
        >
          github.com/Yaskawa-Global/motoros2
        </a>
        {" · "}
        <a
          className="text-accent-fg underline underline-offset-2"
          href={MOTOROS2_DOCS.releases}
          target="_blank"
          rel="noreferrer"
        >
          Releases
        </a>
        {" · "}
        <a
          className="text-accent-fg underline underline-offset-2"
          href={MOTOROS2_DOCS.portalRos}
          target="_blank"
          rel="noreferrer"
        >
          Motoman Developer Portal
        </a>
      </p>

      <fieldset className="mt-3">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-2">
          Cell checklist (from MotoROS2 docs)
        </legend>
        <ul className="mt-2 flex flex-col gap-1.5">
          {MOTOROS2_CELL_CHECKLIST.map((item) => (
            <li key={item.id}>
              <label className="flex items-start gap-2 text-xs text-fg/80">
                <input
                  type="checkbox"
                  aria-label={item.label}
                  checked={Boolean(checks[item.id])}
                  onChange={() => handleToggleCheck(item.id)}
                  className="mt-0.5"
                />
                <span>{item.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="mt-3 flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Agent host (PC)
          <input
            aria-label="MotoROS2 micro-ROS Agent host IP"
            className="input-field min-w-[10rem] py-1.5 font-mono text-sm"
            value={settings.agentHost}
            onChange={(event) =>
              setSettings({ ...settings, agentHost: event.target.value })
            }
            disabled={!profileId}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Agent UDP port
          <input
            type="number"
            aria-label="MotoROS2 micro-ROS Agent UDP port"
            className="input-field w-28 py-1.5 font-mono text-sm"
            value={settings.agentPort}
            onChange={(event) =>
              setSettings({
                ...settings,
                agentPort: Number.parseInt(event.target.value, 10) || 8888
              })
            }
            disabled={!profileId}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          ROS 2 distro
          <select
            aria-label="ROS 2 distro for MotoROS2"
            className="input-field py-1.5 text-sm"
            value={settings.rosDistro}
            onChange={(event) =>
              setSettings({
                ...settings,
                rosDistro: event.target.value as MotoRos2Settings["rosDistro"]
              })
            }
            disabled={!profileId}
          >
            <option value="humble">Humble</option>
            <option value="jazzy">Jazzy</option>
            <option value="foxy">Foxy</option>
            <option value="galactic">Galactic (+ FastDDS)</option>
            <option value="">Other / unset</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Node name hint
          <input
            aria-label="Expected MotoROS2 node name"
            className="input-field min-w-[10rem] py-1.5 font-mono text-sm"
            placeholder="motoman_ab_cd_ef"
            value={settings.nodeNameHint}
            onChange={(event) =>
              setSettings({ ...settings, nodeNameHint: event.target.value })
            }
            disabled={!profileId}
          />
        </label>
      </div>

      <label className="mt-2 flex flex-col gap-1 text-xs text-muted">
        Notes
        <textarea
          aria-label="MotoROS2 setup notes"
          className="input-field min-h-16 font-mono text-xs"
          value={settings.notes}
          onChange={(event) => setSettings({ ...settings, notes: event.target.value })}
          disabled={!profileId}
          placeholder="e.g. LAN3 used; Agent on welding PC; joint_states QoS…"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Save MotoROS2 preferences"
          disabled={!profileId}
          onClick={handleSave}
          className="btn-secondary"
        >
          Save optional prefs
        </button>
        <p className="text-[11px] text-muted-2">
          Future: subscribe to <span className="font-mono">joint_states</span> / TF to seed
          calibration pairs. Live ROS client is not wired in this app yet.
        </p>
      </div>
      {status ? (
        <p className="mt-2 text-xs text-fg/80" role="status">
          {status}
        </p>
      ) : null}
    </section>
  )
}
