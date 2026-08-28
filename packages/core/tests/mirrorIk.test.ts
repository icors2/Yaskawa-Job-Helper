import { describe, expect, it } from "vitest"
import { applyMirrorToWire, applyMirrorWithIk, mirrorPose } from "../src/kin/transforms"
import type { CartesianPose } from "../src/kin/types"

const UF: CartesianPose = {
  x: 1200,
  y: 0,
  z: 0,
  rx: 180,
  ry: 0,
  rz: 0
}

const NEAR: CartesianPose = {
  x: 200,
  y: -50,
  z: 100,
  rx: 180,
  ry: 0,
  rz: 0
}

describe("applyMirrorWithIk", () => {
  it("returns mirrored UF poses and RCONF text for reachable points", () => {
    const points = applyMirrorWithIk({
      plane: "YZ",
      uf: UF,
      sourcePoses: [NEAR]
    })
    expect(points).toHaveLength(1)
    const expected = mirrorPose(NEAR, "YZ").pose
    expect(points[0].pose.x).toBeCloseTo(expected.x, 3)
    expect(points[0].ik.rconfText.split(",")).toHaveLength(24)
    const wired = applyMirrorToWire(points, 2)
    expect(wired.retainedUserFrameId).toBe(2)
    expect(wired.poses).toHaveLength(1)
  })

  it("sets saveBlocked when a pose is unreachable", () => {
    const far: CartesianPose = {
      x: 50000,
      y: 50000,
      z: 50000,
      rx: 0,
      ry: 0,
      rz: 0
    }
    const points = applyMirrorWithIk({
      plane: "XZ",
      uf: UF,
      sourcePoses: [far]
    })
    const wired = applyMirrorToWire(points, 2)
    expect(wired.saveBlocked).toBe(true)
    expect(wired.failedCount).toBeGreaterThan(0)
    expect(wired.reachableCount).toBe(0)
  })
})
