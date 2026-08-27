import { useMemo, useState } from "react"
import {
  createRobotProfileFromBackup,
  scanRobotBackup,
  setActiveProfileId,
  syncActiveProfileToSidecar,
  type RobotProfilesStore
} from "../../lib/robot/profile"
import { getFolderPrefsForProfile } from "@yaskawa/core/robot/folders"
import {
  isProfileSetupFinished,
  loadSetupProgress
} from "@yaskawa/core/setup/progress"
import type { ScanBackupResult } from "../../lib/kin/client"

interface ProfileGateProps {
  profilesStore: RobotProfilesStore
  onProfilesStoreChange: (store: RobotProfilesStore) => void
  onPickBackupFolder: () => Promise<string | null>
  onContinue: (profileId: string) => void
}

/**
 * Blocking first screen: must select or create a robot profile before main chrome.
 * Finished profiles enter the main app; incomplete ones continue Setup.
 */
export const ProfileGate = ({
  profilesStore,
  onProfilesStoreChange,
  onPickBackupFolder,
  onContinue
}: ProfileGateProps) => {
  const [selectedId, setSelectedId] = useState<string>(
    profilesStore.activeProfileId ?? profilesStore.profiles[0]?.id ?? ""
  )
  const [mode, setMode] = useState<"pick" | "create">(
    profilesStore.profiles.length === 0 ? "create" : "pick"
  )
  const [backupFolder, setBackupFolder] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanBackupResult | null>(null)
  const [displayName, setDisplayName] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(
    profilesStore.profiles.length === 0
      ? "No robot profiles yet - create one from a pendant backup before continuing."
      : "Select the robot you will work on, or add a new profile."
  )

  const setupProgress = useMemo(() => loadSetupProgress(), [profilesStore])

  const selectedReady = useMemo(() => {
    if (!selectedId) {
      return false
    }
    const prefs = getFolderPrefsForProfile(selectedId)
    const hasFolders = Boolean(prefs?.sourceFolder && prefs?.outputFolder)
    return isProfileSetupFinished(setupProgress, selectedId, hasFolders)
  }, [selectedId, setupProgress])

  const handlePickBackup = async () => {
    const folder = await onPickBackupFolder()
    if (!folder) {
      return
    }
    setBackupFolder(folder)
    setBusy(true)
    try {
      const result = await scanRobotBackup(folder)
      setScan(result)
      setStatus(
        result.ready
          ? "Required controller files found - create the profile."
          : `Missing required files: ${result.missingRequired.join(", ")}`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Scan failed")
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    if (!backupFolder) {
      setStatus("Choose a controller backup folder first.")
      return
    }
    if (scan && !scan.ready) {
      setStatus(`Cannot create - missing ${scan.missingRequired.join(", ")}`)
      return
    }
    setBusy(true)
    try {
      const { store, profile } = await createRobotProfileFromBackup({
        folder: backupFolder,
        displayName: displayName.trim() || undefined,
        makeActive: true
      })
      onProfilesStoreChange(store)
      setSelectedId(profile.id)
      setMode("pick")
      setStatus(`Created "${profile.displayName}". Continue to Setup Guide.`)
      try {
        await syncActiveProfileToSidecar(store)
      } catch {
        /* sidecar may be offline */
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Profile create failed")
    } finally {
      setBusy(false)
    }
  }

  const handleContinue = async () => {
    if (!selectedId) {
      setStatus("Select a robot profile, or create one.")
      return
    }
    try {
      const next = setActiveProfileId(profilesStore, selectedId)
      onProfilesStoreChange(next)
      try {
        await syncActiveProfileToSidecar(next)
      } catch {
        /* sidecar may be offline */
      }
      onContinue(selectedId)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not activate profile")
    }
  }

  const continueLabel = selectedReady ? "Enter app" : "Continue setup"
  const continueHint = selectedReady
    ? "This profile already finished setup - open Loaded Jobs."
    : "This profile still needs Setup Guide steps."

  return (
    <div
      className="flex min-h-screen flex-col bg-bg font-sans text-fg"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-gate-title"
    >
      <div className="brand-bar shrink-0" aria-hidden="true" />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
        <header>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            Motoman
          </p>
          <h1 id="profile-gate-title" className="mt-2 text-2xl font-semibold tracking-tight text-fg">
            Choose robot profile
          </h1>
          <p className="mt-2 text-sm text-muted">
            Required before the editor opens. Each profile is built from that robot&apos;s
            controller backup (SYSTEM.SYS, RC.PRM, TOOL.CND, UFRAME.CND). Finished profiles
            enter the app directly; new or incomplete profiles continue Setup.
          </p>
        </header>

        {profilesStore.profiles.length > 0 && mode === "pick" ? (
          <ul className="flex flex-col gap-2" aria-label="Saved robot profiles">
            {profilesStore.profiles.map((profile) => {
              const selected = profile.id === selectedId
              const prefs = getFolderPrefsForProfile(profile.id)
              const hasFolders = Boolean(prefs?.sourceFolder && prefs?.outputFolder)
              const ready = isProfileSetupFinished(setupProgress, profile.id, hasFolders)
              return (
                <li key={profile.id}>
                  <button
                    type="button"
                    aria-label={`Select ${profile.displayName}`}
                    aria-pressed={selected}
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
                      {" · "}
                      {ready ? "setup complete" : "setup incomplete"}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}

        <div className="rounded border border-border bg-surface p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {profilesStore.profiles.length > 0 ? (
              <button
                type="button"
                aria-label="Pick existing profile"
                onClick={() => setMode("pick")}
                className={mode === "pick" ? "btn-primary" : "btn-secondary"}
              >
                Select existing
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Create new robot profile"
              onClick={() => setMode("create")}
              className={mode === "create" ? "btn-primary" : "btn-secondary"}
            >
              {profilesStore.profiles.length === 0 ? "Create robot profile" : "Add new robot…"}
            </button>
          </div>

          {mode === "create" ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                On the pendant: back up the controller to CF/USB (or copy the backup folder to
                this PC). Point at that folder - the app looks for SYSTEM.SYS, RC.PRM, TOOL.CND,
                and UFRAME.CND.
              </p>
              <p className="font-mono text-xs text-muted-2">
                {backupFolder ?? "No backup folder selected"}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label="Choose controller backup folder"
                  disabled={busy}
                  onClick={() => void handlePickBackup()}
                  className="btn-secondary"
                >
                  Choose backup folder
                </button>
                <input
                  type="text"
                  aria-label="Optional display name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Display name (optional)"
                  className="input-field max-w-xs text-sm"
                />
                <button
                  type="button"
                  aria-label="Create robot profile from backup"
                  disabled={busy || !backupFolder || Boolean(scan && !scan.ready)}
                  onClick={() => void handleCreate()}
                  className="btn-primary"
                >
                  {busy ? "Working…" : "Create profile"}
                </button>
              </div>
              {scan ? (
                <ul className="font-mono text-xs" aria-label="Required file checklist">
                  {scan.required.map((item) => (
                    <li
                      key={item.name}
                      className={item.found ? "text-success" : "text-danger"}
                    >
                      {item.found ? "✓" : "✗"} {item.name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <p className="text-sm text-fg/80" role="status">
              {status}
            </p>
            {selectedId && mode === "pick" ? (
              <p className="mt-1 text-xs text-muted">{continueHint}</p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={continueLabel}
            disabled={!selectedId || (profilesStore.profiles.length === 0 && mode === "create")}
            onClick={() => void handleContinue()}
            className="btn-primary"
          >
            {continueLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
