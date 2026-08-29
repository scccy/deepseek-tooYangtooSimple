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
/// Background children get the same treatment: GUI processes boot from
/// launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so toolchains the
/// user installed for their shell (cargo, conda, java, maven...) are
/// invisible even though they work in Terminal. One interactive-login-shell
/// round trip captures the user's real environment (`-lic` sources .zshrc
/// too, which `-lc` skips) and we re-inject it into the sidecar, so agent
/// sessions and background tasks see exactly what Terminal sees — no sudo,
/// nothing for the user to configure.
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

/// 选一个可用的 POSIX shell（macOS 优先 zsh，Linux 优先 bash；尊重 SHELL）。
#[cfg(unix)]
fn preferred_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .filter(|s| Path::new(s).is_file())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        })
}

fn shell_probe() -> &'static ShellProbe {
    SHELL_PROBE.get_or_init(|| {
        let fallback = ShellProbe {
            node: None,
            npm_root: None,
        };
        // nvm/fnm/volta 的 shim 只在 login shell 中可见；Windows 没有 login
        // shell，改用 cmd 的 where/npm。
        #[cfg(windows)]
        let probe_output = Command::new("cmd")
            .args(["/C", "where node & npm root -g"])
            .output();
        #[cfg(unix)]
        let probe_output = {
            let shell = preferred_shell();
            Command::new(&shell)
                .arg("-lc")
                .arg("command -v node; npm root -g 2>/dev/null")
                .output()
        };
        let Ok(output) = probe_output else {
            return fallback;
        };
        let Ok(text) = String::from_utf8(output.stdout) else {
            return fallback;
        };
        let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
        let first = lines.next().map(PathBuf::from);
        let second = lines.next().map(PathBuf::from);
        // If node is missing, the first line is npm's answer — disambiguate
        // by shape instead of position (Windows 二进制名是 node.exe)。
        let is_node_path =
            |p: &PathBuf| p.file_name().map(|n| n == "node" || n == "node.exe").unwrap_or(false);
        let (node, npm_root) = match (&first, &second) {
            (Some(a), Some(b)) if is_node_path(a) => (first, Some(b.clone())),
            (Some(a), None) if is_node_path(a) => (first, None),
            (Some(_), None) => (None, first),
            _ => (None, None),
        };
        ShellProbe { node, npm_root }
    })
}

/// The environment background children should inherit. GUI processes get
/// launchd's bare PATH, so we re-inject what the user actually sees in a
/// terminal: PATH plus a small whitelist (JAVA_HOME / MAVEN_HOME / proxies).
/// Secrets the shell may export are deliberately NOT captured — keep the
/// blast radius of agent subprocesses minimal.
struct ShellEnv {
    path: Option<String>,
    java_home: Option<String>,
    maven_home: Option<String>,
    http_proxy: Option<String>,
    https_proxy: Option<String>,
}

static SHELL_ENV: OnceLock<Option<ShellEnv>> = OnceLock::new();

fn shell_env() -> Option<&'static ShellEnv> {
    SHELL_ENV.get_or_init(probe_shell_env).as_ref()
}

/// 用交互式登录 shell 读用户真实环境。`-lic` 会连同 .zshrc 一起 source
/// （很多安装器——conda init / nvm / fnm——把 PATH 写进 .zshrc，非交互的
/// `-lc` 会漏掉）。每行以 `__DSH_*=` 标记输出，rc 文件里的杂音被过滤掉。
/// Windows 无此问题（GUI 进程天然继承 user+system 环境变量），返回 None。
fn probe_shell_env() -> Option<ShellEnv> {
    #[cfg(not(unix))]
    {
        return None;
    }
    #[cfg(unix)]
    {
        let shell = preferred_shell();
        let command = r#"printf '__DSH_PATH__=%s\n__DSH_JAVA_HOME__=%s\n__DSH_MAVEN_HOME__=%s\n__DSH_HTTP_PROXY__=%s\n__DSH_HTTPS_PROXY__=%s\n' "$PATH" "$JAVA_HOME" "$MAVEN_HOME" "$HTTP_PROXY" "$HTTPS_PROXY""#;
        let output = Command::new(&shell).arg("-lic").arg(command).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut env = ShellEnv {
            path: None,
            java_home: None,
            maven_home: None,
            http_proxy: None,
            https_proxy: None,
        };
        for line in text.lines() {
            let Some((key, value)) = line.trim().split_once('=') else {
                continue;
            };
            match key {
                "__DSH_PATH__" => env.path = Some(value.trim().to_string()),
                "__DSH_JAVA_HOME__" => env.java_home = Some(value.trim().to_string()),
                "__DSH_MAVEN_HOME__" => env.maven_home = Some(value.trim().to_string()),
                "__DSH_HTTP_PROXY__" => env.http_proxy = Some(value.trim().to_string()),
                "__DSH_HTTPS_PROXY__" => env.https_proxy = Some(value.trim().to_string()),
                _ => {}
            }
        }
        Some(env)
    }
}

