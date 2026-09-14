use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::host;

/// Global handle used by the `dsh://` protocol dispatcher (registered outside
/// of Tauri `setup`, where managed state is not available).
pub static GLOBAL_BRIDGE: OnceLock<Arc<Bridge>> = OnceLock::new();

/// Bulk response bodies travel as `chunk-bin` frames (JSON header line +
/// `len` raw bytes) instead of base64-in-NDJSON. Guard against a corrupt or
/// hostile header asking for unbounded memory.
const MAX_CHUNK_BIN_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct ReadyInfo {
    pub www: Option<PathBuf>,
    pub error: Option<String>,
}

/// Latest startup/lifecycle status reported by the sidecar (`status` frames).
/// Powers the recovery page's stage display.
#[derive(Debug, Clone, Default)]
pub struct StatusInfo {
    pub stage: String,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub enum BridgeEvent {
    Headers {
        id: u64,
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        id: u64,
        data: Vec<u8>,
    },
    End {
        id: u64,
    },
    Error {
        id: u64,
        message: String,
    },
    WsResult {
        id: u64,
        ok: bool,
        reason: String,
    },
    WsSendResult {
        id: u64,
        ok: bool,
        reason: String,
    },
    WsCloseResult {
        id: u64,
        ok: bool,
        reason: String,
    },
    WsFrame {
        stream_id: String,
        raw: Value,
    },
    Ready {
        ok: bool,
        www: Option<PathBuf>,
        error: Option<String>,
    },
    Notify {
        title: String,
        body: String,
        background_only: bool,
    },
    Exit {
        code: Option<i64>,
        term: Option<String>,
    },
    Pong {
        id: u64,
    },
}

pub struct Bridge {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<BridgeEvent>>>,
    ready: RwLock<Option<ReadyInfo>>,
    status: RwLock<Option<StatusInfo>>,
    exited: AtomicBool,
    /// Incremented on every sidecar respawn. Reader threads and in-flight
    /// requests belong to one generation; once the generation moves on they
    /// must not mutate `ready`/`exited`/`pending` for the new host.
    generation: AtomicU64,
    /// Serializes generation transitions with late reader-thread EOF.
    lifecycle: Mutex<()>,
}

impl Bridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            ready: RwLock::new(None),
            status: RwLock::new(None),
            exited: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
        })
    }

    pub fn attach_stdio(&self, stdin: ChildStdin) {
        *self.stdin.lock().unwrap() = Some(stdin);
    }

    pub fn attach_child(&self, child: Child) {
        *self.child.lock().unwrap() = Some(child);
    }

    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub fn mark_exited(&self) {
        self.exited.store(true, Ordering::SeqCst);
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn is_current_generation(&self, generation: u64) -> bool {
        self.generation() == generation
    }

    /// Reset every piece of per-host state and stop the running sidecar.
    /// Callers must respawn and attach a new sidecar afterwards or leave the
    /// bridge permanently marked failed.
    pub fn prepare_for_restart(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap();

        // Bump first: the old reader thread ignores anything it still reads
        // from the dying host and cannot poison the new host's state at EOF.
        self.generation.fetch_add(1, Ordering::SeqCst);

        // Close our end of the old stdin before signals: the sidecar treats
        // stdin EOF as "shell gone" and starts its own graceful disposal.
        *self.stdin.lock().unwrap() = None;

        let mut child = self.child.lock().unwrap().take();
        if let Some(child) = child.as_mut() {
            host::terminate_child(child);
        }

        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        for (_, tx) in pending {
            let _ = tx.send(BridgeEvent::Error {
                id: 0,
                message: "host sidecar restarted".to_string(),
            });
        }
        *self.ready.write().unwrap() = None;
        *self.status.write().unwrap() = None;
        self.exited.store(false, Ordering::SeqCst);
    }

    pub fn ready(&self) -> Option<ReadyInfo> {
        self.ready.read().unwrap().clone()
    }

    pub fn www_dir(&self) -> Option<PathBuf> {
        self.ready.read().unwrap().as_ref()?.www.clone()
    }

    /// Record the sidecar's latest `status` frame (startup stage + detail).
    pub fn set_status(&self, stage: &str, detail: &str) {
        *self.status.write().unwrap() = Some(StatusInfo {
            stage: stage.to_string(),
            detail: detail.to_string(),
        });
    }

    pub fn status(&self) -> Option<StatusInfo> {
        self.status.read().unwrap().clone()
    }

    fn set_ready(&self, _ok: bool, www: Option<PathBuf>, error: Option<String>) {
        *self.ready.write().unwrap() = Some(ReadyInfo { www, error });
    }

    pub fn set_ready_pedantic(&self, ok: bool, error: Option<String>) {
        self.set_ready(ok, None, error);
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn next_id_value(&self) -> u64 {
        self.next_id.load(Ordering::SeqCst)
    }

    /// Send an NDJSON request and register the pending receiver atomically.
    pub fn request(&self, msg: Value) -> Result<(u64, Receiver<BridgeEvent>), String> {
        let id = self.next_id();
        if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
            let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
            eprintln!("[dsh-bridge] send {kind} as {id}");
        }
        let mut full = msg.clone();
        full["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = format!("{}\n", full);
        let mut guard = self.stdin.lock().unwrap();
        let Some(stdin) = guard.as_mut() else {
            drop(guard);
            self.pending.lock().unwrap().remove(&id);
            return Err("bridge stdin is not attached".to_string());
        };
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| {
                self.pending.lock().unwrap().remove(&id);
                format!("bridge write failed: {e}")
            })?;
        Ok((id, rx))
    }

    /// Send an NDJSON header followed by a raw body (request chunk-bin): the
    /// header carries `bodyLen` and the sidecar reads exactly that many
    /// bytes, so upload bodies skip base64 and never blow up the line.
    /// Mirrors `request()`'s state handling.
    pub fn request_with_body(
        &self,
        msg: Value,
        body: Vec<u8>,
    ) -> Result<(u64, Receiver<BridgeEvent>), String> {
        let id = self.next_id();
        if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
            let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
            eprintln!("[dsh-bridge] send {kind} as {id} (+{} bytes)", body.len());
        }
        let mut full = msg.clone();
        full["id"] = json!(id);
        if !body.is_empty() {
            full["bodyLen"] = json!(body.len());
        }
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = format!("{}\n", full);
        let mut guard = self.stdin.lock().unwrap();
        let Some(stdin) = guard.as_mut() else {
            drop(guard);
            self.pending.lock().unwrap().remove(&id);
            return Err("bridge stdin is not attached".to_string());
        };
        let write = if body.is_empty() {
            stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush())
        } else {
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(&body))
                .and_then(|_| stdin.flush())
        };
        write.map_err(|e| {
            self.pending.lock().unwrap().remove(&id);
            format!("bridge write failed: {e}")
        })?;
        Ok((id, rx))
    }

    pub async fn request_async(
        self: Arc<Self>,
        msg: Value,
    ) -> Result<(u64, Receiver<BridgeEvent>), String> {
        tauri::async_runtime::spawn_blocking(move || self.request(msg))
            .await
            .map_err(|e| format!("bridge task failed: {e}"))?
    }

    /// Wait for a single event matching expectations; returns timeout.
    pub fn recv_event_timeout(
        rx: &Receiver<BridgeEvent>,
        timeout: Duration,
    ) -> Option<BridgeEvent> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(event) => return Some(event),
                Err(mpsc::RecvTimeoutError::Timeout) => return None,
                Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    /// Collector used by the custom-protocol handler: buffers a complete
    /// in-process route response.
    pub fn fetch_full(
        &self,
        url: String,
        method: String,
        headers: HashMap<String, String>,
        body: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<(u16, HashMap<String, String>, Vec<u8>), String> {
        let request_msg = json!({
            "type": "fetch",
            "url": url,
            "method": method,
            "headers": headers,
        });
        let (_, rx) = match body {
            Some(bytes) if !bytes.is_empty() => self.request_with_body(request_msg, bytes)?,
            _ => self.request(request_msg)?,
        };
        if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
            eprintln!("[dsh-bridge] fetch_full: {url}");
        }
        let deadline = Instant::now() + timeout;
        let mut status = 502u16;
        let mut response_headers = HashMap::new();
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("route response timed out".to_string());
            }
            match Self::recv_event_timeout(&rx, remaining) {
                Some(BridgeEvent::Headers {
                    status: s, headers, ..
                }) => {
                    if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
                        eprintln!("[dsh-bridge] fetch_full headers {s}");
                    }
                    status = s;
                    response_headers = headers;
                }
                Some(BridgeEvent::Chunk { data, .. }) => {
                    chunks.push(data);
                }
                Some(BridgeEvent::End { .. }) => {
                    if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
                        eprintln!("[dsh-bridge] fetch_full end");
                    }
                    break;
                }
                Some(BridgeEvent::Error { message, .. }) => {
                    return Err(message);
                }
                None => return Err("route response timed out".to_string()),
                _ => continue,
            }
        }
        let total: usize = chunks.iter().map(Vec::len).sum();
        const MAX_ROUTE_BODY: usize = 128 * 1024 * 1024;
        if total > MAX_ROUTE_BODY {
            return Err("route response too large".to_string());
        }
        let mut body = Vec::with_capacity(total);
        for chunk in chunks {
            body.extend_from_slice(&chunk);
        }
        Ok((status, response_headers, body))
    }

    /// Reader-thread exit path: only the reader belonging to the current host
    /// is allowed to mark the bridge exited and flush waiters. Late EOF from a
    /// replaced sidecar returns `false` and stays completely inert.
    pub fn finish_reader_generation(&self, generation: u64) -> bool {
        let _lifecycle = self.lifecycle.lock().unwrap();
        if !self.is_current_generation(generation) {
            return false;
        }
        self.mark_exited();
        true
    }

    pub fn terminate(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            host::terminate_child(child);
        }
    }
}

