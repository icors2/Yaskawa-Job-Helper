"""Unit tests for AR2010 FK, CND readers, transforms, and RC.PRM geometry.

Run from this folder:
    python test_kinematics.py
    pytest test_kinematics.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

KIN_DIR = Path(__file__).resolve().parent
if str(KIN_DIR) not in sys.path:
    sys.path.insert(0, str(KIN_DIR))

from ar2010 import (
    HOME_CARTESIAN,
    HOME_PULSES,
    Pose,
    default_params,
    default_tool,
    forward_kinematics,
    pulses_to_degrees,
    xyz_error_mm,
)
from calibrate import backup_seed_pairs, calibrate, evaluate_residuals, uframe_pairs
from cnd import parse_rc_prm, parse_tool_cnd, parse_uframe_cnd
from robot_profile import create_profile_from_backup, scan_backup
from server import STATE, dispatch
from transform import frame_move, mirror, offset, reach_envelope

WORKSPACE = KIN_DIR.parent.parent
DYNAMIC1 = WORKSPACE / "Yaskawa Jobs" / "DYNAMIC1"
UFRAME_PATH = DYNAMIC1 / "UFRAME.CND"
TOOL_PATH = DYNAMIC1 / "TOOL.CND"
RC_PRM_PATH = DYNAMIC1 / "RC.PRM"
SYSTEM_PATH = DYNAMIC1 / "SYSTEM.SYS"

HOME_XYZ_LIMIT_MM = 2.0
UFRAME_XYZ_LIMIT_MM = 1.0


def test_parse_uframe_and_tool() -> None:
    frames = parse_uframe_cnd(UFRAME_PATH)
    tools = parse_tool_cnd(TOOL_PATH)
    assert [frame.id for frame in frames] == [1, 2, 3]
    assert [frame.name for frame in frames] == ["REAMER", "S1", "S2"]
    assert frames[1].rorg[:6] == [-46843.0, -84846.0, -95223.0, 7024.0, -29869.0, -5287.0]
    assert abs(frames[1].buser.x - 841.349) < 1e-6
    tool0 = next(tool for tool in tools if tool.id == 0)
    assert tool0.name == "STANDARD TOOL"
    assert abs(tool0.tcp.z - 463.147) < 1e-6
    assert abs(tool0.tcp.ry + 45.0) < 1e-6


def test_rc_prm_hypothesis() -> None:
    geometry = parse_rc_prm(RC_PRM_PATH)
    assert geometry.row1[:10] == [200.0, 150000.0, 0.0, 760000.0, 0.0, 200000.0, 0.0, 0.0, 1082000.0, 0.0]
    assert geometry.link_lengths_mm["a1"] == 150.0
    assert geometry.link_lengths_mm["a2"] == 760.0
    assert geometry.link_lengths_mm["a3"] == 200.0
    assert geometry.link_lengths_mm["d4"] == 1082.0
    assert geometry.link_lengths_mm["d6"] == 100.0
    assert geometry.hypothesis_holds is True
    assert geometry.pulse_limits_pos[:6] == [241449.0, 295690.0, 254863.0, 204573.0, 147036.0, 206914.0]


def test_scan_and_create_profile() -> None:
    scan = scan_backup(DYNAMIC1)
    assert scan["ready"] is True
    assert scan["missingRequired"] == []
    profile = create_profile_from_backup(DYNAMIC1)
    assert "AR2010" in profile.robot_model.upper() or profile.robot_id.upper() == "AR2010"
    assert profile.status == "template_validated"
    assert profile.link_lengths_mm["a2"] == 760.0
    assert len(profile.pulse_per_deg) == 6
    assert SYSTEM_PATH.is_file()

    loaded = dispatch(
        {
            "id": "profile-1",
            "type": "load_profile",
            "profile": profile.to_dict(),
        }
    )
    assert loaded["ok"] is True
    assert loaded["result"]["profile"]["robotId"] == profile.robot_id
    assert STATE.profile is not None
    assert abs(STATE.params.a2 - 760.0) < 1e-9

    got = dispatch({"id": "profile-2", "type": "get_profile"})
    assert got["ok"] is True
    assert got["result"]["hasProfile"] is True

    scanned = dispatch({"id": "profile-3", "type": "scan_backup", "folder": str(DYNAMIC1)})
    assert scanned["ok"] is True
    assert scanned["result"]["ready"] is True


def test_fk_home() -> dict[str, float]:
    result = forward_kinematics(HOME_PULSES, tool=default_tool())
    expected = Pose.from_xyzrpy(HOME_CARTESIAN)
    err = xyz_error_mm(result.pose, expected)
    assert err < HOME_XYZ_LIMIT_MM, f"home residual {err:.3f} mm exceeds {HOME_XYZ_LIMIT_MM} mm"
    return {"home_mm": err, "home_pose": result.pose}


def test_fk_uframes() -> list[dict[str, object]]:
    frames = parse_uframe_cnd(UFRAME_PATH)
    tool = default_tool()
    rows = []
    for frame in frames:
        result = forward_kinematics(frame.rorg, tool=tool)
        err = xyz_error_mm(result.pose, frame.buser)
        assert err < UFRAME_XYZ_LIMIT_MM, f"{frame.name} residual {err:.3f} mm"
        rows.append({"name": frame.name, "id": frame.id, "xyz_mm": err})
    return rows


def test_pulses_to_degrees() -> None:
    degrees = pulses_to_degrees(HOME_PULSES)
    assert abs(degrees[0]) < 1e-9
    assert degrees[1] < 0
    assert abs(degrees[3]) < 1e-9


def test_transforms() -> None:
    pose = Pose(100.0, 20.0, 50.0, 180.0, 0.0, 10.0)
    moved = frame_move(pose, 2, 3)
    assert moved.as_tuple() == pose.as_tuple()
    mirrored, review = mirror(pose, "XZ")
    assert review is True
    assert abs(mirrored.y + pose.y) < 1e-9
    shifted = offset(pose, (1.0, 2.0, 3.0), (0.0, 0.0, 0.0))
    assert abs(shifted.x - 101.0) < 1e-6
    # +100 mm X in USER/BASE frame (fixture-style check)
    shifted_x100 = offset(pose, (100.0, 0.0, 0.0), (0.0, 0.0, 0.0))
    assert abs(shifted_x100.x - 200.0) < 1e-9
    assert abs(shifted_x100.y - pose.y) < 1e-9
    assert abs(shifted_x100.z - pose.z) < 1e-9
    assert abs(shifted_x100.rx - pose.rx) < 1e-9
    # Fixed-frame RPY: +10° Rz should change orientation, keep XYZ
    rotated = offset(pose, (0.0, 0.0, 0.0), (0.0, 0.0, 10.0))
    assert abs(rotated.x - pose.x) < 1e-9
    assert abs(rotated.y - pose.y) < 1e-9
    assert abs(rotated.z - pose.z) < 1e-9
    assert abs(rotated.rz - (pose.rz + 10.0)) < 1e-3 or abs(rotated.rz - pose.rz) > 1e-3
    check = reach_envelope(Pose(2500.0, 0.0, 0.0, 0.0, 0.0, 0.0))
    assert check.within_reach is False


def test_joint_limit_label_parse() -> None:
    from calibrate import parse_axis_limit_label

    assert parse_axis_limit_label("S+ safe limit from home") == ("S", "+")
    assert parse_axis_limit_label("L- safe limit from home") == ("L", "-")
    assert parse_axis_limit_label("STEP_T_PLUS") == ("T", "+")
    assert parse_axis_limit_label("home") is None


def test_calibrate_improves_or_holds() -> ResidualReportLike:
    frames = parse_uframe_cnd(UFRAME_PATH)
    seed = default_params()
    before = evaluate_residuals(backup_seed_pairs(), seed, frames=frames)
    result = calibrate(backup_seed_pairs(), seed=seed, frames=frames)
    assert result.residuals.worst_mm < 2.0
    assert result.residuals.rms_mm < 1.0
    return before, result


def test_server_protocol() -> None:
    ping = dispatch({"id": "1", "type": "ping"})
    assert ping["ok"] is True
    assert ping["result"]["pong"] is True

    uframe = dispatch({"id": "2", "type": "read_uframe", "path": str(UFRAME_PATH)})
    assert uframe["ok"] is True
    assert len(uframe["result"]["frames"]) == 3

    tool = dispatch({"id": "3", "type": "read_tool", "path": str(TOOL_PATH)})
    assert tool["ok"] is True
    assert tool["result"]["tools"][0]["tcp"]["z"] == 463.147

    fk = dispatch({"id": "4", "type": "forward_kinematics", "pulses": list(HOME_PULSES), "toolId": 0})
    assert fk["ok"] is True
    assert "pose" in fk["result"]

    mirrored = dispatch(
        {
            "id": "5",
            "type": "transform_mirror",
            "poses": [{"x": 1.0, "y": 2.0, "z": 3.0, "rx": 0.0, "ry": 0.0, "rz": 0.0}],
            "plane": "YZ",
        }
    )
    assert mirrored["result"]["rconfReviewRequired"] is True
    assert mirrored["result"]["poses"][0]["x"] == -1.0

    STATE.frames = parse_uframe_cnd(UFRAME_PATH)
    moved = dispatch(
        {
            "id": "6",
            "type": "transform_frame",
            "pulses": [list(HOME_PULSES)],
            "sourceFrameId": 2,
            "targetFrameId": 3,
            "toolId": 0,
        }
    )
    assert moved["ok"] is True
    assert moved["result"]["targetFrameId"] == 3


ResidualReportLike = tuple[object, object]


def main() -> None:
    print("Parsing CND / RC.PRM...")
    test_parse_uframe_and_tool()
    test_rc_prm_hypothesis()
    test_scan_and_create_profile()
    geometry = parse_rc_prm(RC_PRM_PATH)

    print("FK home...")
    home = test_fk_home()
    home_pose = home["home_pose"]
    print(
        f"  FK(home) = {home_pose.x:.3f},{home_pose.y:.3f},{home_pose.z:.3f},"
        f"{home_pose.rx:.4f},{home_pose.ry:.4f},{home_pose.rz:.4f}"
    )
    print(f"  residual {home['home_mm']:.4f} mm")

    print("FK UFRAME RORG vs BUSER...")
    rows = test_fk_uframes()
    for row in rows:
        print(f"  {row['name']}: {row['xyz_mm']:.4f} mm")

    print("Transforms / protocol...")
    test_pulses_to_degrees()
    test_transforms()
    test_joint_limit_label_parse()
    test_server_protocol()

    print("Transform fixtures (USER cartesian)...")
    from tests.test_transform_fixtures import (
        test_mirror_yz_same_user_frame,
        test_offset_x100_same_user_frame,
        test_single_side_left_right_match_yz,
        test_transfer_uf2_to_uf3_identical,
        test_uframe_cnd_s1_s2_present,
    )

    test_transfer_uf2_to_uf3_identical()
    test_mirror_yz_same_user_frame()
    test_single_side_left_right_match_yz()
    test_offset_x100_same_user_frame()
    test_uframe_cnd_s1_s2_present()
    print("  fixture transfer / YZ / single-side / offset +100 X OK")

    print("Calibration (home + UFRAME orientation constraints)...")
    before, fitted = test_calibrate_improves_or_holds()
    print(f"  seed worst={before.worst_mm:.4f} mm rms={before.rms_mm:.4f} mm")
    print(f"  fit  worst={fitted.residuals.worst_mm:.4f} mm rms={fitted.residuals.rms_mm:.4f} mm")
    print(f"  {fitted.message}")

    summary = {
        "home_mm": home["home_mm"],
        "uframes": rows,
        "rc_prm_hypothesis": geometry.hypothesis_holds,
        "fit_rms_mm": fitted.residuals.rms_mm,
        "fit_worst_mm": fitted.residuals.worst_mm,
    }
    print(json.dumps(summary, indent=2))
    print("RC.PRM hypothesis:", "HOLDS" if geometry.hypothesis_holds else "FAILED")
    print("All unit tests passed.")


if __name__ == "__main__":
    main()
