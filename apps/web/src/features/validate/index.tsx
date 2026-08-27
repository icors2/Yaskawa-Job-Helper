import { useEffect, useMemo, useState } from "react"
import { findFrame, findTool, parseToolCnd, parseUframeCnd } from "@yaskawa/core/kin/cnd"
import type { CartesianPose } from "@yaskawa/core/kin/types"
import {
  DYNAMIC1_MIRROR_PAIRS,
  DYNAMIC1_TRANSFER_PAIRS,
  scoreStationFlipFromJobText,
  type KnownJobPair,
  type TransformValidationResult,
  type ValidationVerdict
} from "@yaskawa/core/kin/validation"
import { usePlatform } from "../../context/PlatformContext"
import { getActiveProfile, paramsFromProfileReady } from "./helpers"

const ZERO: CartesianPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }

const verdictClass = (verdict: ValidationVerdict): string => {
  if (verdict === "pass") {
    return "border-success bg-success/15 text-success"
  }
  if (verdict === "warn") {
    return "border-warn bg-warn/15 text-warn"
  }
  return "border-danger bg-danger/15 text-danger"
}

const verdictLabel = (verdict: ValidationVerdict): string => {
  if (verdict === "pass") {
    return "PASS"
  }
  if (verdict === "warn") {
    return "WARN"
  }
  return "FAIL"
}

const SUGGESTED_PAIRS: KnownJobPair[] = [
  ...DYNAMIC1_MIRROR_PAIRS,
  ...DYNAMIC1_TRANSFER_PAIRS
]

