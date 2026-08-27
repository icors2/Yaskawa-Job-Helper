"""Numeric IK round-trip, joint limits, and RCONF derivation."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

KIN_DIR = Path(__file__).resolve().parents[1]
if str(KIN_DIR) not in sys.path:
    sys.path.insert(0, str(KIN_DIR))

from ar2010 import (
    HOME_PULSES,
    RC_PRM_PULSE_LIMITS_NEG,
    RC_PRM_PULSE_LIMITS_POS,
    default_params,
    default_tool,
    forward_kinematics,
    pulses_to_degrees,
    xyz_error_mm,
)
from ik import (
    degrees_to_pulses,
    format_rconf,
    inverse_kinematics,
    pulses_within_limits,
    rconf_from_degrees,
    station_flip_seed,
    t_turn_number,
)


def test_degrees_pulses_roundtrip() -> None:
    params = default_params()
    degrees = pulses_to_degrees(HOME_PULSES, params)
    back = degrees_to_pulses(degrees, params)
    assert np.allclose(back, HOME_PULSES, atol=1e-6)


def test_ik_roundtrip_home_within_0_1_mm() -> None:
    tool = default_tool()
    fk = forward_kinematics(HOME_PULSES, tool=tool)
    solved = inverse_kinematics(fk.pose, HOME_PULSES, tool=tool)
    assert solved.reachable
    assert solved.within_limits
    assert solved.position_error_mm < 0.1
    roundtrip = forward_kinematics(solved.pulses, tool=tool)
    assert xyz_error_mm(roundtrip.pose, fk.pose) < 0.1


def test_ik_roundtrip_offset_seed() -> None:
    tool = default_tool()
    fk = forward_kinematics(HOME_PULSES, tool=tool)
    noisy = [p + 400.0 for p in HOME_PULSES]
    solved = inverse_kinematics(fk.pose, noisy, tool=tool)
    assert solved.reachable
    assert solved.position_error_mm < 0.1


def test_home_rconf_is_front_upper_noflip() -> None:
    degrees = pulses_to_degrees(HOME_PULSES)
    bits = rconf_from_degrees(degrees)
    assert bits[0] == 1
    assert bits[1] == 0
    assert bits[2] == 0
    assert bits[3] == 0
    assert bits[4] == 0
    assert format_rconf(bits).startswith("1,0,0,0,0,")
    assert format_rconf(bits).count(",") == 23


def test_t_turn_number() -> None:
    assert t_turn_number(0.0) == 0
    assert t_turn_number(179.9) == 0
    assert t_turn_number(180.1) == 1
    assert t_turn_number(-200.0) == 1


def test_pulse_limit_violation() -> None:
    over = list(HOME_PULSES)
    over[0] = RC_PRM_PULSE_LIMITS_POS[0] + 5000.0
    ok, messages = pulses_within_limits(over)
    assert ok is False
    assert any("S " in msg or msg.startswith("S ") for msg in messages)


def test_home_within_rc_prm_limits() -> None:
    ok, messages = pulses_within_limits(
        HOME_PULSES, RC_PRM_PULSE_LIMITS_POS, RC_PRM_PULSE_LIMITS_NEG
    )
    assert ok, messages


def test_station_flip_seed_negates_s_r_t() -> None:
    seed = station_flip_seed([10.0, 20.0, 30.0, 40.0, 50.0, 60.0])
    assert seed == [-10.0, 20.0, 30.0, -40.0, 50.0, -60.0]