/// 把登录 shell 的真实环境注入子进程（PATH + 白名单变量）。探测失败时
/// 什么都不改，保持继承 launchd 环境的原有行为。
fn inject_shell_env(cmd: &mut Command) {
    let Some(env) = shell_env() else {
        return;
    };
    if let Some(path) = env.path.as_deref().filter(|p| !p.trim().is_empty()) {
        cmd.env("PATH", path);
    }
    for (key, value) in [
        ("JAVA_HOME", env.java_home.as_deref()),
        ("MAVEN_HOME", env.maven_home.as_deref()),
        ("HTTP_PROXY", env.http_proxy.as_deref()),
        ("HTTPS_PROXY", env.https_proxy.as_deref()),
    ] {
        if let Some(v) = value.filter(|v| !v.trim().is_empty()) {
            cmd.env(key, v);
        }
    }
}

/// Resolve the `node` binary: env override, standard prefixes, login-shell
/// probe, then bare PATH.
pub fn resolve_node() -> PathBuf {
    NODE_PATH.get_or_init(resolve_node_uncached).clone()
}

/// 标准安装前缀中的 node 路径（按平台）。
/// Windows 没有固定前缀，交给 cmd 的 `where node` 探测。
fn node_prefix_candidates() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node"]
    }
    #[cfg(target_os = "linux")]
    {
        &["/usr/bin/node", "/usr/local/bin/node", "/opt/node/bin/node"]
    }
    #[cfg(target_os = "windows")]
    {
        &[]
    }
}

/// 全局 npm 前缀下 @deepseek-ai/dsh 的标准位置（按平台）。
/// Windows 没有固定全局前缀，交给 `npm root -g` 探测。
fn dsh_root_candidates() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &[
            "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh",
            "/usr/local/lib/node_modules/@deepseek-ai/dsh",
        ]
    }
    #[cfg(target_os = "linux")]
    {
        &[
            "/usr/lib/node_modules/@deepseek-ai/dsh",
            "/usr/local/lib/node_modules/@deepseek-ai/dsh",
        ]
    }
    #[cfg(target_os = "windows")]
    {
        &[]
    }
}

