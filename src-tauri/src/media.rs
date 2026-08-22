use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetDriveTypeW(lp_root_path_name: *const u16) -> u32;
}

#[cfg(windows)]
const DRIVE_REMOVABLE: u32 = 2;
#[cfg(windows)]
const DRIVE_CDROM: u32 = 5;
#[cfg(windows)]
const DRIVE_FIXED: u32 = 3;
#[cfg(windows)]
const DRIVE_REMOTE: u32 = 4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovableDrive {
    pub path: String,
    pub drive_type: String,
    pub label: String,
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn drive_type_name(code: u32) -> &'static str {
    match code {
        DRIVE_REMOVABLE => "removable",
        DRIVE_FIXED => "fixed",
        DRIVE_REMOTE => "remote",
        DRIVE_CDROM => "cdrom",
        1 => "no_root",
        _ => "unknown",
    }
}

#[cfg(windows)]
fn windows_drive_type(root: &str) -> u32 {
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { GetDriveTypeW(wide.as_ptr()) }
}

/// Lists present drive roots. On Windows, prefers removable/CDROM; includes
/// type metadata so the UI can still show fixed drives if needed.
#[tauri::command]
pub fn list_removable_media() -> Result<Vec<String>, String> {
    let drives = list_removable_drives()?;
    Ok(drives
        .into_iter()
        .filter(|d| d.drive_type == "removable" || d.drive_type == "cdrom")
        .map(|d| d.path)
        .collect())
}

#[tauri::command]
pub fn list_removable_drives() -> Result<Vec<RemovableDrive>, String> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        if !Path::new(&path).exists() {
            continue;
        }
        #[cfg(windows)]
        {
            let code = windows_drive_type(&path);
            // Skip NO_ROOT_DIR
            if code == 1 {
                continue;
            }
            drives.push(RemovableDrive {
                path: path.clone(),
                drive_type: drive_type_name(code).to_string(),
                label: format!("Drive {}", letter as char),
            });
        }
        #[cfg(not(windows))]
        {
            drives.push(RemovableDrive {
                path: path.clone(),
                drive_type: "unknown".into(),
                label: path.clone(),
            });
        }
    }
    Ok(drives)
}

fn copy_path_recursive(src: &Path, dst: &Path) -> Result<(usize, u64), String> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    if src.is_file() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::copy(src, dst).map_err(|err| err.to_string())?;
        files += 1;
        bytes += fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        return Ok((files, bytes));
    }
    if !src.is_dir() {
        return Err(format!("Source does not exist: {}", path_to_string(src)));
    }
    fs::create_dir_all(dst).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(src).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let (f, b) = copy_path_recursive(&from, &to)?;
        files += f;
        bytes += b;
    }
    Ok((files, bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub destination: String,
    pub files_copied: usize,
    pub bytes_copied: u64,
}

/// Copy a file or folder from the output tree onto removable media.
/// Never writes into the source backup — caller must pass an output path.
#[tauri::command]
pub fn export_to_removable(
    source_path: String,
    usb_root: String,
    dest_subdir: String,
) -> Result<ExportResult, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err(format!("Export source not found: {source_path}"));
    }
    let usb = PathBuf::from(&usb_root);
    if !usb.is_dir() {
        return Err(format!("USB root is not a folder: {usb_root}"));
    }
    let sub = dest_subdir.trim().trim_matches(|c| c == '/' || c == '\\');
    if sub.is_empty() {
        return Err("Destination folder name is required".into());
    }
    if sub.contains("..") {
        return Err("Destination folder must not contain ..".into());
    }
    let dest_root = usb.join(sub);
    fs::create_dir_all(&dest_root).map_err(|err| err.to_string())?;

    let leaf = src
        .file_name()
        .ok_or_else(|| "Invalid export source name".to_string())?;
    let dest = dest_root.join(leaf);
    let (files_copied, bytes_copied) = copy_path_recursive(&src, &dest)?;
    Ok(ExportResult {
        destination: path_to_string(&dest),
        files_copied,
        bytes_copied,
    })
}

#[tauri::command]
pub fn ensure_directory(path: String) -> Result<String, String> {
    let resolved = PathBuf::from(&path);
    fs::create_dir_all(&resolved).map_err(|err| err.to_string())?;
    if !resolved.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }
    Ok(path_to_string(&resolved))
}
