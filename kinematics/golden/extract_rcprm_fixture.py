"""Extract the ///RC1G section of a controller RC.PRM into a small fixture.

The full RC.PRM is ~200 kB of plant data. Everything the geometry parser reads
lives in ///RC1G, so the committed fixture keeps that section only.

    python kinematics/golden/extract_rcprm_fixture.py "<backup>/RC.PRM"
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEST = REPO_ROOT / "fixtures" / "RC.PRM"


def extract(source: Path) -> str:
    lines = source.read_text(encoding="ascii", errors="replace").splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip().startswith("///RC1G"))
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("///")),
        len(lines),
    )
    header = ["//RC YAS", "///RCD", "20,100,1,0,0,90,1,1,0,0"]
    body = lines[start:end]
    trailer = [lines[end]] if end < len(lines) else ["///RC1H"]
    return "\r\n".join([*header, *body, *trailer]) + "\r\n"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = Path(sys.argv[1])
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(extract(source), encoding="ascii", newline="")
    print(f"wrote {DEST} ({DEST.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
