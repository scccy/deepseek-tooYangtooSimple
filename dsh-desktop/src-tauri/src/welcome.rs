//! Welcome/onboarding window (batch 2, ported from the official shell's
//! welcome-window semantics).
//!
//! Shown only when the active profile has NO configured API credential; the
//! check runs once at startup, after the host reports ready. The window is a
//! 600×700 material sheet (`window-vibrancy`) served from the inline
//! `/__welcome.html` page. "Save & continue" stores the key through the
//! sidecar's credential service; "Set up later" and closing the window both
//! enter the workspace unchanged.
//!
//! Conservative rule: any bridge failure around the credential check lets the
//! user straight in — a broken sidecar must never lock the user out of the
//! workspace.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::bridge::{Bridge, BridgeEvent};

const WELCOME_WINDOW: &str = "welcome";
const WELCOME_URL: &str = "dsh://localhost/__welcome.html";

/// Set once the workspace entry ran, so a late CloseRequested cannot run it
/// twice.
static ENTRY_DONE: AtomicBool = AtomicBool::new(false);

/// Whether the workspace may open directly: `true` when a credential is
/// configured OR the check is unavailable; `false` (show welcome) only on a
/// definitive "no credential configured".
pub fn entry_allowed(app: &AppHandle) -> bool {
    match credential_configured(app) {
        Some(configured) => configured,
        None => {
            eprintln!("dsh-desktop: credential check unavailable; entering workspace directly");
            true
        }
    }
}

/// `Some(configured)` after a successful describe; `None` when the sidecar
/// did not answer in time.
fn credential_configured(app: &AppHandle) -> Option<bool> {
    let state = app.state::<crate::AppState>();
    let bridge = state.bridge.clone();
    let (_id, rx) = bridge
        .request(json!({ "type": "credentials-describe", "ref": "DEEPSEEK_API_KEY" }))
        .ok()?;
    match Bridge::recv_event_timeout(&rx, Duration::from_secs(2))? {
        BridgeEvent::CredentialsInfo { configured, .. } => {
            if !configured {
                let notes = "credential absent";
                eprintln!("dsh-desktop: welcome: {notes}");
            }
            Some(configured)
        }
        _ => None,
    }
}

/// Explicit `locale.preference` from the host settings (`zh` / `en`), or
/// `None` when unset/unavailable — the caller falls back to the detected
/// shell locale.
fn locale_preference(app: &AppHandle) -> Option<String> {
    let state = app.state::<crate::AppState>();
    let bridge = state.bridge.clone();
    let (_id, rx) = bridge
        .request(json!({ "type": "settings-get", "key": "locale.preference" }))
        .ok()?;
    match Bridge::recv_event_timeout(&rx, Duration::from_secs(2))? {
        BridgeEvent::SettingsValue { value, .. } => match value {
            Value::String(text) if text.starts_with("zh") || text.starts_with("en") => {
                Some(text[..2].to_string())
            }
            _ => None,
        },
        _ => None,
    }
}

/// Create (or focus) the welcome window. The fallback lives inside the
/// main-thread closure: if the window cannot be built the workspace is
/// entered directly, so the user is never stranded on the splash.
pub fn show_welcome(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(existing) = handle.get_webview_window(WELCOME_WINDOW) {
            let _ = existing.show();
            let _ = existing.set_focus();
            return;
        }
        let Ok(url) = WELCOME_URL.parse::<tauri::Url>() else {
            enter_workspace(&handle);
            return;
        };
        let builder = WebviewWindowBuilder::new(&handle, WELCOME_WINDOW, WebviewUrl::CustomProtocol(url))
            .title("DSH Desktop")
            .inner_size(600.0, 700.0)
            .resizable(false)
            .center();
        match builder.build() {
            Ok(window) => {
                // Material sheet: vibrancy on macOS, acrylic on Windows;
                // Linux keeps a solid surface from the page background.
                #[cfg(target_os = "macos")]
                {
                    if let Err(e) = window_vibrancy::apply_vibrancy(
                        &window,
                        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
                        None,
                        None,
                    ) {
                        eprintln!("dsh-desktop: welcome vibrancy: {e}");
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    if let Err(e) = window_vibrancy::apply_acrylic(&window, Some((24, 24, 32, 125)))
                    {
                        eprintln!("dsh-desktop: welcome acrylic: {e}");
                    }
                }
                let w = window.clone();
                window.on_window_event(move |event| {
                    // Closing the welcome window = "set up later": enter the
                    // workspace instead of quitting the app.
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        enter_workspace(w.app_handle());
                    }
                });
                let _ = window.set_focus();
            }
            Err(e) => {
                eprintln!("dsh-desktop: welcome window build failed: {e}; entering workspace");
                enter_workspace(&handle);
            }
        }
    });
}

/// Navigate the main window into the workspace and dispose the welcome
/// window. Idempotent.
pub fn enter_workspace(app: &AppHandle) {
    let first_entry = !ENTRY_DONE.swap(true, Ordering::SeqCst);
    if first_entry {
        if let Some(main) = app.get_webview_window(crate::MAIN_WINDOW) {
            // First load must be the host's authenticated loopback URL (the
            // webserver mints the session cookie there); dsh:// is only a
            // fallback for a legacy portless host.
            let dest = app
                .try_state::<crate::AppState>()
                .and_then(|state| state.bridge.ready())
                .and_then(|ready| ready.url)
                .unwrap_or_else(|| crate::INDEX_URL.to_string());
            if let Ok(url) = dest.parse::<tauri::Url>() {
                let _ = main.navigate(url);
            }
        }
        eprintln!("dsh-desktop: welcome: entering workspace");
    }
    if let Some(welcome) = app.get_webview_window(WELCOME_WINDOW) {
        let _ = welcome.close();
    }
    if let Some(main) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

// ---------------------------------------------------------------------------
// commands (called from the welcome page)
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn welcome_get_state(app: AppHandle) -> Result<String, String> {
    let configured = credential_configured(&app).unwrap_or(false);
    let locale = locale_preference(&app).unwrap_or_else(|| {
        match crate::i18n::locale() {
            crate::i18n::Locale::Zh => "zh".to_string(),
            crate::i18n::Locale::En => "en".to_string(),
        }
    });
    Ok(json!({
        "locale": locale,
        "credential": { "configured": configured },
    })
    .to_string())
}

#[tauri::command]
pub fn welcome_save_api_key(app: AppHandle, value: String) -> Result<String, String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        return Ok(json!({ "ok": false, "error": "key is empty" }).to_string());
    }
    let state = app.state::<crate::AppState>();
    let bridge = state.bridge.clone();
    let (_id, rx) = bridge
        .request(json!({ "type": "credentials-set", "ref": "DEEPSEEK_API_KEY", "value": trimmed }))
        .map_err(|e| e)?;
    let answer = Bridge::recv_event_timeout(&rx, Duration::from_secs(4));
    match answer {
        Some(BridgeEvent::CredentialsResult { ok, error, .. }) => Ok(json!({
            "ok": ok,
            "error": error,
        })
        .to_string()),
        _ => Ok(json!({ "ok": false, "error": "credential service did not answer" }).to_string()),
    }
}

#[tauri::command]
pub fn welcome_complete(app: AppHandle) -> Result<String, String> {
    enter_workspace(&app);
    Ok("entered".to_string())
}
