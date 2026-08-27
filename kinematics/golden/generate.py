"""Generate golden JSON for the TypeScript kinematics port.

The Python implementation in `kinematics/` is the oracle. This script runs it
over the committed `fixtures/` controller files and writes the expected values
to `packages/core/tests/fixtures/`, where the vitest suites compare against
them. Regenerate with `npm run kin:golden` whenever the Python side changes.

Only structural, deterministic output is emitted. Profile ids, timestamps,
absolute paths, and file digests are excluded because they are supplied by the
caller in the TypeScript port.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
KIN_DIR = REPO_ROOT / "kinematics"
FIXTURES = REPO_ROOT / "fixtures"
OUT_DIR = REPO_ROOT / "packages" / "core" / "tests" / "fixtures"

sys.path.insert(0, str(KIN_DIR))

import ar2010  # noqa: E402
import cnd  # noqa: E402
import robot_profile  # noqa: E402

GENERATOR = "kinematics/golden/generate.py"


def mat(matrix) -> list[list[float]]:
    return [[float(value) for value in row] for row in matrix]


# The "Pulse soft-limits decoded from RC1G" note interpolates a Python list
# repr, which the TypeScript port has no reason to imitate. Notes are display
# strings, so the golden contract covers the count plus the stable wording.
PULSE_NOTE_MARKER = "Pulse soft-limits decoded"


def stable_notes(notes: list[str]) -> list[str]:
    return [note for note in notes if PULSE_NOTE_MARKER not in note]


def write(name: str, payload: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"generatedBy": GENERATOR, **payload}
    path = OUT_DIR / name
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(REPO_ROOT)} ({path.stat().st_size} bytes)")


# --- inputs -----------------------------------------------------------------

FRAMES = cnd.parse_uframe_cnd(FIXTURES / "UFRAME.CND")
TOOLS = cnd.parse_tool_cnd(FIXTURES / "TOOL.CND")

# Real taught pulse positions: the RORG/RXX/RXY triples of every user frame.
TAUGHT_PULSES: list[tuple[str, list[float]]] = []
for frame in FRAMES:
    for label, pulses in (("rorg", frame.rorg), ("rxx", frame.rxx), ("rxy", frame.rxy)):
        TAUGHT_PULSES.append((f"uf{frame.id}_{label}", [float(v) for v in pulses[:6]]))

PULSE_CASES: list[tuple[str, list[float]]] = [
    ("home", list(ar2010.HOME_PULSES)),
    ("zero", [0.0] * 6),
    *TAUGHT_PULSES,
    ("s_plus_limit", list(ar2010.RC_PRM_PULSE_LIMITS_POS)),
    ("s_minus_limit", list(ar2010.RC_PRM_PULSE_LIMITS_NEG)),
]

# Orientations chosen to cover the normal branch and the gimbal-lock branch
# of rotation_to_yaskawa_zyx (|R[2,0]| >= 0.999999).
RPY_CASES = [
    (0.0, 0.0, 0.0),
    (180.0, 45.0, 0.0),
    (-0.0176, 0.0306, -10.0157),
    (0.7381, 0.4043, 87.7138),
    (-30.0, 90.0, 15.0),
    (12.0, -90.0, -170.0),
    (179.9, 89.99999, -179.9),
    (-45.0, 60.0, 120.0),
    (90.0, 0.0, -90.0),
]


# --- pose.golden.json -------------------------------------------------------


def gen_pose() -> None:
    rotation_cases = []
    for rx, ry, rz in RPY_CASES:
        rotation = ar2010.yaskawa_zyx_to_rotation(rx, ry, rz)
        back = ar2010.rotation_to_yaskawa_zyx(rotation)
        rotation_cases.append(
            {
                "rx": rx,
                "ry": ry,
                "rz": rz,
                "rotation": mat(rotation),
                "roundTrip": [float(v) for v in back],
            }
        )

    transform_cases = []
    for xyz, rpy in (
        ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]),
        ([150.0, 0.0, 0.0], [1.5707963267948966, -1.5707963267948966, -3.141592653589793]),
        ([200.0, -1082.0, 0.0], [-1.5707963267948966, 0.0, 0.0]),
        ([1.5, -2.25, 3.125], [0.3, -0.7, 1.1]),
    ):
        transform_cases.append(
            {"xyz": xyz, "rpyRad": rpy, "matrix": mat(ar2010.transform(xyz, rpy))}
        )

    pose_cases = []
    for index, (rx, ry, rz) in enumerate(RPY_CASES):
        p = ar2010.Pose(100.0 * index, -50.0 * index, 875.0 + index, rx, ry, rz)
        matrix = ar2010.pose_to_matrix(p)
        pose_cases.append(
            {
                "pose": p.to_dict(),
                "matrix": mat(matrix),
                "back": ar2010.matrix_to_pose(matrix).to_dict(),
                "inverse": mat(ar2010.invert_transform(matrix)),
            }
        )

    frame_poses = [frame.buser for frame in FRAMES]
    compose_cases = []
    relative_cases = []
    for parent in frame_poses:
        for child_index, (rx, ry, rz) in enumerate(RPY_CASES[:4]):
            child = ar2010.Pose(10.0 * child_index, 20.0, -30.0, rx, ry, rz)
            compose_cases.append(
                {
                    "parent": parent.to_dict(),
                    "child": child.to_dict(),
                    "result": ar2010.compose_poses(parent, child).to_dict(),
                }
            )
            relative_cases.append(
                {
                    "world": child.to_dict(),
                    "frame": parent.to_dict(),
                    "result": ar2010.relative_pose(child, parent).to_dict(),
                }
            )

    geodesic_cases = []
    for a_index, a in enumerate(RPY_CASES):
        b = RPY_CASES[(a_index + 3) % len(RPY_CASES)]
        geodesic_cases.append(
            {
                "a": {"rx": a[0], "ry": a[1], "rz": a[2]},
                "b": {"rx": b[0], "ry": b[1], "rz": b[2]},
                "deg": ar2010.rotation_geodesic_deg(
                    ar2010.yaskawa_zyx_to_rotation(*a), ar2010.yaskawa_zyx_to_rotation(*b)
                ),
            }
        )

    write(
        "pose.golden.json",
        {
            "rotationCases": rotation_cases,
            "transformCases": transform_cases,
            "poseCases": pose_cases,
            "composeCases": compose_cases,
            "relativeCases": relative_cases,
            "geodesicCases": geodesic_cases,
        },
    )


# --- fk.golden.json ---------------------------------------------------------


def gen_fk() -> None:
    params = ar2010.default_params()
    tool0 = ar2010.default_tool()
    uf2 = cnd.find_frame(FRAMES, 2).buser
    tool_from_cnd = cnd.find_tool(TOOLS, 0).tcp

    cases = []
    for label, pulses in PULSE_CASES:
        for tool_label, tool in (("none", None), ("tool0", tool0)):
            result = ar2010.forward_kinematics(pulses, tool=tool, params=params)
            cases.append(
                {
                    "label": f"{label}/{tool_label}",
                    "pulses": pulses,
                    "tool": tool.to_dict() if tool else None,
                    "userFrame": None,
                    "degrees": [float(v) for v in result.degrees],
                    "pose": result.pose.to_dict(),
                    "flange": result.flange.to_dict(),
                    "matrix": mat(result.matrix),
                    "flangeMatrix": mat(result.flange_matrix),
                }
            )
        # Same pulses expressed in UF#2 (S1), which is what the JBI files store.
        in_frame = ar2010.forward_kinematics(
            pulses, tool=tool_from_cnd, params=params, user_frame=uf2
        )
        cases.append(
            {
                "label": f"{label}/uf2",
                "pulses": pulses,
                "tool": tool_from_cnd.to_dict(),
                "userFrame": uf2.to_dict(),
                "degrees": [float(v) for v in in_frame.degrees],
                "pose": in_frame.pose.to_dict(),
                "flange": in_frame.flange.to_dict(),
                "matrix": mat(in_frame.matrix),
                "flangeMatrix": mat(in_frame.flange_matrix),
            }
        )

    scaled = ar2010.AR2010Params(
        pulse_per_degree=tuple(v * 1.0025 for v in params.pulse_per_degree),
        pulse_offsets=(120.0, -80.0, 35.0, 5.0, -14.0, 9.0),
    )
    scaled_cases = [
        {
            "label": label,
            "pulses": pulses,
            "degrees": [float(v) for v in ar2010.pulses_to_degrees(pulses, scaled)],
            "pose": ar2010.forward_kinematics(pulses, tool=tool0, params=scaled).pose.to_dict(),
        }
        for label, pulses in PULSE_CASES
    ]

    write(
        "fk.golden.json",
        {
            "defaultParams": ar2010.default_params().to_dict(),
            "defaultTool": tool0.to_dict(),
            "homePulses": list(ar2010.HOME_PULSES),
            "homeCartesian": list(ar2010.HOME_CARTESIAN),
            "seedPulsePerDegree": list(params.pulse_per_degree),
            "cases": cases,
            "calibratedParams": scaled.to_dict(),
            "calibratedCases": scaled_cases,
        },
    )


# --- cnd.golden.json --------------------------------------------------------


def gen_cnd() -> None:
    geometry = cnd.parse_rc_prm(FIXTURES / "RC.PRM")
    write(
        "cnd.golden.json",
        {
            "uframeFile": "fixtures/UFRAME.CND",
            "toolFile": "fixtures/TOOL.CND",
            "rcPrmFile": "fixtures/RC.PRM",
            "frames": [
                {
                    "id": frame.id,
                    "name": frame.name,
                    "toolId": frame.tool_id,
                    "rorg": frame.rorg,
                    "rxx": frame.rxx,
                    "rxy": frame.rxy,
                    "buser": frame.buser.to_dict(),
                }
                for frame in FRAMES
            ],
            "tools": [
                {"id": tool.id, "name": tool.name, "tcp": tool.tcp.to_dict()}
                for tool in TOOLS
            ],
            "rcPrm": {
                "row1": geometry.row1,
                "row2": geometry.row2,
                "linkLengthsMm": geometry.link_lengths_mm,
                "pulseLimitsPos": geometry.pulse_limits_pos,
                "pulseLimitsNeg": geometry.pulse_limits_neg,
                "hypothesisHolds": geometry.hypothesis_holds,
                "notesCount": len(geometry.notes),
                "stableNotes": stable_notes(geometry.notes),
            },
        },
    )


# --- backup.golden.json -----------------------------------------------------

PROFILE_VOLATILE_KEYS = (
    "id",
    "createdAt",
    "updatedAt",
    "sourceFolder",
    "sourceFiles",
    "notes",
)


def gen_backup() -> None:
    identity = robot_profile.parse_system_sys(FIXTURES / "SYSTEM.SYS")

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for name in robot_profile.REQUIRED_FILES:
            shutil.copyfile(FIXTURES / name, root / name)
        (root / "JOBS").mkdir()
        shutil.copyfile(FIXTURES / "TCP_CHECK.JBI", root / "JOBS" / "TCP_CHECK.JBI")
        shutil.copyfile(FIXTURES / "S1_90.JBI", root / "S1_90.JBI")

        scan = robot_profile.scan_backup(root)
        profile = robot_profile.create_profile_from_backup(root, display_name="Golden AR2010")
        entries = sorted(
            str(path.relative_to(root)).replace("\\", "/")
            for path in root.rglob("*")
            if path.is_file()
        )

    profile_dict = profile.to_dict()
    stable_profile = {
        key: value for key, value in profile_dict.items() if key not in PROFILE_VOLATILE_KEYS
    }

    write(
        "backup.golden.json",
        {
            "systemSysFile": "fixtures/SYSTEM.SYS",
            "identity": {
                "rawRobotLine": identity.raw_robot_line,
                "robotModel": identity.robot_model,
                "robotTypeCode": identity.robot_type_code,
                "displayName": identity.display_name,
                "group": identity.group,
                "application": identity.application,
                "systemNo": identity.system_no,
                "controller": identity.controller,
                "groups": identity.groups,
            },
            "scanEntries": entries,
            "scan": {
                "requiredNames": [item["name"] for item in scan["required"]],
                "requiredFound": [bool(item["found"]) for item in scan["required"]],
                "recommendedNames": [item["name"] for item in scan["recommended"]],
                "recommendedFound": [bool(item["found"]) for item in scan["recommended"]],
                "jbiCount": scan["recommended"][-1]["count"],
                "missingRequired": scan["missingRequired"],
                "ready": scan["ready"],
            },
            "profile": stable_profile,
            "profileNotesCount": len(profile.notes),
            "profileStableNotes": stable_notes(profile.notes),
            "profileParams": profile.to_params().to_dict(),
        },
    )


# --- ik.golden.json ---------------------------------------------------------


def gen_ik() -> None:
    import ik

    tool = ar2010.default_tool()
    params = ar2010.default_params()
    cases = []
    for label, pulses, seed_delta, try_flip in (
        ("home", list(ar2010.HOME_PULSES), 0.0, False),
        ("home_noisy_seed", list(ar2010.HOME_PULSES), 400.0, False),
        ("uf2_rorg", list(FRAMES[0].rorg[:6]) if FRAMES else list(ar2010.HOME_PULSES), 0.0, False),
    ):
        fk = ar2010.forward_kinematics(pulses, tool=tool, params=params)
        seed = [p + seed_delta for p in pulses]
        solved = ik.inverse_kinematics(fk.pose, seed, tool=tool, params=params, try_station_flip_seed=try_flip)
        cases.append(
            {
                "label": label,
                "target": fk.pose.to_dict(),
                "seedPulses": seed,
                "tryStationFlipSeed": try_flip,
                "result": solved.to_dict(),
            }
        )

    degrees = ar2010.pulses_to_degrees(ar2010.HOME_PULSES, params)
    rconf = ik.rconf_from_degrees(degrees, params)
    write(
        "ik.golden.json",
        {
            "homeRconf": rconf,
            "homeRconfText": ik.format_rconf(rconf),
            "stationFlipSeed": ik.station_flip_seed([10.0, 20.0, 30.0, 40.0, 50.0, 60.0]),
            "tTurn": {
                "0": ik.t_turn_number(0.0),
                "179.9": ik.t_turn_number(179.9),
                "180.1": ik.t_turn_number(180.1),
                "-200": ik.t_turn_number(-200.0),
            },
            "cases": cases,
        },
    )


# --- calibrate.golden.json --------------------------------------------------


def gen_calibrate() -> None:
    import calibrate

    tool = ar2010.default_tool()
    seed = ar2010.default_params()
    pairs = calibrate.backup_seed_pairs(tool)
    # Add a few UF RORG pairs for a deterministic multi-pair fit.
    for frame in FRAMES[:3]:
        pairs.append(
            calibrate.CalibPair(
                pulses=list(frame.rorg[:6]),
                cartesian=frame.buser,
                match_orientation=False,
                label=f"{frame.name}-RORG",
            )
        )
    result = calibrate.calibrate(pairs, seed=seed, tool=tool, frames=None)
    # Strip volatile calibration id for the golden contract.
    payload = result.to_dict()
    payload.pop("calibrationId", None)
    write(
        "calibrate.golden.json",
        {
            "pairLabels": [p.label for p in pairs],
            "seedParams": seed.to_dict(),
            "result": {
                "parameters": payload["parameters"],
                "residuals": payload["residuals"],
                "success": payload["success"],
            },
            "isCalibratedAt1mm": calibrate.is_calibrated(result, 1.0),
            "isCalibratedAt5mm": calibrate.is_calibrated(result, 5.0),
        },
    )


# --- transforms.golden.json -------------------------------------------------


def gen_transforms() -> None:
    import transform
    import frame_flip

    sample = ar2010.Pose(100.0, 20.0, 50.0, 180.0, 0.0, 10.0)
    mirror_cases = []
    for plane in ("XY", "XZ", "YZ"):
        mirrored, review = transform.mirror(sample, plane)
        mirror_cases.append(
            {
                "plane": plane,
                "input": sample.to_dict(),
                "output": mirrored.to_dict(),
                "rconfReviewRequired": review,
            }
        )

    offset_delta = ar2010.Pose(100.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    offset_out = transform.offset_pose(sample, offset_delta)

    uf_old = FRAMES[0].buser if FRAMES else ar2010.Pose(0, 0, 0, 0, 0, 0)
    uf_new = FRAMES[1].buser if len(FRAMES) > 1 else ar2010.Pose(100, 0, 0, 0, 0, 0)
    flip_in = ar2010.Pose(150.0, -20.0, 80.0, 180.0, 5.0, -10.0)
    flip_on = frame_flip.convert_pose(flip_in, uf_old, uf_new, apply_tool_z_flip=True)
    flip_off = frame_flip.convert_pose(flip_in, uf_old, uf_new, apply_tool_z_flip=False)

    uf2 = cnd.find_frame(FRAMES, 2).buser
    pulse = list(ar2010.HOME_PULSES)
    relative = transform.pulses_in_user_frame(pulse, uf2, tool=ar2010.default_tool())

    write(
        "transforms.golden.json",
        {
            "mirrorCases": mirror_cases,
            "offset": {
                "input": sample.to_dict(),
                "delta": offset_delta.to_dict(),
                "output": offset_out.to_dict(),
            },
            "frameFlip": {
                "pose": flip_in.to_dict(),
                "ufOld": uf_old.to_dict(),
                "ufNew": uf_new.to_dict(),
                "withToolFlip": flip_on.to_dict(),
                "withoutToolFlip": flip_off.to_dict(),
            },
            "pulsesInUserFrame": {
                "pulses": pulse,
                "userFrame": uf2.to_dict(),
                "pose": relative.to_dict(),
            },
            "reach": transform.reach_envelope(sample).to_dict(),
        },
    )


# --- stationFlip.golden.json ------------------------------------------------


def gen_station_flip() -> None:
    import station_flip

    lx = 1245.3
    recipe = station_flip.recipe_from_lx(lx, 2.0, -1.0)
    src = ar2010.Pose(100.0, 40.0, 70.0, 180.0, 10.0, 5.0)
    applied = station_flip.apply_flip(src, recipe)

    # Deterministic non-collinear cloud so Umeyama is full-rank.
    source_poses = []
    for i in range(12):
        source_poses.append(
            ar2010.Pose(
                50.0 + 20.0 * (i % 4),
                -30.0 + 15.0 * (i // 4),
                40.0 + 25.0 * ((i * 3) % 5),
                180.0 - i,
                5.0 + 0.5 * i,
                -8.0 + i,
            )
        )
    target_poses = [station_flip.apply_flip(p, recipe) for p in source_poses]
    # Two outliers like the Python unit test.
    target_poses[3] = ar2010.Pose(
        target_poses[3].x + 80.0, target_poses[3].y, target_poses[3].z, 0.0, 0.0, 0.0
    )
    target_poses[7] = ar2010.Pose(0.0, 0.0, 0.0, 10.0, 20.0, 30.0)

    umeyama_src = [[0.0, 0.0, 0.0], [100.0, 0.0, 0.0], [0.0, 50.0, 0.0], [10.0, 10.0, 20.0]]
    umeyama_dst = [[1200.0 - r[0], r[1], r[2]] for r in umeyama_src]
    rot, trans = station_flip.umeyama_with_reflection(
        __import__("numpy").asarray(umeyama_src),
        __import__("numpy").asarray(umeyama_dst),
    )

    fit = station_flip.fit_flip(source_poses=source_poses, target_poses=target_poses)
    identity_fit = station_flip.fit_flip(source_poses=source_poses, target_poses=source_poses)

    write(
        "stationFlip.golden.json",
        {
            "closedForm": {
                "lx": lx,
                "ly": 2.0,
                "lz": -1.0,
                "input": src.to_dict(),
                "output": applied.to_dict(),
                "recipe": recipe.to_dict(),
            },
            "umeyama": {
                "source": umeyama_src,
                "target": umeyama_dst,
                "rotation": mat(rot),
                "translation": [float(v) for v in trans],
                "detR": float(__import__("numpy").linalg.det(rot)),
            },
            "syntheticFit": fit.to_dict(),
            "identityRejected": identity_fit.to_dict(),
        },
    )


def main() -> int:
    gen_pose()
    gen_fk()
    gen_cnd()
    gen_backup()
    gen_ik()
    gen_calibrate()
    gen_transforms()
    gen_station_flip()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
