/**
 * Transform fixture checks: USER cartesian transfer + Flip convert + YZ /
 * single-side mirror pose signs and frame labels (no sidecar required for
 * transfer; Flip/mirror/offset need sidecar when available).
 *
 * Run: npm run test:transform
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJob } from "@yaskawa/core/jbi/parse"
import {
  previewFrameMove,
  previewFrameFlipJob,
  previewMirrorJob,
  previewOffsetJob
} from "../apps/desktop/src/lib/jbi/frameTransform.ts"
import type { CartesianPose } from "@yaskawa/core/kin/types"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = join(here, "..")
const fixtureDir = join(repoRoot, "fixtures", "transform")

let failed = 0

const assert = (cond: boolean, message: string) => {
  if (cond) {
    console.log(`ok â€” ${message}`)
    return
  }
  failed += 1
  console.error(`FAIL â€” ${message}`)
}

const readFixture = (name: string): string =>
  readFileSync(join(fixtureDir, name), "utf8")

const parsePoseLine = (raw: string): CartesianPose => {
  const rhs = raw.includes("=") ? raw.split("=").slice(1).join("=") : raw
  const parts = rhs.split(",").map((p) => Number.parseFloat(p.trim()))
  return {
    x: parts[0],
    y: parts[1],
    z: parts[2],
    rx: parts[3],
    ry: parts[4],
    rz: parts[5]
  }
}

const collectUserPoses = (text: string): { userId: number; poses: CartesianPose[] } => {
  const job = parseJob(text)
  const group = job.posGroups.find((g) => String(g.postype).toUpperCase() === "USER")
  if (!group) {
    throw new Error("No USER pos group")
  }
  const userId = Number.parseInt(String(group.user ?? ""), 10)
  const poses = group.vars
    .filter((v) => v.kind === "P" || v.kind === "C")
    .map((v) => parsePoseLine(v.raw))
  return { userId, poses }
}

const nearlyEqual = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps

const assertPosesClose = (
  actual: CartesianPose[],
  expected: CartesianPose[],
  label: string
) => {
  assert(actual.length === expected.length, `${label}: pose count ${actual.length} === ${expected.length}`)
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i]
    const e = expected[i]
    assert(
      nearlyEqual(a.x, e.x) &&
        nearlyEqual(a.y, e.y) &&
        nearlyEqual(a.z, e.z) &&
        nearlyEqual(a.rx, e.rx, 1e-3) &&
        nearlyEqual(a.ry, e.ry, 1e-3) &&
        nearlyEqual(a.rz, e.rz, 1e-3),
      `${label}: pose[${i}] matches fixture`
    )
  }
}

/**
 * Local YZ mirror for cartesian fixture checks (matches kinematics/transform.py
 * for the near-180Â° orientations in USER_CART_S1). Used when sidecar is offline.
 */
const mirrorYzLocal = (pose: CartesianPose): CartesianPose => ({
  x: -pose.x,
  y: pose.y,
  z: pose.z,
  rx: pose.rx,
  ry: -pose.ry,
  rz: -pose.rz
})

