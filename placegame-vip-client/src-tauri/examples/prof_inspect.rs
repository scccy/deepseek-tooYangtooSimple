//! 副职业实测调研：用主号登录，dump professions section + 背包材料，供分析副职业生产的东西与配方
//! 运行：cargo run --example prof_inspect

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
    let main = accounts
        .iter()
        .find(|a| a.role == "main")
        .ok_or("未找到主号")?;
    println!(
        "=== 主号 #{} {} device={} ===",
        main.id, main.username, main.device_id
    );
    let api = Api::new(DEFAULT_BASE_URL.to_string(), main.device_id.clone());
    let token = ensure_session(&db, &api, main).await?;
    println!("token ok ({} chars)", token.len());

    // 1) professions section 全量
    let secs = api.view_sections(&token, &["professions"]).await?;
    println!("\n=== professions section (全文) ===");
    println!("{}", serde_json::to_string_pretty(&secs).unwrap());

    // 2) bootstrap 背包物品（材料等）—— 只 dump in_bag 且数量>0
    let st = api.bootstrap(&token).await.unwrap_or(serde_json::Value::Null);
    let items = st["items"].as_array().cloned().unwrap_or_default();
    println!("\n=== 背包 in_bag 物品 ({}) ===", items.len());
    let mut n = 0;
    for it in items {
        if it["status"].as_str() != Some("in_bag") {
            continue;
        }
        n += 1;
        if n > 800 {
            break;
        }
        println!(
            "- {} | q={} | {} | cat={} | count={}",
            it["itemKey"].as_str().unwrap_or("?"),
            it["quality"].as_str().unwrap_or("?"),
            it["name"].as_str().unwrap_or("?"),
            it["category"].as_str().unwrap_or("?"),
            it["count"].as_i64().unwrap_or(0)
        );
    }
    println!("in_bag 条目数 = {n}");
    Ok(())
}