pub mod status;
pub mod utils;
pub(crate) mod win_inspector;
#[cfg(windows)]
pub(crate) mod win_spawn;

use crate::config;
use crate::service::download;
use crate::service::workflow::utils::{is_dsh_running, is_port_in_use, spawn_output_readers};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// 启动守卫：并发调用 `launch` 时只允许一个真正拉起 dsh 进程
static LAUNCH_GUARD: AtomicBool = AtomicBool::new(false);

/// 强制结束占用指定端口的进程（用于停止服务或清理僵尸进程）
fn kill_port_holder(port: u16) {
    #[cfg(unix)]
    {
        // 使用 lsof 找到占用端口的进程并强制结束
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("lsof -ti:{} | xargs kill -9", port))
            .output();
    }

    #[cfg(windows)]
    {
        // 使用 PowerShell 找到占用端口的进程，再通过 taskkill /T 结束整个进程树。
        // dsh 会派生 node worker 子进程，若只杀端口占用者，子进程仍会锁定原生
        // 模块 DLL（如 sharp 的 libvips-42.dll），导致重新解压失败。
        let ps_cmd = format!(
            "$ids = Get-NetTCPConnection -LocalPort {} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($id in $ids) {{ taskkill /PID $id /T /F 2>$null }}",
            port
        );

        let mut cmd = Command::new("powershell");
        // 使用 -WindowStyle Hidden 和 -NoProfile -NonInteractive 确保不显示窗口
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps_cmd,
        ]);

        // 隐藏 PowerShell 窗口，避免弹出黑色控制台窗口
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // 重定向 stdout 和 stderr 到空，进一步确保不显示窗口
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        if let Err(e) = cmd.output() {
            log::error!("Failed to kill port holder: {}", e);
        }
    }
}

/// 结束本应用（AppData 目录）下由 dsh 拉起的 node 进程。
///
/// sharp 等原生模块 DLL 会被 node 及其子进程加载并锁定。服务崩溃或失去响应时
/// HTTP 探测不到，但这些进程仍持有 DLL；仅杀端口占用者会漏掉不再监听端口的
/// 子进程。这里通过可执行文件路径或命令行是否位于 AppData 目录来识别。
#[cfg(windows)]
fn kill_dsh_processes(base_dir: &Path) {
    let base = base_dir.to_string_lossy().to_string();
    let ps_cmd = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {{ ($_.ExecutablePath -like '{base}\\*') -or ($_.CommandLine -like '*{base}\\*') }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    );

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &ps_cmd,
    ]);

    // 隐藏 PowerShell 窗口，避免弹出黑色控制台窗口
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    if let Err(e) = cmd.output() {
        log::error!("Failed to kill dsh processes: {}", e);
    }
}

/// 结束本应用（AppData 目录）下由 dsh 拉起的 node 进程（Unix 分支）。
///
/// Windows 上这些进程会锁原生模块 DLL；macOS/Linux 上虽然不锁 DLL，但 dsh 派生
/// 的 worker 子进程会持有 `dependencies/dsh` 与 `runtime` 目录下的文件句柄——
/// 若在更新/重解压期间仍存活，会与 `ensure_extract` 的删除-重写产生竞态，留下
/// 半写坏的安装目录（对应 issue #21「更新闪退、装推荐插件闪退后环境损坏」）。
///
/// 这里按“命令行中包含本应用布局标记”来匹配（dsh 入口 `dependencies/dsh` 与
/// 捆绑运行时 `runtime`），只清理本应用派生进程，绝不使用 `pkill -9 node`
/// 误杀用户自己运行的 node。pkill 以单个 argv 传入，无 shell 参与，空格安全。
#[cfg(not(windows))]
fn kill_dsh_processes(base_dir: &Path) {
    let base = base_dir.to_string_lossy();
    for marker in [format!("{base}/dependencies/dsh"), format!("{base}/runtime")] {
        let _ = Command::new("pkill")
            .args(["-9", "-f", &marker])
            .output();
    }
}

