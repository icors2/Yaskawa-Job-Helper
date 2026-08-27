import { useEffect, useState } from "react"
import { getCalibrationGate } from "../calibration"
import { UsbExportPanel } from "../export/UsbExportPanel"
import { MotoRos2SetupPanel } from "./MotoRos2SetupPanel"
import { joinPath } from "@yaskawa/core/fs/paths"
import { readTextFile, writeOutputFile } from "../../lib/fs/desktop"
import { getYmConnectBridgeStatus, YMCONNECT_ONLINE_VALIDATION } from "../../lib/kin/client"
import { readTool, readUframe } from "../../lib/kin/client"
import {
  OUTPUT_FOLDER_BASENAME,
  folderConventionHelp
} from "@yaskawa/core/robot/folders"
import {
  createRobotProfileFromBackup,
  deleteProfile,
  getActiveProfile,
  loadProfilesStore,
  profilesStoreJson,
  renameProfile,
  ROBOT_PROFILES_FILENAME,
  scanRobotBackup,
  setActiveProfileId,
  syncActiveProfileToSidecar,
  type RobotProfilesStore
} from "../../lib/robot/profile"
import type { ScanBackupResult } from "../../lib/kin/client"
import {
  getYmConnectSettings,
  saveYmConnectSettings,
  YMCONNECT_DOCS,
  type YmConnectConnectionSettings
} from "@yaskawa/core/robot/ymconnectPrefs"
import {
  finishSetup,
  isCalibrationStepSatisfied,
  isMinimumSetupComplete,
  isSetupComplete,
  loadSetupProgress,
  markSetupStep,
  saveSetupProgress,
  SETUP_STEP_ORDER,
  skipCalibrationForNow,
  type SetupProgress,
  type SetupStepId
} from "@yaskawa/core/setup/progress"

interface SetupGuidePageProps {
  sourceFolder: string | null
  outputFolder: string | null
  profilesStore: RobotProfilesStore
  onProfilesStoreChange: (store: RobotProfilesStore) => void
  onOpenSourceFolder: () => Promise<void>
  onChooseOutputFolder: () => Promise<void>
  onPickBackupFolder: () => Promise<string | null>
  onNavigate: (page: "library" | "calibration" | "diff" | "wizard") => void
  onDismiss: (message?: string) => void
  onProgressChange?: () => void
  forced?: boolean
}

const STEP_TITLES: Record<SetupStepId, string> = {
  robotInstall: "Import controller / create robot profile",
  sourceFolder: "Source jobs folder",
  outputFolder: "Output folder",
  cndFiles: "UFRAME / TOOL conditions",
  calibration: "Calibration (required for editing)",
  safety: "Safety rules"
}

const REQUIRED_FILE_HELP: { name: string; purpose: string }[] = [
  {
    name: "SYSTEM.SYS",
    purpose: "Robot name/type (e.g. AR2010), groups, and application — identifies which arm this profile is for."
  },
  {
    name: "RC.PRM",
    purpose: "Link geometry (///RC1G microns) and pulse soft-limit seeds used by offline kinematics."
  },
  {
    name: "TOOL.CND",
    purpose: "Tool / TCP definitions — needed for FK and frame transforms."
  },
  {
    name: "UFRAME.CND",
    purpose: "User frames (ORG/XX/XY). May be empty but the file is still required for install."
  }
]

const PENDANT_BACKUP_STEPS = [
  "On the pendant, enter a security level that allows backup (often MANAGEMENT).",
  "Use the pendant backup / EX. MEMORY save to copy controller files to CF, SD, or USB (depending on your controller).",
  "Include at least SYSTEM.SYS, RC.PRM, TOOL.CND, and UFRAME.CND. A full backup that also has JOB folders is ideal.",
  "Bring that media to this PC (or copy the backup folder over the network).",
  "In this app, choose that backup folder — do not edit files on the stick in place."
]

const buttonClass = "btn-secondary"
const primaryClass = "btn-primary"

