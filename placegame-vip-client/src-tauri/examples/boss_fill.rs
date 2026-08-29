use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::db::Db;
use placegame_vip_client_lib::engine::scheduler::SchedulerOpts;
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
    println!("=== #{} {} ===", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let opts = SchedulerOpts::default();
    let main_slot: Option<&str> = None;
    let r = placegame_vip_client_lib::engine::boss::boss_solo_daily(
        &db, &api, acc, true, "none", main_slot, &opts.boss_set_quality, &opts.boss_set_rareness,
    ).await;
    println!("boss_solo -> {:?}", r);
    Ok(())
}
