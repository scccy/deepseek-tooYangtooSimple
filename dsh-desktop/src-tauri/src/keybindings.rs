//! Configurable keyboard shortcuts (batch 4), mirroring the official
//! `packages/client/shortcuts` semantics:
//!
//! - bindings live in `<app_data_dir>/keybindings.json` (app userData, never
//!   DSH_HOME), shape: `{ "version": 1, "bindings": { "<command>":
//!   "<accelerator>" } }`;
//! - the main process validates before publishing: unknown commands, bad
//!   accelerators and non-object files are dropped; a file that fails to read
//!   or parse keeps the last accepted bindings and blocks edits (including
//!   Restore All) until it is fixed manually;
//! - dispatch happens through the page-level chord listener which invokes
//!   `shell_dispatch_shortcut` for completed chords; the first key of a
//!   two-key chord stays available to the page.
//!
//! v1 command set keeps the surface small: reloadPage, toggleDevtools,
//! minimize, closePage, quit.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::Manager;

/// The accepted command set (closed: unknown keys are dropped at validation).
pub const COMMANDS: [&str; 5] = [
    "reloadPage",
    "toggleDevtools",
    "minimize",
    "closePage",
    "quit",
];

fn default_binding(command: &str) -> &'static str {
    match command {
        "reloadPage" => "CmdOrCtrl+R",
        "toggleDevtools" => "F12",
        "minimize" => "CmdOrCtrl+M",
        "closePage" => "CmdOrCtrl+W",
        "quit" => "CmdOrCtrl+Q",
        _ => "",
    }
}

struct Store {
    bindings: BTreeMap<String, String>,
    /// A malformed/unreadable file blocks edits (and Restore All) — the last
    /// accepted bindings stay active.
    blocked: bool,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| {
        Mutex::new(Store {
            bindings: default_bindings(),
            blocked: false,
        })
    })
}

fn default_bindings() -> BTreeMap<String, String> {
    COMMANDS
        .iter()
        .map(|c| ((*c).to_string(), default_binding(c).to_string()))
        .collect()
}

pub fn is_blocked() -> bool {
    store().lock().unwrap().blocked
}

pub fn bindings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("keybindings.json"))
}

/// Valid accelerator: modifiers + one key, `+`-separated. Deliberately
/// permissive about key names (Chromium key values), strict about structure.
fn valid_accelerator(value: &str) -> bool {
    let parts: Vec<&str> = value.split('+').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.len() > 4 {
        return false;
    }
    let modifiers = ["CmdOrCtrl", "CommandOrControl", "Cmd", "Ctrl", "Alt", "Shift", "Meta", "Super"];
    let Some((key, mods)) = parts.split_last() else {
        return false;
    };
    // Every leading part must be a known modifier; the key may be a letter,
    // an F-key (F1..F24) or a named key (Enter, Tab, ArrowUp, ...).
    if !mods.iter().all(|p| modifiers.contains(p)) {
        return false;
    }
    let key = *key;
    !key.is_empty()
        && key.chars().all(|c| c.is_ascii_alphanumeric())
        && !key.chars().all(|c| c.is_ascii_digit())
}

/// Load + validate the persisted bindings; falls back to defaults on a
/// missing/invalid file. Invalid content also flags the store blocked.
pub fn load(app: &tauri::AppHandle) {
    let Some(path) = bindings_path(app) else { return };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return, // defaults
        Err(_) => {
            store().lock().unwrap().blocked = true;
            return;
        }
    };
    let parsed: Result<Value, _> = serde_json::from_str(&raw);
    let Ok(Value::Object(root)) = parsed else {
        store().lock().unwrap().blocked = true;
        eprintln!("dsh-desktop: keybindings.json malformed; last bindings kept, edits blocked");
        return;
    };
    if root.get("version").and_then(Value::as_i64) != Some(1) {
        store().lock().unwrap().blocked = true;
        return;
    }
    let accepted = validate_map(root.get("bindings"));
    let mut guard = store().lock().unwrap();
    guard.bindings = accepted;
    guard.blocked = false;
}

