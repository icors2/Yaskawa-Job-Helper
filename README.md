# Yaskawa Job Helper

Desktop app for YRC1000 `.JBI` jobs (Windows portable USB, Ubuntu portable USB). Source folders are read-only; writes go only to a user-chosen output folder.

**Repository:** https://github.com/icors2/Yaskawa-Job-Helper

Requires Python 3.14, Node 24, and Rust (cargo) on the PATH.

## Documentation

- **[Developer guide](docs/DEVELOPER_GUIDE.md)** — install, run, tests, safety model, troubleshooting
- **[Agent handoff](AGENT_HANDOFF.md)** — architecture, status, conventions, and next work for coding agents
- **[Motoman developer findings](docs/MOTOMAN_DEVELOPER_FINDINGS.md)** — portal / YMConnect / INFORM research notes

## Run

**Windows:** double-click `start.bat` (or `Start Yaskawa Job Editor.bat` in the parent folder). First launch installs deps if needed; later launches skip straight to the app. Use `stop.bat` (or `Stop Yaskawa Job Editor.bat`) to stop tracked Vite/Tauri/node processes.

**Portable USB:** build once, then open one file on the target PC — `Run.bat` on Windows, `Yaskawa Job Editor.sh` on Ubuntu. Both OS builds write into the same `portable/YaskawaJobEditor/` folder. See the [Developer guide](docs/DEVELOPER_GUIDE.md#portable-usb-app-no-nodepython-on-the-target-pc).

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
