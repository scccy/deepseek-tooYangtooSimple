use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::{self, Bridge, BridgeEvent};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FetchFrame {
    Chunk { data: String },
    End,
    Error { message: String },
}

#[derive(Clone, Serialize)]
pub struct FetchStart {
    ok: bool,
    status: u16,
    headers: HashMap<String, String>,
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn request_quit(app: &AppHandle) {
    let state = app.state::<crate::AppState>();
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ---------------------------------------------------------------------------
// bridge commands (called from __tauri_bridge.js)
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn bridge_log(message: String) -> Result<String, String> {
    eprintln!("[dsh-bridge-js] {message}");
    Ok("ok".to_string())
}

#[tauri::command]
pub fn bridge_probe() -> Result<String, String> {
    eprintln!("[dsh-desktop] frontend bridge active");
    Ok("ok".to_string())
}

#[tauri::command]
pub async fn bridge_fetch(
    state: State<'_, crate::AppState>,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    req_id: String,
    channel: Channel<FetchFrame>,
) -> Result<FetchStart, String> {
    if req_id.trim().is_empty() {
        return Err("missing request id".to_string());
    }
    let body_bytes = match body.as_deref() {
        Some("") | None => None,
        Some(text) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .map_err(|_| "invalid body encoding".to_string())?,
        ),
    };
    let headers = bridge::normalize_headers(&headers);
    let bridge = state.bridge.clone();
    let (internal_id, receiver) = bridge
        .request_async(json!({
            "type": "fetch",
            "url": url,
            "method": method,
            "headers": headers,
            "body": body_bytes,
        }))
        .await?;
    // Keep the JS request id <-> Rust bridge id mapping for abort.
    state
        .fetch_ids
        .lock()
        .unwrap()
        .insert(req_id.clone(), internal_id);

    // Wait for response headers (or an immediate failure).
    let first = Bridge::recv_event_timeout(&receiver, Duration::from_secs(20))
        .ok_or_else(|| "host did not respond within 20s".to_string())?;
    match first {
        BridgeEvent::Headers {
            status,
            headers: response_headers,
            ..
        } => {
            let ids = state.fetch_ids.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = pump_fetch_channel(receiver, channel);
                ids.lock().unwrap().remove(&req_id);
            });
            Ok(FetchStart {
                ok: true,
                status,
                headers: response_headers,
            })
        }
        BridgeEvent::Error { message, .. } => {
            state.fetch_ids.lock().unwrap().remove(&req_id);
            Err(message)
        }
        _ => {
            state.fetch_ids.lock().unwrap().remove(&req_id);
            Err("host ended the request before sending headers".to_string())
        }
    }
}

fn pump_fetch_channel(
    receiver: std::sync::mpsc::Receiver<BridgeEvent>,
    channel: Channel<FetchFrame>,
) {
    let mut sent_end = false;
    for event in receiver {
        let frame = match event {
            BridgeEvent::Chunk { data, .. } => FetchFrame::Chunk {
                data: base64::engine::general_purpose::STANDARD.encode(&data),
            },
            BridgeEvent::End { .. } => {
                sent_end = true;
                FetchFrame::End
            }
            BridgeEvent::Error { message, .. } => FetchFrame::Error { message },
            _ => continue,
        };
        let ok = channel.send(frame);
        if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
            eprintln!("[dsh-bridge] pump channel send -> {ok:?}");
        }
        if ok.is_err() {
            sent_end = true;
            break;
        }
    }
    if !sent_end {
        let _ = channel.send(FetchFrame::End);
    }
}

#[tauri::command]
pub async fn bridge_fetch_abort(
    state: State<'_, crate::AppState>,
    req_id: String,
) -> Result<(), String> {
    let internal = state
        .fetch_ids
        .lock()
        .unwrap()
        .remove(&req_id)
        .ok_or_else(|| "unknown request id".to_string())?;
    let _ = state
        .bridge
        .clone()
        .request_async(json!({ "type": "fetch-abort", "key": internal }))
        .await;
    Ok(())
}

