"""Readers for Yaskawa YRC1000 UFRAME.CND, TOOL.CND, and RC.PRM."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ar2010 import (
    RC_PRM_PULSE_LIMITS_NEG,
    RC_PRM_PULSE_LIMITS_POS,
    Pose,
)


def _parse_numbers(text: str) -> list[float]:
    return [float(part) for part in text.replace("=", " ").split(",") if part.strip()]


def _first_int(token: str) -> int:
    digits = "".join(ch if ch.isdigit() or ch == "-" else " " for ch in token)
    parts = digits.split()
    if not parts:
        raise ValueError(f"no integer in {token!r}")
    return int(parts[0])


@dataclass
class UserFrame:
    id: int
    name: str
    tool_id: int
    rorg: list[float]
    rxx: list[float]
    rxy: list[float]
    buser: Pose
    group: list[int] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "toolId": self.tool_id,
            "rorg": self.rorg,
            "rxx": self.rxx,
            "rxy": self.rxy,
            "buser": self.buser.to_dict(),
        }


@dataclass
class ToolRecord:
    id: int
    name: str
    tcp: Pose
    cg: list[float] = field(default_factory=list)
    weight: float = 0.0

    def to_dict(self) -> dict[str, object]:
        return {"id": self.id, "name": self.name, "tcp": self.tcp.to_dict()}


@dataclass
class RcPrmGeometry:
    row1: list[float]
    row2: list[float]
    link_lengths_mm: dict[str, float]
    pulse_limits_pos: list[float]
    pulse_limits_neg: list[float]
    hypothesis_holds: bool
    notes: list[str]

    def to_dict(self) -> dict[str, object]:
        return {
            "row1": self.row1,
            "row2": self.row2,
            "linkLengthsMm": self.link_lengths_mm,
            "pulseLimitsPos": self.pulse_limits_pos,
            "pulseLimitsNeg": self.pulse_limits_neg,
            "hypothesisHolds": self.hypothesis_holds,
            "notes": self.notes,
        }


def parse_uframe_cnd(path: str | Path) -> list[UserFrame]:
    frames: list[UserFrame] = []
    current: dict[str, object] = {}

    def flush() -> None:
        if "id" not in current:
            return
        rorg = current.get("rorg")
        rxx = current.get("rxx")
        rxy = current.get("rxy")
        buser = current.get("buser")
        if not isinstance(rorg, list) or not isinstance(buser, Pose):
            raise ValueError(f"UFRAME {current.get('id')} is missing RORG/BUSER")
        frames.append(
            UserFrame(
                id=int(current["id"]),
                name=str(current.get("name", "")),
                tool_id=int(current.get("tool_id", 0)),
                rorg=[float(v) for v in rorg],
                rxx=[float(v) for v in rxx] if isinstance(rxx, list) else [],
                rxy=[float(v) for v in rxy] if isinstance(rxy, list) else [],
                buser=buser,
                group=list(current.get("group", [])) if isinstance(current.get("group"), list) else [],
            )
        )

    for raw in Path(path).read_text(encoding="ascii", errors="replace").splitlines():
        line = raw.strip()
        if line.startswith("//UFRAME"):
            flush()
            current = {"id": _first_int(line.split()[-1])}
            continue
        if line.startswith("///NAME"):
            current["name"] = line[7:].strip()
        elif line.startswith("///TOOL"):
            current["tool_id"] = _first_int(line.split()[-1])
        elif line.startswith("///GROUP"):
            current["group"] = [int(float(v)) for v in _parse_numbers(line.split(None, 1)[-1])]
        elif "RORG" in line:
            current["rorg"] = _parse_numbers(line.split("=", 1)[-1])
        elif "RXX" in line:
            current["rxx"] = _parse_numbers(line.split("=", 1)[-1])
        elif "RXY" in line:
            current["rxy"] = _parse_numbers(line.split("=", 1)[-1])
        elif "BUSER" in line:
            values = _parse_numbers(line.split()[-1] if "=" not in line else line.split("=", 1)[-1])
            if "BUSER" in line and not values:
                values = _parse_numbers(line.replace("////BUSER", ""))
            if len(values) < 6:
                values = _parse_numbers(line)
            current["buser"] = Pose.from_xyzrpy(values)
    flush()
    return frames


def parse_tool_cnd(path: str | Path) -> list[ToolRecord]:
    tools: list[ToolRecord] = []
    current_id: int | None = None
    current_name = ""
    pending_numeric = False

    for raw in Path(path).read_text(encoding="ascii", errors="replace").splitlines():
        line = raw.strip()
        if line.startswith("//TOOL"):
            current_id = _first_int(line.split()[-1])
            current_name = ""
            pending_numeric = True
            continue
        if current_id is None:
            continue
        if line.startswith("///NAME"):
            current_name = line[7:].strip()
            continue
        if line.startswith("///"):
            continue
        if pending_numeric and line and (line[0].isdigit() or line[0] in "+-"):
            values = _parse_numbers(line)
            tools.append(
                ToolRecord(
                    id=current_id,
                    name=current_name,
                    tcp=Pose.from_xyzrpy(values),
                )
            )
            pending_numeric = False
    return tools


def _extract_pulse_limits(
    data_rows: list[list[float]],
) -> tuple[list[float], list[float]]:
    """Find soft-limit rows inside ///RC1G (six large pulse values each)."""
    for index in range(len(data_rows) - 1):
        pos = data_rows[index][:6]
        neg = data_rows[index + 1][:6]
        if len(pos) < 6 or len(neg) < 6:
            continue
        if not all(abs(value) > 10_000 for value in pos):
            continue
        if not all(abs(value) > 10_000 for value in neg):
            continue
        # Soft limits: positive row mostly +, negative row mostly -
        if sum(1 for value in pos if value > 0) < 4:
            continue
        if sum(1 for value in neg if value < 0) < 4:
            continue
        return [float(v) for v in pos], [float(v) for v in neg]
    return list(RC_PRM_PULSE_LIMITS_POS), list(RC_PRM_PULSE_LIMITS_NEG)


