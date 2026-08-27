/**
 * Bounded Levenberg–Marquardt with finite-difference Jacobian.
 *
 * Replaces scipy.optimize.least_squares(method="trf") for IK (6 pulse
 * variables) and calibration (12 scale/offset params). Steps are clamped
 * into the box after each successful update.
 */

export type ResidualFn = (x: number[]) => number[]

export interface LmBounds {
  lower: readonly number[]
  upper: readonly number[]
}

export interface LmOptions {
  bounds?: LmBounds
  xtol?: number
  ftol?: number
  maxNfev?: number
  /** Forward-difference step; defaults to a relative 1e-8 blend. */
  eps?: number
  initialLambda?: number
}

export interface LmResult {
  x: number[]
  cost: number
  nfev: number
  success: boolean
  message: string
}

const sumSquares = (residuals: readonly number[]): number => {
  let sum = 0
  for (const value of residuals) {
    sum += value * value
  }
  return sum
}

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value

const clipVector = (values: readonly number[], bounds?: LmBounds): number[] => {
  if (!bounds) {
    return [...values]
  }
  return values.map((value, index) =>
    clamp(value, bounds.lower[index] ?? -1e12, bounds.upper[index] ?? 1e12)
  )
}

const finiteDiffJacobian = (
  residual: ResidualFn,
  x: readonly number[],
  f0: readonly number[],
  eps: number
): number[][] => {
  const n = x.length
  const m = f0.length
  const jac: number[][] = Array.from({ length: m }, () => Array(n).fill(0))
  for (let j = 0; j < n; j += 1) {
    const step = eps * (1 + Math.abs(x[j]))
    const xPert = [...x]
    xPert[j] = x[j] + step
    const f1 = residual(xPert)
    for (let i = 0; i < m; i += 1) {
      jac[i][j] = (f1[i] - f0[i]) / step
    }
  }
  return jac
}

/** Solve (JᵀJ + λI) δ = −Jᵀr with Gaussian elimination. */
const solveNormalEquations = (
  jac: readonly (readonly number[])[],
  residuals: readonly number[],
  lambda: number
): number[] | null => {
  const m = jac.length
  const n = jac[0]?.length ?? 0
  if (n === 0) {
    return []
  }
  const a: number[][] = Array.from({ length: n }, () => Array(n).fill(0))
  const b = Array(n).fill(0)
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = 0
      for (let row = 0; row < m; row += 1) {
        sum += jac[row][i] * jac[row][j]
      }
      a[i][j] = sum
      a[j][i] = sum
    }
    a[i][i] += lambda
    let rhs = 0
    for (let row = 0; row < m; row += 1) {
      rhs -= jac[row][i] * residuals[row]
    }
    b[i] = rhs
  }

  // Augmented Gaussian elimination with partial pivoting.
  const aug = a.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) {
        pivot = row
      }
    }
    if (Math.abs(aug[pivot][col]) < 1e-18) {
      return null
    }
    if (pivot !== col) {
      const tmp = aug[col]
      aug[col] = aug[pivot]
      aug[pivot] = tmp
    }
    const diag = aug[col][col]
    for (let row = col + 1; row < n; row += 1) {
      const factor = aug[row][col] / diag
      for (let k = col; k <= n; k += 1) {
        aug[row][k] -= factor * aug[col][k]
      }
    }
  }
  const delta = Array(n).fill(0)
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = aug[i][n]
    for (let j = i + 1; j < n; j += 1) {
      sum -= aug[i][j] * delta[j]
    }
    delta[i] = sum / aug[i][i]
  }
  return delta
}

export const leastSquaresLm = (
  residual: ResidualFn,
  x0: readonly number[],
  options: LmOptions = {}
): LmResult => {
  const xtol = options.xtol ?? 1e-10
  const ftol = options.ftol ?? 1e-10
  const maxNfev = options.maxNfev ?? 400
  const eps = options.eps ?? 1e-8
  let lambda = options.initialLambda ?? 1e-3
  let x = clipVector(x0, options.bounds)
  let f = residual(x)
  let nfev = 1
  let cost = 0.5 * sumSquares(f)
  let success = false
  let message = "max iterations"

  for (let iter = 0; iter < maxNfev; iter += 1) {
    if (nfev >= maxNfev) {
      break
    }
    const jac = finiteDiffJacobian(residual, x, f, eps)
    nfev += x.length
    if (nfev >= maxNfev) {
      break
    }

    let accepted = false
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delta = solveNormalEquations(jac, f, lambda)
      if (delta === null) {
        lambda *= 10
        continue
      }
      const xTrial = clipVector(
        x.map((value, index) => value + delta[index]),
        options.bounds
      )
      const fTrial = residual(xTrial)
      nfev += 1
      const costTrial = 0.5 * sumSquares(fTrial)
      const stepNorm = Math.sqrt(sumSquares(delta))
      const xNorm = Math.sqrt(sumSquares(x))
      if (costTrial < cost) {
        const costDrop = cost - costTrial
        x = xTrial
        f = fTrial
        cost = costTrial
        lambda = Math.max(lambda / 3, 1e-12)
        accepted = true
        if (stepNorm <= xtol * (1 + xNorm) || costDrop <= ftol * cost) {
          success = true
          message = "converged"
        }
        break
      }
      lambda *= 10
      if (stepNorm <= xtol * (1 + xNorm)) {
        success = true
        message = "converged (small step)"
        accepted = true
        break
      }
    }
    if (success) {
      break
    }
    if (!accepted) {
      message = "line search failed"
      break
    }
  }

  return { x, cost, nfev, success, message }
}
