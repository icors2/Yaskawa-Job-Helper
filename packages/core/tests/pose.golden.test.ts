import { describe, expect, it } from "vitest"
import {
  composePoses,
  invertTransform,
  matrixToPose,
  multiply4,
  poseToMatrix,
  relativePose,
  rotationGeodesicDeg,
  rotationToYaskawaZyx,
  transform,
  yaskawaZyxToRotation,
  type Mat3
} from "../src/kin/pose"
import type { CartesianPose } from "../src/kin/types"
import {
  expectArrayClose,
  expectClose,
  expectMatrixClose,
  expectPoseClose,
  readGolden
} from "./golden"

interface PoseGolden {
  rotationCases: {
    rx: number
    ry: number
    rz: number
    rotation: number[][]
    roundTrip: number[]
  }[]
  transformCases: { xyz: number[]; rpyRad: number[]; matrix: number[][] }[]
  poseCases: {
    pose: CartesianPose
    matrix: number[][]
    back: CartesianPose
    inverse: number[][]
  }[]
  composeCases: { parent: CartesianPose; child: CartesianPose; result: CartesianPose }[]
  relativeCases: { world: CartesianPose; frame: CartesianPose; result: CartesianPose }[]
  geodesicCases: {
    a: { rx: number; ry: number; rz: number }
    b: { rx: number; ry: number; rz: number }
    deg: number
  }[]
}

const golden = readGolden<PoseGolden>("pose.golden.json")

describe("intrinsic Z-Y-X Euler", () => {
  it("matches the Python rotation matrices", () => {
    expect(golden.rotationCases.length).toBeGreaterThan(0)
    for (const item of golden.rotationCases) {
      const label = `rpy(${item.rx},${item.ry},${item.rz})`
      expectMatrixClose(yaskawaZyxToRotation(item.rx, item.ry, item.rz), item.rotation, label)
    }
  })

  it("matches the Python inverse, including the gimbal-lock branch", () => {
    for (const item of golden.rotationCases) {
      const label = `roundTrip(${item.rx},${item.ry},${item.rz})`
      const rotation = item.rotation as Mat3
      expectArrayClose(rotationToYaskawaZyx(rotation), item.roundTrip, label)
    }
  })
})

describe("homogeneous transforms", () => {
  it("builds the same matrices from xyz + rpy radians", () => {
    for (const item of golden.transformCases) {
      expectMatrixClose(
        transform(item.xyz, item.rpyRad),
        item.matrix,
        `transform(${item.xyz.join(",")})`
      )
    }
  })

  it("round-trips poses through matrices and inverts them", () => {
    for (const item of golden.poseCases) {
      const label = `pose(${item.pose.x},${item.pose.ry})`
      const matrix = poseToMatrix(item.pose)
      expectMatrixClose(matrix, item.matrix, `${label} matrix`)
      expectPoseClose(matrixToPose(matrix), item.back, `${label} back`)
      expectMatrixClose(invertTransform(matrix), item.inverse, `${label} inverse`)
    }
  })

  it("inverse composed with the original is the identity", () => {
    for (const item of golden.poseCases) {
      const matrix = poseToMatrix(item.pose)
      expectMatrixClose(
        multiply4(invertTransform(matrix), matrix),
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 1, 0],
          [0, 0, 0, 1]
        ],
        "inverse @ matrix"
      )
    }
  })
})

describe("pose composition", () => {
  it("composes parent and child like Python", () => {
    for (const item of golden.composeCases) {
      expectPoseClose(composePoses(item.parent, item.child), item.result, "composePoses")
    }
  })

  it("expresses world poses in a user frame like Python", () => {
    for (const item of golden.relativeCases) {
      expectPoseClose(relativePose(item.world, item.frame), item.result, "relativePose")
    }
  })
})

describe("rotation distance", () => {
  it("matches the Python geodesic angle", () => {
    for (const item of golden.geodesicCases) {
      const a = yaskawaZyxToRotation(item.a.rx, item.a.ry, item.a.rz)
      const b = yaskawaZyxToRotation(item.b.rx, item.b.ry, item.b.rz)
      expectClose(rotationGeodesicDeg(a, b), item.deg, "rotationGeodesicDeg")
    }
  })
})
