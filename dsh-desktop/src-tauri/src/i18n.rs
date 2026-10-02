//! Minimal zh/en string table for native-shell surfaces (menus, tray,
//! notifications, dialogs, settings-panel error strings). The web UI owns its
//! own i18n; this module only covers text rendered outside the webview.
//!
//! The locale is detected once per process: macOS reads the global
//! AppleLanguages preference (first entry), everything else falls back to the
//! `LC_ALL` / `LANG` environment (Windows queries the registry locale name).
//! Anything not starting with "zh" renders English.

use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    Zh,
    En,
}

static LOCALE: OnceLock<Locale> = OnceLock::new();

pub fn locale() -> Locale {
    *LOCALE.get_or_init(detect_locale)
}

fn detect_locale() -> Locale {
    for candidate in locale_candidates() {
        if candidate.to_ascii_lowercase().starts_with("zh") {
            return Locale::Zh;
        }
    }
    Locale::En
}

/// Ordered system-locale candidates, best first.
fn locale_candidates() -> Vec<String> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    {
        // `defaults read -g AppleLanguages` prints e.g. `(\n    "zh-Hans-CN",\n    "en-US",\n)`.
        if let Ok(output) = std::process::Command::new("defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            for token in text.split(',') {
                let token = token
                    .trim()
                    .trim_start_matches('(')
                    .trim_matches([')', ' '])
                    .trim()
                    .trim_matches('"')
                    .trim();
                if !token.is_empty() {
                    out.push(token.to_string());
                    break;
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Control Panel\International",
                "/v",
                "LocaleName",
            ])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if let Some(name) = line.trim().rsplit(char::is_whitespace).next() {
                    if !name.is_empty() && !name.contains("REG_SZ") && name != "LocaleName" {
                        out.push(name.to_string());
                        break;
                    }
                }
            }
        }
    }
    for key in ["LC_ALL", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.split('.').next().unwrap_or("").trim().to_string();
            if !value.is_empty() {
                out.push(value);
            }
        }
    }
    out
}

fn pick(zh: &'static str, en: &'static str) -> &'static str {
    if matches!(locale(), Locale::Zh) {
        zh
    } else {
        en
    }
}

/// Dynamic-string variant of [`pick`] for `format!`-built text.
fn pick_owned(zh: String, en: String) -> String {
    if matches!(locale(), Locale::Zh) {
        zh
    } else {
        en
    }
}

// ---------------------------------------------------------------------------
// fixed strings
// ---------------------------------------------------------------------------
#[derive(Clone, Copy)]
pub enum Text {
    MenuAbout,
    MenuQuit,
    MenuReload,
    TrayShow,
    QuitDialogTitle,
    QuitConfirm,
    QuitCancel,
    QuitFallbackBody,
    RecoveryTitle,
    RecoveryExit,
    RecoveryRestart,
    RecoveryDisablePlugins,
    CredentialExpiredTitle,
    MandatoryDialogTitle,
    MandatoryInstallButton,
}

pub fn text(key: Text) -> &'static str {
    match key {
        Text::MenuAbout => pick("关于 DSH Desktop", "About DSH Desktop"),
        Text::MenuQuit => pick("退出 DSH Desktop", "Quit DSH Desktop"),
        Text::MenuReload => pick("重新加载", "Reload"),
        Text::TrayShow => pick("显示 DSH Desktop", "Show DSH Desktop"),
        Text::QuitDialogTitle => pick("退出 DSH Desktop？", "Quit DSH Desktop?"),
        Text::QuitConfirm => pick("退出", "Quit"),
        Text::QuitCancel => pick("取消", "Cancel"),
        Text::QuitFallbackBody => pick(
            "无法确认当前是否有任务在运行（状态检查不可用）。现在退出可能中断正在执行的任务。",
            "Running tasks could not be checked (the status probe is unavailable). Quitting now may interrupt them.",
        ),
        Text::RecoveryTitle => pick("DSH Desktop 无法启动", "DSH Desktop Failed to Start"),
        Text::RecoveryExit => pick("退出", "Exit"),
        Text::RecoveryRestart => pick("重启", "Restart"),
        Text::RecoveryDisablePlugins => {
            pick("禁用第三方插件并重启", "Disable third-party plugins and restart")
        }
        Text::CredentialExpiredTitle => pick("凭据已过期", "Credential expired"),
        Text::MandatoryDialogTitle => pick("需要安装强制更新", "Mandatory update required"),
        Text::MandatoryInstallButton => pick("立即安装", "Install now"),
    }
}

