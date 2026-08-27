//! Soft-dependency bridge for YMConnect ConvertPosition.
//!
//! Looks for an external helper executable (see `ymconnect/YmConnectBridge`).
//! When missing, returns a structured unavailable payload the UI can show
//! with install links — offline pendant calibration stays available.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub available: bool,
    pub bridge_path: Option<String>,
    pub message: String,
}

fn candidate_bridge_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(custom) = std::env::var("YMCONNECT_BRIDGE") {
        paths.push(PathBuf::from(custom));
    }
    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join("ymconnect").join("YmConnectBridge").join("bin").join("Release").join("net8.0").join("YmConnectBridge.exe"));
        paths.push(cwd.join("ymconnect").join("YmConnectBridge").join("bin").join("Debug").join("net8.0").join("YmConnectBridge.exe"));
        paths.push(cwd.join("ymconnect").join("YmConnectBridge.exe"));
        paths.push(cwd.join("YmConnectBridge.exe"));
    }
    // Relative to the Tauri app / resource dir when packaged
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("YmConnectBridge.exe"));
            paths.push(dir.join("ymconnect").join("YmConnectBridge.exe"));
        }
    }
    paths
}

fn find_bridge() -> Option<PathBuf> {
    candidate_bridge_paths().into_iter().find(|p| p.is_file())
}

#[tauri::command]
pub fn ymconnect_bridge_status() -> Result<BridgeStatus, String> {
    match find_bridge() {
        Some(path) => Ok(BridgeStatus {
            available: true,
            bridge_path: Some(path.to_string_lossy().into_owned()),
            message: "YMConnect bridge executable found.".into(),
        }),
        None => Ok(BridgeStatus {
            available: false,
            bridge_path: None,
            message: "YMConnect bridge not installed. Install the SDK from GitHub releases, build ymconnect/YmConnectBridge, or set YMCONNECT_BRIDGE to the helper path.".into(),
        }),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertPayload {
    pub host: String,
    pub control_group: Option<String>,
    pub direction: String,
    pub pulses: Option<Vec<f64>>,
    pub pose: Option<serde_json::Value>,
    pub tool_number: Option<i32>,
    pub user_frame_number: Option<i32>,
    pub figure: Option<Vec<i32>>,
}

#[tauri::command]
pub fn ymconnect_convert_position(payload: ConvertPayload) -> Result<serde_json::Value, String> {
    let Some(bridge) = find_bridge() else {
        return Ok(json!({
            "ok": false,
            "unavailable": true,
            "reason": "YMConnect bridge executable not found",
            "installHint": "Install YMConnect from https://github.com/Yaskawa-Global/YMConnect/releases , build ymconnect/YmConnectBridge, or set YMCONNECT_BRIDGE.",
            "docs": {
                "home": "https://developer.motoman.com/en/YMConnect",
                "kinematics": "https://developer.motoman.com/en/YMConnect/KinematicsInterface",
                "releases": "https://github.com/Yaskawa-Global/YMConnect/releases",
                "note": "Motion and Kinematics interfaces require YRC1000 or newer."
            }
        }));
    };

    let request = json!({
        "host": payload.host,
        "controlGroup": payload.control_group.unwrap_or_else(|| "R1".into()),
        "direction": payload.direction,
        "pulses": payload.pulses,
        "pose": payload.pose,
        "toolNumber": payload.tool_number.unwrap_or(0),
        "userFrameNumber": payload.user_frame_number.unwrap_or(0),
        "figure": payload.figure.unwrap_or_default(),
    });

    let output = Command::new(&bridge)
        .arg("--convert")
        .arg(request.to_string())
        .output()
        .map_err(|err| format!("Failed to launch YMConnect bridge: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Bridge may still emit JSON on failure
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            return Ok(value);
        }
        return Ok(json!({
            "ok": false,
            "unavailable": true,
            "reason": format!("Bridge exit {}: {} {}", output.status, stdout.trim(), stderr.trim()),
            "installHint": "Verify YMConnect DLLs are installed and the controller IP is reachable.",
            "docs": {
                "home": "https://developer.motoman.com/en/YMConnect",
                "kinematics": "https://developer.motoman.com/en/YMConnect/KinematicsInterface",
                "releases": "https://github.com/Yaskawa-Global/YMConnect/releases"
            }
        }));
    }

    serde_json::from_slice(&output.stdout).map_err(|err| {
        format!(
            "Bridge returned non-JSON: {err}; stdout={}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}
