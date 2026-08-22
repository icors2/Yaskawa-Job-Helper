# YMConnect bridge (ConvertPosition)

Soft dependency for online pulse ↔ cartesian conversion via
[`YMConnect::KinematicsInterface::ConvertPosition`](https://developer.motoman.com/en/YMConnect/KinematicsInterface).

## Status

| Piece | State |
| --- | --- |
| Tauri commands `ymconnect_bridge_status` / `ymconnect_convert_position` | Implemented |
| TypeScript `convertPositionPulseToCartesian` / `convertPositionCartesianToPulse` | Implemented |
| This C# helper stub | Builds without SDK; returns structured “unavailable” |
| Live ConvertPosition against a cell | **Needs YMConnect SDK + YRC1000 Ethernet — untested** |

Offline pendant transcription and SciPy FK remain the default calibration path.

## Requirements (for live use)

- Controller: **YRC1000 or newer** (Motion + Kinematics interfaces)
- [YMConnect releases](https://github.com/Yaskawa-Global/YMConnect/releases) (Apache 2.0)
- Quick start: [developer.motoman.com/en/YMConnect](https://developer.motoman.com/en/YMConnect)
- Ethernet to the controller; connection IP stored per robot profile in the app

## Build stub (no SDK)

```bat
cd ymconnect\YmConnectBridge
dotnet build -c Release
```

Point the app at the exe with env `YMCONNECT_BRIDGE`, or place `YmConnectBridge.exe` next to the Tauri binary / under `ymconnect/`.

## Enable real ConvertPosition

1. Install YMConnect from GitHub releases.
2. Add a reference to the YMConnect .NET assembly in `YmConnectBridge.csproj`.
3. In `Program.cs`, set `SdkLinked = true` and call:
   - `OpenConnection(host)`
   - `Kinematics.ConvertPosition(..., PulseToCartesianPos, ...)`
   - `Kinematics.ConvertPositionFromCartesian(..., CartesianPosToPulse, Figure, ...)`
4. Rebuild Release and restart the Job Editor.

## JSON contract (`--convert`)

Request:

```json
{
  "host": "192.168.1.31",
  "controlGroup": "R1",
  "direction": "pulseToCartesian",
  "pulses": [0, 0, 0, 0, 0, 0],
  "toolNumber": 0
}
```

or `direction: "cartesianToPulse"` with `pose: { x,y,z,rx,ry,rz }`.

Success response: `{ "ok": true, "direction": "...", "pose"?: {...}, "pulses"?: [...] }`  
Unavailable: `{ "ok": false, "unavailable": true, "reason": "...", "docs": {...} }`
