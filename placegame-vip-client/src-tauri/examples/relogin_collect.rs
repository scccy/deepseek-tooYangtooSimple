use placegame_vip_client_lib::engine::api::{Api, DEFAULT_BASE_URL};
use placegame_vip_client_lib::engine::auth::{ensure_session, force_relogin};
use placegame_vip_client_lib::engine::collect::{collect_idle_with_pref, has_gains, idle_summary};
use placegame_vip_client_lib::engine::db::Db;
use std::path::Path;
use std::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db = Db::open(Path::new(&format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db")))?;
    let db = Mutex::new(db);
    let accounts = db.lock().unwrap().list_accounts()?;
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(25);
    let acc = accounts.iter().find(|a| a.id == id).ok_or("账号不存在")?;
    println!("=== 账号 #{} {} ===", acc.id, acc.username);
    let api = Api::new(DEFAULT_BASE_URL.to_string(), acc.device_id.clone());
    let t0 = ensure_session(&db, &api, acc).await?;
    println!("旧 token: {} 字符", t0.len());
    // 强制重新登入
    match force_relogin(&db, &api, acc).await {
        Ok(_) => println!("重新登入成功（已更新会话）"),
        Err(e) => println!("重新登入失败: {e}"),
    }
    let t1 = ensure_session(&db, &api, acc).await?;
    println!("新 token: {} 字符", t1.len());
    // 领取收益（默认经验偏好），dump 奇遇
    match idle_summary(&api, &t1).await {
        Ok(sum) if has_gains(&sum) => {
            println!("有收益: 金币={} 碎片={} 击杀={} 掉落={}", sum["gold"].as_i64().unwrap_or(0), sum["rareCoinFragments"].as_i64().unwrap_or(0), sum["killCount"].as_i64().unwrap_or(0), sum["dropCount"].as_i64().unwrap_or(0));
            match collect_idle_with_pref(&db, &api, acc, &t1, "exp").await {
                Ok(data) => {
                    if data.get("adventure").map(|a| a.is_object()).unwrap_or(false) {
                        println!("==== 奇遇 adventure 结构 ====");
                        println!("{}", serde_json::to_string_pretty(&data["adventure"]).unwrap_or_default());
                    } else {
                        println!("collect 成功，本次未触发奇遇");
                    }
                }
                Err(e) => println!("领取失败: {e}"),
            }
        }
        Ok(_) => println!("暂无收益（不触发）"),
        Err(e) => println!("收益预览失败: {e}"),
    }
    Ok(())
}
