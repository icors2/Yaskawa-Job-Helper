/**
 * Optional MotoROS2 connection prefs (setup/diagnostics only).
 * Not required for offline .JBI editing. See docs/MOTOROS2.md.
 */

import { getStoragePort } from "../ports/storage"

export const MOTOROS2_PREFS_STORAGE_KEY = "yaskawa.motoros2.v1"

export interface MotoRos2Settings {
  /** micro-ROS Agent host IP (PC running the agent — same as motoros2_config.yaml agent_ip_address) */
  agentHost: string
  /** UDP port — must match motoros2_config.yaml agent_port_number (commonly 8888) */
  agentPort: number
  /** Expected ROS 2 node name hint (default is motoman_<mac>); optional */
  nodeNameHint: string
  /** ROS 2 distro the cell targets */
  rosDistro: "humble" | "jazzy" | "foxy" | "galactic" | ""
  notes: string
  updatedAt: string
}

export interface MotoRos2PrefsStore {
  version: 1
  byProfileId: Record<string, MotoRos2Settings>
}

const defaultSettings = (): MotoRos2Settings => ({
  agentHost: "192.168.1.10",
  agentPort: 8888,
  nodeNameHint: "",
  rosDistro: "humble",
  notes: "",
  updatedAt: new Date().toISOString()
})

export const loadMotoRos2PrefsStore = (): MotoRos2PrefsStore => {
  try {
    const raw = getStoragePort().getItem(MOTOROS2_PREFS_STORAGE_KEY)
    if (!raw) {
      return { version: 1, byProfileId: {} }
    }
    const parsed = JSON.parse(raw) as MotoRos2PrefsStore
    if (parsed.version !== 1 || typeof parsed.byProfileId !== "object") {
      return { version: 1, byProfileId: {} }
    }
    return { version: 1, byProfileId: parsed.byProfileId ?? {} }
  } catch {
    return { version: 1, byProfileId: {} }
  }
}

export const getMotoRos2Settings = (profileId: string | null): MotoRos2Settings => {
  if (!profileId) {
    return defaultSettings()
  }
  return loadMotoRos2PrefsStore().byProfileId[profileId] ?? defaultSettings()
}

export const saveMotoRos2Settings = (
  profileId: string,
  settings: Partial<MotoRos2Settings>
): MotoRos2Settings => {
  const store = loadMotoRos2PrefsStore()
  const prev = store.byProfileId[profileId] ?? defaultSettings()
  const next: MotoRos2Settings = {
    agentHost: (settings.agentHost ?? prev.agentHost).trim() || prev.agentHost,
    agentPort: Number(settings.agentPort ?? prev.agentPort) || 8888,
    nodeNameHint: (settings.nodeNameHint ?? prev.nodeNameHint).trim(),
    rosDistro: settings.rosDistro ?? prev.rosDistro,
    notes: settings.notes ?? prev.notes,
    updatedAt: new Date().toISOString()
  }
  getStoragePort().setItem(
    MOTOROS2_PREFS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      byProfileId: { ...store.byProfileId, [profileId]: next }
    } satisfies MotoRos2PrefsStore)
  )
  return next
}

export const MOTOROS2_DOCS = {
  github: "https://github.com/Yaskawa-Global/motoros2",
  releases: "https://github.com/Yaskawa-Global/motoros2/releases",
  interfaces: "https://github.com/Yaskawa-Global/motoros2_interfaces",
  portalRos:
    "https://developer.motoman.com/en/home"
} as const

/** Accurate checklist derived from MotoROS2 README (do not invent). */
export const MOTOROS2_CELL_CHECKLIST: { id: string; label: string }[] = [
  {
    id: "controller",
    label: "Controller is DX200, YRC1000, or YRC1000micro (YNX1000 / FS100 / DX100 not supported)"
  },
  {
    id: "sysver",
    label:
      "System software ≥ DN2.44.00-00 (DX200), YAS2.80.00-00 (YRC1000), or YBS2.45.00-00 (YRC1000micro)"
  },
  {
    id: "network",
    label: "Controller network configured (YRC1000: LAN2 or LAN3; DX200 / YRC1000micro: LAN)"
  },
  {
    id: "motoplus",
    label: "Maintenance → OPTION FUNCTION: MotoPlus FUNC. = USED and MOTOMAN DRIVER = USED"
  },
  {
    id: "outfile",
    label: "Correct mr2_*.out loaded via MotoPlus APL (YRC1000 / micro / DX200 variant)"
  },
  {
    id: "config",
    label: "motoros2_config.yaml on controller with agent_ip_address + agent_port_number set to the PC"
  },
  {
    id: "agent",
    label: "micro-ROS Agent running on PC (Docker or Colcon); FastDDS RMW; ROS 2 Foxy/Galactic/Humble/Jazzy"
  },
  {
    id: "incompat",
    label: "Not using incompatible options (e.g. Simple Connect must be removed; see MotoROS2 README)"
  }
]
