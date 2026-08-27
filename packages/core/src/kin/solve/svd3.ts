/**
 * 3x3 SVD via svd-js, used by Umeyama and the tool-correction polar fit.
 *
 * Golub–Reinsch form: A = U · diag(q) · Vᵀ. Callers that need NumPy's
 * `u, s, vt = svd(A)` should take `vt = transpose(v)`.
 */

import { SVD } from "svd-js"
import { multiply3, transpose3, type Mat3 } from "../pose"

export interface Svd3Result {
  u: Mat3
  /** Singular values (non-negative, not necessarily sorted). */
  s: [number, number, number]
  /** V from A = U · S · Vᵀ (not Vᵀ). */
  v: Mat3
  /** Vᵀ — matches NumPy's third return value. */
  vt: Mat3
}

const asMat3 = (rows: number[][]): Mat3 => [
  [rows[0][0], rows[0][1], rows[0][2]],
  [rows[1][0], rows[1][1], rows[1][2]],
  [rows[2][0], rows[2][1], rows[2][2]]
]

/** Copy before SVD — svd-js may mutate its input. */
export const svd3 = (matrix: Mat3): Svd3Result => {
  const copy = [
    [...matrix[0]],
    [...matrix[1]],
    [...matrix[2]]
  ]
  const { u, v, q } = SVD(copy, true, true)
  const uMat = asMat3(u)
  const vMat = asMat3(v)
  return {
    u: uMat,
    s: [q[0], q[1], q[2]],
    v: vMat,
    vt: transpose3(vMat)
  }
}

/** Polar / orthogonal factor U @ Vᵀ of a 3x3 matrix (NumPy svd path). */
export const orthogonalFactor = (matrix: Mat3): Mat3 => {
  const { u, vt } = svd3(matrix)
  return multiply3(u, vt)
}

export const det3 = (matrix: Mat3): number => {
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
}
