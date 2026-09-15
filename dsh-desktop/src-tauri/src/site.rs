use percent_encoding::percent_decode_str;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::UriSchemeResponder;

use crate::bridge::GLOBAL_BRIDGE;

pub const BRIDGE_JS: &str = include_str!("bridge.js");

const MAX_STATIC_FILE: u64 = 64 * 1024 * 1024;
/// Keep the hot set bounded; the frontend bundle is a few dozen files, so a
/// full clear is cheaper than an LRU for this workload.
const MAX_CACHE_ENTRIES: usize = 256;

/// Boot splash shown while the host sidecar starts. `#error=<text>` renders
/// the failure instead of the spinner (navigation happens from Rust).
const LOADING_HTML: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Desktop</title>
<style>
  html, body { margin: 0; height: 100%; background: #101016; color: #c8c8d2;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    display: flex; align-items: center; justify-content: center; }
  .box { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .spinner { width: 28px; height: 28px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,.14); border-top-color: #7c8cff;
    animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #stage { display: none; max-width: 560px; color: #9aa0b5; font-size: 12px;
    line-height: 1.5; white-space: pre-wrap; text-align: center; }
  #err { display: none; max-width: 560px; color: #ff9a9a; font-size: 13px;
    line-height: 1.6; white-space: pre-wrap; text-align: center; }
  #retry { display: none; margin-top: 4px; padding: 8px 20px; border: 1px solid #3d4460;
    border-radius: 6px; background: #1b1f2b; color: #d6d9e8; font-size: 13px;
    cursor: pointer; }
  #retry:hover { background: #242a3a; }
  #retry:disabled { opacity: .55; cursor: default; }
</style>
</head>
<body>
<div class="box">
  <div class="spinner" id="spin"></div>
  <div id="label">正在启动 DSH Desktop 主机…</div>
  <div id="stage"></div>
  <div id="err"></div>
  <button id="retry">重试</button>
</div>
<script>
  var T = window.__TAURI__ && window.__TAURI__.core;
  var errorHash = location.hash.indexOf('#error=') === 0;
  function showError() {
    document.getElementById('spin').style.display = 'none';
    document.getElementById('label').textContent = '启动失败';
    var e = document.getElementById('err');
    e.style.display = 'block';
    e.textContent = decodeURIComponent(location.hash.slice(7));
    document.getElementById('retry').style.display = 'inline-block';
  }
  function renderStatus(s) {
    var el = document.getElementById('stage');
    if (!el) return;
    if (s && s.stage && s.stage !== 'ready') {
      el.style.display = 'block';
      el.textContent = '阶段：' + s.stage + (s.detail ? ' — ' + s.detail : '');
    } else {
      el.style.display = 'none';
    }
  }
  function poll() {
    if (!T || errorHash) return;
    T.invoke('shell_startup_status').then(function (raw) {
      try {
        renderStatus(typeof raw === 'string' ? JSON.parse(raw) : raw);
      } catch (e) {}
    }).catch(function () {});
  }
  if (errorHash) {
    showError();
  } else {
    setInterval(poll, 250);
    poll();
  }
  document.getElementById('retry').onclick = function () {
    if (!T) { location.hash = ''; location.reload(); return; }
    var btn = this;
    btn.disabled = true;
    btn.textContent = '正在重试…';
    T.invoke('shell_retry_startup').catch(function (e) {
      btn.disabled = false;
      btn.textContent = '重试';
      var err = document.getElementById('err');
      err.style.display = 'block';
      err.textContent = '重试失败：' + String(e);
    });
  };
</script>
</body>
</html>
"#;

struct CachedFile {
    mtime: SystemTime,
    data: Arc<Vec<u8>>,
}

static FILE_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedFile>>> = OnceLock::new();

fn content_type(path: &str) -> &'static str {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
}

/// Read a static file through a small mtime-validated memory cache. The
/// desktop app serves the same bundle on every request; without this each
/// asset costs a full disk read.
fn read_static_cached(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_STATIC_FILE {
        return None;
    }
    let mtime = meta.modified().ok()?;
    let cache = FILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let map = cache.lock().unwrap();
        if let Some(entry) = map.get(path) {
            if entry.mtime == mtime {
                return Some((*entry.data).clone());
            }
        }
    }
    let data = std::fs::read(path).ok()?;
    let mut map = cache.lock().unwrap();
    if map.len() >= MAX_CACHE_ENTRIES {
        map.clear();
    }
    map.insert(
        path.to_path_buf(),
        CachedFile {
            mtime,
            data: Arc::new(data.clone()),
        },
    );
    Some(data)
}

/// Join a request path onto the served root, refusing traversal and symlink
/// escapes. Both sides are canonicalized, so a symlink inside `www/` cannot
/// point outside of it.
fn safe_path(path: &str, root: &Path) -> Option<PathBuf> {
    if path.contains("..") {
        return None;
    }
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    let relative = decoded.strip_prefix('/').unwrap_or(decoded.as_ref());
    let mut target = root.to_path_buf();
    for component in PathBuf::from(relative).components() {
        match component {
            Component::Normal(part) => target.push(part),
            Component::RootDir | Component::Prefix(_) | Component::ParentDir => return None,
            Component::CurDir => {}
        }
    }
    let canonical_root = root.canonicalize().ok()?;
    let canonical_target = target.canonicalize().ok()?;
    if canonical_target.starts_with(&canonical_root) {
        Some(canonical_target)
    } else {
        None
    }
}