// ---------------------------------------------------------------------------
// reader / writer threads
// ---------------------------------------------------------------------------
fn headers_from(value: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(obj) = value.as_object() {
        for (key, value) in obj {
            let rendered = match value {
                Value::String(s) => s.clone(),
                Value::Array(items) => {
                    let parts: Vec<String> = items
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| v.to_string())
                        })
                        .collect();
                    parts.join(", ")
                }
                other => other.to_string(),
            };
            out.insert(key.to_ascii_lowercase(), rendered);
        }
    }
    out
}

pub fn normalize_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (key, value) in headers {
        let lower = key.to_ascii_lowercase();
        if lower == "origin" || lower == "referer" || lower.starts_with("sec-fetch-") {
            continue;
        }
        out.insert(lower, value.clone());
    }
    out
}

fn decode_chunk(value: &Value) -> Vec<u8> {
    match value
        .as_str()
        .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
    {
        Some(bytes) => bytes,
        None => Vec::new(),
    }
}

pub struct BridgeIo {
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

/// Own the child stdio streams so they are not dropped and closed.
pub fn take_reader_io(child: &mut Child) -> BridgeIo {
    BridgeIo {
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
    }
}

/// Discard `len` bytes from the stream (oversized chunk-bin guard) so the
/// frame parser stays aligned with the sidecar's output.
fn drain_bytes(reader: &mut impl BufRead, mut len: u64) -> std::io::Result<()> {
    let mut buf = [0u8; 8192];
    while len > 0 {
        let take = len.min(buf.len() as u64) as usize;
        reader.read_exact(&mut buf[..take])?;
        len -= take as u64;
    }
    Ok(())
}

/// A chunk-bin header line was consumed; read exactly `len` raw bytes and
/// forward them as a stream chunk.
fn read_chunk_bin(
    bridge: &Arc<Bridge>,
    reader: &mut impl BufRead,
    msg: &Value,
) -> std::io::Result<()> {
    let Some(id) = msg.get("id").and_then(Value::as_u64) else {
        return Ok(());
    };
    let len = msg.get("len").and_then(Value::as_u64).unwrap_or(0);
    if len > MAX_CHUNK_BIN_BYTES {
        eprintln!("[dsh-host-bridge] chunk-bin too large ({len} bytes), dropping");
        return drain_bytes(reader, len);
    }
    let mut data = vec![0u8; len as usize];
    reader.read_exact(&mut data)?;
    // Same streaming semantics as the legacy `chunk` frame: keep the sender
    // registered so the rest of the response reaches the same waiter.
    let tx = bridge.pending.lock().unwrap().get(&id).cloned();
    if let Some(tx) = tx {
        let _ = tx.send(BridgeEvent::Chunk { id, data });
    }
    Ok(())
}

pub fn spawn_reader(bridge: Arc<Bridge>, io: BridgeIo, app: AppHandle, log_path: Option<PathBuf>) {
    if let Some(stderr) = io.stderr {
        let stderr_log = log_path.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let line = line.unwrap_or_default();
                eprintln!("[dsh-host] {line}");
                if let Some(path) = &stderr_log {
                    append_log(path, format!("[dsh-host] {line}"));
                }
            }
        });
    }

    let Some(stdout) = io.stdout else {
        bridge.set_ready(false, None, Some("no host stdout".to_string()));
        return;
    };

    thread::spawn(move || {
        let generation = bridge.generation();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            // Stale generation: this reader belongs to a host that is being
            // replaced. Drain nothing and never touch the shared bridge state
            // — the new host's reader owns it now.
            if !bridge.is_current_generation(generation) {
                break;
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
                eprintln!(
                    "[dsh-host-bridge] bad stdout frame: {}",
                    &trimmed[..trimmed.len().min(120)]
                );
                continue;
            };
            let kind = msg.get("type").and_then(Value::as_str).unwrap_or_default();
            if crate::envs::is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE") {
                eprintln!("[dsh-bridge] recv {kind} {:?}", msg.get("id"));
            }
            // Binary bulk path: header line followed by `len` raw bytes.
            if kind == "chunk-bin" {
                if read_chunk_bin(&bridge, &mut reader, &msg).is_err() {
                    break;
                }
                continue;
            }
            match kind {
                "status" => {
                    let stage = msg
                        .get("stage")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let detail = msg
                        .get("detail")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    bridge.set_status(&stage, &detail);
                }
                "ready" => {
                    let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    let www = msg
                        .get("www")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(PathBuf::from);
                    let error_text = msg.get("error").and_then(Value::as_str).map(str::to_owned);
                    let error_for_set = error_text.clone();
                    bridge.set_ready(ok, if ok { www } else { None }, error_for_set);
                    if ok {
                        eprintln!("[dsh-host] ready");
                    } else {
                        eprintln!(
                            "[dsh-host] boot failed: {}",
                            error_text.as_deref().unwrap_or("unknown")
                        );
                    }
                }
                "pong" | "headers" | "chunk" | "end" | "error" | "ws-result" | "ws-send-result"
                | "ws-close-result" => {
                    let Some(id) = msg.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    // `headers` and `chunk` are stream frames: keep the sender
                    // registered so the rest of the response reaches the
                    // same waiter. Terminal frames remove it.
                    let stream_frame = kind == "headers" || kind == "chunk";
                    let tx = if stream_frame {
                        bridge.pending.lock().unwrap().get(&id).cloned()
                    } else {
                        bridge.pending.lock().unwrap().remove(&id)
                    };
                    let Some(tx) = tx else {
                        continue;
                    };
                    let event = match kind {
                        "pong" => BridgeEvent::Pong { id },
                        "end" => BridgeEvent::End { id },
                        "headers" => BridgeEvent::Headers {
                            id,
                            status: msg.get("status").and_then(Value::as_u64).unwrap_or(500) as u16,
                            headers: headers_from(msg.get("headers").unwrap_or(&Value::Null)),
                        },
                        "chunk" => BridgeEvent::Chunk {
                            id,
                            data: decode_chunk(msg.get("data").unwrap_or(&Value::Null)),
                        },
                        "error" => BridgeEvent::Error {
                            id,
                            message: msg
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("host request failed")
                                .to_owned(),
                        },
                        "ws-result" => BridgeEvent::WsResult {
                            id,
                            ok: msg.get("ok").and_then(Value::as_bool).unwrap_or(false),
                            reason: msg
                                .get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                        },
                        "ws-send-result" => BridgeEvent::WsSendResult {
                            id,
                            ok: msg.get("ok").and_then(Value::as_bool).unwrap_or(false),
                            reason: msg
                                .get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                        },
                        "ws-close-result" => BridgeEvent::WsCloseResult {
                            id,
                            ok: msg.get("ok").and_then(Value::as_bool).unwrap_or(false),
                            reason: msg
                                .get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                        },
                        _ => continue,
                    };
                    let _ = tx.send(event);
                }
                "ws-frame" => {
                    let Some(stream_id) = msg
                        .get("streamId")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                    else {
                        continue;
                    };
                    let mut event = serde_json::Map::new();
                    event.insert("streamId".to_string(), json!(stream_id));
                    if let Some(data) = msg.get("data") {
                        event.insert("data".to_string(), data.clone());
                    }
                    if let Some(closed) = msg.get("closed").and_then(Value::as_bool) {
                        event.insert("closed".to_string(), json!(closed));
                    }
                    if let Some(code) = msg.get("code") {
                        event.insert("code".to_string(), code.clone());
                    }
                    if let Some(reason) = msg.get("reason") {
                        event.insert("reason".to_string(), reason.clone());
                    }
                    let _ = app.emit_to("main", "dsh:ws-frame", Value::Object(event));
                }
                "notify" => {
                    let title = msg
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("DSH Desktop");
                    let body = msg.get("body").and_then(Value::as_str).unwrap_or_default();
                    let background_only = msg
                        .get("backgroundOnly")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    show_notification(&app, title.to_owned(), body.to_owned(), background_only);
                }
                "exit" => {
                    if !bridge.finish_reader_generation(generation) {
                        break;
                    }
                    let _ = app.emit_to(
                        "main",
                        "dsh:host-exit",
                        json!({
                            "code": msg.get("code").and_then(Value::as_i64),
                            "term": msg.get("term").and_then(Value::as_str)
                        }),
                    );
                    // Wake every waiter so no command hangs on a dead host.
                    let pending = std::mem::take(&mut *bridge.pending.lock().unwrap());
                    for (_, tx) in pending {
                        let _ = tx.send(BridgeEvent::Error {
                            id: 0,
                            message: "host sidecar exited".to_string(),
                        });
                    }
                    break;
                }
                _ => {
                    eprintln!(
                        "[dsh-host-bridge] unknown event: {}",
                        &trimmed[..trimmed.len().min(160)]
                    );
                }
            }
        }
        if !bridge.finish_reader_generation(generation) {
            return;
        }
        let pending = std::mem::take(&mut *bridge.pending.lock().unwrap());
        for (_, tx) in pending {
            let _ = tx.send(BridgeEvent::Error {
                id: 0,
                message: "host sidecar exited".to_string(),
            });
        }
    });
}

