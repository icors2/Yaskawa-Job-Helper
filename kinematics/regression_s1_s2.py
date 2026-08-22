"""S1→S2 frame-move regression against hand-taught job pairs.

Compares FK-relative poses of *_S1* pulse jobs (projected into UF#2) against
the corresponding *_S2* jobs (UF#3). Independent teaching means residuals will
not be zero; look for a small, consistent bias.

Usage (from repo root or kinematics/):
    python kinematics/regression_s1_s2.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

KIN_DIR = Path(__file__).resolve().parent
if str(KIN_DIR) not in sys.path:
    sys.path.insert(0, str(KIN_DIR))

from ar2010 import default_params, default_tool, xyz_error_mm
from cnd import find_frame, parse_uframe_cnd
from transform import pulses_in_user_frame

WORKSPACE = KIN_DIR.parent.parent
DYNAMIC1 = WORKSPACE / "Yaskawa Jobs" / "DYNAMIC1"
UFRAME_PATH = DYNAMIC1 / "UFRAME.CND"

PULSE_LINE = re.compile(r"^(C|P)(\d+)=(.+)$", re.I)
S1_MARKERS = ("_S1", "-S1", "_s1", "-s1")
S2_MARKERS = ("_S2", "-S2", "_s2", "-s2")


def read_pulse_rows(path: Path) -> list[list[float]]:
    rows: list[list[float]] = []
    in_pos = False
    postype_pulse = False
    for raw in path.read_text(encoding="latin-1").splitlines():
        line = raw.strip()
        if line == "//POS":
            in_pos = True
            continue
        if line == "//INST":
            break
        if not in_pos:
            continue
        if line.startswith("///POSTYPE"):
            postype_pulse = "PULSE" in line.upper()
            continue
        if not postype_pulse:
            continue
        match = PULSE_LINE.match(line)
        if not match:
            continue
        values = [float(part) for part in match.group(3).split(",")]
        if len(values) >= 6:
            rows.append(values[:6])
    return rows


def pair_key(name: str) -> str | None:
    upper = name.upper()
    for marker in ("_S1", "-S1", "_S2", "-S2"):
        if marker in upper:
            return upper.replace("_S1", "").replace("-S1", "").replace("_S2", "").replace("-S2", "")
    return None


def is_s1(name: str) -> bool:
    return any(m in name for m in S1_MARKERS)


def is_s2(name: str) -> bool:
    return any(m in name for m in S2_MARKERS)


def main() -> int:
    if not DYNAMIC1.is_dir():
        print(f"Backup not found: {DYNAMIC1}")
        return 1

    frames = parse_uframe_cnd(UFRAME_PATH)
    s1 = find_frame(frames, 2).buser
    s2 = find_frame(frames, 3).buser
    tool = default_tool()
    params = default_params()

    jobs = {path.stem: path for path in DYNAMIC1.glob("*.JBI")}
    s1_jobs = [name for name in jobs if is_s1(name)]
    pairs: list[tuple[str, str]] = []
    for s1_name in sorted(s1_jobs):
        key = pair_key(s1_name)
        if key is None:
            continue
        for s2_name in jobs:
            if not is_s2(s2_name):
                continue
            if pair_key(s2_name) == key:
                pairs.append((s1_name, s2_name))
                break

    print(f"Found {len(pairs)} S1/S2 pairs under {DYNAMIC1}")
    if not pairs:
        return 1

    reports: list[dict[str, float | str | int]] = []
    for s1_name, s2_name in pairs[:40]:
        rows1 = read_pulse_rows(jobs[s1_name])
        rows2 = read_pulse_rows(jobs[s2_name])
        if not rows1 or not rows2:
            continue
        count = min(len(rows1), len(rows2), 12)
        errors: list[float] = []
        for i in range(count):
            rel1 = pulses_in_user_frame(rows1[i], s1, tool=tool, params=params)
            rel2 = pulses_in_user_frame(rows2[i], s2, tool=tool, params=params)
            # Same relative geometry ⇒ frame-move identity check in each station frame.
            errors.append(xyz_error_mm(rel1, rel2))
        if not errors:
            continue
        worst = max(errors)
        rms = (sum(e * e for e in errors) / len(errors)) ** 0.5
        reports.append(
            {
                "s1": s1_name,
                "s2": s2_name,
                "n": count,
                "rms_mm": rms,
                "worst_mm": worst,
            }
        )

    reports.sort(key=lambda row: float(row["worst_mm"]))
    print("Closest pairs (relative-pose agreement after projecting into UF2/UF3):")
    for row in reports[:10]:
        print(
            f"  {row['s1']} <-> {row['s2']}: "
            f"n={row['n']} rms={row['rms_mm']:.2f} mm worst={row['worst_mm']:.2f} mm"
        )
    print("Farthest pairs:")
    for row in reports[-5:]:
        print(
            f"  {row['s1']} <-> {row['s2']}: "
            f"n={row['n']} rms={row['rms_mm']:.2f} mm worst={row['worst_mm']:.2f} mm"
        )
    if reports:
        mean_worst = sum(float(r["worst_mm"]) for r in reports) / len(reports)
        print(f"Pairs scored: {len(reports)}; mean worst deviation: {mean_worst:.2f} mm")
        print(
            "Note: hand-taught S1/S2 pairs are independent - large scatter is expected; "
            "use this as a trend check after calibration improves, not a hard gate."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
