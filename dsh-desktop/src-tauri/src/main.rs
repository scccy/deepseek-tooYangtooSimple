// DeepSeek Harness desktop shell — cross-platform edition (Tauri v2).
//
// Architecture:
//   The webview loads dsh://localhost/index.html (custom scheme, local site)
//   └─ __tauri_bridge.js replaces /api fetch & WebSocket with Tauri IPC
//     └─ Rust commands forward NDJSON to the Node host sidecar
//       └─ sidecar boots the official `web` profile in-process with a
//          zero-socket webServer stub — no port, no local HTTP server.
//
// Native integration: application menu + standard shortcuts, menu-bar tray
// with close-to-tray, Notification Center / desktop alerts from host event
// streams, Dock reopen (macOS) / single-instance activation, and persisted
// window geometry.

mod bridge;
mod commands;
mod host;
mod site;
mod envs;
mod updater;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

use bridge::Bridge;

pub struct AppState {
    pub bridge: Arc<Bridge>,
    pub quitting: Arc<AtomicBool>,
    /// Guards the in-place sidecar restart: one at a time, and never while
    /// the app is closing.
    pub restarting: Arc<AtomicBool>,
    /// Guards the one-at-a-time "update dsh" install.
    pub updating: Arc<AtomicBool>,
    pub fetch_ids: Arc<Mutex<HashMap<String, u64>>>,
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
    /// Last applied logical frame position; `shell_window_move` applies
    /// per-frame deltas to this cache instead of re-reading AppKit.
    pub move_pos: Mutex<Option<(f64, f64)>>,
}

const MAIN_WINDOW: &str = "main";
const LOADING_URL: &str = "dsh://localhost/__loading.html";
const INDEX_URL: &str = "dsh://localhost/index.html";

/// Default geometry for `window.open` popups that do not specify a size.
const POPUP_INNER_WIDTH: f64 = 1024.0;
const POPUP_INNER_HEIGHT: f64 = 768.0;
const POPUP_MIN_WIDTH: f64 = 480.0;
const POPUP_MIN_HEIGHT: f64 = 360.0;

/// Monotonic popup-window label counter. Labels must stay unique while the
/// app runs: building a second window with the same label fails.
static POPUP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Full-viewport shutter injected into the live page when a hot restart is
/// requested. Kept as a same-page overlay — the WebView never navigates away
/// from the desktop app's own `dsh://` page.
const RESTART_OVERLAY_JS: &str = r##"
(() => {
  if (document.getElementById("__dsh_restart_shim__")) return;
  var box = document.createElement("div");
  box.id = "__dsh_restart_shim__";
  var s = box.style;
  s.position = "fixed";
  s.inset = "0";
  s.zIndex = "2147483647";
  s.background = "#101016";
  s.display = "flex";
  s.alignItems = "center";
  s.justifyContent = "center";
  s.font = "13px -apple-system, BlinkMacSystemFont, \"SF Pro Text\", sans-serif";
  s.color = "#c8c8d2";
  box.textContent = "正在热重启 …";
  (document.body || document.documentElement).appendChild(box);
})();
"##;

