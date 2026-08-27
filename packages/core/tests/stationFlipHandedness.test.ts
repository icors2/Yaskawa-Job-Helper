/**
 * Right-handedness of the station-flip product and the operator tool-axis pin.
 *
 * No Python oracle here — `kinematics/station_flip.py` stays auto-only and does
 * not carry the sign fix, so these are pure TypeScript invariants.
 */

import { describe, expect, it } from "vitest"
import {
  MIRROR_X,
  TOOL_AXIS_PREFERENCES,
  TOOL_Y_FLIP,
  applyFlip,
  fitFlip,
  flipRecipeFromDict,
  flipRecipeToStation,
  normalizeToolAxisPreference,
  recipeFromLx,
  svdToolCorrection,
  type FlipRecipe
} from "../src/kin/stationFlip"
import {
  assertRightHanded,
  multiply3,
  poseToMatrix,
  rotationOf,
  transpose3,
  type Mat3
} from "../src/kin/pose"
import { det3, orthogonalFactor } from "../src/kin/solve/svd3"
import type { CartesianPose, ToolAxisPreference } from "../src/kin/types"
import { expectClose, expectMatrixClose } from "./golden"

/** diag(-1, -1, 1) — a proper 180° rotation about Z, so det(F) = +1. */
const TOOL_XY_FLIP: Mat3 = [
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, 1]
]

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
]

const syntheticSource = (): CartesianPose[] => {
  const poses: CartesianPose[] = []
  for (let i = 0; i < 12; i += 1) {
    poses.push({
      x: 50 + 20 * (i % 4),
      y: -30 + 15 * Math.floor(i / 4),
      z: 40 + 25 * ((i * 3) % 5),
      rx: 180 - i,
      ry: 5 + 0.5 * i,
      rz: -8 + i
    })
  }
  return poses
}

const rotationsOf = (poses: readonly CartesianPose[]): Mat3[] =>
  poses.map((p) => rotationOf(poseToMatrix(p)))

const recipeWithTool = (toolCorrection: Mat3): FlipRecipe => ({
  ...recipeFromLx(1200, 0, 0),
  toolCorrection
})

describe("station-flip handedness", () => {
  it("corrects a polar fit that would land on det(F) = +1", () => {
    const source = syntheticSource()
    const srcRot = rotationsOf(source)
    // dst = M · src · F with an improper-mirror/proper-F pairing. Because M and
    // src are orthogonal, srcᵀ · Mᵀ · dst collapses to exactly F for every
    // point, so the unsigned polar factor is TOOL_XY_FLIP itself.
    const dstRot = srcRot.map((r) => multiply3(MIRROR_X, multiply3(r, TOOL_XY_FLIP)))
    const inlierIdx = srcRot.map((_, i) => i)

    expect(det3(orthogonalFactor(TOOL_XY_FLIP))).toBeGreaterThan(0)

    const fitted = svdToolCorrection(srcRot, dstRot, MIRROR_X, inlierIdx)
    expectClose(det3(fitted), -1, "det(F)")
    expectMatrixClose(multiply3(transpose3(fitted), fitted), IDENTITY, "FᵀF")
    expectClose(det3(multiply3(MIRROR_X, multiply3(srcRot[0], fitted))), 1, "det(M·R·F)")
  })

  it("throws instead of emitting a left-handed flip", () => {
    const source = syntheticSource()
    expect(() => applyFlip(source[0], recipeWithTool(TOOL_XY_FLIP))).toThrow(/left-handed/)
    expect(() => applyFlip(source[0], recipeWithTool(TOOL_Y_FLIP))).not.toThrow()
  })

  it("accepts proper rotations and rejects reflections and degenerate frames", () => {
    expect(() => assertRightHanded(IDENTITY, "unit")).not.toThrow()
    expect(() => assertRightHanded(MIRROR_X, "unit")).toThrow(/left-handed/)
    expect(() =>
      assertRightHanded(
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 0]
        ],
        "unit"
      )
    ).toThrow(/degenerate/)
  })
})

