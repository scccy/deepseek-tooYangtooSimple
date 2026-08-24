//! 桌面应用自更新模块。
//!
//! 与 `dsh` 内核更新（`download` 模块）不同，这里负责「DeepSeek Harness 桌面端」
//! 自身的更新：查询 GitHub Release 的最新版本、下载安装包、并交给系统打开安装器。
//!
//! 设计考量：
//! - GitHub 未认证 API 限流 60 次/小时/IP，而前端每 10 秒轮询一次「检查更新」，
//!   因此这里对最新 Release 查询结果做 5 分钟内存缓存，轮询命中缓存、不再打网络。
//! - 安装包下载到 AppData/updates 目录；已存在则视为「已下载」，不再重复拉取。
//! - 打开安装器（exe/msi/dmg 等）交给系统默认处理器（ShellExecute/LaunchServices）。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

/// 桌面端 GitHub 仓库 API 地址（未认证限流 60 次/小时/IP）
const GITHUB_API: &str = "https://api.github.com/repos/hairyf/deepseek-harness-desktop";
/// 仓库主页（关于对话框展示）
const REPO_URL: &str = "https://github.com/hairyf/deepseek-harness-desktop";
/// 版权信息（与 tauri.conf.json bundle.copyright 保持一致）
const COPYRIGHT: &str = "Copyright © 2026 Deepseek Harness Desktop contributors";
/// About 对话框的 "Powered by" 文案
const POWERED_BY: &str = "DeepSeek Harness";
/// 最新 Release 查询结果缓存时长（轮询防限流）
const CACHE_TTL: Duration = Duration::from_secs(300);
/// AppData 下安装包存放目录名
const UPDATES_DIR: &str = "updates";

/// 最新可用发布信息（仅在有更新且匹配到当前平台安装包时才有意义）
#[derive(Debug, Clone)]
struct LatestRelease {
    version: String,
    tag: String,
    published_at: String,
    url: String,
    asset_name: String,
}

/// 缓存的查询结果：published_at 无论是否有更新都会写入，
/// release 仅在「有更新且匹配到资产」时为 Some，其余为 None（同样缓存以免限流）。
struct CacheEntry {
    fetched_at: Instant,
    published_at: String,
    release: Option<LatestRelease>,
}

static CACHE: OnceLock<Mutex<Option<CacheEntry>>> = OnceLock::new();

/// 当前桌面端版本号（来自 Cargo.toml / tauri.conf.json）
fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 解析版本号为数字段序列：`v0.5.2` / `0.5.2` → [0, 5, 2]
fn parse_version(v: &str) -> Option<Vec<u64>> {
    let s = v.trim().trim_start_matches('v');
    s.split('.')
        .map(|p| p.parse().ok())
        .collect::<Option<Vec<_>>>()
}

/// 判断 `latest` 是否严格高于 `current`（逐段比较，段数多者视作更新）
fn is_newer(latest: &str, current: &str) -> bool {
    let Some(a) = parse_version(latest) else {
        return false;
    };
    let Some(b) = parse_version(current) else {
        return false;
    };
    for (x, y) in a.iter().zip(b.iter()) {
        if x != y {
            return x > y;
        }
    }
    a.len() > b.len()
}

/// 选择当前平台对应的安装包资产（名称, 下载 URL）。
///
/// 优先级由各平台偏好扩展名顺序决定：Windows 优先 msi（其次 exe/nsis），
/// macOS 选 dmg，Linux 选 AppImage（其次 deb/rpm）。
fn pick_asset(assets: &[serde_json::Value]) -> Option<(String, String)> {
    #[cfg(target_os = "windows")]
    let prefs = [".msi", ".exe"];
    #[cfg(target_os = "macos")]
    let prefs = [".dmg"];
    #[cfg(target_os = "linux")]
    let prefs = [".AppImage", ".deb", ".rpm"];

    let mut best: Option<(usize, String, String)> = None;
    for asset in assets {
        let Some(name) = asset.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(idx) = prefs.iter().position(|p| name.ends_with(p)) else {
            continue;
        };
        let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) else {
            continue;
        };
        let rank = prefs.len() - idx; // 越靠前优先级越高
        if best.as_ref().is_none_or(|(r, _, _)| rank > *r) {
            best = Some((rank, name.to_string(), url.to_string()));
        }
    }
    best.map(|(_, name, url)| (name, url))
}

