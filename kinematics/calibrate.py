"""SciPy least_squares fit of pulse-per-degree and home pulse offsets."""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Sequence
from uuid import uuid4

import numpy as np
from numpy.typing import NDArray
from scipy.optimize import least_squares

from ar2010 import (
    AR2010Params,
    HOME_CARTESIAN,
    HOME_PULSES,
    Pose,
    default_params,
    default_tool,
    forward_kinematics,
    pose_to_matrix,
    pulses_to_degrees,
    rotation_geodesic_deg,
    xyz_error_mm,
)
from cnd import UserFrame, find_frame

Vec = NDArray[np.float64]

# Labels like "S+", "L-", "STEP_S_PLUS", "joint_limit_S_plus", "S+ safe limit from home"
_AXIS_LIMIT_RE = re.compile(
    r"(?:^|[^A-Z])(?P<axis>[SLURBT])\s*(?P<dir>[+\-]|PLUS|MINUS|_plus|_minus)",
    re.IGNORECASE,
)
_AXIS_ORDER = "SLURBT"


@dataclass
class CalibPair:
    pulses: list[float]
    cartesian: Pose
    weight_mm: float = 1.0
    weight_rot: float = 1.0
    match_orientation: bool = True
    label: str = ""
    # Coordinate frame of `cartesian`: BASE (default) or USER (relative to UFRAME BUSER).
    frame: str = "BASE"
    user_frame_id: int | None = None


def _resolve_user_frame(
    pair: CalibPair,
    frames: Sequence[UserFrame] | None,
) -> Pose | None:
    frame_name = (pair.frame or "BASE").upper()
    if frame_name != "USER":
        return None
    if pair.user_frame_id is None:
        raise ValueError(f"pair {pair.label or '?'} has frame=USER but no userFrameId")
    if not frames:
        raise ValueError(
            f"pair {pair.label or '?'} needs loaded UFRAME.CND for USER frame "
            f"{pair.user_frame_id}"
        )
    return find_frame(list(frames), int(pair.user_frame_id)).buser


def parse_axis_limit_label(label: str) -> tuple[str, str] | None:
    """Return (axis letter, '+'|'-') if label encodes a joint safe-limit sample."""
    if not label:
        return None
    match = _AXIS_LIMIT_RE.search(label.replace("safe limit", " "))
    if not match:
        return None
    axis = match.group("axis").upper()
    raw_dir = match.group("dir").upper().replace("_", "")
    direction = "+" if raw_dir in {"+", "PLUS"} else "-"
    return axis, direction


def _find_home_pair(pairs: Sequence[CalibPair]) -> CalibPair | None:
    for pair in pairs:
        if pair.label and "home" in pair.label.lower():
            return pair
    return None


def estimate_scales_from_joint_limits(
    pairs: Sequence[CalibPair],
    seed: AR2010Params,
) -> AR2010Params:
    """Seed pulse_per_degree from home → ±limit pulse deltas.

    For each axis with a home sample and at least one S+/S− (etc.) limit,
    estimate scale as Δpulses / Δdegrees where Δdegrees uses the current seed
    conversion on that axis only. Larger safe-range spans improve conditioning
    vs tiny deltas. Missing sides are skipped.
    """
    home = _find_home_pair(pairs)
    if home is None or len(home.pulses) < 6:
        return seed

    scales = list(seed.pulse_per_degree)
    by_axis: dict[str, list[CalibPair]] = {letter: [] for letter in _AXIS_ORDER}
    for pair in pairs:
        parsed = parse_axis_limit_label(pair.label)
        if parsed is None or len(pair.pulses) < 6:
            continue
        axis, _direction = parsed
        by_axis[axis].append(pair)

    for axis_letter, limit_pairs in by_axis.items():
        if not limit_pairs:
            continue
        index = _AXIS_ORDER.index(axis_letter)
        home_pulse = float(home.pulses[index])
        numerators: list[float] = []
        denominators: list[float] = []
        for limit in limit_pairs:
            delta_pulse = float(limit.pulses[index]) - home_pulse
            if abs(delta_pulse) < 50.0:
                continue
            home_deg = pulses_to_degrees(home.pulses, seed)[index]
            limit_deg = pulses_to_degrees(limit.pulses, seed)[index]
            delta_deg = limit_deg - home_deg
            if abs(delta_deg) < 1e-6:
                delta_deg = delta_pulse / float(seed.pulse_per_degree[index])
            numerators.append(abs(delta_pulse))
            denominators.append(abs(delta_deg))
        if not numerators:
            continue
        if len(numerators) >= 2:
            est = sum(numerators) / max(sum(denominators), 1e-9)
        else:
            est = numerators[0] / max(denominators[0], 1e-9)
        if 200.0 <= est <= 4000.0:
            scales[index] = float(est)

    return AR2010Params(
        a1=seed.a1,
        a2=seed.a2,
        a3=seed.a3,
        d4=seed.d4,
        d6=seed.d6,
        d1=seed.d1,
        pulse_per_degree=tuple(scales),
        pulse_offsets=seed.pulse_offsets,
        reach_mm=seed.reach_mm,
    )


