import { describe, it } from "vitest"
import {
  convertPose,
  transformFrameFlipPoses
} from "../src/kin/frameFlip"
import {
  mirrorPose,
  offsetByPose,
  pulsesInUserFrame,
  reachEnvelope,
  transformMirrorPoses,
  transformOffsetPoses
} from "../src/kin/transforms"
import { defaultTool } from "../src/kin/fk"
import type { CartesianPose, MirrorPlane } from "../src/kin/types"
import { expectClose, expectPoseClose, readGolden } from "./golden"

interface TransformsGolden {
  mirrorCases: {
    plane: MirrorPlane
    input: CartesianPose
    output: CartesianPose
    rconfReviewRequired: boolean
  }[]
  offset: { input: CartesianPose; delta: CartesianPose; output: CartesianPose }
  frameFlip: {
    pose: CartesianPose
    ufOld: CartesianPose
    ufNew: CartesianPose
    withToolFlip: CartesianPose
    withoutToolFlip: CartesianPose
  }
  pulsesInUserFrame: {
    pulses: number[]
    userFrame: CartesianPose
    pose: CartesianPose
  }
  reach: {
    horizontalMm: number
    radialMm: number
    withinReach: boolean
  }
}

const golden = readGolden<TransformsGolden>("transforms.golden.json")

describe("transforms against the Python oracle", () => {
  for (const testCase of golden.mirrorCases) {
    it(`mirrors across ${testCase.plane}`, () => {
      const { pose, rconfReviewRequired } = mirrorPose(testCase.input, testCase.plane)
      expectPoseClose(pose, testCase.output, `mirror.${testCase.plane}`)
      if (rconfReviewRequired !== testCase.rconfReviewRequired) {
        throw new Error("rconfReviewRequired mismatch")
      }
      const batch = transformMirrorPoses([testCase.input], testCase.plane)
      expectPoseClose(batch.poses[0], testCase.output, `batch.${testCase.plane}`)
    })
  }

  it("applies a fixed-frame XYZ offset", () => {
    const out = offsetByPose(golden.offset.input, golden.offset.delta)
    expectPoseClose(out, golden.offset.output, "offset")
    const batch = transformOffsetPoses([golden.offset.input], golden.offset.delta)
    expectPoseClose(batch.poses[0], golden.offset.output, "offset.batch")
  })

  it("converts poses between user frames (Flip)", () => {
    const withFlip = convertPose(
      golden.frameFlip.pose,
      golden.frameFlip.ufOld,
      golden.frameFlip.ufNew,
      { applyToolZFlip: true }
    )
    const withoutFlip = convertPose(
      golden.frameFlip.pose,
      golden.frameFlip.ufOld,
      golden.frameFlip.ufNew,
      { applyToolZFlip: false }
    )
    expectPoseClose(withFlip, golden.frameFlip.withToolFlip, "flip.on")
    expectPoseClose(withoutFlip, golden.frameFlip.withoutToolFlip, "flip.off")
    const batch = transformFrameFlipPoses({
      poses: [golden.frameFlip.pose],
      sourceUf: golden.frameFlip.ufOld,
      targetUf: golden.frameFlip.ufNew,
      applyToolZFlip: true
    })
    expectPoseClose(batch.poses[0], golden.frameFlip.withToolFlip, "flip.batch")
  })

  it("expresses pulses in a user frame", () => {
    const pose = pulsesInUserFrame(golden.pulsesInUserFrame.pulses, golden.pulsesInUserFrame.userFrame, {
      tool: defaultTool()
    })
    expectPoseClose(pose, golden.pulsesInUserFrame.pose, "pulsesInUf")
  })

  it("reports the reach heuristic", () => {
    const check = reachEnvelope(golden.offset.input)
    expectClose(check.horizontalMm, golden.reach.horizontalMm, "horizontal")
    expectClose(check.radialMm, golden.reach.radialMm, "radial")
    if (check.withinReach !== golden.reach.withinReach) {
      throw new Error("withinReach mismatch")
    }
  })
})
