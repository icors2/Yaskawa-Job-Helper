"""Robot profile creation from YRC1000 controller backup files.

v1 supports 6-axis Motoman S-L-U-R-B-T layout with RC.PRM-derived link lengths.
Different DH families may need a separate layout later.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from ar2010 import (
    AR2010Params,
    DEFAULT_TOOL0,
    HOME_PULSES,
    Pose,
    RC_PRM_DEGREE_RANGES_POS,
    default_params,
)
from cnd import (
    ToolRecord,
    UserFrame,
    parse_rc_prm,
    parse_tool_cnd,
    parse_uframe_cnd,
)

REQUIRED_FILES = ("SYSTEM.SYS", "RC.PRM", "TOOL.CND", "UFRAME.CND")
RECOMMENDED_FILES = (
    "RE.PRM",
    "SV.PRM",
    "ARCSRT.CND",
    "ARCEND.CND",
    "WEAV.CND",
)

# Motoman 6-axis default motion ranges used as pulse/deg seeds when unknown.
DEFAULT_DEGREE_RANGES_POS = RC_PRM_DEGREE_RANGES_POS

PROFILE_STATUS_TEMPLATE = "template_validated"
PROFILE_STATUS_UNVALIDATED = "unvalidated"
PROFILE_STATUS_CALIBRATED = "calibrated"


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sanitize_id(text: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", text.strip())
    cleaned = cleaned.strip("_")
    return cleaned[:48] or "robot"


def _find_file(root: Path, name: str) -> Path | None:
    direct = root / name
    if direct.is_file():
        return direct
    upper = root / name.upper()
    if upper.is_file():
        return upper
    lower = root / name.lower()
    if lower.is_file():
        return lower
    # Shallow search (one level) for CF/USB layouts
    try:
        for child in root.iterdir():
            if child.is_dir():
                candidate = child / name
                if candidate.is_file():
                    return candidate
    except OSError:
        return None
    return None


def scan_backup(folder: str | Path) -> dict[str, Any]:
    root = Path(folder)
    required: list[dict[str, Any]] = []
    recommended: list[dict[str, Any]] = []
    for name in REQUIRED_FILES:
        path = _find_file(root, name)
        required.append(
            {
                "name": name,
                "required": True,
                "found": path is not None,
                "path": str(path) if path else None,
            }
        )
    for name in RECOMMENDED_FILES:
        path = _find_file(root, name)
        recommended.append(
            {
                "name": name,
                "required": False,
                "found": path is not None,
                "path": str(path) if path else None,
            }
        )
    jbi_count = 0
    try:
        seen: set[str] = set()
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() == ".jbi":
                key = str(path.resolve()).lower()
                if key not in seen:
                    seen.add(key)
        jbi_count = len(seen)
    except OSError:
        jbi_count = 0
    recommended.append(
        {
            "name": "*.JBI (sample jobs)",
            "required": False,
            "found": jbi_count > 0,
            "path": None,
            "count": jbi_count,
        }
    )
    missing = [item["name"] for item in required if not item["found"]]
    return {
        "folder": str(root),
        "required": required,
        "recommended": recommended,
        "missingRequired": missing,
        "ready": len(missing) == 0,
    }


@dataclass
class SystemIdentity:
    raw_robot_line: str
    robot_model: str
    robot_type_code: str
    display_name: str
    group: str
    application: str
    system_no: str
    controller: str
    groups: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_system_sys(path: str | Path) -> SystemIdentity:
    text = Path(path).read_text(encoding="ascii", errors="replace")
    application = ""
    system_no = ""
    robot_line = ""
    groups: list[str] = []
    in_robot = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("//APPLI"):
            application = line.split(":", 1)[-1].strip()
        elif line.startswith("//SYSTEM NO"):
            system_no = line.split(":", 1)[-1].strip()
        elif line.startswith("//ROBOT NAME"):
            in_robot = True
            continue
        elif in_robot:
            if line.startswith("//"):
                in_robot = False
                continue
            stripped = line.strip()
            if not stripped:
                continue
            groups.append(stripped)
            if stripped.startswith("R1") and not robot_line:
                robot_line = stripped

    model = ""
    type_code = ""
    group = "R1"
    match = re.match(
        r"^(R\d+)\s*:\s*([^\s*(]+)\s*(?:\(([^)]+)\))?",
        robot_line,
    )
    if match:
        group = match.group(1)
        type_code = match.group(2).strip()
        model = (match.group(3) or "").strip()
    if not model:
        # Fallback: last token in parentheses anywhere on the line
        paren = re.search(r"\(([^)]+)\)", robot_line)
        model = paren.group(1).strip() if paren else type_code or "UNKNOWN"
    display = model or type_code or "Yaskawa robot"
    controller = "YRC1000"
    if "YAS" in system_no.upper() or "YRC" in system_no.upper():
        controller = "YRC1000"
    return SystemIdentity(
        raw_robot_line=robot_line,
        robot_model=model,
        robot_type_code=type_code,
        display_name=display,
        group=group,
        application=application,
        system_no=system_no,
        controller=controller,
        groups=groups,
    )


def _seed_pulse_per_degree(limits_pos: list[float]) -> list[float]:
    ranges = DEFAULT_DEGREE_RANGES_POS
    seeds: list[float] = []
    for index in range(6):
        limit = abs(float(limits_pos[index])) if index < len(limits_pos) else 1.0
        degrees = abs(float(ranges[index])) if index < len(ranges) else 180.0
        if degrees < 1e-9:
            degrees = 180.0
        seeds.append(limit / degrees)
    return seeds


def _reach_from_links(links: dict[str, float]) -> float:
    a2 = float(links.get("a2", 0.0))
    d4 = float(links.get("d4", 0.0))
    d6 = float(links.get("d6", 0.0))
    a1 = float(links.get("a1", 0.0))
    # Rough horizontal reach heuristic for gate messaging
    return float(a1 + a2 + d4 + d6)


@dataclass
class RobotProfile:
    id: str
    robot_id: str
    display_name: str
    controller: str
    robot_model: str
    robot_type_code: str
    raw_system_line: str
    application: str
    status: str
    link_lengths_mm: dict[str, float]
    pulse_per_deg: list[float]
    pulse_offsets: list[float]
    pulse_limits_pos: list[float]
    pulse_limits_neg: list[float]
    home_pulses: list[float]
    tool0: dict[str, float]
    frames_summary: list[dict[str, Any]]
    tools_summary: list[dict[str, Any]]
    source_folder: str
    source_files: dict[str, dict[str, str]]
    dh_layout: str
    created_at: str
    updated_at: str
    calibration_id: str | None = None
    notes: list[str] = field(default_factory=list)
    station_flip_recipes: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "robotId": self.robot_id,
            "displayName": self.display_name,
            "controller": self.controller,
            "robotModel": self.robot_model,
            "robotTypeCode": self.robot_type_code,
            "rawSystemLine": self.raw_system_line,
            "application": self.application,
            "status": self.status,
            "linkLengthsMm": self.link_lengths_mm,
            "pulsePerDeg": self.pulse_per_deg,
            "pulseOffsets": self.pulse_offsets,
            "pulseLimitsPos": self.pulse_limits_pos,
            "pulseLimitsNeg": self.pulse_limits_neg,
            "homePulses": self.home_pulses,
            "tool0": self.tool0,
            "framesSummary": self.frames_summary,
            "toolsSummary": self.tools_summary,
            "sourceFolder": self.source_folder,
            "sourceFiles": self.source_files,
            "dhLayout": self.dh_layout,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "calibrationId": self.calibration_id,
            "notes": self.notes,
            "stationFlipRecipes": self.station_flip_recipes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RobotProfile:
        return cls(
            id=str(data.get("id") or data.get("robotId") or uuid4()),
            robot_id=str(data.get("robotId") or data.get("robot_id") or "robot"),
            display_name=str(data.get("displayName") or data.get("display_name") or "Robot"),
            controller=str(data.get("controller") or "YRC1000"),
            robot_model=str(data.get("robotModel") or data.get("robot_model") or ""),
            robot_type_code=str(data.get("robotTypeCode") or data.get("robot_type_code") or ""),
            raw_system_line=str(data.get("rawSystemLine") or data.get("raw_system_line") or ""),
            application=str(data.get("application") or ""),
            status=str(data.get("status") or PROFILE_STATUS_UNVALIDATED),
            link_lengths_mm={
                str(k): float(v)
                for k, v in dict(data.get("linkLengthsMm") or data.get("link_lengths_mm") or {}).items()
            },
            pulse_per_deg=[float(v) for v in (data.get("pulsePerDeg") or data.get("pulse_per_deg") or [])],
            pulse_offsets=[float(v) for v in (data.get("pulseOffsets") or data.get("pulse_offsets") or [0] * 6)],
            pulse_limits_pos=[
                float(v) for v in (data.get("pulseLimitsPos") or data.get("pulse_limits_pos") or [])
            ],
            pulse_limits_neg=[
                float(v) for v in (data.get("pulseLimitsNeg") or data.get("pulse_limits_neg") or [])
            ],
            home_pulses=[float(v) for v in (data.get("homePulses") or data.get("home_pulses") or list(HOME_PULSES))],
            tool0=dict(data.get("tool0") or Pose.from_xyzrpy(DEFAULT_TOOL0).to_dict()),
            frames_summary=list(data.get("framesSummary") or data.get("frames_summary") or []),
            tools_summary=list(data.get("toolsSummary") or data.get("tools_summary") or []),
            source_folder=str(data.get("sourceFolder") or data.get("source_folder") or ""),
            source_files=dict(data.get("sourceFiles") or data.get("source_files") or {}),
            dh_layout=str(data.get("dhLayout") or data.get("dh_layout") or "motoman_slurbt_6"),
            created_at=str(data.get("createdAt") or data.get("created_at") or _utc_now()),
            updated_at=str(data.get("updatedAt") or data.get("updated_at") or _utc_now()),
            calibration_id=data.get("calibrationId") or data.get("calibration_id"),
            notes=list(data.get("notes") or []),
            station_flip_recipes=list(
                data.get("stationFlipRecipes") or data.get("station_flip_recipes") or []
            ),
        )

    def to_params(self) -> AR2010Params:
        links = self.link_lengths_mm
        ppd = self.pulse_per_deg or list(default_params().pulse_per_degree)
        offsets = self.pulse_offsets or [0.0] * 6
        while len(ppd) < 6:
            ppd.append(float(default_params().pulse_per_degree[len(ppd)]))
        while len(offsets) < 6:
            offsets.append(0.0)
        return AR2010Params(
            a1=float(links.get("a1", 150.0)),
            a2=float(links.get("a2", 760.0)),
            a3=float(links.get("a3", 200.0)),
            d4=float(links.get("d4", 1082.0)),
            d6=float(links.get("d6", 100.0)),
            d1=float(links.get("d1", 0.0)),
            pulse_per_degree=tuple(float(v) for v in ppd[:6]),
            pulse_offsets=tuple(float(v) for v in offsets[:6]),
            reach_mm=_reach_from_links(links) or 2010.0,
        )


def create_profile_from_backup(
    folder: str | Path,
    *,
    display_name: str | None = None,
    profile_id: str | None = None,
) -> RobotProfile:
    root = Path(folder)
    scan = scan_backup(root)
    if not scan["ready"]:
        missing = ", ".join(scan["missingRequired"])
        raise ValueError(f"Missing required controller files: {missing}")

    paths = {item["name"]: Path(item["path"]) for item in scan["required"] if item["path"]}
    identity = parse_system_sys(paths["SYSTEM.SYS"])
    geometry = parse_rc_prm(paths["RC.PRM"])
    tools = parse_tool_cnd(paths["TOOL.CND"])
    frames = parse_uframe_cnd(paths["UFRAME.CND"])

    links = dict(geometry.link_lengths_mm)
    for key in ("a1", "a2", "a3", "d4", "d6"):
        if key not in links:
            raise ValueError(f"RC.PRM did not yield link length {key}")

    pulse_pos = geometry.pulse_limits_pos
    pulse_neg = geometry.pulse_limits_neg
    pulse_per_deg = _seed_pulse_per_degree(pulse_pos)

    tool0 = next((t for t in tools if t.id == 0), None)
    tool0_dict = tool0.tcp.to_dict() if tool0 else Pose.from_xyzrpy(DEFAULT_TOOL0).to_dict()

    model_upper = identity.robot_model.upper()
    is_ar2010 = "AR2010" in model_upper or geometry.hypothesis_holds
    status = PROFILE_STATUS_TEMPLATE if is_ar2010 else PROFILE_STATUS_UNVALIDATED
    robot_id = _sanitize_id(identity.robot_model or identity.robot_type_code or "robot")
    now = _utc_now()
    notes = list(geometry.notes)
    if status == PROFILE_STATUS_UNVALIDATED:
        notes.append(
            "Unvalidated robot: pulse scales are RC.PRM soft-limit seeds. "
            "Cell calibration is required before trusting geometry transforms."
        )
    else:
        notes.append(
            "AR2010 template: geometry matches validated DYNAMIC1 / URDF lengths. "
            "Still calibrate pulse scales/offsets per cell."
        )

    source_files: dict[str, dict[str, str]] = {}
    for name, path in paths.items():
        source_files[name] = {"path": str(path), "sha256": _file_sha256(path)}

    frames_summary = [
        {"id": frame.id, "name": frame.name, "toolId": frame.tool_id} for frame in frames
    ]
    tools_summary = [
        {"id": tool.id, "name": tool.name, "tcp": tool.tcp.to_dict()}
        for tool in tools
        if tool.id <= 3
    ]

    home = list(HOME_PULSES) if is_ar2010 else [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]

    return RobotProfile(
        id=profile_id or str(uuid4()),
        robot_id=robot_id,
        display_name=display_name or identity.display_name,
        controller=identity.controller,
        robot_model=identity.robot_model,
        robot_type_code=identity.robot_type_code,
        raw_system_line=identity.raw_robot_line,
        application=identity.application,
        status=status,
        link_lengths_mm=links,
        pulse_per_deg=pulse_per_deg,
        pulse_offsets=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        pulse_limits_pos=[float(v) for v in pulse_pos],
        pulse_limits_neg=[float(v) for v in pulse_neg],
        home_pulses=home,
        tool0=tool0_dict,
        frames_summary=frames_summary,
        tools_summary=tools_summary,
        source_folder=str(root.resolve()),
        source_files=source_files,
        dh_layout="motoman_slurbt_6",
        created_at=now,
        updated_at=now,
        calibration_id=None,
        notes=notes,
        station_flip_recipes=[],
    )


def save_profile_json(profile: RobotProfile, path: str | Path) -> Path:
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(profile.to_dict(), indent=2) + "\n", encoding="utf-8")
    return dest


def load_profile_json(path: str | Path) -> RobotProfile:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("robot profile JSON must be an object")
    return RobotProfile.from_dict(data)


def profiles_store_path(folder: str | Path) -> Path:
    return Path(folder) / "profiles" / "robot_profiles.json"


def load_profiles_store(folder: str | Path) -> dict[str, Any]:
    path = profiles_store_path(folder)
    if not path.is_file():
        return {"version": 1, "activeProfileId": None, "profiles": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("profiles store must be an object")
    return {
        "version": int(data.get("version", 1)),
        "activeProfileId": data.get("activeProfileId"),
        "profiles": list(data.get("profiles") or []),
    }


def save_profiles_store(folder: str | Path, store: dict[str, Any]) -> Path:
    path = profiles_store_path(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "activeProfileId": store.get("activeProfileId"),
        "profiles": list(store.get("profiles") or []),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path
