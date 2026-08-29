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
    let before = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    println!("换图前: 当前图={}", before["player"]["currentMap"]);
    let r = placegame_vip_client_lib::engine::guild::change_best_map(&api, &token).await;
    println!("change_best_map -> {:?}", r);
    let after = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    println!("换图后: 当前图={}", after["player"]["currentMap"]);
    Ok(())
}
