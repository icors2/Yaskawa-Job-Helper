"""User-frame convert / Flip — homogeneous transform between USER frames.

Ports workspace ``Flip.py`` into the kinematics package.

Math (Yaskawa ZYX Euler, same as ``ar2010.pose_to_matrix``):

    P_new = inv(UF_new) @ UF_old @ P_old

Optional tool Z 180° flip (default ON, keeps wrist healthy):

    P_final = P_new @ R_flip   where R_flip[:3,:3] = diag(-1, -1, 1)

UF poses are BUSER (or equivalent) ``[X, Y, Z, Rx, Ry, Rz]`` from UFRAME.CND.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Sequence

import numpy as np

from ar2010 import Pose, matrix_to_pose, pose_to_matrix

# Tool Z 180° — same as Flip.py (stops /OV wrist-twist faults).
TOOL_Z_FLIP = np.eye(4, dtype=np.float64)
TOOL_Z_FLIP[0:3, 0:3] = np.array(
    [[-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]],
    dtype=np.float64,
)

# Flip.py C#####= decimal pattern (also used for P#####= cartesian).
_CART_POSE_LINE = re.compile(
    r"^([CP]\d+=)"
    r"(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),"
    r"(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)"
    r"(.*)$"
)

# Integer PULSE rows look like P00001=123,-456,... without decimals — skip those.
_PULSE_INT_LINE = re.compile(r"^[CP]\d+=-?\d+(?:,-?\d+){5,}")


def euref_to_matrix(x: float, y: float, z: float, rx: float, ry: float, rz: float) -> np.ndarray:
    """Build 4×4 from XYZ mm + RxRyRz deg (Yaskawa intrinsic ZYX)."""
    return pose_to_matrix(Pose(float(x), float(y), float(z), float(rx), float(ry), float(rz)))


def matrix_to_euref(matrix: np.ndarray) -> list[float]:
    pose = matrix_to_pose(matrix)
    return [pose.x, pose.y, pose.z, pose.rx, pose.ry, pose.rz]


def tool_z_flip_matrix() -> np.ndarray:
    return TOOL_Z_FLIP.copy()


def convert_pose(
    pose: Pose,
    uf_old: Pose,
    uf_new: Pose,
    *,
    apply_tool_z_flip: bool = True,
) -> Pose:
    """Convert one cartesian pose from uf_old into uf_new coordinates."""
    m_old = pose_to_matrix(uf_old)
    m_new = pose_to_matrix(uf_new)
    m_p = pose_to_matrix(pose)
    m_out = np.linalg.inv(m_new) @ m_old @ m_p
    if apply_tool_z_flip:
        m_out = m_out @ TOOL_Z_FLIP
    return matrix_to_pose(m_out)


def convert_poses(
    poses: Sequence[Pose],
    uf_old: Pose,
    uf_new: Pose,
    *,
    apply_tool_z_flip: bool = True,
) -> list[Pose]:
    return [
        convert_pose(pose, uf_old, uf_new, apply_tool_z_flip=apply_tool_z_flip)
        for pose in poses
    ]


def format_pose_coords(pose: Pose, xyz_digits: int = 3, rpy_digits: int = 4) -> str:
    """Match app ``formatPose`` (3 XYZ / 4 RPY). Flip.py CLI used 3/3 — pass rpy_digits=3 if needed."""
    vals = [pose.x, pose.y, pose.z, pose.rx, pose.ry, pose.rz]
    return ",".join(
        f"{v:.{xyz_digits if i < 3 else rpy_digits}f}" for i, v in enumerate(vals)
    )


def convert_jbi_text(
    text: str,
    uf_old: Pose,
    uf_new: Pose,
    target_user_frame: int,
    *,
    apply_tool_z_flip: bool = True,
    name_suffix: str | None = None,
) -> tuple[str, dict[str, int | list[str]]]:
    """Rewrite cartesian C/P decimal lines and ///USER; skip integer PULSE rows.

    Returns ``(new_text, stats)`` where stats has converted / skippedPulse / warnings.
    """
    lines = text.splitlines(keepends=True)
    new_lines: list[str] = []
    converted = 0
    skipped_pulse = 0
    warnings: list[str] = []

    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("///USER"):
            eol = "\n" if line.endswith("\n") else ""
            new_lines.append(f"///USER {int(target_user_frame)}{eol}")
            continue

        if name_suffix and stripped.startswith("//NAME"):
            # Optional rename when calling from CLI; UI renames via serializeJob.
            parts = stripped.split(None, 1)
            eol = "\n" if line.endswith("\n") else ""
            if len(parts) >= 2:
                base = parts[1].strip()
                if not base.endswith(name_suffix):
                    new_lines.append(f"//NAME {base}{name_suffix}{eol}")
                    continue

        match = _CART_POSE_LINE.match(stripped.rstrip("\r\n"))
        if match:
            prefix = match.group(1)
            coords = [float(match.group(i)) for i in range(2, 8)]
            suffix = match.group(8)
            pose_old = Pose(*coords)
            pose_new = convert_pose(
                pose_old, uf_old, uf_new, apply_tool_z_flip=apply_tool_z_flip
            )
            # Preserve original line ending / leading whitespace.
            leading = line[: len(line) - len(stripped)]
            eol = ""
            if line.endswith("\r\n"):
                eol = "\r\n"
            elif line.endswith("\n"):
                eol = "\n"
            coord_str = format_pose_coords(pose_new)
            new_lines.append(f"{leading}{prefix}{coord_str}{suffix}{eol}")
            converted += 1
            continue

        if _PULSE_INT_LINE.match(stripped.rstrip("\r\n")):
            skipped_pulse += 1
            warnings.append(
                f"Skipped integer PULSE line (not cartesian): {stripped.strip()[:60]}"
            )
            new_lines.append(line)
            continue

        new_lines.append(line)

    if skipped_pulse and converted == 0:
        warnings.append(
            "No cartesian decimal C/P poses converted — this Flip path is for "
            "USER/BASE cartesian jobs, not raw PULSE. Use Transfer (FK) or teach in USER."
        )

    stats: dict[str, int | list[str]] = {
        "converted": converted,
        "skippedPulse": skipped_pulse,
        "warnings": warnings,
    }
    return "".join(new_lines), stats


def convert_jbi_file(
    input_path: str | Path,
    output_path: str | Path,
    uf_old: Sequence[float],
    uf_new: Sequence[float],
    target_user_frame: int,
    *,
    apply_tool_z_flip: bool = True,
) -> dict[str, int | list[str]]:
    text = Path(input_path).read_text(encoding="ascii", errors="replace")
    old = Pose.from_xyzrpy(list(uf_old))
    new = Pose.from_xyzrpy(list(uf_new))
    out, stats = convert_jbi_text(
        text,
        old,
        new,
        target_user_frame,
        apply_tool_z_flip=apply_tool_z_flip,
    )
    Path(output_path).write_text(out, encoding="ascii", newline="\n")
    return stats


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Convert a cartesian .JBI from one USER frame to another (Flip math)."
    )
    parser.add_argument("input", type=Path, help="Source .JBI")
    parser.add_argument("output", type=Path, help="Destination .JBI")
    parser.add_argument(
        "--uf-old",
        required=True,
        help="Source BUSER as X,Y,Z,Rx,Ry,Rz",
    )
    parser.add_argument(
        "--uf-new",
        required=True,
        help="Target BUSER as X,Y,Z,Rx,Ry,Rz",
    )
    parser.add_argument(
        "--target-uf",
        type=int,
        required=True,
        help="///USER number written into the job header",
    )
    parser.add_argument(
        "--no-tool-flip",
        action="store_true",
        help="Disable tool Z 180° flip (default is ON like Flip.py)",
    )
    args = parser.parse_args()
    uf_old = [float(p) for p in args.uf_old.split(",")]
    uf_new = [float(p) for p in args.uf_new.split(",")]
    stats = convert_jbi_file(
        args.input,
        args.output,
        uf_old,
        uf_new,
        args.target_uf,
        apply_tool_z_flip=not args.no_tool_flip,
    )
    print(
        f"Converted {stats['converted']} pose(s); "
        f"skippedPulse={stats['skippedPulse']} → {args.output}"
    )
    for warning in stats["warnings"]:
        print(f"warn: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
