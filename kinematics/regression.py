"""Find S1/S2 job pairs and compare pulse poses via FK into each user frame."""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

from ar2010 import AR2010Params, default_tool, forward_kinematics, relative_pose
from cnd import UserFrame


_PULSE_RE = re.compile(
    r"^(?:C|BC|P|BP)(\d+)\s*=\s*(-?\d+(?:\s*,\s*-?\d+){5,})",
    re.IGNORECASE,
)


@dataclass
class PairComparison:
    s1_path: str
    s2_path: str
    compared: int
    rms_mm: float
    worst_mm: float
    details: list[dict]


def find_s1_s2_pairs(root: str | Path) -> list[tuple[Path, Path]]:
    root_path = Path(root)
    jobs = {p.stem.upper(): p for p in root_path.rglob("*.JBI")}
    pairs: list[tuple[Path, Path]] = []
    seen: set[str] = set()
    for stem, path in jobs.items():
        if stem in seen:
            continue
        mate = None
        if stem.endswith("_S1"):
            mate = stem[:-3] + "_S2"
        elif stem.endswith("-S1"):
            mate = stem[:-3] + "-S2"
        elif re.search(r"S1$", stem):
            mate = re.sub(r"S1$", "S2", stem)
        if mate and mate in jobs:
            pairs.append((path, jobs[mate]))
            seen.add(stem)
            seen.add(mate)
    pairs.sort(key=lambda item: item[0].name.lower())
    return pairs


def parse_pulse_points(text: str) -> list[list[float]]:
    points: list[list[float]] = []
    for raw in text.splitlines():
        match = _PULSE_RE.match(raw.strip())
        if not match:
            continue
        nums = [float(part.strip()) for part in match.group(2).split(",")]
        points.append(nums[:6])
    return points


def frame_by_name(frames: Iterable[UserFrame], name: str) -> UserFrame:
    upper = name.upper()
    for frame in frames:
        if frame.name.upper() == upper:
            return frame
    raise KeyError(f"User frame {name!r} not found")


def compare_pair(
    params: AR2010Params,
    s1_path: Path,
    s2_path: Path,
    s1_frame: UserFrame,
    s2_frame: UserFrame,
    max_points: int = 50,
) -> PairComparison:
    tool = default_tool()
    s1_pts = parse_pulse_points(s1_path.read_text(encoding="utf-8", errors="replace"))
    s2_pts = parse_pulse_points(s2_path.read_text(encoding="utf-8", errors="replace"))
    n = min(len(s1_pts), len(s2_pts), max_points)
    details: list[dict] = []
    errors: list[float] = []
    for i in range(n):
        p1 = forward_kinematics(s1_pts[i], tool=tool, params=params).pose
        p2 = forward_kinematics(s2_pts[i], tool=tool, params=params).pose
        rel1 = relative_pose(p1, s1_frame.buser)
        rel2 = relative_pose(p2, s2_frame.buser)
        err = float(
            np.linalg.norm(
                np.array([rel1.x, rel1.y, rel1.z]) - np.array([rel2.x, rel2.y, rel2.z])
            )
        )
        errors.append(err)
        details.append({"index": i, "error_mm": err})
    if not errors:
        return PairComparison(str(s1_path), str(s2_path), 0, 0.0, 0.0, [])
    arr = np.asarray(errors, dtype=float)
    return PairComparison(
        str(s1_path),
        str(s2_path),
        len(errors),
        float(np.sqrt(np.mean(arr ** 2))),
        float(np.max(arr)),
        details,
    )


def run_regression(
    params: AR2010Params,
    jobs_root: str | Path,
    frames: Sequence[UserFrame],
    max_pairs: int = 10,
    max_points: int = 40,
) -> list[dict]:
    s1 = frame_by_name(frames, "S1")
    s2 = frame_by_name(frames, "S2")
    out: list[dict] = []
    for s1_path, s2_path in find_s1_s2_pairs(jobs_root)[:max_pairs]:
        cmp = compare_pair(params, s1_path, s2_path, s1, s2, max_points=max_points)
        out.append(
            {
                "s1": cmp.s1_path,
                "s2": cmp.s2_path,
                "compared": cmp.compared,
                "rms_mm": cmp.rms_mm,
                "worst_mm": cmp.worst_mm,
            }
        )
    return out
