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
    let lvl = st["player"]["level"].as_i64().unwrap_or(0);
    let pw = st["player"]["power"].as_i64().unwrap_or(0);
    let cur = st["player"]["currentMap"].as_str().unwrap_or("");
    println!("等级={lvl} 战力={pw} 当前图={cur}");
    let secs = api.view_sections(&token, &["maps"]).await.map_err(|e| e.to_string())?;
    let maps = secs["maps"].as_array().cloned().unwrap_or_default();
    println!("== maps 列表 ==");
    for m in &maps {
        let key = m["key"].as_str().unwrap_or("");
        let rl = m["requiredLevel"].as_i64().unwrap_or(i64::MAX);
        let ep = m["entryPower"].as_i64().unwrap_or(i64::MAX);
        let name = m["name"].as_str().unwrap_or("");
        let ok = rl <= lvl && ep <= pw;
        let tag = if ok { "Y" } else { "n" };
        println!("  {key} | {name} | reqLv={rl} entryPwr={ep} | 可选={tag}");
    }
    Ok(())
}
