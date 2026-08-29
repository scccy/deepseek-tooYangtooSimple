//! M6 内部市场闭环（小号↔大号，默认关 market_internal）
//! 设计 §5.10：不做公开价格发现，交易对家全是自家账号。
//! 大号侧：求购单巡检（积压提价/撤单）+ 收小号的卖单；小号侧：交付大号求购 + 溢出挂单 + 超时撤单。
//! 注意：create-buy-order / fulfill-buy-order 字段按文档 §4.6 形状 best-effort 实现（§5.13-13 待实测），
//! 失败走退避，默认关闭不影响其他模块。门槛已实测（marketAccess.canTrade）。

use super::api::Api;
use super::auth::{ensure_session, now_ms, beijing_day};
use super::db::{Account, Db, RunRow};
use super::scheduler::SchedulerOpts;
use serde_json::{json, Value};
use std::sync::Mutex;

const ORDER_STALE_UPPRICE_MS: i64 = 24 * 3600_000; // 求购积压 24h 提价
const ORDER_STALE_CANCEL_MS: i64 = 48 * 3600_000; // 卖单 48h 未成交撤单

fn rec(db: &Mutex<Db>, acc_id: i64, task: &str, run_key: &str, ok: bool, detail: String) {
    let now = now_ms();
    let row = RunRow {
        account_id: acc_id,
        task: task.into(),
        run_key: run_key.into(),
        status: if ok { "ok".into() } else { "failed".into() },
        detail,
        started_at: now,
        finished_at: now,
    };
    if let Ok(guard) = db.lock() {
        let _ = guard.touch_run(&row, true);
    }
}

/// 当日市场动作笔数（挂单/交付/收购合计，用于 market_daily_cap 熔断）
fn today_deal_count(db: &Mutex<Db>, acc_id: i64, today: &str) -> i64 {
    let mut n = 0;
    for t in ["market_buy", "market_fulfill", "market_list"] {
        n += db
            .lock()
            .unwrap()
            .count_runs_with_prefix(acc_id, t, &format!("{t}:{today}"))
            .unwrap_or(0);
    }
    n
}