def weight_joint_limit_pairs(pairs: Sequence[CalibPair], boost: float = 2.0) -> list[CalibPair]:
    """Up-weight home→±limit samples so large safe-range spans dominate the fit."""
    out: list[CalibPair] = []
    for pair in pairs:
        if parse_axis_limit_label(pair.label) is not None:
            out.append(
                replace(
                    pair,
                    weight_mm=pair.weight_mm * boost,
                    weight_rot=pair.weight_rot * boost,
                )
            )
        else:
            out.append(pair)
    return out


@dataclass
class ResidualReport:
    rms_mm: float
    worst_mm: float
    per_pair: list[dict[str, float]] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "rmsMm": self.rms_mm,
            "worstMm": self.worst_mm,
            "perPair": self.per_pair,
        }


@dataclass
class CalibrationResult:
    calibration_id: str
    params: AR2010Params
    residuals: ResidualReport
    success: bool
    message: str

    def to_dict(self) -> dict[str, object]:
        return {
            "calibrationId": self.calibration_id,
            "parameters": self.params.to_dict(),
            "residuals": self.residuals.to_dict(),
            "success": self.success,
            "message": self.message,
        }


def backup_seed_pairs(tool: Pose | None = None) -> list[CalibPair]:
    _ = tool
    return [
        CalibPair(
            pulses=list(HOME_PULSES),
            cartesian=Pose.from_xyzrpy(HOME_CARTESIAN),
            weight_rot=1.0,
            label="home",
        )
    ]


def uframe_pairs(frames: Sequence[UserFrame]) -> list[CalibPair]:
    pairs: list[CalibPair] = []
    for frame in frames:
        pairs.append(
            CalibPair(
                pulses=list(frame.rorg[:6]),
                cartesian=frame.buser,
                match_orientation=False,
                label=f"{frame.name}-RORG",
            )
        )
    return pairs


def _frame_rotation(p0: Vec, px: Vec, py: Vec) -> NDArray[np.float64]:
    x_axis = px - p0
    x_norm = np.linalg.norm(x_axis)
    if x_norm < 1e-9:
        raise ValueError("RXX coincides with RORG")
    x_axis = x_axis / x_norm
    z_axis = np.cross(x_axis, py - p0)
    z_norm = np.linalg.norm(z_axis)
    if z_norm < 1e-9:
        raise ValueError("RXY is collinear with RORG/RXX")
    z_axis = z_axis / z_norm
    y_axis = np.cross(z_axis, x_axis)
    return np.column_stack((x_axis, y_axis, z_axis))


def _pack(params: AR2010Params) -> Vec:
    return np.concatenate(
        [
            np.asarray(params.pulse_per_degree, dtype=np.float64),
            np.asarray(params.pulse_offsets, dtype=np.float64),
        ]
    )


def _unpack(seed: AR2010Params, values: Vec) -> AR2010Params:
    fitted = AR2010Params(
        a1=seed.a1,
        a2=seed.a2,
        a3=seed.a3,
        d4=seed.d4,
        d6=seed.d6,
        d1=seed.d1,
        pulse_per_degree=tuple(float(v) for v in values[:6]),
        pulse_offsets=tuple(float(v) for v in values[6:12]),
        reach_mm=seed.reach_mm,
    )
    return fitted


def evaluate_residuals(
    pairs: Sequence[CalibPair],
    params: AR2010Params,
    tool: Pose | None = None,
    frames: Sequence[UserFrame] | None = None,
) -> ResidualReport:
    tcp_tool = tool if tool is not None else default_tool()
    per_pair: list[dict[str, float]] = []
    errors: list[float] = []
    for pair in pairs:
        user_frame = _resolve_user_frame(pair, frames)
        result = forward_kinematics(
            pair.pulses, tool=tcp_tool, params=params, user_frame=user_frame
        )
        err = xyz_error_mm(result.pose, pair.cartesian)
        rot = rotation_geodesic_deg(
            result.matrix[:3, :3],
            pose_to_matrix(pair.cartesian)[:3, :3],
        )
        errors.append(err)
        row: dict[str, float] = {"xyzMm": err, "rotDeg": rot}
        if pair.user_frame_id is not None:
            row["userFrameId"] = float(pair.user_frame_id)
        per_pair.append(row)
    if frames:
        for frame in frames:
            origin = forward_kinematics(frame.rorg, tool=tcp_tool, params=params)
            err = xyz_error_mm(origin.pose, frame.buser)
            rot = 0.0
            if frame.rxx and frame.rxy:
                px = forward_kinematics(frame.rxx, tool=tcp_tool, params=params).matrix[:3, 3]
                py = forward_kinematics(frame.rxy, tool=tcp_tool, params=params).matrix[:3, 3]
                built = _frame_rotation(origin.matrix[:3, 3], px, py)
                rot = rotation_geodesic_deg(built, pose_to_matrix(frame.buser)[:3, :3])
            errors.append(err)
            per_pair.append({"xyzMm": err, "rotDeg": rot, "frame": float(frame.id)})
    if not errors:
        return ResidualReport(0.0, 0.0, per_pair)
    rms = float(np.sqrt(np.mean(np.square(errors))))
    return ResidualReport(rms, float(max(errors)), per_pair)


