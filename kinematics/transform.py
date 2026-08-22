"""Frame move, mirror, offset, and reach-envelope helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from ar2010 import (
    AR2010_REACH_MM,
    Pose,
    forward_kinematics,
    matrix_to_pose,
    pose_to_matrix,
    relative_pose,
)

MirrorPlane = Literal["XY", "XZ", "YZ"]


@dataclass
class ReachCheck:
    horizontal_mm: float
    radial_mm: float
    within_reach: bool
    heuristic: str

    def to_dict(self) -> dict[str, object]:
        return {
            "horizontalMm": self.horizontal_mm,
            "radialMm": self.radial_mm,
            "withinReach": self.within_reach,
            "heuristic": self.heuristic,
        }


def frame_move(pose: Pose, source_frame_id: int, target_frame_id: int) -> Pose:
    """Reuse the same user-frame numbers; the caller relabels ///USER.

    `source_frame_id` is accepted so the API matches the sidecar contract.
    The relative XYZRxRyRz are identity — only the frame label changes.
    """
    _ = source_frame_id
    _ = target_frame_id
    return Pose(pose.x, pose.y, pose.z, pose.rx, pose.ry, pose.rz)


def pulses_in_user_frame(
    pulses: list[float],
    source_frame: Pose,
    tool: Pose | None = None,
    params=None,
) -> Pose:
    result = forward_kinematics(pulses, tool=tool, params=params)
    return relative_pose(result.pose, source_frame)


def mirror(pose: Pose, plane: MirrorPlane) -> tuple[Pose, bool]:
    """Reflect a pose across a plane of the current frame.

    Handedness reverses, so the returned flag tells the UI to review ///RCONF
    on the pendant instead of guessing the flip bit.
    """
    if plane == "XZ":
        reflect = np.diag([1.0, -1.0, 1.0])
    elif plane == "YZ":
        reflect = np.diag([-1.0, 1.0, 1.0])
    elif plane == "XY":
        reflect = np.diag([1.0, 1.0, -1.0])
    else:
        raise ValueError(f"unsupported mirror plane: {plane}")

    matrix = pose_to_matrix(pose)
    rotation = matrix[:3, :3]
    origin = matrix[:3, 3]
    mirrored = np.eye(4, dtype=np.float64)
    mirrored[:3, :3] = reflect @ rotation @ reflect
    mirrored[:3, 3] = reflect @ origin
    return matrix_to_pose(mirrored), True


def offset(pose: Pose, dxyz: tuple[float, float, float], drpy: tuple[float, float, float]) -> Pose:
    """Apply XYZ mm and RPY deg deltas in the current USER/BASE cartesian frame.

    XYZ are added in frame coordinates. RPY is a fixed-frame rotation
    (R' = R_delta @ R) about the same frame — matching pendant-style
    shifts in USER/BASE space, not a body-fixed tool twist.
    """
    translated = Pose(
        pose.x + float(dxyz[0]),
        pose.y + float(dxyz[1]),
        pose.z + float(dxyz[2]),
        pose.rx,
        pose.ry,
        pose.rz,
    )
    if abs(drpy[0]) < 1e-15 and abs(drpy[1]) < 1e-15 and abs(drpy[2]) < 1e-15:
        return translated
    # Fixed-frame: rotate orientation in the current cartesian frame, keep XYZ.
    matrix = pose_to_matrix(translated)
    delta_rot = pose_to_matrix(
        Pose(0.0, 0.0, 0.0, float(drpy[0]), float(drpy[1]), float(drpy[2]))
    )[:3, :3]
    matrix[:3, :3] = delta_rot @ matrix[:3, :3]
    return matrix_to_pose(matrix)


def offset_pose(pose: Pose, delta: Pose) -> Pose:
    return offset(pose, (delta.x, delta.y, delta.z), (delta.rx, delta.ry, delta.rz))


def reach_envelope(pose: Pose, reach_mm: float = AR2010_REACH_MM) -> ReachCheck:
    horizontal = float(np.hypot(pose.x, pose.y))
    radial = float(np.sqrt(pose.x * pose.x + pose.y * pose.y + pose.z * pose.z))
    within = horizontal <= reach_mm
    note = (
        f"Horizontal distance {horizontal:.1f} mm vs AR2010 reach {reach_mm:.0f} mm "
        "(heuristic only; joint limits are not checked)"
    )
    return ReachCheck(horizontal, radial, within, note)
