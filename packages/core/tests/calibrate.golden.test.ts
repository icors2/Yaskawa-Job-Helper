import { describe, expect, it } from "vitest"
import { calibrate, evaluateResiduals, isCalibrated, type CalibPairLocal } from "../src/kin/calibrate"
import { paramsFromRecord, defaultTool } from "../src/kin/fk"
import { parseUframeCnd } from "../src/kin/cnd"
import type { CartesianPose } from "../src/kin/types"
import { expectClose, readFixture, readGolden } from "./golden"

interface CalibrateGolden {
  result: {
    parameters: Record<string, number>
    residuals: { rmsMm: number; worstMm: number; perPair: { xyzMm: number; rotDeg?: number }[] }
    success: boolean
  }
  seedParams: Record<string, number>
  isCalibratedAt1mm: boolean
  isCalibratedAt5mm: boolean
}

const golden = readGolden<CalibrateGolden>("calibrate.golden.json")

const buildPairs = (): { wire: { pulses: number[]; cartesian: CartesianPose; label: string; matchOrientation?: boolean }[]; local: CalibPairLocal[] } => {
  const frames = parseUframeCnd(readFixture("UFRAME.CND"))
  const wire = [
    {
      pulses: [0, -75310, 1200, 0, -127658, -70],
      cartesian: { x: 275, y: 0, z: 875, rx: 180, ry: 45, rz: 0 } satisfies CartesianPose,
      label: "home"
    },
    ...frames.slice(0, 3).map((frame) => ({
      pulses: [...frame.rorg].slice(0, 6),
      cartesian: { ...frame.buser },
      label: `${frame.name}-RORG`,
      matchOrientation: false as const
    }))
  ]
  const local: CalibPairLocal[] = wire.map((pair) => ({
    pulses: pair.pulses,
    cartesian: pair.cartesian,
    weightMm: 1,
    weightRot: 1,
    matchOrientation: "matchOrientation" in pair ? pair.matchOrientation !== false : true,
    label: pair.label,
    frame: "BASE",
    userFrameId: null
  }))
  return { wire, local }
}

describe("calibration against the Python oracle", () => {
  it("evaluates Python-fitted params to 1e-6 mm", () => {
    const { local } = buildPairs()
    const pyParams = paramsFromRecord(golden.result.parameters)
    const report = evaluateResiduals(local, pyParams, { tool: defaultTool() })
    expectClose(report.rmsMm, golden.result.residuals.rmsMm, "rmsMm")
    expectClose(report.worstMm, golden.result.residuals.worstMm, "worstMm")
    expect(isCalibrated(report, 1)).toBe(golden.isCalibratedAt1mm)
    expect(isCalibrated(report, 5)).toBe(golden.isCalibratedAt5mm)
  })

  it("converges the TS LM fit to a usable residual (same pair set)", () => {
    const { wire } = buildPairs()
    const seed = paramsFromRecord(golden.seedParams)
    const result = calibrate(wire, { seed, tool: defaultTool() })
    expect(result.success).toBe(true)
    // Hand-written LM need not match scipy TRF params bit-for-bit; residuals must still gate.
    expect(result.residuals.worstMm).toBeLessThan(5)
    expect(result.residuals.rmsMm).toBeLessThan(1)
  })
})