/// 检测并启动 Harness 服务
pub async fn start(app_handle: tauri::AppHandle) -> Result<(), String> {
    let setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    let dsh_binary_path = config::get_dsh_binary_path(&app_handle);

    if !setting.installed {
        log::debug!("Harness not installed, skipping startup");
        return Ok(());
    }
    if !node_binary_path.exists() || !dsh_binary_path.exists() {
        let mut setting = config::get_store_dat_setting(&app_handle);
        setting.installed = false;
        config::set_store_dat_setting(&app_handle, setting);
        log::debug!("Harness not installed, skipping startup");
        return Ok(());
    }

    log::debug!("Checking Harness running status");
    let port_in_use = is_port_in_use(setting.port);
    let dsh_running = is_dsh_running(setting.port).await;

    if port_in_use && !dsh_running {
        log::info!("Harness is not running, but port is in use, stopping harness");
        stop(app_handle.clone()).await?;
        return Ok(());
    }

    if dsh_running {
        log::info!("Harness is already running");
        status::set_status(status::Status::Running);
        status::emit_status(&app_handle);
        return Ok(());
    }

    log::info!("Starting Harness service");
    status::set_status(status::Status::Starting);
    status::emit_status(&app_handle);
    launch(app_handle).await?;
    // 之后由 scheduler/task/tick_check_dsh_process/mod.rs 检测状态

    Ok(())
}

/// 重启 Harness 服务
pub async fn restart(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Restarting Harness service");

    // 1. 停止现有服务
    stop(app_handle.clone()).await?;

    // 2. 重新启动
    start(app_handle).await?;

    Ok(())
}

/// 启动 Harness 服务进程
pub async fn launch(app_handle: tauri::AppHandle) -> Result<(), String> {
    let setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    let dsh_binary_path = config::get_dsh_binary_path(&app_handle);

    log::debug!("Checking Node.js path: {:?}", node_binary_path);
    if !node_binary_path.exists() {
        log::error!("Node.js not installed");
        return Err("NODE_NOT_FOUND: Node.js not installed".to_string());
    }
    log::debug!("Checking Harness path: {:?}", dsh_binary_path);
    if !dsh_binary_path.exists() {
        log::error!("Harness not installed");
        return Err("HARNESS_NOT_FOUND: Harness not installed".to_string());
    }

    // 避免重复启动（配合启动守卫，确保并发调用只拉起一个进程）
    if is_dsh_running(setting.port).await {
        log::info!("Harness is already running, skipping launch");
        return Ok(());
    }
    if LAUNCH_GUARD.swap(true, Ordering::SeqCst) {
        log::info!("Harness launch already in progress, skipping");
        return Ok(());
    }

    // 端口被占用但服务未响应：先清理僵尸进程，避免 dsh EADDRINUSE 崩溃
    if is_port_in_use(setting.port) {
        log::warn!(
            "Port {} is occupied but harness is not responding, cleaning up",
            setting.port
        );
        kill_port_holder(setting.port);
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }

    // 清理上次可能残留的本应用 dsh 进程，避免命令行/端口复用竞态。
    // 注意只按本应用布局标记匹配，绝不使用旧的 `pkill -9 node`（会误杀用户
    // 自己运行的 node，尤其 macOS 上常见）。
    kill_dsh_processes(&config::get_base_dir(&app_handle));

    // 构造环境变量：隔离的 $DSH_HOME + 隐私默认（关闭遥测）
    let dsh_home = config::get_dsh_data_path(&app_handle);
    fs::create_dir_all(&dsh_home).map_err(|e| format!("create dsh home failed: {e}"))?;

    // Windows 极简模式修复的自愈：插件已装入 profile 时确保 patch 挂载行与
    // minimal-win 用户 preset 落盘（幂等）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = win_inspector::apply(&app_handle) {
        log::warn!("win32 terminal support apply failed: {e}");
    }
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert("DSH_HOME".to_string(), dsh_home.to_string_lossy().into_owned());
    envs.insert("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string());
    envs.insert("NO_COLOR".to_string(), "1".to_string());
    envs.insert("DSH_WEB_PORT".to_string(), setting.port.to_string());

    // 扩展 PATH，让 dsh 及其子进程能找到 node；Windows 上再注入 Git Bash 的
    // bin 目录：persistent bash（--noprofile --norc）不执行 profile 脚本、PATH
    // 完全继承服务进程，若不含 Git 的 usr/bin，ls/sed/find 等 coreutils 全会
    // `command not found`（MSYS 运行时在部分环境下不会自动补 /usr/bin）。
    if let Some(node_dir) = node_binary_path.parent() {
        if let Some(existing_path) = std::env::var_os("PATH") {
            let git_dirs = win_inspector::git_bash_bin_dirs();
            // 只打印注入的前缀目录，完整 PATH 太长会刷屏
            for dir in &git_dirs {
                log::debug!("harness service PATH prepend: {}", dir.to_string_lossy());
            }
            let mut paths = vec![node_dir.to_path_buf()];
            paths.extend(git_dirs);
            paths.extend(std::env::split_paths(&existing_path));
            if let Ok(new_path) = std::env::join_paths(paths) {
                envs.insert("PATH".to_string(), new_path.to_string_lossy().into_owned());
            }
        }
    }

    // 日志文件（前端日志面板读取）
    let log_path = config::get_service_log_path(&app_handle);
    fs::create_dir_all(log_path.parent().unwrap_or(std::path::Path::new(".")))
        .map_err(|e| format!("create log dir failed: {e}"))?;

    log::info!("Starting Harness process");

    // Windows 打包版是 GUI 进程（没有控制台）。直接以 CREATE_NO_WINDOW 启动
    // node 会让 dsh 派生的子进程各自新建可见控制台窗口（频繁闪烁 cmd 黑窗），
    // 因此 Windows 上改用“隐藏控制台”方式启动，见 win_spawn 模块。
    let spawn_result = {
        #[cfg(windows)]
        {
            let args: Vec<OsString> = vec![
                dsh_binary_path.as_os_str().to_os_string(),
                OsString::from("--profile"),
                OsString::from("web"),
                OsString::from("--host"),
                OsString::from("127.0.0.1"),
                OsString::from("--port"),
                OsString::from(setting.port.to_string()),
            ];
            win_spawn::spawn_with_hidden_console(
                &node_binary_path,
                &args,
                Some(&config::get_dsh_install_path(&app_handle)),
                &envs,
            )
            .map(|(stdout, stderr)| (Some(stdout), Some(stderr)))
        }
        #[cfg(not(windows))]
        {
            let mut cmd = Command::new(&node_binary_path);
            cmd.arg(&dsh_binary_path)
                .arg("--profile")
                .arg("web")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(&setting.port.to_string())
                .envs(&envs)
                .current_dir(config::get_dsh_install_path(&app_handle))
                // 核心修正：提供一个空的 stdin 防止 setRawMode 报错
                .stdin(Stdio::null())
                // 使用管道捕获输出，以便在子线程中读取
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            cmd.spawn().map(|mut child| {
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                (stdout, stderr)
            })
        }
    };

    match spawn_result {
        Ok((stdout, stderr)) => {
            log::info!("Harness process started successfully");
            spawn_output_readers(stdout, stderr, log_path);

            // 后台等待 dsh 就绪后释放启动守卫，覆盖启动窗口内的并发调用
            tauri::async_runtime::spawn(async move {
                for _ in 0..15 {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    if is_dsh_running(setting.port).await {
                        break;
                    }
                }
                LAUNCH_GUARD.store(false, Ordering::SeqCst);
            });

            Ok(())
        }
        Err(e) => {
            LAUNCH_GUARD.store(false, Ordering::SeqCst);
            log::error!("Failed to start process: {}", e);
            Err(format!("Failed to start process: {}", e))
        }
    }
}

