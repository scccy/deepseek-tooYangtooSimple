//! M5 副职业循环：settle 收进度 → 智能填充制作队列 → 口粮/首领药剂就位
//! 实测结论：
//! - enqueue 不校验当前职业：采集/烹饪/炼金动作可混排同一队列（"副职业选什么不影响制作"）
//! - select 只是确立专精加成（采药专精：-10% 耗时 +20% 经验），一旦确立不可改（400）
//! - 策略：按最高等级优先；经验口粮（travel/royal 按 stat=exp）只有"快没用了"才制作；
//!   采集动作（inputs 空）作为原料底仓；药剂在没装配/库存空时补。
//! 主号小号统一同一套逻辑。

use super::api::Api;
use super::auth::ensure_session;
use super::db::{Account, Db};
use serde_json::{json, Value};
use std::sync::Mutex;

/// 经验口粮（stat=exp，自动提高挂机经验）
fn is_exp_food(key: &str) -> bool {
    matches!(key, "travel_ration" | "royal_feast")
}

/// 判断"经验口粮是否快没用了"：当前激活的不是经验类 / 剩余不足 30 分钟 / 库存经验口粮为 0
fn need_exp_food(p: &Value) -> bool {
    let supplies = &p["supplies"];
    let food_key = supplies["foodKey"].as_str().unwrap_or("").to_string();
    let remain = supplies["foodRemainingSeconds"].as_i64().unwrap_or(0);
    let stock = p["itemAmounts"]["travel_ration"].as_i64().unwrap_or(0)
        + p["itemAmounts"]["royal_feast"].as_i64().unwrap_or(0);
    if food_key.is_empty() {
        return true;
    }
    if !is_exp_food(&food_key) {
        return true; // 当前吃的是金币口粮等非经验口粮 → 也要补经验口粮
    }
    remain < 1800 || stock <= 0
}

/// 可制作数量：已解锁且按「每种材料最多可用 (库存-预留) 个」算出的可做次数。
/// 公式：每种 input 材料可消耗 = 库存 - 预留，除以单次消耗取整；各材料取最小。
/// 采集类（inputs 空）不受材料限制返回大数。
/// 当前调用都传 reserve=0（原材料不设保留；炼金的"保留 100"指**产物**库存，见候选构建）。
fn craft_count(a: &Value, amt: &dyn Fn(&str) -> i64, reserve: i64) -> i64 {
    if !a["unlocked"].as_bool().unwrap_or(false) {
        return 0;
    }
    let Some(ips) = a["inputs"].as_array() else {
        return 999_999; // 采集类
    };
    if ips.is_empty() {
        return 999_999;
    }
    let mut n = i64::MAX;
    for ip in ips {
        let need = ip["amount"].as_i64().unwrap_or(0);
        let have = amt(ip["itemKey"].as_str().unwrap_or(""));
        if need <= 0 {
            continue;
        }
        let usable = (have - reserve).max(0);
        n = n.min(usable / need);
    }
    if n == i64::MAX {
        999_999
    } else {
        n
    }
}

/// 配方材料描述（供日志显示："曦光叶×8、苍蓝鳞×2/次"）；采集类返回空
fn recipe_desc(a: &Value) -> String {
    a["inputs"]
        .as_array()
        .map(|ips| {
            ips.iter()
                .map(|ip| {
                    format!(
                        "{}×{}",
                        ip["itemKey"].as_str().unwrap_or("?"),
                        ip["amount"].as_i64().unwrap_or(0)
                    )
                })
                .collect::<Vec<_>>()
                .join(" + ")
        })
        .unwrap_or_default()
}

/// 全量候选里选"最高等级"（同级按基础经验高者优先），返回最优动作
fn pick_best<'a>(cands: impl Iterator<Item = &'a Value>) -> Option<&'a Value> {
    cands.max_by_key(|a| {
        (
            a["requiredLevel"].as_i64().unwrap_or(0),
            a["baseExp"].as_i64().unwrap_or(0),
        )
    })
}

