import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react"
import {
  createPlatform,
  syncKeyToIdb,
  tierHint,
  tierLabel,
  type LinkedFolders,
  type PlatformApi
} from "../platform"
import {
  loadProfilesStore,
  profilesStoreJson,
  ROBOT_PROFILES_STORAGE_KEY,
  type RobotProfilesStore
} from "@yaskawa/core/robot/profile"

interface PlatformContextValue {
  ready: boolean
  error: string | null
  platform: PlatformApi | null
  folders: LinkedFolders
  tierName: string
  tierDescription: string
  profilesStore: RobotProfilesStore
  setProfilesStore: (store: RobotProfilesStore) => void
  persistProfiles: (store: RobotProfilesStore) => Promise<void>
  refreshFolders: () => Promise<void>
  handleReconnectSource: () => Promise<void>
  handleReconnectOutput: () => Promise<void>
}

const PlatformContext = createContext<PlatformContextValue | null>(null)

export const PlatformProvider = ({ children }: { children: ReactNode }) => {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [platform, setPlatform] = useState<PlatformApi | null>(null)
  const [folders, setFolders] = useState<LinkedFolders>({
    sourceLabel: null,
    outputLabel: null,
    sourceReady: false,
    outputReady: false,
    sourceNeedsReconnect: false,
    outputNeedsReconnect: false
  })
  const [profilesStore, setProfilesStore] = useState<RobotProfilesStore>(() =>
    loadProfilesStore()
  )

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const api = await createPlatform()
        if (cancelled) {
          return
        }
        setPlatform(api)
        setFolders(api.folders())
        setProfilesStore(loadProfilesStore())
        setReady(true)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Platform init failed")
          setReady(true)
        }
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshFolders = useCallback(async () => {
    if (!platform) {
      return
    }
    const next = await platform.refreshPermissionState()
    setFolders(next)
  }, [platform])

  const persistProfiles = useCallback(
    async (store: RobotProfilesStore) => {
      setProfilesStore(store)
      await syncKeyToIdb(ROBOT_PROFILES_STORAGE_KEY)
      if (platform) {
        const mirrored = await platform.mirrorProfilesJson(profilesStoreJson(store))
        if (mirrored) {
          // Folder is source of truth when linked; browser is a cache.
        }
      }
    },
    [platform]
  )

  const handleReconnectSource = useCallback(async () => {
    if (!platform) {
      return
    }
    await platform.reconnectSource()
    setFolders(platform.folders())
  }, [platform])

  const handleReconnectOutput = useCallback(async () => {
    if (!platform) {
      return
    }
    await platform.reconnectOutput()
    setFolders(platform.folders())
  }, [platform])

  const value = useMemo<PlatformContextValue>(
    () => ({
      ready,
      error,
      platform,
      folders,
      tierName: platform ? tierLabel(platform.tier) : "…",
      tierDescription: platform ? tierHint(platform.tier) : "",
      profilesStore,
      setProfilesStore,
      persistProfiles,
      refreshFolders,
      handleReconnectSource,
      handleReconnectOutput
    }),
    [
      ready,
      error,
      platform,
      folders,
      profilesStore,
      persistProfiles,
      refreshFolders,
      handleReconnectSource,
      handleReconnectOutput
    ]
  )

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
}

export const usePlatform = (): PlatformContextValue => {
  const ctx = useContext(PlatformContext)
  if (!ctx) {
    throw new Error("usePlatform must be used within PlatformProvider")
  }
  return ctx
}
