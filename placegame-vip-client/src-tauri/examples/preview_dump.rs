use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::ensure_session;
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
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let acc = accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?;
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let token = ensure_session(&db, &api, acc).await?;
    for (bk, diff) in [("boar_king", "nightmare"), ("boar_king", "normal"), ("skeleton_warlord", "normal")] {
        let r = api.mutate(&token, "/api/boss/preview", json!({"bossKey": bk, "difficulty": diff, "useMaterialBoost": false, "affixKey": "none", "targetSlot": "weapon"})).await;
        match r {
            Ok(v) => {
                println!("=== preview {bk}/{diff} ===");
                println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            }
            Err(e) => println!("preview {bk}/{diff} 失败: {e}"),
        }
    }
    Ok(())
}
