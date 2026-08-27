import { describe, expect, it } from "vitest"
import { applyFlip, recipeFromLx } from "../src/kin/stationFlip"
import type { CartesianPose } from "../src/kin/types"
import {
  parsePulsePointsFromJbi,
  scoreStationFlipPair,
  POSITION_RMS_PASS_MAX_MM
} from "../src/kin/validation"

const pose = (
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0
): CartesianPose => ({ x, y, z, rx, ry, rz })

const rngPoses = (count: number, seed: number): CartesianPose[] => {
  let state = seed
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
  const poses: CartesianPose[] = []
  for (let i = 0; i < count; i += 1) {
    poses.push(
      pose(
        next() * 600 - 200,
        next() * 400 - 200,
        next() * 300,
        next() * 80 - 40,
        next() * 80 - 40,
        next() * 80 - 40
      )
    )
  }
  return poses
}

describe("validation harness", () => {
  it("parses pulse rows from JBI text", () => {
    const text = [
      "/JOB",
      "//POS",
      "///NPOS 2,0,0,0,0,0",
      "///TOOL 0",
      "///POSTYPE PULSE",
      "///PULSE",
      "C000=1,2,3,4,5,6",
      "C001=10,20,30,40,50,60",
      "//INST",
      "NOP",
      "END",
      ""
    ].join("\r\n")
    const rows = parsePulsePointsFromJbi(text)
    expect(rows).toEqual([
      [1, 2, 3, 4, 5, 6],
      [10, 20, 30, 40, 50, 60]
    ])
  })

  it("passes a synthetic station-mirror pair inside the RMS band", () => {
    const recipe = recipeFromLx(1245.3, 2, -1)
    const source = rngPoses(20, 11)
    const target = source.map((p) => applyFlip(p, recipe))
    const result = scoreStationFlipPair({
      sourcePoses: source,
      targetPoses: target,
      expectMirror: true,
      pairId: "synthetic-mirror"
    })
    expect(result.verdict).toBe("pass")
    expect(result.fit.accepted).toBe(true)
    expect(result.detR).toBeLessThan(0)
    expect(result.positionRmsMm).toBeLessThanOrEqual(POSITION_RMS_PASS_MAX_MM)
    expect(result.points.length).toBe(20)
    expect(result.worstPointIndex).toBeGreaterThanOrEqual(0)
    expect(result.inliers).toBeGreaterThanOrEqual(Math.ceil(0.6 * 20))
  })

  it("rejects identity pairs as transfer artefacts", () => {
    const source = rngPoses(16, 7)
    const result = scoreStationFlipPair({
      sourcePoses: source,
      targetPoses: source,
      expectMirror: false,
      pairId: "identity-transfer"
    })
    expect(result.verdict).toBe("pass")
    expect(result.fit.accepted).toBe(false)
    expect(result.detR).toBeGreaterThan(0)
  })

  it("fails when a mirror is expected but the pair is a transfer", () => {
    const source = rngPoses(16, 9)
    const result = scoreStationFlipPair({
      sourcePoses: source,
      targetPoses: source,
      expectMirror: true,
      pairId: "bad-expect"
    })
    expect(result.verdict).toBe("fail")
  })
})