fn resolve_node_uncached() -> PathBuf {
    if let Some(value) = crate::envs::var("DSH_DESKTOP_NODE", "DSH_MAC_NODE") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    for candidate in node_prefix_candidates() {
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
    if let Some(value) = crate::envs::var("DSH_DESKTOP_NPM", "DSH_MAC_NPM") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    let node = resolve_node();
    if let Some(bin_dir) = node.parent() {
        // Windows 上 npm 是 npm.cmd；Unix 是名为 npm 的 shell 脚本。
        #[cfg(windows)]
        let npm = bin_dir.join("npm.cmd");
        #[cfg(not(windows))]
        let npm = bin_dir.join("npm");
        if npm.is_file() {
            return npm;
        }
    }
    if let Some(line) = probe_npm_path() {
        return line;
    }
    #[cfg(windows)]
    let bare = "npm.cmd";
    #[cfg(not(windows))]
    let bare = "npm";
    PathBuf::from(bare)
}

/// 在 login shell 中探测 npm 路径（Windows 用 cmd 的 where）。
fn probe_npm_path() -> Option<PathBuf> {
    #[cfg(windows)]
    let output = Command::new("cmd").arg("/C").arg("where npm").output();
    #[cfg(unix)]
    let output = {
        let shell = preferred_shell();
        Command::new(&shell).arg("-lc").arg("command -v npm").output()
    };
    let output = output.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
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
    if let Some(value) = crate::envs::var("DSH_DESKTOP_DSH_ROOT", "DSH_MAC_DSH_ROOT") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    if let Some(value) = crate::envs::var("DSH_DESKTOP_DSH_BIN", "DSH_MAC_DSH_BIN") {
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
    for candidate in dsh_root_candidates() {
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
///
/// Windows 上的已知坑：`resource_dir()` 返回 exe 所在目录（Tauri 把
/// `bundle.resources` 直接放进 exe 目录），且存在 `resources/` 层级变体；
/// 某些安装形态下路径解析可能把盘符根（如 `C:`）当成目录——这里逐一探测
/// 候选并拒绝"没有文件名"的坏路径，并把每个候选写进 dsh-desktop.log。
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
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        // macOS: Contents/Resources；Windows: exe 目录。两种布局都探测。
        candidates.push(dir.join("host").join("sidecar.mjs"));
        candidates.push(dir.join("resources").join("host").join("sidecar.mjs"));
    }
    candidates.push(repo);

    for path in &candidates {
        trace_host_script(app, path);
        // 防御：`C:` 这类没有文件名的路径不能被当成脚本喂给 node（会
        // lstat('C:') 直接崩）——宁可报错也不要裸崩。
        if path.file_name().is_some() && path.is_file() {
            return Some(path.clone());
        }
    }
    None
}

/// 把每个脚本候选与解析结果写进 dsh-desktop.log，便于在 Windows 端定位
/// "sidecar 路径被算成 C:" 的真实来源。
fn trace_host_script(app: &tauri::AppHandle, path: &Path) {
    if let Ok(dir) = app.path().app_log_dir() {
        crate::bridge::append_log(
            &dir.join("dsh-desktop.log"),
            format!(
                "dsh-desktop: host script candidate: {} (is_file={}, file_name={:?})",
                path.display(),
                path.is_file(),
                path.file_name().map(|n| n.to_string_lossy().into_owned())
            ),
        );
    }
}

pub fn resolve_home() -> PathBuf {
    if let Ok(value) = std::env::var("DSH_HOME") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    if let Some(value) = crate::envs::var("DSH_DESKTOP_HOME", "DSH_MAC_HOME") {
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
    let script = resolve_host_script(app).ok_or_else(|| {
        "找不到 host/sidecar.mjs（未随包分发且仓库布局缺失）".to_string()
    })?;
    // 二次防御：脚本必须存在且是带文件名的常规文件，否则给出可读错误
    // 而不是把坏路径（如 Windows 盘符根 `C:`）传给 node 崩掉。
    if script.file_name().is_none() || !script.is_file() {
        return Err(format!(
            "host/sidecar.mjs 无效（{}），请重新安装桌面版",
            script.display()
        ));
    }
    let home = resolve_home();
    let cwd = crate::envs::var("DSH_DESKTOP_CWD", "DSH_MAC_CWD")
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.clone());

    let version = app.package_info().version.to_string();
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .env("DSH_DESKTOP_DSH_ROOT", &dsh_root)
        .env("DSH_DESKTOP_WWW_DIR", www_dir)
        .env("DSH_HOME", &home)
        .env("DSH_DESKTOP_CWD", &cwd)
        .env("DSH_DESKTOP_APP_VERSION", &version)
        .env("DSH_TELEMETRY_DISABLED", "1");
    // Re-inject the user's real login-shell environment: launchd hands GUI
    // processes a bare PATH, so without this every background child (agent
    // sessions, shell tasks) would fail to find cargo/node/java/conda/mvn
    // even though Terminal sees them fine.
    inject_shell_env(&mut cmd);
    cmd.current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP：sidecar 与 agent 子进程归入独立组，
        // 供 taskkill /T 整树回收。
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
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
    // 先温和终止：POSIX 向进程组发 SIGTERM；Windows 没有信号，直接对整棵
    // 进程树 taskkill（sidecar 的 agent 会话是孙进程）。
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    // The child window owns graceful disposal; do not block the UI too long,
    // then make sure the process group is gone.
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(150));
    }
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}