def is_calibrated(
    residuals: ResidualReport | Sequence[float] | CalibrationResult,
    threshold_mm: float,
) -> bool:
    """Hard gate: worst-case XYZ residual must be at or below threshold_mm."""
    if isinstance(residuals, CalibrationResult):
        worst = residuals.residuals.worst_mm
    elif isinstance(residuals, ResidualReport):
        worst = residuals.worst_mm
    else:
        worst = float(max(abs(float(v)) for v in residuals)) if residuals else 0.0
    return worst <= threshold_mm


def calibrate(
    pairs: Sequence[CalibPair],
    seed: AR2010Params | None = None,
    tool: Pose | None = None,
    frames: Sequence[UserFrame] | None = None,
) -> CalibrationResult:
    if not pairs and not frames:
        pairs = backup_seed_pairs()
    model = seed or default_params()
    # Home→±limit pairs: boost weight + seed scales from large safe-range spans
    weighted = weight_joint_limit_pairs(list(pairs))
    model = estimate_scales_from_joint_limits(weighted, model)
    tcp_tool = tool if tool is not None else default_tool()
    x0 = _pack(model)

    def residual(values: Vec) -> Vec:
        candidate = _unpack(model, values)
        rows: list[float] = []
        for pair in weighted:
            user_frame = _resolve_user_frame(pair, frames)
            result = forward_kinematics(
                pair.pulses, tool=tcp_tool, params=candidate, user_frame=user_frame
            )
            expected = pose_to_matrix(pair.cartesian)
            delta = (result.matrix[:3, 3] - expected[:3, 3]) * pair.weight_mm
            rows.extend(delta.tolist())
            if pair.match_orientation:
                relative = result.matrix[:3, :3].T @ expected[:3, :3]
                omega = np.array(
                    [
                        relative[2, 1] - relative[1, 2],
                        relative[0, 2] - relative[2, 0],
                        relative[1, 0] - relative[0, 1],
                    ]
                )
                rows.extend((omega * 80.0 * pair.weight_rot).tolist())
        if frames:
            for frame in frames:
                origin = forward_kinematics(frame.rorg, tool=tcp_tool, params=candidate)
                expected = pose_to_matrix(frame.buser)
                rows.extend((origin.matrix[:3, 3] - expected[:3, 3]).tolist())
                if frame.rxx and frame.rxy:
                    px = forward_kinematics(frame.rxx, tool=tcp_tool, params=candidate).matrix[:3, 3]
                    py = forward_kinematics(frame.rxy, tool=tcp_tool, params=candidate).matrix[:3, 3]
                    built = _frame_rotation(origin.matrix[:3, 3], px, py)
                    relative = built.T @ expected[:3, :3]
                    omega = np.array(
                        [
                            relative[2, 1] - relative[1, 2],
                            relative[0, 2] - relative[2, 0],
                            relative[1, 0] - relative[0, 1],
                        ]
                    )
                    rows.extend((omega * 80.0).tolist())
        return np.asarray(rows, dtype=np.float64)

    solution = least_squares(
        residual,
        x0,
        bounds=(
            [200.0, 200.0, 200.0, 200.0, 200.0, 200.0, -2.0e5, -2.0e5, -2.0e5, -2.0e5, -2.0e5, -2.0e5],
            [4000.0, 4000.0, 4000.0, 4000.0, 4000.0, 4000.0, 2.0e5, 2.0e5, 2.0e5, 2.0e5, 2.0e5, 2.0e5],
        ),
        xtol=1e-10,
    )
    fitted = _unpack(model, solution.x)
    report = evaluate_residuals(weighted, fitted, tool=tcp_tool, frames=frames)
    return CalibrationResult(
        calibration_id=f"cal-{uuid4().hex[:10]}",
        params=fitted,
        residuals=report,
        success=bool(solution.success) and report.worst_mm < 5.0,
        message=(
            f"least_squares nfev={solution.nfev} cost={solution.cost:.4f} "
            f"rms={report.rms_mm:.3f} mm worst={report.worst_mm:.3f} mm"
        ),
    )
