"""Numeric inverse kinematics, joint-limit checks, and ///RCONF derivation.

least_squares is seeded from the source point's pulses so the solution
keeps the operator's arm posture. For an X-axis station mirror the
posture-preserving seed negates S/R/T (matching re-taught S1/S2 pairs)
and falls back to the raw source pulses if that seed fails.

///RCONF (24 INFORM ints) matches this cell's cartesian jobs:

    [0] front=1 / back=0
    [1] lower=1 / upper=0
    [2] flip=1 / no-flip=0
    [3] R-axis turn (1 if |R| > 180°)
    [4] T-axis turn (1 if |T| > 180°)
    [5:] unused (0)

HOME (CUT_ONLY / AR2010 ready pose) yields ``1,0,0,0,0,...``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np
from numpy.typing import NDArray
from scipy.optimize import least_squares

from ar2010 import (
    AR2010Params,
    AXIS_NAMES,
    Pose,
    RC_PRM_PULSE_LIMITS_NEG,
    RC_PRM_PULSE_LIMITS_POS,
    default_params,
    default_tool,
    forward_kinematics,
    pose_to_matrix,
    pulses_to_degrees,
    rotation_geodesic_deg,
)

Vec = NDArray[np.float64]

RCONF_LENGTH = 24
IK_POSITION_TOL_MM = 1.0
IK_ROUNDTRIP_TOL_MM = 0.1
ORIENT_WEIGHT = 80.0


@dataclass
class IkResult:
    pulses: list[float]
    degrees: list[float]
    pose: Pose
    reachable: bool
    within_limits: bool
    position_error_mm: float
    orientation_error_deg: float
    rconf: list[int]
    rconf_text: str
    message: str
    limit_violations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "pulses": [float(v) for v in self.pulses],
            "degrees": [float(v) for v in self.degrees],
            "pose": self.pose.to_dict(),
            "reachable": self.reachable,
            "withinLimits": self.within_limits,
            "positionErrorMm": float(self.position_error_mm),
            "orientationErrorDeg": float(self.orientation_error_deg),
            "rconf": [int(v) for v in self.rconf],
            "rconfText": self.rconf_text,
            "message": self.message,
            "limitViolations": list(self.limit_violations),
        }


def degrees_to_pulses(
    degrees: Sequence[float],
    params: AR2010Params | None = None,
) -> list[float]:
    model = params or default_params()
    raw = np.asarray(list(degrees)[:6], dtype=np.float64)
    scales = np.asarray(model.pulse_per_degree[:6], dtype=np.float64)
    offsets = np.asarray(model.pulse_offsets[:6], dtype=np.float64)
    return [float(v) for v in raw * scales + offsets]


def format_rconf(bits: Sequence[int]) -> str:
    padded = [int(v) for v in bits[:RCONF_LENGTH]]
    while len(padded) < RCONF_LENGTH:
        padded.append(0)
    return ",".join(str(v) for v in padded[:RCONF_LENGTH])


def rconf_from_degrees(
    degrees: Sequence[float],
    params: AR2010Params | None = None,
) -> list[int]:
    """Front/upper/flip figure bits plus R/T turn numbers."""
    _ = params
    s_deg, l_deg, _u_deg, r_deg, b_deg, t_deg = (float(v) for v in list(degrees)[:6])
    bits = [0] * RCONF_LENGTH

    model = params or default_params()
    pulses = degrees_to_pulses(degrees, model)
    flange = forward_kinematics(pulses, tool=None, params=model).flange
    heading = flange.x * np.cos(np.deg2rad(s_deg)) + flange.y * np.sin(np.deg2rad(s_deg))
    bits[0] = 1 if heading >= 0.0 else 0
    bits[1] = 1 if l_deg > 90.0 else 0
    bits[2] = 1 if b_deg > 0.0 else 0
    bits[3] = r_turn_number(r_deg)
    bits[4] = t_turn_number(t_deg)
    return bits


def r_turn_number(r_deg: float) -> int:
    return 1 if abs(float(r_deg)) > 180.0 else 0


def t_turn_number(t_deg: float) -> int:
    return 1 if abs(float(t_deg)) > 180.0 else 0


def pulses_within_limits(
    pulses: Sequence[float],
    pulse_limits_pos: Sequence[float] | None = None,
    pulse_limits_neg: Sequence[float] | None = None,
) -> tuple[bool, list[str]]:
    pos = list(pulse_limits_pos) if pulse_limits_pos is not None else list(RC_PRM_PULSE_LIMITS_POS)
    neg = list(pulse_limits_neg) if pulse_limits_neg is not None else list(RC_PRM_PULSE_LIMITS_NEG)
    names = AXIS_NAMES
    violations: list[str] = []
    for index, pulse in enumerate(list(pulses)[:6]):
        lo = float(neg[index]) if index < len(neg) else -1.0e9
        hi = float(pos[index]) if index < len(pos) else 1.0e9
        if pulse < lo - 0.5 or pulse > hi + 0.5:
            axis = names[index].upper() if index < len(names) else f"J{index + 1}"
            violations.append(f"{axis} pulse {pulse:.0f} outside [{lo:.0f}, {hi:.0f}]")
    return len(violations) == 0, violations


def station_flip_seed(source_pulses: Sequence[float]) -> list[float]:
    """Posture-preserving seed for an X-axis station mirror: negate S, R, T."""
    row = [float(v) for v in list(source_pulses)[:6]]
    while len(row) < 6:
        row.append(0.0)
    return [-row[0], row[1], row[2], -row[3], row[4], -row[5]]


def clip_pulses_to_limits(
    pulses: Sequence[float],
    pulse_limits_pos: Sequence[float] | None = None,
    pulse_limits_neg: Sequence[float] | None = None,
) -> list[float]:
    pos = list(pulse_limits_pos) if pulse_limits_pos is not None else list(RC_PRM_PULSE_LIMITS_POS)
    neg = list(pulse_limits_neg) if pulse_limits_neg is not None else list(RC_PRM_PULSE_LIMITS_NEG)
    clipped: list[float] = []
    for index, pulse in enumerate(list(pulses)[:6]):
        lo = float(neg[index]) if index < len(neg) else -1.0e9
        hi = float(pos[index]) if index < len(pos) else 1.0e9
        clipped.append(float(np.clip(pulse, lo, hi)))
    return clipped


def inverse_kinematics(
    target: Pose,
    seed_pulses: Sequence[float],
    tool: Pose | None = None,
    params: AR2010Params | None = None,
    pulse_limits_pos: Sequence[float] | None = None,
    pulse_limits_neg: Sequence[float] | None = None,
    *,
    position_tol_mm: float = IK_POSITION_TOL_MM,
    try_station_flip_seed: bool = False,
) -> IkResult:
    """Solve pulses for a BASE-frame TCP pose. Seed keeps the source posture."""
    model = params or default_params()
    tcp = tool if tool is not None else default_tool()
    seeds: list[list[float]] = [list(seed_pulses)[:6]]
    if try_station_flip_seed:
        seeds.insert(0, station_flip_seed(seed_pulses))

    best: IkResult | None = None
    for seed in seeds:
        candidate = _solve_ik(
            target,
            seed,
            tcp,
            model,
            pulse_limits_pos,
            pulse_limits_neg,
            position_tol_mm,
        )
        if best is None or candidate.position_error_mm < best.position_error_mm:
            best = candidate
        if candidate.reachable and candidate.within_limits:
            return candidate
    assert best is not None
    return best


def _solve_ik(
    target: Pose,
    seed_pulses: Sequence[float],
    tool: Pose,
    params: AR2010Params,
    pulse_limits_pos: Sequence[float] | None,
    pulse_limits_neg: Sequence[float] | None,
    position_tol_mm: float,
) -> IkResult:
    pos = list(pulse_limits_pos) if pulse_limits_pos is not None else list(RC_PRM_PULSE_LIMITS_POS)
    neg = list(pulse_limits_neg) if pulse_limits_neg is not None else list(RC_PRM_PULSE_LIMITS_NEG)
    x0 = np.asarray(clip_pulses_to_limits(seed_pulses, pos, neg), dtype=np.float64)
    expected = pose_to_matrix(target)
    lo = np.asarray([float(v) for v in neg[:6]], dtype=np.float64)
    hi = np.asarray([float(v) for v in pos[:6]], dtype=np.float64)

    def residual(values: Vec) -> Vec:
        result = forward_kinematics(values, tool=tool, params=params)
        delta = result.matrix[:3, 3] - expected[:3, 3]
        relative = result.matrix[:3, :3].T @ expected[:3, :3]
        omega = np.array(
            [
                relative[2, 1] - relative[1, 2],
                relative[0, 2] - relative[2, 0],
                relative[1, 0] - relative[0, 1],
            ]
        )
        return np.concatenate([delta, omega * ORIENT_WEIGHT])

    solution = least_squares(
        residual,
        x0,
        bounds=(lo, hi),
        method="trf",
        xtol=1e-10,
        ftol=1e-10,
        max_nfev=400,
    )
    pulses = [float(v) for v in solution.x[:6]]
    fk = forward_kinematics(pulses, tool=tool, params=params)
    pos_err = float(np.linalg.norm(fk.matrix[:3, 3] - expected[:3, 3]))
    ori_err = rotation_geodesic_deg(fk.matrix[:3, :3], expected[:3, :3])
    degrees = [float(v) for v in pulses_to_degrees(pulses, params)]
    within, violations = pulses_within_limits(pulses, pos, neg)
    reachable = bool(solution.success) and pos_err <= position_tol_mm
    rconf = rconf_from_degrees(degrees, params)
    if reachable and within:
        message = f"IK ok ({pos_err:.3f} mm, {ori_err:.3f} deg)"
    elif not reachable:
        message = f"Unreachable: IK residual {pos_err:.2f} mm ({ori_err:.2f} deg)"
    else:
        message = "Joint limit: " + "; ".join(violations)
    return IkResult(
        pulses=pulses,
        degrees=degrees,
        pose=fk.pose,
        reachable=reachable and within,
        within_limits=within,
        position_error_mm=pos_err,
        orientation_error_deg=ori_err,
        rconf=rconf,
        rconf_text=format_rconf(rconf),
        message=message,
        limit_violations=violations,
    )
