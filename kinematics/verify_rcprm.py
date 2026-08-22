"""CLI: test RC.PRM link-length hypothesis against UFRAME + home anchors."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_KIN_DIR = Path(__file__).resolve().parent
if str(_KIN_DIR) not in sys.path:
    sys.path.insert(0, str(_KIN_DIR))

from ar2010 import (
    HOME_CARTESIAN,
    HOME_PULSES,
    Pose,
    default_params,
    default_tool,
    forward_kinematics,
    xyz_error_mm,
)
from calibrate import (
    backup_seed_pairs,
    calibrate,
    evaluate_residuals,
    is_calibrated,
    uframe_pairs,
)
from cnd import parse_rc_prm, parse_tool_cnd, parse_uframe_cnd


def run_verify(rcprm_path: str, uframe_path: str, tool_path: str) -> dict:
    geometry = parse_rc_prm(rcprm_path)
    frames = parse_uframe_cnd(uframe_path)
    tools = parse_tool_cnd(tool_path)
    tool0 = next((t for t in tools if t.id == 0), None)
    tool_pose = tool0.tcp if tool0 is not None else default_tool()

    seed = default_params()
    seed.a1 = geometry.link_lengths_mm["a1"]
    seed.a2 = geometry.link_lengths_mm["a2"]
    seed.a3 = geometry.link_lengths_mm["a3"]
    seed.d4 = geometry.link_lengths_mm["d4"]
    seed.d6 = geometry.link_lengths_mm["d6"]

    # Seed model (no least_squares) — should already be excellent
    seed_pairs = backup_seed_pairs() + uframe_pairs(frames)
    seed_report = evaluate_residuals(seed_pairs, seed, tool=tool_pose, frames=frames)

    home_fk = forward_kinematics(HOME_PULSES, tool=tool_pose, params=seed)
    home_err = xyz_error_mm(home_fk.pose, Pose.from_xyzrpy(HOME_CARTESIAN))

    uframe_rows = []
    for frame in frames:
        fk = forward_kinematics(frame.rorg, tool=tool_pose, params=seed)
        err = xyz_error_mm(fk.pose, frame.buser)
        uframe_rows.append(
            {
                "name": frame.name,
                "id": frame.id,
                "error_mm": err,
                "fk": fk.pose.as_tuple(),
                "buser": frame.buser.as_tuple(),
            }
        )

    # Optional refinement
    result = calibrate(seed_pairs, seed=seed, tool=tool_pose, frames=frames)

    return {
        "rcprm_links_mm": geometry.link_lengths_mm,
        "hypothesis_holds": geometry.hypothesis_holds,
        "seed": {
            "rms_mm": seed_report.rms_mm,
            "worst_mm": seed_report.worst_mm,
            "home_error_mm": home_err,
            "uframes": uframe_rows,
        },
        "calibrated": result.to_dict(),
        "gates": {
            "rc_prm_hypothesis_held": bool(
                geometry.hypothesis_holds and seed_report.worst_mm < 1.0
            ),
            "uframe_pass": all(row["error_mm"] < 1.0 for row in uframe_rows),
            "home_pass": home_err < 2.0,
            "is_calibrated_5mm": is_calibrated(result, 5.0),
        },
        "notes": geometry.notes,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--rcprm",
        default=r"C:\Users\icors\Documents\Yaskawa Job editing\Yaskawa Jobs\DYNAMIC1\RC.PRM",
    )
    parser.add_argument(
        "--uframe",
        default=r"C:\Users\icors\Documents\Yaskawa Job editing\Yaskawa Jobs\DYNAMIC1\UFRAME.CND",
    )
    parser.add_argument(
        "--tool",
        default=r"C:\Users\icors\Documents\Yaskawa Job editing\Yaskawa Jobs\DYNAMIC1\TOOL.CND",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = run_verify(args.rcprm, args.uframe, args.tool)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    links = result["rcprm_links_mm"]
    print("RC.PRM ///RC1G link hypothesis (mm):")
    print(
        f"  a1={links['a1']:.1f}  a2={links['a2']:.1f}  "
        f"a3={links['a3']:.1f}  d4={links['d4']:.1f}  d6={links['d6']:.1f}"
    )
    seed = result["seed"]
    print(
        f"\nSeed FK residuals: RMS={seed['rms_mm']:.4f} mm  "
        f"worst={seed['worst_mm']:.4f} mm"
    )
    for row in seed["uframes"]:
        print(f"  {row['name']}: {row['error_mm']:.4f} mm")
    print(f"\nHome anchor error: {seed['home_error_mm']:.4f} mm")
    home_fk = forward_kinematics(HOME_PULSES, tool=default_tool())
    print(f"  home FK={tuple(round(float(v), 3) for v in home_fk.pose.as_tuple())}")
    print(f"  home target={HOME_CARTESIAN}")
    gates = result["gates"]
    print("\nGates:")
    print(f"  RC.PRM hypothesis held: {gates['rc_prm_hypothesis_held']}")
    print(f"  UFRAME pass (<1 mm):    {gates['uframe_pass']}")
    print(f"  Home pass (<2 mm):      {gates['home_pass']}")
    return 0 if gates["uframe_pass"] and gates["home_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
