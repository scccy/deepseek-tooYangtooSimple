use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use tauri::Manager;

/// The desktop shell runs the USER's Node and the USER's globally installed
/// @deepseek-ai/dsh — never a bundled copy. One runtime, one dsh, one
/// ~/.dsh: the plugin ecosystem the CLI sees is exactly what the desktop
/// sees. Resolution is pure self-discovery: env overrides, standard install
/// prefixes, then a single login-shell probe. Nothing machine-specific is
/// hardcoded.
///
/// Probing a login shell costs hundreds of milliseconds, so every resolved
/// value is computed at most once.
const MIN_NODE_MAJOR: u64 = 20;

static NODE_PATH: OnceLock<PathBuf> = OnceLock::new();
static NPM_PATH: OnceLock<PathBuf> = OnceLock::new();
static DSH_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
static SHELL_PROBE: OnceLock<ShellProbe> = OnceLock::new();

/// One login-shell round trip discovers both the node binary and the global
/// npm root (nvm/fnm/volta shims only exist inside a login shell).
struct ShellProbe {
    node: Option<PathBuf>,
    npm_root: Option<PathBuf>,
}

fn shell_probe() -> &'static ShellProbe {
    SHELL_PROBE.get_or_init(|| {
        let fallback = ShellProbe {
            node: None,
            npm_root: None,
        };
        let Ok(output) = Command::new("/bin/zsh")
            .arg("-lc")
            .arg("command -v node; npm root -g 2>/dev/null")
            .output()
        else {
            return fallback;
        };
        let Ok(text) = String::from_utf8(output.stdout) else {
            return fallback;
        };
        let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
        let first = lines.next().map(PathBuf::from);
        let second = lines.next().map(PathBuf::from);
        // If node is missing, the first line is npm's answer — disambiguate
        // by shape instead of position.
        let (node, npm_root) = match (&first, &second) {
            (Some(a), Some(b)) if a.file_name().map(|n| n == "node").unwrap_or(false) => {
                (first, Some(b.clone()))
            }
            (Some(a), None) if a.file_name().map(|n| n == "node").unwrap_or(false) => (first, None),
            (Some(_), None) => (None, first),
            _ => (None, None),
        };
        ShellProbe { node, npm_root }
    })
}

/// Resolve the `node` binary: env override, standard prefixes, login-shell
/// probe, then bare PATH.
pub fn resolve_node() -> PathBuf {
    NODE_PATH.get_or_init(resolve_node_uncached).clone()
}

fn resolve_node_uncached() -> PathBuf {
    if let Ok(value) = std::env::var("DSH_MAC_NODE") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/local/bin/node",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    if let Some(node) = &shell_probe().node {
        return node.clone();
    }
    PathBuf::from("node")
}

/// Resolve the `npm` binary that manages the same global prefix the shell
/// boots from: the sibling next to the resolved node, an env override, then a
/// login-shell probe (npm is a shell-script wrapper / shim that only appears
/// inside a login shell under nvm/fnm/volta).
pub fn resolve_npm() -> PathBuf {
    NPM_PATH.get_or_init(resolve_npm_uncached).clone()
}

fn resolve_npm_uncached() -> PathBuf {
    if let Ok(value) = std::env::var("DSH_MAC_NPM") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    let node = resolve_node();
    if let Some(bin_dir) = node.parent() {
        let npm = bin_dir.join("npm");
        if npm.is_file() {
            return npm;
        }
    }
    if let Ok(output) = Command::new("/bin/zsh")
        .arg("-lc")
        .arg("command -v npm")
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
            return PathBuf::from(line);
        }
    }
    PathBuf::from("npm")
}

/// A dsh package root must contain both package.json and lib/bin.js.
fn valid_dsh_root(path: &Path) -> bool {
    path.join("package.json").is_file() && path.join("lib").join("bin.js").is_file()
}

/// Resolve the @deepseek-ai/dsh package root. Order: env overrides, derive
/// from the resolved node prefix (<prefix>/lib/node_modules/@deepseek-ai/dsh
/// — covers Homebrew, the official installer and nvm-style layouts), the
/// probed global npm root, then standard fixed locations.
pub fn resolve_dsh_root() -> Option<PathBuf> {
    DSH_ROOT.get_or_init(resolve_dsh_root_uncached).clone()
}

