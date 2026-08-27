import { useEffect, useMemo, useState } from "react"
import type {
  MirrorPlane,
  StationFlipRecipe,
  ToolAxisPreference,
  UserFrame
} from "@yaskawa/core/kin/types"
import type { FitStationFlipResult } from "@yaskawa/core/kin/protocol"
import { TOOL_AXIS_PREFERENCES } from "@yaskawa/core/kin/stationFlip"
import { profileToParams } from "@yaskawa/core/kin/backup"
import {
  deleteStationFlipRecipe,
  jobFamilyKey,
  upsertStationFlipRecipe
} from "@yaskawa/core/robot/profile"
import { usePlatform } from "../../context/PlatformContext"
import { getActiveProfile, getRobotInstallGate } from "../../lib/profile"
import { getCalibrationGate, getEditWriteGate } from "../calibration/storage"
import {
  fitStationFlipFromPair,
  jobStem,
  loadUserFramesFromText,
  parseDeltaText,
  previewFrameFlipJob,
  previewFrameMove,
  previewMirrorJob,
  previewOffsetJob,
  previewStationFlipJob,
  type FrameMovePreview,
  type StationFlipPreview
} from "./frameTransform"

type TransformMode = "transfer" | "mirror" | "offset" | "frameFlip" | "stationFlip"

const ZERO = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }

const TOOL_AXIS_LABELS: Record<ToolAxisPreference, string> = {
  auto: "Auto (best RMS)",
  X: "Tool X",
  Y: "Tool Y",
  XY: "Tool X+Y",
  Z: "Tool Z"
}

const formatUf = (pose: { x: number; y: number; z: number; rx: number; ry: number; rz: number }) =>
  `${pose.x},${pose.y},${pose.z},${pose.rx},${pose.ry},${pose.rz}`

