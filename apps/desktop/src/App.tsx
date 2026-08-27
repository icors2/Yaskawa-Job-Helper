import { useEffect, useState } from "react"
import { Sidebar, type AppPage } from "./components/Sidebar"
import { StatusBar } from "./components/StatusBar"
import { CalibrationPage } from "./features/calibration"
import { DiffPage } from "./features/diff"
import { EditorPage } from "./features/editor"
import { LibraryPage } from "./features/library"
import { SetupGuidePage } from "./features/setup"
import { ProfileGate } from "./features/startup/ProfileGate"
import { TransformPage } from "./features/transform"
import { WizardPage } from "./features/wizard"
import {
  ensureDirectory,
  listJbiFiles,
  pickFolder,
  setOutputFolder,
  setSourceFolder,
  writeOutputFile,
  type JbiEntry
} from "./lib/fs/desktop"
import { ping } from "./lib/kin/client"
import {
  defaultOutputFolderForSource,
  getFolderPrefsForProfile,
  setFolderPrefsForProfile
} from "@yaskawa/core/robot/folders"
import {
  getActiveProfile,
  loadProfilesStore,
  profilesStoreJson,
  ROBOT_PROFILES_FILENAME,
  setActiveProfileId,
  syncActiveProfileToSidecar,
  type RobotProfilesStore
} from "./lib/robot/profile"
import {
  isMinimumSetupComplete,
  isProfileSetupFinished,
  loadSetupProgress,
  shouldForceSetup
} from "@yaskawa/core/setup/progress"
import { getCalibrationGate } from "./features/calibration"

const SESSION_PROFILE_KEY = "yaskawa.session.profileConfirmed.v1"

const readSessionConfirmed = (): boolean => {
  try {
    return sessionStorage.getItem(SESSION_PROFILE_KEY) === "1"
  } catch {
    return false
  }
}

