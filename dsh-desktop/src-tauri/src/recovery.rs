//! Startup-failure recovery, ported from the official desktop shell's
//! crash-report.ts + fatal-recovery.ts semantics:
//!
//! - one crash report per failure under `<app_log_dir>/crashes/`
//!   (`crash-<UTC timestamp>-<source>.log`), keeping the ten newest files;
//! - one native recovery dialog per process (exit / restart / disable
//!   third-party plugins and restart);
//! - "disable third-party plugins" is purely mechanical: rename the active
//!   profile's `cordis.patch.yml` to `cordis.patch.yml.bak-<unix-seconds>`
//!   without parsing it — the next boot recreates an empty patch, and the
//!   installed packages / earlier backups stay untouched.
//!
//! Everything is defensive: report or dialog failures only log, never panic.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use tauri::Manager;

const MAX_REPORTS: usize = 10;
const MAX_REPORT_BYTES: usize = 256 * 1024;
const MAX_HOST_LOG_TAIL_CHARS: usize = 64 * 1024;
const MAX_DIALOG_LINES: usize = 8;

static RECOVERY_DIALOG_SHOWN: AtomicBool = AtomicBool::new(false);

/// Write a crash report for a startup failure and open the recovery dialog.
/// `source` mirrors the official classification: `host` (sidecar exit /
/// boot failure), `web-boot`, `renderer`, `main`.
pub fn on_startup_failure(app: &tauri::AppHandle, source: &str, error: &str) {
    let report_path = write_crash_report(app, source, error);
    eprintln!(
        "dsh-desktop: startup failure ({source}): {error}; crash report: {}",
        report_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<unavailable>".to_string())
    );
    if RECOVERY_DIALOG_SHOWN
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // one recovery dialog per process
    }
    let handle = app.clone();
    let source = source.to_string();
    let error = error.to_string();
    // rfd blocks until answered; never run that on the main/event thread.
    std::thread::spawn(move || show_recovery_dialog(handle, source, error, report_path));
}

fn crashes_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|dir| dir.join("crashes"))
}

fn write_crash_report(
    app: &tauri::AppHandle,
    source: &str,
    error: &str,
) -> Option<PathBuf> {
    let dir = crashes_dir(app)?;
    if let Err(io_error) = std::fs::create_dir_all(&dir) {
        eprintln!("dsh-desktop: crash dir create failed: {io_error}");
        return None;
    }
    let ready = app
        .try_state::<crate::AppState>()
        .map(|state| state.bridge.ready().map(|r| r.error.is_none()).unwrap_or(false))
        .unwrap_or(false);
    let mut report = format!(
        "source: {source}\nhost reached ready: {ready}\napp version: {}\nplatform: {} {}\n\ndiagnostic:\n{}\n",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        truncate_chars(error, MAX_REPORT_BYTES),
    );
    if let Some(tail) = host_log_tail(app) {
        report.push_str("\n--- host stderr tail ---\n");
        report.push_str(&truncate_chars(&tail, MAX_REPORT_BYTES));
        report.push('\n');
    }
    let path = dir.join(format!(
        "crash-{}-{source}.log",
        crate::bridge::utc_timestamp_now()
    ));
    std::fs::write(&path, report).ok()?;
    prune_old_reports(&dir);
    Some(path)
}

/// Keep only the newest [`MAX_REPORTS`] crash files.
fn prune_old_reports(dir: &std::path::Path) {
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = match std::fs::read_dir(dir) {
        Ok(items) => items
            .filter_map(|item| {
                let path = item.ok()?.path();
                let meta = std::fs::metadata(&path).ok()?;
                if !path.is_file() || !path.file_name().is_some_and(|n| {
                    n.to_string_lossy().starts_with("crash-")
                }) {
                    return None;
                }
                Some((meta.modified().ok()?, path))
            })
            .collect(),
        Err(_) => return,
    };
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in entries.into_iter().skip(MAX_REPORTS) {
        let _ = std::fs::remove_file(path);
    }
}

