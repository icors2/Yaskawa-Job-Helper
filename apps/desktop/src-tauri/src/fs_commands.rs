use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct FolderStore {
    pub source: Mutex<Option<PathBuf>>,
    pub output: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JbiEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderState {
    pub source_folder: Option<String>,
    pub output_folder: Option<String>,
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn snapshot(store: &FolderStore) -> FolderState {
    FolderState {
        source_folder: store
            .source
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| path_to_string(p))),
        output_folder: store
            .output
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| path_to_string(p))),
    }
}

fn is_jbi(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("jbi"))
        .unwrap_or(false)
}

fn collect_jbi(root: &Path, dir: &Path, out: &mut Vec<JbiEntry>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_jbi(root, &path, out)?;
            continue;
        }
        if !is_jbi(&path) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("")
            .to_string();
        out.push(JbiEntry {
            name,
            path: path_to_string(&path),
            relative_path: relative,
        });
    }
    Ok(())
}

fn resolve_under_output(output: &Path, requested: &Path) -> Result<PathBuf, String> {
    let output_canon =
        std::fs::canonicalize(output).map_err(|err| format!("output folder: {err}"))?;
    let dest = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        output_canon.join(requested)
    };
    let parent = dest.parent().ok_or("invalid output path")?;
    std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let parent_canon = std::fs::canonicalize(parent).map_err(|err| err.to_string())?;
    if !parent_canon.starts_with(&output_canon) {
        return Err("Writes are only allowed inside the chosen output folder".into());
    }
    let file_name = dest.file_name().ok_or("invalid output filename")?;
    Ok(parent_canon.join(file_name))
}

#[tauri::command]
pub fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let folder = app
        .dialog()
        .file()
        .set_title("Open folder")
        .blocking_pick_folder();
    Ok(folder.and_then(|path| {
        path.into_path()
            .ok()
            .map(|resolved| path_to_string(&resolved))
    }))
}

#[tauri::command]
pub fn pick_jbi_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter("Yaskawa jobs", &["jbi", "JBI"])
        .set_title("Open calibration .JBI")
        .blocking_pick_file();
    Ok(picked.and_then(|path| {
        path.into_path()
            .ok()
            .map(|resolved| path_to_string(&resolved))
    }))
}

#[tauri::command]
pub fn set_source_folder(store: tauri::State<FolderStore>, path: String) -> Result<FolderState, String> {
    let resolved = PathBuf::from(&path);
    if !resolved.is_dir() {
        return Err("Source path is not a folder".into());
    }
    *store.source.lock().map_err(|_| "source folder lock")? = Some(resolved);
    Ok(snapshot(&store))
}

#[tauri::command]
pub fn set_output_folder(store: tauri::State<FolderStore>, path: String) -> Result<FolderState, String> {
    let resolved = PathBuf::from(&path);
    if !resolved.is_dir() {
        return Err("Output path is not a folder".into());
    }
    *store.output.lock().map_err(|_| "output folder lock")? = Some(resolved);
    Ok(snapshot(&store))
}

#[tauri::command]
pub fn get_folders(store: tauri::State<FolderStore>) -> Result<FolderState, String> {
    Ok(snapshot(&store))
}

#[tauri::command]
pub fn list_jbi_files(root: String) -> Result<Vec<JbiEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("Folder does not exist".into());
    }
    let mut jobs = Vec::new();
    collect_jbi(&root_path, &root_path, &mut jobs)?;
    jobs.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    Ok(jobs)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn write_output_file(
    store: tauri::State<FolderStore>,
    path: String,
    contents: String,
) -> Result<String, String> {
    let output = store
        .output
        .lock()
        .map_err(|_| "output folder lock")?
        .clone()
        .ok_or("Choose an output folder before writing")?;
    let dest = resolve_under_output(&output, Path::new(&path))?;
    std::fs::write(&dest, contents).map_err(|err| err.to_string())?;
    Ok(path_to_string(&dest))
}
