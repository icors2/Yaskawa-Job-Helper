import { describe, expect, it } from "vitest"
import { findFrame, findTool, parseRcPrm, parseToolCnd, parseUframeCnd } from "../src/kin/cnd"
import type { CartesianPose } from "../src/kin/types"
import { expectArrayClose, expectPoseClose, readFixture, readGolden } from "./golden"

interface CndGolden {
  frames: {
    id: number
    name: string
    toolId: number
    rorg: number[]
    rxx: number[]
    rxy: number[]
    buser: CartesianPose
  }[]
  tools: { id: number; name: string; tcp: CartesianPose }[]
  rcPrm: {
    row1: number[]
    row2: number[]
    linkLengthsMm: Record<string, number>
    pulseLimitsPos: number[]
    pulseLimitsNeg: number[]
    hypothesisHolds: boolean
    notesCount: number
    stableNotes: string[]
  }
}

const golden = readGolden<CndGolden>("cnd.golden.json")

describe("UFRAME.CND", () => {
  const frames = parseUframeCnd(readFixture("UFRAME.CND"))

  it("reads every frame the Python parser reads", () => {
    expect(frames.map((frame) => frame.id)).toEqual(golden.frames.map((frame) => frame.id))
  })

  it.each(golden.frames.map((frame) => [frame.id, frame] as const))(
    "matches Python for UFRAME %i",
    (id, expected) => {
      const frame = findFrame(frames, id)
      expect(frame.name).toBe(expected.name)
      expect(frame.toolId).toBe(expected.toolId)
      expectArrayClose(frame.rorg, expected.rorg, `uf${id}.rorg`)
      expectArrayClose(frame.rxx, expected.rxx, `uf${id}.rxx`)
      expectArrayClose(frame.rxy, expected.rxy, `uf${id}.rxy`)
      expectPoseClose(frame.buser, expected.buser, `uf${id}.buser`)
    }
  )

  it("throws for an unknown frame", () => {
    expect(() => findFrame(frames, 99)).toThrow(/user frame 99 not found/)
  })
})

describe("TOOL.CND", () => {
  const tools = parseToolCnd(readFixture("TOOL.CND"))

  it("reads every tool the Python parser reads", () => {
    expect(tools.length).toBe(golden.tools.length)
    expect(tools.map((tool) => tool.id)).toEqual(golden.tools.map((tool) => tool.id))
  })

  it("matches Python TCP and names", () => {
    for (const expected of golden.tools) {
      const tool = findTool(tools, expected.id)
      expect(tool.name, `tool ${expected.id} name`).toBe(expected.name)
      expectPoseClose(tool.tcp, expected.tcp, `tool ${expected.id} tcp`)
    }
  })

  it("throws for an unknown tool", () => {
    expect(() => findTool(tools, 999)).toThrow(/tool 999 not found/)
  })
})

describe("RC.PRM ///RC1G", () => {
  const geometry = parseRcPrm(readFixture("RC.PRM"))

  it("decodes the same link lengths", () => {
    expect(geometry.linkLengthsMm).toEqual(golden.rcPrm.linkLengthsMm)
    expect(geometry.hypothesisHolds).toBe(golden.rcPrm.hypothesisHolds)
  })

  it("decodes the same rows and pulse soft-limits", () => {
    expectArrayClose(geometry.row1, golden.rcPrm.row1, "row1")
    expectArrayClose(geometry.row2, golden.rcPrm.row2, "row2")
    expectArrayClose(geometry.pulseLimitsPos, golden.rcPrm.pulseLimitsPos, "pulseLimitsPos")
    expectArrayClose(geometry.pulseLimitsNeg, golden.rcPrm.pulseLimitsNeg, "pulseLimitsNeg")
  })

  it("produces the same notes, apart from the pulse-limit display line", () => {
    expect(geometry.notes.length).toBe(golden.rcPrm.notesCount)
    for (const note of golden.rcPrm.stableNotes) {
      expect(geometry.notes, `missing note: ${note}`).toContain(note)
    }
  })

  it("falls back to the AR2010 soft-limits when ///RC1G is absent", () => {
    const empty = parseRcPrm("//RC YAS\r\n///RCD\r\n1,2,3\r\n")
    expectArrayClose(empty.pulseLimitsPos, golden.rcPrm.pulseLimitsPos, "fallback pos")
    expectArrayClose(empty.pulseLimitsNeg, golden.rcPrm.pulseLimitsNeg, "fallback neg")
    expect(empty.hypothesisHolds).toBe(false)
  })
})
