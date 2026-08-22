# External kinematic references (AR2010 / YRC1000)

For parallel build agents working on `ar2010.py` / calibration.  
Full Motoman portal notes: `docs/MOTOMAN_DEVELOPER_FINDINGS.md`.

## Trusted link lengths (mm)

Source of truth for **geometry** (not pulse scales):

1. ROS-Industrial URDF  
   https://github.com/ros-industrial/motoman/blob/kinetic-devel/motoman_ar2010_support/urdf/ar2010_macro.xacro
2. This cell’s `RC.PRM` `///RC1G` (microns) — see `RC_PRM_FINDINGS.txt`
3. Motoman AR2010 datasheet envelope drawing  
   https://www.motoman.com/getmedia/e0638c68-2a09-490d-9eb1-a8a1c1efa01c/AR2010.pdf.aspx

### Seed constants (ROS URDF joint origins, mm)

Motoman BASE frame is at the S-axis (URDF also defines `base` fixed joint at `z = 505` from `base_link` floor). For TCP in BASE, start FK at the S joint (do not add 505 mm into XYZ unless comparing to floor CAD).

```text
# joint origins (parent → child), before revolute about +Z (URDF convention)
S:  xyz = (0, 0, 0)          # in BASE; floor CAD uses +505 Z from base_link
L:  xyz = (150, 0, 0)        rpy = (+90°, -90°, -180°)
U:  xyz = (760, 0, 0)        rpy = (+180°, 0, 0)
R:  xyz = (200, -1082, 0)    rpy = (-90°, 0, 0)
B:  xyz = (0, 0, 0)          rpy = (+90°, 0, 0)
T:  xyz = (0, -100, 0)       rpy = (-90°, 0, 0)

# ROS-Industrial flange / tool0 fixed transforms (for mesh alignment)
flange from link_6_t: rpy = (0, +90°, 0)
tool0 from flange:    rpy = (+180°, -90°, 0)
```

These lengths are the seed data in `ar2010.py`. Verified against UFRAME.CND (RORG→BUSER residuals < 0.01 mm). See `RC_PRM_FINDINGS.txt`.

### Reach / limits (heuristic only)

- Max reach: **2010 mm**
- URDF joint limits (deg): S ±180, L −105…+155, U −86…+160, R ±150, B −135…+90, T ±210
- This cell’s `RC.PRM` pulse limits are consistent with expanded wrist ranges R ±200, B ±150, T ±455. `ar2010.default_params()` uses those for pulse-per-degree seeds.

## Pulse ↔ degree

Seed scales in `ar2010.py` are RC.PRM pulse soft-limits divided by the degree ranges above. `calibrate.py` can still nudge the six scales and home pulse offsets. On the backup anchors the seed model is already within 1 mm (UFRAME origins ~0.005 mm).

## Trusted conversion API (online validation)

YMConnect `KinematicsInterface` on **YRC1000+** (Apache 2.0):

- Docs: https://developer.motoman.com/en/YMConnect/KinematicsInterface
- Releases: https://github.com/Yaskawa-Global/YMConnect/releases
- `KinematicConversions::PulseToCartesianPos` / `PulseToJointAngle` / `CartesianPosToPulse`
- Returns `Figure` (Front/Upper/Flip + axis flags) ≈ live `///RCONF`

**Does not** expose Get/Put user-frame definitions (use `UFRAME.CND`).

## On-controller INFORM equivalent

```text
CNVRT PX000 PX001 BF          # pulse → base XYZ
CNVRT PX000 PX001 UF#(2)      # pulse → user frame 2 XYZ
CNVRT PX000 PX001 UF#(2) TL#(0)
```

Use for optional pendant-side golden pairs, not offline editing.

## Offline calibration assist (this app)

The Calibration Wizard exports paired jobs `CAL_AR2010_STANDARD.JBI` (Phase A PULSE) and `CAL_AR2010_RELATIVE.JBI` (Phase B cartesian) with matching pause tags, plus a README for the standard→relative procedure. Collect transcribed pulse↔cartesian pairs offline. It does **not** call YMConnect. Prefer BASE readouts for joint-delta samples; USER pairs need loaded `UFRAME.CND` in the sidecar. Cell-safe: modest joint deltas only — no full-span sweeps.
