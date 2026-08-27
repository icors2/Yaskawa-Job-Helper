use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(not(windows))]
use std::collections::BTreeSet;

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

#[cfg(windows)]
fn windows_list_drives() -> Result<Vec<RemovableDrive>, String> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        if !Path::new(&path).exists() {
            continue;
        }
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
    Ok(drives)
}

#[cfg(not(windows))]
fn unescape_mount(raw: &str) -> String {
    raw.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(not(windows))]
fn is_skipped_fs(fs: &str) -> bool {
    const SKIP: &[&str] = &[
        "proc",
        "sysfs",
        "devtmpfs",
        "devpts",
        "tmpfs",
        "cgroup",
        "cgroup2",
        "overlay",
        "squashfs",
        "autofs",
        "bpf",
        "tracefs",
        "debugfs",
        "securityfs",
        "pstore",
        "efivarfs",
        "fusectl",
        "mqueue",
        "hugetlbfs",
        "rpc_pipefs",
        "nsfs",
        "ramfs",
    ];
    SKIP.iter().any(|name| fs == *name || fs.starts_with(&format!("{name}.")))
}

#[cfg(not(windows))]
fn unix_drive_type(mount: &str, fs: &str) -> &'static str {
    if fs == "iso9660" || fs == "udf" {
        return "cdrom";
    }
    if mount.starts_with("/mnt/") && (fs == "9p" || fs == "drvfs" || fs == "virtiofs") {
        return "fixed";
    }
    "removable"
}

#[cfg(not(windows))]
fn is_likely_removable_mount(mount: &str, fs: &str) -> bool {
    if is_skipped_fs(fs) {
        return false;
    }
    if matches!(
        mount,
        "/" | "/boot" | "/boot/efi" | "/home" | "/home/root"
    ) {
        return false;
    }
    if mount.starts_with("/snap")
        || mount.starts_with("/var/")
        || mount.starts_with("/sys")
        || mount.starts_with("/proc")
        || mount.starts_with("/dev")
        || mount.starts_with("/run/user/")
        || mount.starts_with("/mnt/wsl")
    {
        return false;
    }
    mount.starts_with("/media/")
        || mount.starts_with("/run/media/")
        || mount.starts_with("/mnt/")
}

#[cfg(not(windows))]
fn push_unix_drive(
    drives: &mut Vec<RemovableDrive>,
    seen: &mut BTreeSet<String>,
    mount: String,
    fs: &str,
) {
    if !seen.insert(mount.clone()) {
        return;
    }
    let label = Path::new(&mount)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| mount.clone());
    let drive_type = unix_drive_type(&mount, fs).to_string();
    drives.push(RemovableDrive {
        path: mount,
        drive_type,
        label,
    });
}

#[cfg(not(windows))]
fn unix_list_drives() -> Result<Vec<RemovableDrive>, String> {
    let mut drives = Vec::new();
    let mut seen = BTreeSet::new();

    if let Ok(text) = fs::read_to_string("/proc/mounts") {
        for line in text.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }
            let mount = unescape_mount(parts[1]);
            let fs = parts[2];
            if !is_likely_removable_mount(&mount, fs) {
                continue;
            }
            if !Path::new(&mount).is_dir() {
                continue;
            }
            push_unix_drive(&mut drives, &mut seen, mount, fs);
        }
    }

    let user = std::env::var("USER").unwrap_or_default();
    let browse = [
        format!("/media/{user}"),
        format!("/run/media/{user}"),
        "/mnt".to_string(),
    ];
    for root in browse {
        let root_path = Path::new(&root);
        if !root_path.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(root_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let mount = path_to_string(&path);
            if mount.starts_with("/mnt/wsl") {
                continue;
            }
            if !is_likely_removable_mount(&mount, "fuseblk") && !mount.starts_with("/mnt/") {
                continue;
            }
            push_unix_drive(&mut drives, &mut seen, mount, "fuseblk");
        }
    }

    Ok(drives)
}

#[tauri::command]
pub fn list_removable_drives() -> Result<Vec<RemovableDrive>, String> {
    #[cfg(windows)]
    {
        windows_list_drives()
    }
    #[cfg(not(windows))]
    {
        unix_list_drives()
    }
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