def parse_rc_prm(path: str | Path) -> RcPrmGeometry:
    lines = Path(path).read_text(encoding="ascii", errors="replace").splitlines()
    row1: list[float] = []
    row2: list[float] = []
    in_rc1g = False
    data_rows: list[list[float]] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("///RC1G"):
            in_rc1g = True
            continue
        if in_rc1g and stripped.startswith("///"):
            break
        if in_rc1g and stripped and (stripped[0].isdigit() or stripped.startswith("-")):
            data_rows.append(_parse_numbers(stripped))
    if data_rows:
        row1 = data_rows[0]
        row2 = data_rows[1] if len(data_rows) > 1 else []

    expected_ar2010 = {
        "a1": 150.0,
        "a2": 760.0,
        "a3": 200.0,
        "d4": 1082.0,
        "d6": 100.0,
    }
    microns = {
        "a1": row1[1] / 1000.0 if len(row1) > 1 else None,
        "a2": row1[3] / 1000.0 if len(row1) > 3 else None,
        "a3": row1[5] / 1000.0 if len(row1) > 5 else None,
        "d4": row1[8] / 1000.0 if len(row1) > 8 else None,
        "d6": row2[2] / 1000.0 if len(row2) > 2 else None,
    }
    pulse_pos, pulse_neg = _extract_pulse_limits(data_rows)
    notes = [
        "RC1G microns → mm: a1/a2/a3/d4 from row1, d6 from row2 (Motoman S-L-U-R-B-T).",
        "505 mm floor-to-S height is not in RC1G; Yaskawa BASE is the S/L intersection.",
        f"Pulse soft-limits decoded from RC1G: +{pulse_pos} / {pulse_neg}.",
    ]
    holds = all(
        value is not None and abs(value - expected_ar2010[name]) < 1e-6
        for name, value in microns.items()
    )
    if holds:
        notes.append(
            "AR2010 template match: 150/760/200/1082/100 mm from RC1G microns."
        )
    else:
        notes.append(
            "Non-AR2010 or unverified geometry. Decoded link lengths (mm): "
            f"{ {k: v for k, v in microns.items() if v is not None} }"
        )

    return RcPrmGeometry(
        row1=row1,
        row2=row2,
        link_lengths_mm={name: float(value) for name, value in microns.items() if value is not None},
        pulse_limits_pos=pulse_pos,
        pulse_limits_neg=pulse_neg,
        hypothesis_holds=holds,
        notes=notes,
    )


def find_frame(frames: list[UserFrame], frame_id: int) -> UserFrame:
    for frame in frames:
        if frame.id == frame_id:
            return frame
    raise KeyError(f"user frame {frame_id} not found")


def find_tool(tools: list[ToolRecord], tool_id: int) -> ToolRecord:
    for tool in tools:
        if tool.id == tool_id:
            return tool
    raise KeyError(f"tool {tool_id} not found")
