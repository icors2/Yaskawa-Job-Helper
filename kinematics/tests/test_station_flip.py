"""Station-flip fit: synthetic reflection, DYNAMIC1 pairs, transfer rejection."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

KIN_DIR = Path(__file__).resolve().parents[1]
if str(KIN_DIR) not in sys.path:
    sys.path.insert(0, str(KIN_DIR))

from ar2010 import Pose, default_params, pose_to_matrix, rotation_geodesic_deg
from station_flip import (
    TOOL_Y_FLIP,
    apply_flip,
    fit_flip,
    recipe_from_lx,
    umeyama_with_reflection,
)

BACKUP = Path(__file__).resolve().parents[3] / "Yaskawa Jobs" / "DYNAMIC1"

MIRROR_PAIRS = (
    ("R1_A304-STEP2-S1.JBI", "R1_A304-STEP2-S2.JBI", True),
    ("R1_A304-STEP4_S1.JBI", "R1_A304-STEP4_S2.JBI", True),
    ("R1_A304-STEP1_S1.JBI", "R1_A304-STEP1_S2.JBI", True),
    ("R1_A304-STEP3_S1.JBI", "R1_A304-STEP3_S2.JBI", True),
    ("R1_A307-STEP2-S1.JBI", "R1_A307-STEP2-S2.JBI", True),
    ("RACK-A402_STEP-2-S1.JBI", "RACK-A402_STEP-2-S2.JBI", False),
)

TRANSFER_PAIRS = (
    ("TUBE_WELD_43_STEP_2_S1_BOLT_SKIP.JBI", "TUBE_WELD_43_STEP_2_S2_BOLT_SKIP.JBI"),
    ("TUBE_WELD_24_STEP_2_S1_FULL.JBI", "TUBE_WELD_24_STEP_2_S2_FULL.JBI"),
)


def _rng_poses(count: int, seed: int = 0) -> list[Pose]:
    rng = np.random.default_rng(seed)
    poses: list[Pose] = []
    for _ in range(count):
        xyz = rng.uniform(-200.0, 400.0, size=3)
        rpy = rng.uniform(-40.0, 40.0, size=3)
        poses.append(
            Pose(float(xyz[0]), float(xyz[1]), float(xyz[2]), float(rpy[0]), float(rpy[1]), float(rpy[2]))
        )
    return poses


def test_apply_flip_closed_form_x_mirror() -> None:
    recipe = recipe_from_lx(1245.0, 2.0, -1.0)
    src = Pose(100.0, 40.0, 70.0, 180.0, 10.0, 5.0)
    got = apply_flip(src, recipe)
    assert abs(got.x - (1245.0 - 100.0)) < 1e-6
    assert abs(got.y - 42.0) < 1e-6
    assert abs(got.z - 69.0) < 1e-6
    expected_r = recipe.mirror_matrix @ pose_to_matrix(src)[:3, :3] @ TOOL_Y_FLIP
    got_r = pose_to_matrix(got)[:3, :3]
    assert rotation_geodesic_deg(got_r, expected_r) < 1e-6


def test_umeyama_allows_reflection() -> None:
    src = np.array([[0.0, 0.0, 0.0], [100.0, 0.0, 0.0], [0.0, 50.0, 0.0], [10.0, 10.0, 20.0]])
    dst = src.copy()
    dst[:, 0] = 1200.0 - src[:, 0]
    rotation, translation = umeyama_with_reflection(src, dst)
    assert float(np.linalg.det(rotation)) < 0.0
    assert abs(translation[0] - 1200.0) < 1e-6


def test_fit_synthetic_reflection_recovers_lx() -> None:
    lx = 1245.3
    recipe = recipe_from_lx(lx)
    source = _rng_poses(24, seed=3)
    target = [apply_flip(p, recipe) for p in source]
    # A few non-corresponding points, as in re-taught pairs.
    target[5] = Pose(target[5].x + 80.0, target[5].y, target[5].z, 0.0, 0.0, 0.0)
    target[11] = Pose(0.0, 0.0, 0.0, 10.0, 20.0, 30.0)
    result = fit_flip(source_poses=source, target_poses=target)
    assert result.accepted, result.message
    assert result.recipe is not None
    assert result.recipe.det_r < 0.0
    assert abs(result.recipe.offset[0] - lx) < 2.0
    assert result.recipe.mirror_axis == "X"
    assert result.orientation_rms_deg < 3.0
    assert result.inliers / result.total >= 0.6


def test_fit_identity_is_rejected_as_transfer() -> None:
    poses = _rng_poses(16, seed=7)
    result = fit_flip(source_poses=poses, target_poses=poses)
    assert result.accepted is False
    assert result.det_r > 0.0
    assert "Transfer" in result.message or "same-UF" in result.message


def test_fit_rotation_only_is_rejected() -> None:
    poses = _rng_poses(16, seed=9)
    cz, sz = np.cos(np.deg2rad(21.68)), np.sin(np.deg2rad(21.68))
    rot_z = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]])
    rotated: list[Pose] = []
    for pose in poses:
        xyz = rot_z @ np.array([pose.x, pose.y, pose.z])
        rotated.append(Pose(float(xyz[0]), float(xyz[1]), float(xyz[2]), pose.rx, pose.ry, pose.rz))
    result = fit_flip(source_poses=poses, target_poses=rotated)
    assert result.accepted is False
    assert result.det_r > 0.0


def _load_backup_frames_and_tool():
    from cnd import find_frame, find_tool, parse_tool_cnd, parse_uframe_cnd

    uframe = BACKUP / "UFRAME.CND"
    tool = BACKUP / "TOOL.CND"
    if not uframe.is_file() or not tool.is_file():
        pytest.skip("DYNAMIC1 backup not present")
    frames = parse_uframe_cnd(uframe)
    tools = parse_tool_cnd(tool)
    return find_frame(frames, 2).buser, find_frame(frames, 3).buser, find_tool(tools, 0).tcp


def _pulse_rows(path: Path) -> list[list[float]]:
    from regression import parse_pulse_points

    return parse_pulse_points(path.read_text(encoding="utf-8", errors="replace"))


@pytest.mark.parametrize("s1_name,s2_name,expect_lx_1245", MIRROR_PAIRS)
def test_fit_dynamic1_mirror_pairs(s1_name: str, s2_name: str, expect_lx_1245: bool) -> None:
    if not BACKUP.is_dir():
        pytest.skip("DYNAMIC1 backup not present")
    s1_path = BACKUP / s1_name
    s2_path = BACKUP / s2_name
    if not s1_path.is_file() or not s2_path.is_file():
        pytest.skip(f"missing pair {s1_name} / {s2_name}")
    uf2, uf3, tool = _load_backup_frames_and_tool()
    result = fit_flip(
        source_pulses=_pulse_rows(s1_path),
        target_pulses=_pulse_rows(s2_path),
        uf_source=uf2,
        uf_target=uf3,
        tool=tool,
        params=default_params(),
        source_frame_id=2,
        target_frame_id=3,
        source_job_name=s1_path.stem,
        target_job_name=s2_path.stem,
    )
    assert result.accepted, result.message
    assert result.recipe is not None
    assert result.recipe.det_r < 0.0
    assert result.recipe.mirror_axis == "X"
    assert result.orientation_rms_deg < 3.0
    assert result.inliers / result.total >= 0.6
    if expect_lx_1245:
        assert abs(result.recipe.offset[0] - 1245.0) < 8.0


@pytest.mark.parametrize("s1_name,s2_name", TRANSFER_PAIRS)
def test_fit_dynamic1_transfer_artifacts_rejected(s1_name: str, s2_name: str) -> None:
    if not BACKUP.is_dir():
        pytest.skip("DYNAMIC1 backup not present")
    s1_path = BACKUP / s1_name
    s2_path = BACKUP / s2_name
    if not s1_path.is_file() or not s2_path.is_file():
        pytest.skip(f"missing pair {s1_name} / {s2_name}")
    uf2, uf3, tool = _load_backup_frames_and_tool()
    result = fit_flip(
        source_pulses=_pulse_rows(s1_path),
        target_pulses=_pulse_rows(s2_path),
        uf_source=uf2,
        uf_target=uf3,
        tool=tool,
        params=default_params(),
    )
    assert result.accepted is False
    assert result.det_r > 0.0
    assert "Transfer" in result.message or "same-UF" in result.message