fn validate_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = default_bindings();
    let Some(Value::Object(map)) = value else { return out };
    for (command, accelerator) in map {
        let Some(accelerator) = accelerator.as_str() else { continue };
        if !COMMANDS.contains(&command.as_str()) {
            continue;
        }
        if valid_accelerator(accelerator) {
            out.insert(command.clone(), accelerator.to_string());
        }
    }
    out
}

/// Current bindings snapshot (for the page chord listener and menus).
pub fn snapshot() -> BTreeMap<String, String> {
    store().lock().unwrap().bindings.clone()
}

/// Persist `bindings` (validated merge) and publish. Returns Err("blocked")
/// while the store is blocked.
pub fn update(app: &tauri::AppHandle, bindings: &Value) -> Result<Value, String> {
    let mut guard = store().lock().unwrap();
    if guard.blocked {
        return Err("blocked".to_string());
    }
    guard.bindings = validate_map(Some(bindings));
    let payload = json!({
        "version": 1,
        "bindings": guard.bindings,
    });
    if let Some(path) = bindings_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&path, payload.to_string())
            .map_err(|e| format!("keybindings write failed: {e}"))?;
    }
    Ok(payload)
}

/// Restore defaults: blocked while the store is blocked.
pub fn restore_all(app: &tauri::AppHandle) -> Result<Value, String> {
    let mut guard = store().lock().unwrap();
    if guard.blocked {
        return Err("blocked".to_string());
    }
    guard.bindings = default_bindings();
    let payload = json!({ "version": 1, "bindings": guard.bindings });
    if let Some(path) = bindings_path(app) {
        let _ = std::fs::write(&path, payload.to_string());
    }
    Ok(payload)
}

/// Chord-listener source handed to the page: resolves completed chords
/// locally and invokes `shell_dispatch_shortcut` for accepted commands.
/// Two-key chords keep the first key's default page behavior.
pub fn chord_listener_js() -> String {
    let bindings = serde_json::to_string(&snapshot()).unwrap_or_else(|_| "{}".into());
    format!(
        r#"
(function () {{
  if (window.__DSH_CHORDS__) return;
  window.__DSH_CHORDS__ = true;
  var bindings = {bindings};
  function norm(e) {{
    var parts = [];
    if (e.ctrlKey || e.metaKey) parts.push("CmdOrCtrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    var key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    parts.push(key);
    return parts.join("+");
  }}
  document.addEventListener("keydown", function (e) {{
    if (e.isComposing) return;
    var combo = norm(e);
    for (var command in bindings) {{
      if (bindings[command] === combo) {{
        e.preventDefault();
        var core = window.__TAURI__ && window.__TAURI__.core;
        if (core) core.invoke("shell_dispatch_shortcut", {{ command: command }});
        return;
      }}
    }}
  }}, true);
}})();
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validators_accept_sane_accelerators() {
        assert!(valid_accelerator("CmdOrCtrl+R"));
        assert!(valid_accelerator("F12"));
        assert!(valid_accelerator("Alt+Shift+K"));
        assert!(!valid_accelerator("123"));
        assert!(!valid_accelerator(""));
        assert!(!valid_accelerator("Ctrl+Shift+Alt+Cmd+X"));
    }

    #[test]
    fn validate_map_drops_unknown_commands() {
        let map: Value = serde_json::from_str(
            r#"{"reloadPage":"CmdOrCtrl+Shift+R","hack":"CmdOrCtrl+X","bogus":"x"}"#,
        )
        .unwrap();
        let out = validate_map(Some(&map));
        assert_eq!(out.get("reloadPage").unwrap(), "CmdOrCtrl+Shift+R");
        assert!(out.get("hack").is_none());
        // untouched commands keep their defaults
        assert_eq!(out.get("quit").unwrap(), "CmdOrCtrl+Q");
    }
}
