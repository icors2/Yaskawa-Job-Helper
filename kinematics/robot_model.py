"""Active robot model parameters loaded from a RobotProfile.

AR2010 remains the best-validated Motoman S-L-U-R-B-T template; FK math lives
in ar2010.py. This module maps profile JSON → AR2010Params for the sidecar.
"""

from __future__ import annotations

from ar2010 import AR2010Params, Pose, default_params, default_tool, forward_kinematics
from robot_profile import RobotProfile

# Re-export for callers that import robot_model instead of ar2010
__all__ = [
    "AR2010Params",
    "Pose",
    "RobotProfile",
    "default_params",
    "default_tool",
    "forward_kinematics",
    "params_from_profile",
]


def params_from_profile(profile: RobotProfile | dict | None) -> AR2010Params:
    if profile is None:
        return default_params()
    if isinstance(profile, dict):
        return RobotProfile.from_dict(profile).to_params()
    return profile.to_params()
