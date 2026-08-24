//! dsh self-update for the desktop shell.
//!
//! The shell deliberately runs the user's globally installed `@deepseek-ai/dsh`
//! (never a bundled copy), so "checking for updates" means comparing the local
//! package version against the npm registry's `latest` dist-tag (the stable
//! channel), and "update dsh" means running `npm install -g
//! @deepseek-ai/dsh@latest` and then hot-restarting the Node sidecar so the new
//! package loads. Both the version check and the install route through the
//! same npm binary and global prefix the shell booted from, so there is no
//! copy/prefix mismatch between what is checked and what boots.
//!
//! This is intentionally a **stable-channel consumer**: prerelease channels
//! such as `next` are never offered. A rc published only under `next` (e.g.
//! `0.1.0-rc.8` while `latest` points at `0.1.0-rc.7`) stays invisible until
//! it is promoted to `latest`. When `latest` itself is a prerelease, the
//! suffix comparison still ranks rc candidates correctly (rc.8 > rc.7).

use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::host;
use crate::AppState;

pub const PKG_NAME: &str = "@deepseek-ai/dsh";
const CHECK_TIMEOUT: Duration = Duration::from_secs(25);
const CACHE_TTL: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(80);

/// Latest-version memo shared by the startup check, the settings row's mount
/// check and any in-flight `npm view`. A manual "检测更新" click passes
/// `force=true` and bypasses the memo.
static LATEST_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(Instant, String)>>> =
    std::sync::OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshVersionInfo {
    pub local_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub dsh_root: Option<String>,
    pub error: Option<String>,
}

/// Release the update lock when the install thread exits, whichever path it
/// takes. This keeps a crashed/failed install from wedging the button forever.
struct UpdateGuard(std::sync::Arc<AtomicBool>);
impl Drop for UpdateGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn normalize_version(version: &str) -> String {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
        .trim()
        .to_string()
}

fn numeric_core(version: &str) -> (Vec<u64>, bool) {
    let mut prerelease = false;
    let mut core = version;
    if let Some((head, _tail)) = version.split_once('-') {
        core = head;
        prerelease = true;
    } else if let Some((head, _tail)) = version.split_once('+') {
        core = head;
    }
    let nums: Vec<u64> = core
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect();
    (nums, prerelease)
}

/// Text after the first `-` — a prerelease suffix (`rc.7`, `alpha.2`).
/// `+build` metadata is dropped because it does not affect precedence. Empty
/// for plain releases. Mirrors `numeric_core`'s "-"/"+" detection order so the
/// two helpers always agree about whether a version is a prerelease.
fn prerelease_suffix(version: &str) -> &str {
    if let Some((_, tail)) = version.split_once('-') {
        tail.split('+').next().unwrap_or("")
    } else {
        ""
    }
}

/// Compare two prerelease suffixes (text after `-`), semver-style: identifiers
/// split on `.`, numeric identifiers compare numerically, numeric sorts before
/// alphanumeric, two alphanumeric identifiers compare in ASCII order, and more
/// identifiers beat fewer when the shared prefix is equal. So rc.8 > rc.7 and
/// rc.1 > rc.
fn compare_prerelease(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a_id: Vec<&str> = a.split('.').collect();
    let b_id: Vec<&str> = b.split('.').collect();
    for (x, y) in a_id.iter().zip(b_id.iter()) {
        let ordering = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(xn), Ok(yn)) => xn.cmp(&yn),
            (Ok(_), Err(_)) => Ordering::Less, // numeric < alphanumeric
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    a_id.len().cmp(&b_id.len())
}