/// Synthetic pointer-event selftest (DSH_DESKTOP_SELFTEST=1): drags the titlebar
/// twice and resizes the west edge once, then reports window geometry deltas
/// through bridge_log. Guards against the "second drag silently fails"
/// regression (tao native drag only works once per run on macOS).
const SELFTEST_JS: &str = r#"
(async function () {
  window.__DSH_SELFTEST__ = true;
  var core = window.__TAURI__.core;
  function pe(type, x, y) {
    return new PointerEvent(type, { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, detail: 1, isPrimary: true, bubbles: true });
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function geo() { return core.invoke('shell_window_geometry'); }
  function dragTitlebar() {
    // Release 20px past the last move: the pointer-up tail must be counted,
    // otherwise the window ends up short of the final cursor position.
    document.dispatchEvent(pe('pointerdown', 500, 10));
    for (var i = 1; i <= 5; i += 1) document.dispatchEvent(pe('pointermove', 500 + i * 10, 10));
    document.dispatchEvent(pe('pointerup', 570, 10));
  }
  var out = {};
  out.g0 = await geo();
  dragTitlebar();
  await sleep(700);
  out.g1 = await geo();
  dragTitlebar();
  await sleep(700);
  out.g2 = await geo();
  document.dispatchEvent(pe('pointerdown', 3, 500));
  for (var i = 1; i <= 3; i += 1) document.dispatchEvent(pe('pointermove', 3 - i * 10, 500));
  document.dispatchEvent(pe('pointerup', -47, 500));
  await sleep(700);
  out.g3 = await geo();
  core.invoke('bridge_log', { message: '[dsh-selftest] ' + JSON.stringify(out) });
  return 'selftest done';
})();
"#;

fn focus_main_window(app: &tauri::AppHandle) {
    commands::focus_main_window(app);
}

fn request_quit(app: &tauri::AppHandle) {
    commands::request_quit(app);
}

/// Handle `window.open` / target=_blank from WKWebView.
///
/// Policy: web URLs open in the macOS **default browser** (standard for OAuth
/// sign-in windows), `about:blank` is denied so the frontend's popup stub can
/// take over via `__DSH_MAC__.openExternal`, and only app-internal `dsh://`
/// pages get a real in-app webview window. Any other scheme is denied.
fn open_popup_window(
    app: &tauri::AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    match url.scheme() {
        "http" | "https" => {
            // Jump to the system browser instead of embedding another webview.
            if let Err(error) = std::process::Command::new("open")
                .arg(url.as_str())
                .spawn()
            {
                eprintln!("[dsh-popup] failed to open system browser for {url}: {error}");
            }
            tauri::webview::NewWindowResponse::Deny
        }
        "dsh" => {
            let seq = POPUP_SEQ.fetch_add(1, Ordering::Relaxed);
            let label = format!("popup-{seq}");
            let title = url
                .host_str()
                .map(str::to_owned)
                .unwrap_or_else(|| url.as_str().to_owned());

            let builder = WebviewWindowBuilder::new(
                app,
                &label,
                WebviewUrl::CustomProtocol(url.clone()),
            )
            .title(title)
            .inner_size(POPUP_INNER_WIDTH, POPUP_INNER_HEIGHT)
            .min_inner_size(POPUP_MIN_WIDTH, POPUP_MIN_HEIGHT)
            // Applies the requested size/position and, on macOS, shares WebKit's
            // target WKWebViewConfiguration with the caller webview.
            .window_features(features)
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            });

            match builder.build() {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(error) => {
                    eprintln!("[dsh-popup] failed to create window {label} for {url}: {error}");
                    tauri::webview::NewWindowResponse::Deny
                }
            }
        }
        _ => {
            eprintln!(
                "[dsh-popup] denied window.open for scheme {:?}: {}",
                url.scheme(),
                url
            );
            tauri::webview::NewWindowResponse::Deny
        }
    }
}

fn setup_native_shell(app: &tauri::App) -> tauri::Result<()> {
    // ------------------------- application menu -------------------------
    let about = PredefinedMenuItem::about(app, Some("关于 DeepSeek Harness Desktop"), None)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = MenuItemBuilder::with_id("menu-quit", "退出 DeepSeek Harness Desktop")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "DeepSeek Harness Desktop")
        .item(&about)
        .separator()
        .item(&services)
        .separator()
        .item(&hide)
        .item(&hide_others)
        .item(&show_all)
        .separator()
        .item(&quit)
        .build()?;

    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .build()?;

    let reload = MenuItemBuilder::with_id("menu-reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&reload)
        .separator()
        .item(&fullscreen)
        .build()?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let close = PredefinedMenuItem::close_window(app, None)?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .item(&close)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;

    // ------------------------- menu-bar tray -------------------------
    let tray_show = MenuItemBuilder::with_id("tray-show", "显示 DeepSeek Harness Desktop").build(app)?;
    let tray_quit = MenuItemBuilder::with_id("tray-quit", "退出 DeepSeek Harness Desktop").build(app)?;
    let tray_menu = MenuBuilder::new(app)
        .item(&tray_show)
        .separator()
        .item(&tray_quit)
        .build()?;
    let mut tray_builder = TrayIconBuilder::with_id("dsh-desktop-tray")
        .tooltip("DeepSeek Harness Desktop")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        // macOS convention: a monochrome template image that adapts to light
        // and dark menu bars instead of the full-color app icon.
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => focus_main_window(app),
            "tray-quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(handle) = _tray.app_handle().get_webview_window(MAIN_WINDOW) {
                    if handle.is_minimized().unwrap_or(false) {
                        let _ = handle.unminimize();
                    }
                    let _ = handle.show();
                    let _ = handle.set_focus();
                }
            }
        });
    // The tray uses the plain whale SILHOUETTE (rendered as a macOS template
    // image): the colorful dock icon would collapse into a muddy blob here.
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(icon) => {
            tray_builder = tray_builder.icon(icon);
        }
        Err(error) => {
            eprintln!("dsh-desktop: tray icon decode failed: {error}");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
        }
    }
    let tray = tray_builder.build(app)?;
    {
        let state = app.state::<AppState>();
        *state.tray.lock().unwrap() = Some(tray);
    }

    Ok(())
}

