//! 预装插件安装：校验选中项、准备环境（pnpm/dsh shim、按需补齐捆绑 pnpm、
//! 停止运行中的服务），随后调用 `dsh plugin --profile web add <specs...>`，
//! 成功后执行 Windows 极简模式专项修复。

use crate::config;
use crate::service::cli;
use crate::service::download;
use crate::service::download::Installable;
use crate::service::workflow;
use std::collections::HashMap;
use std::ffi::OsString;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::installed::PREINSTALL_PROFILE;
use super::preset::load_presets;
use super::process::{run_plugin_process, PreinstallLogPayload, PREINSTALL_LOG_EVENT};

/// 校验并安装选中的预装插件：`dsh plugin --profile web add <ids...>`
pub async fn install(app_handle: &AppHandle, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Err("PREINSTALL_EMPTY: no plugins selected".to_string());
    }

    // 单次读取预设并构建查找表，提升算法效率至 O(N)
    let presets = load_presets(app_handle);
    let preset_map: HashMap<&str, &str> = presets.iter().map(|p| (p.id.as_str(), p.spec.as_str())).collect();

    let mut specs = Vec::with_capacity(ids.len());
    for id in ids {
        let spec = preset_map
            .get(id.as_str())
            .ok_or_else(|| format!("PREINSTALL_INVALID_ID: {id}"))?;
        specs.push(spec.to_string());
    }

    // 确保 pnpm/dsh shim 存在
    cli::ensure_shims(app_handle)?;

    let node = config::get_node_binary_path(app_handle);
    let dsh_bin = config::get_dsh_binary_path(app_handle);
    if !node.exists() {
        return Err("NODE_NOT_FOUND: Node.js runtime missing".to_string());
    }
    if !dsh_bin.exists() {
        return Err("HARNESS_NOT_FOUND: dsh CLI missing".to_string());
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;

    // 按需补齐捆绑 pnpm
    ensure_pnpm(app_handle, &window).await?;

    // 安装前停止运行中的服务，避免资源冲突
    if workflow::utils::is_dsh_running(config::get_store_dat_setting(app_handle).port).await {
        log::info!("Stopping running harness service before installing preinstall plugins");
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            log::warn!("failed to stop harness before preinstall: {e}");
        }
    }

    // 构建环境变量
    let bin_dir = cli::get_bin_dir(app_handle);
    let mut envs = HashMap::from([
        ("DSH_HOME".to_string(), config::get_dsh_data_path(app_handle).to_string_lossy().into_owned()),
        ("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
    ]);

    let mut paths = vec![bin_dir];
    if let Some(node_dir) = node.parent() {
        paths.push(node_dir.to_path_buf());
    }
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));

    if let Ok(joined) = std::env::join_paths(paths) {
        envs.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    }

    // 拼装命令行参数
    let mut args = vec![
        dsh_bin.as_os_str().to_os_string(),
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(PREINSTALL_PROFILE),
        OsString::from("add"),
    ];
    args.extend(specs.into_iter().map(OsString::from));

    let cwd = config::get_dsh_install_path(app_handle);
    log::info!("Running dsh plugin install for {ids:?}");

    let exit_code = run_plugin_process(&node, &args, &cwd, &envs, &window).await?;
    if exit_code != 0 {
        log::error!("dsh plugin install failed with exit code {exit_code}");
        return Err(format!("PREINSTALL_FAILED: dsh plugin exited with code {exit_code}"));
    }

    // Windows 极简模式专项修复
    if ids.iter().any(|id| id == "dsh-win-terminal-inspector") {
        if let Err(e) = workflow::win_inspector::apply(app_handle) {
            log::warn!("win inspector apply failed after install: {e}");
        }
    }

    log::info!("Preinstall plugins installed successfully: {ids:?}");
    Ok(())
}

/// 确保捆绑 pnpm 已安装
async fn ensure_pnpm(app_handle: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if download::Pnpm.check_installed(app_handle) {
        return Ok(());
    }

    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: "[pnpm] bundled pnpm not found, downloading before plugin install".to_string(),
        },
    );

    let tracker = download::ProgressTracker::new(window, 2);
    let url = download::Pnpm.get_download_url()?;
    let name = url.split('/').next_back().unwrap_or(&url).to_string();
    let buffer = download::download_file(&tracker, url)
        .await
        .map_err(|e| format!("PNPM_DOWNLOAD_FAILED: {e}"))?;
    let dest = download::Pnpm.get_install_path(app_handle);

    download::ensure_extract(&tracker, name, buffer, dest)
        .map_err(|e| format!("PNPM_EXTRACT_FAILED: {e}"))?;

    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: "[pnpm] bundled pnpm ready".to_string(),
        },
    );
    Ok(())
}