#[tauri::command]
pub async fn bridge_ws_open(
    state: State<'_, crate::AppState>,
    app: AppHandle,
    stream_id: String,
    path: String,
) -> Result<Value, String> {
    let (_, receiver) = state
        .bridge
        .clone()
        .request_async(json!({
            "type": "ws-open",
            "streamId": stream_id,
            "path": path,
        }))
        .await?;
    let event = Bridge::recv_event_timeout(&receiver, Duration::from_secs(20))
        .ok_or_else(|| "host did not answer ws-open".to_string())?;
    match event {
        BridgeEvent::WsResult { ok, reason, .. } => {
            if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
                eprintln!("[dsh-bridge] ws-open command resolved {ok} {reason}");
            }
            if ok {
                Ok(json!({ "ok": true }))
            } else {
                let _ = app.emit_to(
                    "main",
                    "dsh:ws-error",
                    json!({ "streamId": stream_id, "reason": reason }),
                );
                Err(reason)
            }
        }
        BridgeEvent::Error { message, .. } => Err(message),
        _ => Err("unexpected ws-open response".to_string()),
    }
}

#[tauri::command]
pub async fn bridge_ws_close(
    state: State<'_, crate::AppState>,
    stream_id: String,
) -> Result<(), String> {
    let (_, receiver) = state
        .bridge
        .clone()
        .request_async(json!({ "type": "ws-close", "streamId": stream_id }))
        .await?;
    if let Some(BridgeEvent::WsCloseResult { ok, .. }) =
        Bridge::recv_event_timeout(&receiver, Duration::from_secs(10))
    {
        if ok {
            return Ok(());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn bridge_ws_send(
    state: State<'_, crate::AppState>,
    stream_id: String,
    data: Option<String>,
    base64: Option<String>,
) -> Result<(), String> {
    let payload = if let Some(b) = base64.as_deref() {
        json!({ "base64": b })
    } else if let Some(text) = data.as_deref() {
        json!(text)
    } else {
        return Err("no frame data".to_string());
    };
    let (_, receiver) = state
        .bridge
        .clone()
        .request_async(json!({
            "type": "ws-send",
            "streamId": stream_id,
            "data": payload,
        }))
        .await?;
    if let Some(BridgeEvent::WsSendResult { ok, reason, .. }) =
        Bridge::recv_event_timeout(&receiver, Duration::from_secs(10))
    {
        if !ok {
            return Err(reason);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// native shell commands
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn shell_show_window(app: AppHandle) -> Result<(), String> {
    focus_main_window(&app);
    Ok(())
}

#[tauri::command]
pub fn shell_open_external(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("only https URLs are allowed".to_string());
    }
    Command::new("open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| format!("open failed: {e}"))?;
    Ok(())
}

fn logical_bounds(window: &tauri::WebviewWindow) -> Result<(f64, f64, f64, f64), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if scale <= 0.0 {
        return Err("invalid scale factor".to_string());
    }
    let position = window.inner_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok((
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ))
}

const MIN_INNER_WIDTH: f64 = 960.0;
const MIN_INNER_HEIGHT: f64 = 640.0;

#[tauri::command]
pub fn shell_window_resize(app: AppHandle, edge: String, dx: f64, dy: f64) -> Result<(), String> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err("invalid delta".to_string());
    }
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window unavailable".to_string());
    };
    let (mut x, y, mut width, mut height) = logical_bounds(&window)?;
    // West-edge moves shift x only by the amount actually applied: when the
    // width clamps at the minimum, moving x by the raw dx would drift the
    // window rightwards on every event.
    match edge.as_str() {
        "west" => {
            let new_width = (width - dx).max(MIN_INNER_WIDTH);
            x += width - new_width;
            width = new_width;
        }
        "east" => {
            width = (width + dx).max(MIN_INNER_WIDTH);
        }
        "south" => {
            height = (height + dy).max(MIN_INNER_HEIGHT);
        }
        "southwest" => {
            let new_width = (width - dx).max(MIN_INNER_WIDTH);
            x += width - new_width;
            width = new_width;
            height = (height + dy).max(MIN_INNER_HEIGHT);
        }
        "southeast" => {
            width = (width + dx).max(MIN_INNER_WIDTH);
            height = (height + dy).max(MIN_INNER_HEIGHT);
        }
        _ => return Err(format!("unsupported resize edge: {edge}")),
    }
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    if edge == "west" || edge == "southwest" {
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Move the window by an incremental logical-pixel delta. The frontend's
/// titlebar drag uses this instead of tao's native drag, which on macOS
/// only honors the first invocation per run. `begin` marks the first delta
/// of a drag and forces a fresh position read (the cached position may be
/// stale after native zoom / window-state restore).
#[tauri::command]
pub fn shell_window_move(
    app: AppHandle,
    dx: f64,
    dy: f64,
    begin: Option<bool>,
) -> Result<(), String> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err("invalid delta".to_string());
    }
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window unavailable".to_string());
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if scale <= 0.0 {
        return Err("invalid scale factor".to_string());
    }
    // Per-frame AppKit reads are the expensive half of this command. The
    // frontend marks the first delta of a drag with `begin`, which forces a
    // fresh read; subsequent deltas apply to the cached logical position.
    let state = app.state::<crate::AppState>();
    let mut cache = state.move_pos.lock().unwrap();
    let cached = if begin.unwrap_or(false) { None } else { *cache };
    let current = match cached {
        Some(pos) => pos,
        None => {
            let position = window.outer_position().map_err(|e| e.to_string())?;
            (position.x as f64 / scale, position.y as f64 / scale)
        }
    };
    let next = (current.0 + dx, current.1 + dy);
    window
        .set_position(tauri::LogicalPosition::new(next.0, next.1))
        .map_err(|e| e.to_string())?;
    *cache = Some(next);
    Ok(())
}

/// Current frame geometry in logical pixels; used by the drag/resize
/// selftest (WKWebView reports window.screenX/outerWidth as 0).
#[derive(Serialize)]
pub struct WindowGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[tauri::command]
pub fn shell_window_geometry(app: AppHandle) -> Result<WindowGeometry, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window unavailable".to_string());
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if scale <= 0.0 {
        return Err("invalid scale factor".to_string());
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(WindowGeometry {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

#[tauri::command]
pub fn shell_toggle_maximize(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window unavailable".to_string());
    };
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replace the Node sidecar process group in place and reload the WebView
/// once the new host is ready. The window is never closed or moved.
#[tauri::command]
pub fn shell_hot_restart(app: AppHandle) -> Result<String, String> {
    crate::request_hot_restart(&app)?;
    Ok("restarting".to_string())
}

/// Latest sidecar startup status (`{stage, detail, ready}`) for the recovery
/// page. Polled by the loading page while the host boots.
#[tauri::command]
pub fn shell_startup_status(app: AppHandle) -> Result<String, String> {
    let state = app.state::<crate::AppState>();
    let status = state.bridge.status();
    let ready = state.bridge.ready();
    Ok(json!({
        "stage": status.as_ref().map(|s| s.stage.clone()).unwrap_or_else(|| "starting".to_string()),
        "detail": status.as_ref().map(|s| s.detail.clone()).unwrap_or_default(),
        "ready": ready.as_ref().map(|r| r.error.is_none()).unwrap_or(false),
    })
    .to_string())
}

/// Retry the host startup from the recovery page (respawns the sidecar and
/// navigates on settle).
#[tauri::command]
pub fn shell_retry_startup(app: AppHandle) -> Result<String, String> {
    crate::shell_retry_startup(&app)?;
    Ok("retrying".to_string())
}

/// Reset the desktop runtime from Settings (rebuild www + respawn the host).
/// Non-destructive: sessions, plugins and settings under the shared profile
/// are left untouched.
#[tauri::command]
pub fn shell_reset_runtime(app: AppHandle) -> Result<String, String> {
    crate::reset_runtime(&app)?;
    Ok("resetting".to_string())
}

/// Diagnostics for the Settings panel: bridge readiness, last boot error,
/// sidecar stage and the tail of the app log.
#[tauri::command]
pub fn shell_diagnostics(app: AppHandle) -> Result<String, String> {
    let state = app.state::<crate::AppState>();
    let ready_info = state.bridge.ready();
    let status = state.bridge.status();
    let mut log_tail: Vec<String> = Vec::new();
    if let Ok(dir) = app.path().app_log_dir() {
        let path = dir.join("dsh-desktop.log");
        if let Ok(content) = std::fs::read_to_string(&path) {
            let lines: Vec<&str> = content.lines().rev().take(60).collect();
            log_tail = lines.into_iter().rev().map(str::to_string).collect();
        }
    }
    Ok(json!({
        "ready": ready_info.as_ref().map(|r| r.error.is_none()).unwrap_or(false),
        "error": ready_info.as_ref().and_then(|r| r.error.clone()),
        "stage": status.as_ref().map(|s| s.stage.clone()).unwrap_or_else(|| "starting".to_string()),
        "detail": status.as_ref().map(|s| s.detail.clone()).unwrap_or_default(),
        "log_tail": log_tail,
    })
    .to_string())
}