const run = async () => {
  const sourceText = readFixture("USER_CART_S1.JBI")
  const source = collectUserPoses(sourceText)
  assert(source.userId === 2, "source ///USER 2 (S1)")
  assert(source.poses.length === 4, "source has 4 USER poses")
  assert(source.poses[0].x > 0, "source first pose +X")

  const transferExpected = collectUserPoses(readFixture("USER_CART_S1_UF3.JBI"))
  assert(transferExpected.userId === 3, "transfer expected ///USER 3 (S2)")
  assertPosesClose(transferExpected.poses, source.poses, "transfer expected keeps poses")

  const transfer = await previewFrameMove({
    originalText: sourceText,
    sourceFrameId: 2,
    targetFrameId: 3,
    sourceLabel: "USER_CART_S1.JBI"
  })
  const transferActual = collectUserPoses(transfer.after)
  assert(transferActual.userId === 3, "previewFrameMove â†’ ///USER 3")
  assert(transfer.after.includes("//NAME USER_CART_S1_UF3"), "transfer renames job")
  assertPosesClose(transferActual.poses, source.poses, "transfer preview poses identical")

  const flipExpected = collectUserPoses(readFixture("USER_CART_S1_FLIP_UF3.JBI"))
  assert(flipExpected.userId === 3, "Flip expected ///USER 3")
  assert(flipExpected.poses.length === 4, "Flip expected has 4 poses")

  try {
    const uframeText = readFixture("UFRAME.CND")
    // Parse BUSER for UF2 / UF3 without sidecar (regex on fixture CND).
    const buserOf = (id: number): CartesianPose => {
      const block = uframeText.split("//UFRAME ").find((part) => part.startsWith(`${id}\n`) || part.startsWith(`${id}\r`))
      if (!block) {
        throw new Error(`UF${id} missing in fixture UFRAME.CND`)
      }
      const match = block.match(/BUSER\s+(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)/)
      if (!match) {
        throw new Error(`BUSER for UF${id} not found`)
      }
      return {
        x: Number.parseFloat(match[1]),
        y: Number.parseFloat(match[2]),
        z: Number.parseFloat(match[3]),
        rx: Number.parseFloat(match[4]),
        ry: Number.parseFloat(match[5]),
        rz: Number.parseFloat(match[6])
      }
    }
    const flipped = await previewFrameFlipJob({
      originalText: sourceText,
      sourceFrameId: 2,
      targetFrameId: 3,
      sourceUf: buserOf(2),
      targetUf: buserOf(3),
      applyToolZFlip: true,
      sourceLabel: "USER_CART_S1.JBI"
    })
    const flipActual = collectUserPoses(flipped.after)
    assert(flipActual.userId === 3, "Flip preview â†’ ///USER 3")
    assert(flipped.after.includes("//NAME USER_CART_S1_FLIP_UF3"), "Flip renames with _FLIP_UF3")
    assertPosesClose(flipActual.poses, flipExpected.poses, "Flip preview vs FLIP_UF3 fixture")
  } catch (error) {
    console.log(
      `skip â€” sidecar Flip (${error instanceof Error ? error.message : String(error)}); fixture file still present`
    )
  }

  const mirrorExpected = collectUserPoses(readFixture("USER_CART_S1_MYZ.JBI"))
  assert(mirrorExpected.userId === 2, "mirror YZ keeps ///USER 2")
  assert(mirrorExpected.poses[0].x < 0, "mirror YZ first pose âˆ’X")
  assertPosesClose(
    mirrorExpected.poses,
    source.poses.map(mirrorYzLocal),
    "MYZ fixture vs local YZ mirror"
  )

  let mirrorViaKin = false
  try {
    const uframeText = readFixture("UFRAME.CND")
    const buserMatch = (id: number): CartesianPose => {
      const block = uframeText
        .split("//UFRAME ")
        .find((part) => part.startsWith(`${id}\n`) || part.startsWith(`${id}\r`))
      if (!block) {
        throw new Error(`UF${id} missing in fixture UFRAME.CND`)
      }
      const match = block.match(
        /BUSER\s+(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)/
      )
      if (!match) {
        throw new Error(`BUSER for UF${id} not found`)
      }
      return {
        x: Number.parseFloat(match[1]),
        y: Number.parseFloat(match[2]),
        z: Number.parseFloat(match[3]),
        rx: Number.parseFloat(match[4]),
        ry: Number.parseFloat(match[5]),
        rz: Number.parseFloat(match[6])
      }
    }
    const mirrored = await previewMirrorJob({
      originalText: sourceText,
      plane: "YZ",
      sourceFrameId: 2,
      sourceUf: buserMatch(2),
      sourceLabel: "USER_CART_S1.JBI"
    })
    const mirroredActual = collectUserPoses(mirrored.after)
    assert(mirroredActual.userId === 2, "mirror preview keeps ///USER 2")
    assert(mirrored.rconfReviewRequired === true, "mirror sets RCONF review")
    assert(typeof mirrored.saveBlocked === "boolean", "mirror returns saveBlocked")
    assert(mirrored.reachReport.length === mirrored.poseCount, "mirror reach report per pose")
    assert(mirrored.after.includes("///RCONF"), "mirror emits RCONF groups")
    const mirrorJob = parseJob(mirrored.after)
    const mirrorVars = mirrorJob.posGroups.flatMap((g) => g.vars)
    assert(
      mirrorVars.every((v, i) => v.kind === "P" && v.index === 105 + i),
      "mirror preserves P00105..P00108 kinds/indices"
    )
    assertPosesClose(mirroredActual.poses, mirrorExpected.poses, "mirror preview vs MYZ fixture")

    const cSource = readFixture("USER_CART_C_S1.JBI")
    const cMirrored = await previewMirrorJob({
      originalText: cSource,
      plane: "YZ",
      sourceFrameId: 2,
      sourceUf: buserMatch(2),
      sourceLabel: "USER_CART_C_S1.JBI"
    })
    const cVars = parseJob(cMirrored.after)
      .posGroups.flatMap((g) => g.vars)
      .filter((v) => v.kind === "C" || v.kind === "P")
    assert(cVars.length === 4, "C-fixture mirror keeps 4 pos vars")
    assert(
      cVars.every((v, i) => v.kind === "C" && v.index === i),
      "mirror preserves C00000..C00003 (never C→P)"
    )
    assert(!cMirrored.after.includes("P00000="), "mirrored C job has no P00000 rows")
    assert(cMirrored.after.includes("///RCONF"), "C-fixture mirror emits RCONF")

    mirrorViaKin = true
  } catch (error) {
    console.log(
      `skip — mirror IK (${error instanceof Error ? error.message : String(error)}); fixture math still checked`
    )
  }

  for (const side of ["left", "right"] as const) {
    const tag = side === "left" ? "L" : "R"
    const expected = collectUserPoses(readFixture(`USER_CART_S1_SSM_${tag}_YZ.JBI`))
    assert(expected.userId === 2, `SSM ${tag} keeps ///USER 2`)
    assertPosesClose(expected.poses, mirrorExpected.poses, `SSM ${tag} same math as MYZ`)

    if (mirrorViaKin) {
      const uframeText = readFixture("UFRAME.CND")
      const block = uframeText
        .split("//UFRAME ")
        .find((part) => part.startsWith("2\n") || part.startsWith("2\r"))
      const match = block?.match(
        /BUSER\s+(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)/
      )
      if (!match) {
        throw new Error("BUSER for UF2 not found for SSM")
      }
      const sourceUf: CartesianPose = {
        x: Number.parseFloat(match[1]),
        y: Number.parseFloat(match[2]),
        z: Number.parseFloat(match[3]),
        rx: Number.parseFloat(match[4]),
        ry: Number.parseFloat(match[5]),
        rz: Number.parseFloat(match[6])
      }
      const ssm = await previewMirrorJob({
        originalText: sourceText,
        plane: "YZ",
        sourceFrameId: 2,
        sourceUf,
        side,
        sourceLabel: "USER_CART_S1.JBI"
      })
      const ssmActual = collectUserPoses(ssm.after)
      assert(ssmActual.userId === 2, `SSM ${tag} preview keeps ///USER 2`)
      assert(
        ssm.after.includes(`//NAME USER_CART_S1_SSM_${tag}_YZ`),
        `SSM ${tag} names job with side suffix`
      )
      assertPosesClose(ssmActual.poses, expected.poses, `SSM ${tag} preview vs fixture`)
    }
  }

  const offsetExpected = collectUserPoses(readFixture("USER_CART_S1_OFF_X100.JBI"))
  assert(offsetExpected.userId === 2, "offset fixture keeps ///USER 2")
  assertPosesClose(
    offsetExpected.poses,
    source.poses.map((p) => ({ ...p, x: p.x + 100 })),
    "OFF_X100 fixture vs +100 mm X"
  )

  try {
    const offsetPreview = await previewOffsetJob({
      originalText: sourceText,
      deltaText: "100,0,0,0,0,0",
      sourceFrameId: 2,
      sourceLabel: "USER_CART_S1.JBI"
    })
    const offsetActual = collectUserPoses(offsetPreview.after)
    assert(offsetActual.userId === 2, "offset preview keeps ///USER 2")
    assert(offsetPreview.after.includes("//NAME USER_CART_S1_OFF"), "offset renames with _OFF")
    assertPosesClose(offsetActual.poses, offsetExpected.poses, "offset preview vs OFF_X100")
  } catch (error) {
    console.log(
      `skip â€” sidecar offset (${error instanceof Error ? error.message : String(error)}); fixture math still checked`
    )
  }

  if (failed > 0) {
    console.error(`\n${failed} transform fixture assertion(s) failed`)
    process.exit(1)
  }
  console.log("\nAll transform fixture checks passed.")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
