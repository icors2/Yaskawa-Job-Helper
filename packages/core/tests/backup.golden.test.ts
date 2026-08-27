import { describe, expect, it } from "vitest"
import {
  createProfileFromBackup,
  parseSystemSys,
  profileToParams,
  scanBackup,
  type SystemIdentity
} from "../src/kin/backup"
import { paramsToRecord } from "../src/kin/fk"
import type { RobotProfile } from "../src/kin/types"
import { expectArrayClose, expectPoseClose, readFixture, readGolden } from "./golden"

interface BackupGolden {
  identity: SystemIdentity
  scanEntries: string[]
  scan: {
    requiredNames: string[]
    requiredFound: boolean[]
    recommendedNames: string[]
    recommendedFound: boolean[]
    jbiCount: number
    missingRequired: string[]
    ready: boolean
  }
  profile: Omit<RobotProfile, "id" | "createdAt" | "updatedAt" | "sourceFolder" | "sourceFiles" | "notes">
  profileNotesCount: number
  profileStableNotes: string[]
  profileParams: Record<string, number>
}

const golden = readGolden<BackupGolden>("backup.golden.json")

const FOLDER = "C:\\backups\\DYNAMIC1"
const NOW = "2026-08-26T00:00:00Z"

const buildProfile = (): RobotProfile =>
  createProfileFromBackup(
    {
      systemSys: readFixture("SYSTEM.SYS"),
      rcPrm: readFixture("RC.PRM"),
      toolCnd: readFixture("TOOL.CND"),
      uframeCnd: readFixture("UFRAME.CND")
    },
    {
      folder: FOLDER,
      displayName: "Golden AR2010",
      profileId: "golden",
      now: NOW
    }
  )

describe("SYSTEM.SYS", () => {
  it("matches the Python identity", () => {
    expect(parseSystemSys(readFixture("SYSTEM.SYS"))).toEqual(golden.identity)
  })

  it("falls back to UNKNOWN when there is no R1 line", () => {
    const identity = parseSystemSys("/SYSTEM 8\r\n//APPLI     : ARC WELDING\r\n")
    expect(identity.robotModel).toBe("UNKNOWN")
    expect(identity.displayName).toBe("UNKNOWN")
    expect(identity.application).toBe("ARC WELDING")
    expect(identity.groups).toEqual([])
  })
})

describe("backup scan", () => {
  const scan = scanBackup(FOLDER, golden.scanEntries)

  it("reports the same required and recommended files", () => {
    expect(scan.required.map((item) => item.name)).toEqual(golden.scan.requiredNames)
    expect(scan.required.map((item) => item.found)).toEqual(golden.scan.requiredFound)
    expect(scan.recommended.map((item) => item.name)).toEqual(golden.scan.recommendedNames)
    expect(scan.recommended.map((item) => item.found)).toEqual(golden.scan.recommendedFound)
  })

  it("counts JBI files recursively", () => {
    const jbi = scan.recommended[scan.recommended.length - 1]
    expect(jbi.count).toBe(golden.scan.jbiCount)
  })

  it("agrees on readiness", () => {
    expect(scan.missingRequired).toEqual(golden.scan.missingRequired)
    expect(scan.ready).toBe(golden.scan.ready)
  })

  it("joins found paths onto the folder with its own separator", () => {
    expect(scan.required[0].path).toBe(`${FOLDER}\\SYSTEM.SYS`)
  })

  it("is not ready when a required file is missing", () => {
    const partial = scanBackup(FOLDER, ["SYSTEM.SYS", "RC.PRM"])
    expect(partial.ready).toBe(false)
    expect(partial.missingRequired).toEqual(["TOOL.CND", "UFRAME.CND"])
  })

  it("finds controller files one level down, like CF/USB layouts", () => {
    const nested = scanBackup(FOLDER, [
      "CF/SYSTEM.SYS",
      "CF/RC.PRM",
      "CF/TOOL.CND",
      "CF/UFRAME.CND"
    ])
    expect(nested.ready).toBe(true)
    expect(nested.required[0].path).toBe(`${FOLDER}\\CF/SYSTEM.SYS`)
  })
})

describe("profile from backup", () => {
  const profile = buildProfile()

  it("matches every deterministic Python field", () => {
    const { id, createdAt, updatedAt, sourceFolder, sourceFiles, notes, ...stable } = profile
    expect(id).toBe("golden")
    expect(createdAt).toBe(NOW)
    expect(updatedAt).toBe(NOW)
    expect(sourceFolder).toBe(FOLDER)
    expect(sourceFiles).toEqual({})
    expect(notes.length).toBe(golden.profileNotesCount)
    expect(stable).toEqual(golden.profile)
  })

  it("produces the same notes, apart from the pulse-limit display line", () => {
    for (const note of golden.profileStableNotes) {
      expect(profile.notes, `missing note: ${note}`).toContain(note)
    }
  })

  it("converts to the same kinematic parameters", () => {
    const record = paramsToRecord(profileToParams(profile))
    for (const [key, value] of Object.entries(golden.profileParams)) {
      expect(record[key], `profileParams.${key}`).toBeCloseTo(value, 9)
    }
  })

  it("keeps the AR2010 tool 0 and home pulses", () => {
    expectPoseClose(profile.tool0, golden.profile.tool0, "tool0")
    expectArrayClose(profile.homePulses, golden.profile.homePulses, "homePulses")
    expect(profile.status).toBe("template_validated")
  })

  it("mints an id and timestamp when the caller does not supply them", () => {
    const generated = createProfileFromBackup(
      {
        systemSys: readFixture("SYSTEM.SYS"),
        rcPrm: readFixture("RC.PRM"),
        toolCnd: readFixture("TOOL.CND"),
        uframeCnd: readFixture("UFRAME.CND")
      },
      { folder: FOLDER, newId: () => "minted" }
    )
    expect(generated.id).toBe("minted")
    expect(generated.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(generated.displayName).toBe("AR2010")
  })

  it("rejects an RC.PRM without link lengths", () => {
    expect(() =>
      createProfileFromBackup(
        {
          systemSys: readFixture("SYSTEM.SYS"),
          rcPrm: "//RC YAS\r\n///RCD\r\n1,2,3\r\n",
          toolCnd: readFixture("TOOL.CND"),
          uframeCnd: readFixture("UFRAME.CND")
        },
        { folder: FOLDER }
      )
    ).toThrow(/did not yield link length/)
  })
})
