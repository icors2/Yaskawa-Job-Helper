import { describe, expect, it } from "vitest"
import {
  defaultParams,
  defaultTool,
  fkPulse,
  forwardKinematics,
  paramsFromRecord,
  paramsToRecord,
  pulsesToDegrees,
  seedPulsePerDegree,
  HOME_CARTESIAN,
  HOME_PULSES,
  type Ar2010Params
} from "../src/kin/fk"
import type { CartesianPose } from "../src/kin/types"
import {
  expectArrayClose,
  expectMatrixClose,
  expectPoseClose,
  readGolden
} from "./golden"

interface FkCase {
  label: string
  pulses: number[]
  tool: CartesianPose | null
  userFrame: CartesianPose | null
  degrees: number[]
  pose: CartesianPose
  flange: CartesianPose
  matrix: number[][]
  flangeMatrix: number[][]
}

interface FkGolden {
  defaultParams: Record<string, number>
  defaultTool: CartesianPose
  homePulses: number[]
  homeCartesian: number[]
  seedPulsePerDegree: number[]
  cases: FkCase[]
  calibratedParams: Record<string, number>
  calibratedCases: { label: string; pulses: number[]; degrees: number[]; pose: CartesianPose }[]
}

const golden = readGolden<FkGolden>("fk.golden.json")

describe("AR2010 parameters", () => {
  it("seeds pulses/degree from the RC.PRM soft limits", () => {
    expectArrayClose(seedPulsePerDegree(), golden.seedPulsePerDegree, "seedPulsePerDegree")
  })

  it("flattens to the sidecar parameter record", () => {
    const record = paramsToRecord(defaultParams())
    expect(Object.keys(record).sort()).toEqual(Object.keys(golden.defaultParams).sort())
    for (const [key, value] of Object.entries(golden.defaultParams)) {
      expect(record[key], `defaultParams.${key}`).toBeCloseTo(value, 9)
    }
  })

  it("reads the sidecar parameter record back", () => {
    const params = paramsFromRecord(golden.calibratedParams)
    expect(paramsToRecord(params)).toEqual(paramsToRecord(paramsFromRecord(golden.calibratedParams)))
    for (const [key, value] of Object.entries(golden.calibratedParams)) {
      expect(paramsToRecord(params)[key], `calibratedParams.${key}`).toBeCloseTo(value, 9)
    }
  })

  it("agrees on the default TOOL 0 and HOME constants", () => {
    expectPoseClose(defaultTool(), golden.defaultTool, "defaultTool")
    expect([...HOME_PULSES]).toEqual(golden.homePulses)
    expect([...HOME_CARTESIAN]).toEqual(golden.homeCartesian)
  })
})

describe("forward kinematics against the Python oracle", () => {
  it("covers every golden case", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(30)
  })

  it.each(golden.cases.map((item) => [item.label, item] as const))(
    "matches Python for %s",
    (label, item) => {
      const result = forwardKinematics(item.pulses, {
        tool: item.tool,
        userFrame: item.userFrame
      })
      expectArrayClose(result.degrees, item.degrees, `${label} degrees`)
      expectPoseClose(result.pose, item.pose, `${label} pose`)
      expectPoseClose(result.flange, item.flange, `${label} flange`)
      expectMatrixClose(result.matrix, item.matrix, `${label} matrix`)
      expectMatrixClose(result.flangeMatrix, item.flangeMatrix, `${label} flangeMatrix`)
    }
  )

  it("reaches the taught HOME cartesian within a millimetre", () => {
    const home = fkPulse(HOME_PULSES)
    expect(Math.abs(home.x - HOME_CARTESIAN[0])).toBeLessThan(1)
    expect(Math.abs(home.y - HOME_CARTESIAN[1])).toBeLessThan(1)
    expect(Math.abs(home.z - HOME_CARTESIAN[2])).toBeLessThan(1)
  })
})

describe("calibrated pulse scales and offsets", () => {
  const params: Ar2010Params = paramsFromRecord(golden.calibratedParams)

  it.each(golden.calibratedCases.map((item) => [item.label, item] as const))(
    "matches Python for %s",
    (label, item) => {
      expectArrayClose(
        pulsesToDegrees(item.pulses, params),
        item.degrees,
        `${label} calibrated degrees`
      )
      expectPoseClose(
        forwardKinematics(item.pulses, { tool: defaultTool(), params }).pose,
        item.pose,
        `${label} calibrated pose`
      )
    }
  )

  it("rejects a zero pulse scale", () => {
    const broken: Ar2010Params = { ...defaultParams(), pulsePerDegree: [1, 1, 0, 1, 1, 1] }
    expect(() => pulsesToDegrees([0, 0, 0, 0, 0, 0], broken)).toThrow(/zero scale/)
  })

  it("rejects fewer than six pulses", () => {
    expect(() => pulsesToDegrees([0, 0, 0])).toThrow(/at least 6/)
  })
})
