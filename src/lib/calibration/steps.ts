import type { CartesianPose, UserFrame } from "../kin/client"
import type {
  CalibrationStepDef,
  ConfiguredUserFrame,
  JointAxis,
  JointLimitDirection
} from "./types"
import { JOINT_AXES } from "./types"

const HOME_PULSES = [0, -75310, 1200, 0, -127658, -70]
const HOME_CART: CartesianPose = { x: 275, y: 0, z: 875, rx: 180, ry: 45, rz: 0 }

/** 24-bit ///RCONF payload copied from CALIBRATION_RELATIVE.JBI. */
export const DEFAULT_RCONF =
  "1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"

const RCONF_L_MINUS_U_PLUS =
  "1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"
const RCONF_B_PLUS =
  "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"
const RCONF_T_TURN =
  "1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"

type StepSeed = {
  pulses: number[]
  cartesian: CartesianPose
  rconf?: string
}

/**
 * Taught C00000–C00019 from the pendant reference pair
 * CALIBRATION_STANDARD.JBI / CALIBRATION_RELATIVE.JBI.
 */
const STEP_SEEDS: Record<string, StepSeed> = {
  home: {
    pulses: [208, -75312, 1200, 1, -127658, -69],
    cartesian: { x: 274.98, y: -0.008, z: 875, rx: 179.9989, ry: 44.9997, rz: 0.002 }
  },
  uf2_rorg: {
    pulses: [-65160, -163660, -127880, -27700, -57282, 17604],
    cartesian: {
      x: 622.573,
      y: -426.393,
      z: -101.139,
      rx: -179.294,
      ry: -0.1745,
      rz: -16.1282
    }
  },
  uf2_rxx: {
    pulses: [-113924, 37261, -15839, -53976, -37776, 36022],
    cartesian: {
      x: 383.55,
      y: -1649.719,
      z: -105.735,
      rx: -178.5001,
      ry: 0.5026,
      rz: -41.4095
    }
  },
  uf2_rxy: {
    pulses: [-88935, 71842, 22776, -38328, -30113, 23127],
    cartesian: {
      x: 933.399,
      y: -1756.204,
      z: -107.506,
      rx: -178.6315,
      ry: 0.5025,
      rz: -41.3677
    }
  },
  uf3_rorg: {
    pulses: [118388, 64274, 14120, 47959, -74513, -50857],
    cartesian: {
      x: 385.503,
      y: 1598.413,
      z: -99.61,
      rx: -179.5797,
      ry: -0.3013,
      rz: -6.9319
    }
  },
  uf3_rxx: {
    pulses: [75149, -145859, -123958, 43122, -68431, -32519],
    cartesian: {
      x: 613.623,
      y: 374.87,
      z: -107.125,
      rx: -179.5061,
      ry: -0.2696,
      rz: -6.9262
    }
  },
  uf3_rxy: {
    pulses: [42804, -31159, -73294, 53963, -32933, -35202],
    cartesian: {
      x: 1163.774,
      y: 478.153,
      z: -91.819,
      rx: -179.4694,
      ry: -0.2982,
      rz: -6.9135
    }
  },
  joint_limit_S_plus: {
    pulses: [148382, -75311, 1200, 0, -127658, -70],
    cartesian: {
      x: -96.141,
      y: 257.633,
      z: 874.999,
      rx: 180,
      ry: 45.0002,
      rz: 110.465
    }
  },
  joint_limit_S_minus: {
    pulses: [-154802, -75311, 1200, 0, -127658, -70],
    cartesian: {
      x: -118.644,
      y: -248.076,
      z: 874.999,
      rx: 180,
      ry: 45.0002,
      rz: -115.559
    }
  },
  joint_limit_L_plus: {
    pulses: [206, -2208, 1200, 0, -127658, -70],
    cartesian: {
      x: 790.609,
      y: 1.376,
      z: 608.986,
      rx: 179.1795,
      ry: 83.3199,
      rz: -0.7822
    }
  },
  joint_limit_L_minus: {
    pulses: [206, -166566, 1200, 0, -127658, -70],
    cartesian: {
      x: -414.668,
      y: -1.854,
      z: 679.993,
      rx: -179.8858,
      ry: -2.8354,
      rz: 0.0446
    },
    rconf: RCONF_L_MINUS_U_PLUS
  },
  joint_limit_U_plus: {
    pulses: [206, -75311, 123177, 0, -127658, -70],
    cartesian: {
      x: -472.496,
      y: -2.009,
      z: 1245.133,
      rx: -179.8243,
      ry: -31.5756,
      rz: 0.0258
    },
    rconf: RCONF_L_MINUS_U_PLUS
  },
  joint_limit_U_minus: {
    pulses: [206, -75311, -86954, 0, -127658, -70],
    cartesian: {
      x: 249.873,
      y: -0.073,
      z: 250.348,
      rx: 0.7052,
      ry: 79.6569,
      rz: -179.2402
    }
  },
  joint_limit_R_plus: {
    pulses: [206, -75311, 1200, 153424, -127658, -70],
    cartesian: {
      x: -173.865,
      y: -186.177,
      z: 1406.145,
      rx: 147.2368,
      ry: -45.5002,
      rz: -134.7207
    }
  },
  joint_limit_R_minus: {
    pulses: [206, -75311, 1200, -153424, -127658, -70],
    cartesian: {
      x: -174.385,
      y: 186.529,
      z: 1405.578,
      rx: -146.8336,
      ry: -45.3818,
      rz: 134.7676
    }
  },
  joint_limit_B_plus: {
    pulses: [206, -75311, 1196, 0, 5700, -72],
    cartesian: {
      x: 818.445,
      y: 1.458,
      z: 1781.947,
      rx: -6.0107,
      ry: -88.9505,
      rz: -173.7227
    },
    rconf: RCONF_B_PLUS
  },
  joint_limit_B_minus: {
    pulses: [206, -75312, 1196, 0, -132260, -71],
    cartesian: {
      x: 229.198,
      y: -0.125,
      z: 884.124,
      rx: 179.9802,
      ry: 49.6969,
      rz: -0.0171
    }
  },
  joint_limit_T_plus: {
    pulses: [206, -75311, 1200, 0, -127658, 109912],
    cartesian: {
      x: 404.652,
      y: 79.634,
      z: 874.999,
      rx: 179.9998,
      ry: 44.9999,
      rz: -118.1512
    },
    rconf: RCONF_T_TURN
  },
  joint_limit_T_minus: {
    pulses: [206, -75311, 1200, 0, -127658, -109925],
    cartesian: {
      x: 406.759,
      y: -76.55,
      z: 874.999,
      rx: -179.9998,
      ry: 44.9999,
      rz: 118.4297
    },
    rconf: RCONF_T_TURN
  },
  extra_pose: {
    pulses: [-77633, -75310, 1200, 0, -127658, -70],
    cartesian: {
      x: 145.602,
      y: -233.286,
      z: 874.998,
      rx: 180,
      ry: 45.0007,
      rz: -58.0294
    }
  }
}

