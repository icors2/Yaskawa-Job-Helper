import { useMemo, useState } from "react"
import type { ScanBackupResult } from "@yaskawa/core/kin/types"
import {
  setFolderPrefsForProfile,
  getFolderPrefsForProfile
} from "@yaskawa/core/robot/folders"
import { usePlatform } from "../../context/PlatformContext"
import { TierBadge } from "../../components/TierBadge"
import {
  createRobotProfileFromBackupWeb,
  deleteProfile,
  getActiveProfile,
  renameProfile,
  scanRobotBackupWeb,
  setActiveProfileId
} from "../../lib/profile"
import { syncKeyToIdb } from "../../platform"

const SESSION_PROFILE_KEY = "yaskawa.session.profileConfirmed.v1"

export const writeSessionConfirmed = (confirmed: boolean) => {
  try {
    if (confirmed) {
      sessionStorage.setItem(SESSION_PROFILE_KEY, "1")
    } else {
      sessionStorage.removeItem(SESSION_PROFILE_KEY)
    }
  } catch {
    /* ignore */
  }
}

export const readSessionConfirmed = (): boolean => {
  try {
    return sessionStorage.getItem(SESSION_PROFILE_KEY) === "1"
  } catch {
    return false
  }
}

export const ProfilesPage = () => {
  const {
    platform,
    folders,
    tierName,
    profilesStore,
    persistProfiles,
    handleReconnectSource,
    handleReconnectOutput,
    refreshFolders
  } = usePlatform()

  const [selectedId, setSelectedId] = useState(
    profilesStore.activeProfileId ?? profilesStore.profiles[0]?.id ?? ""
  )
  const [mode, setMode] = useState<"pick" | "create">(
    profilesStore.profiles.length === 0 ? "create" : "pick"
  )
  const [displayName, setDisplayName] = useState("")
  const [scan, setScan] = useState<ScanBackupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(
    profilesStore.profiles.length === 0
      ? "Link a controller backup, then create a robot profile."
      : "Select a robot or create a new profile from a backup."
  )
  const [renameText, setRenameText] = useState("")

  const active = useMemo(() => getActiveProfile(profilesStore), [profilesStore])

  const handlePickSource = async () => {
    if (!platform) {
      return
    }
    setBusy(true)
    try {
      const label = await platform.fs.pickSourceFolder()
      await refreshFolders()
      if (!label) {
        setStatus("Source folder pick cancelled.")
        return
      }
      const result = await scanRobotBackupWeb(platform, label)
      setScan(result)
      setStatus(
        result.ready
          ? `Source linked (${label}) — required controller files found.`
          : `Source linked (${label}) — missing: ${result.missingRequired.join(", ")}. ` +
              "Pick the folder that contains SYSTEM.SYS (not a parent JOBS folder), " +
              "or if Chrome hid .SYS, choose SYSTEM.SYS in the follow-up file picker / rename to SYSTEM.SYS.TXT."
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pick source failed")
    } finally {
      setBusy(false)
    }
  }

  const handlePickOutput = async () => {
    if (!platform) {
      return
    }
    setBusy(true)
    try {
      const label = await platform.fs.pickOutputFolder()
      await refreshFolders()
      setStatus(
        label
          ? `Output linked (${label}). Profiles will mirror to profiles/robot_profiles.json when possible.`
          : "Output pick cancelled."
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pick output failed")
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    if (!platform || !folders.sourceLabel) {
      setStatus("Link a source/backup folder first.")
      return
    }
    setBusy(true)
    try {
      const { store, profile } = await createRobotProfileFromBackupWeb(platform, {
        folderLabel: folders.sourceLabel,
        displayName: displayName.trim() || undefined,
        makeActive: true
      })
      setFolderPrefsForProfile(profile.id, {
        sourceFolder: folders.sourceLabel,
        outputFolder: folders.outputLabel
      })
      await syncKeyToIdb("yaskawa.folders.v1")
      await persistProfiles(store)
      setSelectedId(profile.id)
      setMode("pick")
      writeSessionConfirmed(true)
      setStatus(`Created "${profile.displayName}". Folder is the durability source of truth when output is linked.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Profile create failed")
    } finally {
      setBusy(false)
    }
  }

  const handleActivate = async () => {
    if (!selectedId) {
      setStatus("Select a profile first.")
      return
    }
    try {
      const next = setActiveProfileId(profilesStore, selectedId)
      const prefs = getFolderPrefsForProfile(selectedId)
      if (prefs) {
        setFolderPrefsForProfile(selectedId, prefs)
      }
      await persistProfiles(next)
      writeSessionConfirmed(true)
      setStatus(`Active robot: ${getActiveProfile(next)?.displayName ?? selectedId}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Activate failed")
    }
  }

  const handleRename = async () => {
    if (!selectedId || !renameText.trim()) {
      return
    }
    try {
      const next = renameProfile(profilesStore, selectedId, renameText.trim())
      await persistProfiles(next)
      setRenameText("")
      setStatus("Profile renamed.")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Rename failed")
    }
  }

  const handleDelete = async () => {
    if (!selectedId) {
      return
    }
    const next = deleteProfile(profilesStore, selectedId)
    await persistProfiles(next)
    setSelectedId(next.activeProfileId ?? "")
    setStatus("Profile deleted.")
  }

  return (
    <div className="page-shell">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold text-fg">Robot profiles</h2>
        <p className="text-sm text-muted">
          Create from a linked controller backup (SYSTEM.SYS, RC.PRM, TOOL.CND, UFRAME.CND).
          Profiles cache in IndexedDB / localStorage and mirror to the output folder when linked.
        </p>
        {platform ? <TierBadge tier={platform.tier} label={tierName} /> : null}
      </header>

      <section className="panel flex flex-col gap-3 p-4" aria-label="Folder links">
        <h3 className="text-sm font-semibold text-fg">Folder links</h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            aria-label="Link source or backup folder"
            disabled={busy || !platform}
            onClick={() => void handlePickSource()}
          >
            Link source / backup
          </button>
          <button
            type="button"
            className="btn-secondary"
            aria-label="Link output folder"
            disabled={busy || !platform}
            onClick={() => void handlePickOutput()}
          >
            Link output folder
          </button>
          {folders.sourceNeedsReconnect ? (
            <button
              type="button"
              className="btn-accent-soft"
              aria-label="Reconnect source folder"
              onClick={() => void handleReconnectSource()}
            >
              Reconnect source
            </button>
          ) : null}
          {folders.outputNeedsReconnect ? (
            <button
              type="button"
              className="btn-accent-soft"
              aria-label="Reconnect output folder"
              onClick={() => void handleReconnectOutput()}
            >
              Reconnect output
            </button>
          ) : null}
        </div>
        <p className="font-mono text-[11px] text-muted-2">
          Source: {folders.sourceReady ? folders.sourceLabel : folders.sourceNeedsReconnect ? `${folders.sourceLabel} (reconnect)` : "—"}
          {" · "}
          Output: {folders.outputReady ? folders.outputLabel : folders.outputNeedsReconnect ? `${folders.outputLabel} (reconnect)` : "—"}
        </p>
        {scan ? (
          <p className="text-xs text-muted">
            Scan: {scan.ready ? "ready" : `missing ${scan.missingRequired.join(", ")}`}
          </p>
        ) : null}
      </section>

      <section className="panel flex flex-col gap-3 p-4" aria-label="Profile list">
        <div className="flex flex-wrap gap-2">
          {profilesStore.profiles.length > 0 ? (
            <button
              type="button"
              className={mode === "pick" ? "btn-primary" : "btn-ghost"}
              aria-label="Pick existing profile"
              onClick={() => setMode("pick")}
            >
              Existing
            </button>
          ) : null}
          <button
            type="button"
            className={mode === "create" ? "btn-primary" : "btn-ghost"}
            aria-label="Create new profile"
            onClick={() => setMode("create")}
          >
            Create new
          </button>
        </div>

        {mode === "pick" && profilesStore.profiles.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Saved robot profiles">
            {profilesStore.profiles.map((profile) => {
              const selected = profile.id === selectedId
              return (
                <li key={profile.id}>
                  <button
                    type="button"
                    aria-label={`Select ${profile.displayName}`}
                    aria-pressed={selected}
                    tabIndex={0}
                    onClick={() => setSelectedId(profile.id)}
                    className={
                      selected
                        ? "flex w-full flex-col gap-0.5 rounded border border-accent/60 bg-accent/15 px-4 py-3 text-left focus-ring"
                        : "flex w-full flex-col gap-0.5 rounded border border-border bg-surface px-4 py-3 text-left hover:border-border-strong focus-ring"
                    }
                  >
                    <span className="text-sm font-medium text-fg">{profile.displayName}</span>
                    <span className="font-mono text-[11px] text-muted-2">
                      {profile.robotModel || profile.robotId} · {profile.status}
                      {active?.id === profile.id ? " · active" : ""}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}

        {mode === "create" ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs text-muted" htmlFor="profile-display-name">
              Display name (optional)
            </label>
            <input
              id="profile-display-name"
              className="input-field max-w-md"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-label="Profile display name"
            />
            <button
              type="button"
              className="btn-primary w-fit"
              aria-label="Create profile from linked backup"
              disabled={busy || !folders.sourceReady}
              onClick={() => void handleCreate()}
            >
              Create from linked backup
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <button
              type="button"
              className="btn-primary"
              aria-label="Activate selected profile"
              disabled={!selectedId}
              onClick={() => void handleActivate()}
            >
              Set active
            </button>
            <input
              className="input-field max-w-xs"
              placeholder="Rename…"
              value={renameText}
              onChange={(event) => setRenameText(event.target.value)}
              aria-label="New profile name"
            />
            <button
              type="button"
              className="btn-secondary"
              aria-label="Rename selected profile"
              disabled={!selectedId || !renameText.trim()}
              onClick={() => void handleRename()}
            >
              Rename
            </button>
            <button
              type="button"
              className="btn-ghost"
              aria-label="Delete selected profile"
              disabled={!selectedId}
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
          </div>
        )}
      </section>

      <p className="text-sm text-muted" role="status">
        {status}
      </p>
    </div>
  )
}
