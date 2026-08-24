use super::constants::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Setting {
    pub installed: bool,
    pub port: u16,
    pub auto_start: bool,
    pub language: String,
    #[serde(default)]
    pub dsh_pkg_commit: Option<String>,
    /// 已安装 Harness 发行版对应的 GitHub release tag（与 dsh_pkg_commit 配套，
    /// 用于甄别“记录滞后于文件”与“同版本热修”两种不一致）
    #[serde(default)]
    pub dsh_pkg_tag: Option<String>,
    /// 命令行集成开关：安装后在用户 PATH 中注册 `dsh` 命令
    #[serde(default = "default_cli_link_enabled")]
    pub cli_link_enabled: bool,
    /// 预装插件引导是否已完成（确认安装或跳过都算完成，之后不再弹出）
    #[serde(default)]
    pub preinstall_done: bool,
    /// 上次引导结束时的 `preset-plugins.json` 内容指纹。资源文件每次安装都会被
    /// 强制覆盖、旧文件不复存在，只能把「上次看到的内容」记在这里，每次启动再比对：
    /// 内容有变更 → 重新进入预设引导。`None` = 老用户升级（无基线）→ 弹一次建立基线。
    #[serde(default)]
    pub preset_hash: Option<String>,
}

/// 命令行集成默认开启（开发者工具场景，安装完成即可用）
fn default_cli_link_enabled() -> bool {
    true
}

/// 默认服务端口：debug 构建与生产隔离，避免开发时与已运行的桌面端争用 3080。
fn default_port() -> u16 {
    if cfg!(debug_assertions) {
        DSH_DEV_PORT
    } else {
        DSH_PORT
    }
}

impl Default for Setting {
    fn default() -> Self {
        Self {
            installed: false,
            port: default_port(),
            auto_start: true,
            language: "zh-CN".to_string(),
            dsh_pkg_commit: None,
            dsh_pkg_tag: None,
            cli_link_enabled: default_cli_link_enabled(),
            preinstall_done: false,
            preset_hash: None,
        }
    }
}

pub fn set_store_dat_setting(app_handle: &AppHandle, setting: Setting) {
    let store = app_handle
        .store(STORE_DAT_FILE)
        .expect("Failed to load store");
    store.set(STORE_SETTING_KEY, serde_json::to_value(&setting).unwrap());
    store.save().expect("Failed to save store");
    app_handle
        .emit("setting_updated", &serde_json::to_value(&setting).unwrap())
        .expect("Failed to emit event");
}

pub fn get_store_dat_setting(app_handle: &AppHandle) -> Setting {
    let store = app_handle
        .store(STORE_DAT_FILE)
        .expect("Failed to load store");
    let raw = store.get(STORE_SETTING_KEY);
    let value = raw.as_ref().and_then(|v| {
        v.as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| Some(v.clone()))
    });
    value
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(Setting::default)
}

/// 已安装 Harness 发行版对应的 GitHub release commit hash
pub fn get_dsh_pkg_commit(app_handle: &AppHandle) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_commit
}

/// 记录已安装 Harness 发行版的 GitHub release commit hash
pub fn set_dsh_pkg_commit(app_handle: &AppHandle, commit: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_commit = Some(commit);
    set_store_dat_setting(app_handle, setting);
}

/// 已安装 Harness 发行版对应的 GitHub release tag
pub fn get_dsh_pkg_tag(app_handle: &AppHandle) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_tag
}

/// 记录已安装 Harness 发行版的 GitHub release tag
pub fn set_dsh_pkg_tag(app_handle: &AppHandle, tag: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_tag = Some(tag);
    set_store_dat_setting(app_handle, setting);
}
