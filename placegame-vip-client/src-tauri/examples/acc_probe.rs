use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::ensure_session;
use placegame_vip_client_lib::engine::db::Db;
use serde_json::Value;
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
    println!("=== #{} {} role={} job={} enabled={} ===", acc.id, acc.username, acc.role, acc.job, acc.enabled);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let token = ensure_session(&db, &api, acc).await?;
    let st = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let p = &st["player"];
    println!("等级={} 战力={} 当前地图={} job={}", p["level"], p["power"], p["currentMap"], p["job"]);
    // 当前地图
    // 装备明细（背包+穿戴）
    let eqs = st["equipment"].as_array().cloned().unwrap_or_default();
    println!("装备数: {}", eqs.len());
    let rank = |r: &str| match r { "大极品"=>4, "极品"=>3, "小极品"=>2, _=>1 };
    // 概览每个部位的已穿戴
    let mut slots: std::collections::BTreeMap<String, Vec<(String,String,i64,String)>> = Default::default();
    for e in &eqs {
        let slot = e["slot"].as_str().unwrap_or("").to_string();
        if slot.is_empty() { continue; }
        slots.entry(slot).or_default().push((
            e["status"].as_str().unwrap_or("").to_string(),
            e["quality"].as_str().unwrap_or("").to_string(),
            e["score"].as_f64().unwrap_or(0.0) as i64,
            e["rareRank"].as_str().unwrap_or("").to_string(),
        ));
    }
    for (slot, list) in &slots {
        let worn: Vec<_> = list.iter().filter(|x| x.0=="equipped").collect();
        let bag: Vec<_> = list.iter().filter(|x| x.0=="in_bag").collect();
        let w = worn.iter().map(|x| format!("{}/{}", x.1, x.3)).collect::<Vec<_>>().join(" ");
        let b = bag.iter().map(|x| format!("{}/{}", x.1, x.3)).collect::<Vec<_>>().join(" ");
        println!("  {slot}: 穿戴[{w}] 背包[{b}]");
    }
    Ok(())
}
