import { useEffect, useState } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { Sidebar } from "./components/Sidebar"
import { StatusBar } from "./components/StatusBar"
import { usePlatform } from "./context/PlatformContext"
import { CalibrationPage } from "./features/calibration"
import { DemoPage } from "./features/demo"
import { ProfilesPage, readSessionConfirmed } from "./features/profiles"
import { TransformPage } from "./features/transform"
import { ValidatePage } from "./features/validate"
import { getActiveProfile } from "./lib/profile"
import type { JbiEntry } from "./platform"

const AppShell = () => {
  const { ready, error, platform, folders, tierName, profilesStore } = usePlatform()
  const [status, setStatus] = useState("Starting…")
  const [jobCount, setJobCount] = useState(0)
  const active = getActiveProfile(profilesStore)
  const confirmed = readSessionConfirmed()

  useEffect(() => {
    if (!ready) {
      setStatus("Loading platform…")
      return
    }
    if (error) {
      setStatus(error)
      return
    }
    if (!platform) {
      setStatus("Platform unavailable")
      return
    }
    const bits = [
      folders.sourceReady ? `source:${folders.sourceLabel}` : "source:—" ,
      folders.outputReady ? `output:${folders.outputLabel}` : "output:—",
      platform.tier
    ]
    setStatus(bits.join(" · "))
  }, [ready, error, platform, folders])

  useEffect(() => {
    if (!platform || !folders.sourceReady) {
      setJobCount(0)
      return
    }
    let cancelled = false
    void platform.fs
      .listJbi()
      .then((jobs: JbiEntry[]) => {
        if (!cancelled) {
          setJobCount(jobs.length)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setJobCount(0)
        }
      })
    return () => {
      cancelled = true
    }
  }, [platform, folders.sourceReady, folders.sourceLabel])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-muted">
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg p-6 text-fg">
        <p className="text-danger">Platform failed to start</p>
        <p className="text-sm text-muted">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="flex min-h-0 flex-1">
        <Sidebar jobCount={jobCount} />
        <main className="min-w-0 flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Navigate to={confirmed && active ? "/transform" : "/profiles"} replace />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/calibration" element={<CalibrationPage />} />
            <Route path="/transform" element={<TransformPage />} />
            <Route path="/demo" element={<DemoPage />} />
            <Route path="/validate" element={<ValidatePage />} />
            <Route path="*" element={<Navigate to="/profiles" replace />} />
          </Routes>
        </main>
      </div>
      <StatusBar
        status={status}
        tierName={tierName}
        profileName={active?.displayName ?? null}
      />
    </div>
  )
}

const App = () => <AppShell />

export default App