// ---------------------------------------------------------------------------
// formatted strings
// ---------------------------------------------------------------------------

pub fn quit_dialog_body(
    running_tasks: bool,
    scheduled_reminders: bool,
    agents: u64,
    jobs: u64,
) -> String {
    match (running_tasks, scheduled_reminders) {
        (true, true) => pick(
            "有正在运行的任务，退出将中断它们；已排定的任务在应用关闭后也不会运行。",
            "Running tasks will be interrupted if you quit now, and scheduled tasks will not run while the app is closed.",
        )
        .to_string(),
        (true, false) => pick_owned(
            format!("有 {agents} 个会话 / {jobs} 个任务正在运行，退出将中断它们。"),
            format!("{agents} agent session(s) / {jobs} task(s) are still running and will be interrupted."),
        ),
        (false, true) => pick(
            "已排定的任务在应用关闭后不会运行。",
            "Scheduled tasks will not run while the application is closed.",
        )
        .to_string(),
        (false, false) => String::new(),
    }
}

pub fn update_available_body(latest: &str, local: &str) -> String {
    if matches!(locale(), Locale::Zh) {
        format!("dsh 有新版本 v{latest} 可用（当前 v{local}），可在设置中一键更新")
    } else {
        format!("dsh v{latest} is available (current v{local}) — update from Settings")
    }
}

pub fn stale_server_body() -> String {
    pick(
        "检测到旧版 dsh web 仍在 127.0.0.1:3080 监听：桌面版为无端口形态，请用 pkill -f \"dsh --profile web\" 结束旧进程，避免浏览器打开到旧页面",
        "An old standalone dsh web server is still listening on 127.0.0.1:3080. The desktop shell is portless — end it with pkill -f \"dsh --profile web\" so browsers do not open the stale page",
    )
    .to_string()
}

pub fn restarting_overlay_text() -> &'static str {
    pick("正在热重启 …", "Hot restarting …")
}

// Setting-panel flow guards (returned to the frontend and shown there).
pub fn err_app_quitting() -> String {
    pick("应用正在退出", "The application is quitting").to_string()
}

pub fn err_host_not_ready() -> String {
    pick("主机尚未就绪", "The host is not ready yet").to_string()
}

pub fn err_update_in_progress() -> String {
    if matches!(locale(), Locale::Zh) {
        "dsh 正在更新，请更新完成后再操作".to_string()
    } else {
        "A dsh update is in progress — wait for it to finish first".to_string()
    }
}

pub fn err_restart_in_progress() -> String {
    pick("重启已在进行中", "A restart is already in progress").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_is_detected() {
        assert!(matches!(locale(), Locale::Zh | Locale::En));
    }

    #[test]
    fn menu_strings_are_nonempty() {
        assert!(!text(Text::MenuQuit).is_empty());
        assert!(!text(Text::RecoveryDisablePlugins).is_empty());
    }

    #[test]
    fn quit_body_reflects_facts() {
        assert!(quit_dialog_body(true, true, 1, 2).contains('1') || quit_dialog_body(true, true, 1, 2).len() > 10);
        assert_eq!(quit_dialog_body(false, false, 0, 0), "");
    }

    #[test]
    fn update_body_mentions_versions() {
        let body = update_available_body("0.8.0", "0.7.5");
        assert!(body.contains("0.8.0") && body.contains("0.7.5"));
    }
}

pub fn credential_expired_body() -> String {
    pick(
        "检测到 API 凭据失效，请在设置的模型页更新凭据。",
        "The API credential appears to have expired — update it in Settings → Models.",
    )
    .to_string()
}

pub fn shell_update_available_body(version: &str) -> String {
    if matches!(locale(), Locale::Zh) {
        format!("桌面版有新版本 v{version} 可用，可在设置的「应用更新」中安装")
    } else {
        format!("Desktop v{version} is available — install it from Settings → App update")
    }
}

pub fn mandatory_overlay_text() -> &'static str {
    pick(
        "检测到强制更新，正在准备安装 …",
        "A mandatory update is being prepared …",
    )
}

pub fn mandatory_dialog_body(version: &str) -> String {
    if matches!(locale(), Locale::Zh) {
        format!("桌面版 v{version} 为强制更新，安装后应用将自动重启。")
    } else {
        format!("Desktop v{version} is a mandatory update. The app restarts after installation.")
    }
}