/// 停止 Harness 服务
pub async fn stop(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Stopping Harness service...");
    let port = config::get_store_dat_setting(&app_handle).port;

    // 重置启动守卫，确保后续 launch 可以重新拉起
    LAUNCH_GUARD.store(false, Ordering::SeqCst);
    kill_port_holder(port);

    // 连带清理 dsh 派生的 node 子进程：它们可能不再监听端口，但仍持有原生
    // 模块 DLL（Windows 文件锁）或 dependencies/runtime 目录文件句柄
    // （macOS/Linux 重解压竞态），需要一并强制结束。
    kill_dsh_processes(&config::get_base_dir(&app_handle));

    // 给系统一点时间释放端口 (重要！)
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    status::set_status(status::Status::Stopped);
    status::emit_status(&app_handle);
    Ok(())
}

/// 应用退出时同步回收 Harness 进程。
///
/// 退出路径上不更新状态、不做异步等待，仅强制结束端口占用者及其进程树，
/// 以及 AppData 目录下的 node 进程，避免残留进程把原生模块 DLL 锁在内存或
/// 持有目录文件句柄，导致下次启动重新解压失败。
/// 需要 app_handle 定位 AppData 目录来清理进程树。
pub fn stop_on_exit(app_handle: tauri::AppHandle, port: u16) {
    kill_port_holder(port);
    kill_dsh_processes(&config::get_base_dir(&app_handle));
}

