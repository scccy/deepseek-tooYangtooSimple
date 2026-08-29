//! 批量扫号触发奇遇，抓 options 真实字段结构
//! 运行：cargo run --example adv_sweep [from] [to]

use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::{ensure_session, force_relogin};
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
    let from: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(3);
    let to: i64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    let mut hit = 0;
    for acc in accounts.iter().filter(|a| a.enabled && a.id >= from && a.id <= to) {
        let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
        let token = match ensure_session(&db, &api, acc).await {
            Ok(t) => t,
            Err(e) => { println!("#{} err {}", acc.id, e); continue; }
        };
        let sum = api.request(placegame_vip_client_lib::engine::api::Req {
            method: "GET", path: "/api/client/idle-summary".into(), body: None,
            token: Some(&token), response_state: "omit", timeout_secs: 20,
        }).await.ok();
        let sum = sum.and_then(|v| v.get("data").cloned()).unwrap_or(json!({}));
        let gains = {
            let get = |k: &str| sum.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
            get("exp") > 0 || get("gold") > 0 || get("killCount") > 0 || get("dropCount") > 0 || get("rareCoinFragments") > 0
        };
        if !gains {
            println!("#{} 暂无收益", acc.id);
            continue;
        }
        let mut tok = token;
        let r = match api.mutate(&tok, "/api/client/collect", json!({})).await {
            Err(e) if e.to_string().contains("worker 更新") => {
                let _ = force_relogin(&db, &api, acc).await;
                match ensure_session(&db, &api, acc).await {
                    Ok(t2) => { tok = t2; api.mutate(&tok, "/api/client/collect", json!({})).await }
                    Err(e2) => Err(placegame_vip_client_lib::engine::api::ApiError::Network(e2)),
                }
            }
            r => r,
        };
        match r {
            Ok(v) => {
                let data = v.get("data").cloned().unwrap_or(v);
                if data.get("adventure").map(|a| a.is_object()).unwrap_or(false) {
                    hit += 1;
                    println!("#{} 触发奇遇！adventure 结构：", acc.id);
                    println!("{}", serde_json::to_string_pretty(&data["adventure"]).unwrap_or_default());
                    if let Some(opts) = data["adventure"]["options"].as_array() {
                        for (j, o) in opts.iter().enumerate() {
                            let keys: Vec<&str> = o.as_object().map(|m| m.keys().map(|k| k.as_str()).collect()).unwrap_or_default();
                            println!("  option[{j}] fields={keys:?}");
                        }
                    }
                    // 结算（选第一个），避免滞留
                    if let Some(o) = data["adventure"]["options"].as_array().and_then(|a| a.first()) {
                        if let Some(k) = o["key"].as_str() {
                            let _ = api.mutate(&tok, "/api/client/collect", json!({"adventureOptionKey": k})).await;
                        }
                    }
                    if hit >= 3 { break; } // 抓到 3 次足够
                } else {
                    println!("#{} collect 成功，未触发奇遇", acc.id);
                }
            }
            Err(e) => println!("#{} collect 失败: {}", acc.id, e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
    println!("共触发奇遇 {hit} 次");
    Ok(())
}
