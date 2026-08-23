"""Tests for user-frame Flip convert (homogeneous UF remap)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

KIN_DIR = Path(__file__).resolve().parents[1]
if str(KIN_DIR) not in sys.path:
    sys.path.insert(0, str(KIN_DIR))

from ar2010 import Pose, pose_to_matrix
from cnd import parse_uframe_cnd
from frame_flip import TOOL_Z_FLIP, convert_jbi_text, convert_pose, euref_to_matrix
from server import STATE, dispatch

APP_FIXTURE = KIN_DIR.parent / "fixtures" / "transform"


def test_flip_sample_matrix_matches_formula() -> None:
    """Flip.py sample UF1/UF2 + one pose — matrix identity check."""
    uf_old = Pose.from_xyzrpy([1000.0, 0.0, 500.0, 0.0, 0.0, 0.0])
    uf_new = Pose.from_xyzrpy([1500.0, 200.0, 500.0, 0.0, 0.0, 180.0])
    p_old = Pose(100.0, 50.0, 25.0, 180.0, 0.0, 0.0)

    expected = (
        np.linalg.inv(euref_to_matrix(*uf_new.as_tuple()))
        @ euref_to_matrix(*uf_old.as_tuple())
        @ euref_to_matrix(*p_old.as_tuple())
        @ TOOL_Z_FLIP
    )
    got = convert_pose(p_old, uf_old, uf_new, apply_tool_z_flip=True)
    assert np.allclose(pose_to_matrix(got), expected, atol=1e-9)
    assert abs(got.x - 400.0) < 1e-6
    assert abs(got.y - 150.0) < 1e-6
    assert abs(got.z - 25.0) < 1e-6


def test_flip_fixture_jbi_roundtrip() -> None:
    uframe_path = APP_FIXTURE / "UFRAME.CND"
    source_path = APP_FIXTURE / "USER_CART_S1.JBI"
    expected_path = APP_FIXTURE / "USER_CART_S1_FLIP_UF3.JBI"
    assert uframe_path.is_file()
    assert source_path.is_file()
    assert expected_path.is_file()

    frames = parse_uframe_cnd(uframe_path)
    uf2 = next(f for f in frames if f.id == 2).buser
    uf3 = next(f for f in frames if f.id == 3).buser
    text = source_path.read_text(encoding="utf-8")
    out, stats = convert_jbi_text(
        text, uf2, uf3, 3, apply_tool_z_flip=True, name_suffix="_FLIP_UF3"
    )
    assert stats["converted"] == 4
    assert stats["skippedPulse"] == 0
    expected = expected_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert out.replace("\r\n", "\n") == expected


def test_server_transform_frame_flip() -> None:
    uf_old = {"x": 1000.0, "y": 0.0, "z": 500.0, "rx": 0.0, "ry": 0.0, "rz": 0.0}
    uf_new = {"x": 1500.0, "y": 200.0, "z": 500.0, "rx": 0.0, "ry": 0.0, "rz": 180.0}
    pose = {"x": 100.0, "y": 50.0, "z": 25.0, "rx": 180.0, "ry": 0.0, "rz": 0.0}
    resp = dispatch(
        {
            "id": "flip-1",
            "type": "transform_frame_flip",
            "poses": [pose],
            "sourceUf": uf_old,
            "targetUf": uf_new,
            "targetFrameId": 2,
            "applyToolZFlip": True,
        }
    )
    assert resp["ok"] is True
    got = resp["result"]["poses"][0]
    assert abs(got["x"] - 400.0) < 1e-6
    assert abs(got["y"] - 150.0) < 1e-6
    assert abs(got["z"] - 25.0) < 1e-6

    STATE.frames = parse_uframe_cnd(APP_FIXTURE / "UFRAME.CND")
    via_ids = dispatch(
        {
            "id": "flip-2",
            "type": "transform_frame_flip",
            "poses": [pose],
            "sourceFrameId": 2,
            "targetFrameId": 3,
            "applyToolZFlip": False,
        }
    )
    assert via_ids["ok"] is True
    assert via_ids["result"]["applyToolZFlip"] is False