export const TransformPage = () => {
  const { platform, folders, profilesStore, persistProfiles } = usePlatform()
  const [jobs, setJobs] = useState<{ name: string; path: string }[]>([])
  const [jobPath, setJobPath] = useState("")
  const [mode, setMode] = useState<TransformMode>("transfer")
  const [sourceFrameId, setSourceFrameId] = useState(2)
  const [targetFrameId, setTargetFrameId] = useState(3)
  const [mirrorPlane, setMirrorPlane] = useState<MirrorPlane>("XZ")
  const [offsetText, setOffsetText] = useState("0,0,0,0,0,0")
  const [applyToolZFlip, setApplyToolZFlip] = useState(true)
  const [sourceUfText, setSourceUfText] = useState(formatUf(ZERO))
  const [targetUfText, setTargetUfText] = useState(formatUf(ZERO))
  const [frames, setFrames] = useState<UserFrame[]>([])
  const [fitSourcePath, setFitSourcePath] = useState("")
  const [fitTargetPath, setFitTargetPath] = useState("")
  const [fitResult, setFitResult] = useState<FitStationFlipResult | null>(null)
  const [recipeId, setRecipeId] = useState("")
  const [recipeName, setRecipeName] = useState("")
  const [toolAxisPreference, setToolAxisPreference] = useState<ToolAxisPreference>("auto")
  const [reachReport, setReachReport] = useState<StationFlipPreview["reachReport"]>([])
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [familyWarning, setFamilyWarning] = useState<string | null>(null)
  const [preview, setPreview] = useState<FrameMovePreview | null>(null)
  const [outName, setOutName] = useState("")
  const [status, setStatus] = useState(
    "Pick a job from the linked source, choose an operation, Preview, then Write to output."
  )
  const [busy, setBusy] = useState(false)

  const install = getRobotInstallGate()
  const calib = getCalibrationGate()
  const writeGate = getEditWriteGate()
  const active = getActiveProfile(profilesStore)
  const recipes = active?.stationFlipRecipes ?? []
  const selectedRecipe = recipes.find((entry) => entry.id === recipeId) ?? null

  const jobOptions = useMemo(
    () =>
      jobs.filter((job) =>
        job.name.toUpperCase().endsWith(".JBI")
      ),
    [jobs]
  )

  useEffect(() => {
    if (!platform || !folders.sourceReady) {
      setJobs([])
      return
    }
    void platform.fs.listJbi().then(setJobs).catch(() => setJobs([]))
  }, [platform, folders.sourceReady])

  const handleLoadFrames = async () => {
    if (!platform || !folders.sourceReady) {
      setStatus("Link a source backup that contains UFRAME.CND.")
      return
    }
    try {
      const text = await platform.readSourceFile("UFRAME.CND")
      const loaded = loadUserFramesFromText(text)
      setFrames(loaded)
      const src = loaded.find((f) => f.id === sourceFrameId)
      const tgt = loaded.find((f) => f.id === targetFrameId)
      if (src?.buser) {
        setSourceUfText(formatUf(src.buser))
      }
      if (tgt?.buser) {
        setTargetUfText(formatUf(tgt.buser))
      }
      setStatus(`Loaded ${loaded.length} user frame(s) from UFRAME.CND.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load UFRAME.CND")
    }
  }

  const suggestS2Mate = (sourcePath: string): string => {
    const stem = jobStem(sourcePath)
    const mateStem = stem.replace(/([_-])S1(?=([_-]|$))/i, "$1S2").replace(/S1$/i, "S2")
    if (mateStem === stem) {
      return ""
    }
    const mate = jobOptions.find(
      (job) => jobStem(job.path).toUpperCase() === mateStem.toUpperCase()
    )
    return mate?.path ?? ""
  }

  const handleSelectMode = (next: TransformMode) => {
    setMode(next)
    setPreview(null)
    setReachReport([])
    setSaveBlocked(false)
    setFamilyWarning(null)
    if (next === "stationFlip" && !fitSourcePath && jobPath) {
      setFitSourcePath(jobPath)
      const mate = suggestS2Mate(jobPath)
      if (mate) {
        setFitTargetPath(mate)
      }
    }
  }

  const handleFitStationFlip = async () => {
    if (!platform) {
      return
    }
    if (!install.allowed) {
      setStatus(install.reason)
      return
    }
    const sourcePath = fitSourcePath.trim() || jobPath
    const targetPath = fitTargetPath.trim()
    if (!sourcePath || !targetPath) {
      setStatus("Pick a known-good S1 job and its re-taught S2 counterpart to fit a recipe.")
      return
    }
    setBusy(true)
    try {
      const sourceText = await platform.fs.readText(sourcePath)
      const targetText = await platform.fs.readText(targetPath)
      const result = fitStationFlipFromPair({
        sourceText,
        targetText,
        sourceFrameId,
        targetFrameId,
        sourceUf: parseDeltaText(sourceUfText),
        targetUf: parseDeltaText(targetUfText),
        tool: active?.tool0,
        params: active ? profileToParams(active) : undefined,
        sourceJobName: jobStem(sourcePath),
        targetJobName: jobStem(targetPath),
        toolAxisPreference
      })
      setFitResult(result)
      if (result.accepted && result.recipe) {
        const family = result.recipe.jobFamily || jobFamilyKey(sourcePath)
        const lx = result.recipe.offset[0]?.toFixed(1) ?? "?"
        setRecipeName((prev) => prev.trim() || `${family || "station"} Lx ${lx} mm`)
      }
      setStatus(result.message)
    } catch (error) {
      setFitResult(null)
      setStatus(error instanceof Error ? error.message : "Station flip fit failed")
    } finally {
      setBusy(false)
    }
  }

  const handleSaveRecipe = async () => {
    if (!fitResult?.accepted || !fitResult.recipe) {
      setStatus("Fit a valid station flip recipe before saving it to the profile.")
      return
    }
    if (!active) {
      setStatus("No active robot profile — install a robot from a backup first.")
      return
    }
    const family = fitResult.recipe.jobFamily || jobFamilyKey(fitSourcePath || jobPath)
    const name = recipeName.trim() || `${family || "station"} flip`
    const stored: StationFlipRecipe = {
      ...fitResult.recipe,
      id: crypto.randomUUID(),
      name,
      fittedAt: new Date().toISOString(),
      sourceFrameId: fitResult.recipe.sourceFrameId ?? sourceFrameId,
      targetFrameId: fitResult.recipe.targetFrameId ?? targetFrameId,
      jobFamily: family
    }
    await persistProfiles(upsertStationFlipRecipe(profilesStore, active.id, stored))
    setRecipeId(stored.id ?? "")
    setStatus(`Saved recipe “${name}” on profile ${active.displayName}.`)
  }

  const handleDeleteRecipe = async () => {
    if (!active || !selectedRecipe?.id) {
      setStatus("Select a saved recipe to delete.")
      return
    }
    const name = selectedRecipe.name ?? "untitled"
    await persistProfiles(deleteStationFlipRecipe(profilesStore, active.id, selectedRecipe.id))
    setRecipeId("")
    setStatus(`Deleted recipe “${name}”.`)
  }

  const handleStationFlipPreview = async () => {
    if (!platform) {
      return
    }
    const recipe = selectedRecipe ?? (fitResult?.accepted ? fitResult.recipe : null)
    if (!recipe) {
      setStatus("Select a saved recipe or fit one from a reference pair before preview.")
      return
    }
    setBusy(true)
    try {
      const text = await platform.fs.readText(jobPath)
      const result = previewStationFlipJob({
        originalText: text,
        recipe,
        sourceFrameId,
        targetFrameId,
        sourceUf: parseDeltaText(sourceUfText),
        targetUf: parseDeltaText(targetUfText),
        tool: active?.tool0,
        params: active ? profileToParams(active) : undefined,
        pulseLimitsPos: active?.pulseLimitsPos,
        pulseLimitsNeg: active?.pulseLimitsNeg,
        sourceLabel: jobPath,
        toolAxisPreference
      })
      setPreview(result)
      setOutName(result.outName)
      setReachReport(result.reachReport)
      setSaveBlocked(result.saveBlocked)
      setFamilyWarning(result.familyWarning)
      const reachNote = result.saveBlocked
        ? `${result.failedCount} point(s) failed IK or a joint limit — write is blocked.`
        : `All ${result.reachableCount} point(s) reachable.`
      setStatus(
        `Station flip preview: UF${sourceFrameId} → UF${targetFrameId}, ${result.poseCount} pose(s). ${reachNote}`
      )
    } catch (error) {
      setPreview(null)
      setReachReport([])
      setSaveBlocked(false)
      setStatus(error instanceof Error ? error.message : "Station flip preview failed")
    } finally {
      setBusy(false)
    }
  }

  const handlePreview = async () => {
    if (!platform || !jobPath) {
      setStatus("Select a job first.")
      return
    }
    if (!install.allowed) {
      setStatus(install.reason)
      return
    }
    if (mode === "stationFlip") {
      await handleStationFlipPreview()
      return
    }
    setBusy(true)
    try {
      const text = await platform.fs.readText(jobPath)
      const label = jobPath
      let result: FrameMovePreview
      if (mode === "transfer") {
        const srcPose = parseDeltaText(sourceUfText)
        result = previewFrameMove(
          text,
          sourceFrameId,
          targetFrameId,
          active,
          srcPose,
          label
        )
      } else if (mode === "mirror") {
        result = previewMirrorJob(text, mirrorPlane, label)
      } else if (mode === "offset") {
        result = previewOffsetJob(text, parseDeltaText(offsetText), label)
      } else {
        result = previewFrameFlipJob(
          text,
          parseDeltaText(sourceUfText),
          parseDeltaText(targetUfText),
          targetFrameId,
          applyToolZFlip,
          label
        )
      }
      setPreview(result)
      setOutName(result.outName)
      setReachReport([])
      setSaveBlocked(false)
      setFamilyWarning(null)
      setStatus(
        `Preview ready — ${result.poseCount} pose(s).${result.note ? ` ${result.note}` : ""}`
      )
    } catch (error) {
      setPreview(null)
      setStatus(error instanceof Error ? error.message : "Preview failed")
    } finally {
      setBusy(false)
    }
  }

  const handleWrite = async () => {
    if (!platform || !preview) {
      return
    }
    if (saveBlocked) {
      setStatus(
        "Write is blocked — one or more flipped points failed IK or a joint limit. See the reach report."
      )
      return
    }
    if (!writeGate.allowed) {
      setStatus(writeGate.reason)
      return
    }
    if (!folders.outputReady) {
      setStatus("Link an output folder (or enable Downloads) before writing.")
      return
    }
    setBusy(true)
    try {
      const name = outName.trim() || preview.outName
      const written = await platform.fs.writeOutput(name, preview.after)
      setStatus(`Wrote ${written}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Write failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-shell">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold text-fg">Transform</h2>
        <p className="text-sm text-muted">
          Transfer, Mirror, Offset, Frame flip (Flip), and Station flip (mirror) all run in-browser
          via core FK / IK / pose math.
        </p>
        <p className="text-xs text-muted-2">
          Gate: {calib.allowed ? "open" : calib.reason}
        </p>
      </header>

      <section className="panel flex flex-col gap-3 p-4" aria-label="Transform controls">
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="transform-job">
          Source job
          <select
            id="transform-job"
            className="input-field max-w-xl"
            value={jobPath}
            onChange={(event) => {
              const next = event.target.value
              setJobPath(next)
              if (next && !fitSourcePath) {
                setFitSourcePath(next)
                const mate = suggestS2Mate(next)
                if (mate) {
                  setFitTargetPath(mate)
                }
              }
            }}
            aria-label="Select job to transform"
          >
            <option value="">Select…</option>
            {jobOptions.map((job) => (
              <option key={job.path} value={job.path}>
                {job.path}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Transform mode">
          {(
            [
              ["transfer", "Transfer"],
              ["frameFlip", "Frame flip"],
              ["stationFlip", "Station flip (mirror)"],
              ["mirror", "Mirror"],
              ["offset", "Offset"]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={mode === id ? "btn-primary" : "btn-ghost"}
              aria-pressed={mode === id}
              onClick={() => handleSelectMode(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {(mode === "transfer" || mode === "frameFlip" || mode === "stationFlip") && (
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-muted" htmlFor="src-uf">
              Source UF
              <input
                id="src-uf"
                type="number"
                className="input-field ml-2 w-20"
                value={sourceFrameId}
                onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 0)}
              />
            </label>
            <label className="text-xs text-muted" htmlFor="tgt-uf">
              Target UF
              <input
                id="tgt-uf"
                type="number"
                className="input-field ml-2 w-20"
                value={targetFrameId}
                onChange={(event) => setTargetFrameId(Number.parseInt(event.target.value, 10) || 0)}
              />
            </label>
            <button
              type="button"
              className="btn-secondary"
              aria-label="Load user frames from UFRAME.CND"
              onClick={() => void handleLoadFrames()}
            >
              Load UFRAME.CND
            </button>
          </div>
        )}

        {mode === "frameFlip" || mode === "stationFlip" ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs text-muted" htmlFor="src-pose">
              Source UF BUSER (X,Y,Z,Rx,Ry,Rz)
              <input
                id="src-pose"
                className="input-field mt-1 w-full max-w-xl font-mono"
                value={sourceUfText}
                onChange={(event) => setSourceUfText(event.target.value)}
              />
            </label>
            <label className="text-xs text-muted" htmlFor="tgt-pose">
              Target UF BUSER
              <input
                id="tgt-pose"
                className="input-field mt-1 w-full max-w-xl font-mono"
                value={targetUfText}
                onChange={(event) => setTargetUfText(event.target.value)}
              />
            </label>
            {mode === "frameFlip" ? (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={applyToolZFlip}
                  onChange={(event) => setApplyToolZFlip(event.target.checked)}
                />
                Apply tool Z 180°
              </label>
            ) : null}
            {frames.length > 0 ? (
              <p className="font-mono text-[11px] text-muted-2">
                Catalog: {frames.map((f) => `UF${f.id}`).join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}

        {mode === "transfer" ? (
          <label className="text-xs text-muted" htmlFor="transfer-src-pose">
            Source UF pose (for PULSE FK)
            <input
              id="transfer-src-pose"
              className="input-field mt-1 w-full max-w-xl font-mono"
              value={sourceUfText}
              onChange={(event) => setSourceUfText(event.target.value)}
            />
          </label>
        ) : null}

        {mode === "mirror" ? (
          <label className="text-xs text-muted" htmlFor="mirror-plane">
            Plane
            <select
              id="mirror-plane"
              className="input-field ml-2"
              value={mirrorPlane}
              onChange={(event) => setMirrorPlane(event.target.value as MirrorPlane)}
            >
              <option value="XY">XY</option>
              <option value="XZ">XZ</option>
              <option value="YZ">YZ</option>
            </select>
          </label>
        ) : null}

        {mode === "offset" ? (
          <label className="text-xs text-muted" htmlFor="offset-delta">
            Delta X,Y,Z,Rx,Ry,Rz
            <input
              id="offset-delta"
              className="input-field mt-1 w-full max-w-xl font-mono"
              value={offsetText}
              onChange={(event) => setOffsetText(event.target.value)}
            />
          </label>
        ) : null}

        {mode === "stationFlip" ? (
          <div className="panel-inset flex flex-col gap-3 p-3">
            <p className="text-xs text-muted">
              Learn the S1↔S2 reflection from a known-good pair, then apply it to the loaded job. In
              station UF coords <span className="font-mono text-fg/80">x′ = Lx − x</span> with a
              fitted tool-axis correction. Output is{" "}
              <span className="font-mono text-fg/80">///POSTYPE USER</span> on the target frame with
              per-point <span className="font-mono text-fg/80">///RCONF</span>. Unreachable or
              limit-violating points block the write. A recipe is only valid for the fixture family
              it was fitted on.
            </p>

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs text-muted" htmlFor="station-recipe">
                Saved recipe
                <select
                  id="station-recipe"
                  className="input-field font-mono text-xs"
                  aria-label="Saved station flip recipe"
                  value={recipeId}
                  onChange={(event) => {
                    const nextId = event.target.value
                    setRecipeId(nextId)
                    const next = recipes.find((entry) => entry.id === nextId)
                    if (next?.toolAxisPreference) {
                      setToolAxisPreference(next.toolAxisPreference)
                    }
                  }}
                >
                  <option value="">— none (fit a pair first) —</option>
                  {recipes.map((entry) => (
                    <option key={entry.id ?? entry.name} value={entry.id ?? ""}>
                      {entry.name || entry.jobFamily || "untitled"}
                      {typeof entry.offset?.[0] === "number"
                        ? ` (Lx ${entry.offset[0].toFixed(1)} mm)`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-ghost"
                aria-label="Delete selected station flip recipe"
                disabled={busy || !selectedRecipe}
                onClick={() => void handleDeleteRecipe()}
              >
                Delete recipe
              </button>
              <label
                className="flex min-w-[10rem] flex-col gap-1 text-xs text-muted"
                htmlFor="tool-axis-preference"
              >
                Tool axis correction
                <select
                  id="tool-axis-preference"
                  className="input-field font-mono text-xs"
                  aria-label="Tool axis correction preference"
                  value={toolAxisPreference}
                  onChange={(event) =>
                    setToolAxisPreference(event.target.value as ToolAxisPreference)
                  }
                >
                  {TOOL_AXIS_PREFERENCES.map((preference) => (
                    <option key={preference} value={preference}>
                      {TOOL_AXIS_LABELS[preference]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-muted-2">
              Dress package / cable routing may prefer a different tool axis than the lowest-RMS
              pick — re-fit after changing this.
            </p>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-fg">Fit from reference pair</h3>
              <p className="text-xs text-muted">
                Choose a re-taught S1 job and its S2 counterpart in the same point order.
                Transfer-only copies and same-UF pairs are rejected.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted" htmlFor="fit-s1">
                  S1 reference (source)
                  <select
                    id="fit-s1"
                    className="input-field font-mono text-xs"
                    aria-label="Station flip S1 reference job"
                    value={fitSourcePath}
                    onChange={(event) => {
                      const next = event.target.value
                      setFitSourcePath(next)
                      const mate = suggestS2Mate(next)
                      if (mate) {
                        setFitTargetPath(mate)
                      }
                    }}
                  >
                    <option value="">— choose S1 job —</option>
                    {jobOptions.map((job) => (
                      <option key={`s1-${job.path}`} value={job.path}>
                        {job.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted" htmlFor="fit-s2">
                  S2 reference (taught counterpart)
                  <select
                    id="fit-s2"
                    className="input-field font-mono text-xs"
                    aria-label="Station flip S2 reference job"
                    value={fitTargetPath}
                    onChange={(event) => setFitTargetPath(event.target.value)}
                  >
                    <option value="">— choose S2 job —</option>
                    {jobOptions.map((job) => (
                      <option key={`s2-${job.path}`} value={job.path}>
                        {job.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  aria-label="Fit station flip from reference pair"
                  disabled={busy || !fitTargetPath}
                  onClick={() => void handleFitStationFlip()}
                >
                  Fit from reference pair
                </button>
              </div>
            </div>

            {fitResult ? (
              <div className="flex flex-col gap-2" role="status">
                <p className={fitResult.accepted ? "text-xs text-fg/90" : "text-xs text-warn"}>
                  {fitResult.message}
                </p>
                {fitResult.accepted && fitResult.recipe ? (
                  <ul className="font-mono text-[11px] text-muted">
                    <li>Lx,Ly,Lz: {fitResult.recipe.offset.map((v) => v.toFixed(1)).join(", ")} mm</li>
                    <li>
                      RMS {fitResult.positionRmsMm.toFixed(2)} mm /{" "}
                      {fitResult.orientationRmsDeg.toFixed(2)} deg · inliers {fitResult.inliers}/
                      {fitResult.total} · det(R) {fitResult.detR.toFixed(3)}
                    </li>
                    <li>
                      Tool axis: {TOOL_AXIS_LABELS[fitResult.recipe.toolAxisPreference ?? "auto"]}
                    </li>
                  </ul>
                ) : null}
                {fitResult.toolAxisOptions && fitResult.toolAxisOptions.length > 0 ? (
                  <div className="panel-inset p-2" role="region" aria-label="Tool axis orientation RMS">
                    <p className="mb-1 text-[11px] text-muted">
                      Orientation RMS by tool-axis choice (re-fit to apply a different pick):
                    </p>
                    <ul className="font-mono text-[11px] text-muted">
                      {fitResult.toolAxisOptions.map((option) => (
                        <li
                          key={option.preference}
                          className={
                            option.preference === toolAxisPreference ? "text-fg/90" : undefined
                          }
                        >
                          {TOOL_AXIS_LABELS[option.preference]}:{" "}
                          {option.orientationRmsDeg.toFixed(2)} deg
                          {option.preference === toolAxisPreference ? " ← selected" : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {fitResult.accepted ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted" htmlFor="recipe-name">
                      Recipe name
                      <input
                        id="recipe-name"
                        className="input-field font-mono text-xs"
                        aria-label="Station flip recipe name"
                        value={recipeName}
                        onChange={(event) => setRecipeName(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-secondary"
                      aria-label="Save station flip recipe to robot profile"
                      disabled={busy || !active}
                      onClick={() => void handleSaveRecipe()}
                    >
                      Save recipe to profile
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedRecipe ? (
              <p className="text-[11px] text-muted-2" role="status">
                Using recipe {selectedRecipe.name ?? "untitled"}
                {selectedRecipe.sourceJobName
                  ? ` (fitted from ${selectedRecipe.sourceJobName} → ${selectedRecipe.targetJobName ?? "S2"})`
                  : ""}
                {typeof selectedRecipe.offset?.[0] === "number"
                  ? ` · Lx ${selectedRecipe.offset[0].toFixed(1)} mm`
                  : ""}
                {` · RMS ${selectedRecipe.positionRmsMm.toFixed(2)} mm / ${selectedRecipe.orientationRmsDeg.toFixed(2)} deg`}
              </p>
            ) : null}
          </div>
        ) : null}

        {familyWarning ? (
          <p className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" role="status">
            {familyWarning}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            aria-label="Preview transform"
            disabled={busy || !jobPath}
            onClick={() => void handlePreview()}
          >
            Preview
          </button>
          <input
            className="input-field max-w-xs"
            value={outName}
            onChange={(event) => setOutName(event.target.value)}
            aria-label="Output file name"
            placeholder="Output name.JBI"
          />
          <button
            type="button"
            className="btn-secondary"
            aria-label="Write transform to output folder"
            disabled={busy || !preview || !writeGate.allowed || saveBlocked}
            onClick={() => void handleWrite()}
          >
            Write to output
          </button>
        </div>
      </section>

      {reachReport.length > 0 ? (
        <section className="panel flex flex-col gap-2 p-4" aria-label="Station flip reach report">
          <h3 className="text-sm font-semibold text-fg">Reach / RCONF report</h3>
          <p className="text-xs text-muted">
            {reachReport.filter((row) => row.reachable).length}/{reachReport.length} solved within
            joint limits. The limits column separates an out-of-range solution from geometry the arm
            cannot reach. Consecutive points that share RCONF are grouped in the written job.
          </p>
          <div className="panel-inset max-h-64 overflow-auto p-2">
            <table className="w-full text-left font-mono text-[11px] text-fg/80">
              <thead>
                <tr className="text-muted">
                  <th scope="col" className="pr-2">#</th>
                  <th scope="col" className="pr-2">OK</th>
                  <th scope="col" className="pr-2">limits</th>
                  <th scope="col" className="pr-2">err mm</th>
                  <th scope="col" className="pr-2">err deg</th>
                  <th scope="col" className="pr-2">RCONF</th>
                  <th scope="col">note</th>
                </tr>
              </thead>
              <tbody>
                {reachReport.map((row) => (
                  <tr key={row.index} className={row.reachable ? "" : "text-warn"}>
                    <td className="pr-2">{row.index}</td>
                    <td className="pr-2">{row.reachable ? "yes" : "no"}</td>
                    <td className="pr-2">{row.withinLimits ? "ok" : "violation"}</td>
                    <td className="pr-2">{row.positionErrorMm.toFixed(2)}</td>
                    <td className="pr-2">{row.orientationErrorDeg.toFixed(2)}</td>
                    <td className="whitespace-nowrap pr-2">
                      {row.rconfText.split(",").slice(0, 5).join(",")}
                    </td>
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {preview ? (
        <section className="panel flex flex-col gap-2 p-4" aria-label="Preview diff">
          <h3 className="text-sm font-semibold text-fg">Diff</h3>
          <pre className="panel-inset max-h-80 overflow-auto p-3 font-mono text-[11px] text-muted">
            {preview.diffText}
          </pre>
        </section>
      ) : null}

      <p className="text-sm text-muted" role="status">
        {status}
      </p>
    </div>
  )
}
