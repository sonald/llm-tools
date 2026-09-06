pub mod document_session;
pub mod file_route;
pub mod file_source;
pub mod ipc;
pub mod json;
pub mod jsonl_entry;
pub mod jsonl_index;
pub mod jsonl_session;
pub mod semantic_detection;
pub mod tree;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ipc::AppState::default())
        .invoke_handler(tauri::generate_handler![
            ipc::open_file,
            ipc::get_file_summary,
            ipc::get_root_node,
            ipc::get_node_summary,
            ipc::get_children,
            ipc::open_nested_json,
            ipc::close_nested_scope,
            ipc::read_raw_slice,
            ipc::read_selected_entry_bytes,
            ipc::read_raw_document_bytes,
            ipc::read_decoded_text,
            ipc::get_string_detection,
            ipc::scan_entries,
            ipc::list_entries,
            ipc::select_entry,
            ipc::get_oversized_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
