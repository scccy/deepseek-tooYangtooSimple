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
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let acc = accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?;
    println!("=== #{} {} (lv? 战力?) ===", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let token = ensure_session(&db, &api, acc).await?;
    let st = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    println!("player: level={} power={} map={}", st["player"]["level"], st["player"]["power"], st["player"]["currentMap"]);
    let secs = api.view_sections(&token, &["bosses"]).await.map_err(|e| e.to_string())?;
    let bosses = secs["bosses"].as_array().cloned().unwrap_or_default();
    println!("== 个人/地图 boss ==");
    for b in bosses.iter() {
        let t = b["type"].as_str().unwrap_or("");
        if t != "personal" && t != "map" { continue; }
        println!("- {} | {} | {} | reqPwr={}",
            b["key"].as_str().unwrap_or("?"),
            b["name"].as_str().unwrap_or("?"),
            b["mapKey"].as_str().unwrap_or("?"),
            b["requiredPower"].as_i64().unwrap_or(0));
        if let Some(opts) = b["difficultyOptions"].as_array() {
            for o in opts {
                println!("    diff={} win={} block={} ticket={}/{} free={}",
                    o["key"].as_str().unwrap_or("?"),
                    o["predictedWin"].as_bool().unwrap_or(false),
                    o["blockedReason"].as_str().unwrap_or(""),
                    o["ticketCost"].as_i64().unwrap_or(0),
                    o["ownedTickets"].as_i64().unwrap_or(0),
                    b["personalAttemptPool"]["freeRemaining"].as_i64().unwrap_or(0));
            }
        }
    }
    Ok(())
}
