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
    tauri_build::build()
}