//! 副职业机制探测：select 切职业是否清队列 / 能否跨职业 enqueue / 切换代价
//! 运行：cargo run --example prof_probe [account_id]（默认主号；建议传测试小号 id）

use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::ensure_session;
use placegame_vip_client_lib::engine::db::Db;
use serde_json::json;
use std::path::Path;
use std::sync::Mutex;

async fn snapshot(api: &Api, token: &str) -> (String, usize, String) {
    let s = api.view_sections(token, &["professions"]).await.unwrap();
    let p = &s["professions"];
    (
        p["selectedProfessionKey"].as_str().unwrap_or("").to_string(),
        p["queue"].as_array().map(|q| q.len()).unwrap_or(0),
        p["queue"]
            .as_array()
            .map(|q| serde_json::to_string(q).unwrap_or_default())
            .unwrap_or_default(),
    )
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db_path = format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db");
    let db = Db::open(Path::new(&db_path))?;
    let db = Mutex::new(db);
    let accounts = db.lock().unwrap().list_accounts()?;
    for a in &accounts {
        println!("acc #{} role={} user={} enabled={}", a.id, a.role, a.username, a.enabled);
    }
    let target_id: Option<i64> = std::env::args().nth(1).and_then(|s| s.parse().ok());
    let acc = match target_id {
        Some(id) => accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?,
        None => accounts.iter().find(|a| a.role == "main").ok_or("无主号")?,
    };
    println!("\n=== 探测账号 #{} {} ===", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let token = ensure_session(&db, &api, acc).await?;
    let (sel0, q0, q0s) = snapshot(&api, &token).await;
    println!("BEFORE: selected={sel0} queue_len={q0} queue={q0s}");

    // 1) select 切到 cooking
    let r1 = api
        .mutate(&token, "/api/professions/select", json!({"professionKey": "cooking"}))
        .await;
    println!("select cooking -> {:?}", r1.map(|v| serde_json::to_string(&v).unwrap_or_default()));
    let (sel1, q1, q1s) = snapshot(&api, &token).await;
    println!("AFTER select: selected={sel1} queue_len={q1} queue={q1s}");

    // 2) 现在是 cooking，尝试 enqueue 采集动作（跨职业）
    let r2 = api
        .mutate(&token, "/api/professions/queue/enqueue", json!({"actionKey": "gather_sunleaf", "count": 1}))
        .await;
    println!("enqueue gather_sunleaf(herbalism) while cooking -> {:?}", r2.map(|v| serde_json::to_string(&v).unwrap_or_default()));
    let (sel2, q2, q2s) = snapshot(&api, &token).await;
    println!("AFTER enqueue: selected={sel2} queue_len={q2} queue={q2s}");

    // 3) 再试 enqueue 本职业 cooking 配方
    let r3 = api
        .mutate(&token, "/api/professions/queue/enqueue", json!({"actionKey": "cook_travel_ration", "count": 1}))
        .await;
    println!("enqueue cook_travel_ration(cooking) while cooking -> {:?}", r3.map(|v| serde_json::to_string(&v).unwrap_or_default()));
    let (sel3, q3, q3s) = snapshot(&api, &token).await;
    println!("AFTER cook enqueue: selected={sel3} queue_len={q3} queue={q3s}");

    // 4) 恢复原职业
    let r4 = api
        .mutate(&token, "/api/professions/select", json!({"professionKey": sel0}))
        .await;
    println!("restore select {sel0} -> {:?}", r4.map(|v| serde_json::to_string(&v).unwrap_or_default()));
    let (sel4, q4, q4s) = snapshot(&api, &token).await;
    println!("RESTORED: selected={sel4} queue_len={q4} queue={q4s}");
    Ok(())
}