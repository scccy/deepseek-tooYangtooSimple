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
    let eqs = st["equipment"].as_array().cloned().unwrap_or_default();
    println!("玩家等级={lvl}");
    for e in &eqs {
        if e["status"].as_str() != Some("in_bag") { continue; }
        let q = e["quality"].as_str().unwrap_or("");
        let lv = e["level"].as_i64().unwrap_or(0);
        let sc = e["score"].as_f64().unwrap_or(0.0) as i64;
        let bind = e["bindStatus"].as_str().unwrap_or("");
        println!("in_bag: {}-{} lv={} score={} bind={} slot={} set={}",
            q, e["rareRank"].as_str().unwrap_or(""), lv, sc, bind, e["slot"].as_str().unwrap_or(""), e["setKey"].as_str().unwrap_or(""));
    }
    Ok(())
}