/// 查询最新 Release（带缓存）。
///
/// 返回 `Ok(Some(LatestRelease))` 表示有更新且匹配到当前平台安装包；
/// `Ok(None)` 表示无更新（或未匹配到资产）。网络失败/限流返回 Err。
async fn fetch_latest_release() -> Result<Option<LatestRelease>, String> {
    {
        let lock = CACHE.get_or_init(|| Mutex::new(None));
        if let Ok(guard) = lock.lock() {
            if let Some(entry) = guard.as_ref() {
                if entry.fetched_at.elapsed() < CACHE_TTL {
                    return Ok(entry.release.clone());
                }
            }
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("deepseek-harness-desktop")
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("UPDATE_CLIENT: {e}"))?;

    let release: serde_json::Value = client
        .get(format!("{GITHUB_API}/releases/latest"))
        .send()
        .await
        .map_err(|e| format!("UPDATE_REQ: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_REQ: {e}"))?
        .json()
        .await
        .map_err(|e| format!("UPDATE_PARSE: {e}"))?;

    let tag_name = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let published_at = release
        .get("published_at")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let version = tag_name.trim_start_matches('v').to_string();

    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let asset = pick_asset(&assets);

    // 有更新且匹配到资产才视为「可更新」
    let release = if is_newer(&version, &current_version()) {
        match asset {
            Some((name, url)) => Some(LatestRelease {
                version: version.clone(),
                tag: tag_name.clone(),
                published_at: published_at.clone(),
                url,
                asset_name: name,
            }),
            None => None,
        }
    } else {
        None
    };

    if let Ok(mut guard) = CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some(CacheEntry {
            fetched_at: Instant::now(),
            published_at,
            release: release.clone(),
        });
    }
    Ok(release)
}

/// 安装包存放路径（AppData/updates/<asset_name>）
fn installer_path(app_handle: &AppHandle, asset_name: &str) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("UPDATE_DIR: {e}"))?
        .join(UPDATES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("UPDATE_DIR: {e}"))?;
    Ok(dir.join(asset_name))
}

/// 检查是否有桌面端新版本。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    /// 最新可用版本号（无 `v` 前缀）
    pub version: String,
    /// 当前已安装版本号（无 `v` 前缀）
    pub current_version: String,
    pub tag: String,
    pub published_at: String,
    pub url: String,
    pub asset_name: String,
    pub path: String,
    pub downloaded: bool,
}

/// 检查是否有新版本可用（含安装包是否已下载）
pub async fn check(app_handle: &AppHandle) -> Result<Option<DesktopUpdateInfo>, String> {
    match fetch_latest_release().await? {
        None => Ok(None),
        Some(r) => {
            let path = installer_path(app_handle, &r.asset_name)?;
            let downloaded = path.exists();
            Ok(Some(DesktopUpdateInfo {
                version: r.version,
                current_version: current_version(),
                tag: r.tag,
                published_at: r.published_at,
                url: r.url,
                asset_name: r.asset_name,
                path: path.to_string_lossy().into_owned(),
                downloaded,
            }))
        }
    }
}

/// 下载进度载荷（前端进度条展示）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDownloadProgress {
    pub percentage: f64,
    pub downloaded: u64,
    pub total: u64,
}

/// 下载桌面端安装包；已下载则直接返回。
///
/// 下载期间通过 `desktop-update-progress` 事件推送进度；完成后返回
/// `DesktopUpdateInfo`（path/downloaded 已更新）。
pub async fn download(app_handle: &AppHandle) -> Result<DesktopUpdateInfo, String> {
    let release = fetch_latest_release()
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())?;
    let path = installer_path(app_handle, &release.asset_name)?;

    if path.exists() {
        log::info!("Installer already downloaded: {}", path.display());
        return check(app_handle)
            .await?
            .ok_or_else(|| "UPDATE_NONE".to_string());
    }

    log::info!("Downloading desktop installer from {}", release.url);
    let client = reqwest::Client::builder()
        .user_agent("deepseek-harness-desktop")
        .build()
        .map_err(|e| format!("UPDATE_CLIENT: {e}"))?;

    let res = client
        .get(&release.url)
        .send()
        .await
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;

    let total = res.content_length().unwrap_or(0);
    // 先写临时文件再原子改名，避免下载中断残留半成品被误判为「已下载」
    let tmp = path.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("UPDATE_FILE: {e}"))?;

    use std::io::Write;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("UPDATE_FILE: {e}"))?;
        downloaded += chunk.len() as u64;
        let pct = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app_handle.emit(
            "desktop-update-progress",
            DesktopDownloadProgress {
                percentage: pct,
                downloaded,
                total,
            },
        );
    }
    drop(file);
    std::fs::rename(&tmp, &path).map_err(|e| format!("UPDATE_FILE: {e}"))?;

    check(app_handle)
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())
}