export const ValidatePage = () => {
  const { platform, folders } = usePlatform()
  const [jobs, setJobs] = useState<{ name: string; path: string }[]>([])
  const [sourcePath, setSourcePath] = useState("")
  const [targetPath, setTargetPath] = useState("")
  const [expectMirror, setExpectMirror] = useState(true)
  const [sourceFrameId, setSourceFrameId] = useState(2)
  const [targetFrameId, setTargetFrameId] = useState(3)
  const [ufSource, setUfSource] = useState<CartesianPose>(ZERO)
  const [ufTarget, setUfTarget] = useState<CartesianPose>(ZERO)
  const [toolOverride, setToolOverride] = useState<CartesianPose | null>(null)
  const [framesLoaded, setFramesLoaded] = useState(false)
  const [result, setResult] = useState<TransformValidationResult | null>(null)
  const [status, setStatus] = useState(
    "Pick a source job and its known-good counterpart, load UF frames, then Score."
  )
  const [busy, setBusy] = useState(false)

  const active = getActiveProfile()
  const { params, tool: profileTool } = paramsFromProfileReady(active)
  const tool = toolOverride ?? profileTool

  const jobOptions = useMemo(
    () => jobs.filter((job) => job.name.toUpperCase().endsWith(".JBI")),
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
      setStatus("Link a source backup that contains UFRAME.CND and TOOL.CND.")
      return
    }
    try {
      const uframeText = await platform.readSourceFile("UFRAME.CND")
      const toolText = await platform.readSourceFile("TOOL.CND")
      const frames = parseUframeCnd(uframeText)
      const tools = parseToolCnd(toolText)
      const src = findFrame(frames, sourceFrameId)
      const tgt = findFrame(frames, targetFrameId)
      if (!src.buser || !tgt.buser) {
        setStatus("Selected user frames are missing BUSER poses.")
        return
      }
      setUfSource(src.buser)
      setUfTarget(tgt.buser)
      const tcp = findTool(tools, 0).tcp
      if (tcp) {
        setToolOverride(tcp)
      }
      setFramesLoaded(true)
      setStatus(
        `Loaded UF${sourceFrameId} / UF${targetFrameId} BUSER and tool0 from linked backup (${frames.length} frames).`
      )
    } catch (error) {
      setFramesLoaded(false)
      setStatus(error instanceof Error ? error.message : "Could not load frames")
    }
  }

  const handleApplySuggested = (pair: KnownJobPair) => {
    const source = jobOptions.find(
      (job) => job.name.toUpperCase() === pair.sourceFile.toUpperCase()
    )
    const target = jobOptions.find(
      (job) => job.name.toUpperCase() === pair.targetFile.toUpperCase()
    )
    if (source) {
      setSourcePath(source.path)
    }
    if (target) {
      setTargetPath(target.path)
    }
    setExpectMirror(pair.expectMirror)
    setStatus(
      source && target
        ? `Loaded suggested pair ${pair.id}`
        : `Pair ${pair.id} not fully present in linked source (found source=${Boolean(source)} target=${Boolean(target)})`
    )
  }

  const handleScore = async () => {
    if (!platform || !sourcePath || !targetPath) {
      setStatus("Select both source and counterpart jobs.")
      return
    }
    if (!framesLoaded) {
      setStatus("Load UF frames from UFRAME.CND first.")
      return
    }
    setBusy(true)
    try {
      const sourceText = await platform.fs.readText(sourcePath)
      const targetText = await platform.fs.readText(targetPath)
      const scored = scoreStationFlipFromJobText({
        sourceText,
        targetText,
        ufSource,
        ufTarget,
        tool,
        params,
        profile: active,
        sourceFrameId,
        targetFrameId,
        sourceJobName: sourcePath.replace(/\.JBI$/i, ""),
        targetJobName: targetPath.replace(/\.JBI$/i, ""),
        pairId: `${sourcePath}→${targetPath}`,
        expectMirror
      })
      setResult(scored)
      setStatus(scored.message)
    } catch (error) {
      setResult(null)
      setStatus(error instanceof Error ? error.message : "Validation failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-shell">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold text-fg">Validate</h2>
        <p className="text-sm text-muted">
          Score a station-flip transform against a known-good re-taught counterpart.
          Position RMS should stay near the measured 2–64 mm band; transfer artefacts
          must be rejected.
        </p>
      </header>

      <section className="panel flex flex-col gap-3 p-4" aria-label="Validation controls">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleLoadFrames()}
            aria-label="Load user frames from UFRAME.CND"
          >
            Load UF frames
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !sourcePath || !targetPath}
            onClick={() => void handleScore()}
            aria-label="Score station flip against counterpart"
          >
            {busy ? "Scoring…" : "Score transform"}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="validate-source">
            Source job (S1)
            <select
              id="validate-source"
              className="input-field"
              value={sourcePath}
              onChange={(event) => setSourcePath(event.target.value)}
              aria-label="Select source job"
            >
              <option value="">Select…</option>
              {jobOptions.map((job) => (
                <option key={job.path} value={job.path}>
                  {job.path}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="validate-target">
            Known-good counterpart (S2)
            <select
              id="validate-target"
              className="input-field"
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
              aria-label="Select counterpart job"
            >
              <option value="">Select…</option>
              {jobOptions.map((job) => (
                <option key={`t-${job.path}`} value={job.path}>
                  {job.path}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="validate-src-uf">
            Source UF
            <input
              id="validate-src-uf"
              className="input-field w-20"
              type="number"
              value={sourceFrameId}
              onChange={(event) => setSourceFrameId(Number.parseInt(event.target.value, 10) || 2)}
              aria-label="Source user frame id"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted" htmlFor="validate-tgt-uf">
            Target UF
            <input
              id="validate-tgt-uf"
              className="input-field w-20"
              type="number"
              value={targetFrameId}
              onChange={(event) => setTargetFrameId(Number.parseInt(event.target.value, 10) || 3)}
              aria-label="Target user frame id"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-fg" htmlFor="validate-expect-mirror">
            <input
              id="validate-expect-mirror"
              type="checkbox"
              checked={expectMirror}
              onChange={(event) => setExpectMirror(event.target.checked)}
              aria-label="Expect station mirror acceptance"
            />
            Expect station mirror (uncheck for transfer-rejection check)
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wider text-muted-2">Suggested DYNAMIC1 pairs</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_PAIRS.map((pair) => (
              <button
                key={pair.id}
                type="button"
                className="btn-ghost text-xs"
                onClick={() => handleApplySuggested(pair)}
                aria-label={`Load suggested pair ${pair.id}`}
              >
                {pair.id}
                {pair.expectMirror ? "" : " (reject)"}
              </button>
            ))}
          </div>
        </div>

        <p className="text-sm text-muted" role="status">
          {status}
        </p>
      </section>

      {result ? (
        <section className="panel flex flex-col gap-4 p-4" aria-label="Validation result">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded border px-3 py-1 font-mono text-sm font-semibold ${verdictClass(result.verdict)}`}
              aria-label={`Verdict ${verdictLabel(result.verdict)}`}
            >
              {verdictLabel(result.verdict)}
            </span>
            <p className="text-sm text-fg">{result.message}</p>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-2">Position RMS</dt>
              <dd className="font-mono text-fg">{result.positionRmsMm.toFixed(2)} mm</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-2">Orientation RMS</dt>
              <dd className="font-mono text-fg">{result.orientationRmsDeg.toFixed(2)} deg</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-2">Inliers</dt>
              <dd className="font-mono text-fg">
                {result.inliers}/{result.total}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-2">Worst point</dt>
              <dd className="font-mono text-fg">
                #{result.worstPointIndex} · {result.worstPositionErrorMm.toFixed(2)} mm
              </dd>
            </div>
          </dl>

          {!result.recipe ? (
            <p className="text-xs text-muted-2">
              No accepted recipe — predicted column shows source UF poses (transform not applied).
            </p>
          ) : null}

          <div className="overflow-auto panel-inset">
            <table className="min-w-full text-left text-xs" aria-label="Per-point residuals">
              <thead className="border-b border-border text-muted-2">
                <tr>
                  <th className="px-2 py-2 font-medium">#</th>
                  <th className="px-2 py-2 font-medium">Pos err (mm)</th>
                  <th className="px-2 py-2 font-medium">Ori err (deg)</th>
                  <th className="px-2 py-2 font-medium">Inlier</th>
                  <th className="px-2 py-2 font-medium">Predicted XYZ</th>
                  <th className="px-2 py-2 font-medium">Target XYZ</th>
                </tr>
              </thead>
              <tbody>
                {result.points.map((point) => (
                  <tr
                    key={point.index}
                    className={
                      point.index === result.worstPointIndex
                        ? "bg-danger/10 text-fg"
                        : "text-fg"
                    }
                  >
                    <td className="px-2 py-1 font-mono">{point.index}</td>
                    <td className="px-2 py-1 font-mono">{point.positionErrorMm.toFixed(2)}</td>
                    <td className="px-2 py-1 font-mono">{point.orientationErrorDeg.toFixed(2)}</td>
                    <td className="px-2 py-1">{point.isInlier ? "yes" : "no"}</td>
                    <td className="px-2 py-1 font-mono">
                      {point.predictedPose.x.toFixed(1)},{point.predictedPose.y.toFixed(1)},
                      {point.predictedPose.z.toFixed(1)}
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {point.targetPose.x.toFixed(1)},{point.targetPose.y.toFixed(1)},
                      {point.targetPose.z.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}
