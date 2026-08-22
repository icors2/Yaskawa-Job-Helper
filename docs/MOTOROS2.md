# MotoROS2 and this Job Editor

Research / adopt guidance for [Yaskawa-Global/motoros2](https://github.com/Yaskawa-Global/motoros2) (v0.2.1 docs skimmed 2026-08-22).

## What it is

MotoROS2 is a **ROS 2 node that runs on the Motoman controller** (MotoPlus application + micro-ROS). A **micro-ROS Agent** on a PC bridges it into the ROS 2 graph. It publishes topics such as `joint_states`, `robot_status`, and `tf`, and exposes motion via `FollowJointTrajectory` (and related services).

It is **not** a PC SDK like YMConnect. It does **not** replace offline `.JBI` editing.

## Supported controllers (from upstream README)

| Series | Support |
| --- | --- |
| YRC1000 | Supported |
| YRC1000micro | Supported |
| DX200 | Supported |
| YNX1000 / FS100 / DX100 | Not supported |

Minimum system software (README): `DN2.44.00-00` (DX200), `YAS2.80.00-00` (YRC1000), `YBS2.45.00-00` (YRC1000micro).

Network: YRC1000 uses **LAN2 or LAN3**; DX200 / YRC1000micro use **LAN**.

ROS 2: Foxy, Galactic, Humble, or Jazzy (not Iron / Rolling). **FastDDS** RMW required (critical on Galactic).

## Cell checklist (accurate — do not invent)

1. Compatible controller + system software version (pendant: System Info → Version).
2. Network configured on the correct LAN port.
3. Maintenance → OPTION FUNCTION: **MotoPlus FUNC. = USED**, **MOTOMAN DRIVER = USED**.
4. Load matching `mr2_*.out` via MotoPlus APL (USB/CF/SD).
5. Deploy `motoros2_config.yaml` with **`agent_ip_address`** and **`agent_port_number`** pointing at the PC Agent (not the robot IP).
6. Run micro-ROS Agent on the PC (Docker on Linux, or Colcon; Windows Agent build documented upstream).
7. Reboot / clear alarms per upstream install steps; verify with `ros2 node list`.
8. Check incompatibilities: e.g. **Simple Connect** must be removed; Absolute Accuracy Compensation caveats (see upstream README / #206).

Full install: [github.com/Yaskawa-Global/motoros2](https://github.com/Yaskawa-Global/motoros2) README Quickstart + Installation.

## Adopt vs ignore for Yaskawa Job Editor

| Topic | Guidance |
| --- | --- |
| Offline `.JBI` parse / edit / Diff writes | **Ignore MotoROS2** — not involved |
| PC-side pulse↔cartesian validation | **Prefer YMConnect** `ConvertPosition` |
| Setup assist / cell diagnostics notes | **Adopt as optional UI** (prefs + checklist) |
| Live `joint_states` / TF → calibration pairs | **Defer** — document only; no ROS client in this app yet |
| Motion / MoveIt / trajectory control | **Ignore** for this product |
| Job file CRUD on controller | Upstream roadmap only — **ignore** for now |

## How it appears in the app

- **Setup Guide** (header / first-run gate — not in the sidebar) → collapsed disclosure **“Optional: MotoROS2”**
  - Explains what it is vs YMConnect
  - Links to GitHub + Developer Portal
  - Cell checklist (from docs)
  - Stores Agent host/port / ROS distro / notes **per robot profile**
  - **Does not block** install or editing
- **Online (YMConnect)** is also collapsed by default; remains the primary online kinematics path
- Finish setup with **Save** / **Finish setup** → **Loaded Jobs**

## Future calibration feed (not implemented)

If a shop already runs MotoROS2 + Agent:

1. Subscribe to `joint_states` (and optionally TF / robot_status) from a small ROS 2 helper or sidecar.
2. At each calibration pause tag, snapshot joint positions (and convert to pulses if needed) + cartesian from pendant or YMConnect.
3. Feed pairs into the existing SciPy calibrate path.

Until then, use **offline pendant transcription** or **YMConnect ConvertPosition** (when the bridge + SDK are linked).

## Links

- https://github.com/Yaskawa-Global/motoros2
- https://github.com/Yaskawa-Global/motoros2/releases
- https://github.com/Yaskawa-Global/motoros2_interfaces
- https://developer.motoman.com/en/home (ROS / Motoman developer track)
- YMConnect (PC kinematics): https://developer.motoman.com/en/YMConnect