const writeSessionConfirmed = (confirmed: boolean) => {
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

const App = () => {
  const [profilesStore, setProfilesStore] = useState<RobotProfilesStore>(() =>
    loadProfilesStore()
  )
  const [profileConfirmed, setProfileConfirmed] = useState(() => readSessionConfirmed())
  const [setupProgress, setSetupProgress] = useState(() => loadSetupProgress())
  const [page, setPage] = useState<AppPage>("setup")
  const [sourceFolder, setSourceFolderState] = useState<string | null>(null)
  const [outputFolder, setOutputFolderState] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JbiEntry[]>([])
  const [status, setStatus] = useState("Ready")
  const [sidecar, setSidecar] = useState("sidecar: idle")
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [wizardJobPath, setWizardJobPath] = useState<string | null>(null)
  /** Shared active job for Transform / Wizard / Library / Manual Editor. */
  const [activeJobPath, setActiveJobPath] = useState<string | null>(null)

  const activeProfile = getActiveProfile(profilesStore)
  const forceSetup = shouldForceSetup(setupProgress)
  const calibGate = getCalibrationGate()

  useEffect(() => {
    const handlePingSidecar = async () => {
      try {
        const result = await ping()
        setSidecar(`sidecar: ${result.protocol}`)
        await syncActiveProfileToSidecar(loadProfilesStore())
      } catch {
        setSidecar("sidecar: offline")
      }
    }
    void handlePingSidecar()
  }, [])

  const handleApplyFolders = async (
    profileId: string | null,
    source: string | null,
    output: string | null
  ) => {
    if (source) {
      await setSourceFolder(source)
      const listed = await listJbiFiles(source)
      setSourceFolderState(source)
      setJobs(listed)
    } else {
      setSourceFolderState(null)
      setJobs([])
    }
    if (output) {
      await ensureDirectory(output)
      const next = await setOutputFolder(output)
      setOutputFolderState(next.outputFolder)
    } else {
      setOutputFolderState(null)
    }
    setFolderPrefsForProfile(profileId, {
      sourceFolder: source,
      outputFolder: output
    })
  }

  const handleRestoreFoldersForProfile = async (profileId: string) => {
    const prefs = getFolderPrefsForProfile(profileId)
    if (!prefs?.sourceFolder && !prefs?.outputFolder) {
      return
    }
    try {
      await handleApplyFolders(
        profileId,
        prefs.sourceFolder,
        prefs.outputFolder
      )
      if (prefs.sourceFolder) {
        setStatus(
          `Restored source (${prefs.sourceFolder}) and output for this robot.`
        )
      }
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not restore folders: ${error.message}`
          : "Could not restore folders"
      )
    }
  }

  useEffect(() => {
    if (!profileConfirmed || !activeProfile) {
      return
    }
    void handleRestoreFoldersForProfile(activeProfile.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once per confirmed session profile
  }, [profileConfirmed, activeProfile?.id])

  useEffect(() => {
    if (!profileConfirmed || !activeProfile) {
      return
    }
    const progress = loadSetupProgress()
    setSetupProgress(progress)
    const prefs = getFolderPrefsForProfile(activeProfile.id)
    const hasFolders = Boolean(prefs?.sourceFolder && prefs?.outputFolder)
    if (!isProfileSetupFinished(progress, activeProfile.id, hasFolders)) {
      setPage("setup")
      return
    }
    setPage((current) => (current === "setup" ? "library" : current))
  }, [profileConfirmed, activeProfile?.id])

  const handlePersistProfiles = async (store: RobotProfilesStore) => {
    setProfilesStore(store)
    if (!outputFolder) {
      return
    }
    try {
      await writeOutputFile(ROBOT_PROFILES_FILENAME, profilesStoreJson(store))
    } catch {
      /* optional disk mirror */
    }
  }

  const handleOpenSourceWithAutoOutput = async () => {
    const folder = await pickFolder()
    if (!folder) {
      return
    }
    const outPath = defaultOutputFolderForSource(folder)
    try {
      await ensureDirectory(outPath)
      await setSourceFolder(folder)
      const listed = await listJbiFiles(folder)
      const outState = await setOutputFolder(outPath)
      setSourceFolderState(folder)
      setJobs(listed)
      setOutputFolderState(outState.outputFolder)
      setFolderPrefsForProfile(activeProfile?.id ?? null, {
        sourceFolder: folder,
        outputFolder: outState.outputFolder
      })
      setStatus(
        `Source opened (${listed.length} jobs). Output auto-set to ${outState.outputFolder}`
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open folders")
    }
  }

  const handlePickBackupFolder = async (): Promise<string | null> => {
    return pickFolder()
  }

  const handleChooseOutput = async () => {
    const folder = await pickFolder()
    if (!folder) {
      return
    }
    try {
      await ensureDirectory(folder)
      const next = await setOutputFolder(folder)
      setOutputFolderState(next.outputFolder)
      setFolderPrefsForProfile(activeProfile?.id ?? null, {
        outputFolder: next.outputFolder
      })
      setStatus("Output folder set — writes stay here")
      await handlePersistProfiles(profilesStore)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not set output")
    }
  }

  const handleNavigate = (next: AppPage) => {
    if (forceSetup && next !== "setup" && next !== "calibration") {
      setStatus(
        "Finish minimum Setup Guide steps first (folders, CND, safety). Calibration may be skipped for now."
      )
      setPage("setup")
      return
    }
    setPage(next)
  }

  const handleSetActiveJob = (jobPath: string | null) => {
    setActiveJobPath(jobPath)
    if (jobPath) {
      setEditorPath(jobPath)
      setWizardJobPath(jobPath)
    }
  }

  const handleOpenManualEditor = (jobPath?: string) => {
    if (jobPath) {
      setEditorPath(jobPath)
      setActiveJobPath(jobPath)
    }
    handleNavigate("editor")
    setStatus(jobPath ? `Manual Editor — loaded ${jobPath}` : "Manual Editor")
  }

  const handleOpenWizardWithJob = (jobPath: string) => {
    setWizardJobPath(jobPath)
    setActiveJobPath(jobPath)
    handleNavigate("wizard")
    setStatus(`Job Editing Wizard — selected ${jobPath}`)
  }

  const handleOpenTransform = (jobPath?: string | null) => {
    if (jobPath) {
      setActiveJobPath(jobPath)
    }
    handleNavigate("transform")
    setStatus(
      jobPath
        ? `Transform — active job ${jobPath}`
        : activeJobPath
          ? `Transform — active job ${activeJobPath}`
          : "Transform — pick a job from Loaded Jobs"
    )
  }

  const handleSetupDismiss = (message?: string) => {
    const progress = loadSetupProgress()
    setSetupProgress(progress)
    if (!isMinimumSetupComplete(progress)) {
      setStatus("Minimum setup not finished — complete required steps before leaving.")
      return
    }
    setPage("library")
    setStatus(
      message ??
        "Setup finished — opened Loaded Jobs. Calibration may still be required before writes."
    )
  }

  const handleSetupNavigate = (next: "library" | "calibration" | "diff" | "wizard") => {
    handleNavigate(next)
  }

  const handleSetupProgressChange = () => {
    setSetupProgress(loadSetupProgress())
  }

  const handleProfileContinue = async (profileId: string) => {
    writeSessionConfirmed(true)
    setProfileConfirmed(true)
    const store = loadProfilesStore()
    setProfilesStore(store)
    await handleRestoreFoldersForProfile(profileId)
    const progress = loadSetupProgress()
    setSetupProgress(progress)
    const prefs = getFolderPrefsForProfile(profileId)
    const hasFolders = Boolean(prefs?.sourceFolder && prefs?.outputFolder)
    if (isProfileSetupFinished(progress, profileId, hasFolders)) {
      setPage("library")
      setStatus("Robot selected — opened Loaded Jobs.")
      return
    }
    setPage("setup")
    setStatus(
      "Robot selected — complete the Setup Guide (calibration can be skipped for now)."
    )
  }

  const handleSelectRobot = async (profileId: string) => {
    if (profileId === "__add__") {
      writeSessionConfirmed(false)
      setProfileConfirmed(false)
      setStatus("Add a robot profile.")
      return
    }
    if (profileId === "__switch__") {
      writeSessionConfirmed(false)
      setProfileConfirmed(false)
      return
    }
    try {
      const next = setActiveProfileId(loadProfilesStore(), profileId)
      await handlePersistProfiles(next)
      await syncActiveProfileToSidecar(next)
      await handleRestoreFoldersForProfile(profileId)
      const active = getActiveProfile(next)
      setStatus(
        active
          ? `Active robot: ${active.displayName}`
          : "No active robot"
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not switch robot")
    }
  }

  if (!profileConfirmed) {
    return (
      <ProfileGate
        profilesStore={profilesStore}
        onProfilesStoreChange={(store) => void handlePersistProfiles(store)}
        onPickBackupFolder={handlePickBackupFolder}
        onContinue={(id) => void handleProfileContinue(id)}
      />
    )
  }

  const renderPage = () => {
    if (page === "setup") {
      return (
        <SetupGuidePage
          sourceFolder={sourceFolder}
          outputFolder={outputFolder}
          profilesStore={profilesStore}
          onProfilesStoreChange={(store) => void handlePersistProfiles(store)}
          onOpenSourceFolder={handleOpenSourceWithAutoOutput}
          onChooseOutputFolder={handleChooseOutput}
          onPickBackupFolder={handlePickBackupFolder}
          onNavigate={handleSetupNavigate}
          onDismiss={handleSetupDismiss}
          onProgressChange={handleSetupProgressChange}
          forced={!isMinimumSetupComplete(setupProgress)}
        />
      )
    }
    if (page === "wizard") {
      return (
        <WizardPage
          sourceFolder={sourceFolder}
          outputFolder={outputFolder}
          jobs={jobs}
          initialJobPath={wizardJobPath ?? activeJobPath}
          onOpenManualEditor={handleOpenManualEditor}
          onNavigateTransform={(jobPath) => handleOpenTransform(jobPath)}
          onNavigateCalibration={() => handleNavigate("calibration")}
          onOpenSourceFolder={handleOpenSourceWithAutoOutput}
          onOpenSetup={() => handleNavigate("setup")}
          onActiveJobChange={handleSetActiveJob}
        />
      )
    }
    if (page === "library") {
      return (
        <LibraryPage
          sourceFolder={sourceFolder}
          jobs={jobs}
          activeJobPath={activeJobPath}
          onOpenFolder={handleOpenSourceWithAutoOutput}
          onEditInWizard={handleOpenWizardWithJob}
          onEditInManualEditor={handleOpenManualEditor}
          onSelectJob={handleSetActiveJob}
          onOpenTransform={(path) => handleOpenTransform(path)}
        />
      )
    }
    if (page === "editor") {
      return (
        <EditorPage
          sourceFolder={sourceFolder}
          initialPath={editorPath ?? activeJobPath}
          onActiveJobChange={handleSetActiveJob}
          onNavigateTransform={(jobPath) => handleOpenTransform(jobPath)}
        />
      )
    }
    if (page === "calibration") {
      return (
        <CalibrationPage outputFolder={outputFolder} sourceFolder={sourceFolder} />
      )
    }
    if (page === "transform") {
      return (
        <TransformPage
          jobs={jobs}
          activeJobPath={activeJobPath}
          onActiveJobChange={handleSetActiveJob}
          onOpenSetup={() => handleNavigate("setup")}
          onOpenLibrary={() => handleNavigate("library")}
          onOpenDiff={() => handleNavigate("diff")}
          outputFolder={outputFolder}
        />
      )
    }
    return <DiffPage outputFolder={outputFolder} />
  }

  return (
    <div className="flex h-screen flex-col bg-bg font-sans text-fg">
      <div className="brand-bar shrink-0" aria-hidden="true" />
      <div className="flex min-h-0 flex-1">
        <Sidebar page={page} onNavigate={handleNavigate} jobCount={jobs.length} />
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border bg-surface px-4 py-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              <span className="shrink-0">Robot:</span>
              <select
                aria-label="Active robot profile"
                value={profilesStore.activeProfileId ?? ""}
                onChange={(event) => void handleSelectRobot(event.target.value)}
                className="input-field max-w-[14rem] py-1 text-xs"
              >
                {profilesStore.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.displayName}
                    {profile.status === "unvalidated" ? " (unvalidated)" : ""}
                  </option>
                ))}
                <option value="__add__">Add robot…</option>
                <option value="__switch__">Choose robot at startup…</option>
              </select>
            </label>
            <button
              type="button"
              aria-label="Open setup guide"
              onClick={() => handleNavigate("setup")}
              className="btn-ghost px-2.5 py-1 text-xs"
            >
              Setup Guide
            </button>
            <button
              type="button"
              aria-label="Choose output folder"
              onClick={() => void handleChooseOutput()}
              className="btn-ghost px-2.5 py-1 text-xs"
            >
              Output folder
            </button>
          </div>
          {forceSetup ? (
            <div
              className="border-b border-accent/40 bg-accent/10 px-4 py-1.5 text-xs text-accent-fg"
              role="status"
            >
              Forced setup — finish source/output folders, CND, and safety. Calibration may be
              skipped for now; job writes stay locked until calibration is applied.
            </div>
          ) : !calibGate.allowed ? (
            <div
              className="border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-warn"
              role="status"
            >
              Setup can continue; editing unlocks after calibration. {calibGate.reason}{" "}
              <button
                type="button"
                aria-label="Open calibration"
                onClick={() => handleNavigate("calibration")}
                className="underline underline-offset-2 hover:text-fg focus-ring"
              >
                Open Calibration
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">{renderPage()}</div>
        </main>
      </div>
      <StatusBar
        message={status}
        sidecar={sidecar}
        outputFolder={outputFolder}
        activeRobot={activeProfile?.displayName ?? null}
        onOpenSetup={() => handleNavigate("setup")}
      />
    </div>
  )
}

export default App
