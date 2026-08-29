//! 验证新版副职业循环：主号跑一次 professions_loop，看是否能跨职业排入烹饪/采集动作
//! 运行：cargo run --example prof_fill [account_id]（默认主号）

use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::ensure_session;
use placegame_vip_client_lib::engine::db::Db;
use placegame_vip_client_lib::engine::profession::professions_loop;
use placegame_vip_client_lib::engine::scheduler::SchedulerOpts;
use std::path::Path;
use std::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db_path = format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db");
    let db = Db::open(Path::new(&db_path))?;
    let db = Mutex::new(db);
    let accounts = db.lock().unwrap().list_accounts()?;
    let target_id: Option<i64> = std::env::args().nth(1).and_then(|s| s.parse().ok());
    let acc = match target_id {
        Some(id) => accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?,
        None => accounts.iter().find(|a| a.role == "main").ok_or("无主号")?,
    };
    println!("账号 #{} {}", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let opts = SchedulerOpts::default();
    let token = ensure_session(&db, &api, acc).await?;
    // 跑前队列
    let before = api.view_sections(&token, &["professions"]).await?;
    println!(
        "BEFORE queue: {}",
        serde_json::to_string(&before["professions"]["queue"]).unwrap_or_default()
    );
    let r = professions_loop(&db, &api, acc, &opts).await;
    println!("professions_loop -> {:?}", r);
    let after = api.view_sections(&token, &["professions"]).await?;
    println!(
        "AFTER queue: {}",
        serde_json::to_string(&after["professions"]["queue"]).unwrap_or_default()
    );
    Ok(())
}