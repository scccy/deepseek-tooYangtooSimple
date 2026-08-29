//! 批量检查各账号副职业现状：selected / 采药等级 / 是否已确立专精
//! 运行：cargo run --example prof_check [max_accounts]

use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::ensure_session;
use placegame_vip_client_lib::engine::db::Db;
use std::path::Path;
use std::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db_path = format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db");
    let db = Db::open(Path::new(&db_path))?;
    let db = Mutex::new(db);
    let accounts = db.lock().unwrap().list_accounts()?;
    let enabled: Vec<_> = accounts.iter().filter(|a| a.enabled).collect();
    let max: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(enabled.len());
    println!("启用账号 {} 个，本次扫描前 {} 个", enabled.len(), max.min(enabled.len()));
    let mut never: Vec<String> = Vec::new();
    for (i, a) in enabled.iter().enumerate() {
        if i >= max {
            break;
        }
        let api = Api::new(DEFAULT_BASE_URL.to_string(), a.device_id.clone());
        let token = match ensure_session(&db, &api, a).await {
            Ok(t) => t,
            Err(e) => {
                println!("#{} {} err={}", a.id, a.role, e);
                continue;
            }
        };
        let secs = api.view_sections(&token, &["professions"]).await.unwrap_or_default();
        let p = &secs["professions"];
        let sel = p["selectedProfessionKey"].as_str().unwrap_or("").to_string();
        let mut profs = String::new();
        if let Some(arr) = p["professions"].as_array() {
            for pr in arr {
                profs.push_str(&format!(
                    "{}L{} ",
                    pr["key"].as_str().unwrap_or(""),
                    pr["level"].as_i64().unwrap_or(0)
                ));
            }
        }
        if sel.is_empty() {
            never.push(format!("#{} {}", a.id, a.username));
        }
        println!("#{} {} selected={} | {}", a.id, a.role, if sel.is_empty() { "(未确立)" } else { &sel }, profs);
    }
    println!("\n未确立专精的号: {}", if never.is_empty() { "无".to_string() } else { never.join(", ") });
    Ok(())
}