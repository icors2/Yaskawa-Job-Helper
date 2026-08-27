# AGENT_HANDOFF — Yaskawa Job Helper

Dense briefing for coding agents. Human runbook: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).  
**Do not** invent unfinished features as done. **Do not** edit the Cursor plan file unless the user asks.

**GitHub:** https://github.com/icors2/Yaskawa-Job-Helper  
**App / git root:** `yaskawa-job-editor/` (this folder is the repository root).  
Parent workspace may also contain `Yaskawa Jobs/` (full controller backup — **SENSITIVE**) and `Manuals/` (PDFs — large/proprietary). **Never commit those.**

---

## How to use this handoff (token strategy)

1. **Read this file first** — architecture, map, invariants, gates, where-to-change.
2. **Open listed files only when editing that area** (table below). Prefer 1–3 files over repo-wide search.
3. **Grep only to** (a) verify a claim here after parallel edits, or (b) find call sites *after* reading the map.
4. **Skip** dumping whole files into context; use section anchors + exports.
5. **Parallel work risk:** another agent may touch `apps/desktop/src/features/transform`, `apps/desktop/src/features/wizard`, `packages/core/src/jbi/edit.ts` (speeds), `stop.bat`. If behavior disagrees with this doc → **verify if PR in flight**; re-read those paths before changing them.

| Task | Open first |
| --- | --- |
| Nav / chrome / gates | `apps/desktop/src/App.tsx`, `apps/desktop/src/components/Sidebar.tsx`, `packages/core/src/setup/progress.ts` |
| Parse / serialize | `packages/core/src/jbi/parse.ts`, `serialize.ts`, `model.ts` |
| Speeds / weld / line edits | `packages/core/src/jbi/edit.ts`, `cnd.ts` |
| Frame move / transform | `apps/desktop/src/lib/jbi/frameTransform.ts`, `apps/desktop/src/features/transform/index.tsx`, `kinematics/transform.py`, `kinematics/frame_flip.py` |
| Calibration / write gate | `apps/desktop/src/features/calibration/storage.ts`, `wizard.tsx`, `packages/core/src/calibration/*`, `kinematics/calibrate.py` |
| Profiles / folders | `packages/core/src/robot/profile.ts`, `folders.ts` |
| Kin protocol | `packages/core/src/kin/protocol.ts` (types) + `apps/desktop/src/lib/kin/client.ts` (transport) ↔ `kinematics/server.py` |
| FK / pose math in TS | `packages/core/src/kin/{pose,fk}.ts`, golden tests in `packages/core/tests/` |
| CND / RC.PRM / backup parse in TS | `packages/core/src/kin/{cnd,backup}.ts` |
| FS / USB / sidecar spawn | `apps/desktop/src-tauri/src/fs_commands.rs`, `media.rs`, `sidecar.rs`, `apps/desktop/src/lib/fs/desktop.ts` |
| YMConnect | `apps/desktop/src/lib/kin/ymconnect.ts`, `apps/desktop/src-tauri/src/ymconnect.rs`, `ymconnect/` |

---

## Meta

