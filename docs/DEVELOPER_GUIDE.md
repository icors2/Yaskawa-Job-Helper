# Developer guide

Windows desktop app for lossless YRC1000 `.JBI` editing (Tauri + React/Tailwind + Python kinematics sidecar).

**Agents:** read [`../AGENT_HANDOFF.md`](../AGENT_HANDOFF.md) first for architecture, file map, gates, and where-to-change (token-efficient). This guide is the human install/runbook. Motoman portal research: [`MOTOMAN_DEVELOPER_FINDINGS.md`](./MOTOMAN_DEVELOPER_FINDINGS.md).

## Prerequisites

| Tool | Notes |
| --- | --- |
| **Node.js** | Project developed with Node 24; `npm` on PATH |
| **Rust / cargo** | Required for Tauri (`npm run dev` / `npm run build`) |
| **Python 3.14** | Sidecar and kinematics tests (`python` on PATH) |
| **numpy / scipy** | `pip install -r kinematics/requirements.txt` (also pulls `pytest`) |

Optional: [PyInstaller](https://pyinstaller.org/) for `npm run kin:bundle`.

## Install

```bat
cd yaskawa-job-editor
npm install
pip install -r kinematics\requirements.txt
```

Confirm:

```bat
node -v
cargo -V
python --version
```

## Start the app

**Quick start (Windows):** double-click `start.bat` in this folder, or `Start Yaskawa Job Editor.bat` in the parent workspace. It checks Node/npm, warns if Python is missing, runs `npm install` only when `node_modules` is absent (or if you pass `--install`), **frees TCP 1420 if a leftover Vite process still holds it**, then starts `npm run dev` and writes the root process id to `.dev.pids`. Keep the console open while the app runs.

**Stop (Windows):** double-click `stop.bat` in this folder, or `Stop Yaskawa Job Editor.bat` in the parent workspace. It kills the process tree from `.dev.pids` when present, **kills whatever is listening on TCP 1420** (`scripts/free-port.ps1`), then falls back to stopping node/vite/tauri/cargo processes whose command line includes this app path (`scripts/stop-project-procs.ps1`). After stop, `start.bat` should succeed without “Port 1420 is already in use”.

**Clean restart:** run `stop.bat`, confirm it reports port 1420 is free, then run `start.bat`.

Full desktop shell (Vite + Tauri + sidecar spawn):

```bat
npm run dev
```

Frontend-only (no native FS / sidecar):

```bat
npm run dev:vite
```

Production build:

```bat
npm run build
```

## First-run: robot profile + forced setup

On every app session a **blocking “Choose robot profile”** screen appears before main chrome.

1. Select an existing profile, or create one from a pendant backup (required files below).
2. If that profile’s **minimum setup is already finished** (and folders are known for it), the gate shows **Enter app** and opens **Loaded Jobs** — Setup Guide is not forced again.
3. Only **new / incomplete** profiles show **Continue setup** and enter the **Setup Guide**, which cannot be left until **minimum** steps are done:
   - Robot profile active
   - Source jobs folder
   - Output folder (auto-created — see convention)
   - UFRAME/TOOL CND loaded (or marked)
   - Safety acknowledgements
4. **Calibration** may be **skipped for now** during setup. Banner: *Setup can continue; editing unlocks after calibration.* **Loaded Jobs** browse stays read-only; **Diff / Job Editing Wizard writes and transforms stay locked** until calibration is applied for the **active** profile. Finish with **Save** / **Finish setup** → **Loaded Jobs**.

**Active job:** selecting a job in Loaded Jobs (or opening it in the Wizard / Manual Editor) sets a shared active job used by **Transform** (Transfer / Mirror / Single-side mirror / Offset), so you do not need to re-type the path.

### Required controller files (profile create)

| File | Purpose |
| --- | --- |
| `SYSTEM.SYS` | Robot name/type, groups, application |
| `RC.PRM` | Link geometry (`///RC1G`) + pulse soft-limit seeds |
| `TOOL.CND` | TCP / tools |
| `UFRAME.CND` | User frames (file required even if sparse) |

**Recommended:** `RE.PRM`, `SV.PRM`, sample `.JBI`, weld CND files.

### Pendant backup language (shop floor)

1. On the pendant, raise security as needed for backup.  
2. Save / EX. MEMORY backup to CF, SD, or USB.  
3. Include at least the four required files (full backup with JOB folders preferred).  
4. Copy that media to the PC.  
5. In the app, choose the backup folder — **never edit jobs on the stick in place**.

### Folder convention

When a **source** jobs folder is chosen, the app creates (if missing) and selects:

```text
<sourceParent>\YaskawaJobEditor_Output
```

Persisted per profile in `localStorage` `yaskawa.folders.v1`. All edited `.JBI`, calibration exports, and profile mirrors write there. **USB Export** copies from the output folder onto removable media (e.g. `YaskawaJobs/`) — never into the source backup.

### Multi-robot profiles

- Create **one profile per robot** from that robot’s backup.
- Switch robots via the header **Robot:** dropdown (or “Choose robot at startup…”).
- Calibration is **per profile** (`yaskawa.calibration.v1.<profileId>`).
- Geometry / job writes gated until **that** robot’s calibration passes.

### Online paths (optional)

| Path | Role in this app |
| --- | --- |
| **YMConnect** `ConvertPosition` | Primary PC-side pulse↔cartesian validation. Soft dependency: `ymconnect/YmConnectBridge` + SDK. Connection IP stored per profile. **Untested on cell** until SDK linked. YRC1000+. |
| **MotoROS2** | Optional setup/diagnostics assist only. ROS 2 node **on the controller** via MotoPlus + micro-ROS Agent. Prefs + checklist in Setup — **does not block** install. See [`MOTOROS2.md`](./MOTOROS2.md). |

### v1 kinematics limitation

Offline FK assumes a **6-axis Motoman S-L-U-R-B-T** DH layout with lengths from `RC.PRM`. AR2010 is the best-validated template. Pulse scales **must be cell-calibrated per robot**.

## Kinematics sidecar alone

JSON-over-stdio, one request object per line, one response object per line:

```bat
npm run kin
```

Locked protocol version **`1.0.0`** (camelCase) is defined in:

- `src/lib/kin/client.ts` (`KIN_PROTOCOL_VERSION`)
- `kinematics/server.py`

Methods: `ping`, `forward_kinematics`, `calibrate`, `transform_frame`, `transform_mirror`, `transform_offset`, `read_uframe`, `read_tool`, `scan_backup`, `create_profile_from_backup`, `load_profile`, `get_profile`.

YMConnect ConvertPosition is a **separate** Tauri/bridge path (`ymconnect_convert_position`), not the Python sidecar.

## Tests

| Command | What it checks |
| --- | --- |
| `npm run test:roundtrip` | Byte-identical parse→serialize over `fixtures/` + `../Yaskawa Jobs/DYNAMIC1` (~305 `.JBI`) — **gate on parser/serialize changes** |
| `npm run test:edit` | Instruction insert/delete/reorder, speed scale/set, weld CND validation helpers |
| `npm run test:kin` | Python FK / calibration / **robot profile** / transform fixture unit tests |
| `npm run test:transform` | USER cartesian transfer + YZ / single-side fixture asserts (`fixtures/transform/`) |
| `npm run test:regression` | S1→S2 frame-move vs hand-taught job pairs |

Also useful: `npx tsc --noEmit` for TypeScript.

## Folder layout

```text
yaskawa-job-editor/
  start.bat / stop.bat   Windows launchers (PID file `.dev.pids`)
  src/
    features/          setup, wizard, library, editor, calibration (+ guided), transform, diff
    lib/jbi/           parse, serialize, library, edit, cnd, diff, frameTransform
    lib/calibration/   STANDARD+RELATIVE JBI generators, dynamic steps, session helpers
    lib/robot/         multi-profile store + install gate
    lib/setup/         Setup Guide progress (localStorage)
    lib/kin/client.ts  sidecar protocol (locked)
    lib/fs/desktop.ts  Tauri FS + folder pickers + USB export
  src-tauri/           Rust shell (source read-only, output writes, USB, YMConnect bridge)
  ymconnect/           C# ConvertPosition bridge stub (soft dependency)
  kinematics/          Python FK, robot_profile, calibrate, transform, CND readers, stdio server
  fixtures/            small .JBI + UFRAME/TOOL samples for local tests
  scripts/             roundtrip.ts, edit-test.ts
  docs/                this guide + Motoman findings + MOTOROS2.md
../Start Yaskawa Job Editor.bat / Stop Yaskawa Job Editor.bat
../Yaskawa Jobs/DYNAMIC1/   controller backup (~300 jobs + *.CND / RC.PRM)
../Manuals/                 INFORM / cell manuals (reference only)
```

## UI theme

Motoman/Yaskawa–inspired industrial dark theme (CSS variables in `src/index.css`). Tokens: `--app-bg`, `--app-surface`, `--app-accent` (industrial red `#c8102e`), neutrals, success/warn/danger. Live motoman.com uses Yaskawa Blue (`#0056ba`) / navy (`#002e5e`) on white — those are available as `--app-brand-blue` / `--app-brand-navy` for secondary cues. Prefer theme utilities (`bg-bg`, `text-accent`, `btn-primary`, `btn-secondary`, `input-field`) over hard-coded zinc/amber. Typography: IBM Plex Sans / Mono.

## Safety model

Non-negotiable for robot programs:

1. **Source folder is read-only** — never write in-place over backup/USB jobs.
2. **Writes only to a chosen output folder** (auto `YaskawaJobEditor_Output` or override).
3. **Mandatory unified diff preview** before treating an edit as ready to write.
4. **Dry-run** mode on Diff page produces report without writing.
5. **Robot profile gate** — geometry ops require an active profile built from controller files.
6. **Calibration gate** — position-rewriting transforms **and Diff/Wizard job writes** refuse to run when stored residuals for the **active** profile are missing or exceed the threshold (default 1.0 mm). Setup may continue while this gate is closed.
7. **USB export** copies from the **output** folder only.

Library text browse remains available without calibration.

## Key concepts

### Lossless `.JBI` roundtrip

Jobs are pure ASCII, CRLF, trailing newline. The TypeScript parser keeps `raw` strings for headers, position vars, and instruction lines so serialize can be **byte-identical**. Always run `npm run test:roundtrip` after touching `parse.ts` / `serialize.ts` / anything that rewrites structure.

### Robot profile

Built from controller backup:

| File | Role |
| --- | --- |
| `SYSTEM.SYS` | Robot name/type (e.g. `R1 : …*(AR2010)`), groups, application |
| `RC.PRM` | Link geometry (`///RC1G` microns) + pulse soft-limit seeds |
| `TOOL.CND` | TCP |
| `UFRAME.CND` | User frames (may be empty/minimal; file still required) |

AR2010 matching RC.PRM lengths is marked `template_validated`. Other Motoman models get `unvalidated` until cell-calibrated. Calibration jobs export as `CAL_<robotId>_STANDARD.JBI` / `CAL_<robotId>_RELATIVE.JBI`.

### PULSE → USER frame move

Most production jobs store `///POSTYPE PULSE`. A frame move:

1. FK each robot pulse pose into the **source** user frame (active profile + `UFRAME.CND` / `TOOL.CND`).
2. Emit the same relative XYZ/RPY as `///POSTYPE USER` with `///USER <target>`.
3. Instruction lines are left alone; station `CALL` retargeting is a separate rename/reference pass.

No inverse kinematics in v1 — the controller resolves joints at playback. **Transfer to new userframe** (identical fixtures) is the first-class frame-move path — USER cartesian jobs relabel `///USER` in place; PULSE jobs use FK→USER. **Mirror** reflects across stations (mirrored fixtures). **Single-side mirror** reflects in the **same** `///USER` on one station (Left/Right demo images); prefer cartesian USER/BASE, with optional approximate pulse-axis sign knobs only after cell calibration. Mirror/offset/single-side keep source frame id on output and flag RCONF for pendant review. Synthetic before/after jobs: `fixtures/transform/` (see README there).

### Core editing (Manual Editor)

- Rename `//NAME`, duplicate, `///FOLDERNAME`, CALL/PSTART rewrite, find/replace
- Instruction **insert / delete / reorder** (checkbox selection; orphans in `//POS` are reported, not auto-deleted)
- **Speed** `V=` / `VJ=` set or scale with motion-type filtering and weld/travel scope (empty selection = all matching lines in scope)
  - `VJ=` only on **MOVJ**; `V=` only on **MOVL** / **MOVC** / **SMOVL** (never emit both on one line)
  - **Weld speed** scope edits `V=` on motion lines between `ARCON` and `ARCOF` only
- **Weld** `ASF#` / `AEF#` / `WEV#` with optional inventory from `ARCSRT.CND` / `ARCEND.CND` / `WEAV.CND` (Load CND after opening a source folder)

### Setup Guide & navigation

- **Setup Guide** is not a permanent sidebar item — reached via first-run / incomplete-setup gate, header **Setup Guide**, or status-bar link.
- Forced minimum install → folders → CND → calibration (skippable) → safety. Explicit **Save** / **Finish setup** persist prefs and land on **Loaded Jobs** (not Manual Editor). Progress: `yaskawa.setup.v1` (v3).
- Optional panels (collapsed by default): **Online (YMConnect)** + **Optional: MotoROS2** (see [`MOTOROS2.md`](./MOTOROS2.md)).
- Sidebar labels: **Job Editing Wizard**, **Loaded Jobs**, **Manual Editor**, **Calibration**, **Transform**, **Diff**.
- **Transform** — **Transfer** (identical fixtures), **Mirror** (mirrored fixtures), **Single-side mirror** (same `///USER` / same station; Left→`flip-assist-left.png`, Right→`flip-assist-right.png`; default plane YZ), and **Offset**. Shared **active job** context with Wizard / Loaded Jobs / Manual Editor. Dual-station Flip assist stays for Transfer/Mirror/Offset; single-side uses the matching station PNG with before→after overlays on the XYZ origin. Preview/diff boxes are large (`min-h` ~20–28rem) for readability.
- **Job Editing Wizard** — writes require calibration gate open; geometry intents need active profile + calibration. Mirror/Offset intents hand the selected job to Transform.
- **Loaded Jobs** — double-click a job → choose Wizard or Manual Editor.

### Calibration test (robot-assisted)

Default: offline pendant transcription. Optional: **Capture via YMConnect** when the bridge + SDK are available (still untested on cell). Motion is operator-responsibility; exported jobs are PAUSE-heavy.

1. Set **Output folder** and confirm **active robot**.
2. Open **Calibration** → **Guided** — export `CAL_<robotId>_STANDARD.JBI` + `CAL_<robotId>_RELATIVE.JBI`.
3. Home is the anchor. Phase A PULSE → Phase B BASE/USER at the same poses, including per-axis **S+/S− … T+/T−** farthest *safe* limits from home (skip a side only if unclear). Prefer one MOVL per step.
4. Fit → Apply (stored per profile). When real cartesian production jobs arrive later, re-validate mirror/shift.

### YMConnect bridge (soft dependency)

See [`../ymconnect/README.md`](../ymconnect/README.md). Install SDK from [GitHub releases](https://github.com/Yaskawa-Global/YMConnect/releases); docs: [developer.motoman.com/en/YMConnect](https://developer.motoman.com/en/YMConnect). Set `YMCONNECT_BRIDGE` or place `YmConnectBridge.exe` where Tauri can find it.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Blocking profile screen every launch | Expected — select robot; **Enter app** if setup complete, else **Continue setup** |
| Port 1420 already in use | Run `stop.bat` (kills listeners on 1420); `start.bat` also clears stale listeners |
| Forced setup cannot leave | Finish source, output, CND, safety (calibration may be skipped) |
| Job writes / USB export locked | Calibration gate closed for active robot — Guided wizard → Apply |
| Geometry locked / “Complete robot install” | No active profile |
| `sidecar: offline` | Python/deps/Tauri spawn — `npm run kin`, `pip install -r kinematics/requirements.txt` |
| Roundtrip FAIL + `*.roundtrip-fail` | Serialize changed formatting — restore `raw` preservation |
| YMConnect unavailable | Build/link `ymconnect/YmConnectBridge` or set `YMCONNECT_BRIDGE` |
| Guided export fails | Output folder not set |
| Write fails / nothing on disk | Set **Output folder**; leave Dry-run unchecked on Diff |

## Related docs

- [`../AGENT_HANDOFF.md`](../AGENT_HANDOFF.md) — agent briefing: architecture, file map, gates, where-to-change
- [`MOTOMAN_DEVELOPER_FINDINGS.md`](./MOTOMAN_DEVELOPER_FINDINGS.md) — portal / YMConnect / INFORM research
- [`MOTOROS2.md`](./MOTOROS2.md) — MotoROS2 adopt vs ignore for this app
- [`../kinematics/RC_PRM_FINDINGS.txt`](../kinematics/RC_PRM_FINDINGS.txt) — RC.PRM geometry hypothesis (holds for AR2010)
- [`../kinematics/EXTERNAL_REFS.md`](../kinematics/EXTERNAL_REFS.md) — URDF lengths, pulse seeds, YMConnect links
