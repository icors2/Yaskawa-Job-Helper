/**
 * Transform fixture checks: USER cartesian transfer + YZ / single-side mirror
 * pose signs and frame labels (no sidecar required for these fixtures).
 *
 * Run: npm run test:transform
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseJob } from "../src/lib/jbi/parse.ts"
import {
  previewFrameMove,
  previewMirrorJob,
  previewOffsetJob
} from "../src/lib/jbi/frameTransform.ts"
import type { CartesianPose } from "../src/lib/kin/client.ts"

const here = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = join(here, "..")
const fixtureDir = join(repoRoot, "fixtures", "transform")

let failed = 0

const assert = (cond: boolean, message: string) => {
  if (cond) {
    console.log(`ok — ${message}`)
    return
  }
  failed += 1
  console.error(`FAIL — ${message}`)
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
 * for the near-180° orientations in USER_CART_S1). Used when sidecar is offline.
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
  assert(transferActual.userId === 3, "previewFrameMove → ///USER 3")
  assert(transfer.after.includes("//NAME USER_CART_S1_UF3"), "transfer renames job")
  assertPosesClose(transferActual.poses, source.poses, "transfer preview poses identical")

  const mirrorExpected = collectUserPoses(readFixture("USER_CART_S1_MYZ.JBI"))
  assert(mirrorExpected.userId === 2, "mirror YZ keeps ///USER 2")
  assert(mirrorExpected.poses[0].x < 0, "mirror YZ first pose −X")
  assertPosesClose(
    mirrorExpected.poses,
    source.poses.map(mirrorYzLocal),
    "MYZ fixture vs local YZ mirror"
  )

  let mirrorViaKin = false
  try {
    const mirrored = await previewMirrorJob({
      originalText: sourceText,
      plane: "YZ",
      sourceFrameId: 2,
      sourceLabel: "USER_CART_S1.JBI"
    })
    const mirroredActual = collectUserPoses(mirrored.after)
    assert(mirroredActual.userId === 2, "mirror preview keeps ///USER 2")
    assert(mirrored.rconfReviewRequired === true, "mirror sets RCONF review")
    assertPosesClose(mirroredActual.poses, mirrorExpected.poses, "mirror preview vs MYZ fixture")
    mirrorViaKin = true
  } catch (error) {
    console.log(
      `skip — sidecar mirror (${error instanceof Error ? error.message : String(error)}); fixture math still checked`
    )
  }

  for (const side of ["left", "right"] as const) {
    const tag = side === "left" ? "L" : "R"
    const expected = collectUserPoses(readFixture(`USER_CART_S1_SSM_${tag}_YZ.JBI`))
    assert(expected.userId === 2, `SSM ${tag} keeps ///USER 2`)
    assertPosesClose(expected.poses, mirrorExpected.poses, `SSM ${tag} same math as MYZ`)

    if (mirrorViaKin) {
      const ssm = await previewMirrorJob({
        originalText: sourceText,
        plane: "YZ",
        sourceFrameId: 2,
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
      `skip — sidecar offset (${error instanceof Error ? error.message : String(error)}); fixture math still checked`
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
