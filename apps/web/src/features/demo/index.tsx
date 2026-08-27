/**
 * Interactive station-flip 3D demo page (`/demo`).
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"
import { usePlatform } from "../../context/PlatformContext"
import { getActiveProfile } from "../../lib/profile"
import { DemoCanvas } from "./DemoScene"
import {
  buildDemoModel,
  loadBundledDemoInputs,
  type DemoLayoutMode,
  type DemoModel
} from "./demoModel"

const PLAY_MS = 450

export const DemoPage = () => {
  const { platform, folders, profilesStore } = usePlatform()
  const active = getActiveProfile(profilesStore)

  const [layout, setLayout] = useState<DemoLayoutMode>("overlay")
  const [showTriads, setShowTriads] = useState(true)
  const [showMirrorPlane, setShowMirrorPlane] = useState(true)
  const [scrubIndex, setScrubIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState("Loading demo…")
  const [model, setModel] = useState<DemoModel | null>(null)
  const [jobOptions, setJobOptions] = useState<{ name: string; path: string }[]>([])
  const [selectedJob, setSelectedJob] = useState("")
  const [forceBundled, setForceBundled] = useState(false)
  const playRef = useRef<number | null>(null)

  const canUseLinked = Boolean(platform && folders.sourceReady && !forceBundled)

  useEffect(() => {
    if (!platform || !folders.sourceReady) {
      setJobOptions([])
      return
    }
    let cancelled = false
    void platform.fs
      .listJbi()
      .then((jobs) => {
        if (!cancelled) {
          setJobOptions(jobs)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setJobOptions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [platform, folders.sourceReady])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        if (canUseLinked && platform) {
          const uframeText = await platform.readSourceFile("UFRAME.CND")
          let jobText = ""
          let jobLabel = ""
          if (selectedJob) {
            jobText = await platform.fs.readText(selectedJob)
            jobLabel = selectedJob
          } else {
            const preferred =
              jobOptions.find((job) => /S1/i.test(job.name)) ?? jobOptions[0]
            if (preferred) {
              jobText = await platform.fs.readText(preferred.path)
              jobLabel = preferred.name
              if (!selectedJob) {
                setSelectedJob(preferred.path)
              }
            }
          }
          if (jobText) {
            const next = buildDemoModel({
              uframeText,
              jobText,
              jobLabel,
              profile: active,
              usingBundledFixtures: false,
              layout
            })
            if (!cancelled) {
              setModel(next)
              setScrubIndex(0)
              setStatus(
                `Live: ${jobLabel} · UF2→UF3 · Lx=${next.lx.toFixed(1)} mm · ` +
                  `${next.reachableCount}/${next.pointCount} reachable`
              )
            }
            return
          }
        }

        const bundled = loadBundledDemoInputs()
        const next = buildDemoModel({
          ...bundled,
          profile: active,
          layout
        })
        if (!cancelled) {
          setModel(next)
          setScrubIndex(0)
          setStatus(
            `${bundled.jobLabel} · Lx=${next.lx.toFixed(1)} mm · ` +
              `${next.reachableCount}/${next.pointCount} reachable` +
              (next.failedCount ? ` · ${next.failedCount} fail (red)` : "")
          )
        }
      } catch (error) {
        if (!cancelled) {
          try {
            const bundled = loadBundledDemoInputs()
            const next = buildDemoModel({
              ...bundled,
              profile: active,
              layout
            })
            setModel(next)
            setScrubIndex(0)
            setStatus(
              `Fallback to bundled sample after: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          } catch (fallbackError) {
            setModel(null)
            setStatus(
              fallbackError instanceof Error
                ? fallbackError.message
                : "Could not build demo model"
            )
          }
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [canUseLinked, platform, selectedJob, jobOptions, active, layout, forceBundled])

  useEffect(() => {
    if (!playing || !model) {
      if (playRef.current !== null) {
        window.clearInterval(playRef.current)
        playRef.current = null
      }
      return
    }
    playRef.current = window.setInterval(() => {
      setScrubIndex((prev) => {
        if (!model.pointCount) {
          return 0
        }
        return (prev + 1) % model.pointCount
      })
    }, PLAY_MS)
    return () => {
      if (playRef.current !== null) {
        window.clearInterval(playRef.current)
        playRef.current = null
      }
    }
  }, [playing, model])

  const current = useMemo(() => {
    if (!model) {
      return null
    }
    const src = model.sourcePoints[scrubIndex]
    const dst = model.flippedPoints[scrubIndex]
    return { src, dst }
  }, [model, scrubIndex])

  const handleScrub = (event: ChangeEvent<HTMLInputElement>) => {
    setPlaying(false)
    setScrubIndex(Number.parseInt(event.target.value, 10) || 0)
  }

  const handlePlayToggle = () => {
    setPlaying((prev) => !prev)
  }

  const handleStep = (delta: number) => {
    if (!model) {
      return
    }
    setPlaying(false)
    setScrubIndex((prev) => {
      const next = prev + delta
      if (next < 0) {
        return model.pointCount - 1
      }
      if (next >= model.pointCount) {
        return 0
      }
      return next
    })
  }

  const handleSelectPoint = (index: number) => {
    setPlaying(false)
    setScrubIndex(index)
  }

  const handleLayoutChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setLayout(event.target.value as DemoLayoutMode)
  }

  const handleJobChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedJob(event.target.value)
    setForceBundled(false)
  }

  const handleUseBundled = () => {
    setForceBundled(true)
    setSelectedJob("")
  }

  const handleUseLinked = () => {
    setForceBundled(false)
  }

  return (
    <div className="page-shell !overflow-hidden">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
            Station flip
          </p>
          <h2 className="text-xl font-semibold text-fg">3D Flip Demo</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            UF2 source path, UF3 flipped path, torch triads (keep-Z / flip-Y), mirror plane at
            local x = Lx/2, IK/joint-limit fails in red.
          </p>
        </div>
        <p className="font-mono text-xs text-muted-2" role="status" aria-live="polite">
          {status}
        </p>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="panel flex min-h-0 flex-col overflow-hidden p-2" aria-label="3D viewport">
          {model ? (
            <DemoCanvas
              model={model}
              layout={layout}
              scrubIndex={scrubIndex}
              showTriads={showTriads}
              showMirrorPlane={showMirrorPlane}
              onSelectPoint={handleSelectPoint}
            />
          ) : (
            <div className="flex min-h-[420px] items-center justify-center text-sm text-muted">
              Building scene…
            </div>
          )}
        </section>

        <aside className="panel flex flex-col gap-3 overflow-auto p-4" aria-label="Demo controls">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor="demo-layout">
              Layout
            </label>
            <select
              id="demo-layout"
              className="input-field"
              value={layout}
              onChange={handleLayoutChange}
              aria-label="Overlay or side-by-side layout"
            >
              <option value="overlay">Overlay (cell)</option>
              <option value="sideBySide">Side-by-side (UF local)</option>
            </select>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs text-muted">Overlays</legend>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={showTriads}
                onChange={(event) => setShowTriads(event.target.checked)}
                aria-label="Show torch orientation triads"
              />
              Torch triads
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={showMirrorPlane}
                onChange={(event) => setShowMirrorPlane(event.target.checked)}
                aria-label="Show mirror plane at Lx over 2"
              />
              Mirror plane (x = Lx/2)
            </label>
          </fieldset>

          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted">Path scrub · S1 / S2 step</p>
            <input
              type="range"
              min={0}
              max={Math.max(0, (model?.pointCount ?? 1) - 1)}
              value={scrubIndex}
              onChange={handleScrub}
              className="w-full accent-[var(--app-accent)]"
              aria-label="Scrub along toolpath"
              disabled={!model}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleStep(-1)}
                aria-label="Previous path point"
                disabled={!model}
              >
                Prev
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handlePlayToggle}
                aria-label={playing ? "Pause playback" : "Play along path"}
                disabled={!model}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleStep(1)}
                aria-label="Next path point"
                disabled={!model}
              >
                Next
              </button>
            </div>
            <p className="font-mono text-xs text-muted-2">
              Step {model ? scrubIndex + 1 : 0}/{model?.pointCount ?? 0}
              {current?.dst?.failed ? " · FAIL" : ""}
            </p>
          </div>

          {current?.src && current.dst ? (
            <div className="panel-inset space-y-1 p-2 font-mono text-[11px] text-muted">
              <p className="text-fg">S1 [{scrubIndex}]</p>
              <p>
                {current.src.position.map((n) => n.toFixed(1)).join(", ")}
              </p>
              <p className="pt-1 text-fg">S2 [{scrubIndex}]</p>
              <p className={current.dst.failed ? "text-danger" : ""}>
                {current.dst.position.map((n) => n.toFixed(1)).join(", ")}
              </p>
              <p>{current.dst.message}</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1 border-t border-border pt-3">
            <label className="text-xs text-muted" htmlFor="demo-job">
              Linked job (optional)
            </label>
            <select
              id="demo-job"
              className="input-field"
              value={forceBundled ? "" : selectedJob}
              onChange={handleJobChange}
              aria-label="Select linked source job for demo"
              disabled={!folders.sourceReady || forceBundled}
            >
              <option value="">—</option>
              {jobOptions.map((job) => (
                <option key={job.path} value={job.path}>
                  {job.name}
                </option>
              ))}
            </select>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleUseBundled}
                aria-label="Load bundled DYNAMIC1 sample fixtures"
              >
                Bundled sample
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleUseLinked}
                aria-label="Use linked backup profile and job"
                disabled={!folders.sourceReady}
              >
                Linked backup
              </button>
            </div>
          </div>

          {model ? (
            <dl className="mt-auto space-y-1 border-t border-border pt-3 font-mono text-[11px] text-muted-2">
              <div className="flex justify-between gap-2">
                <dt>Lx</dt>
                <dd className="text-fg">{model.lx.toFixed(2)} mm</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Reach</dt>
                <dd className="text-fg">
                  {model.reachableCount}/{model.pointCount}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Fails</dt>
                <dd className={model.failedCount ? "text-danger" : "text-fg"}>
                  {model.failedCount}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Source</dt>
                <dd className="truncate text-fg" title={model.sourceLabel}>
                  {model.usingBundledFixtures ? "bundled" : "linked"}
                </dd>
              </div>
            </dl>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