pub(crate) fn show_notification(app: &AppHandle, title: String, body: String, background_only: bool) {
    if background_only {
        if let Some(window) = app.get_webview_window("main") {
            if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
                return;
            }
        }
    }
    let result = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
    if let Err(error) = result {
        eprintln!("[dsh-desktop] notification failed: {error}");
    }
}

/// Log lines this old (or older) are pruned from `dsh-desktop.log` on the
/// next append: keep the last 2 hours of logs only.
const LOG_RETENTION_SECS: u64 = 2 * 60 * 60;
/// In-run prune passes never run more often than this, so appending stays
/// cheap between passes while the running app still self-cleans.
const LOG_PRUNE_INTERVAL_SECS: u64 = 10 * 60;

/// Serializes appends and prunes across the stdout/stderr reader threads.
static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
/// Unix seconds of the last prune pass; 0 forces a prune on the first append
/// (i.e. at startup), cleaning up whatever previous runs left behind.
static LAST_LOG_PRUNE: AtomicU64 = AtomicU64::new(0);

pub fn append_log(path: &PathBuf, line: String) {
    // OpenOptions::create makes the file but not its parents — the log dir
    // does not exist on first launch.
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let lock = LOG_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    prune_log_if_due(path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {line}", chrono_like_now());
    }
}

