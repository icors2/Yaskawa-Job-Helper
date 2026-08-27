import { describe, expect, it } from "vitest"
import {
  applyFlip,
  fitFlip,
  recipeFromLx,
  umeyamaWithReflection
} from "../src/kin/stationFlip"
import type { CartesianPose } from "../src/kin/types"
import {
  expectArrayClose,
  expectClose,
  expectMatrixClose,
  expectPoseClose,
  readGolden
} from "./golden"

interface StationFlipGolden {
  closedForm: {
    lx: number
    ly: number
    lz: number
    input: CartesianPose
    output: CartesianPose
    recipe: {
      mirrorAxis: string
      offset: number[]
      mirrorMatrix: number[][]
      toolCorrection: number[][]
    }
  }
  umeyama: {
    source: number[][]
    target: number[][]
    rotation: number[][]
    translation: number[]
    detR: number
  }
  syntheticFit: {
    accepted: boolean
    message: string
    recipe: {
      offset: number[]
      mirrorAxis: string
      detR: number
      positionRmsMm: number
      orientationRmsDeg: number
    } | null
    positionRmsMm: number
    orientationRmsDeg: number
    inliers: number
    total: number
    detR: number
  }
  identityRejected: {
    accepted: boolean
    detR: number
    message: string
  }
}

const golden = readGolden<StationFlipGolden>("stationFlip.golden.json")

describe("station flip against the Python oracle", () => {
  it("applies the closed-form X mirror", () => {
    const recipe = recipeFromLx(golden.closedForm.lx, golden.closedForm.ly, golden.closedForm.lz)
    const out = applyFlip(golden.closedForm.input, recipe)
    expectPoseClose(out, golden.closedForm.output, "closedForm")
    expectArrayClose(recipe.offset, golden.closedForm.recipe.offset, "offset")
    expectMatrixClose(recipe.mirrorMatrix, golden.closedForm.recipe.mirrorMatrix, "mirror")
    expectMatrixClose(recipe.toolCorrection, golden.closedForm.recipe.toolCorrection, "tool")
  })

  it("runs reflection-aware Umeyama", () => {
    const { rotation, translation } = umeyamaWithReflection(
      golden.umeyama.source,
      golden.umeyama.target
    )
    expectMatrixClose(rotation, golden.umeyama.rotation, "umeyama.R")
    expectArrayClose(translation, golden.umeyama.translation, "umeyama.t")
    expectClose(
      rotation[0][0] * (rotation[1][1] * rotation[2][2] - rotation[1][2] * rotation[2][1]) -
        rotation[0][1] * (rotation[1][0] * rotation[2][2] - rotation[1][2] * rotation[2][0]) +
        rotation[0][2] * (rotation[1][0] * rotation[2][1] - rotation[1][1] * rotation[2][0]),
      golden.umeyama.detR,
      "detR"
    )
  })

  it("fits a synthetic reflection and rejects identity", () => {
    const recipe = recipeFromLx(golden.closedForm.lx, golden.closedForm.ly, golden.closedForm.lz)
    const source: CartesianPose[] = []
    for (let i = 0; i < 12; i += 1) {
      source.push({
        x: 50 + 20 * (i % 4),
        y: -30 + 15 * Math.floor(i / 4),
        z: 40 + 25 * ((i * 3) % 5),
        rx: 180 - i,
        ry: 5 + 0.5 * i,
        rz: -8 + i
      })
    }
    const target = source.map((p) => applyFlip(p, recipe))
    target[3] = {
      x: target[3].x + 80,
      y: target[3].y,
      z: target[3].z,
      rx: 0,
      ry: 0,
      rz: 0
    }
    target[7] = { x: 0, y: 0, z: 0, rx: 10, ry: 20, rz: 30 }

    const fit = fitFlip({ sourcePoses: source, targetPoses: target })
    expect(fit.accepted).toBe(golden.syntheticFit.accepted)
    expect(fit.recipe).not.toBeNull()
    expectClose(fit.positionRmsMm, golden.syntheticFit.positionRmsMm, "posRms")
    expectClose(fit.orientationRmsDeg, golden.syntheticFit.orientationRmsDeg, "oriRms")
    expectClose(fit.detR, golden.syntheticFit.detR, "detR")
    expect(fit.inliers).toBe(golden.syntheticFit.inliers)
    expectArrayClose(fit.recipe!.offset, golden.syntheticFit.recipe!.offset, "fit.offset")

    const identity = fitFlip({ sourcePoses: source, targetPoses: source })
    expect(identity.accepted).toBe(false)
    expect(identity.detR).toBeGreaterThan(0)
    expect(identity.message).toContain("Transfer")
  })
})
