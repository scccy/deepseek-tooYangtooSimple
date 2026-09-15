//! 统一环境变量读取：新名前缀 `DSH_DESKTOP_*`，旧名 `DSH_MAC_*` 向后兼容。
//!
//! 跨平台化后变量名不再绑定 macOS；历史用户仍可通过 `DSH_MAC_*` 覆盖，
//! 二者同时命中时以新名为准。

use std::sync::OnceLock;

/// 优先读新名，回退旧名；空串视为未设置。
pub fn var(new_key: &str, legacy_key: &str) -> Option<String> {
    if let Ok(value) = std::env::var(new_key) {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }
    std::env::var(legacy_key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// 布尔开关：任一名为 `"1"` 视为开启。
pub fn is_1(new_key: &str, legacy_key: &str) -> bool {
    [new_key, legacy_key]
        .iter()
        .any(|key| std::env::var(key).as_deref() == Ok("1"))
}

/// 桥接追踪开关，读取一次后缓存（每帧/bridge 消息反复查 env 是浪费）。
pub fn trace_bridge() -> bool {
    static TRACE: OnceLock<bool> = OnceLock::new();
    *TRACE.get_or_init(|| is_1("DSH_DESKTOP_TRACE_BRIDGE", "DSH_MAC_TRACE_BRIDGE"))
}