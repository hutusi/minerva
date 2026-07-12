mod sidecar;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(sidecar::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::sidecar_start,
            sidecar::sidecar_send,
            sidecar::sidecar_kill,
            sidecar::default_cwd
        ])
        .build(tauri::generate_context!())
        .expect("failed to build tauri application")
        .run(|app, event| {
            // The kernel child must never outlive the app: webview teardown is
            // not a reliable signal (reloads, crashes), so the kill lives here.
            if let tauri::RunEvent::Exit = event {
                sidecar::kill_sidecar(app);
            }
        });
}
