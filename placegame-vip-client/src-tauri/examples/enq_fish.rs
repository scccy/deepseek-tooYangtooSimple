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
    let main = accounts.iter().find(|a| a.role == "main").unwrap();
    let api = Api::new(DEFAULT_BASE_URL.to_string(), main.device_id.clone());
    let token = ensure_session(&db, &api, main).await?;
    let r = api.mutate(&token, "/api/professions/queue/enqueue", json!({"actionKey": "fish_azure_scale", "count": 60})).await;
    println!("enqueue fish_azure_scale x60 -> {:?}", r.map(|v| v.get("data").and_then(|d| d.get("result")).and_then(|x| x.get("queue")).map(|q| serde_json::to_string(q).unwrap_or_default()).unwrap_or_default()));
    Ok(())
}
