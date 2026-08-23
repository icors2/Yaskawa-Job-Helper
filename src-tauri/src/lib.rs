mod fs_commands;
mod media;
mod sidecar;
mod ymconnect;

use fs_commands::FolderStore;
use sidecar::SidecarStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(FolderStore::default())
        .manage(SidecarStore::default())
        .invoke_handler(tauri::generate_handler![
            fs_commands::pick_folder,
            fs_commands::pick_jbi_file,
            fs_commands::set_source_folder,
            fs_commands::set_output_folder,
            fs_commands::get_folders,
            fs_commands::list_jbi_files,
            fs_commands::read_text_file,
            fs_commands::write_output_file,
            media::list_removable_media,
            media::list_removable_drives,
            media::export_to_removable,
            media::ensure_directory,
            ymconnect::ymconnect_bridge_status,
            ymconnect::ymconnect_convert_position,
            sidecar::kin_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
