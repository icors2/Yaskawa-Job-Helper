/**
 * Pose and homogeneous-transform helpers, ported from `kinematics/ar2010.py`.
 *
 * Yaskawa Rx/Ry/Rz are intrinsic Z-Y-X Euler angles in degrees: the rotation
 * is Rz(rz) @ Ry(ry) @ Rx(rx). Matrices are row-major 4x4 (or 3x3), stored as
 * nested arrays so they serialise straight to the sidecar's JSON shape.
 */

import type { CartesianPose } from "./types"

export type Mat3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number]
]

export type Mat4 = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number]
]

export const DEG_TO_RAD = Math.PI / 180
export const RAD_TO_DEG = 180 / Math.PI

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

export const pose = (
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number
): CartesianPose => ({ x, y, z, rx, ry, rz })

export const poseFromXyzRpy = (values: readonly number[]): CartesianPose => {
  if (values.length < 6) {
    throw new Error("pose requires X,Y,Z,Rx,Ry,Rz")
  }
  return pose(values[0], values[1], values[2], values[3], values[4], values[5])
}

export const poseToArray = (
  value: CartesianPose
): [number, number, number, number, number, number] => [
  value.x,
  value.y,
  value.z,
  value.rx,
  value.ry,
  value.rz
]

export const identity4 = (): Mat4 => [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1]
]

/** Rotation for intrinsic Z-Y-X Euler angles in radians: Rz @ Ry @ Rx. */
export const rpyToRotation = (rxRad: number, ryRad: number, rzRad: number): Mat3 => {
  const cr = Math.cos(rxRad)
  const sr = Math.sin(rxRad)
  const cp = Math.cos(ryRad)
  const sp = Math.sin(ryRad)
  const cy = Math.cos(rzRad)
  const sy = Math.sin(rzRad)
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr]
  ]
}

export const yaskawaZyxToRotation = (rxDeg: number, ryDeg: number, rzDeg: number): Mat3 =>
  rpyToRotation(rxDeg * DEG_TO_RAD, ryDeg * DEG_TO_RAD, rzDeg * DEG_TO_RAD)

/** Inverse of `yaskawaZyxToRotation`, returning [rx, ry, rz] in degrees. */
export const rotationToYaskawaZyx = (rotation: Mat3): [number, number, number] => {
  const pitch = Math.asin(clamp(-rotation[2][0], -1, 1))
  if (Math.abs(rotation[2][0]) < 0.999999) {
    return [
      Math.atan2(rotation[2][1], rotation[2][2]) * RAD_TO_DEG,
      pitch * RAD_TO_DEG,
      Math.atan2(rotation[1][0], rotation[0][0]) * RAD_TO_DEG
    ]
  }
  return [
    0,
    pitch * RAD_TO_DEG,
    Math.atan2(-rotation[0][1], rotation[1][1]) * RAD_TO_DEG
  ]
}

/**
 * Guard the unstated precondition of `rotationToYaskawaZyx`: Euler extraction
 * returns plausible-looking angles for a left-handed frame instead of failing.
 * Call this only where a reflection is deliberately introduced — the FK/IK hot
 * path is already proper by construction and does not need the check.
 *
 * The determinant is inlined rather than taken from `solve/svd3`, which imports
 * this module.
 */
export const assertRightHanded = (rotation: Mat3, context: string): void => {
  const det =
    rotation[0][0] * (rotation[1][1] * rotation[2][2] - rotation[1][2] * rotation[2][1]) -
    rotation[0][1] * (rotation[1][0] * rotation[2][2] - rotation[1][2] * rotation[2][0]) +
    rotation[0][2] * (rotation[1][0] * rotation[2][1] - rotation[1][1] * rotation[2][0])
  if (det > 0) {
    return
  }
  throw new Error(
    `${context}: rotation is ${det < 0 ? "left-handed" : "degenerate"} (det=${det.toFixed(6)}). ` +
      "A mirror must be paired with an improper tool correction so the product stays a proper rotation."
  )
}

