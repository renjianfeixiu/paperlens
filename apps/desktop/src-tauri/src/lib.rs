mod remote_pdf;
mod browser_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            remote_pdf::download_pdf,
            browser_bridge::resolve_landing_page,
            browser_bridge::find_recent_browser_pdf,
            browser_bridge::import_browser_pdf_candidate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
