use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::ensure_session;
use placegame_vip_client_lib::engine::db::Db;
use std::path::Path;
use std::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db = Db::open(Path::new(&format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db")))?;
    let db = Mutex::new(db);
    let accounts = db.lock().unwrap().list_accounts()?;
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(21);
    let acc = accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?;
    println!("=== #{} {} ===", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let token = ensure_session(&db, &api, acc).await?;
    // bootstrap 全量
    let b = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let s = serde_json::to_string_pretty(&b).unwrap_or_default();
    std::fs::write("/tmp/state_bootstrap.json", &s)?;
    // 顶层 key
    let keys: Vec<&str> = b.as_object().map(|m| m.keys().map(|k| k.as_str()).collect()).unwrap_or_default();
    println!("bootstrap 顶层字段: {}", keys.join(", "));
    // idle-summary 全量
    let sum = api.request(placegame_vip_client_lib::engine::api::Req {
        method: "GET", path: "/api/client/idle-summary".into(), body: None,
        token: Some(&token), response_state: "omit", timeout_secs: 20,
    }).await.map_err(|e| e.to_string())?;
    std::fs::write("/tmp/state_idle.json", serde_json::to_string_pretty(&sum).unwrap_or_default())?;
    println!("idle-summary 已存 /tmp/state_idle.json");
    Ok(())
}