/// enqueue 带 409 乐观锁重试：settle 后服务端状态持续推进会把 enqueue 判为版本冲突，
/// 等一拍重试一次；仍失败则返回错误（记入日志，留到下个循环再补）。
async fn enqueue_retry(api: &Api, token: &str, action_key: &str, count: i64) -> Result<(), String> {
    let mut last_err = match api
        .mutate(token, "/api/professions/queue/enqueue", json!({"actionKey": action_key, "count": count}))
        .await
    {
        Ok(_) => return Ok(()),
        Err(e) => e.to_string(),
    };
    if last_err.contains("worker 更新") {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        match api
            .mutate(token, "/api/professions/queue/enqueue", json!({"actionKey": action_key, "count": count}))
            .await
        {
            Ok(_) => return Ok(()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

pub async fn professions_loop(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    opts: &super::scheduler::SchedulerOpts,
) -> Result<String, String> {
    let token = ensure_session(db, api, acc).await?;

    // 1) select 配置职业（仅首次可确立；已确立会 400，忽略——选什么不影响制作）
    let secs = api
        .view_sections(&token, &["professions"])
        .await
        .map_err(|e| e.to_string())?;
    let selected = secs["professions"]["selectedProfessionKey"].as_str().unwrap_or("").to_string();
    if selected != opts.profession_key {
        let _ = api
            .mutate(&token, "/api/professions/select", json!({"professionKey": opts.profession_key}))
            .await;
    }

    // 2) 收取已完成进度（队列空也安全）
    let _ = api.mutate(&token, "/api/professions/settle", json!({})).await;

    // 3) 智能填充制作队列（采集+加工全链路，主号小号统一）
    let secs2 = api
        .view_sections(&token, &["professions"])
        .await
        .map_err(|e| e.to_string())?;
    let p = &secs2["professions"];
    let actions = p["actions"].as_array().cloned().unwrap_or_default();
    let queue_len = p["queue"].as_array().map(|q| q.len()).unwrap_or(0);
    let queue_limit = p["queueLimit"].as_i64().unwrap_or(5);
    let amt = |k: &str| -> i64 { p["itemAmounts"][k].as_i64().unwrap_or(0) };

    let mut notes: Vec<String> = Vec::new();
    let queue_len = queue_len as i64;
    let max_add = (queue_limit - queue_len).max(0);
    // 产物驱动 + 按需采集：四职业一直做、不停。
    // - 炼金：产物（药剂）库存低于常备线(100) = "产物没了"，材料够就补做这个配方（最高级优先）；
    //   材料不够 → 自动采集该配方的缺失材料（对应采集动作）补料进队。
    //   所有产物都 ≥100 时仍做最高级可做药剂（炼金等级要继续涨）。
    // - 采集：有缺料需求 → 按需采（补产物缺口）；无缺料 → 采药/钓鱼最高级（原料底仓）。
    // - 烹饪：经验口粮快没 → 经验配方；否则 → 最高级烹饪配方（金币口粮）。
    const PROF_NEED_KEEP: i64 = 100; // 产物常备线：药剂库存低于此视为"没了要补"
    let mut candidates: Vec<&Value> = Vec::new();
    let is_gather = |a: &Value| a["inputs"].as_array().map(|i| i.is_empty()).unwrap_or(false);
    let is_food = |a: &Value| a["professionKey"].as_str() == Some("cooking");
    let out_key = |a: &Value| a["output"]["itemKey"].as_str().unwrap_or("").to_string();
    let alchemy_all: Vec<&Value> = actions
        .iter()
        .filter(|a| a["professionKey"].as_str() == Some("alchemy") && !is_gather(a))
        .collect();
    let need_recipes: Vec<&Value> = alchemy_all
        .iter()
        .filter(|a| amt(&out_key(a)) < PROF_NEED_KEEP)
        .copied()
        .collect();
    // 缺料分析：缺产配方里材料不足的 → 找到产出该材料的采集动作（补料）
    let mut want_gather: Vec<&Value> = Vec::new();
    for r in &need_recipes {
        if let Some(ips) = r["inputs"].as_array() {
            for ip in ips {
                let ik = ip["itemKey"].as_str().unwrap_or("");
                if ik.is_empty() || amt(ik) >= ip["amount"].as_i64().unwrap_or(0) {
                    continue; // 材料够，不需要补采
                }
                let g = pick_best(actions.iter().filter(|a| {
                    is_gather(a)
                        && a["unlocked"].as_bool().unwrap_or(false)
                        && a["output"]["itemKey"].as_str() == Some(ik)
                }));
                if let Some(g) = g {
                    if !want_gather.contains(&g) {
                        want_gather.push(g);
                    }
                }
            }
        }
    }
    // 采集：按需补料优先；无缺料 → 采药/钓鱼最高级兜底
    if want_gather.is_empty() {
        if let Some(ac) = pick_best(
            actions
                .iter()
                .filter(|a| a["professionKey"].as_str() == Some("herbalism") && is_gather(a) && a["unlocked"].as_bool().unwrap_or(false)),
        ) {
            candidates.push(ac);
        }
        if let Some(ac) = pick_best(
            actions
                .iter()
                .filter(|a| a["professionKey"].as_str() == Some("fishing") && is_gather(a) && a["unlocked"].as_bool().unwrap_or(false)),
        ) {
            candidates.push(ac);
        }
    } else {
        candidates.extend(want_gather);
    }
    // 炼金：缺产配方（材料够）最高级优先补货；无缺产 → 最高级可做（升级不停）
    let craftable: Vec<&Value> = alchemy_all
        .iter()
        .filter(|a| craft_count(a, &amt, 0) > 0)
        .copied()
        .collect();
    if let Some(ac) = pick_best(craftable.iter().filter(|a| amt(&out_key(a)) < PROF_NEED_KEEP).map(|a| *a)) {
        candidates.push(ac);
    } else if let Some(ac) = pick_best(craftable.iter().map(|a| *a)) {
        candidates.push(ac);
    }
    // 烹饪（一直做）：经验口粮快没 → 经验配方；否则 → 最高级烹饪配方（金币口粮）
    let cooking_cand = actions
        .iter()
        .filter(|a| is_food(a) && craft_count(a, &amt, 0) > 0);
    let cooking_target = if need_exp_food(p) {
        pick_best(
            cooking_cand
                .clone()
                .filter(|a| a["output"]["itemKey"].as_str().map(is_exp_food).unwrap_or(false)),
        )
    } else {
        pick_best(
            cooking_cand
                .clone()
                .filter(|a| !a["output"]["itemKey"].as_str().map(is_exp_food).unwrap_or(true)),
        )
    };
    if let Some(ac) = cooking_target {
        candidates.push(ac);
    }
    let mut added = 0i64;
    for ac in candidates {
        if added >= max_add {
            break;
        }
        let Some(ak) = ac["key"].as_str() else { continue };
        let maxc = ac["maxCraftable"].as_i64().unwrap_or(0);
        let by_material = craft_count(ac, &amt, 0);
        let count = 60.min(if maxc > 0 { maxc } else { 60 }).min(by_material).max(1);
        let recipe = recipe_desc(ac);
        let recipe_note = if recipe.is_empty() {
            "采集".to_string()
        } else {
            let out_owned = amt(ac["output"]["itemKey"].as_str().unwrap_or(""));
            format!("配方:{recipe} 产物{out_owned}")
        };
        match enqueue_retry(api, &token, ak, count).await {
            Ok(()) => {
                notes.push(format!("{}×{count}（{}）", ac["name"].as_str().unwrap_or(ak), recipe_note));
                added += 1;
            }
            Err(e) => {
                notes.push(format!("{}×{count} 失败:{e}", ac["name"].as_str().unwrap_or(ak)));
            }
        }
    }
    let note = if notes.is_empty() {
        "队列已满/无可执行动作".to_string()
    } else {
        notes.join("，")
    };

    // 4) 补给装配（有货才装；经验口粮优先，其次金币口粮；首领药剂按需）
    if opts.supply_auto {
        let state = api.bootstrap(&token).await.unwrap_or(Value::Null);
        if let Some(items) = state.get("items").and_then(|v| v.as_array()) {
            let exp_food = items
                .iter()
                .filter(|it| it["status"].as_str() == Some("in_bag"))
                .filter(|it| matches!(it["itemKey"].as_str(), Some("royal_feast") | Some("travel_ration")))
                .max_by_key(|it| quality_rank(it["quality"].as_str().unwrap_or("white")));
            let food = exp_food
                .or_else(|| {
                    items
                        .iter()
                        .filter(|it| it["status"].as_str() == Some("in_bag"))
                        .filter(|it| matches!(it["itemKey"].as_str(), Some("lucky_feast") | Some("dragon_feast")))
                        .max_by_key(|it| quality_rank(it["quality"].as_str().unwrap_or("white")))
                });
            if let Some(f) = food {
                let _ = api
                    .mutate(&token, "/api/professions/supply/equip", json!({"supplyType": "food", "itemKey": f["itemKey"].as_str().unwrap_or("")}))
                    .await;
            }
            let potion = items
                .iter()
                .filter(|it| it["status"].as_str() == Some("in_bag"))
                .filter(|it| {
                    matches!(
                        it["itemKey"].as_str(),
                        Some("assault_tonic")
                            | Some("guardian_tonic")
                            | Some("fortune_tonic")
                            | Some("berserker_tonic")
                            | Some("aegis_tonic")
                            | Some("shatter_tonic")
                    )
                })
                .next();
            if let Some(p) = potion {
                let _ = api
                    .mutate(&token, "/api/professions/supply/equip", json!({"supplyType": "bossPotion", "itemKey": p["itemKey"].as_str().unwrap_or("")}))
                    .await;
            }
        }
    }

    Ok(format!("副职业循环：{note}（{}）", opts.profession_key))
}

fn quality_rank(q: &str) -> i32 {
    match q {
        "white" => 0,
        "green" => 1,
        "blue" => 2,
        "purple" => 3,
        "orange" => 4,
        "red" => 5,
        "gold" => 6,
        _ => 0,
    }
}