/// Last `[dsh-host]` lines from the app log, bounded to a few KiB, so the
/// report carries the sidecar's own stderr tail.
fn host_log_tail(app: &tauri::AppHandle) -> Option<String> {
    let log = app
        .path()
        .app_log_dir()
        .ok()?
        .join("dsh-desktop.log");
    let content = std::fs::read_to_string(log).ok()?;
    let lines: Vec<&str> = content
        .lines()
        .filter(|line| line.contains("[dsh-host]"))
        .collect();
    let start = lines.len().saturating_sub(120);
    Some(truncate_chars(&lines[start..].join("\n"), MAX_HOST_LOG_TAIL_CHARS))
}

fn truncate_chars(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &text[..end])
}

/// Native three-button recovery dialog. rfd dispatches to the main thread
/// internally on macOS, so a dedicated helper thread is safe; the caller is
/// already off the UI thread.
fn show_recovery_dialog(
    app: tauri::AppHandle,
    source: String,
    error: String,
    report_path: Option<PathBuf>,
) {
    use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};

    let total_lines = error.lines().count();
    let mut body = error
        .lines()
        .take(MAX_DIALOG_LINES)
        .collect::<Vec<&str>>()
        .join("\n");
    if total_lines > MAX_DIALOG_LINES {
        body.push_str(&format!("\n… (+{} more lines)", total_lines - MAX_DIALOG_LINES));
    }
    if let Some(path) = &report_path {
        body.push_str(&format!("\n\ncrash report: {}", path.display()));
    }

    let result = MessageDialog::new()
        .set_title(crate::i18n::text(crate::i18n::Text::RecoveryTitle))
        .set_description(&body)
        .set_level(MessageLevel::Error)
        .set_buttons(MessageButtons::YesNoCancelCustom(
            crate::i18n::text(crate::i18n::Text::RecoveryRestart).to_string(),
            crate::i18n::text(crate::i18n::Text::RecoveryDisablePlugins).to_string(),
            crate::i18n::text(crate::i18n::Text::RecoveryExit).to_string(),
        ))
        .show();

    match result {
        MessageDialogResult::Yes => {
            append_recovery_log(&app, "recovery dialog: restart chosen");
            let _ = crate::shell_retry_startup(&app);
        }
        MessageDialogResult::No => {
            append_recovery_log(&app, "recovery dialog: disable third-party plugins chosen");
            match backup_cordis_patch(&app) {
                Ok(backup) => append_recovery_log(
                    &app,
                    &format!("recovery: profile patch backed up to {}", backup.display()),
                ),
                Err(problem) => append_recovery_log(
                    &app,
                    &format!("recovery: patch backup failed: {problem}"),
                ),
            }
            let _ = crate::shell_retry_startup(&app);
        }
        _ => {
            append_recovery_log(&app, "recovery dialog: exit chosen");
            crate::commands::finish_quit(&app);
        }
    }
    let _ = source; // already part of the report filename
}

fn append_recovery_log(app: &tauri::AppHandle, line: &str) {
    if let Ok(dir) = app.path().app_log_dir() {
        crate::bridge::append_log(&dir.join("dsh-desktop.log"), line.to_string());
    }
}

/// Rename `<home>/profiles/<profile>/cordis.patch.yml` to
/// `cordis.patch.yml.bak-<unix-seconds>` (ordinal on collisions). Returns the
/// backup path; a missing patch counts as success (nothing to back up).
pub fn backup_cordis_patch(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let profile = crate::envs::var("DSH_DESKTOP_PROFILE", "DSH_MAC_PROFILE")
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "web".to_string());
    let patch = crate::host::resolve_home()
        .join("profiles")
        .join(&profile)
        .join("cordis.patch.yml");
    if !patch.is_file() {
        append_recovery_log(
            app,
            &json!({"recoveryPatch": "absent", "profile": profile}).to_string(),
        );
        return Ok(patch); // nothing to disable; next boot recreates it if needed
    }
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let parent = patch.parent().ok_or("patch has no parent dir")?;
    let mut backup = parent.join(format!("cordis.patch.yml.bak-{seconds}"));
    let mut ordinal = 1u32;
    while backup.exists() {
        ordinal += 1;
        backup = parent.join(format!("cordis.patch.yml.bak-{seconds}.{ordinal}"));
        if ordinal > 1000 {
            return Err("backup ordinal overflow".to_string());
        }
    }
    std::fs::rename(&patch, &backup).map_err(|e| format!("rename failed: {e}"))?;
    Ok(backup)
}
