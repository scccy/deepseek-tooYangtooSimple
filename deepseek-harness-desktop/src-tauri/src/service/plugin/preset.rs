//! 预设插件清单：读取并解析随安装包分发的 `resources/preset-plugins.json`。
//!
//! 社区新增推荐插件只需在该 JSON 中追加一项并提交 PR，无需改动 Rust 代码；
//! 界面与安装逻辑自动生效。资源缺失/损坏时报错并回落为空清单，不阻断启动。

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::config;

/// 预设插件清单文件名
const PRESET_PLUGINS_FILE: &str = "preset-plugins.json";

/// 预装插件静态信息，对应 `resources/preset-plugins.json` 中的条目
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallPluginInfo {
    /// 前端主键 / 仓库跳转查找键
    pub id: String,
    /// 传给 `dsh plugin add` 的依赖形式（npm 包名或 git 依赖形式）
    pub spec: String,
    /// 安装进 profile 后实际出现在 `dependencies`/`bundles` 里的包名。
    /// 默认与 `id` 相同；仅当 npm 包名与预设 id 不一致时（如 scoped 包
    /// `@scope/name`）才需要显式指定，供“已安装”检测使用。
    #[serde(default)]
    pub package: Option<String>,
    pub name: String,
    pub description: String,
    pub repo_url: String,
    /// 绿色「推荐」chip，默认勾选（普通推荐插件）
    #[serde(default)]
    pub recommended: bool,
    /// 黄色「修复」chip，默认勾选（Windows 极简模式修复项）
    #[serde(default)]
    pub fix: bool,
    /// 无 chip 但默认勾选（如 dsh-notification：不标「推荐」，首次引导仍直接勾上）
    #[serde(default)]
    pub default_checked: bool,
    /// 仅 Windows 平台列出
    #[serde(default)]
    pub win_only: bool,
}

/// 在资源根目录下查找预设清单：先探测扁平布局（exe 同级），再探测
/// `resources/` 子目录布局（Tauri 2 的 `bundle.resources` 按相对路径保留前缀）。
fn find_in_resource_root(root: &std::path::Path) -> Option<PathBuf> {
    let flat = root.join(PRESET_PLUGINS_FILE);
    if flat.exists() {
        return Some(flat);
    }
    let nested = root.join("resources").join(PRESET_PLUGINS_FILE);
    nested.exists().then_some(nested)
}

/// 定位预设插件清单文件：优先使用随安装包分发的资源目录，回落到源码开发目录。
///
/// 注意：Tauri 2 在 Windows 上 `resource_dir()` 恒等于 exe 所在目录，而安装包
/// （NSIS/MSI）与开发产物都会把资源按 `resources/**` 前缀落盘到
/// `{resource_dir}/resources/` 子目录，因此必须探测该子目录；`CARGO_MANIFEST_DIR`
/// 是编译期路径，仅开发机有效（CI/发布版在本机不可用），只作最后兜底。
fn preset_plugins_path(app_handle: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app_handle.path().resource_dir() {
        if let Some(candidate) = find_in_resource_root(&dir) {
            return Some(candidate);
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(PRESET_PLUGINS_FILE);
    source.exists().then_some(source)
}

/// 解析预设清单 JSON
fn parse_presets(json: &str) -> Result<Vec<PreinstallPluginInfo>, String> {
    serde_json::from_str(json).map_err(|e| format!("PRESET_PLUGINS_INVALID_JSON: {e}"))
}

/// 读取并解析预设插件清单；资源缺失/损坏时记录错误并返回空清单
pub(crate) fn load_presets(app_handle: &AppHandle) -> Vec<PreinstallPluginInfo> {
    let Some(path) = preset_plugins_path(app_handle) else {
        log::warn!("PRESET_PLUGINS_MISSING: {PRESET_PLUGINS_FILE} not found in resource dir or source resources dir");
        return Vec::new();
    };

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::error!("PRESET_PLUGINS_READ_FAILED: {}: {e}", path.display());
            return Vec::new();
        }
    };

    parse_presets(&raw).unwrap_or_else(|e| {
        log::error!("PRESET_PLUGINS_PARSE_FAILED: {}: {e}", path.display());
        Vec::new()
    })
}

/// 预装清单中某 id 对应的仓库地址
pub fn repo_url_of(app_handle: &AppHandle, id: &str) -> Option<String> {
    load_presets(app_handle)
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.repo_url)
}

/// FNV-1a 64 位哈希（无外部依赖，跨平台稳定）
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// 当前 `preset-plugins.json` 内容指纹（十六进制 FNV-1a）；文件缺失/不可读返回 None
pub(crate) fn current_preset_hash(app_handle: &AppHandle) -> Option<String> {
    let path = preset_plugins_path(app_handle)?;
    let raw = std::fs::read(&path).ok()?;
    Some(format!("{:016x}", fnv1a(&raw)))
}

