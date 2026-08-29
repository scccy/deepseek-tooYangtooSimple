//! 认证与会话管理（已实测 guest 流程）

use super::api::{Api, ApiError, Req};
use super::db::{Account, Db};
use serde_json::json;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 北京日期 YYYY-MM-DD（服务端 daily.key 同口径：UTC+8）
pub fn beijing_day(ms: i64) -> String {
    let days = (ms / 1000 + 8 * 3600).div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 北京时间（UTC+8）的小时与分钟，用于限时场次窗口判断
pub fn beijing_hour_minute(ms: i64) -> (i32, i32) {
    let secs = ms / 1000 + 8 * 3600;
    let h = (secs.div_euclid(3600) % 24) as i32;
    let m = (secs.div_euclid(60) % 60) as i32;
    (h, m)
}

/// 北京时区当日 0 点的毫秒时间戳（用于"今日已完成"的 finished_at 下界查询）
pub fn beijing_day_start_ms(ms: i64) -> i64 {
    let (h, m) = beijing_hour_minute(ms);
    ms - (h as i64) * 3600_000 - (m as i64) * 60_000 - (ms % 60_000)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub fn default_nickname(username: &str) -> String {
    let base = username.trim_start_matches("guest_");
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_alphanumeric())
        .take(14)
        .collect();
    let mut nick = if cleaned.is_empty() {
        format!("acc{:06}", rand::random::<u32>() % 1_000_000)
    } else {
        cleaned
    };
    while nick.len() < 2 {
        nick.push('0');
    }
    nick
}

pub fn new_device_id() -> String {
    let a: u64 = rand::random();
    let b: u64 = rand::random();
    let c: u64 = rand::random();
    format!("{a:016x}{b:016x}{c:016x}")
}

/// 回读服务端角色信息（player.job / player.nickname）并同步本地 accounts
/// 解决"本地 job 显示默认 warrior，实际是召唤/法师"的问题
pub async fn sync_character_info(db: &Mutex<Db>, api: &Api, account_id: i64, token: &str) {
    if let Ok(state) = api.bootstrap(token).await {
        let p = &state["player"];
        let job = p["job"].as_str().unwrap_or("").to_string();
        let nick = p["nickname"].as_str().unwrap_or("").to_string();
        if !job.is_empty() {
            if let Ok(guard) = db.lock() {
                let _ = guard.update_nickname_job(account_id, &nick, &job);
            }
        }
    }
}

pub async fn create_guest(db: &Mutex<Db>, api: &Api, role: &str, job: &str) -> Result<i64, String> {
    let resp = api
        .request(Req {
            method: "POST",
            path: "/api/auth/guest".into(),
            body: Some(json!({})),
            token: None,
            response_state: "full",
            timeout_secs: 25,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = resp.get("data").cloned().ok_or("guest 响应缺少 data")?;
    let token = data["sessionToken"].as_str().unwrap_or("").to_string();
    let user_id = data["currentUserId"].as_str().unwrap_or("").to_string();
    let username = data["generatedCredential"]["username"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let password = data["generatedCredential"]["password"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if username.is_empty() || token.is_empty() {
        return Err("guest 响应缺少凭证".into());
    }
    let id = {
        let db = db.lock().unwrap();
        if let Some(existing) = db.find_by_username(&username).map_err(|e| e.to_string())? {
            db.update_session(existing.id, Some(&token)).map_err(|e| e.to_string())?;
            existing.id
        } else {
            let nick = default_nickname(&username);
            let acc = Account {
                id: 0,
                role: role.into(),
                username,
                password,
                user_id,
                nickname: nick.clone(),
                job: job.into(),
                device_id: api.device_id.clone(),
                session_token: Some(token.clone()),
                enabled: true,
                created_at: now_ms(),
            };
            let id = db.insert_account(&acc).map_err(|e| e.to_string())?;
            let _ = db.update_nickname_job(id, &nick, job);
            id
        }
    };
    if role == "main" {
        sync_character_info(db, api, id, &token).await;
    }
    Ok(id)
}

pub async fn login_or_create_main(
    db: &Mutex<Db>,
    api: &Api,
    username: &str,
    password: &str,
) -> Result<i64, String> {
    if username.trim().is_empty() {
        return create_guest(db, api, "main", "warrior").await;
    }
    let resp = api
        .request(Req {
            method: "POST",
            path: "/api/auth/login".into(),
            body: Some(json!({"username": username, "password": password})),
            token: None,
            response_state: "full",
            timeout_secs: 25,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = resp.get("data").cloned().ok_or("登录响应缺少 data")?;
    let token = data["sessionToken"].as_str().unwrap_or("").to_string();
    let user_id = data["currentUserId"].as_str().unwrap_or("").to_string();
    if token.is_empty() {
        return Err("登录失败：无 sessionToken".into());
    }
    let id = {
        let db = db.lock().unwrap();
        if let Some(existing) = db.find_by_username(username).map_err(|e| e.to_string())? {
            db.update_session(existing.id, Some(&token)).map_err(|e| e.to_string())?;
            existing.id
        } else {
            let nick = default_nickname(username);
            let acc = Account {
                id: 0,
                role: "main".into(),
                username: username.into(),
                password: password.into(),
                user_id,
                nickname: nick.clone(),
                job: "warrior".into(),
                device_id: api.device_id.clone(),
                session_token: Some(token.clone()),
                enabled: true,
                created_at: now_ms(),
            };
            let id = db.insert_account(&acc).map_err(|e| e.to_string())?;
            let _ = db.update_nickname_job(id, &nick, "warrior");
            id
        }
    };
    sync_character_info(db, api, id, &token).await;
    Ok(id)
}

/// 注册正式账号并作为大号入库（已实测：POST /api/auth/register → sessionToken）
pub async fn register_or_create_main(
    db: &Mutex<Db>,
    api: &Api,
    username: &str,
    password: &str,
) -> Result<i64, String> {
    let username = username.trim();
    if username.is_empty() {
        return Err("注册正式账号需要填写账号名".into());
    }
    let resp = api
        .request(Req {
            method: "POST",
            path: "/api/auth/register".into(),
            body: Some(json!({"username": username, "password": password})),
            token: None,
            response_state: "full",
            timeout_secs: 25,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = resp.get("data").cloned().ok_or("注册响应缺少 data")?;
    let token = data["sessionToken"].as_str().unwrap_or("").to_string();
    let user_id = data["currentUserId"].as_str().unwrap_or("").to_string();
    if token.is_empty() {
        return Err("注册失败：无 sessionToken".into());
    }
    let id = {
        let db = db.lock().unwrap();
        if let Some(existing) = db.find_by_username(username).map_err(|e| e.to_string())? {
            db.update_session(existing.id, Some(&token)).map_err(|e| e.to_string())?;
            existing.id
        } else {
            let nick = default_nickname(username);
            let acc = Account {
                id: 0,
                role: "main".into(),
                username: username.into(),
                password: password.into(),
                user_id,
                nickname: nick.clone(),
                job: "warrior".into(),
                device_id: api.device_id.clone(),
                session_token: Some(token.clone()),
                enabled: true,
                created_at: now_ms(),
            };
            let id = db.insert_account(&acc).map_err(|e| e.to_string())?;
            let _ = db.update_nickname_job(id, &nick, "warrior");
            id
        }
    };
    sync_character_info(db, api, id, &token).await;
    Ok(id)
}

/// 确保会话有效，返回可用 token；过期则用账号密码自动重登
pub async fn ensure_session(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    if let Some(t) = &acc.session_token {
        let check = api
            .request(Req {
                method: "GET",
                path: "/api/users/list".into(),
                body: None,
                token: Some(t),
                response_state: "omit",
                timeout_secs: 10,
            })
            .await;
        match check {
            Ok(body) => {
                // 必须校验"当前设备确有有效登录"，只返回 200 不够：
                // 旧/错设备的 token 会返回空壳（users=[]、currentUserId=null）
                let data = body.get("data").cloned().unwrap_or(body);
                let uid = data["currentUserId"].as_str().unwrap_or("");
                let uid2 = data["currentUser"]["id"].as_str().unwrap_or("");
                if !uid.is_empty() || !uid2.is_empty() {
                    return Ok(t.clone());
                }
                // 空壳会话 → 走自动重登
            }
            Err(ApiError::SessionExpired) => {} // 掉线重登
            Err(ApiError::VersionRequired) => {
                return Err("客户端版本过低（426），需要更新".into());
            }
            // 网络抖动/服务端 5xx：沿用旧 token（token 本身没问题，换新的也一样）
            Err(ApiError::Network(_)) => return Ok(t.clone()),
            Err(ApiError::Http { status, .. }) if status >= 500 => return Ok(t.clone()),
            // 其余（401/403 等鉴权类错误）照常传播，不掩盖成"网络抖动"
            Err(e) => return Err(e.to_string()),
        }
    }
    relogin(db, api, acc).await
}

/// 用本地保存的账号密码重新登录，更新本地 session，返回新 token
pub async fn relogin(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    if acc.username.is_empty() || acc.password.is_empty() {
        return Err("该账号无本地凭证，无法自动重登".into());
    }
    let resp = api
        .request(Req {
            method: "POST",
            path: "/api/auth/login".into(),
            body: Some(json!({"username": acc.username, "password": acc.password})),
            token: None,
            response_state: "full",
            timeout_secs: 25,
        })
        .await
        .map_err(|e| e.to_string())?;
    let token = resp["data"]["sessionToken"].as_str().unwrap_or("").to_string();
    if token.is_empty() {
        return Err("自动重登失败：无 sessionToken".into());
    }
    let db = db.lock().unwrap();
    db.update_session(acc.id, Some(&token)).map_err(|e| e.to_string())?;
    Ok(token)
}

/// 强制重登（忽略旧 token），供"访问被拒后再试一次"的路径使用
pub async fn force_relogin(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    relogin(db, api, acc).await
}

fn random_password() -> String {
    const CHARS: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut s = String::new();
    for _ in 0..12 {
        s.push(CHARS[(rand::random::<u32>() % CHARS.len() as u32) as usize] as char);
    }
    s
}

async fn register_account_req(
    api: &Api,
    username: &str,
    password: &str,
) -> Result<(String, String), String> {
    let resp = api
        .request(Req {
            method: "POST",
            path: "/api/auth/register".into(),
            body: Some(json!({"username": username, "password": password})),
            token: None,
            response_state: "full",
            timeout_secs: 25,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = resp.get("data").cloned().ok_or("注册响应缺少 data")?;
    let token = data["sessionToken"].as_str().unwrap_or("").to_string();
    let user_id = data["currentUserId"].as_str().unwrap_or("").to_string();
    if token.is_empty() {
        return Err("注册失败：无 sessionToken".into());
    }
    Ok((token, user_id))
}

/// 创建正式（持久化）小号：自动生成唯一用户名+密码，走 /api/auth/register
pub async fn register_alt(db: &Mutex<Db>, api: &Api, job: &str) -> Result<i64, String> {
    for _ in 0..5 {
        let username = format!("vip_{:08x}", rand::random::<u64>());
        let password = random_password();
        match register_account_req(api, &username, &password).await {
            Ok((token, user_id)) => {
                let nick = default_nickname(&username);
                let acc = Account {
                    id: 0,
                    role: "alt".into(),
                    username,
                    password,
                    user_id,
                    nickname: nick.clone(),
                    job: job.into(),
                    device_id: api.device_id.clone(),
                    session_token: Some(token),
                    enabled: true,
                    created_at: now_ms(),
                };
                let db = db.lock().unwrap();
                let id = db.insert_account(&acc).map_err(|e| e.to_string())?;
                let _ = db.update_nickname_job(id, &nick, job);
                return Ok(id);
            }
            Err(e) => {
                if e.contains("已存在") || e.contains("存在") || e.contains("占用") {
                    continue; // 用户名撞了，换一个重试
                }
                return Err(e);
            }
        }
    }
    Err("创建正式小号失败：多次用户名冲突".into())
}

/// 试玩小号转正：reset-credentials（已实测 {username,password} 即可，temporary→custom）
/// 成功返回 (新用户名, 新密码)，并同步本地 accounts
pub async fn promote_alt(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    new_username: &str,
    new_password: &str,
) -> Result<(String, String), String> {
    let token = ensure_session(db, api, acc).await?;
    let username = if new_username.trim().is_empty() {
        format!("vip_{:08x}", rand::random::<u64>())
    } else {
        new_username.trim().to_string()
    };
    let password = if new_password.trim().is_empty() {
        random_password()
    } else {
        new_password.to_string()
    };
    api.request(Req {
        method: "POST",
        path: "/api/auth/reset-credentials".into(),
        body: Some(json!({"username": username, "password": password})),
        token: Some(&token),
        response_state: "omit",
        timeout_secs: 25,
    })
    .await
    .map_err(|e| e.to_string())?;
    {
        let db = db.lock().unwrap();
        db.update_credentials(acc.id, &username, &password)
            .map_err(|e| e.to_string())?;
    }
    Ok((username, password))
}

#[cfg(test)]
mod tests {
    use super::beijing_day;

    #[test]
    fn beijing_day_basics() {
        assert_eq!(beijing_day(0), "1970-01-01");
        // UTC 23:59 仍是北京同日
        assert_eq!(beijing_day(57_540_000), "1970-01-01");
        // UTC 00:01 已跨北京次日
        assert_eq!(beijing_day(57_660_000), "1970-01-02");
    }

    #[test]
    fn beijing_day_modern() {
        // 2026-08-25 00:05 (+08)
        assert_eq!(beijing_day(1_787_587_500_000), "2026-08-25");
        // 2026-08-24 23:59 (+08)
        assert_eq!(beijing_day(1_787_587_140_000), "2026-08-24");
    }
}