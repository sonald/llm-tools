pub mod file_route;
pub mod file_source;
pub mod json;
pub mod jsonl_entry;
pub mod jsonl_index;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