const AXIS_INDEX: Record<JointAxis, number> = {
  S: 0,
  L: 1,
  U: 2,
  R: 3,
  B: 4,
  T: 5
}

const isStationFrame = (frame: { id: number; name: string }): boolean => {
  return frame.id === 2 || frame.id === 3 || /s[12]/i.test(frame.name)
}

const withSeed = (step: CalibrationStepDef): CalibrationStepDef => {
  const seed = STEP_SEEDS[step.id]
  if (!seed) {
    return {
      ...step,
      seedRconf: step.seedRconf ?? DEFAULT_RCONF
    }
  }
  return {
    ...step,
    seedPulses: seed.pulses,
    seedCartesian: seed.cartesian,
    seedRconf: seed.rconf ?? DEFAULT_RCONF
  }
}

/**
 * Default frames when UFRAME.CND is not loaded yet.
 * S1 (UF#2) and S2 (UF#3) each contribute ORG/RXX/RXY (20 points with home, limits, extra).
 */
export const defaultConfiguredFrames = (): ConfiguredUserFrame[] => [
  {
    id: 2,
    name: "S1",
    includeRorg: true,
    includeRxx: true,
    includeRxy: true,
    required: true
  },
  {
    id: 3,
    name: "S2",
    includeRorg: true,
    includeRxx: true,
    includeRxy: true,
    required: false
  }
]