/// 安装环境（Node.js 运行时 + 打包的 Harness 发行版）
pub async fn install(
    app_handle: &tauri::AppHandle,
    dsh_latest: Option<download::LatestDshPkg>,
) -> Result<(), String> {
    log::info!("Starting installation process");

    // 安装前先停止正在运行的 Harness 服务：运行中的 node 进程会把
    // 原生模块 DLL（如 sharp 的 libvips-42.dll）加载进内存并锁住文件，
    // 不停止的话覆盖解压必然失败（Windows os error 32）。
    // 注意不能只依赖 HTTP 探测：服务崩溃/失去响应时探测不到，但 node
    // 进程可能仍存活并持有 DLL，因此探测不到时也要强制清理。
    if is_dsh_running(config::get_store_dat_setting(app_handle).port).await {
        log::info!("Stopping running Harness service before installation");
        stop(app_handle.clone()).await?;
    } else {
        log::warn!("Harness service not responding, force cleaning dsh processes");
        kill_port_holder(config::get_store_dat_setting(app_handle).port);
        kill_dsh_processes(&config::get_base_dir(app_handle));
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    log::debug!("Main window obtained");
    // 3 个任务 × 下载/解压 2 个阶段
    let mut tracker = download::ProgressTracker::new(&window, 6);
    let tasks: Vec<Box<dyn download::Installable>> =
        vec![Box::new(download::Nodejs), Box::new(download::Dsh), Box::new(download::Pnpm)];
    log::info!("Task list created, {} tasks total", tasks.len());

    for (index, task) in tasks.iter().enumerate() {
        log::debug!("Processing task {}/{}", index + 1, tasks.len());
        // 已安装但 commit 与最新 release 不一致时强制重新下载
        let outdated = index == 1
            && dsh_latest.as_ref().is_some_and(|info| {
                config::get_dsh_pkg_commit(app_handle).as_deref() != Some(info.commit.as_str())
            });
        if task.check_installed(app_handle) && !outdated {
            log::debug!(
                "Task {} already installed and up to date, skipping",
                index + 1
            );
            tracker.skip_phases(2);
            continue;
        }

        log::info!("Task {} not installed, starting installation", index + 1);

        // 1. 下载
        tracker.start_phase("download", &format!("{} {}", config::i18n::t("install.downloading"), task.title()));
        let url = task.get_download_url()?;
        log::debug!("Download URL: {}", url);
        // 取文件名用于解压类型判定；下载 URL 正常必含 '/'，但这里不 panic，
        // 防御性兜底为空串（后续 ensure_extract 会因无法判定类型而报错返回，
        // 不再让进程崩溃）。
        let name = url.rsplit('/').next().unwrap_or("").to_string();
        log::debug!("File name: {}", name);
        let buffer = download::download_file(&tracker, url).await?;
        log::info!("Download completed, file size: {} bytes", buffer.len());
        tracker.end_phase();

        // 2. 解压
        tracker.start_phase("extract", &format!("{} {}", config::i18n::t("install.extracting"), task.title()));
        let dest = task.get_install_path(app_handle);
        log::debug!("Installation path: {:?}", dest);
        download::ensure_extract(&tracker, name, buffer, dest)?;
        log::info!("Extraction completed");
        tracker.end_phase();

        // 记录本次安装对应的 release tag 与 commit，供下次启动比对
        if index == 1 {
            if let Some(info) = &dsh_latest {
                config::set_dsh_pkg_commit(app_handle, info.commit.clone());
                config::set_dsh_pkg_tag(app_handle, info.tag.clone());
            }
        }
    }

    log::info!("All installation tasks completed");
    tracker.update(
        100.0,
        config::i18n::t("install.done"),
        "All tasks completed".into(),
    );

    Ok(())
}

/// 健康检查（通过 Rust 代理，避免 WebView CORS 问题）
pub async fn proxy_health_check(port: u16) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(config::HEALTH_CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    for endpoint in [
        format!("http://127.0.0.1:{port}/"),
        format!("http://127.0.0.1:{port}/healthz"),
    ] {
        match client.get(&endpoint).send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if status.is_success() {
                    return Ok(format!(
                        "healthy - {status} - {}",
                        body.chars().take(80).collect::<String>()
                    ));
                }
            }
            Err(err) => {
                log::debug!("Health check {endpoint}: {err}");
            }
        }
    }
    Err("HARNESS_NOT_READY: Harness service is not ready".to_string())
}
