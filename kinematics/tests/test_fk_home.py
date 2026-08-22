"""Home-pose FK test against the assumed BASE twin."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ar2010 import (
    HOME_CARTESIAN,
    HOME_PULSES,
    Pose,
    default_tool,
    forward_kinematics,
    xyz_error_mm,
)

HOME_XYZ_LIMIT_MM = 2.0


def test_fk_home_near_cartesian():
    result = forward_kinematics(HOME_PULSES, tool=default_tool())
    err = xyz_error_mm(result.pose, Pose.from_xyzrpy(HOME_CARTESIAN))
    assert err < HOME_XYZ_LIMIT_MM, f"home residual {err:.3f} mm"


def test_fk_pulse_alias():
    from ar2010 import fk_pulse

    pose = fk_pulse(HOME_PULSES)
    assert abs(pose.x - 275.0) < 2.0
    assert abs(pose.z - 875.0) < 2.0