/// 打开安装包：交给系统默认处理器（Windows 会触发 UAC 执行安装器）。
pub async fn open_installer(app_handle: &AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("UPDATE_NOT_FOUND: {path}"));
    }
    log::info!("Opening desktop installer: {}", p.display());
    app_handle
        .opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("UPDATE_OPEN: {e}"))
}

/// 关于对话框信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAboutInfo {
    pub version: String,
    pub published_at: String,
    pub copyright: String,
    pub repo: String,
    pub powered_by: String,
}

/// 关于信息：版本来自编译常量，发布时间复用最近一次 Release 查询结果。
/// 缓存为空（如尚未触发任何轮询）时做一次尽力查询填充，失败则留空、不影响展示。
pub async fn about() -> DesktopAboutInfo {
    let cache_empty = CACHE
        .get()
        .map_or(true, |m| m.lock().map(|g| g.is_none()).unwrap_or(true));
    if cache_empty {
        let _ = fetch_latest_release().await;
    }
    let published_at = CACHE
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|g| g.as_ref().map(|e| e.published_at.clone()))
        .unwrap_or_default();
    DesktopAboutInfo {
        version: current_version(),
        published_at,
        copyright: COPYRIGHT.to_string(),
        repo: REPO_URL.to_string(),
        powered_by: POWERED_BY.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_strips_v_prefix() {
        assert_eq!(parse_version("v0.5.2").as_deref(), Some(&[0u64, 5, 2][..]));
        assert_eq!(parse_version("0.5.2").as_deref(), Some(&[0u64, 5, 2][..]));
        assert_eq!(parse_version("0.5").as_deref(), Some(&[0u64, 5][..]));
        assert_eq!(parse_version("abc"), None);
    }

    #[test]
    fn is_newer_compares_segments() {
        assert!(is_newer("0.5.2", "0.5.1"));
        assert!(is_newer("1.0.0", "0.9.0"));
        assert!(is_newer("0.5.0", "0.5"));
        assert!(!is_newer("0.5.1", "0.5.2"));
        assert!(!is_newer("0.5.1", "0.5.1"));
        assert!(!is_newer("0.5.1", "1.0.0"));
    }

    #[test]
    fn is_newer_ignores_unparseable() {
        assert!(!is_newer("abc", "0.5.1"));
        assert!(!is_newer("0.5.1", "abc"));
    }

    #[test]
    fn pick_asset_prefers_matching_suffix() {
        let mk = |name: &str, url: &str| {
            serde_json::json!({ "name": name, "browser_download_url": url })
        };
        #[cfg(target_os = "windows")]
        {
            let assets = vec![
                mk("app-x86_64-setup.exe", "https://x/exe"),
                mk("app.msi", "https://x/msi"),
            ];
            let (name, url) = pick_asset(&assets).unwrap();
            assert_eq!(name, "app.msi");
            assert_eq!(url, "https://x/msi");
        }
        #[cfg(target_os = "macos")]
        {
            let assets = vec![mk("app.dmg", "https://x/dmg"), mk("app-x86_64.tar.gz", "https://x/tgz")];
            let (name, url) = pick_asset(&assets).unwrap();
            assert_eq!(name, "app.dmg");
            assert_eq!(url, "https://x/dmg");
        }
        let no_match: Vec<serde_json::Value> = vec![mk("README.md", "https://x/readme")];
        assert!(pick_asset(&no_match).is_none());
        assert!(pick_asset(&[]).is_none());
    }
}
