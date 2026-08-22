#!/usr/bin/env python3
"""Yaskawa kinematics sidecar — JSON-over-stdio protocol v1.0.0.

One JSON object per line on stdin. One JSON object per line on stdout.
Field names are camelCase so they match src/lib/kin/client.ts.

Request types:
  ping, forward_kinematics, calibrate, transform_frame,
  transform_mirror, transform_offset, read_uframe, read_tool,
  scan_backup, create_profile_from_backup, load_profile, get_profile
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

_KIN_DIR = Path(__file__).resolve().parent
if str(_KIN_DIR) not in sys.path:
    sys.path.insert(0, str(_KIN_DIR))

from ar2010 import AR2010Params, Pose, default_params, default_tool, forward_kinematics
from calibrate import (
    CalibPair,
    CalibrationResult,
    backup_seed_pairs,
    calibrate,
    is_calibrated,
    uframe_pairs,
)
from cnd import ToolRecord, UserFrame, find_frame, find_tool, parse_tool_cnd, parse_uframe_cnd
from robot_model import params_from_profile
from robot_profile import (
    RobotProfile,
    create_profile_from_backup,
    load_profile_json,
    save_profile_json,
    scan_backup,
)
from transform import (
    frame_move,
    mirror,
    offset_pose,
    pulses_in_user_frame,
    reach_envelope,
)

PROTOCOL_VERSION = "1.0.0"
SIDECAR_VERSION = "0.2.0"

METHODS = (
    "ping",
    "forward_kinematics",
    "fk",
    "calibrate",
    "get_calibration_status",
    "load_cnd",
    "transform_frame",
    "frame_move",
    "transform_mirror",
    "mirror",
    "transform_offset",
    "offset",
    "read_uframe",
    "read_tool",
    "verify_rcprm",
    "regression_pair",
    "scan_backup",
    "create_profile_from_backup",
    "load_profile",
    "get_profile",
)

WORKSPACE = Path(__file__).resolve().parent.parent.parent
DEFAULT_UFRAME = WORKSPACE / "Yaskawa Jobs" / "DYNAMIC1" / "UFRAME.CND"
DEFAULT_TOOL = WORKSPACE / "Yaskawa Jobs" / "DYNAMIC1" / "TOOL.CND"


class SidecarState:
    def __init__(self) -> None:
        self.params = default_params()
        self.frames: list[UserFrame] = []
        self.tools: list[ToolRecord] = []
        self.calibration: CalibrationResult | None = None
        self.profile: RobotProfile | None = None

    def apply_profile(self, profile: RobotProfile) -> None:
        self.profile = profile
        self.params = params_from_profile(profile)
        # Prefer CND paths recorded on the profile
        uframe = (profile.source_files.get("UFRAME.CND") or {}).get("path")
        tool = (profile.source_files.get("TOOL.CND") or {}).get("path")
        if uframe and Path(uframe).is_file():
            self.frames = parse_uframe_cnd(uframe)
        if tool and Path(tool).is_file():
            self.tools = parse_tool_cnd(tool)

    def ensure_frames(self, path: str | None = None) -> list[UserFrame]:
        if path:
            self.frames = parse_uframe_cnd(path)
            return self.frames
        if self.frames:
            return self.frames
        if DEFAULT_UFRAME.is_file():
            self.frames = parse_uframe_cnd(DEFAULT_UFRAME)
        return self.frames

    def ensure_tools(self, path: str | None = None) -> list[ToolRecord]:
        if path:
            self.tools = parse_tool_cnd(path)
            return self.tools
        if self.tools:
            return self.tools
        if DEFAULT_TOOL.is_file():
            self.tools = parse_tool_cnd(DEFAULT_TOOL)
        return self.tools

    def tool_pose(self, tool_id: int | None) -> Pose:
        if tool_id is None:
            tool_id = 0
        tools = self.ensure_tools()
        if tools:
            try:
                return find_tool(tools, int(tool_id)).tcp
            except KeyError:
                if int(tool_id) == 0:
                    if self.profile and self.profile.tool0:
                        return Pose.from_dict(self.profile.tool0)
                    return default_tool()
                raise
        if int(tool_id) == 0:
            if self.profile and self.profile.tool0:
                return Pose.from_dict(self.profile.tool0)
            return default_tool()
        raise KeyError(f"tool {tool_id} not loaded")

    def frame_pose(self, frame_id: int) -> Pose:
        return find_frame(self.ensure_frames(), int(frame_id)).buser


STATE = SidecarState()


def ok(request_id: str, result: dict[str, Any]) -> dict[str, Any]:
    return {"id": request_id, "ok": True, "result": result}


def err(request_id: str | None, code: str, message: str) -> dict[str, Any]:
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}


def require(req: dict[str, Any], *keys: str) -> None:
    missing = [key for key in keys if key not in req]
    if missing:
        raise ValueError(f"missing fields: {', '.join(missing)}")


def _pose_from(data: dict[str, Any]) -> Pose:
    return Pose.from_dict(data)


def handle_ping(req: dict[str, Any]) -> dict[str, Any]:
    return ok(
        req["id"],
        {"pong": True, "version": SIDECAR_VERSION, "protocol": PROTOCOL_VERSION},
    )


def handle_forward_kinematics(req: dict[str, Any]) -> dict[str, Any]:
    require(req, "pulses")
    tool = STATE.tool_pose(req.get("toolId"))
    user_frame = None
    if req.get("userFrameId") is not None:
        user_frame = STATE.frame_pose(int(req["userFrameId"]))
    result = forward_kinematics(
        req["pulses"],
        tool=tool,
        params=STATE.params,
        user_frame=user_frame,
    )
    payload = result.to_dict()
    payload["reach"] = reach_envelope(result.pose, STATE.params.reach_mm).to_dict()
    return ok(req["id"], payload)


def handle_calibrate(req: dict[str, Any]) -> dict[str, Any]:
    require(req, "pairs")
    seed = STATE.params
    if isinstance(req.get("seed"), dict):
        seed = AR2010Params.from_dict(req["seed"])
    pairs = []
    for item in req["pairs"]:
        frame = str(item.get("frame", "BASE") or "BASE").upper()
        user_frame_id = item.get("userFrameId", item.get("user_frame_id"))
        pairs.append(
            CalibPair(
                pulses=[float(v) for v in item["pulses"]],
                cartesian=_pose_from(item["cartesian"]),
                label=str(item.get("label", "")),
                frame=frame,
                user_frame_id=int(user_frame_id) if user_frame_id is not None else None,
            )
        )
    frames = STATE.frames
    if not pairs:
        pairs = backup_seed_pairs()
        if not frames:
            frames = STATE.ensure_frames()
        pairs = pairs + uframe_pairs(frames)
    result = calibrate(pairs, seed=seed, tool=STATE.tool_pose(req.get("toolId")), frames=frames)
    STATE.params = result.params
    STATE.calibration = result
    return ok(req["id"], result.to_dict())


def handle_transform_frame(req: dict[str, Any]) -> dict[str, Any]:
    require(req, "pulses", "sourceFrameId", "targetFrameId")
    source = STATE.frame_pose(int(req["sourceFrameId"]))
    tool = STATE.tool_pose(req.get("toolId"))
    poses: list[dict[str, float]] = []
    for pulse_row in req["pulses"]:
        relative = pulses_in_user_frame(pulse_row, source, tool=tool, params=STATE.params)
        moved = frame_move(relative, int(req["sourceFrameId"]), int(req["targetFrameId"]))
        poses.append(moved.to_dict())
    return ok(
        req["id"],
        {"poses": poses, "targetFrameId": int(req["targetFrameId"])},
    )


def handle_transform_mirror(req: dict[str, Any]) -> dict[str, Any]:
    require(req, "poses", "plane")
    poses = []
    for item in req["poses"]:
        mirrored, _review = mirror(_pose_from(item), req["plane"])
        poses.append(mirrored.to_dict())
    return ok(req["id"], {"poses": poses, "rconfReviewRequired": True})


def handle_transform_offset(req: dict[str, Any]) -> dict[str, Any]:
    require(req, "poses", "delta")
    delta = _pose_from(req["delta"])
    poses = [offset_pose(_pose_from(item), delta).to_dict() for item in req["poses"]]
    return ok(req["id"], {"poses": poses})


def handle_read_uframe(req: dict[str, Any]) -> dict[str, Any]:
    require(req, "path")
    frames = STATE.ensure_frames(req["path"])
    return ok(req["id"], {"frames": [frame.to_dict() for frame in frames]})


def handle_read_tool(req: dict[str, Any]) -> dict[str, Any]:
    require(req, "path")
    tools = STATE.ensure_tools(req["path"])
    return ok(req["id"], {"tools": [tool.to_dict() for tool in tools]})


def handle_load_cnd(req: dict[str, Any]) -> dict[str, Any]:
    uframe = req.get("uframe") or req.get("uframePath") or req.get("path")
    tool = req.get("tool") or req.get("toolPath")
    params = req.get("params") if isinstance(req.get("params"), dict) else {}
    if isinstance(params, dict):
        uframe = uframe or params.get("uframe") or params.get("uframe_cnd")
        tool = tool or params.get("tool") or params.get("tool_cnd")
    if not uframe or not tool:
        raise ValueError("load_cnd requires uframe and tool paths")
    frames = STATE.ensure_frames(str(uframe))
    tools = STATE.ensure_tools(str(tool))
    return ok(
        req["id"],
        {
            "frames": [frame.to_dict() for frame in frames],
            "tools": [t.to_dict() for t in tools if t.id <= 3],
        },
    )


def handle_get_calibration_status(req: dict[str, Any]) -> dict[str, Any]:
    threshold = float(req.get("thresholdMm", req.get("threshold_mm", 5.0)))
    cal = STATE.calibration
    return ok(
        req["id"],
        {
            "calibrated": bool(cal and is_calibrated(cal, threshold)),
            "thresholdMm": threshold,
            "parameters": STATE.params.to_dict(),
            "calibration": cal.to_dict() if cal else None,
        },
    )


def handle_verify_rcprm(req: dict[str, Any]) -> dict[str, Any]:
    from verify_rcprm import run_verify

    params = req.get("params") if isinstance(req.get("params"), dict) else {}
    rcprm = req.get("rcprm") or params.get("rcprm")
    uframe = req.get("uframe") or params.get("uframe")
    tool = req.get("tool") or params.get("tool")
    if not rcprm or not uframe or not tool:
        raise ValueError("verify_rcprm requires rcprm, uframe, tool")
    return ok(req["id"], run_verify(str(rcprm), str(uframe), str(tool)))


def handle_scan_backup(req: dict[str, Any]) -> dict[str, Any]:
    folder = req.get("folder") or req.get("path")
    if not folder and isinstance(req.get("params"), dict):
        folder = req["params"].get("folder") or req["params"].get("path")
    if not folder:
        raise ValueError("scan_backup requires folder")
    return ok(req["id"], scan_backup(str(folder)))


def handle_create_profile_from_backup(req: dict[str, Any]) -> dict[str, Any]:
    folder = req.get("folder") or req.get("path")
    display_name = req.get("displayName") or req.get("display_name")
    profile_id = req.get("profileId") or req.get("id_override")
    save_path = req.get("savePath") or req.get("save_path")
    if not folder and isinstance(req.get("params"), dict):
        p = req["params"]
        folder = folder or p.get("folder") or p.get("path")
        display_name = display_name or p.get("displayName") or p.get("display_name")
        save_path = save_path or p.get("savePath") or p.get("save_path")
    if not folder:
        raise ValueError("create_profile_from_backup requires folder")
    profile = create_profile_from_backup(
        str(folder),
        display_name=str(display_name) if display_name else None,
        profile_id=str(profile_id) if profile_id else None,
    )
    written = None
    if save_path:
        written = str(save_profile_json(profile, str(save_path)))
    STATE.apply_profile(profile)
    return ok(
        req["id"],
        {
            "profile": profile.to_dict(),
            "savedPath": written,
            "scan": scan_backup(str(folder)),
        },
    )


def handle_load_profile(req: dict[str, Any]) -> dict[str, Any]:
    path = req.get("path")
    profile_data = req.get("profile")
    if not path and not profile_data and isinstance(req.get("params"), dict):
        path = req["params"].get("path")
        profile_data = req["params"].get("profile")
    if profile_data and isinstance(profile_data, dict):
        profile = RobotProfile.from_dict(profile_data)
    elif path:
        profile = load_profile_json(str(path))
    else:
        raise ValueError("load_profile requires path or profile object")
    STATE.apply_profile(profile)
    return ok(req["id"], {"profile": profile.to_dict()})


def handle_get_profile(req: dict[str, Any]) -> dict[str, Any]:
    profile = STATE.profile
    return ok(
        req["id"],
        {
            "profile": profile.to_dict() if profile else None,
            "hasProfile": profile is not None,
            "parameters": STATE.params.to_dict(),
        },
    )


def handle_regression_pair(req: dict[str, Any]) -> dict[str, Any]:
    from regression import compare_pair, frame_by_name, run_regression

    params = req.get("params") if isinstance(req.get("params"), dict) else {}
    frames = STATE.ensure_frames()
    if req.get("s1") and req.get("s2"):
        s1 = frame_by_name(frames, "S1")
        s2 = frame_by_name(frames, "S2")
        cmp = compare_pair(
            STATE.params,
            Path(req["s1"]),
            Path(req["s2"]),
            s1,
            s2,
            max_points=int(req.get("max_points", params.get("max_points", 40))),
        )
        return ok(
            req["id"],
            {
                "s1": cmp.s1_path,
                "s2": cmp.s2_path,
                "compared": cmp.compared,
                "rms_mm": cmp.rms_mm,
                "worst_mm": cmp.worst_mm,
            },
        )
    jobs_root = req.get("jobs_root") or params.get("jobs_root")
    if not jobs_root:
        raise ValueError("regression_pair requires jobs_root or s1/s2")
    return ok(
        req["id"],
        {
            "pairs": run_regression(
                STATE.params,
                jobs_root,
                frames,
                max_pairs=int(req.get("max_pairs", params.get("max_pairs", 10))),
            )
        },
    )


def handle_fk(req: dict[str, Any]) -> dict[str, Any]:
    # Alias accepting either flat fields or params.pulses
    if "pulses" not in req and isinstance(req.get("params"), dict):
        req = {**req, **req["params"]}
    return handle_forward_kinematics(req)


def handle_frame_move_alias(req: dict[str, Any]) -> dict[str, Any]:
    if isinstance(req.get("params"), dict):
        p = req["params"]
        merged = {
            **req,
            "pulses": req.get("pulses", [p["pulses"]] if "pulses" in p else req.get("pulses")),
            "sourceFrameId": req.get("sourceFrameId", p.get("source_frame_id", p.get("sourceFrameId"))),
            "targetFrameId": req.get("targetFrameId", p.get("target_frame_id", p.get("targetFrameId"))),
            "toolId": req.get("toolId", p.get("toolId", 0)),
        }
        if merged.get("pulses") is not None and merged["pulses"] and not isinstance(merged["pulses"][0], (list, tuple)):
            merged["pulses"] = [merged["pulses"]]
        req = merged
    return handle_transform_frame(req)


def handle_mirror_alias(req: dict[str, Any]) -> dict[str, Any]:
    if isinstance(req.get("params"), dict):
        p = req["params"]
        pose = p.get("pose")
        if isinstance(pose, list):
            pose = {
                "x": pose[0],
                "y": pose[1],
                "z": pose[2],
                "rx": pose[3],
                "ry": pose[4],
                "rz": pose[5],
            }
        req = {**req, "poses": req.get("poses", [pose]), "plane": req.get("plane", p.get("plane", "XZ"))}
    return handle_transform_mirror(req)


def handle_offset_alias(req: dict[str, Any]) -> dict[str, Any]:
    if isinstance(req.get("params"), dict):
        p = req["params"]
        pose = p.get("pose")
        if isinstance(pose, list):
            pose = {
                "x": pose[0],
                "y": pose[1],
                "z": pose[2],
                "rx": pose[3],
                "ry": pose[4],
                "rz": pose[5],
            }
        dxyz = p.get("dxyz", (0, 0, 0))
        drpy = p.get("drpy", (0, 0, 0))
        delta = {
            "x": float(dxyz[0]),
            "y": float(dxyz[1]),
            "z": float(dxyz[2]),
            "rx": float(drpy[0]),
            "ry": float(drpy[1]),
            "rz": float(drpy[2]),
        }
        req = {**req, "poses": req.get("poses", [pose]), "delta": req.get("delta", delta)}
    return handle_transform_offset(req)


HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "ping": handle_ping,
    "forward_kinematics": handle_forward_kinematics,
    "fk": handle_fk,
    "calibrate": handle_calibrate,
    "get_calibration_status": handle_get_calibration_status,
    "load_cnd": handle_load_cnd,
    "transform_frame": handle_transform_frame,
    "frame_move": handle_frame_move_alias,
    "transform_mirror": handle_transform_mirror,
    "mirror": handle_mirror_alias,
    "transform_offset": handle_transform_offset,
    "offset": handle_offset_alias,
    "read_uframe": handle_read_uframe,
    "read_tool": handle_read_tool,
    "verify_rcprm": handle_verify_rcprm,
    "regression_pair": handle_regression_pair,
    "scan_backup": handle_scan_backup,
    "create_profile_from_backup": handle_create_profile_from_backup,
    "load_profile": handle_load_profile,
    "get_profile": handle_get_profile,
}


def dispatch(req: dict[str, Any]) -> dict[str, Any]:
    request_id = req.get("id")
    method = req.get("type") or req.get("cmd") or req.get("method") or req.get("command")
    if request_id is None:
        request_id = "anon"
    request_id = str(request_id)
    if method not in HANDLERS:
        return err(request_id, "UNKNOWN_METHOD", f"unsupported type: {method}")
    try:
        # Handlers expect id on the request
        req = {**req, "id": request_id}
        return HANDLERS[method](req)
    except KeyError as exc:
        return err(request_id, "NOT_FOUND", str(exc))
    except ValueError as exc:
        return err(request_id, "INVALID_REQUEST", str(exc))


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        payload: object = None
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                response = err(None, "INVALID_REQUEST", "request must be a JSON object")
            else:
                response = dispatch(payload)
        except ValueError as exc:
            response = err(
                payload.get("id") if isinstance(payload, dict) else None,
                "INVALID_REQUEST",
                str(exc),
            )
        except Exception as exc:  # noqa: BLE001 — keep the stdio loop alive
            print(str(exc), file=sys.stderr)
            response = err(None, "PROTOCOL_ERROR", str(exc))
        print(json.dumps(response, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
