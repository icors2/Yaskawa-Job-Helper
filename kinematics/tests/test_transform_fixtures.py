"""Fixture checks for USER cartesian transfer / YZ mirror / single-side mirror."""

from __future__ import annotations

from pathlib import Path

from ar2010 import Pose
from transform import mirror

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "testdata" / "transform"
# Prefer app fixtures when present (single source of truth).
APP_FIXTURE_DIR = ROOT.parent / "fixtures" / "transform"


def _fixture_dir() -> Path:
    if APP_FIXTURE_DIR.is_dir():
        return APP_FIXTURE_DIR
    return FIXTURE_DIR


def _parse_user_poses(text: str) -> tuple[int, list[Pose]]:
    user_id = -1
    poses: list[Pose] = []
    in_user = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("///USER"):
            parts = line.split()
            user_id = int(parts[1])
            in_user = True
            continue
        if line.startswith("///POSTYPE"):
            in_user = "USER" in line.upper()
            continue
        if line.startswith("//INST"):
            break
        if not in_user:
            continue
        if not (line.startswith("P") or line.startswith("C")) or "=" not in line:
            continue
        rhs = line.split("=", 1)[1]
        vals = [float(p.strip()) for p in rhs.split(",")]
        poses.append(Pose(*vals[:6]))
    return user_id, poses


def _read(name: str) -> str:
    return (_fixture_dir() / name).read_text(encoding="utf-8")


def test_transfer_uf2_to_uf3_identical() -> None:
    source_uid, source_poses = _parse_user_poses(_read("USER_CART_S1.JBI"))
    dest_uid, dest_poses = _parse_user_poses(_read("USER_CART_S1_UF3.JBI"))
    assert source_uid == 2
    assert dest_uid == 3
    assert len(source_poses) == len(dest_poses) == 4
    for a, b in zip(source_poses, dest_poses):
        assert abs(a.x - b.x) < 1e-6
        assert abs(a.y - b.y) < 1e-6
        assert abs(a.z - b.z) < 1e-6


def test_mirror_yz_same_user_frame() -> None:
    source_uid, source_poses = _parse_user_poses(_read("USER_CART_S1.JBI"))
    mirror_uid, mirror_poses = _parse_user_poses(_read("USER_CART_S1_MYZ.JBI"))
    assert source_uid == mirror_uid == 2
    assert source_poses[0].x > 0
    assert mirror_poses[0].x < 0
    for src, expected in zip(source_poses, mirror_poses):
        got, needs_rconf = mirror(src, "YZ")
        assert needs_rconf is True
        assert abs(got.x - expected.x) < 1e-3
        assert abs(got.y - expected.y) < 1e-3
        assert abs(got.z - expected.z) < 1e-3
        assert abs(got.rx - expected.rx) < 1e-3
        assert abs(got.ry - expected.ry) < 1e-3
        assert abs(got.rz - expected.rz) < 1e-3


def test_single_side_left_right_match_yz() -> None:
    _, myz = _parse_user_poses(_read("USER_CART_S1_MYZ.JBI"))
    for name in ("USER_CART_S1_SSM_L_YZ.JBI", "USER_CART_S1_SSM_R_YZ.JBI"):
        uid, poses = _parse_user_poses(_read(name))
        assert uid == 2
        for a, b in zip(poses, myz):
            assert abs(a.x - b.x) < 1e-6
            assert abs(a.y - b.y) < 1e-6
            assert abs(a.z - b.z) < 1e-6


def test_offset_x100_same_user_frame() -> None:
    from transform import offset

    source_uid, source_poses = _parse_user_poses(_read("USER_CART_S1.JBI"))
    off_uid, off_poses = _parse_user_poses(_read("USER_CART_S1_OFF_X100.JBI"))
    assert source_uid == off_uid == 2
    assert len(source_poses) == len(off_poses) == 4
    for src, expected in zip(source_poses, off_poses):
        got = offset(src, (100.0, 0.0, 0.0), (0.0, 0.0, 0.0))
        assert abs(got.x - expected.x) < 1e-3
        assert abs(got.y - expected.y) < 1e-3
        assert abs(got.z - expected.z) < 1e-3
        assert abs(got.rx - expected.rx) < 1e-3
        assert abs(got.ry - expected.ry) < 1e-3
        assert abs(got.rz - expected.rz) < 1e-3
        assert abs(got.x - (src.x + 100.0)) < 1e-3


def test_uframe_cnd_s1_s2_present() -> None:
    path = _fixture_dir() / "UFRAME.CND"
    if not path.is_file():
        path = ROOT.parent / "fixtures" / "UFRAME.CND"
    text = path.read_text(encoding="utf-8")
    assert "//UFRAME 2" in text and "///NAME S1" in text
    assert "//UFRAME 3" in text and "///NAME S2" in text
    assert "////BUSER" in text


if __name__ == "__main__":
    test_transfer_uf2_to_uf3_identical()
    test_mirror_yz_same_user_frame()
    test_single_side_left_right_match_yz()
    test_offset_x100_same_user_frame()
    test_uframe_cnd_s1_s2_present()
    print("transform fixture tests OK")
