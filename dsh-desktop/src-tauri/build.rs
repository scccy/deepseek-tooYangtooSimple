// Every app command must be listed here: tauri-build autogenerates the
// `allow-<command>` ACL permission for each (underscores become hyphens).
// Remote capabilities (capabilities/loopback-host.json) and the local default
// capability reference those identifiers — remote contexts can never reach
// custom commands without an explicit grant.
fn main() {
    #[cfg(target_os = "macos")]
    {
        // Native macOS notifications (see notify_un.m): UNUserNotificationCenter
        // with a foreground-present delegate and one-time authorization request.
        if std::env::var("DOCS_RS").is_err() {
            println!("cargo:rerun-if-changed=notify_un.m");
            cc::Build::new()
                .file("notify_un.m")
                .flag("-mmacosx-version-min=11.0")
                .compile("notify_un");
            println!("cargo:rustc-link-lib=framework=UserNotifications");
            println!("cargo:rustc-link-lib=framework=Foundation");
        }
    }
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "bridge_fetch",
                "bridge_fetch_abort",
                "bridge_log",
                "bridge_probe",
                "bridge_ws_close",
                "bridge_ws_open",
                "bridge_ws_send",
                "shell_diagnostics",
                "shell_dispatch_shortcut",
                "shell_get_close_behavior",
                "shell_get_keybindings",
                "shell_get_notify_prefs",
                "shell_hot_restart",
                "shell_open_external",
                "shell_reset_runtime",
                "shell_restore_keybindings",
                "shell_retry_startup",
                "shell_set_close_behavior",
                "shell_set_keybindings",
                "shell_set_notify_prefs",
                "shell_show_window",
                "shell_startup_status",
                "shell_toggle_maximize",
                "shell_window_geometry",
                "shell_window_move",
                "shell_window_resize",
                "shell_app_update",
                "shell_check_app_update",
                "shell_check_update",
                "shell_dsh_update",
                "welcome_complete",
                "welcome_get_state",
                "welcome_save_api_key",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
