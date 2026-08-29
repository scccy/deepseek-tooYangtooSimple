//! 奇遇选项实测：对指定账号连续 collect，触发奇遇时 dump adventure 完整结构（options 全字段）
//! 运行：cargo run --example adv_inspect [account_id 默认25] [次数 默认3]

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
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(25);
    let rounds: i64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let acc = accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?;
    println!("=== 账号 #{} {} ===", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let token = ensure_session(&db, &api, acc).await?;
    let mut triggered = 0;
    for i in 0..rounds {
        // 先看有没有收益
        let sum = api
            .request(
                placegame_vip_client_lib::engine::api::Req {
                    method: "GET",
                    path: "/api/client/idle-summary".into(),
                    body: None,
                    token: Some(&token),
                    response_state: "omit",
                    timeout_secs: 20,
                },
            )
            .await?;
        let sum = sum.get("data").cloned().unwrap_or(sum);
        let gains = {
            let get = |k: &str| sum.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
            get("exp") > 0 || get("gold") > 0 || get("killCount") > 0 || get("dropCount") > 0
        };
        if !gains {
            println!("第{}次：暂无挂机收益（不触发）", i + 1);
            continue;
        }
        let r = api.mutate(&token, "/api/client/collect", json!({})).await;
        match r {
            Ok(v) => {
                let data = v.get("data").cloned().unwrap_or(v);
                if data.get("adventure").map(|a| a.is_object()).unwrap_or(false) {
                    triggered += 1;
                    println!("==== 第{}次 触发奇遇 ====", i + 1);
                    println!("{}", serde_json::to_string_pretty(&data["adventure"]).unwrap_or_default());
                    // 打印每个 option 的全部字段名
                    if let Some(opts) = data["adventure"]["options"].as_array() {
                        for (j, o) in opts.iter().enumerate() {
                            let keys: Vec<&str> = o.as_object().map(|m| m.keys().map(|k| k.as_str()).collect()).unwrap_or_default();
                            println!("option[{j}] fields={:?}", keys);
                        }
                    }
                } else {
                    println!("第{}次：collect 未触发奇遇", i + 1);
                }
                // 若还带 adventure 就随手选第一个/经验项结算掉，避免滞留
                if data.get("adventure").map(|a| a.is_object()).unwrap_or(false) {
                    if let Some(o) = data["adventure"]["options"].as_array().and_then(|a| a.first()) {
                        if let Some(k) = o["key"].as_str() {
                            let _ = api
                                .mutate(&token, "/api/client/collect", json!({"adventureOptionKey": k}))
                                .await;
                            println!("（已结算 option: {k}）");
                        }
                    }
                }
            }
            Err(e) => println!("第{}次 collect 失败: {}", i + 1, e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    println!("共触发奇遇 {triggered} 次");
    Ok(())
}