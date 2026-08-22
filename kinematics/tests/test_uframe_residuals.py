"""UFRAME.CND RORG→BUSER residual tests."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ar2010 import Pose, default_params, default_tool, forward_kinematics, xyz_error_mm
from calibrate import is_calibrated, evaluate_residuals, uframe_pairs
from cnd import parse_tool_cnd, parse_uframe_cnd

DYNAMIC1 = Path(r"C:\Users\icors\Documents\Yaskawa Job editing\Yaskawa Jobs\DYNAMIC1")
UFRAME_XYZ_LIMIT_MM = 1.0


@pytest.fixture(scope="module")
def setup():
    frames = parse_uframe_cnd(DYNAMIC1 / "UFRAME.CND")
    tools = parse_tool_cnd(DYNAMIC1 / "TOOL.CND")
    return frames, tools, default_params(), default_tool()


def test_parse_three_frames(setup):
    frames, _tools, _params, _tool = setup
    assert [f.name for f in frames] == ["REAMER", "S1", "S2"]


def test_uframe_rorg_residuals(setup):
    frames, _tools, params, tool = setup
    for frame in frames:
        fk = forward_kinematics(frame.rorg, tool=tool, params=params)
        err = xyz_error_mm(fk.pose, frame.buser)
        assert err < UFRAME_XYZ_LIMIT_MM, f"{frame.name} residual {err:.3f} mm"
    report = evaluate_residuals(uframe_pairs(frames), params, tool=tool, frames=frames)
    assert is_calibrated(report, threshold_mm=1.0)


def test_tool0_tcp(setup):
    _frames, tools, _params, _tool = setup
    tool0 = next(t for t in tools if t.id == 0)
    assert abs(tool0.tcp.z - 463.147) < 1e-3
