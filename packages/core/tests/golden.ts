/**
 * Shared helpers for the golden suites.
 *
 * Expected values in `tests/fixtures/*.golden.json` come from the Python
 * oracle in `kinematics/` — regenerate with `npm run kin:golden`. Controller
 * inputs come from the committed `fixtures/` folder at the repo root.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import type { CartesianPose } from "../src/kin/types"

const here = fileURLToPath(new URL(".", import.meta.url))

export const REPO_ROOT = join(here, "..", "..", "..")

/** FK must agree with Python to 1e-6 mm / 1e-6 deg. */
export const TOLERANCE = 1e-6

export const readGolden = <T>(name: string): T =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T

export const readFixture = (...parts: string[]): string =>
  readFileSync(join(REPO_ROOT, "fixtures", ...parts), "latin1")

export const expectClose = (actual: number, expected: number, label: string): void => {
  expect(Math.abs(actual - expected), `${label}: got ${actual}, want ${expected}`).toBeLessThan(
    TOLERANCE
  )
}

export const expectPoseClose = (
  actual: CartesianPose,
  expected: CartesianPose,
  label: string
): void => {
  expectClose(actual.x, expected.x, `${label}.x`)
  expectClose(actual.y, expected.y, `${label}.y`)
  expectClose(actual.z, expected.z, `${label}.z`)
  expectClose(actual.rx, expected.rx, `${label}.rx`)
  expectClose(actual.ry, expected.ry, `${label}.ry`)
  expectClose(actual.rz, expected.rz, `${label}.rz`)
}

export const expectMatrixClose = (
  actual: readonly number[][],
  expected: readonly number[][],
  label: string
): void => {
  expect(actual.length, `${label}: row count`).toBe(expected.length)
  for (let row = 0; row < expected.length; row += 1) {
    for (let col = 0; col < expected[row].length; col += 1) {
      expectClose(actual[row][col], expected[row][col], `${label}[${row}][${col}]`)
    }
  }
}

export const expectArrayClose = (
  actual: readonly number[],
  expected: readonly number[],
  label: string
): void => {
  expect(actual.length, `${label}: length`).toBe(expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    expectClose(actual[index], expected[index], `${label}[${index}]`)
  }
}
