# Yaskawa Job Editor

Windows desktop app for YRC1000 `.JBI` jobs. Source folders are read-only; writes go only to a user-chosen output folder.

Requires Python 3.14, Node 24, and Rust (cargo) on the PATH.

## Documentation

- **[Developer guide](docs/DEVELOPER_GUIDE.md)** — install, run, tests, safety model, troubleshooting
- **[Agent handoff](AGENT_HANDOFF.md)** — architecture, status, conventions, and next work for coding agents
- **[Motoman developer findings](docs/MOTOMAN_DEVELOPER_FINDINGS.md)** — portal / YMConnect / INFORM research notes

## Run

**Windows:** double-click `start.bat` (or `Start Yaskawa Job Editor.bat` in the parent folder). First launch installs deps if needed; later launches skip straight to the app. Use `stop.bat` (or `Stop Yaskawa Job Editor.bat`) to stop tracked Vite/Tauri/node processes.

```bat
cd yaskawa-job-editor
npm install
npm run dev
```

Frontend-only: `npm run dev:vite`

Kinematics sidecar (JSON-over-stdio, one object per line):

```bat
npm run kin
```

Type a request such as `{"id":"1","type":"ping"}` and press Enter.

## Tests

```bat
npm run test:roundtrip
npm run test:edit
npm run test:kin
npm run test:regression
```

## Protocol

Locked schema lives in `src/lib/kin/client.ts` and `kinematics/server.py` (v1.0.0, camelCase). Methods: `ping`, `forward_kinematics`, `calibrate`, `transform_frame`, `transform_mirror`, `transform_offset`, `read_uframe`, `read_tool`.