pub(crate) fn wait_for_bridge(bridge: &Arc<Bridge>, timeout: Duration) -> (bool, Option<String>) {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(ready) = bridge.ready() {
            if let Some(error) = ready.error {
                return (false, Some(error));
            }
            if ready.www.is_some() {
                return (true, None);
            }
        }
        if bridge.is_exited() {
            return (
                false,
                Some("host sidecar exited before becoming ready".to_string()),
            );
        }
        if Instant::now() >= deadline {
            return (
                false,
                Some("host sidecar did not become ready in time".to_string()),
            );
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Navigate the existing main window to the real site on success, or to the
/// splash failure page. The window itself is never closed or recreated.
fn navigate_to_result(app: &tauri::AppHandle, phase: &str, ready: bool, error: Option<String>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if ready {
        eprintln!("dsh-desktop: {phase}: host ready");
        if let Ok(url) = INDEX_URL.parse::<tauri::Url>() {
            let _ = window.navigate(url);
        }
    } else {
        let message = error.unwrap_or_else(|| "unknown startup failure".to_string());
        eprintln!("dsh-desktop: {phase}: host failed: {message}");
        let encoded =
            percent_encoding::utf8_percent_encode(&message, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        if let Ok(url) = format!("{LOADING_URL}#error={encoded}").parse::<tauri::Url>() {
            let _ = window.navigate(url);
        }
    }
}

/// Runs off the main thread: the window is already showing the boot splash,
/// so the app feels instant even while the Node host boots. Navigates to the
/// real site on success, or renders the failure on the splash page.
fn watch_startup(app: tauri::AppHandle, bridge: Arc<Bridge>) {
    std::thread::spawn(move || {
        let (ready, error) = wait_for_bridge(&bridge, Duration::from_secs(45));
        navigate_to_result(&app, "startup", ready, error);
    });
}

/// Run once per launch: compare the installed dsh against the npm registry and,
/// when a newer release exists, surface a native notification. The check lives
/// off the main thread and never blocks boot; failures stay in the log.
fn startup_update_check(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let info = updater::check_update(false);
        if info.update_available {
            let local = info.local_version.clone().unwrap_or_else(|| "?".to_string());
            let latest = info.latest_version.clone().unwrap_or_else(|| "?".to_string());
            bridge::show_notification(
                &app,
                "DeepSeek Harness Desktop".to_string(),
                format!("dsh 有新版本 v{latest} 可用（当前 v{local}），可在设置中一键更新"),
                false,
            );
        } else if let Some(error) = info.error.clone() {
            eprintln!("dsh-desktop: startup dsh update check: {error}");
        }
    });
}

/// Whether a standalone `dsh --profile web` is still listening on
/// 127.0.0.1:3080. The desktop shell is portless (the host boots in-process
/// with zero sockets), so an occupied 3080 is always a *foreign* leftover from
/// an older CLI / Electron `dsh web` run — never the desktop's own process.
fn stale_web_server_running() -> bool {
    use std::net::SocketAddr;
    let Ok(address) = "127.0.0.1:3080".parse::<SocketAddr>() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok()
}

/// Run once per launch: if a leftover standalone `dsh --profile web` still
/// holds 127.0.0.1:3080, warn the user. That old server injects an older
/// bootstrap (no `window.__ModuleLoader__` facade), so a browser opening that
/// port renders the new frontend JS as a blank "Failed to load plugins" screen
/// instead of the HARNESS — exactly the version-skew failure we hit.
fn startup_stale_server_check(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Probe only after the portless host has had a moment to boot, so a
        // brand-new, intentional standalone server is also seen.
        std::thread::sleep(Duration::from_millis(1500));
        if stale_web_server_running() {
            eprintln!("dsh-desktop: stale standalone dsh web detected on 127.0.0.1:3080");
            bridge::show_notification(
                &app,
                "DeepSeek Harness Desktop".to_string(),
                "检测到旧版 dsh web 仍在 127.0.0.1:3080 监听：桌面版为无端口形态，请用 pkill -f \"dsh --profile web\" 结束旧进程，避免浏览器打开到旧页面"
                    .to_string(),
                false,
            );
        }
    });
}