/** Seed configured frames from loaded UFRAME.CND (S1/S2 triples when empty). */
export const framesFromUframeCnd = (frames: UserFrame[]): ConfiguredUserFrame[] => {
  if (frames.length === 0) {
    return defaultConfiguredFrames()
  }
  return frames.map((frame) => {
    const isS1 = frame.id === 2 || /s1/i.test(frame.name)
    const station = isStationFrame(frame)
    return {
      id: frame.id,
      name: frame.name || `UF${frame.id}`,
      includeRorg: true,
      includeRxx: station,
      includeRxy: station,
      required: isS1
    }
  })
}

const homeStep = (): CalibrationStepDef =>
  withSeed({
    id: "home",
    kind: "home",
    label: "Home / safe pose (anchor)",
    exportLabel: "HOME POSTION",
    pauseTag: "STEP_HOME",
    description:
      "Known safe home is the anchor for every joint range. Record pulses (STANDARD) then matching cartesian (RELATIVE / BASE) at the same physical pose. Prefer teaching one MOVL (or MOVJ if needed) at this line.",
    pulseHint:
      "STANDARD job → teach/jog to home → CURRENT POSITION → PULSE. Write S,L,U,R,B,T. Seeds match the pendant CALIBRATION_STANDARD home if still valid.",
    cartesianHint:
      "RELATIVE job (or convert STANDARD→relative / ROBOT) → same home pose → BASE (or USER). Write X,Y,Z,Rx,Ry,Rz.",
    defaultFrame: "BASE",
    seedPulses: HOME_PULSES,
    seedCartesian: HOME_CART,
    required: true,
    skippable: false
  })

const uframePointStep = (
  frame: ConfiguredUserFrame,
  point: "rorg" | "rxx" | "rxy",
  required: boolean
): CalibrationStepDef => {
  const tag = point.toUpperCase()
  const exportTag = point === "rorg" ? "ORG" : tag
  const labels = {
    rorg: "RORG (origin)",
    rxx: "RXX (X-axis)",
    rxy: "RXY (XY plane)"
  } as const
  const kind =
    point === "rorg" ? "uframe_rorg" : point === "rxx" ? "uframe_rxx" : "uframe_rxy"
  return withSeed({
    id: `uf${frame.id}_${point}`,
    kind,
    label: `UF#${frame.id} ${frame.name} — ${labels[point]}`,
    exportLabel: `UF#${frame.id} ${frame.name} ${exportTag}`,
    pauseTag: `STEP_UF${frame.id}_${tag}`,
    description: `Teach/jog to the ${labels[point]} point for user frame ${frame.id} (${frame.name}). One recorded position per step (prefer MOVL). Phase A: pulses in STANDARD. Phase B: cartesian in RELATIVE / USER ${frame.id} (or BASE/BUSER).`,
    pulseHint: `STANDARD job → PULSE screen at ${tag}. Enter S,L,U,R,B,T into the wizard.`,
    cartesianHint: `RELATIVE / ROBOT-frame job → BASE or USER ${frame.id} screen at the same ${tag} pose. Enter XYZ Rx Ry Rz.`,
    defaultFrame: "BASE",
    userFrameId: frame.id,
    required,
    skippable: !required
  })
}