/// True when `latest` is a newer release than `local`. Core triples compare
/// numerically (so 0.10.0 > 0.9.0); on equal cores a plain release beats a
/// prerelease (0.6.4 > 0.6.4-rc.1), and two prereleases rank by their suffix
/// identifiers (0.1.0-rc.8 > 0.1.0-rc.7).
fn version_is_newer(latest: &str, local: &str) -> bool {
    let (ln, lp) = numeric_core(latest);
    let (cn, cp) = numeric_core(local);
    let max = ln.len().max(cn.len());
    for index in 0..max {
        let a = ln.get(index).copied().unwrap_or(0);
        let b = cn.get(index).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    if lp != cp {
        return !lp && cp;
    }
    if lp && cp {
        return compare_prerelease(prerelease_suffix(latest), prerelease_suffix(local))
            == std::cmp::Ordering::Greater;
    }
    false
}

fn looks_like_version(value: &str) -> bool {
    let value = value.trim().trim_start_matches(['v', 'V']);
    // Accept `major[.minor[.patch]]` with an optional `-prerelease`/`+build`
    // suffix (e.g. 0.1.0-rc.7). The suffix can contain letters, so it is
    // split off before validating the numeric core.
    let core = value.split(['-', '+']).next().unwrap_or("");
    let mut parts = core.split('.');
    let Some(first) = parts.next() else {
        return false;
    };
    if first.is_empty() || !first.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    parts.all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

/// Spawn `cmd` and feed every stdout/stderr line to `on_line` until the child
/// exits or `timeout` elapses (then the tree is killed). Two reader threads
/// drain the pipes while this thread polls `try_wait`, so a hung process that
/// stops emitting still gets reaped instead of deadlocking a `read_line`.
fn run_streaming<F>(
    mut cmd: Command,
    timeout: Option<Duration>,
    mut on_line: F,
) -> Result<std::process::ExitStatus, String>
where
    F: FnMut(String),
{
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动命令: {e}"))?;
    let stdout = child.stdout.take().ok_or("无法捕获命令输出")?;
    let stderr = child.stderr.take().ok_or("无法捕获命令输出")?;
    let (sender, receiver) = mpsc::channel::<String>();
    let stderr_sender = sender.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if stderr_sender.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = timeout.map(|duration| Instant::now() + duration);
    loop {
        while let Ok(line) = receiver.try_recv() {
            on_line(line);
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            while let Ok(line) = receiver.try_recv() {
                on_line(line);
            }
            return Ok(status);
        }
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("操作超时".to_string());
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Make the spawned npm binary resolve `node` (and its own bin dir) even when
/// the app was launched from Finder/Dock with a minimal PATH, and optionally
/// pin the global prefix to the exact location the shell booted from.
fn apply_npm_env(cmd: &mut Command, prefix: Option<&Path>) {
    let node = host::resolve_node();
    if let Some(bin_dir) = node.parent() {
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let mut paths: Vec<PathBuf> = vec![bin_dir.to_path_buf()];
        paths.extend(std::env::split_paths(&existing));
        if let Ok(joined) = std::env::join_paths(&paths) {
            cmd.env("PATH", joined);
        }
    }
    if let Some(prefix) = prefix {
        cmd.env("npm_config_prefix", prefix);
    }
}

/// Derive the npm global prefix from the resolved dsh root, but only when the
/// on-disk layout is the standard `<prefix>/lib/node_modules/@deepseek-ai/dsh`
/// shape. Anything else (custom `DSH_DESKTOP_DSH_ROOT`) falls back to npm's own
/// configured global prefix.
fn npm_global_prefix(dsh_root: &Path) -> Option<PathBuf> {
    let scoped = dsh_root.parent()?;
    if scoped.file_name()? != OsStr::new("@deepseek-ai") {
        return None;
    }
    let node_modules = scoped.parent()?;
    if node_modules.file_name()? != OsStr::new("node_modules") {
        return None;
    }
    let lib = node_modules.parent()?;
    if lib.file_name()? != OsStr::new("lib") {
        return None;
    }
    lib.parent().map(Path::to_path_buf)
}

/// The installed dsh root plus its version, read straight from package.json.
pub fn local_dsh_version() -> Option<(PathBuf, String)> {
    let root = host::resolve_dsh_root()?;
    let package = root.join("package.json");
    let text = fs::read_to_string(package).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let version = normalize_version(value.get("version")?.as_str()?);
    if version.is_empty() {
        return None;
    }
    Some((root, version))
}

/// Run `npm view <pkg> <field> --json` synchronously and parse the result.
/// Returns `None` on non-zero exit, timeout, or unparseable JSON.
fn npm_view_json(npm: &Path, field: &str) -> Option<serde_json::Value> {
    let mut cmd = Command::new(npm);
    cmd.arg("view").arg(PKG_NAME).arg(field).arg("--json");
    apply_npm_env(&mut cmd, None);
    let mut out = String::new();
    let outcome = run_streaming(cmd, Some(CHECK_TIMEOUT), |line| {
        if out.len() < (1 << 20) {
            out.push_str(&line);
            out.push('\n');
        }
    });
    match outcome {
        Ok(status) if status.success() => serde_json::from_str(&out).ok(),
        _ => None,
    }
}

/// The `latest` dist-tag version (mirrors `npm view <pkg> version`). The shell
/// is a stable-channel consumer: prerelease channels like `next` are
/// deliberately NOT offered, so a rc published only under `next` stays
/// invisible until it is promoted to `latest`.
fn latest_version(force: bool) -> Option<String> {
    let cache = LATEST_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if !force {
        if let Some((at, version)) = cache.lock().unwrap().clone() {
            if at.elapsed() < CACHE_TTL {
                return Some(version);
            }
        }
    }
    let found = (|| {
        let npm = host::resolve_npm();
        let value = npm_view_json(&npm, "version")?;
        let raw = value.as_str()?;
        if !looks_like_version(raw) {
            return None;
        }
        Some(normalize_version(raw))
    })();
    if let Some(version) = &found {
        *cache.lock().unwrap() = Some((Instant::now(), version.clone()));
    }
    found
}

pub fn check_update(force: bool) -> DshVersionInfo {
    let (root, local) = match local_dsh_version() {
        Some((root, version)) => (Some(root), Some(version)),
        None => (host::resolve_dsh_root(), None),
    };
    let latest = latest_version(force);
    let error = if latest.is_none() {
        Some("无法获取 npm 仓库版本（网络或 npm 不可用）".to_string())
    } else {
        None
    };
    let update_available = match (&local, &latest) {
        (Some(local), Some(latest)) => version_is_newer(latest, local),
        _ => false,
    };
    DshVersionInfo {
        local_version: local,
        latest_version: latest,
        update_available,
        dsh_root: root.map(|path| path.display().to_string()),
        error,
    }
}

#[tauri::command]
pub async fn shell_check_update(force: Option<bool>) -> Result<DshVersionInfo, String> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || check_update(force))
        .await
        .map_err(|error| format!("版本检查任务失败: {error}"))
}

fn emit(app: &AppHandle, phase: &str, line: &str) {
    let _ = app.emit_to(
        "main",
        "dsh:update-progress",
        json!({ "phase": phase, "line": line }),
    );
}

fn run_update(app: AppHandle, updating: std::sync::Arc<AtomicBool>) {
    let guard = UpdateGuard(updating);

    emit(&app, "installing", "开始更新 @deepseek-ai/dsh …");

    let Some((root, local)) = local_dsh_version() else {
        emit(&app, "error", "找不到当前安装的 @deepseek-ai/dsh");
        return;
    };
    let npm = host::resolve_npm();
    let prefix = npm_global_prefix(&root);
    // Stable-channel install: always `@latest`, mirroring what the check reads.
    // A prerelease promoted to `latest` is what belongs on the user's machine;
    // `next`-only releases are never chased.
    let mut cmd = Command::new(&npm);
    cmd.arg("install")
        .arg("-g")
        .arg(format!("{PKG_NAME}@latest"));
    apply_npm_env(&mut cmd, prefix.as_deref());

    match run_streaming(cmd, None, |line| {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            emit(&app, "installing", trimmed);
        }
    }) {
        Ok(status) if status.success() => {}
        Ok(status) => {
            emit(
                &app,
                "error",
                &format!("更新失败：npm 退出码 {}", status.code().unwrap_or(-1)),
            );
            return;
        }
        Err(error) => {
            emit(&app, "error", &format!("更新失败：{error}"));
            return;
        }
    }

    let new_local = local_dsh_version()
        .map(|(_, version)| version)
        .unwrap_or_else(|| "unknown".to_string());
    emit(
        &app,
        "done",
        &format!("更新完成（{local} → {new_local}），正在热重启 …"),
    );

    // Release the update lock before requesting the restart: the restart
    // guard refuses to run while an install is in flight, and at this point
    // the npm process has fully exited and written every file to disk.
    drop(guard);

    if let Err(error) = crate::request_hot_restart(&app) {
        emit(&app, "error", &format!("更新完成，但热重启失败：{error}"));
    }
}

#[tauri::command]
pub fn shell_dsh_update(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    if state
        .updating
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("更新已在进行中".to_string());
    }
    let updating = state.updating.clone();
    std::thread::spawn(move || run_update(app, updating));
    Ok("updating".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prerelease_suffix_outranks_same_core() {
        // rc.8 is newer than rc.7 even though both share the 0.1.0 core.
        assert!(version_is_newer("0.1.0-rc.8", "0.1.0-rc.7"));
        assert!(!version_is_newer("0.1.0-rc.7", "0.1.0-rc.8"));
        assert!(!version_is_newer("0.1.0-rc.7", "0.1.0-rc.7"));
    }

    #[test]
    fn plain_beats_prerelease_on_equal_core() {
        assert!(version_is_newer("0.6.4", "0.6.4-rc.1"));
        assert!(!version_is_newer("0.6.4-rc.1", "0.6.4"));
    }

    #[test]
    fn core_triple_compares_numerically() {
        assert!(version_is_newer("0.10.0", "0.9.0"));
        assert!(version_is_newer("0.1.1-rc.1", "0.1.0-rc.9"));
        assert!(!version_is_newer("0.1.0-rc.9", "0.1.1-rc.1"));
    }

    #[test]
    fn prerelease_identifiers_follow_semver() {
        assert_eq!(compare_prerelease("rc.8", "rc.7"), std::cmp::Ordering::Greater);
        assert_eq!(compare_prerelease("rc.7", "rc.8"), std::cmp::Ordering::Less);
        assert_eq!(compare_prerelease("rc.1", "rc.1"), std::cmp::Ordering::Equal);
        assert_eq!(compare_prerelease("alpha.2", "beta.1"), std::cmp::Ordering::Less); // ascii a < b
        assert_eq!(compare_prerelease("rc", "rc.1"), std::cmp::Ordering::Less); // more fields win
        assert_eq!(compare_prerelease("rc.10", "rc.9"), std::cmp::Ordering::Greater); // numeric, not lexical
    }

    #[test]
    fn suffix_extraction_ignores_build_metadata() {
        assert_eq!(prerelease_suffix("0.1.0-rc.7"), "rc.7");
        assert_eq!(prerelease_suffix("0.1.0-rc.7+build-2"), "rc.7");
        assert_eq!(prerelease_suffix("0.1.0"), "");
    }
}