export const SetupGuidePage = ({
  sourceFolder,
  outputFolder,
  profilesStore,
  onProfilesStoreChange,
  onOpenSourceFolder,
  onChooseOutputFolder,
  onPickBackupFolder,
  onNavigate,
  onDismiss,
  onProgressChange,
  forced = false
}: SetupGuidePageProps) => {
  const [progress, setProgress] = useState<SetupProgress>(() => loadSetupProgress())
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [backupFolder, setBackupFolder] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanBackupResult | null>(null)
  const [displayName, setDisplayName] = useState("")
  const [renameDraft, setRenameDraft] = useState("")
  const [safetyChecks, setSafetyChecks] = useState({
    noInPlace: false,
    diffFirst: false,
    dryRun: false
  })
  const [ymSettings, setYmSettings] = useState<YmConnectConnectionSettings>(() =>
    getYmConnectSettings(getActiveProfile(profilesStore)?.id ?? null)
  )
  const [ymBridgeMsg, setYmBridgeMsg] = useState("")

  const stepId = SETUP_STEP_ORDER[Math.min(progress.currentStep, SETUP_STEP_ORDER.length - 1)]
  const complete = isSetupComplete(progress)
  const minimumDone = isMinimumSetupComplete(progress)
  const gate = getCalibrationGate()
  const activeProfile = getActiveProfile(profilesStore)

  const persist = (next: SetupProgress) => {
    const saved = saveSetupProgress(next)
    setProgress(saved)
    onProgressChange?.()
    return saved
  }

  useEffect(() => {
    if (activeProfile && !progress.completed.robotInstall) {
      persist(
        markSetupStep(
          { ...progress, robotProfileId: activeProfile.id },
          "robotInstall",
          true
        )
      )
    }
  }, [activeProfile?.id])

  useEffect(() => {
    if (!sourceFolder) {
      return
    }
    setProgress((prev) => {
      if (prev.completed.sourceFolder) {
        return prev
      }
      const next = markSetupStep(prev, "sourceFolder", true)
      onProgressChange?.()
      return next
    })
  }, [sourceFolder])

  useEffect(() => {
    if (!outputFolder) {
      return
    }
    setProgress((prev) => {
      if (prev.completed.outputFolder) {
        return prev
      }
      const next = markSetupStep(prev, "outputFolder", true)
      onProgressChange?.()
      return next
    })
  }, [outputFolder])

  useEffect(() => {
    setYmSettings(getYmConnectSettings(activeProfile?.id ?? null))
  }, [activeProfile?.id])

  useEffect(() => {
    void (async () => {
      const bridge = await getYmConnectBridgeStatus()
      setYmBridgeMsg(
        bridge.available
          ? `Bridge found: ${bridge.bridgePath}`
          : bridge.message
      )
    })()
  }, [])

  const handleGotoStep = (index: number) => {
    persist({ ...progress, currentStep: index, dismissedUntilResume: false })
  }

  const handleNext = () => {
    const nextIndex = Math.min(progress.currentStep + 1, SETUP_STEP_ORDER.length - 1)
    persist({ ...progress, currentStep: nextIndex })
  }

  const handleBack = () => {
    const nextIndex = Math.max(progress.currentStep - 1, 0)
    persist({ ...progress, currentStep: nextIndex })
  }

  const handleSaveSetup = () => {
    if (activeProfile) {
      saveYmConnectSettings(activeProfile.id, ymSettings)
    }
    const saved = persist({ ...progress })
    setStatus(
      `Saved setup for ${activeProfile?.displayName ?? "this session"} — folders, checklist, and prefs persisted.`
    )
    return saved
  }

  const handleFinishSetup = () => {
    if (!minimumDone) {
      setStatus("Complete required steps (profile, source, output, CND, safety) before finishing.")
      return
    }
    handleSaveSetup()
    const finished = finishSetup(loadSetupProgress())
    setProgress(finished)
    onProgressChange?.()
    onDismiss(
      "Setup saved and finished — opened Loaded Jobs. Calibration may still be required before writes."
    )
  }

  const handleOpenSource = async () => {
    await onOpenSourceFolder()
    setStatus(
      `Source chosen (read-only). Output auto-created as sibling folder ${OUTPUT_FOLDER_BASENAME} when possible.`
    )
  }

  const handleChooseOutput = async () => {
    await onChooseOutputFolder()
    setStatus("Output folder set — writes stay here.")
  }

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
          ? "Required files found — create a robot profile."
          : `Missing: ${result.missingRequired.join(", ")}`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Scan failed")
    } finally {
      setBusy(false)
    }
  }

  const handlePersistProfilesFile = async (store: RobotProfilesStore) => {
    if (!outputFolder) {
      return
    }
    try {
      await writeOutputFile(ROBOT_PROFILES_FILENAME, profilesStoreJson(store))
    } catch {
      /* optional mirror */
    }
  }

  const handleCreateProfile = async () => {
    if (!backupFolder) {
      setStatus("Choose a backup folder first.")
      return
    }
    if (scan && !scan.ready) {
      setStatus(`Cannot create profile — missing ${scan.missingRequired.join(", ")}`)
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
      await handlePersistProfilesFile(store)
      const next = markSetupStep(
        {
          ...progress,
          robotProfileId: profile.id,
          uframePath: profile.sourceFiles["UFRAME.CND"]?.path ?? null,
          toolPath: profile.sourceFiles["TOOL.CND"]?.path ?? null
        },
        "robotInstall",
        true
      )
      const withCnd = markSetupStep(next, "cndFiles", true)
      persist(withCnd)
      setStatus(
        `Created profile “${profile.displayName}” (${profile.status}). Geometry features use this active robot.`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Profile create failed")
    } finally {
      setBusy(false)
    }
  }

  const handleSetActive = async (profileId: string) => {
    const next = setActiveProfileId(loadProfilesStore(), profileId)
    onProfilesStoreChange(next)
    try {
      await syncActiveProfileToSidecar(next)
    } catch {
      /* sidecar may be offline */
    }
    await handlePersistProfilesFile(next)
    const active = getActiveProfile(next)
    persist(
      markSetupStep(
        { ...progress, robotProfileId: profileId },
        "robotInstall",
        Boolean(active)
      )
    )
    setStatus(active ? `Active robot: ${active.displayName}` : "No active robot")
  }

  const handleRenameActive = () => {
    if (!activeProfile) {
      return
    }
    try {
      const next = renameProfile(
        loadProfilesStore(),
        activeProfile.id,
        renameDraft || activeProfile.displayName
      )
      onProfilesStoreChange(next)
      void handlePersistProfilesFile(next)
      setStatus(`Renamed to “${renameDraft.trim()}”`)
      setRenameDraft("")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Rename failed")
    }
  }

  const handleDeleteActive = () => {
    if (!activeProfile) {
      return
    }
    const ok = window.confirm(
      `Delete robot profile “${activeProfile.displayName}”? Calibration for this robot will be removed.`
    )
    if (!ok) {
      return
    }
    const next = deleteProfile(loadProfilesStore(), activeProfile.id)
    onProfilesStoreChange(next)
    void handlePersistProfilesFile(next)
    const still = getActiveProfile(next)
    persist(
      markSetupStep(
        { ...progress, robotProfileId: still?.id ?? null },
        "robotInstall",
        Boolean(still)
      )
    )
    setStatus(
      still
        ? `Deleted. Active is now ${still.displayName}.`
        : "Deleted. No active robot — create one."
    )
  }

  const handleLoadCnd = async () => {
    const folder = sourceFolder || activeProfile?.sourceFolder
    if (!folder) {
      setStatus("Choose a source folder or create a robot profile first.")
      return
    }
    setBusy(true)
    try {
      const uframePath =
        activeProfile?.sourceFiles["UFRAME.CND"]?.path ?? joinPath(folder, "UFRAME.CND")
      const toolPath =
        activeProfile?.sourceFiles["TOOL.CND"]?.path ?? joinPath(folder, "TOOL.CND")
      await readTextFile(uframePath)
      await readTextFile(toolPath)
      const frames = await readUframe(uframePath)
      const tools = await readTool(toolPath)
      persist(
        markSetupStep(
          {
            ...progress,
            uframePath,
            toolPath
          },
          "cndFiles",
          true
        )
      )
      setStatus(
        `Loaded ${frames.frames.length} user frame(s) and ${tools.tools.length} tool(s).`
      )
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Could not load UFRAME.CND / TOOL.CND."
      )
    } finally {
      setBusy(false)
    }
  }

  const handleMarkCalibrationDone = () => {
    if (!activeProfile) {
      setStatus("Create and select a robot profile before calibration.")
      return
    }
    if (!gate.allowed) {
      setStatus(
        `Calibration not applied yet — ${gate.reason} You may skip for now and finish setup; editing stays locked.`
      )
      return
    }
    persist(markSetupStep(progress, "calibration", true))
    setStatus("Calibration gate is open — transforms and job writes may proceed.")
  }

  const handleSkipCalibration = () => {
    persist(skipCalibrationForNow(progress))
    setStatus(
      "Setup can continue; editing unlocks after calibration. Skipped calibration for now — checklist continues."
    )
    handleNext()
  }

  const handleConfirmSafety = () => {
    if (!safetyChecks.noInPlace || !safetyChecks.diffFirst || !safetyChecks.dryRun) {
      setStatus("Check all three safety acknowledgements before confirming.")
      return
    }
    persist(
      markSetupStep(
        {
          ...progress,
          safetyAcknowledgedAt: new Date().toISOString()
        },
        "safety",
        true
      )
    )
    setStatus("Safety rules confirmed.")
  }

  const handleSaveYmConnect = () => {
    if (!activeProfile) {
      setStatus("Select a robot profile before saving YMConnect settings.")
      return
    }
    const next = saveYmConnectSettings(activeProfile.id, ymSettings)
    setYmSettings(next)
    setStatus(`Saved YMConnect host ${next.host} for ${activeProfile.displayName}.`)
  }

  const handleResetProgress = () => {
    const fresh = persist({
      ...loadSetupProgress(),
      dontShowOnStartup: false,
      dismissedUntilResume: false,
      currentStep: 0,
      completed: {
        robotInstall: Boolean(getActiveProfile(loadProfilesStore())),
        sourceFolder: Boolean(sourceFolder),
        outputFolder: Boolean(outputFolder),
        cndFiles: false,
        calibration: false,
        safety: false
      },
      calibrationSkippedForNow: false,
      uframePath: null,
      toolPath: null,
      robotProfileId: getActiveProfile(loadProfilesStore())?.id ?? null,
      safetyAcknowledgedAt: null
    })
    setProgress(fresh)
    setSafetyChecks({ noInPlace: false, diffFirst: false, dryRun: false })
    setStatus("Setup progress reset (profiles kept).")
  }

  return (
    <section className="flex h-full flex-col gap-4 overflow-auto p-6" aria-label="Setup guide">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Setup Guide</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Required install for this robot: controller files → source jobs → output folder → CND →
            safety. Calibration may be skipped during setup;{" "}
            <span className="text-warn">job writes / transforms stay locked until calibration is
            applied.</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {minimumDone ? (
            <>
              <button
                type="button"
                aria-label="Save setup progress"
                onClick={handleSaveSetup}
                className={buttonClass}
              >
                Save
              </button>
              <button
                type="button"
                aria-label="Finish setup and open Loaded Jobs"
                onClick={handleFinishSetup}
                className={primaryClass}
              >
                Finish setup
              </button>
            </>
          ) : (
            <p className="text-xs text-warn" role="status">
              {forced ? "Cannot skip — finish minimum steps first." : "Minimum setup incomplete."}
            </p>
          )}
        </div>
      </header>

      <aside className="rounded border border-border bg-surface/60 px-3 py-2 text-xs text-muted" role="note">
        <p className="font-medium text-fg/90">Folder convention</p>
        <ul className="mt-1 list-inside list-disc space-y-0.5 font-mono text-[11px]">
          {folderConventionHelp().map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </aside>

      <ol className="flex flex-wrap gap-2" aria-label="Setup steps">
        {SETUP_STEP_ORDER.map((id, index) => {
          const done =
            id === "calibration"
              ? isCalibrationStepSatisfied(progress)
              : progress.completed[id]
          const active = index === progress.currentStep
          return (
            <li key={id}>
              <button
                type="button"
                aria-label={`${STEP_TITLES[id]}${done ? " complete" : ""}`}
                aria-current={active ? "step" : undefined}
                onClick={() => handleGotoStep(index)}
                className={
                  active
                    ? "rounded border border-accent/60 bg-accent/15 px-2.5 py-1 text-xs text-accent-fg"
                    : done
                      ? "rounded border border-success/40 bg-success/10 px-2.5 py-1 text-xs text-success"
                      : "rounded border border-border-strong px-2.5 py-1 text-xs text-muted hover:border-muted"
                }
              >
                {index + 1}. {STEP_TITLES[id]}
                {done ? " ✓" : ""}
                {id === "calibration" && progress.calibrationSkippedForNow && !progress.completed.calibration
                  ? " (skipped)"
                  : ""}
              </button>
            </li>
          )
        })}
      </ol>

      <div className="rounded border border-border bg-bg/50 p-4">
        <h2 className="text-base font-medium text-fg">
          Step {progress.currentStep + 1}: {STEP_TITLES[stepId]}
        </h2>

        {stepId === "robotInstall" ? (
          <div className="mt-4 flex flex-col gap-4">
            <div className="rounded border border-border/80 bg-surface/40 p-3 text-sm text-muted">
              <p className="font-medium text-fg/90">Pendant / USB backup (step by step)</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
                {PENDANT_BACKUP_STEPS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <p className="mt-3 text-xs font-medium text-fg/90">Required files</p>
              <ul className="mt-1 space-y-1.5 text-xs">
                {REQUIRED_FILE_HELP.map((file) => (
                  <li key={file.name}>
                    <span className="font-mono text-accent-fg">{file.name}</span>
                    {" — "}
                    {file.purpose}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-2">
                Recommended: RE.PRM, SV.PRM, sample .JBI, ARCSRT.CND / ARCEND.CND / WEAV.CND
              </p>
            </div>

            {profilesStore.profiles.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-fg/80">
                  Saved robots ({profilesStore.profiles.length}). Active:{" "}
                  <span className="font-medium text-accent-fg">
                    {activeProfile?.displayName ?? "none"}
                  </span>
                </p>
                <ul className="flex flex-col gap-1" aria-label="Robot profiles">
                  {profilesStore.profiles.map((profile) => {
                    const isActive = profile.id === profilesStore.activeProfileId
                    return (
                      <li
                        key={profile.id}
                        className={
                          isActive
                            ? "flex flex-wrap items-center gap-2 rounded border border-accent/50 bg-accent/10 px-2 py-1.5"
                            : "flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5"
                        }
                      >
                        <span className="text-sm text-fg/90">{profile.displayName}</span>
                        <span className="font-mono text-[11px] text-muted-2">
                          {profile.robotModel || profile.robotId} · {profile.status}
                        </span>
                        {!isActive ? (
                          <button
                            type="button"
                            aria-label={`Set ${profile.displayName} active`}
                            onClick={() => void handleSetActive(profile.id)}
                            className={buttonClass}
                          >
                            Set active
                          </button>
                        ) : (
                          <span className="text-[11px] text-accent-fg">Active</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {activeProfile ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      aria-label="Rename active robot"
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      placeholder={activeProfile.displayName}
                      className="input-field text-sm"
                    />
                    <button
                      type="button"
                      aria-label="Rename active profile"
                      onClick={handleRenameActive}
                      className={buttonClass}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      aria-label="Delete active profile"
                      onClick={handleDeleteActive}
                      className={buttonClass}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-accent-fg" role="status">
                No robot profiles yet — create one from a pendant backup.
              </p>
            )}

            <div className="border-t border-border pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-2">
                Add robot from backup
              </p>
              <p className="font-mono text-xs text-muted-2">
                {backupFolder ?? "No backup folder selected"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label="Choose controller backup folder"
                  disabled={busy}
                  onClick={() => void handlePickBackup()}
                  className={primaryClass}
                >
                  Choose backup folder
                </button>
                <input
                  type="text"
                  aria-label="Optional display name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Display name (optional)"
                  className="input-field text-sm"
                />
                <button
                  type="button"
                  aria-label="Create robot profile"
                  disabled={busy || !backupFolder || Boolean(scan && !scan.ready)}
                  onClick={() => void handleCreateProfile()}
                  className={primaryClass}
                >
                  {busy ? "Working…" : "Create robot profile"}
                </button>
              </div>
              {scan ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-2">Required</p>
                    <ul className="mt-1 space-y-0.5 font-mono text-xs">
                      {scan.required.map((item) => (
                        <li
                          key={item.name}
                          className={item.found ? "text-success" : "text-danger"}
                        >
                          {item.found ? "✓" : "✗"} {item.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs text-muted-2">Recommended</p>
                    <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted">
                      {scan.recommended.map((item) => (
                        <li key={item.name}>
                          {item.found ? "✓" : "·"} {item.name}
                          {typeof item.count === "number" ? ` (${item.count})` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {stepId === "sourceFolder" ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted">
              Point at the folder that contains your <span className="font-mono">.JBI</span> jobs
              (often the same pendant backup, or a JOBS subfolder). This path is{" "}
              <span className="font-medium text-fg/90">read-only</span> — the app never overwrites
              source jobs. The choice is remembered per robot profile for the next launch.
            </p>
            <p className="font-mono text-xs text-muted-2">
              {sourceFolder ?? "No source folder open"}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="Choose source jobs folder"
                onClick={() => void handleOpenSource()}
                className={primaryClass}
              >
                Choose source folder
              </button>
              {sourceFolder ? (
                <button
                  type="button"
                  aria-label="Mark source folder step done"
                  onClick={() => persist(markSetupStep(progress, "sourceFolder", true))}
                  className={buttonClass}
                >
                  Mark done
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {stepId === "outputFolder" ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted">
              When you pick a source folder, the app automatically creates{" "}
              <span className="font-mono text-fg/90">
                &lt;sourceParent&gt;\{OUTPUT_FOLDER_BASENAME}
              </span>{" "}
              if missing and sets it as the output folder. All edited jobs, calibration exports,
              and profile mirrors write there — never into the source backup.
            </p>
            <p className="font-mono text-xs text-muted-2">
              {outputFolder ?? "No output folder set"}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="Choose output folder"
                onClick={() => void handleChooseOutput()}
                className={primaryClass}
              >
                Override output folder…
              </button>
              {outputFolder ? (
                <button
                  type="button"
                  aria-label="Mark output folder step done"
                  onClick={() => persist(markSetupStep(progress, "outputFolder", true))}
                  className={buttonClass}
                >
                  Mark done
                </button>
              ) : null}
            </div>
            <UsbExportPanel outputFolder={outputFolder} />
          </div>
        ) : null}

        {stepId === "cndFiles" ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted">
              Reload UFRAME.CND / TOOL.CND into the kinematics sidecar (usually already loaded when
              the profile was created).
            </p>
            <p className="font-mono text-xs text-muted-2">
              UFRAME: {progress.uframePath ?? activeProfile?.sourceFiles["UFRAME.CND"]?.path ?? "—"}
              <br />
              TOOL: {progress.toolPath ?? activeProfile?.sourceFiles["TOOL.CND"]?.path ?? "—"}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="Load UFRAME and TOOL CND"
                disabled={busy}
                onClick={() => void handleLoadCnd()}
                className={primaryClass}
              >
                {busy ? "Loading…" : "Load UFRAME.CND / TOOL.CND"}
              </button>
              <button
                type="button"
                aria-label="Mark CND step done"
                onClick={() => {
                  persist(markSetupStep(progress, "cndFiles", true))
                  setStatus("CND step marked done.")
                }}
                className={buttonClass}
              >
                Mark done
              </button>
            </div>
          </div>
        ) : null}

        {stepId === "calibration" ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" role="status">
              Setup can continue; editing unlocks after calibration. You may skip this step for
              now — Loaded Jobs browse stays read-only; Diff / Job Editing Wizard writes and transforms stay locked
              until calibration is completed and applied for the active robot.
            </p>
            <p className="text-sm text-fg/80">
              {!activeProfile
                ? "Create a robot profile first."
                : gate.allowed
                  ? `Gate open for ${activeProfile.displayName}.`
                  : gate.reason}
            </p>
            {gate.calibration ? (
              <p className="font-mono text-xs text-muted-2">
                Residual worst {gate.calibration.residuals.worstMm.toFixed(3)} mm / RMS{" "}
                {gate.calibration.residuals.rmsMm.toFixed(3)} mm (threshold{" "}
                {gate.calibration.thresholdMm.toFixed(3)} mm)
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="Open calibration tab"
                onClick={() => onNavigate("calibration")}
                className={primaryClass}
              >
                Open Calibration
              </button>
              <button
                type="button"
                aria-label="Mark calibration applied"
                onClick={handleMarkCalibrationDone}
                className={buttonClass}
              >
                Mark applied (gate open)
              </button>
              <button
                type="button"
                aria-label="Skip calibration for now"
                onClick={handleSkipCalibration}
                className={buttonClass}
              >
                Skip calibration for now
              </button>
            </div>
          </div>
        ) : null}

        {stepId === "safety" ? (
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm text-fg/80">
              <input
                type="checkbox"
                aria-label="Acknowledge never write in place"
                checked={safetyChecks.noInPlace}
                onChange={(event) =>
                  setSafetyChecks({ ...safetyChecks, noInPlace: event.target.checked })
                }
                className="mt-1"
              />
              Never write in-place over backup/USB source jobs
            </label>
            <label className="flex items-start gap-2 text-sm text-fg/80">
              <input
                type="checkbox"
                aria-label="Acknowledge mandatory diff preview"
                checked={safetyChecks.diffFirst}
                onChange={(event) =>
                  setSafetyChecks({ ...safetyChecks, diffFirst: event.target.checked })
                }
                className="mt-1"
              />
              Always preview a unified diff before treating an edit as ready
            </label>
            <label className="flex items-start gap-2 text-sm text-fg/80">
              <input
                type="checkbox"
                aria-label="Acknowledge dry-run first"
                checked={safetyChecks.dryRun}
                onChange={(event) =>
                  setSafetyChecks({ ...safetyChecks, dryRun: event.target.checked })
                }
                className="mt-1"
              />
              Prefer dry-run on the Diff page before the first real write
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="Confirm safety rules"
                onClick={handleConfirmSafety}
                className={primaryClass}
              >
                Confirm safety rules
              </button>
              {minimumDone ? (
                <p className="w-full text-xs text-muted">
                  When ready, use <span className="text-fg/90">Save</span> /{" "}
                  <span className="text-fg/90">Finish setup</span> above to land on Loaded Jobs —
                  do not leave setup open-ended into Manual Editor.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <details className="rounded border border-border bg-surface/50 p-4" open={false}>
        <summary className="cursor-pointer text-sm font-semibold text-fg focus-ring">
          Online (YMConnect)
        </summary>
        <p className="mt-2 text-xs text-muted">
          Primary PC-side kinematics validation:{" "}
          <span className="font-mono">{YMCONNECT_ONLINE_VALIDATION.api}</span>. Soft dependency —
          offline pendant transcription remains available. Motion/Kinematics need YRC1000+ and
          Ethernet per the YMConnect quick start.{" "}
          <span className="text-warn">Cell test pending.</span>
        </p>
        <p className="mt-1 text-xs text-muted-2">{ymBridgeMsg}</p>
        <p className="mt-1 text-xs text-muted">
          <a
            className="text-accent-fg underline underline-offset-2"
            href={YMCONNECT_DOCS.home}
            target="_blank"
            rel="noreferrer"
          >
            YMConnect docs
          </a>
          {" · "}
          <a
            className="text-accent-fg underline underline-offset-2"
            href={YMCONNECT_DOCS.releases}
            target="_blank"
            rel="noreferrer"
          >
            GitHub releases
          </a>
          {" · "}
          <a
            className="text-accent-fg underline underline-offset-2"
            href={YMCONNECT_DOCS.kinematics}
            target="_blank"
            rel="noreferrer"
          >
            ConvertPosition
          </a>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Controller IP
            <input
              aria-label="YMConnect controller IP"
              className="input-field min-w-[10rem] py-1.5 font-mono text-sm"
              value={ymSettings.host}
              onChange={(event) =>
                setYmSettings({ ...ymSettings, host: event.target.value })
              }
              disabled={!activeProfile}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Label
            <input
              aria-label="Controller label"
              className="input-field min-w-[8rem] py-1.5 text-sm"
              value={ymSettings.controllerLabel}
              onChange={(event) =>
                setYmSettings({ ...ymSettings, controllerLabel: event.target.value })
              }
              disabled={!activeProfile}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Group
            <select
              aria-label="YMConnect control group"
              className="input-field py-1.5 text-sm"
              value={ymSettings.controlGroup}
              onChange={(event) =>
                setYmSettings({
                  ...ymSettings,
                  controlGroup: event.target.value as YmConnectConnectionSettings["controlGroup"]
                })
              }
              disabled={!activeProfile}
            >
              {(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"] as const).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label="Save YMConnect connection settings"
            className={buttonClass}
            disabled={!activeProfile}
            onClick={handleSaveYmConnect}
          >
            Save connection
          </button>
        </div>
      </details>

      <details className="rounded border border-border bg-bg/40" open={false}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fg focus-ring">
          Optional: MotoROS2
        </summary>
        <div className="border-t border-border px-1 pb-1">
          <MotoRos2SetupPanel profileId={activeProfile?.id ?? null} hideTitle />
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Previous setup step"
          onClick={handleBack}
          disabled={progress.currentStep === 0}
          className={buttonClass}
        >
          Back
        </button>
        <button
          type="button"
          aria-label="Next setup step"
          onClick={handleNext}
          disabled={progress.currentStep >= SETUP_STEP_ORDER.length - 1}
          className={primaryClass}
        >
          Next
        </button>
        <button
          type="button"
          aria-label="Save setup progress"
          onClick={handleSaveSetup}
          className={buttonClass}
        >
          Save
        </button>
        {minimumDone ? (
          <button
            type="button"
            aria-label="Finish setup and open Loaded Jobs"
            onClick={handleFinishSetup}
            className={primaryClass}
          >
            Finish setup
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Reset setup progress"
          onClick={handleResetProgress}
          className={buttonClass}
        >
          Reset progress
        </button>
        {complete ? (
          <p className="text-sm text-success">Setup complete — including calibration applied.</p>
        ) : minimumDone ? (
          <p className="text-sm text-success">
            Minimum setup done
            {progress.calibrationSkippedForNow ? " (calibration skipped — editing still locked)" : ""}
            . Use Finish setup to close the gate and open Loaded Jobs.
          </p>
        ) : null}
      </div>

      {status ? (
        <p className="text-sm text-fg/80" role="status">
          {status}
        </p>
      ) : null}
    </section>
  )
}