fn resolve_dsh_root_uncached() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("DSH_MAC_DSH_ROOT") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    if let Ok(value) = std::env::var("DSH_MAC_DSH_BIN") {
        if !value.trim().is_empty() {
            let bin = PathBuf::from(value);
            if let Some(root) = root_from_bin(&bin) {
                return Some(root);
            }
        }
    }
    // <prefix>/bin/node -> <prefix>/lib/node_modules/@deepseek-ai/dsh
    let node = resolve_node();
    if let Some(prefix) = node.parent().and_then(Path::parent) {
        let derived = prefix
            .join("lib")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh");
        if valid_dsh_root(&derived) {
            return Some(derived);
        }
    }
    if let Some(npm_root) = &shell_probe().npm_root {
        let probed = npm_root.join("@deepseek-ai").join("dsh");
        if valid_dsh_root(&probed) {
            return Some(probed);
        }
    }
    for candidate in [
        "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh",
        "/usr/local/lib/node_modules/@deepseek-ai/dsh",
    ] {
        let path = PathBuf::from(candidate);
        if valid_dsh_root(&path) {
            return Some(path);
        }
    }
    None
}

fn root_from_bin(bin: &Path) -> Option<PathBuf> {
    let normalized = bin.to_string_lossy().replace('\\', "/");
    let marker = "/node_modules/@deepseek-ai/dsh/lib/bin.js";
    if let Some(idx) = normalized.rfind(marker) {
        return Some(PathBuf::from(
            &normalized[..idx + marker.len() - "/lib/bin.js".len()],
        ));
    }
    bin.canonicalize().ok().and_then(|p| {
        if p.ends_with("lib/bin.js") {
            p.parent()?.parent()?.parent()?.to_owned().into()
        } else {
            None
        }
    })
}

/// Refuse to boot on a Node older than the supported floor — a clear error
/// on the splash page beats a cryptic sidecar crash.
fn check_node_version(node: &Path) -> Result<(), String> {
    let output = Command::new(node)
        .arg("--version")
        .output()
        .map_err(|e| format!("无法执行 {}：{e}", node.display()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.trim().trim_start_matches('v');
    let major: u64 = version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if major < MIN_NODE_MAJOR {
        return Err(format!(
            "Node 版本过旧（{text}）：需要 Node ≥ {MIN_NODE_MAJOR}，请升级后重启应用"
        ));
    }
    Ok(())
}

/// The portless host sidecar script. Debug builds prefer the live repository
/// copy (editing sidecar.mjs only requires an app relaunch); release builds
/// use the bundle resource, falling back to the repo layout.
pub fn resolve_host_script(app: &tauri::AppHandle) -> Option<PathBuf> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host")
        .join("sidecar.mjs");
    #[cfg(debug_assertions)]
    {
        if repo.is_file() {
            return Some(repo);
        }
    }
    for candidate in [
        app.path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join("host").join("sidecar.mjs")),
        Some(repo),
    ] {
        if let Some(path) = candidate {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub fn resolve_home() -> PathBuf {
    if let Ok(value) = std::env::var("DSH_HOME") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    if let Ok(value) = std::env::var("DSH_MAC_HOME") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".dsh")
}

pub struct SpawnedHost {
    pub child: Child,
}

pub fn spawn_sidecar(app: &tauri::AppHandle, www_dir: &Path) -> Result<SpawnedHost, String> {
    let node = resolve_node();
    check_node_version(&node)?;
    let dsh_root = resolve_dsh_root().ok_or_else(|| {
        "找不到全局安装的 @deepseek-ai/dsh，请先运行 npm i -g @deepseek-ai/dsh".to_string()
    })?;
    let script = resolve_host_script(app)
        .ok_or_else(|| "找不到 host/sidecar.mjs（未随包分发且仓库布局缺失）".to_string())?;
    let home = resolve_home();
    let cwd = std::env::var("DSH_MAC_CWD")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.clone());

    let version = app.package_info().version.to_string();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("DSH_MAC_DSH_ROOT", &dsh_root)
        .env("DSH_MAC_WWW_DIR", www_dir)
        .env("DSH_HOME", &home)
        .env("DSH_MAC_CWD", &cwd)
        .env("DSH_MAC_APP_VERSION", &version)
        .env("DSH_TELEMETRY_DISABLED", "1")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 Node host sidecar ({}): {e}", node.display()))?;
    Ok(SpawnedHost { child })
}

/// Terminate the Node sidecar and its whole process group (agent shell
/// sessions are grandchildren). SIGTERM first, then SIGKILL after a grace
/// period.
pub fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::killpg(pid, libc::SIGTERM);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = child.kill();
    }

    // The child window owns graceful disposal; do not block the UI too long,
    // then make sure the process group is gone.
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(150));
    }
    #[cfg(target_os = "macos")]
    {
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