const jointLimitStep = (
  axis: JointAxis,
  direction: JointLimitDirection,
  workspaceLimited: boolean
): CalibrationStepDef => {
  const tagDir = direction === "+" ? "PLUS" : "MINUS"
  const sense = direction === "+" ? "positive (+)" : "negative (−)"
  const safeGoal = workspaceLimited
    ? `farthest *safe* ${sense} reach from home in this cell (not mechanical max — stop before walls/fixtures)`
    : `full free-space ${sense} reach from home (still cell-aware; never crash)`
  const short = `${axis}${direction}`
  return withSeed({
    id: `joint_limit_${axis}_${direction === "+" ? "plus" : "minus"}`,
    kind: "joint_limit",
    label: `${short} safe limit from home`,
    exportLabel: `${short} SAFE LIMIT FROM HOME`,
    pauseTag: `STEP_${axis}_${tagDir}`,
    description: `From home, jog *only* ${axis} to the ${safeGoal}. Prefer teaching one MOVL at this pose (MOVJ OK if linear is awkward). Pulse at this pose is what fits pulse-per-degree. Skip only if this direction is not clear.`,
    pulseHint: `STANDARD → from home jog ${axis} ${sense} to safe limit → PULSE. Label ${short}. Skip if unsafe.`,
    cartesianHint: `RELATIVE / BASE at the same ${short} pose → XYZ Rx Ry Rz. Skip if you skipped Phase A.`,
    defaultFrame: "BASE",
    axis,
    direction,
    required: false,
    skippable: true
  })
}

const extraStep = (): CalibrationStepDef =>
  withSeed({
    id: "extra_pose",
    kind: "extra",
    label: "Extra clear pose (optional)",
    exportLabel: "EXTRA CLEAR POSE",
    pauseTag: "STEP_EXTRA",
    description:
      "Any additional clear mid-workspace pose that mixes a few axes — still within the safe cell envelope.",
    pulseHint: "STANDARD → PULSE at a distinct clear pose (one position per step).",
    cartesianHint: "RELATIVE / BASE → cartesian at the same pose.",
    defaultFrame: "BASE",
    required: false,
    skippable: true
  })

/**
 * Build capture checklist: home anchor → user-frame points → per-axis S+/S− … T+/T− safe limits.
 * Default S1+S2 triples yield 20 points matching the pendant reference jobs.
 */
export const buildCalibrationSteps = (
  frames: ConfiguredUserFrame[],
  workspaceLimited = true
): CalibrationStepDef[] => {
  const steps: CalibrationStepDef[] = [homeStep()]

  for (const frame of frames) {
    if (frame.includeRorg) {
      steps.push(uframePointStep(frame, "rorg", frame.required))
    }
    if (frame.includeRxx) {
      steps.push(uframePointStep(frame, "rxx", false))
    }
    if (frame.includeRxy) {
      steps.push(uframePointStep(frame, "rxy", false))
    }
  }

  for (const axis of JOINT_AXES) {
    steps.push(jointLimitStep(axis, "+", workspaceLimited))
    steps.push(jointLimitStep(axis, "-", workspaceLimited))
  }

  steps.push(extraStep())
  return steps
}

/** Static default list for docs / export before session frames are chosen. */
export const CALIBRATION_STEPS: CalibrationStepDef[] = buildCalibrationSteps(
  defaultConfiguredFrames(),
  true
)

export const numberedExportComment = (
  step: CalibrationStepDef,
  index: number
): string => {
  return `'${index + 1} ${step.exportLabel}`
}

export const rconfForStep = (step: CalibrationStepDef): string => {
  return step.seedRconf && step.seedRconf.length > 0 ? step.seedRconf : DEFAULT_RCONF
}

export const getStepById = (
  id: string,
  steps: CalibrationStepDef[] = CALIBRATION_STEPS
): CalibrationStepDef | undefined => {
  return steps.find((step) => step.id === id)
}

export const requiredStepIds = (steps: CalibrationStepDef[] = CALIBRATION_STEPS): string[] => {
  return steps.filter((step) => step.required).map((step) => step.id)
}

export const sampleIsComplete = (sample: {
  skipped?: boolean
  pulses?: number[]
  cartesian?: { x: number }
} | undefined): boolean => {
  if (!sample) {
    return false
  }
  if (sample.skipped) {
    return true
  }
  return Boolean(sample.pulses && sample.pulses.length >= 6 && sample.cartesian)
}

export const axisIndex = (axis: JointAxis): number => AXIS_INDEX[axis]