/// 是否需要进入预装插件引导：
/// - 引导从未完成（首启/中途退出）→ 需要
/// - 老用户升级无指纹基线（文件在）→ 弹一次建立基线
/// - 有基线且内容已变更 → 需要
/// - 文件缺失视为无变化，避免每次启动都弹空引导
pub(crate) fn preinstall_pending(app_handle: &AppHandle) -> bool {
    let setting = config::get_store_dat_setting(app_handle);
    if !setting.preinstall_done {
        return true;
    }
    match (setting.preset_hash.as_deref(), current_preset_hash(app_handle)) {
        (None, Some(_)) => true,
        (Some(prev), Some(cur)) => prev != cur,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_presets_for_test() -> Vec<PreinstallPluginInfo> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(PRESET_PLUGINS_FILE);
        let raw = std::fs::read_to_string(path).expect("preset-plugins.json should exist");
        parse_presets(&raw).expect("preset-plugins.json should be valid JSON")
    }

    #[test]
    fn preset_list_contains_dshmarket() {
        let presets = load_presets_for_test();
        assert!(presets.iter().any(|p| p.id == "dshmarket"));
        assert_eq!(
            presets
                .iter()
                .find(|p| p.id == "dshmarket")
                .map(|p| p.repo_url.as_str()),
            Some("https://github.com/dsh-market/dsh-market")
        );
        assert!(!presets.iter().any(|p| p.id == "unknown-package"));
    }

    #[test]
    fn preset_json_ids_are_unique() {
        let presets = load_presets_for_test();
        let ids: std::collections::HashSet<&str> =
            presets.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), presets.len(), "preset ids must be unique");
    }

    #[test]
    fn preset_discovery_finds_nested_resources_dir() {
        // 回归：Windows 安装包（NSIS/MSI）与开发产物把资源按 `resources/**` 前缀
        // 落盘到 `{resource_dir}/resources/` 子目录，此前只探测 exe 同级导致
        // 发布版预装页恒为空清单。
        let dir = std::env::temp_dir().join(format!("dsh-preset-layout-{}", std::process::id()));
        let nested = dir.join("resources");
        std::fs::create_dir_all(&nested).expect("create temp resources dir");
        std::fs::write(
            nested.join(PRESET_PLUGINS_FILE),
            r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"}]"#,
        )
        .expect("write temp preset file");

        let found = find_in_resource_root(&dir).expect("nested resources layout should be found");
        assert_eq!(found, nested.join(PRESET_PLUGINS_FILE));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preset_discovery_prefers_flat_layout() {
        // 扁平布局（资源直接放在 exe 同级）仍应优先命中。
        let dir = std::env::temp_dir().join(format!("dsh-preset-flat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        std::fs::write(
            dir.join(PRESET_PLUGINS_FILE),
            r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"}]"#,
        )
        .expect("write temp preset file");

        let found = find_in_resource_root(&dir).expect("flat layout should be found");
        assert_eq!(found, dir.join(PRESET_PLUGINS_FILE));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fnv1a_matches_known_vectors() {
        // FNV-1a 64-bit 标准测试向量
        assert_eq!(fnv1a(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a(b"a"), 0xaf63dc4c8601ec8c);
        assert_eq!(fnv1a(b"foobar"), 0x85944171f73967e8);
    }

    #[test]
    fn same_content_same_hash_appended_comma_changes_hash() {
        let a = r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"}]"#;
        let b = r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"},]"#;
        assert_eq!(fnv1a(a.as_bytes()), fnv1a(a.as_bytes()));
        assert_ne!(fnv1a(a.as_bytes()), fnv1a(b.as_bytes()));
    }

    #[test]
    fn pending_decision_matrix() {
        // 未完成引导 → 一定需要
        assert!(preinstall_pending_for_test(false, None, Some("h1")));
        assert!(preinstall_pending_for_test(false, Some("h1"), Some("h1")));
        // 老用户升级：无基线且文件在 → 弹一次建立基线
        assert!(preinstall_pending_for_test(true, None, Some("h1")));
        // 基线一致 → 不弹
        assert!(!preinstall_pending_for_test(true, Some("h1"), Some("h1")));
        // 内容变更 → 弹
        assert!(preinstall_pending_for_test(true, Some("h1"), Some("h2")));
        // 文件缺失：视为无变化不弹（有基线或老用户都不弹）
        assert!(!preinstall_pending_for_test(true, Some("h1"), None));
        assert!(!preinstall_pending_for_test(true, None, None));
    }

    /// 纯函数版 pending 判定（便于单测，不依赖 AppHandle）
    fn preinstall_pending_for_test(
        preinstall_done: bool,
        recorded: Option<&str>,
        current: Option<&str>,
    ) -> bool {
        if !preinstall_done {
            return true;
        }
        match (recorded, current) {
            (None, Some(_)) => true,
            (Some(prev), Some(cur)) => prev != cur,
            _ => false,
        }
    }
}