/// Hot-restart entry point invoked from the General settings row. The window
/// itself is never recreated or moved: the old sidecar process group is
/// replaced in place and the WebView navigates back to `dsh://localhost`
/// only after the new host reports ready.
pub fn request_hot_restart(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.quitting.load(Ordering::SeqCst) {
        return Err("应用正在退出，无法热重启".to_string());
    }
    if state.bridge.www_dir().is_none() {
        return Err("主机尚未就绪，无法热重启".to_string());
    }
    if state.updating.load(Ordering::SeqCst) {
        return Err("dsh 正在更新，请更新完成后再热重启".to_string());
    }
    if state
        .restarting
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("热重启已在进行中".to_string());
    }

    let app_handle = app.clone();

    // No page navigation during hot restart: the WebView stays on
    // dsh://localhost/index.html the whole time. The stray SPA self-navigation
    // to the portless mock origin (http://127.0.0.1:0/) is blocked by the
    // navigation handler, and we simply shutter the live page with an injected
    // overlay so the user sees a clean "restarting" state. run_hot_restart
    // reloads the app page once the new host reports ready.
    let overlay_app = app.clone();
    std::thread::spawn(move || {
        if let Some(window) = overlay_app.get_webview_window(MAIN_WINDOW) {
            let _ = window.eval(RESTART_OVERLAY_JS);
        }
    });

    std::thread::spawn(move || run_hot_restart(app_handle));
    Ok(())
}

fn run_hot_restart(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    let bridge = state.bridge.clone();
    let log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| dir.join("dsh-desktop.log"));

    let Some(www_dir) = bridge.www_dir() else {
        state.restarting.store(false, Ordering::SeqCst);
        return;
    };

    bridge::append_log(
        &log_path
            .clone()
            .unwrap_or_else(|| www_dir.join("dsh-desktop.log")),
        "dsh-desktop host hot restart requested".to_string(),
    );
    eprintln!(
        "dsh-desktop: hot restart initiated (www={})",
        www_dir.display()
    );

    bridge.prepare_for_restart();
    match host::spawn_sidecar(&app, &www_dir) {
        Ok(mut spawned) => {
            let stdin = spawned.child.stdin.take();
            let io = bridge::take_reader_io(&mut spawned.child);
            if let Some(stdin) = stdin {
                bridge.attach_stdio(stdin);
            } else {
                eprintln!("dsh-desktop: hot restart: host stdin unavailable");
            }
            bridge.attach_child(spawned.child);
            bridge::spawn_reader(bridge.clone(), io, app.clone(), log_path);
        }
        Err(error) => {
            eprintln!("dsh-desktop: hot restart spawn failed: {error}");
            bridge.set_ready_pedantic(false, Some(error));
        }
    }

    let (ready, error) = wait_for_bridge(&bridge, Duration::from_secs(45));
    navigate_to_result(&app, "hot restart", ready, error);
    state.restarting.store(false, Ordering::SeqCst);
}

