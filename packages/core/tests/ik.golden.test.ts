import { describe, expect, it } from "vitest"
import {
  formatRconf,
  inverseKinematics,
  rconfFromDegrees,
  stationFlipSeed,
  tTurnNumber
} from "../src/kin/ik"
import { defaultParams, defaultTool, forwardKinematics, pulsesToDegrees, HOME_PULSES } from "../src/kin/fk"
import type { CartesianPose } from "../src/kin/types"
import { expectPoseClose, readGolden, TOLERANCE } from "./golden"

interface IkCase {
  label: string
  target: CartesianPose
  seedPulses: number[]
  tryStationFlipSeed: boolean
  result: {
    pose: CartesianPose
    reachable: boolean
    withinLimits: boolean
    positionErrorMm: number
    rconf: number[]
    rconfText: string
  }
}

interface IkGolden {
  homeRconf: number[]
  homeRconfText: string
  stationFlipSeed: number[]
  tTurn: Record<string, number>
  cases: IkCase[]
}

const golden = readGolden<IkGolden>("ik.golden.json")

describe("IK helpers against the Python oracle", () => {
  it("derives HOME RCONF", () => {
    const degrees = pulsesToDegrees(HOME_PULSES)
    const bits = rconfFromDegrees(degrees)
    expect(bits.slice(0, 5)).toEqual(golden.homeRconf.slice(0, 5))
    expect(formatRconf(bits)).toBe(golden.homeRconfText)
  })

  it("builds the station-flip seed", () => {
    expect(stationFlipSeed([10, 20, 30, 40, 50, 60])).toEqual(golden.stationFlipSeed)
  })

  it("matches T-axis turn numbers", () => {
    expect(tTurnNumber(0)).toBe(golden.tTurn["0"])
    expect(tTurnNumber(179.9)).toBe(golden.tTurn["179.9"])
    expect(tTurnNumber(180.1)).toBe(golden.tTurn["180.1"])
    expect(tTurnNumber(-200)).toBe(golden.tTurn["-200"])
  })
})

describe("inverse kinematics against the Python oracle", () => {
  for (const testCase of golden.cases) {
    it(`solves ${testCase.label} to the Python target within 1e-6 mm/deg`, () => {
      const solved = inverseKinematics(testCase.target, testCase.seedPulses, {
        tool: defaultTool(),
        params: defaultParams(),
        tryStationFlipSeed: testCase.tryStationFlipSeed
      })
      expect(solved.reachable).toBe(true)
      expect(solved.withinLimits).toBe(true)
      expect(solved.positionErrorMm).toBeLessThan(0.1)
      // Converged TCP must match the Python solution pose (and thus the target).
      expectPoseClose(solved.pose, testCase.result.pose, `${testCase.label}.pose`)
      const roundtrip = forwardKinematics(solved.pulses, {
        tool: defaultTool(),
        params: defaultParams()
      })
      expectPoseClose(roundtrip.pose, testCase.target, `${testCase.label}.roundtrip`)
      expect(Math.abs(solved.pose.x - testCase.target.x)).toBeLessThan(TOLERANCE)
    })
  }
})