/** Homogeneous transform from a translation and intrinsic Z-Y-X radians. */
export const transform = (
  xyz: readonly number[],
  rpyRad: readonly number[]
): Mat4 => {
  const rotation = rpyToRotation(rpyRad[0], rpyRad[1], rpyRad[2])
  return [
    [rotation[0][0], rotation[0][1], rotation[0][2], xyz[0]],
    [rotation[1][0], rotation[1][1], rotation[1][2], xyz[1]],
    [rotation[2][0], rotation[2][1], rotation[2][2], xyz[2]],
    [0, 0, 0, 1]
  ]
}

export const poseToMatrix = (value: CartesianPose): Mat4 => {
  const rotation = yaskawaZyxToRotation(value.rx, value.ry, value.rz)
  return [
    [rotation[0][0], rotation[0][1], rotation[0][2], value.x],
    [rotation[1][0], rotation[1][1], rotation[1][2], value.y],
    [rotation[2][0], rotation[2][1], rotation[2][2], value.z],
    [0, 0, 0, 1]
  ]
}

export const matrixToPose = (matrix: Mat4): CartesianPose => {
  const [rx, ry, rz] = rotationToYaskawaZyx(rotationOf(matrix))
  return pose(matrix[0][3], matrix[1][3], matrix[2][3], rx, ry, rz)
}

export const rotationOf = (matrix: Mat4): Mat3 => [
  [matrix[0][0], matrix[0][1], matrix[0][2]],
  [matrix[1][0], matrix[1][1], matrix[1][2]],
  [matrix[2][0], matrix[2][1], matrix[2][2]]
]

export const multiply4 = (a: Mat4, b: Mat4): Mat4 => {
  const out = identity4()
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) {
        sum += a[row][k] * b[k][col]
      }
      out[row][col] = sum
    }
  }
  return out
}

export const multiply3 = (a: Mat3, b: Mat3): Mat3 => {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0
      for (let k = 0; k < 3; k += 1) {
        sum += a[row][k] * b[k][col]
      }
      out[row][col] = sum
    }
  }
  return out
}

export const transpose3 = (matrix: Mat3): Mat3 => [
  [matrix[0][0], matrix[1][0], matrix[2][0]],
  [matrix[0][1], matrix[1][1], matrix[2][1]],
  [matrix[0][2], matrix[1][2], matrix[2][2]]
]

export const invertTransform = (matrix: Mat4): Mat4 => {
  const rt = transpose3(rotationOf(matrix))
  const t = [matrix[0][3], matrix[1][3], matrix[2][3]]
  const out = identity4()
  for (let row = 0; row < 3; row += 1) {
    let sum = 0
    for (let col = 0; col < 3; col += 1) {
      out[row][col] = rt[row][col]
      sum += rt[row][col] * t[col]
    }
    out[row][3] = -sum
  }
  return out
}

export const composePoses = (parent: CartesianPose, child: CartesianPose): CartesianPose =>
  matrixToPose(multiply4(poseToMatrix(parent), poseToMatrix(child)))

/** Express a base-frame pose in the coordinates of `frame` (a BUSER pose). */
export const relativePose = (
  worldPose: CartesianPose,
  frame: CartesianPose
): CartesianPose =>
  matrixToPose(multiply4(invertTransform(poseToMatrix(frame)), poseToMatrix(worldPose)))

/** Geodesic angle between two rotations, in degrees. */
export const rotationGeodesicDeg = (a: Mat3, b: Mat3): number => {
  const relative = multiply3(transpose3(a), b)
  const trace = relative[0][0] + relative[1][1] + relative[2][2]
  return Math.acos(clamp((trace - 1) * 0.5, -1, 1)) * RAD_TO_DEG
}

export const rotZ4 = (angleRad: number): Mat4 => {
  const cosine = Math.cos(angleRad)
  const sine = Math.sin(angleRad)
  return [
    [cosine, -sine, 0, 0],
    [sine, cosine, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ]
}

export const xyzErrorMm = (computed: CartesianPose, expected: CartesianPose): number => {
  const dx = computed.x - expected.x
  const dy = computed.y - expected.y
  const dz = computed.z - expected.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
