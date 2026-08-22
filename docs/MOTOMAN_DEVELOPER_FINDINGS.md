# Motoman / Yaskawa developer research findings

Research date: 2026-08-22  
Target: YRC1000 + AR2010 job editor (offline `.JBI` parse / frame-move / mirror)  
Portal: [developer.motoman.com/en/home](https://developer.motoman.com/en/home)

---

## Executive verdict

| Area | Verdict for this project |
| --- | --- |
| INFORM / `.JBI` format | **Adopt** community + backup-derived rules; full INFORM manuals are public PDFs / Knowledge Center. No official byte-level `.JBI` schema on the developer portal. |
| AR2010 link lengths | **Adopt** ROS-Industrial URDF + `RC.PRM ///RC1G` (they match). See `kinematics/EXTERNAL_REFS.md`. |
| Pulse↔deg scales | **Not published.** Calibrate from pendant pairs / `RC.PRM` + home anchor. YMConnect can validate later. |
| YMConnect kinematics | **Yes — trusted controller-side pulse→cartesian.** Future calibration/validation path; not required for offline v1. |
| YMConnect user-frame get/set | **Not available** (MotoCom `BscGetUFrame` / `BscPutUFrame` have no YMConnect equivalent). Keep offline `UFRAME.CND` / `TOOL.CND`. |
| VS Code INFORM extension | **Ignore for logic** (syntax highlight only). |
| Motoman NEXT / Smart Pendant | **Ignore** (different platform). |

---

## 1. INFORM / JBI file format (YRC1000)

### Primary sources

| Resource | URL | Access |
| --- | --- | --- |
| Developer portal → Robot Programming | [developer.motoman.com/en/home](https://developer.motoman.com/en/home) (#robot-programming) | Public |
| YRC1000 INFORM Language (Knowledge Center) | [knowledge.motoman.com/.../YRC1000-INFORM-LANGUAGE](https://knowledge.motoman.com/hc/en-us/articles/4407425435927-YRC1000-INFORM-LANGUAGE) | Public TOC; body largely mirrors the PDF |
| YRC1000 INFORM Options Instructions (PDF) | [motoman.com/getmedia/.../178649-1CD](https://www.motoman.com/getmedia/346F8450-7888-448E-A145-6BAA3B894B74/178649-1CD) | Public (~470 KB PDF) |
| Forum: raw `.JBI` header jargon | [robot-forum.com/thread/16258](https://www.robot-forum.com/robotforum/thread/16258-raw-program-jargon/) | Public |
| Forum: POSTYPE PULSE vs USER | [robot-forum.com/thread/33666](https://www.robot-forum.com/robotforum/thread/33666-how-to-change-postype-in-jbi-file/) | Public |
| Local backup (authoritative for *our* cell) | `Yaskawa Jobs/DYNAMIC1/*.JBI` | Offline |

### What the manuals actually document

The INFORM manuals document **pendant instructions** (MOVJ, SFTON, CNVRT, MFRAME, …), not a formal `.JBI` on-disk grammar. Useful instruction-level facts:

- **`CNVRT`** — converts a pulse-type position variable to XYZ in a chosen frame and stores the result. Frames: `BF` (base), `RF` (robot), `TF` (tool), `UF#(n)` (user 1–63), `MTF` (master tool). Optional `TL#(n)`.  
  Example: `CNVRT PX000 PX001 BF`  
  → Controller-native pulse→cartesian (same family of math as YMConnect). Useful for **on-robot validation jobs**, not for our offline rewrite pipeline.
- **`MFRAME`** — builds / writes a user frame from three points or a pose (`UF#(n)`).
- **`SFTON` / `SFTOF`** — temporary spatial shift of subsequent moves; can reference a user frame (`SFTON Pxxx UF#(xx)`). This is **runtime shift**, not the same as rewriting `///USER` labels in the `.JBI` header.
- **Relative job** — when positions are taught relative to a user frame, they are stored as cartesian in that frame (`POSTYPE USER`), not pulses. Confirmed in forum + our `CUT_ONLY.JBI`.

### Position groups in `.JBI` (from backup + forums)

A single `//POS` block may contain **multiple groups**, each with its own headers:

| Header | Meaning |
| --- | --- |
| `///NPOS a,b,c,d,e,f` | Counts: **C, BC, EC, P, BP, EX** (confirmed by plan + files such as `CUT_ONLY` / `S1_90` / `001-S1_HOME`) |
| `///TOOL n` | Tool number for following cartesian groups |
| `///POSTYPE PULSE` + `///PULSE` | Encoder pulse positions (`C` / `P` / …) |
| `///POSTYPE BASE` + `///RECTAN` + `///RCONF …` | Base-frame XYZRxRyRz |
| `///USER n` + `///POSTYPE USER` | User-frame XYZRxRyRz (relative job / P-var style) |
| `///POSTYPE ANGLE` | Joint angles in degrees (seen in INFORM docs / other cells; rare or absent in this backup) |
| `///RCONF v0,…,v23` | Configuration / figure bits for cartesian groups |

**Adopt for the editor**

- Lossless multi-group `//POS` (already in plan).
- Frame-move = FK into source frame → emit `///USER <target>` with **unchanged relative XYZRxRyRz** (geometry stays; label changes). Matches Motoman relative-job / user-frame design.
- Keep `RCONF` from source and flag for pendant review after mirror (handedness / flip).

**RCONF ↔ YMConnect `Figure` (mapping hypothesis)**

YMConnect `Figure` ([DataStructures](https://developer.motoman.com/en/YMConnect/DataStructures#figure)):

- `frontOrBack`, `upperOrLower`, `flipOrNoFlip`
- Per-axis `axisAngles` (≤180° vs >180°)

Example cartesian group in this cell:

```text
///RCONF 1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
```

Treat first three integers as figure flags (Front/Upper/Flip family); remaining as axis-angle flags. **Do not invent bit semantics** beyond what calibration / YMConnect round-trips prove. After mirror, always flag RCONF for human review.

**Ignore**

- Trying to reverse-engineer every INFORM tag from the VS Code extension.
- Relying on Knowledge Center alone without the PDF (TOC-only pages are incomplete in some browsers).

### Example from this backup (`CUT_ONLY.JBI`)

```text
///NPOS 0,0,0,6,0,0
///TOOL 0
///POSTYPE BASE
///RECTAN
///RCONF 1,0,0,0,...
P00100=275.000,0.000,875.000,180.0000,45.0000,0.0000
///USER 1
///POSTYPE USER
P00105=216.374,-55.365,150.000,...
```

Home in BASE; cut points in USER frame 1 — same file, two groups.

---

## 2. AR2010 / Motoman arm kinematics

### Trusted geometry (link lengths)

ROS-Industrial URDF (`motoman_ar2010_support`, kinetic-devel) **matches** `RC.PRM ///RC1G` row microns and the AR2010 datasheet envelope dimensions:

| Link | URDF origin (m) | RC.PRM (µm → mm) |
| --- | --- | --- |
| S height (base_link → S) | `z = 0.505` | (floor / mounting; BASE frame often at S) |
| L | `0.150, 0, 0` | `150000` → 150 |
| U | `0.760, 0, 0` | `760000` → 760 |
| R | `0.200, -1.082, 0` | `200000`, `1082000` → 200, 1082 |
| T | `0, -0.100, 0` | `100000` → 100 |

Sources:

- [ar2010_macro.xacro](https://github.com/ros-industrial/motoman/blob/kinetic-devel/motoman_ar2010_support/urdf/ar2010_macro.xacro)
- Local `Yaskawa Jobs/DYNAMIC1/RC.PRM` lines 14–16 (`///RC1G`)
- Datasheet PDF: [AR2010.pdf](https://www.motoman.com/getmedia/e0638c68-2a09-490d-9eb1-a8a1c1efa01c/AR2010.pdf.aspx) (reach 2010 mm; dims 505 / 760 / 1082 / …)

**Adopt as FK seed.** Details copied for build agents in `kinematics/EXTERNAL_REFS.md` and `kinematics/RC_PRM_FINDINGS.txt`.

### Pulse-per-degree / signs

**Not published** by Motoman for AR2010.

- [ros-industrial/motoman discussion #650](https://github.com/ros-industrial/motoman/discussions/650) (Ted Miller): pulse↔deg factors are **not on the pendant and not in documentation**; measure by jogging known pulses from home.
- Motor mount can invert sign vs DH/URDF angle sense ([issue #335](https://github.com/ros-industrial/motoman/issues/335)).
- Working seed guesses already exist in `kinematics/_fk_probe.py` (`PPD` / `PPD_EU`); treat as **fit parameters**, not constants of nature.

**Adopt:** SciPy calibration against home + `UFRAME.CND` + pendant pairs (plan).  
**Ignore:** hard-coding any public “generic Motoman” pulse scale.

### Joint limits (datasheet / URDF)

Use for reachability heuristics only (FK-only app cannot prove joint limits after USER rewrite):

| Axis | Typical URDF limits (deg) |
| --- | --- |
| S | ±180 |
| L | −105 … +155 |
| U | −86 … +160 |
| R | ±150 (datasheet variants differ) |
| B | −135 … +90 |
| T | ±210 |

EU datasheet ranges can differ (e.g. R/B/T wider). Prefer **this controller’s** soft limits from `RC.PRM` / pendant if conflict.

---

## 3. YMConnect / MotoCom / High-Speed Ethernet

### YMConnect (preferred modern stack)

| Item | Detail |
| --- | --- |
| Home | [developer.motoman.com/en/YMConnect](https://developer.motoman.com/en/YMConnect) |
| License | Apache 2.0 |
| GitHub releases | [github.com/Yaskawa-Global/YMConnect/releases](https://github.com/Yaskawa-Global/YMConnect/releases) |
| Languages | C++17, C# (.NET 8+) |
| Platforms | Windows 10+, Ubuntu 22.04+, x86-64 |
| Controllers | YRC1000 / YRC1000micro (full); older gens with feature gaps |
| Motion + **Kinematics** | **YRC1000 and newer only** |

#### Pulse ↔ cartesian: **YES**

[`KinematicsInterface`](https://developer.motoman.com/en/YMConnect/KinematicsInterface):

```cpp
enum class KinematicConversions {
  JointAngleToCartesianPos,
  PulseToJointAngle,
  JointAngleToPulse,
  PulseToCartesianPos,   // ← FK path we care about
  CartesianPosToJointAngle,
  CartesianPosToPulse
};

StatusInfo ConvertPosition(
  ControlGroupId grp,
  PositionData& positionToConvert,
  KinematicConversions conversionType,
  PositionData& convertedPosition);

StatusInfo ConvertPositionFromCartesian(
  ControlGroupId grp,
  PositionData& positionToConvert,
  KinematicConversions conversionType,
  KinematicType type,              // Default / Delta / Figure
  const CoordinateArray& prevAngle,
  PositionData& convertedPosition);
```

Documented example converts pulse → cartesian (BASE/robot coordinates, mm + deg) and back with bit-identical pulses. Output includes **`Figure`** (Front/Upper/Flip + axis flags) — the live equivalent of `///RCONF`.

[`ControlGroupInterface::ReadPositionData`](https://developer.motoman.com/en/YMConnect/ControlGroupInterface) can also return current pose as:

```cpp
enum class CoordinateType {
  Pulse = 0,
  BaseCoordinate = 16,
  RobotCoordinate = 17,
  ToolCoordinate = 18,
  UserCoordinate = 19,
  MasterTool = 20,
  JointDegrees = 56,
  // ...
};
```

with `userFrameNumber` + `toolNumber` arguments — so the **controller** can express the same pose in USER/TOOL if those frames exist on the box.

#### Frames / tools from controller: **partial**

| Need | YMConnect? |
| --- | --- |
| Convert pulse ↔ cartesian using controller kinematics + registered tools | **Yes** (`Kinematics` / `ReadPositionData`) |
| Read/write user-frame definition (ORG/XX/XY or UF matrix) | **No API** — MotoCom `BscGetUFrame` / `BscPutUFrame` → “No corresponding function” in [ConversionFromMotoCom](https://developer.motoman.com/en/YMConnect/ConversionFromMotoCom) |
| Bulk job PULSE↔RECTAN convert (`BscConvertJobP2R`) | **No** in YMConnect |
| Read/write P / B / I / … variables | Yes (`VariablesInterface`) |
| Save/load `.JBI` files | Yes (`FilesInterface`) |
| Frame math helpers (multiply / invert / ZYX Euler) | Yes ([MathFunctions](https://developer.motoman.com/en/YMConnect/MathFunctions)) — offline helpers only |

**Future calibration / validation path (recommended later):**

1. Connect YMConnect to the cell YRC1000.
2. For each calibration pulse pose, call `ConvertPosition(..., PulseToCartesianPos, ...)`.
3. Optionally `ReadPositionData(..., UserCoordinate, userFrameN, toolN, ...)` for the same physical pose.
4. Diff against offline FK + `UFRAME.CND` / `TOOL.CND`.
5. Gate production rewrites on residual ≤ threshold.

This **validates** offline FK; it does not replace offline editing when the robot is offline / CF card only.

#### MotoCom (legacy)

- Product page: [MotoCom SDK](https://www.motoman.com/en-us/products/software/development/motocom-sdk)
- Had `BscGetUFrame` / `BscPutUFrame` and job convert helpers that YMConnect dropped.
- **Ignore for new work** unless a licensed legacy install is already on the shop PC and YMConnect cannot be enabled.

#### High-Speed Ethernet Server (HSES)

- Optional paid controller feature; third-party docs (e.g. UnderAutomation) show get joint pulses / get cartesian / move — **not** a documented general-purpose convert API like YMConnect `Kinematics`.
- **Ignore** for kinematics validation unless already licensed; prefer YMConnect.

---

## 4. VS Code INFORM extension & open-source tooling

| Project | URL | Use for us? |
| --- | --- | --- |
| VS Code “Yaskawa Inform” | [marketplace: andyprv.inform](https://marketplace.visualstudio.com/items?itemName=andyprv.inform) · [github.com/andyprv/yaskawa-inform](https://github.com/andyprv/yaskawa-inform) | **Ignore** — syntax highlight / incomplete completion; portal explicitly says it does **not** fully validate JBI. Last meaningful release ~2018. |
| Yaskawa-Global org | [github.com/Yaskawa-Global](https://github.com/Yaskawa-Global) | YMConnect, SmartPendantSDK, motoros2 — **no** JBI editor |
| ROS-Industrial Motoman | [github.com/ros-industrial/motoman](https://github.com/ros-industrial/motoman) | **Adopt** AR2010 URDF / meshes for FK seed & visualization; driver pulse scales are robot-specific |
| MotoROS2 | [github.com/Yaskawa-Global/motoros2](https://github.com/Yaskawa-Global/motoros2) | **Optional setup assist only** — see [`MOTOROS2.md`](./MOTOROS2.md). Ignore for `.JBI` editing / offline FK. Prefer YMConnect for PC-side ConvertPosition. |

No Motoman-official open-source lossless `.JBI` parser was found.

---

## 5. User frame / mirror / shift behavior (YRC1000)

### Documented Motoman behavior

- **User frames** are object-relative coordinate systems (ORG / XX / XY teaching). Moving the frame moves all relative points without reteaching each weld ([YRC1000 instructions — user frame chapter](https://www.manualslib.com/manual/2011279/Yaskawa-Yrc1000.html?page=210)).
- That is exactly the product justification for our **frame-move = relabel `///USER`** approach when poses are already expressed in the source frame.
- **`SFTON`/`SFTOF`**: runtime temporary shift (can be UF-relative). Different from offline rewrite; keep parsing these instructions but do not emulate them as file transforms unless we add an explicit “bake shift” feature later.
- **`MFRAME`**: creates UF from taught points / pose — how frames get into `UFRAME.CND`.
- **Mirror**: no first-class “mirror job” INFORM instruction found in the YRC1000 INFORM PDF index. Offline reflection of XYZRxRyRz + RCONF review remains the correct approach.
- Cartesian USER/BASE storage uses **inverse kinematics at playback**; PULSE storage is configuration-safe. Forum consensus: converting USER↔PULSE can flip R-axis solutions — another reason to prefer USER relabel for frame moves and to flag RCONF after mirror.

### Our cell frames

From backup: `UFRAME.CND` frames **REAMER (1), S1 (2), S2 (3)** — offline file remains source of truth because YMConnect cannot `GetUFrame`.

---

## 6. Access / login blockers

| Target | Status |
| --- | --- |
| [developer.motoman.com](https://developer.motoman.com/en/home) | **Public** — YMConnect docs, NEXT, Smart Pendant, INFORM links |
| YMConnect GitHub releases | **Public** (Apache 2.0 binaries) |
| INFORM PDF `178649-1CD` | **Public** download |
| Knowledge Center INFORM article | **Public** (structure); prefer PDF for full instruction text |
| [portal.motoman.com](https://portal.motoman.com/en-US) Customer Portal | **Login** — order-specific manuals, quotes; not required for what we found |
| MotoPlus / MotoCom full SDKs | **Commercial / account** — not needed if YMConnect + offline CND suffice |
| Exact factory pulse scales / DH export | **Not public**; measure or use controller convert APIs |

Nothing critical for the offline editor was blocked behind login. The valuable locked-behind-purchase pieces are MotoPlus and licensed HSES, which we can skip for v1.

---

## 7. Adopt vs ignore (checklist)

### Adopt now

1. Multi-group `//POS` / `NPOS` / `POSTYPE` / `USER` / `RCONF` rules from backup + forums.
2. AR2010 link lengths from URDF ≡ `RC.PRM` (see kinematics refs).
3. Offline `UFRAME.CND` + `TOOL.CND` readers.
4. Frame-move = relative USER rewrite; mirror + RCONF flag.
5. YMConnect `ConvertPosition` soft-dependency bridge for optional online validation (cell test still required).
6. MotoROS2 docs checklist as **optional** Setup assist (Agent host/port prefs) — not a gate.

### Defer

1. Live YMConnect ConvertPosition golden-set on a real YRC1000 (SDK link + Ethernet).
2. MotoROS2 `joint_states` / TF ingest into calibration pairs (needs ROS 2 client).
3. On-robot `CNVRT` validation jobs.
4. MotoCom `GetUFrame` via legacy SDK.

### Ignore

1. Motoman NEXT / Smart Pendant / YML / YIP.
2. VS Code INFORM extension as a parser.
3. HSES as kinematics engine.
4. Published “universal” pulse-per-degree tables.
5. MotoROS2 for offline `.JBI` rewrite / as a substitute for YMConnect ConvertPosition.

---

## 8. Concrete API cheat-sheet (copy/paste)

```text
YMConnect::OpenConnection(ip, status)
c->Kinematics->ConvertPosition(R1, pulsePos, PulseToCartesianPos, cartPos)
c->Kinematics->ConvertPosition(R1, pulsePos, PulseToJointAngle, jointPos)
c->Kinematics->ConvertPositionFromCartesian(R1, cartPos, CartesianPosToPulse, Figure, {}, pulseOut)
c->ControlGroup->ReadPositionData(R1, UserCoordinate, userFrameN, toolN, pos)
c->Variables->RobotPositionVariable->Read(index, pVar)
FrameMath::MultiplyFrames / InvertFrame / ZYXeulerToFrame / FrameToZYXeuler
```

INFORM on-controller equivalent of pulse→frame XYZ:

```text
CNVRT PX000 PX001 UF#(2) TL#(0)
```

---

## 9. Files written by this research

- `docs/MOTOMAN_DEVELOPER_FINDINGS.md` (this file)
- `docs/MOTOROS2.md` — MotoROS2 adopt/ignore for the Job Editor
- `kinematics/EXTERNAL_REFS.md` — URDF / datasheet / YMConnect links + seed numbers
- `kinematics/RC_PRM_FINDINGS.txt` — `///RC1G` interpretation vs URDF
- `ymconnect/` — ConvertPosition bridge stub (soft dependency)