/// Drop log lines older than [`LOG_RETENTION_SECS`], at most once per
/// [`LOG_PRUNE_INTERVAL_SECS`]. The first append always prunes, so a fresh
/// launch trims the tail left by earlier sessions.
fn prune_log_if_due(path: &PathBuf) {
    let now = unix_now_secs();
    let last = LAST_LOG_PRUNE.load(Ordering::Relaxed);
    if now.saturating_sub(last) < LOG_PRUNE_INTERVAL_SECS {
        return;
    }
    prune_log(path, now);
    LAST_LOG_PRUNE.store(now, Ordering::Relaxed);
}

fn prune_log(path: &PathBuf, now: u64) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return; // nothing to prune (or unreadable) — leave the file alone
    };
    // Every line is timestamped `YYYY-MM-DDTHH:MM:SSZ`; the fixed-width,
    // zero-padded fields make chronological order equal to lexicographic
    // order, so a plain string compare is a correct time comparison.
    let cutoff = utc_ts(now.saturating_sub(LOG_RETENTION_SECS) as i64);
    let lines: Vec<&str> = content.lines().collect();
    let kept: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| line_within_retention(line, &cutoff))
        .collect();
    if kept.len() == lines.len() {
        return; // nothing expired
    }
    let mut out = String::with_capacity(content.len());
    for line in &kept {
        out.push_str(line);
        out.push('\n');
    }
    let _ = std::fs::write(path, out);
}

/// A line is kept when its leading timestamp is missing/unparseable (never
/// drop data we do not understand) or is newer than/equal to `cutoff`.
fn line_within_retention(line: &str, cutoff: &str) -> bool {
    let Some(ts) = line.get(..20) else {
        return true;
    };
    let b = ts.as_bytes();
    let well_formed = b.len() == 20
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'Z';
    if !well_formed {
        return true;
    }
    ts >= cutoff
}

/// Current wall-clock seconds since the Unix epoch.
fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Readable UTC timestamp for log lines without pulling in a date crate.
fn chrono_like_now() -> String {
    utc_ts(unix_now_secs() as i64)
}

fn utc_ts(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Days -> civil date (Howard Hinnant's algorithm, proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

pub fn set_global(bridge: Arc<Bridge>) {
    let _ = GLOBAL_BRIDGE.set(bridge);
}