| | |
| --- | --- |
| **One-liner** | Offline-safe YRC1000 `.JBI` editor: lossless parse/edit/serialize + Motoman FK/calibration/transforms via Python sidecar |
| **Stack** | Tauri **v2** + React/TS/Tailwind + Vite; Python stdio kinematics sidecar |
| **Repo** | https://github.com/icors2/Yaskawa-Job-Helper |
| **App root** | `C:\Users\icors\Documents\Yaskawa Job editing\yaskawa-job-editor\` |
| **Workspace** | `C:\Users\icors\Documents\Yaskawa Job editing\` |
| **Backup corpus** | `../Yaskawa Jobs/DYNAMIC1` (~300 `.JBI` + CND/PRM) — local only, gitignored |
| **Manuals** | `../Manuals/` — local only, gitignored |
| **Flip assist source** | `../Assets/Flip assist.png` → bundled as `apps/desktop/src/assets/flip-assist.png` (dual-station). Single-side: `Flip assist left.png` / `Flip assist right.png` → `flip-assist-left.png` / `flip-assist-right.png` |
| **Transform fixtures** | `fixtures/transform/` (+ `kinematics/testdata/transform/`) — synthetic USER cartesian before/after for transfer / Flip UF convert / YZ / single-side / **offset +100 X** |
| **Parent launchers** | `../Start Yaskawa Job Editor.bat`, `../Stop Yaskawa Job Editor.bat` |

### Run / stop / tests

| Action | Command |
| --- | --- |
| Start | `start.bat` → `npm run dev` (Tauri+Vite); PID in `.dev.pids`; optional `--install` |
| Portable USB | Same folder `portable/YaskawaJobEditor/` for both OSes. Windows: `Build-Portable-USB.bat` → `Run.bat` / `.exe`. Ubuntu: `./Build-Portable-USB.sh` → open `Yaskawa Job Editor.sh`. Sidecar prefers `yaskawa-kin.exe` or `yaskawa-kin` beside the app. |
| Stop | `stop.bat` → kill tree from `.dev.pids`, then path-matched node/vite/tauri/cargo |
| Dev port | **1420** (`apps/desktop/vite.config.ts` `strictPort`); HMR 1421 if `TAURI_DEV_HOST` |
| Vite-only | `npm run dev:vite` (no FS/sidecar) |
| Kin alone | `npm run kin` → `python kinematics/server.py` |
| Roundtrip | `npm run test:roundtrip` — fixtures + DYNAMIC1 ≈ **305** byte-identical (needs local backup) |
| Edit helpers | `npm run test:edit` |
| Kin unit | `npm run test:kin` |
| Transform fixtures | `npm run test:transform` |
| S1→S2 regression | `npm run test:regression` |
| Core golden tests | `npm run test:core` (vitest in `packages/core`) |
| Kin golden fixtures | `npm run kin:golden` — regenerates `packages/core/tests/fixtures/*.golden.json` from the Python oracle |
| Types | `npx tsc -p apps/desktop/tsconfig.json` and `npx tsc -p packages/core/tsconfig.json` |

Quick: `npm install` → `pip install -r kinematics\requirements.txt` → tests → `start.bat`.

---

## Workspace layout (npm workspaces)

The repo is a workspace root; **all scripts still run from the repo root** and delegate with `-w`.

```
yaskawa-job-editor/            workspace root (package.json "workspaces": packages/*, apps/*)
├─ packages/core/              @yaskawa/core — no Tauri, no fs, no network
│  ├─ src/{jbi,calibration,robot,setup,fs,kin}/
│  └─ tests/                   vitest golden tests + fixtures/*.golden.json
├─ apps/desktop/               @yaskawa/desktop — Tauri shell (React UI, src-tauri/, vite.config.ts)
│  └─ src/lib/{kin,fs,jbi}/    platform-coupled tails only (invoke, frameTransform)
├─ apps/web/                   @yaskawa/web — workspace slot only: package.json, no source yet.
│                             The web-shell agent adds index.html, src/, vite.config.ts (with the
│                             core alias below), tsconfig.json, and the build/dev scripts.
├─ kinematics/                 Python sidecar + oracle (unchanged, still at root)
├─ fixtures/  scripts/  docs/  unchanged, still at root
```

**Importing core:** `@yaskawa/core/<area>/<module>` deep imports are the primary form —
e.g. `@yaskawa/core/jbi/parse`, `@yaskawa/core/kin/fk`, `@yaskawa/core/robot/profile`.
The root barrel `@yaskawa/core` re-exports namespaces (`jbi`, `kin`, `calibration`, `robot`,
`paths`, `setup`). Core is consumed as **TypeScript source** — there is no build step.
Resolution comes from `tsconfig.base.json` `paths` plus a matching alias in
`apps/desktop/vite.config.ts`; any new app must declare both.

**Core boundary rule:** if a module needs `invoke`, the filesystem, or the network, the
platform half belongs in the app and only the pure half in core. `kin/client.ts` and
`robot/profile.ts` are already split this way — protocol types and pure logic in core, the
sidecar/backup-scan calls in `apps/desktop`.

**Known boundary debt (ports/adapters agent owns this):** the preference/session stores
(`robot/{profile,folders,pulseMirrorPrefs,ymconnectPrefs,motoros2Prefs}`, `setup/progress`,
`calibration/session`) still call a global `localStorage` directly. That is fine in both
browser-backed shells and is not hit by the golden tests, but it is the remaining
platform assumption inside core and wants a storage port.

### Golden tests for the TS kinematics port

Python stays the oracle. `kinematics/golden/generate.py` (run via `npm run kin:golden`) imports
`ar2010.py` / `cnd.py` / `robot_profile.py`, evaluates a fixed case list, and writes
`packages/core/tests/fixtures/{pose,fk,cnd,backup}.golden.json`. The vitest suites in
`packages/core/tests/` re-run the same cases through the TypeScript port and compare at
`TOLERANCE = 1e-6` (mm / deg) via the helpers in `tests/golden.ts`.

Rules if you extend a ported module:

- Add the case to `generate.py`, regenerate, and commit the JSON. Never hand-edit a `.golden.json`.
- Fixtures must stay small and deterministic — no absolute paths, timestamps, or full backups.
  `fixtures/RC.PRM` is the extracted `///RC1G` section only (see `kinematics/golden/extract_rcprm_fixture.py`),
  not the controller file.
- `../Yaskawa Jobs/DYNAMIC1` is the oracle input but is **never** committed.

---

## Architecture

```mermaid
flowchart LR
  UI[React features/*]
  JBI[lib/jbi parse edit serialize]
  ROBOT[lib/robot profiles folders prefs]
  FS[lib/fs desktop.ts]
  KIN[lib/kin client.ts]
  TAURI[Tauri Rust]
  DISK[(Disk source RO / output RW)]
  PY[kinematics/server.py]
  YM[ymconnect bridge soft]

  UI --> JBI
  UI --> ROBOT
  UI --> FS
  UI --> KIN
  FS --> TAURI
  KIN --> TAURI
  TAURI -->|read / write_output_file / USB| DISK
  TAURI -->|stdio JSON lines| PY
  UI --> YM
  YM --> TAURI
```

**Data flows**

1. **Jobs:** source folder → `read_text_file` → parse → edit → serialize → unified diff → `write_output_file` under output only.
2. **Geometry:** pulses → `forward_kinematics` / `transform_*` (sidecar) → new `///POSTYPE USER` groups (`frameTransform.ts`).
3. **Profiles:** backup scan/create in Python → store in `localStorage` → optional mirror `<output>/profiles/robot_profiles.json` → `load_profile` into sidecar.
4. **Gates:** ProfileGate (session) → forced Setup (min steps) → calibration gate for geometry + Diff/Wizard writes.

**Output-only writes:** Rust `write_output_file` resolves paths under the active output folder; refuses write with no output set. Never overwrite source/backup tree.

---

## Directory map

### UI / app

| Path | Purpose |
| --- | --- |
| `apps/desktop/src/App.tsx` | ProfileGate, forced setup, folder restore, page router, shared `activeJobPath` |
| `apps/desktop/src/main.tsx` | React mount |
| `apps/desktop/src/index.css` | Motoman theme tokens + Tailwind `@theme` / component classes |
| `apps/desktop/src/components/Sidebar.tsx` | Nav labels (Setup **not** listed) |
| `apps/desktop/src/components/StatusBar.tsx` | Status, sidecar ping, setup/calib shortcuts |
| `apps/desktop/src/features/startup/ProfileGate.tsx` | Blocking robot select/create each session |
| `apps/desktop/src/features/setup/` | Forced Setup Guide + YMConnect + MotoROS2 panels |
| `apps/desktop/src/features/wizard/` | Job Editing Wizard (intent → diff → write) |
| `apps/desktop/src/features/library/` | Loaded Jobs + dbl-click → Wizard/Manual modal |
| `apps/desktop/src/features/editor/` | Manual Editor |
| `apps/desktop/src/features/calibration/` | Manual fit UI + Guided wizard + upload/extract + gate storage |
| `apps/desktop/src/features/transform/` | Transfer / **Frame convert (Flip)** / Mirror / **Single-side mirror** / Offset + flip assist; **Preview → Write to output folder** (`writeOutputFile`, edit-write gate) |
| `apps/desktop/src/features/diff/` | Unified diff, dry-run, write, USB export hook |
| `apps/desktop/src/features/export/UsbExportPanel.tsx` | Removable drive export from output |
| `apps/desktop/src/assets/flip-assist.png` | Dual-station Flip assist diagram |
| `apps/desktop/src/assets/flip-assist-left.png` / `flip-assist-right.png` | Single-station demos (XYZ origin anchors) |

### TS libs

| Path | Purpose |
| --- | --- |
| `packages/core/src/jbi/model.ts` | `JobFile`, pos kinds, CRLF contract |
| `packages/core/src/jbi/parse.ts` | Lossless parse; NPOS validate |
| `packages/core/src/jbi/serialize.ts` | Byte-identical emit; optional NPOS recompute |
| `packages/core/src/jbi/library.ts` | Index, CALL/PSTART, rename/refs |
| `packages/core/src/jbi/edit.ts` | Insert/delete/reorder; V=/VJ=; weld tokens |
| `packages/core/src/jbi/cnd.ts` | ARCSRT/ARCEND/WEAV inventory validate |
| `packages/core/src/jbi/diff.ts` | Unified diff + validation report |
| `apps/desktop/src/lib/jbi/frameTransform.ts` | PULSE→USER frame-move; USER cartesian transfer; **Flip UF convert**; mirror / single-side (same UF); offset; optional pulse-axis flips |
| `packages/core/src/robot/profile.ts` | Multi-profile store, install gate, CAL_* names |
| `packages/core/src/robot/pulseMirrorPrefs.ts` | Per-profile advanced S/L/U/R/B/T sign knobs (default identity) |
| `packages/core/src/robot/folders.ts` | Per-profile source/output; `YaskawaJobEditor_Output` |
| `packages/core/src/robot/ymconnectPrefs.ts` | Per-profile YMConnect host/group |
| `packages/core/src/robot/motoros2Prefs.ts` | Optional MotoROS2 prefs (setup only) |
| `packages/core/src/setup/progress.ts` | Setup v3 progress / force / finish |
| `packages/core/src/calibration/*` | STANDARD/RELATIVE generators, home→±limit steps, session |
| `packages/core/src/kin/types.ts` | Shared kin domain types (`CartesianPose`, `RobotProfile`, `UserFrame`, `ToolRecord`) |
| `packages/core/src/kin/protocol.ts` | **Kin protocol SoT** — wire request/response shapes, `KIN_PROTOCOL_VERSION` |
| `packages/core/src/kin/pose.ts` | Rotation/matrix math: Yaskawa ZYX ↔ matrix, compose/invert, geodesic deg (port of `ar2010.py`) |
| `packages/core/src/kin/fk.ts` | AR2010 link params, pulse→deg, `forwardKinematics` / `fkPulse` (port of `ar2010.py`) |
| `packages/core/src/kin/cnd.ts` | `UFRAME.CND` / `TOOL.CND` / `RC.PRM` parsers (port of `cnd.py`) |
| `packages/core/src/kin/backup.ts` | `SYSTEM.SYS` identity, backup scan, profile-from-backup (port of `robot_profile.py`) |
| `apps/desktop/src/lib/kin/client.ts` | Tauri transport for the kin protocol; re-exports the core types |
| `apps/desktop/src/lib/kin/ymconnect.ts` | ConvertPosition client (separate from kin) |
| `apps/desktop/src/lib/fs/desktop.ts` | Tauri FS invokes |
| `apps/desktop/src/lib/robot/profile.ts` | Sidecar profile sync + backup scan/create (Tauri half of `robot/profile`) |
| `packages/core/src/fs/paths.ts` | Path join helpers |

### Rust / Python / other

| Path | Purpose |
| --- | --- |
| `apps/desktop/src-tauri/src/lib.rs` | Command registration |
| `apps/desktop/src-tauri/src/fs_commands.rs` | Folders, list/read JBI, output-scoped write |
| `apps/desktop/src-tauri/src/media.rs` | Removable drives, USB export, `ensure_directory` |
| `apps/desktop/src-tauri/src/sidecar.rs` | Spawn + `kin_request` stdio |
| `apps/desktop/src-tauri/src/ymconnect.rs` | Bridge status + ConvertPosition |
| `kinematics/server.py` | Stdio JSON dispatcher |
| `kinematics/ar2010.py` | S-L-U-R-B-T FK template |
| `kinematics/robot_model.py` | Profile → DH params |
| `kinematics/robot_profile.py` | Backup scan/create/load |
| `kinematics/calibrate.py` | Pair fit / residuals; home→±limit scale seeding |
| `kinematics/transform.py` | Frame move / mirror / **offset (USER/BASE XYZ + fixed-frame RPY)** |
| `kinematics/frame_flip.py` | **User-frame Flip convert** — `P_new = inv(UF_new) @ UF_old @ P_old` + optional tool Z 180°; CLI + sidecar |
| `kinematics/Flip_original.py` | Archived copy of workspace `Flip.py` (do not edit for features — change `frame_flip.py`) |
| `kinematics/cnd.py` | UFRAME/TOOL readers |
| `kinematics/RC_PRM_FINDINGS.txt` | RC.PRM geometry hypothesis (AR2010 holds) |
| `kinematics/regression_s1_s2.py` | Frame-move regression |
| `ymconnect/` | C# ConvertPosition bridge stub (soft dep) |
| `fixtures/` | Small `.JBI` + SYSTEM/TOOL/UFRAME samples (**OK to commit**) |
| `scripts/roundtrip.ts` | Roundtrip gate |
| `scripts/edit-test.ts` | Edit/speed/weld tests |
| `scripts/transform-test.ts` | Transfer / mirror / SSM / offset fixture checks |
| `docs/DEVELOPER_GUIDE.md` | Human install/run |
| `docs/MOTOMAN_DEVELOPER_FINDINGS.md` | Portal / INFORM / YMConnect research |
| `docs/MOTOROS2.md` | MotoROS2 adopt vs ignore |
| `start.bat` / `stop.bat` | Windows launchers |
| `Build-Portable-USB.bat` / `Install-Portable-to-D.bat` | Windows portable USB package + copy to `D:\` |
| `Build-Portable-USB.sh` / `scripts/install-portable-to-drive.sh` | Ubuntu portable USB package (same folder; does not replace Windows files) |

---

## Domain: YRC1000 JBI

**Shape (lossless):** `/JOB` → headers (`//NAME` …) → `//POS` groups → `//INST` → instructions. Newline always `\r\n` + trailing newline. Preserve `raw` on headers, pos vars, inst lines.

**POS groups:** `///POSTYPE` PULSE|USER|BASE|…; `///USER` / `///TOOL`; vars `C`/`BC`/`EC`/`P`/`BP`/`EX`.  
**`///NPOS` order:** `C,BC,EC,P,BP,EX` counts (`serialize.ts` `formatNpos`).

**Pulse vs USER/BASE**

- Production jobs often `///POSTYPE PULSE`.
- **Transfer / frame move:** FK each pulse pose in **source** UF → emit same relative XYZ/RPY as `///POSTYPE USER` + `///USER <target>`. Instructions untouched. **No IK in v1** (controller resolves joints).
- **Transfer** = identical fixtures (geometry relative to fixture unchanged; only frame id).
- **Frame convert (Flip)** = remaps **cartesian** poses between two BUSER frames: `inv(UF_new) @ UF_old @ P_old`, optional tool Z 180° (default ON). Updates `///USER` to target. **Not** Transfer. Integer PULSE rows skipped/rejected — use Transfer FK or teach USER first. UF from profile `UFRAME.CND` (`read_uframe`) with editable override.
- **Mirror** / **Single-side mirror** = reflection across plane in the **same** `///USER` (same station for single-side). Keep source `RCONF`, flag pendant review. Prefer cartesian USER/BASE; PULSE→FK→USER then mirror. Optional advanced pulse-axis sign knobs are approximate until cell-calibrated.
- **Offset (shift)** = XYZ mm added in current USER/BASE frame; RPY deg applied as **fixed-frame** rotation (`R' = R_delta @ R`). PULSE jobs: FK→USER in source frame, then offset, emit USER. Verified with `USER_CART_S1_OFF_X100.JBI` (+100 mm X).

**Speed rules** (`edit.ts`)

| Token | Allowed on |
| --- | --- |
| `VJ=` | `MOVJ` only |
| `V=` | `MOVL` / `MOVC` / `SMOVL` only |
| Dual `V=`+`VJ=` | Illegal — `sanitizeSpeedModifiers` strips |

Weld path: indices strictly between `ARCON`…`ARCOF` (nested depth) for weld-speed targeting.

**Safety (non-negotiable)**

1. Never write source/backup in place.
2. Writes → output folder only (`YaskawaJobEditor_Output` beside source by default).
3. Diff before treating edit as write-ready; Diff dry-run available.
4. Calibration gate for transforms + Diff/Wizard writes (Library browse OK without).
5. USB export from **output** only → e.g. `YaskawaJobs/` on remediable media.

---

## Calibration (home → ± safe limits)

**Design (operator-confirmed):**

1. **Home is the anchor** — every joint range starts from the known safe home pose.
2. **Full *safe* range per joint** (not mechanical max): from home, jog each axis to farthest safe **positive** and **negative** in the cell; record each as one taught position (prefer **MOVL**; MOVJ OK if needed). Labels: `S+`, `S-`, … `T+`, `T-`.
3. **CAL jobs:** `CAL_<robotId>_STANDARD.JBI` + `CAL_<robotId>_RELATIVE.JBI` — one PAUSE / one position per checklist step (home, UF RORG/RXX/RXY, then 12 joint-limit steps, optional extra). Each pause block embeds `' CALSTEP:<stepId>` plus `STEP_*` pause tags so taught jobs can be re-imported.
4. **Upload / extract (preferred after pendant teach):** Guided (and Manual) → **Load STANDARD** / **Load RELATIVE** → **Extract into session**. STANDARD fills pulses; RELATIVE fills XYZ RxRyRz (+ USER/BASE). Summary table shows filled vs missing; manual paste remains for gaps. Never writes into the source backup.
5. **Workspace-limited mode** (default ON): still allows **Skip** if one direction is unclear; *goal* is both sides when safe.
6. **`calibrate.py`:** up-weights joint-limit pairs; seeds `pulse_per_degree` from home→±limit Δpulses/Δdegrees before least_squares.
7. **TODO when cartesian production jobs arrive:** re-validate **mirror** and **offset/shift** against real USER/BASE jobs (synthetic fixtures are interim). Leave conversion-pair import stubbed until cell data exists.

| Piece | Path |
| --- | --- |
| Step defs (home, UF, S+/S−…) | `packages/core/src/calibration/steps.ts` |
| JBI + README generators | `packages/core/src/calibration/jobGenerator.ts` |
| Upload / extract from taught JBIs | `packages/core/src/calibration/extract.ts`, `apps/desktop/src/features/calibration/UploadCalJobs.tsx` |
| Wizard UI | `apps/desktop/src/features/calibration/wizard.tsx` |
| Fit / residuals | `kinematics/calibrate.py` |
| Gate storage | `apps/desktop/src/features/calibration/storage.ts` |
| Mini extract fixtures | `fixtures/calibration/CAL_MINI_*.JBI` + `npm run test:calib-extract` |

---

## Robot profiles & setup

**Required backup files:** `SYSTEM.SYS`, `RC.PRM`, `TOOL.CND`, `UFRAME.CND`  
**Recommended:** `RE.PRM`, `SV.PRM`, `ARCSRT.CND`, `ARCEND.CND`, `WEAV.CND`

**Flow**

1. **ProfileGate** every session (`sessionStorage` confirm) — select/create profile.
2. **Setup Guide** forced until minimum: robotInstall, sourceFolder, outputFolder, cndFiles, safety. Calibration may **Skip for now**.
3. `isProfileSetupFinished` → skip forced setup → land **Loaded Jobs**.
4. Header **Robot:** dropdown switches active profile; folders restore per profile.

**Auto output:** `<parent of source>\YaskawaJobEditor_Output` (`OUTPUT_FOLDER_BASENAME`).

**Online (optional)**

| Path | Status |
| --- | --- |
| YMConnect ConvertPosition | Soft dep; prefs + bridge stub; **untested on cell** |
| MotoROS2 | Setup prefs/checklist only; **no ROS client**; does not block install |

### Storage keys (exact)

| Key | Where | Notes |
| --- | --- | --- |
| `yaskawa.session.profileConfirmed.v1` | **sessionStorage** | ProfileGate confirmed this tab |
| `yaskawa.robot.profiles.v1` | localStorage | Profiles + `activeProfileId` |
| `yaskawa.folders.v1` | localStorage | Per-profile source/output |
| `yaskawa.setup.v1` | localStorage | Setup progress **version 3** |
| `yaskawa.calibration.v1` | localStorage | Legacy / mirror of active |
| `yaskawa.calibration.v1.<profileId>` | localStorage | Per-profile applied fit + `gated` |
| `yaskawa.calibration.session.v1` | localStorage | Guided capture session |
| `yaskawa.ymconnect.v1` | localStorage | Per-profile host/controlGroup |
| `yaskawa.motoros2.v1` | localStorage | Per-profile agent prefs |
| `yaskawa.pulseMirror.v1.<profileId>` | localStorage | Advanced pulse-axis mirror signs (default identity) |

Disk mirror: `<output>/profiles/robot_profiles.json` (`ROBOT_PROFILES_FILENAME`).

**Calibration gate:** active profile + stored record with `gated: true` when `worstMm ≤ thresholdMm` (default **1.0**). Else transforms + edit writes blocked (`getCalibrationGate` / `getEditWriteGate`).

---

## Sidecar JSON protocol

**SoT:** [`packages/core/src/kin/protocol.ts`](packages/core/src/kin/protocol.ts) — `KIN_PROTOCOL_VERSION = "1.0.0"`. Keep in sync with `kinematics/server.py`.

**Transport:** one camelCase JSON object per stdin line → one response line. Tauri `kin_request` in [`apps/desktop/src/lib/kin/client.ts`](apps/desktop/src/lib/kin/client.ts), which re-exports the core protocol types so existing call sites keep importing from one place.

| Method | Role |
| --- | --- |
| `ping` | Health / protocol string |
| `forward_kinematics` | Pulses → pose (tool/UF/calib optional) |
| `calibrate` | Pulse↔cartesian pairs → params + residuals |
| `transform_frame` | Pulse rows source UF → poses in target UF |
| `transform_mirror` | Cartesian poses × plane XY\|XZ\|YZ |
| `transform_offset` | Poses + delta (XYZ frame add; RPY fixed-frame) |
| `transform_frame_flip` | Cartesian poses × UF BUSER convert (+ optional tool Z 180°) |
| `read_uframe` / `read_tool` | Parse CND paths |
| `scan_backup` | Required/recommended file presence |
| `create_profile_from_backup` | Build profile from backup folder |
| `load_profile` / `get_profile` | Sidecar active profile state |

**Units:** pose `x,y,z` mm; `rx,ry,rz` deg. Pulses length-6 **S,L,U,R,B,T**.

YMConnect is **not** this protocol — `ymconnect_convert_position` / `apps/desktop/src/lib/kin/ymconnect.ts`.

---

## UI routes & labels

**Sidebar (order):** Job Editing Wizard · Loaded Jobs · Manual Editor · Calibration · Transform · Diff  

**Not in sidebar:** Setup Guide (header / StatusBar / first-run / incomplete gate only).

| Page id | UI label | Notes |
| --- | --- | --- |
| `wizard` | Job Editing Wizard | Intents: rename, duplicate, frameMove, mirror/offset→Transform, speed, weld, findReplace, manual. Writes need edit-write gate |
| `library` | Loaded Jobs | Dbl-click → choose Wizard or Manual Editor |
| `editor` | Manual Editor | Full line/speed/weld/CND tooling |
| `calibration` | Calibration | Manual + Guided; export `CAL_<id>_STANDARD/RELATIVE.JBI` |
| `transform` | Transform | Modes: **Transfer** \| **Frame convert (Flip)** \| **Mirror** \| **Single-side mirror** \| **Offset** + flip assist; after Preview → rename optional → **Write to output folder** (gate + `writeOutputFile`) |
| `diff` | Diff | Preview / dry-run / write / USB |
| `setup` | Setup Guide | Forced until min complete |

Wizard mirror/offset intents navigate to Transform (geometry lives there).

---

## Where to change X

| Want | Touch |
| --- | --- |
| Rename nav label | `Sidebar.tsx` `NAV_ITEMS` |
| Add sidebar page | `AppPage` + `Sidebar` + `App.tsx` render |
| Forced setup steps | `lib/setup/progress.ts` `SETUP_STEP_ORDER` / `MINIMUM_SETUP_STEPS` + `features/setup` |
| Add transform mode | `features/transform` mode union + UI; kin method if new math; maybe wizard intent |
| Calibration steps / CAL jobs | `packages/core/src/calibration/steps.ts`, `jobGenerator.ts`, `extract.ts`, `apps/desktop/src/features/calibration/wizard.tsx`, `UploadCalJobs.tsx` |
| Gate threshold / logic | `apps/desktop/src/features/calibration/storage.ts` |
| Fix serializer / roundtrip | `parse.ts` / `serialize.ts` — then `test:roundtrip` |
| Speed / weld rules | `lib/jbi/edit.ts` (+ `test:edit`) |
| Frame-move / offset emission | `lib/jbi/frameTransform.ts` + `kinematics/transform.py` |
| Add Tauri command | `apps/desktop/src-tauri/src/*.rs` + `lib.rs` handler + `lib/fs` or kin wrapper |
| Change FK / DH | `kinematics/ar2010.py`, `robot_model.py` — `test:kin` |
| Profile required files | `lib/robot/profile.ts` `PROFILE_REQUIRED_FILES` + `robot_profile.py` |
| Theme tokens | `apps/desktop/src/index.css` (`--app-*`, `@theme`) |
| Dev port | `apps/desktop/vite.config.ts` |
| Stop behavior | `stop.bat` (**verify if PR in flight**) |

---

## Invariants / do-not-break

1. **Byte-identical roundtrip** of fixtures + DYNAMIC1 (~305) after parse/serialize changes (local backup).
2. **No** `MOVL … V= … VJ=…` (or V on MOVJ / VJ on linear) — sanitize + tests.
3. **Calibration gate** before transforms and Diff/Wizard/**Transform** writes; Library read-only browse OK.
4. **Output-only** FS writes; source folder never destination. Transform Save uses the same `writeOutputFile` path as Diff/Wizard.
5. **Preserve `raw`** fields for lossless serialize unless intentionally rewriting.
6. **Motoman theme tokens** in `index.css` — prefer `bg-bg`, `text-accent`, `btn-primary`, etc. over ad-hoc zinc/amber.
7. **Kin protocol 1.0.0** camelCase — TS ↔ Python stay aligned.
8. **NPOS order** `C,BC,EC,P,BP,EX`.
9. TS style: no semicolons; `handle*` event handlers; Tailwind for UI.
10. Do not edit Cursor plan file unless asked.
11. **Never commit** `Yaskawa Jobs/`, `Manuals/`, `*.pdf`, CMOS/bin backups, or plant calibration session JSON.

---

## Known gaps / future

| Gap | Notes |
| --- | --- |
| YMConnect live ConvertPosition | Stub builds without SDK; needs NuGet/DLL + Ethernet cell test |
| MotoROS2 live topics | Prefs/checklist only; no subscribed ROS 2 client |
| Non–S-L-U-R-B-T DH | v1 Motoman 6-axis only |
| Bulk pulse→relative import | **Disabled stub** in Calibration Guided wizard until real cell pairs |
| Auto CALL rewiring on station change | Partial / manual rename-refs |
| Joint-limit checks | Cartesian reach heuristic only |
| Wizard ↔ Transform | Mirror/offset intents redirect; keep UX consistent if both edit |
| **Real cartesian backups** | Prefer USER/BASE jobs for mirror/single-side/**offset**; synthetic fixtures in `fixtures/transform/` until cell uploads — **TODO: re-validate mirror/shift when cartesian production jobs arrive** |
| Pulse-axis mirror knobs | Advanced/approximate; defaults identity until cell-calibrated — not ground truth |
| Live Guided ±limit sessions | UI/generators ready; needs cell operator capture |

**Suggested next work:** run Guided calibration with home→±limits on cell; upload taught CAL STANDARD/RELATIVE and confirm extract; link YMConnect SDK + golden ConvertPosition set; re-validate mirror/offset on real USER jobs; optional ROS 2 `joint_states` snapshot helper; enable conversion-pair import when data exists.

---

## Pitfalls

- Editing `serialize` formatting → mass roundtrip FAIL + `*.roundtrip-fail` artifacts.
- Skipping `raw` preservation when mutating headers/inst lines.
- Assuming calibration optional for writes — Setup can finish; **writes stay locked**.
- Writing paths outside output — Rust rejects / wrong folder.
- Treating YMConnect as required — soft dep; offline FK is primary.
- Hardcoding AR2010 in UI — use **active robot profile**.
- Dual speed tokens from pendant jobs — sanitize before rewrite.
- `sessionStorage` profile confirm ≠ setup finished; both gates exist.
- Committing parent `Yaskawa Jobs/` or `Manuals/` — blocked by `.gitignore`; double-check `git status`.
- Parallel edits to transform/wizard/speeds/`stop.bat` — re-read before merge.

---

## Verification checklist for agents

After changes, run the smallest sufficient set:

| Changed area | Run |
| --- | --- |
| `parse` / `serialize` / model | `npm run test:roundtrip` **required** (needs local DYNAMIC1) |
| `edit.ts` / speeds / weld | `npm run test:edit` |
| `kinematics/*.py` / protocol | `npm run test:kin`; if frame math → `test:regression` |
| `frameTransform` / transform fixtures | `npm run test:transform` (+ `test:kin` for Python fixture asserts) |
| TS types / UI props | `npx tsc --noEmit` |
| Broad / release confidence | roundtrip + edit + kin + transform + manual `start.bat` smoke |

**Re-read before trusting this handoff if stale:**

- Nav: `Sidebar.tsx`
- Keys: `profile.ts`, `folders.ts`, `progress.ts`, `calibration/storage.ts`, `App.tsx` session key
- Transform modes: `features/transform/index.tsx`
- Calibration steps: `packages/core/src/calibration/steps.ts` (home + S+/S− …)
- Protocol methods: `lib/kin/client.ts` ↔ `server.py` header
- Launchers: `start.bat`, `stop.bat`, portable `Run.bat` / `Yaskawa Job Editor.sh`
- Gates: `getCalibrationGate`, `shouldForceSetup`, `isProfileSetupFinished`

---

## Status snapshot (2026-08-22)

**Done:** Tauri scaffold; lossless JBI; library; Manual Editor + edit tests; Wizard; Diff/USB; multi-profile + ProfileGate + forced Setup; calibration UI + gate with **home-anchored ± safe joint limits** (CAL STANDARD/RELATIVE); Transform transfer/**Frame convert (Flip)**/mirror/**single-side mirror**/offset (+100 X fixture) + flip assist + **save previewed `.JBI` to output folder**; `fixtures/transform/`; kin sidecar FK/calib/transform/frame_flip/profile; YMConnect stub; MotoROS2 setup prefs; `start.bat`/`stop.bat`; **portable USB Windows + Ubuntu in the same folder** (`Run.bat` / `Yaskawa Job Editor.sh`); GitHub repo `icors2/Yaskawa-Job-Helper`.

**Not done:** live YMConnect cell; MotoROS2 ingest; bulk conversion import; full CALL auto-rewire; non-6-axis DH; calibrated pulse-axis mirror signs; **re-validate mirror/shift/Flip on real cartesian production jobs** (TODO).

*If transform/wizard/speeds/`stop.bat` disagree with this file → verify mid-flight PR and update this handoff.*