fn log_preamble(app: &tauri::AppHandle, www_dir: &PathBuf, home: &PathBuf) {
    let log = app
        .path()
        .app_log_dir()
        .map(|dir| dir.join("dsh-desktop.log"))
        .unwrap_or_else(|_| {
            app.path()
                .app_data_dir()
                .unwrap_or(www_dir.clone())
                .join("dsh-desktop.log")
        });
    bridge::append_log(
        &log,
        format!(
            "dsh-desktop starting (www={}, dsh-home={}, pid={})",
            www_dir.display(),
            home.display(),
            std::process::id()
        ),
    );
}

fn main() {
    let bridge_handle = Bridge::new();
    let quitting = Arc::new(AtomicBool::new(false));
    let app_state = AppState {
        bridge: bridge_handle.clone(),
        quitting: quitting.clone(),
        restarting: Arc::new(AtomicBool::new(false)),
        updating: Arc::new(AtomicBool::new(false)),
        fetch_ids: Arc::new(Mutex::new(HashMap::new())),
        tray: Mutex::new(None),
        move_pos: Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(app_state)
        .register_asynchronous_uri_scheme_protocol("dsh", site::protocol_handler)
        .invoke_handler(tauri::generate_handler![
            commands::bridge_log,
            commands::bridge_probe,
            commands::bridge_fetch,
            commands::bridge_fetch_abort,
            commands::bridge_ws_open,
            commands::bridge_ws_close,
            commands::bridge_ws_send,
            commands::shell_show_window,
            commands::shell_open_external,
            commands::shell_window_resize,
            commands::shell_window_move,
            commands::shell_window_geometry,
            commands::shell_toggle_maximize,
            commands::shell_hot_restart,
            updater::shell_check_update,
            updater::shell_dsh_update,
        ])
        .setup(move |app| {
            bridge::set_global(bridge_handle.clone());

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let www_dir = data_dir.join("www");
            let home = host::resolve_home();
            std::fs::create_dir_all(&home)?;
            if let Err(error) = std::fs::create_dir_all(&www_dir) {
                eprintln!("dsh-desktop: www dir failed: {error}");
            }
            log_preamble(app.handle(), &www_dir, &home);

            let state = app.state::<AppState>();
            let bridge = state.bridge.clone();
            match host::spawn_sidecar(app.handle(), &www_dir) {
                Ok(mut spawned) => {
                    let stdin = spawned.child.stdin.take();
                    let io = bridge::take_reader_io(&mut spawned.child);
                    if let Some(stdin) = stdin {
                        bridge.attach_stdio(stdin);
                    } else {
                        eprintln!("dsh-desktop: host stdin unavailable");
                    }
                    bridge.attach_child(spawned.child);
                    bridge::spawn_reader(
                        bridge.clone(),
                        io,
                        app.handle().clone(),
                        app.path()
                            .app_log_dir()
                            .ok()
                            .map(|dir| dir.join("dsh-desktop.log")),
                    );
                }
                Err(error) => {
                    eprintln!("dsh-desktop: {error}");
                    bridge.set_ready_pedantic(false, Some(error));
                }
            }

            // Notification Center requires an explicit, user-approved
            // permission grant; without this the first alerts never surface.
            match app.notification().request_permission() {
                Ok(permission) => {
                    eprintln!("dsh-desktop: notification permission: {permission:?}")
                }
                Err(error) => eprintln!("dsh-desktop: notification permission failed: {error}"),
            }

            setup_native_shell(app)?;

            // Show the window immediately with a local splash page; the
            // background watcher navigates once the host is ready. This keeps
            // the run loop responsive instead of blocking on host boot.
            let url: tauri::Url = LOADING_URL.parse().expect("valid custom-scheme url");
            let quitting_flag = state.quitting.clone();
            let mut window_builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::CustomProtocol(url))
                .title("DeepSeek Harness Desktop")
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 640.0);
            #[cfg(target_os = "macos")]
            {
                // Native integrated look: content extends under the traffic
                // lights with no separate white title strip.
                window_builder = window_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .background_color(tauri::utils::config::Color(16, 16, 22, 255));
            }
            // Windows / Linux 保持系统装饰（交给 OS 窗口管理器）：dsh 前端
            // 页面没有窗口控制按钮，无边框自绘标题栏会封死最小化/关闭入口。
            // Route window.open / target=_blank through the native popup
            // window factory instead of letting WKWebView drop the request.
            let popup_handle = app.handle().clone();
            window_builder = window_builder
                .on_new_window(move |url, features| open_popup_window(&popup_handle, url, features));

            // The shell owns its origin (dsh://) and never listens on
            // 127.0.0.1:PORT, so any navigation to a loopback http(s) URL is a
            // stray — e.g. the live SPA reconnecting to the portless mock
            // server while a hot restart kills the sidecar, which resolves to
            // http://127.0.0.1:0/. Block it and pull the webview back to the
            // app page; every legitimate external destination is opened in the
            // system browser via `shell_open_external` instead of navigating
            // the shell.
            let restarting_flag = state.restarting.clone();
            let guard_handle = app.handle().clone();
            window_builder = window_builder.on_navigation(move |url| {
                match url.scheme() {
                    "dsh" | "about" | "blob" => return true,
                    "http" | "https" => {
                        let host = url.host_str().unwrap_or("");
                        if matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]") {
                            // While a restart is in flight, leave the splash
                            // page alone: run_hot_restart navigates back to the
                            // real site once the new host reports ready.
                            if !restarting_flag.load(Ordering::SeqCst) {
                                let handle = guard_handle.clone();
                                std::thread::spawn(move || {
                                    std::thread::sleep(Duration::from_millis(20));
                                    if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
                                        if let Ok(url) = INDEX_URL.parse::<tauri::Url>() {
                                            let _ = window.navigate(url);
                                        }
                                    }
                                });
                            }
                            return false;
                        }
                    }
                    _ => {}
                }
                true
            });
            let window = window_builder.build()?;

            watch_startup(app.handle().clone(), bridge);
            startup_update_check(app.handle().clone());
            startup_stale_server_check(app.handle().clone());

            if crate::envs::is_1("DSH_DESKTOP_DEBUG_UI", "DSH_MAC_DEBUG_UI") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for delay in [3u64, 8, 15] {
                        std::thread::sleep(Duration::from_secs(delay));
                        if let Some(win) = handle.get_webview_window(MAIN_WINDOW) {
                            let _ = win.eval_with_callback(
                                "JSON.stringify(Array.from(document.querySelectorAll('body *')).map(function(e){var r=e.getBoundingClientRect();return {tag:e.tagName,cls:typeof e.className==='string'?e.className.slice(0,60):'',top:Math.round(r.top),left:Math.round(r.left),h:Math.round(r.height),w:Math.round(r.width)};}).filter(function(x){return x.top<90&&x.h>8&&x.w>120;}).slice(0,40))",
                                |text| eprintln!("[dsh-ui-top] {text}"),
                            );
                        }
                    }
                });
            }
            // Synthetic pointer-event selftest for titlebar drag / edge
            // resize: reports window position and width deltas via bridge_log.
            if crate::envs::is_1("DSH_DESKTOP_SELFTEST", "DSH_MAC_SELFTEST") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(12));
                    if let Some(win) = handle.get_webview_window(MAIN_WINDOW) {
                        let _ = win.eval(SELFTEST_JS);
                    }
                });
            }
            let hidden_target = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if !quitting_flag.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = hidden_target.hide();
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => focus_main_window(app_handle),
            RunEvent::MenuEvent(event) => match event.id().as_ref() {
                "menu-quit" => request_quit(app_handle),
                "menu-reload" => {
                    if let Some(window) = app_handle.get_webview_window(MAIN_WINDOW) {
                        let _ = window.eval("window.location.reload()");
                    }
                }
                _ => {}
            },
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                {
                    let state = app_handle.state::<AppState>();
                    state.quitting.store(true, Ordering::SeqCst);
                    state.bridge.terminate();
                }
                // RunEvent::ExitRequested on macOS can arrive more than once;
                // termination is idempotent.
            }
            _ => {}
        });
}