describe("tool-axis preference", () => {
  const source = syntheticSource()
  const target = source.map((p) => applyFlip(p, recipeFromLx(1200, 0, 0)))

  it("defaults to auto and matches the unspecified fit exactly", () => {
    const implicit = fitFlip({ sourcePoses: source, targetPoses: target })
    const explicitAuto = fitFlip({
      sourcePoses: source,
      targetPoses: target,
      toolAxisPreference: "auto"
    })
    expect(implicit.recipe).not.toBeNull()
    expect(implicit.recipe?.toolAxisPreference).toBe("auto")
    expect(explicitAuto.recipe).toEqual(implicit.recipe)
    expect(explicitAuto.message).toBe(implicit.message)
    expectClose(explicitAuto.orientationRmsDeg, implicit.orientationRmsDeg, "auto oriRms")
  })

  it("pins F to the named diagonal and keeps every choice right-handed", () => {
    for (const preference of TOOL_AXIS_PREFERENCES) {
      const fit = fitFlip({ sourcePoses: source, targetPoses: target, toolAxisPreference: preference })
      expect(fit.accepted, `${preference} accepted`).toBe(true)
      expect(fit.recipe?.toolAxisPreference, `${preference} persisted`).toBe(preference)
      const toolF = fit.recipe!.toolCorrection
      expectClose(det3(toolF), -1, `${preference} det(F)`)
      // The guard inside applyFlip is the real assertion here.
      expect(() => source.map((p) => applyFlip(p, fit.recipe!)), `${preference} applyFlip`).not.toThrow()
    }
  })

  it("maps Y to the classic tool-Y flip and XY to the third negation", () => {
    const pinY = fitFlip({ sourcePoses: source, targetPoses: target, toolAxisPreference: "Y" })
    expectMatrixClose(pinY.recipe!.toolCorrection, TOOL_Y_FLIP, "pin Y")
    expect(pinY.message).toContain("Tool axis pinned to Y")

    const pinXy = fitFlip({ sourcePoses: source, targetPoses: target, toolAxisPreference: "XY" })
    expectMatrixClose(
      pinXy.recipe!.toolCorrection,
      [
        [-1, 0, 0],
        [0, -1, 0],
        [0, 0, -1]
      ],
      "pin XY"
    )
  })

  it("reports the orientation RMS of every choice against one fit", () => {
    const fit = fitFlip({ sourcePoses: source, targetPoses: target })
    expect(fit.toolAxisOptions.map((option) => option.preference)).toEqual([
      ...TOOL_AXIS_PREFERENCES
    ])
    const auto = fit.toolAxisOptions.find((option) => option.preference === "auto")
    expectClose(auto!.orientationRmsDeg, fit.orientationRmsDeg, "auto option rms")
    for (const option of fit.toolAxisOptions) {
      expect(Number.isFinite(option.orientationRmsDeg), `${option.preference} finite`).toBe(true)
      expectClose(det3(option.toolCorrection as Mat3), -1, `${option.preference} det`)
    }
  })

  it("loads recipes saved before the selector existed as auto", () => {
    const legacy: Record<string, unknown> = {
      mirrorAxis: "X",
      offset: [1200, 0, 0],
      mirrorMatrix: MIRROR_X,
      toolCorrection: TOOL_Y_FLIP,
      positionRmsMm: 0.4,
      orientationRmsDeg: 1.2,
      inliers: 10,
      total: 12,
      detR: -1
    }
    expect(flipRecipeFromDict(legacy).toolAxisPreference).toBe("auto")

    const pinned = fitFlip({ sourcePoses: source, targetPoses: target, toolAxisPreference: "Z" })
    const stored = flipRecipeToStation(pinned.recipe!)
    expect(stored.toolAxisPreference).toBe("Z")
    expect(flipRecipeFromDict(stored).toolAxisPreference).toBe("Z")
    expect(
      flipRecipeFromDict({ ...legacy, tool_axis_preference: "x" }).toolAxisPreference
    ).toBe("X")
  })

  it("normalises unknown preferences to auto", () => {
    const cases: [unknown, ToolAxisPreference][] = [
      [undefined, "auto"],
      [null, "auto"],
      ["", "auto"],
      ["bogus", "auto"],
      ["xy", "XY"],
      ["Z", "Z"]
    ]
    for (const [input, want] of cases) {
      expect(normalizeToolAxisPreference(input), String(input)).toBe(want)
    }
  })
})
