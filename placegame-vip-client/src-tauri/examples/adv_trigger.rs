use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::{ensure_session, force_relogin};
use placegame_vip_client_lib::engine::db::Db;
use serde_json::json;
use std::path::Path;
use std::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db = Db::open(Path::new(&format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db")))?;
    let db = Mutex::new(db);
    let accounts = db.lock().unwrap().list_accounts()?;
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(21);
    let rounds: i64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(8);
    let acc = accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?;
    println!("=== #{} {} ===", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let mut tok = ensure_session(&db, &api, acc).await?;
    for i in 0..rounds {
        // 409 worker 冲突 → 重登
        let r = match api.mutate(&tok, "/api/client/collect", json!({})).await {
            Err(e) if e.to_string().contains("worker 更新") => {
                let _ = force_relogin(&db, &api, acc).await;
                tok = ensure_session(&db, &api, acc).await?;
                api.mutate(&tok, "/api/client/collect", json!({})).await
            }
            r => r,
        };
        match r {
            Ok(v) => {
                let data = v.get("data").cloned().unwrap_or(v);
                if data.get("adventure").map(|a| a.is_object()).unwrap_or(false) {
                    println!("==== 第{}次 触发奇遇 ====", i + 1);
                    println!("{}", serde_json::to_string_pretty(&data["adventure"]).unwrap_or_default());
                    return Ok(());
                } else {
                    println!("第{}次 collect 成功，未触发奇遇", i + 1);
                }
            }
            Err(e) => println!("第{}次 失败: {}", i + 1, e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    }
    println!("{} 次未触发奇遇", rounds);
    Ok(())
}