fn serve_static(path: &Path) -> Response<Vec<u8>> {
    if path.is_dir() {
        let index = path.join("index.html");
        if let Some(data) = read_static_cached(&index) {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(data)
                .unwrap();
        }
        return text_response(StatusCode::NOT_FOUND, "not found\n");
    }
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_STATIC_FILE => {
            text_response(StatusCode::PAYLOAD_TOO_LARGE, "file too large\n")
        }
        Ok(_) => match read_static_cached(&path) {
            Some(data) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type(&path.to_string_lossy()))
                .body(data)
                .unwrap(),
            None => text_response(StatusCode::NOT_FOUND, "not found\n"),
        },
        Err(_) => text_response(StatusCode::NOT_FOUND, "not found\n"),
    }
}

fn text_response(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body.as_bytes().to_vec())
        .unwrap()
}

pub async fn handle(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().clone();
    let path = uri.path().to_owned();
    if crate::envs::trace_bridge() {
        eprintln!(
            "[dsh-site] {} {}",
            request.method().as_str(),
            uri.path_and_query().map(|p| p.as_str()).unwrap_or_default()
        );
    }
    if path == "/__tauri_bridge.js" {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
            .body(BRIDGE_JS.as_bytes().to_vec())
            .unwrap();
    }
    if path == "/__loading.html" {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(LOADING_HTML.as_bytes().to_vec())
            .unwrap();
    }

    let Some(bridge_handle) = GLOBAL_BRIDGE.get().cloned() else {
        return text_response(StatusCode::SERVICE_UNAVAILABLE, "bridge unavailable\n");
    };

    // Static site fast path. Every non-file path (or missing file) falls
    // through to the in-process route registry, which serves plugin routes
    // and the SPA fallback.
    if let Some(www) = bridge_handle.www_dir() {
        if let Some(target) = safe_path(&path, &www) {
            if target.is_file() {
                let response = serve_static(&target);
                if response.status() == StatusCode::OK {
                    return response;
                }
            }
        }
    }

    let method = request.method().as_str().to_owned();
    let mut headers = HashMap::new();
    for (name, value) in request.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), value.to_owned());
        }
    }
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("{path}{query}");
    if crate::envs::trace_bridge() {
        eprintln!("[dsh-site] route dispatch: {url}");
    }
    // The rust->node bridge sets Host: 127.0.0.1; strip browser markers as
    // the sidecar sanitizes them again.
    let fetched = bridge_handle.fetch_full(
        url,
        method,
        headers,
        Some(request.body().clone()),
        Duration::from_secs(30),
    );
    match fetched {
        Ok((status, response_headers, body)) => {
            // custom schemes have no download delegate in the webviews: an
            // `attachment` response (e.g. dshmarket's log export) would
            // silently vanish. Save it to the Downloads dir from the shell
            // and reveal it in the file manager instead.
            if (200..300).contains(&status) {
                if let Some(filename) = attachment_filename(&response_headers) {
                    return save_attachment(&filename, &body);
                }
            }
            let mut builder = Response::builder()
                .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY));
            for (name, value) in response_headers {
                builder = builder.header(name, value);
            }
            builder
                .body(body)
                .unwrap_or_else(|_| text_response(StatusCode::BAD_GATEWAY, "bad route response\n"))
        }
        Err(error) => text_response(StatusCode::BAD_GATEWAY, &format!("route failed: {error}\n")),
    }
}

/// Extract the filename from `Content-Disposition: attachment; filename=...`.
fn attachment_filename(headers: &HashMap<String, String>) -> Option<String> {
    let value = headers.get("content-disposition")?;
    if !value.to_ascii_lowercase().starts_with("attachment") {
        return None;
    }
    for part in value.split(';').skip(1) {
        let part = part.trim();
        let raw = if let Some(rest) = part
            .to_ascii_lowercase()
            .strip_prefix("filename=")
            .map(|_| &part["filename=".len()..])
        {
            rest.trim().trim_matches('"')
        } else {
            continue;
        };
        // Strip any path components; the shell decides where files land.
        let name = raw.rsplit(['/', '\\']).next()?.trim();
        if !name.is_empty() && name != ".." {
            return Some(name.to_string());
        }
    }
    Some("download.bin".to_string())
}

/// Write an attachment into ~/Downloads (deduping names) and reveal it.
fn save_attachment(filename: &str, body: &[u8]) -> Response<Vec<u8>> {
    let Some(downloads) = dirs::download_dir() else {
        return text_response(StatusCode::INTERNAL_SERVER_ERROR, "no downloads dir\n");
    };
    if let Err(error) = std::fs::create_dir_all(&downloads) {
        return text_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("downloads dir unavailable: {error}\n"),
        );
    }
    let mut target = downloads.join(filename);
    if target.exists() {
        let (stem, ext) = match filename.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
            _ => (filename.to_string(), String::new()),
        };
        for index in 1..1000 {
            let candidate = downloads.join(format!("{stem} ({index}){ext}"));
            if !candidate.exists() {
                target = candidate;
                break;
            }
        }
    }
    if let Err(error) = std::fs::write(&target, body) {
        return text_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("save failed: {error}\n"),
        );
    }
    eprintln!("[dsh-site] attachment saved: {}", target.display());
    reveal_in_file_manager(&target);
    text_response(StatusCode::OK, &format!("saved to {}\n", target.display()))
}

/// 在系统文件管理器中定位刚保存的文件（macOS: Finder；Windows: Explorer；
/// Linux: 打开所在目录——xdg-open 无法高亮单个文件）。
fn reveal_in_file_manager(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        // `Path::display()` 在 Windows 目标上自然使用反斜杠。
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(dir) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    }
}

pub fn protocol_handler(
    _ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        responder.respond(handle(request).await);
    });
}