async fn get_json(api: &Api, token: &str, path: &str) -> Result<Value, String> {
    let v = api
        .request(super::api::Req {
            method: "GET",
            path: path.into(),
            body: None,
            token: Some(token),
            response_state: "omit",
            timeout_secs: 20,
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(v.get("data").cloned().unwrap_or(json!({})))
}

fn orders_of(data: &Value) -> Vec<Value> {
    data.as_array()
        .cloned()
        .or_else(|| data.get("orders").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default()
}

fn order_ts(o: &Value) -> i64 {
    for k in ["createdAt", "created_at", "listedAt"] {
        if let Some(t) = o.get(k).and_then(|v| v.as_i64()) {
            return t;
        }
    }
    0
}

fn owner_id(o: &Value) -> String {
    for k in ["ownerUserId", "userId", "sellerUserId", "buyerUserId"] {
        if let Some(s) = o.get(k).and_then(|v| v.as_str()) {
            return s.to_string();
        }
    }
    String::new()
}

/// 市场门槛检查（已实测字段）
async fn check_access(api: &Api, token: &str) -> Result<(), String> {
    let secs = api
        .view_sections(token, &["marketAccess"])
        .await
        .map_err(|e| e.to_string())?;
    if secs["marketAccess"]["canTrade"].as_bool().unwrap_or(false) {
        Ok(())
    } else {
        Err(format!(
            "市场未解锁：{}",
            secs["marketAccess"]["blockedReason"].as_str().unwrap_or("门槛不足")
        ))
    }
}

/// 内部市场主循环：按角色分流（每日幂等由调度器 step! 保证，成交笔数上限在此兜底）
pub async fn market_internal_loop(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    opts: &SchedulerOpts,
) -> Result<String, String> {
    if !opts.market_internal {
        return Ok("内部市场未开启".into());
    }
    let token = ensure_session(db, api, acc).await?;
    check_access(api, &token).await?;

    let today = beijing_day(now_ms());
    if today_deal_count(db, acc.id, &today) >= opts.market_daily_cap {
        return Ok("已达每日成交上限".into());
    }

    if acc.role == "main" {
        main_side(db, api, acc, opts, &token, &today).await
    } else {
        alt_side(db, api, acc, opts, &token, &today).await
    }
}

/// 大号：求购单巡检（积压>24h 按系数提价、需求过期撤单）+ 收购小号卖单
async fn main_side(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    opts: &SchedulerOpts,
    token: &str,
    today: &str,
) -> Result<String, String> {
    let mut acts: Vec<String> = Vec::new();

    // 1) 我的挂单巡检：求购单积压提价 / 过期撤单
    // 读取失败必须显式报错（之前静默吞掉会整步"无待办"假成功，问题无可见性）
    let data = get_json(api, token, "/api/market/my-orders?status=active")
        .await
        .map_err(|e| format!("市场挂单巡检读取失败: {e}"))?;
    for o in orders_of(&data) {
        let oid = o["orderId"].as_str().or_else(|| o["id"].as_str()).unwrap_or("").to_string();
        if oid.is_empty() {
            continue;
        }
        let is_buy = o["orderType"].as_str() == Some("buy") || o["side"].as_str() == Some("buy");
        let age = now_ms() - order_ts(&o);
        if is_buy && age > ORDER_STALE_UPPRICE_MS {
            let cur_price = o["price"].as_i64().unwrap_or(0);
            if cur_price > 0 {
                // 梯度提价：当前价 × 系数，系数封顶 1.5（validate 已限制 0.8-1.5）
                let new_price = ((cur_price as f64) * (1.0 + opts.market_price_factor.min(1.5) * 0.2)) as i64;
                let run_key = format!("market_maintain:{today}:{oid}");
                let ok = api
                    .mutate(token, "/api/market/update-price", json!({"orderId": oid, "price": new_price.max(cur_price + 1)}))
                    .await
                    .is_ok();
                rec(db, main.id, "market_maintain", &run_key, ok, format!("求购提价 {cur_price}→{new_price}"));
                if ok {
                    acts.push(format!("提价:{oid}"));
                }
            }
        } else if age > ORDER_STALE_CANCEL_MS {
            let run_key = format!("market_maintain:{today}:{oid}:cancel");
            let ok = api
                .mutate(token, "/api/market/cancel", json!({"orderId": oid}))
                .await
                .is_ok();
            rec(db, main.id, "market_maintain", &run_key, ok, "超时撤单".into());
            if ok {
                acts.push(format!("撤单:{oid}"));
            }
        }
    }

    // 2) 收购小号卖单：公开列表按 owner ∈ 自家小号 user_id 过滤
    let alt_ids: Vec<String> = db
        .lock()
        .unwrap()
        .list_accounts()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.role == "alt" && !a.user_id.is_empty())
        .map(|a| a.user_id)
        .collect();
    if !alt_ids.is_empty() {
        let data = get_json(api, token, "/api/market/orders?orderType=sell&scope=all")
            .await
            .map_err(|e| format!("市场卖单列表读取失败: {e}"))?;
        for o in orders_of(&data) {
            if !alt_ids.iter().any(|id| id == &owner_id(&o)) {
                continue; // 只买自家小号的单
            }
            let oid = o["orderId"].as_str().or_else(|| o["id"].as_str()).unwrap_or("").to_string();
            if oid.is_empty() {
                continue;
            }
            if today_deal_count(db, main.id, today) >= opts.market_daily_cap {
                break;
            }
            let run_key = format!("market_buy:{today}:{oid}");
            let done = db.lock().unwrap().get_run(main.id, "market_buy", &run_key).ok().flatten().is_some();
            if done {
                continue;
            }
            let ok = api
                .mutate(token, "/api/market/buy", json!({"orderId": oid, "quantity": o["amount"].as_i64().unwrap_or(1)}))
                .await
                .is_ok();
            rec(db, main.id, "market_buy", &run_key, ok, format!("收购小号卖单 {oid}"));
            if ok {
                acts.push(format!("收货:{oid}"));
            }
        }
    }

    Ok(if acts.is_empty() { "内部市场（大号）：无待办".into() } else { format!("内部市场（大号）：{}", acts.join("、")) })
}

/// 小号：交付大号求购（背包有货 → fulfill）+ 溢出材料挂单 + 卖单超时撤单
async fn alt_side(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    opts: &SchedulerOpts,
    token: &str,
    today: &str,
) -> Result<String, String> {
    let mut acts: Vec<String> = Vec::new();

    // 大号 user_id（求购单归属判定）
    let main_uid = db
        .lock()
        .unwrap()
        .mains()
        .unwrap_or_default()
        .first()
        .map(|m| m.user_id.clone())
        .unwrap_or_default();
    if main_uid.is_empty() {
        return Ok("内部市场（小号）：大号未识别".into());
    }

    // 1) 交付大号求购单
    let data = get_json(api, token, "/api/market/orders?orderType=buy&scope=all")
        .await
        .map_err(|e| format!("市场求购列表读取失败: {e}"))?;
    {
        let state = api.bootstrap(token).await.map_err(|e| format!("市场背包读取失败: {e}"))?;
        let bag: Vec<Value> = state
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for o in orders_of(&data) {
            if owner_id(&o) != main_uid {
                continue; // 只交付自家大号的求购
            }
            let oid = o["orderId"].as_str().or_else(|| o["id"].as_str()).unwrap_or("").to_string();
            let want_key = o["itemKey"].as_str().unwrap_or("").to_string();
            if oid.is_empty() || want_key.is_empty() {
                continue;
            }
            // 背包里找匹配物品（未绑定、非保留清单）
            let held = bag.iter().find(|it| {
                it["itemKey"].as_str() == Some(want_key.as_str())
                    && it["bindStatus"].as_str() == Some("unbound")
                    && !opts.deny_donate.iter().any(|d| d == &want_key)
            });
            let Some(held) = held else { continue };
            let amount = o["amount"].as_i64().unwrap_or(1).min(held["amount"].as_i64().unwrap_or(0));
            if amount <= 0 {
                continue;
            }
            if today_deal_count(db, acc.id, today) >= opts.market_daily_cap {
                break;
            }
            let run_key = format!("market_fulfill:{today}:{oid}");
            let done = db.lock().unwrap().get_run(acc.id, "market_fulfill", &run_key).ok().flatten().is_some();
            if done {
                continue;
            }
            let ok = api
                .mutate(token, "/api/market/fulfill-buy-order", json!({"orderId": oid, "amount": amount}))
                .await
                .is_ok();
            rec(db, acc.id, "market_fulfill", &run_key, ok, format!("交付 {want_key} x{amount}"));
            if ok {
                acts.push(format!("交付:{want_key}x{amount}"));
            }
        }
    }

    // 2) 我的卖单超时撤单（48h 未成交 → 撤下，改走捐赠/分解由既有流程处理）
    let my_orders = get_json(api, token, "/api/market/my-orders?status=active")
        .await
        .map_err(|e| format!("市场卖单列表读取失败: {e}"))?;
    for o in orders_of(&my_orders) {
        let oid = o["orderId"].as_str().or_else(|| o["id"].as_str()).unwrap_or("").to_string();
        if oid.is_empty() {
            continue;
        }
        if now_ms() - order_ts(&o) > ORDER_STALE_CANCEL_MS {
            let run_key = format!("market_maintain:{today}:{oid}:cancel");
            let ok = api.mutate(token, "/api/market/cancel", json!({"orderId": oid})).await.is_ok();
            rec(db, acc.id, "market_maintain", &run_key, ok, "卖单超时撤单".into());
            if ok {
                acts.push(format!("撤单:{oid}"));
            }
        }
    }

    // 3) 溢出材料挂单（每日一次，run_key 幂等）：非保留/未绑定材料，价格=参考价×系数
    let list_key = format!("market_list:{today}");
    let listed = db.lock().unwrap().get_run(acc.id, "market_list", &list_key).ok().flatten().is_some();
    if !listed {
        let state = api.bootstrap(token).await.map_err(|e| format!("市场背包读取失败: {e}"))?;
        let bag: Vec<Value> = state
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut n = 0usize;
        for it in &bag {
            if it["itemType"].as_str() != Some("material") || it["bindStatus"].as_str() != Some("unbound") {
                continue;
            }
            let key = it["itemKey"].as_str().unwrap_or("").to_string();
            if key.is_empty() || opts.deny_donate.iter().any(|d| d == &key) {
                continue;
            }
            let amount = it["amount"].as_i64().unwrap_or(0);
            if amount <= 0 {
                continue;
            }
            let ref_price = it["referencePrice"].as_i64().or_else(|| it["price"].as_i64()).unwrap_or(0);
            if ref_price <= 0 {
                continue; // 无参考价锚不定内部价，跳过（风控边界）
            }
            let price = ((ref_price as f64) * opts.market_price_factor) as i64;
            let item_id = it["id"].as_str().or_else(|| it["itemId"].as_str()).unwrap_or("").to_string();
            if item_id.is_empty() {
                continue;
            }
            if today_deal_count(db, acc.id, today) >= opts.market_daily_cap {
                break;
            }
            if api
                .mutate(
                    token,
                    "/api/market/create-order",
                    json!({"itemType": "material", "itemId": item_id, "amount": amount, "currencyType": "gold", "price": price.max(1)}),
                )
                .await
                .is_ok()
            {
                n += 1;
            }
        }
        rec(db, acc.id, "market_list", &list_key, true, format!("挂单 {n} 种材料"));
        if n > 0 {
            acts.push(format!("挂单:{n}种"));
        }
    }

    Ok(if acts.is_empty() { "内部市场（小号）：无待办".into() } else { format!("内部市场（小号）：{}", acts.join("、")) })
}
