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
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(62);
    let acc = accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?;
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let token = ensure_session(&db, &api, acc).await?;
    let st = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    println!("服务端 currentMap = {}", st["player"]["currentMap"]);
    println!("等级={} 战力={}", st["player"]["level"], st["player"]["power"]);
    // maps 全列表（同一次）
    let secs = api.view_sections(&token, &["maps"]).await.unwrap_or_default();
    let maps = secs["maps"].as_array().cloned().unwrap_or_default();
    println!("== 可见 maps ({}) ==", maps.len());
    for m in &maps {
        println!("  {} reqLv={} entryPwr={}", m["key"].as_str().unwrap_or(""), m["requiredLevel"].as_i64().unwrap_or(0), m["entryPower"].as_i64().unwrap_or(0));
    }
    // bosses 当前图的 personal/map
    let bs = api.view_sections(&token, &["bosses"]).await.unwrap_or_default();
    let cur_map = st["player"]["currentMap"].as_str().unwrap_or("");
    let bosses = bs["bosses"].as_array().cloned().unwrap_or_default();
    println!("== 当前图({cur_map})的 personal/map boss ==");
    for b in bosses.iter() {
        let t = b["type"].as_str().unwrap_or("");
        if (t=="personal"||t=="map") && b["mapKey"].as_str()==Some(cur_map) {
            println!("  {} name={} reqPwr={} diff_cnt={}", b["key"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or(""), b["requiredPower"].as_i64().unwrap_or(0), b["difficultyOptions"].as_array().map(|x|x.len()).unwrap_or(0));
        }
    }
    Ok(())
}
