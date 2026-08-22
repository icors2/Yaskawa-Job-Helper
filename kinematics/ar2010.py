"""MOTOMAN AR2010 forward kinematics.

The chain matches ros-industrial/motoman `ar2010_macro.xacro` (kinetic-devel),
expressed in the manufacturer BASE frame (S/L intersection, not the floor).

RC.PRM ///RC1G row 1 stores a1/a2/a3/d4 in microns (150/760/200/1082 mm).
Row 2 stores d6 = 100 mm. Floor-to-S height 505 mm is ROS base_link only.

Pulse-per-degree seeds come from RC.PRM pulse limits divided by the motion
range on this controller (S/L/U from the US datasheet, R/B/T from the
expanded wrist ranges that make those limits consistent: ±200 / ±150 / ±455).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np
from numpy.typing import NDArray

Mat = NDArray[np.float64]
Vec = NDArray[np.float64]

AXIS_NAMES = ("s", "l", "u", "r", "b", "t")
AR2010_REACH_MM = 2010.0
AR2010_BASE_HEIGHT_MM = 505.0

# RC.PRM ///RC1G pulse soft-limits (lines 118-119 of the DYNAMIC1 backup).
RC_PRM_PULSE_LIMITS_POS = (241449.0, 295690.0, 254863.0, 204573.0, 147036.0, 206914.0)
RC_PRM_PULSE_LIMITS_NEG = (-241449.0, -200306.0, -136989.0, -204573.0, -147036.0, -206914.0)

# Degree ranges that make those pulse limits a constant pulses/deg per axis.
# S/L/U match the published AR2010 sheet. R/B/T match the expanded (EU) wrist.
RC_PRM_DEGREE_RANGES_POS = (180.0, 155.0, 160.0, 200.0, 150.0, 455.0)
RC_PRM_DEGREE_RANGES_NEG = (-180.0, -105.0, -86.0, -200.0, -150.0, -455.0)

DEFAULT_TOOL0 = (-88.687, 0.981, 463.147, 0.0, -45.0, 0.0)
HOME_PULSES = (0.0, -75310.0, 1200.0, 0.0, -127658.0, -70.0)
HOME_CARTESIAN = (275.0, 0.0, 875.0, 180.0, 45.0, 0.0)


def _seed_pulse_per_degree() -> tuple[float, ...]:
    return tuple(
        abs(limit) / abs(degrees)
        for limit, degrees in zip(RC_PRM_PULSE_LIMITS_POS, RC_PRM_DEGREE_RANGES_POS, strict=True)
    )


@dataclass
class Pose:
    x: float
    y: float
    z: float
    rx: float
    ry: float
    rz: float

    def as_tuple(self) -> tuple[float, float, float, float, float, float]:
        return (self.x, self.y, self.z, self.rx, self.ry, self.rz)

    def to_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "z": self.z, "rx": self.rx, "ry": self.ry, "rz": self.rz}

    @classmethod
    def from_dict(cls, data: dict[str, float]) -> Pose:
        return cls(
            float(data["x"]),
            float(data["y"]),
            float(data["z"]),
            float(data["rx"]),
            float(data["ry"]),
            float(data["rz"]),
        )

    @classmethod
    def from_xyzrpy(cls, values: Sequence[float]) -> Pose:
        if len(values) < 6:
            raise ValueError("pose requires X,Y,Z,Rx,Ry,Rz")
        return cls(
            float(values[0]),
            float(values[1]),
            float(values[2]),
            float(values[3]),
            float(values[4]),
            float(values[5]),
        )


@dataclass
class AR2010Params:
    """Geometric and pulse-conversion parameters (all lengths in mm)."""

    a1: float = 150.0
    a2: float = 760.0
    a3: float = 200.0
    d4: float = 1082.0
    d6: float = 100.0
    d1: float = 0.0
    pulse_per_degree: tuple[float, ...] = field(default_factory=_seed_pulse_per_degree)
    pulse_offsets: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    reach_mm: float = AR2010_REACH_MM

    def to_dict(self) -> dict[str, float]:
        values: dict[str, float] = {
            "a1": self.a1,
            "a2": self.a2,
            "a3": self.a3,
            "d4": self.d4,
            "d6": self.d6,
            "d1": self.d1,
            "reach_mm": self.reach_mm,
        }
        for name, ppd, offset in zip(
            AXIS_NAMES, self.pulse_per_degree, self.pulse_offsets, strict=True
        ):
            values[f"pulse_per_degree_{name}"] = float(ppd)
            values[f"pulse_offset_{name}"] = float(offset)
        return values

    @classmethod
    def from_dict(cls, data: dict[str, float]) -> AR2010Params:
        params = cls()
        for key in ("a1", "a2", "a3", "d4", "d6", "d1", "reach_mm"):
            if key in data:
                setattr(params, key, float(data[key]))
        ppd = list(params.pulse_per_degree)
        offsets = list(params.pulse_offsets)
        for index, name in enumerate(AXIS_NAMES):
            ppd_key = f"pulse_per_degree_{name}"
            off_key = f"pulse_offset_{name}"
            if ppd_key in data:
                ppd[index] = float(data[ppd_key])
            if off_key in data:
                offsets[index] = float(data[off_key])
        params.pulse_per_degree = tuple(ppd)
        params.pulse_offsets = tuple(offsets)
        return params


@dataclass
class KinematicResult:
    pose: Pose
    flange: Pose
    degrees: tuple[float, ...]
    matrix: Mat
    flange_matrix: Mat

    def to_dict(self) -> dict[str, object]:
        return {
            "pose": self.pose.to_dict(),
            "flangePose": self.flange.to_dict(),
            "degrees": list(self.degrees),
        }


def default_params() -> AR2010Params:
    return AR2010Params()


def default_tool() -> Pose:
    return Pose.from_xyzrpy(DEFAULT_TOOL0)


def _as_six(values: Sequence[float], label: str) -> Vec:
    if len(values) < 6:
        raise ValueError(f"{label} needs at least 6 values")
    return np.asarray(values[:6], dtype=np.float64)


def rpy_to_rotation(rx_rad: float, ry_rad: float, rz_rad: float) -> Mat:
    cr, sr = np.cos(rx_rad), np.sin(rx_rad)
    cp, sp = np.cos(ry_rad), np.sin(ry_rad)
    cy, sy = np.cos(rz_rad), np.sin(rz_rad)
    rx = np.array([[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]])
    ry = np.array([[cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]])
    rz = np.array([[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]])
    return rz @ ry @ rx


def yaskawa_zyx_to_rotation(rx_deg: float, ry_deg: float, rz_deg: float) -> Mat:
    return rpy_to_rotation(np.deg2rad(rx_deg), np.deg2rad(ry_deg), np.deg2rad(rz_deg))


def rotation_to_yaskawa_zyx(rotation: Mat) -> tuple[float, float, float]:
    pitch = float(np.arcsin(np.clip(-rotation[2, 0], -1.0, 1.0)))
    if abs(rotation[2, 0]) < 0.999999:
        roll = float(np.arctan2(rotation[2, 1], rotation[2, 2]))
        yaw = float(np.arctan2(rotation[1, 0], rotation[0, 0]))
    else:
        roll = 0.0
        yaw = float(np.arctan2(-rotation[0, 1], rotation[1, 1]))
    return (np.rad2deg(roll), np.rad2deg(pitch), np.rad2deg(yaw))


def transform(xyz: Sequence[float], rpy_rad: Sequence[float]) -> Mat:
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = rpy_to_rotation(float(rpy_rad[0]), float(rpy_rad[1]), float(rpy_rad[2]))
    matrix[:3, 3] = np.asarray(xyz, dtype=np.float64)
    return matrix


def pose_to_matrix(pose: Pose) -> Mat:
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = yaskawa_zyx_to_rotation(pose.rx, pose.ry, pose.rz)
    matrix[:3, 3] = [pose.x, pose.y, pose.z]
    return matrix


def matrix_to_pose(matrix: Mat) -> Pose:
    rx, ry, rz = rotation_to_yaskawa_zyx(matrix[:3, :3])
    return Pose(float(matrix[0, 3]), float(matrix[1, 3]), float(matrix[2, 3]), rx, ry, rz)


def invert_transform(matrix: Mat) -> Mat:
    inverse = np.eye(4, dtype=np.float64)
    rotation = matrix[:3, :3]
    inverse[:3, :3] = rotation.T
    inverse[:3, 3] = -rotation.T @ matrix[:3, 3]
    return inverse


def compose_poses(parent: Pose, child: Pose) -> Pose:
    return matrix_to_pose(pose_to_matrix(parent) @ pose_to_matrix(child))


def relative_pose(world_pose: Pose, frame: Pose) -> Pose:
    return matrix_to_pose(invert_transform(pose_to_matrix(frame)) @ pose_to_matrix(world_pose))


def rotation_geodesic_deg(a: Mat, b: Mat) -> float:
    relative = a.T @ b
    trace = np.clip((np.trace(relative) - 1.0) * 0.5, -1.0, 1.0)
    return float(np.rad2deg(np.arccos(trace)))


def _rotz(angle_rad: float) -> Mat:
    cosine, sine = np.cos(angle_rad), np.sin(angle_rad)
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, :3] = [[cosine, -sine, 0.0], [sine, cosine, 0.0], [0.0, 0.0, 1.0]]
    return matrix


def pulses_to_degrees(
    pulses: Sequence[float],
    params: AR2010Params | None = None,
) -> list[float]:
    model = params or default_params()
    raw = _as_six(pulses, "pulses")
    offsets = np.asarray(model.pulse_offsets, dtype=np.float64)
    scales = np.asarray(model.pulse_per_degree, dtype=np.float64)
    if np.any(np.abs(scales) < 1e-9):
        raise ValueError("pulse_per_degree contains a zero scale")
    degrees = (raw - offsets) / scales
    return [float(value) for value in degrees]


def _flange_matrix(degrees: Sequence[float], params: AR2010Params) -> Mat:
    joints = np.deg2rad(_as_six(degrees, "degrees"))
    origins = (
        transform([0.0, 0.0, params.d1], [0.0, 0.0, 0.0]),
        transform([params.a1, 0.0, 0.0], [np.pi / 2.0, -np.pi / 2.0, -np.pi]),
        transform([params.a2, 0.0, 0.0], [np.pi, 0.0, 0.0]),
        transform([params.a3, -params.d4, 0.0], [-np.pi / 2.0, 0.0, 0.0]),
        transform([0.0, 0.0, 0.0], [np.pi / 2.0, 0.0, 0.0]),
        transform([0.0, -params.d6, 0.0], [-np.pi / 2.0, 0.0, 0.0]),
    )
    flange = transform([0.0, 0.0, 0.0], [0.0, np.pi / 2.0, 0.0])
    tool0 = transform([0.0, 0.0, 0.0], [np.pi, -np.pi / 2.0, 0.0])
    world = np.eye(4, dtype=np.float64)
    for origin, joint in zip(origins, joints, strict=True):
        world = world @ origin @ _rotz(float(joint))
    return world @ flange @ tool0


def forward_kinematics(
    pulses: Sequence[float],
    tool: Pose | None = None,
    params: AR2010Params | None = None,
    user_frame: Pose | None = None,
) -> KinematicResult:
    model = params or default_params()
    degrees = tuple(pulses_to_degrees(pulses, model))
    flange_matrix = _flange_matrix(degrees, model)
    tcp_matrix = flange_matrix if tool is None else flange_matrix @ pose_to_matrix(tool)
    if user_frame is not None:
        frame_inv = invert_transform(pose_to_matrix(user_frame))
        flange_matrix = frame_inv @ flange_matrix
        tcp_matrix = frame_inv @ tcp_matrix
    return KinematicResult(
        pose=matrix_to_pose(tcp_matrix),
        flange=matrix_to_pose(flange_matrix),
        degrees=degrees,
        matrix=tcp_matrix,
        flange_matrix=flange_matrix,
    )


def xyz_error_mm(computed: Pose, expected: Pose) -> float:
    delta = np.array(
        [computed.x - expected.x, computed.y - expected.y, computed.z - expected.z]
    )
    return float(np.linalg.norm(delta))


def fk_pulse(
    pulses: Sequence[float],
    tool_xyzrpy: Sequence[float] | None = None,
    params: AR2010Params | None = None,
) -> Pose:
    """Convenience FK returning XYZ + RPY degrees (tool defaults to TOOL 0)."""
    tool = default_tool() if tool_xyzrpy is None else Pose.from_xyzrpy(tool_xyzrpy)
    return forward_kinematics(pulses, tool=tool, params=params).pose


def fk_to_frame(pose_base: Pose | Sequence[float], frame_buser: Pose | Sequence[float]) -> Pose:
    """Transform a base-frame pose into user-frame-relative coordinates."""
    base = pose_base if isinstance(pose_base, Pose) else Pose.from_xyzrpy(pose_base)
    frame = frame_buser if isinstance(frame_buser, Pose) else Pose.from_xyzrpy(frame_buser)
    return relative_pose(base, frame)


# Aliases used by the editor sidecar / verify script
HOME_POSE_XYZRPY = HOME_CARTESIAN
seed_params_from_rcprm = default_params
