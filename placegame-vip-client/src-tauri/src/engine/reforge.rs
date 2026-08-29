//! M7 大号养成自动化（仅大号，默认关 growth_enabled）
//! 顺序（设计 §5.11）：词条继承 → 洗练补词 → 强化 →（可选）强化继承。
//! 预算：金币/元宝双熔断（meta.growth_spent_{gold,rare}:{today} 当日累计，preview 取成本字段）。
//! 安全：来源销毁类只用背包胚子；强化继承默认关且需元宝预算>0；全部 preview 先行。

use super::api::Api;
use super::auth::{ensure_session, now_ms, beijing_day};
use super::db::{Account, Db, RunRow};
use super::scheduler::SchedulerOpts;
use serde_json::{json, Value};
use std::sync::Mutex;

const ENHANCE_LEVEL_CAP: i64 = 12; // 强化等级上限（安全顶，服务端如有更高由 preview 决定）

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

fn run_count(db: &Mutex<Db>, acc_id: i64, task: &str, prefix: &str) -> i64 {
    db.lock()
        .unwrap()
        .count_runs_with_prefix(acc_id, task, prefix)
        .unwrap_or(0)
}

fn spent(db: &Mutex<Db>, kind: &str, today: &str) -> i64 {
    db.lock()
        .unwrap()
        .get_meta(&format!("growth_spent_{kind}:{today}"))
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

fn add_spent(db: &Mutex<Db>, kind: &str, today: &str, delta: i64) {
    let cur = spent(db, kind, today);
    let _ = db
        .lock()
        .unwrap()
        .set_meta(&format!("growth_spent_{kind}:{today}"), &(cur + delta).to_string());
}

/// 从 preview 响应里取成本（字段未实测，多候选兜底）；取不到返回 None = 成本字段未识别。
/// 调用方必须 fail-closed：成本未知时绝不放行花钱动作——否则预算熔断形同虚设，
/// 真实金币/元宝在无预算保护的情况下被消耗（且花费无法入账）。
fn preview_cost(p: &Value, key_candidates: &[&str]) -> Option<i64> {
    let data = p.get("data").cloned().unwrap_or(json!({}));
    for k in key_candidates {
        if let Some(v) = data.get(*k).and_then(|v| v.as_i64()) {
            return Some(v);
        }
    }
    None
}

/// 装备词条集合（字段未实测，多候选兜底）
fn item_affixes(e: &Value) -> Vec<String> {
    for field in ["affixes", "reforgeStats", "rolledStats", "stats"] {
        if let Some(arr) = e.get(field).and_then(|v| v.as_array()) {
            let out: Vec<String> = arr
                .iter()
                .filter_map(|s| {
                    s.as_str()
                        .map(|x| x.to_string())
                        .or_else(|| s["key"].as_str().map(|x| x.to_string()))
                })
                .collect();
            if !out.is_empty() {
                return out;
            }
        }
    }
    vec![]
}

pub async fn growth_main(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    opts: &SchedulerOpts,
) -> Result<String, String> {
    if !opts.growth_enabled {
        return Ok("大号养成未开启".into());
    }
    let token = ensure_session(db, api, main).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let today = beijing_day(now_ms());
    let eqs = state
        .get("equipment")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut acts: Vec<String> = Vec::new();

    for e in &eqs {
        if e["status"].as_str() != Some("equipped") {
            continue;
        }
        let slot = e["slot"].as_str().unwrap_or("").to_string();
        if !opts.growth_slots.is_empty() && !opts.growth_slots.iter().any(|s| s == &slot) {
            continue;
        }
        let eq_id = e["id"].as_str().unwrap_or("").to_string();
        if eq_id.is_empty() {
            continue;
        }
        let affixes = item_affixes(e);
        let locked: Vec<String> = affixes
            .iter()
            .filter(|a| opts.reforge_target_stats.iter().any(|t| t == *a))
            .cloned()
            .collect();

        // ---- 1) 词条继承（每日每件 1 次；来源只用背包胚子，绝不用在役装备）----
        let inherit_key = format!("inherit:{today}:{eq_id}");
        let inherited = db
            .lock()
            .unwrap()
            .get_run(main.id, "inherit", &inherit_key)
            .ok()
            .flatten()
            .is_some();
        if !inherited && locked.len() < opts.reforge_target_stats.len() {
            // 找胚子：同部位、背包内、未锁定、带目标词条且该词条主装还没有
            let missing: Vec<&String> = opts
                .reforge_target_stats
                .iter()
                .filter(|t| !locked.contains(t))
                .collect();
            let source = eqs.iter().find(|s| {
                s["status"].as_str() == Some("in_bag")
                    && s["slot"].as_str() == Some(slot.as_str())
                    && !s["locked"].as_bool().unwrap_or(false)
                    && item_affixes(s).iter().any(|a| missing.iter().any(|m| *m == a))
            });
            if let Some(src) = source {
                let src_id = src["id"].as_str().unwrap_or("").to_string();
                let body = json!({"targetEquipmentId": eq_id, "sourceEquipmentId": src_id});
                let prev = api.mutate(&token, "/api/equipment/affix-inherit-preview", body.clone()).await;
                match prev {
                    Ok(p) => match preview_cost(&p, &["costGold", "goldCost", "cost"]) {
                        None => rec(db, main.id, "inherit", &inherit_key, false, "preview 成本字段未识别，为保护预算跳过".into()),
                        Some(cost) if spent(db, "gold", &today) + cost > opts.growth_gold_budget => {
                            rec(db, main.id, "inherit", &inherit_key, false, "金币预算熔断".into());
                        }
                        Some(cost) => {
                            if api.mutate(&token, "/api/equipment/affix-inherit", body).await.is_ok() {
                                add_spent(db, "gold", &today, cost);
                                rec(db, main.id, "inherit", &inherit_key, true, format!("胚子 {src_id} 继承入 {slot}"));
                                acts.push(format!("继承:{slot}"));
                            }
                        }
                    },
                    Err(_) => rec(db, main.id, "inherit", &inherit_key, false, "preview 失败".into()),
                }
            }
        }

        // ---- 2) 洗练补词（每日每件 ≤ reforge_max_per_day；锁已命中目标词条）----
        let reforge_prefix = format!("reforge:{today}:{eq_id}");
        let reforged = run_count(db, main.id, "reforge", &reforge_prefix);
        let graduated = locked.len() as i64 >= opts.growth_stop_quality;
        if !graduated && reforged < opts.reforge_max_per_day {
            let target = opts
                .reforge_target_stats
                .iter()
                .find(|t| !locked.contains(t))
                .cloned();
            if let Some(target_stat) = target {
                let body = json!({"equipmentId": eq_id, "lockedStats": locked, "targetStat": target_stat});
                let run_key = format!("{reforge_prefix}:{}", reforged + 1);
                match api.mutate(&token, "/api/equipment/reforge-preview", body.clone()).await {
                    Ok(p) => match preview_cost(&p, &["costGold", "goldCost", "cost"]) {
                        None => rec(db, main.id, "reforge", &run_key, false, "preview 成本字段未识别，为保护预算跳过".into()),
                        Some(cost) if spent(db, "gold", &today) + cost > opts.growth_gold_budget => {
                            rec(db, main.id, "reforge", &run_key, false, "金币预算熔断".into());
                        }
                        Some(cost) => {
                            if api.mutate(&token, "/api/equipment/reforge", body).await.is_ok() {
                                add_spent(db, "gold", &today, cost);
                                rec(db, main.id, "reforge", &run_key, true, format!("洗 {slot} 目标 {target_stat}"));
                                acts.push(format!("洗练:{slot}"));
                            } else {
                                rec(db, main.id, "reforge", &run_key, false, "reforge 失败".into());
                            }
                        }
                    },
                    Err(_) => rec(db, main.id, "reforge", &run_key, false, "preview 失败".into()),
                }
            }
        }

        // ---- 3) 强化（每日每件 ≤ enhance_max_per_day；+11 起必带保护符）----
        let enh = e["enhanceLevel"].as_i64().unwrap_or(0);
        let enhance_prefix = format!("enhance:{today}:{eq_id}");
        let enhanced = run_count(db, main.id, "enhance", &enhance_prefix);
        if enh < ENHANCE_LEVEL_CAP && enhanced < opts.enhance_max_per_day {
            let use_protect = enh >= opts.enhance_protect_from;
            let run_key = format!("{enhance_prefix}:{}", enhanced + 1);
            let prev = api
                .mutate(&token, "/api/equipment/enhance-preview", json!({"equipmentId": eq_id, "useProtectCharm": use_protect}))
                .await;
            match prev {
                Ok(p) => {
                    let cost_gold = preview_cost(&p, &["costGold", "goldCost", "cost"]);
                    // 元宝成本：不带保护符时无元宝消耗（字段缺失视为 0）；带保护符时字段缺失 = 成本未知 → 熔断
                    let cost_rare = preview_cost(&p, &["costRareCoin", "rareCost"]).or_else(|| if use_protect { None } else { Some(0) });
                    if cost_gold.is_none() || cost_rare.is_none() {
                        rec(db, main.id, "enhance", &run_key, false, "preview 成本字段未识别，为保护预算跳过".into());
                    } else {
                        let cost_gold = cost_gold.unwrap();
                        let cost_rare = cost_rare.unwrap();
                        if spent(db, "gold", &today) + cost_gold > opts.growth_gold_budget {
                            rec(db, main.id, "enhance", &run_key, false, "金币预算熔断".into());
                        } else if cost_rare > 0 && spent(db, "rare", &today) + cost_rare > opts.growth_rare_budget {
                            rec(db, main.id, "enhance", &run_key, false, "元宝预算熔断".into());
                        } else if api
                            .mutate(&token, "/api/equipment/enhance", json!({"equipmentId": eq_id, "useProtectCharm": use_protect}))
                            .await
                            .is_ok()
                        {
                            add_spent(db, "gold", &today, cost_gold);
                            add_spent(db, "rare", &today, cost_rare);
                            rec(db, main.id, "enhance", &run_key, true, format!("+{enh}→{}{}", enh + 1, if use_protect { "（保护符）" } else { "" }));
                            acts.push(format!("强化:{slot}+{}", enh + 1));
                        } else {
                            rec(db, main.id, "enhance", &run_key, false, "enhance 失败（连败停手）".into());
                        }
                    }
                }
                Err(_) => rec(db, main.id, "enhance", &run_key, false, "preview 失败".into()),
            }
        }

        // ---- 4) 强化继承（默认关；高风险：失败摧毁目标，需元宝预算>0 且每日全账号最多 1 次）----
        if opts.enhance_inherit_enabled && opts.growth_rare_budget > 0 {
            let inh_key = format!("enhance_inherit:{today}");
            let done = db
                .lock()
                .unwrap()
                .get_run(main.id, "enhance_inherit", &inh_key)
                .ok()
                .flatten()
                .is_some();
            if !done {
                // 来源：背包内同部位、强化等级更高的胚子
                let source = eqs.iter().find(|s| {
                    s["status"].as_str() == Some("in_bag")
                        && s["slot"].as_str() == Some(slot.as_str())
                        && s["enhanceLevel"].as_i64().unwrap_or(0) > enh
                });
                if let Some(src) = source {
                    let src_id = src["id"].as_str().unwrap_or("").to_string();
                    let body = json!({"targetEquipmentId": eq_id, "sourceEquipmentId": src_id});
                    match api.mutate(&token, "/api/equipment/enhance-inherit-preview", body.clone()).await {
                        Ok(p) => match preview_cost(&p, &["costRareCoin", "rareCost"]) {
                            None => rec(db, main.id, "enhance_inherit", &inh_key, false, "preview 成本字段未识别，为保护预算跳过".into()),
                            Some(cost_rare) if spent(db, "rare", &today) + cost_rare > opts.growth_rare_budget => {
                                rec(db, main.id, "enhance_inherit", &inh_key, false, "元宝预算熔断".into());
                            }
                            Some(cost_rare) => {
                                if api.mutate(&token, "/api/equipment/enhance-inherit", body).await.is_ok() {
                                    add_spent(db, "rare", &today, cost_rare);
                                    rec(db, main.id, "enhance_inherit", &inh_key, true, format!("强化继承入 {slot}"));
                                    acts.push(format!("强化继承:{slot}"));
                                } else {
                                    rec(db, main.id, "enhance_inherit", &inh_key, false, "失败（高风险动作已熔断当日）".into());
                                }
                            }
                        },
                        Err(_) => rec(db, main.id, "enhance_inherit", &inh_key, false, "preview 失败".into()),
                    }
                }
            }
        }
    }

    Ok(format!(
        "大号养成：{}（金币已用 {}/{} 元宝已用 {}/{}）",
        if acts.is_empty() { "无动作".into() } else { acts.join("、") },
        spent(db, "gold", &today),
        opts.growth_gold_budget,
        spent(db, "rare", &today),
        opts.growth_rare_budget
    ))
}

// ============================================================================
// 交互式装备洗练（独立 tab 页面，对官网洗练界面；与上面的定时自动化解耦）
// ============================================================================

/// 部位目录（官网 10 部位）
const SLOT_CATALOG: [(&str, &str); 10] = [
    ("weapon", "武器"), ("armor", "衣服"), ("helmet", "头盔"), ("necklace", "项链"),
    ("bracelet", "手镯"), ("ring", "戒指"), ("belt", "腰带"), ("boots", "鞋子"),
    ("talisman", "护符"), ("medal", "勋章"),
];

/// 词条目录（官网 20 属性，洗练保底/锁定用）
const STAT_CATALOG: [(&str, &str); 20] = [
    ("hp", "生命"), ("attack", "攻击"), ("magicAttack", "魔攻"), ("summonAttack", "召唤"),
    ("defense", "防御"), ("magicDefense", "魔防"), ("hit", "命中"), ("dodge", "闪避"),
    ("crit", "暴击"), ("critDamage", "爆伤"), ("attackSpeed", "攻速"), ("luck", "幸运"),
    ("expBonus", "经验"), ("goldBonus", "金币"), ("dropBonus", "爆率"), ("rareDropBonus", "极品掉率"),
    ("bossDropBonus", "首领掉落"), ("lifesteal", "吸血"), ("bossDamage", "首领伤害"), ("idleEfficiency", "挂机效率"),
];

/// 词条（key+value 结构化，供页面逐条锁定）
fn item_affix_detail(e: &Value) -> Vec<Value> {
    for field in ["affixes", "reforgeStats", "rolledStats", "stats"] {
        if let Some(arr) = e.get(field).and_then(|v| v.as_array()) {
            let out: Vec<Value> = arr
                .iter()
                .filter_map(|s| {
                    if let Some(k) = s.as_str() {
                        Some(json!({ "key": k, "value": Value::Null }))
                    } else {
                        let key = s["key"]
                            .as_str()
                            .or_else(|| s["stat"].as_str())
                            .or_else(|| s["name"].as_str())?;
                        let value = s.get("value").cloned().unwrap_or(Value::Null);
                        Some(json!({ "key": key, "value": value }))
                    }
                })
                .collect();
            if !out.is_empty() {
                return out;
            }
        }
    }
    vec![]
}

/// 多路径取数值（金币/元宝所在 section 未实测，多候选兜底）
fn pick_num(state: &Value, paths: &[&[&str]]) -> i64 {
    for path in paths {
        let mut cur = state;
        let mut ok = true;
        for seg in *path {
            match cur.get(*seg) {
                Some(v) => cur = v,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            if let Some(n) = cur.as_i64().or_else(|| cur.as_f64().map(|f| f as i64)) {
                return n;
            }
        }
    }
    0
}

/// 交互页：拉取大号装备 + 货币 + 目录
pub async fn fetch_reforge_state(db: &Mutex<Db>, api: &Api, main: &Account) -> Result<Value, String> {
    let token = ensure_session(db, api, main).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let gold = pick_num(&state, &[&["player", "gold"], &["currencies", "gold"], &["profile", "gold"], &["gold"]]);
    let rare = pick_num(
        &state,
        &[&["player", "rareCoin"], &["currencies", "rareCoin"], &["profile", "rareCoin"], &["rareCoin"]],
    );
    let eqs = state
        .get("equipment")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let items: Vec<Value> = eqs
        .iter()
        .filter(|e| {
            let st = e["status"].as_str().unwrap_or("");
            st == "equipped" || st == "in_bag"
        })
        .map(|e| {
            json!({
                "id": e["id"].as_str().unwrap_or(""),
                "name": e["name"].as_str().unwrap_or(""),
                "slot": e["slot"].as_str().unwrap_or(""),
                "quality": e["quality"].as_str().unwrap_or("white"),
                "score": e["score"].as_f64().unwrap_or(0.0),
                "level": e["level"].as_i64().unwrap_or(0),
                "enhanceLevel": e["enhanceLevel"].as_i64().unwrap_or(0),
                "locked": e["locked"].as_bool().unwrap_or(false),
                "bindStatus": e["bindStatus"].as_str().unwrap_or(""),
                "status": e["status"].as_str().unwrap_or(""),
                "affixes": item_affix_detail(e),
            })
        })
        .collect();
    Ok(json!({
        "gold": gold,
        "rareCoin": rare,
        "equipment": items,
        "statCatalog": STAT_CATALOG.iter().map(|(k, n)| json!([k, n])).collect::<Vec<_>>(),
        "slotCatalog": SLOT_CATALOG.iter().map(|(k, n)| json!([k, n])).collect::<Vec<_>>(),
    }))
}

/// 交互页：洗练预览
pub async fn reforge_preview(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    equipment_id: &str,
    locked_stats: &[String],
    target_stat: &str,
) -> Result<Value, String> {
    let token = ensure_session(db, api, main).await?;
    let body = json!({
        "equipmentId": equipment_id,
        "lockedStats": locked_stats,
        "targetStat": target_stat,
    });
    api.mutate(&token, "/api/equipment/reforge-preview", body)
        .await
        .map_err(|e| e.to_string())
}

/// 交互页：洗练执行（记录一条运行日志）
pub async fn reforge_exec(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    equipment_id: &str,
    locked_stats: &[String],
    target_stat: &str,
) -> Result<Value, String> {
    let token = ensure_session(db, api, main).await?;
    let body = json!({
        "equipmentId": equipment_id,
        "lockedStats": locked_stats,
        "targetStat": target_stat,
    });
    let r = api
        .mutate(&token, "/api/equipment/reforge", body)
        .await
        .map_err(|e| e.to_string())?;
    let today = beijing_day(now_ms());
    rec(
        db,
        main.id,
        "reforge_manual",
        &format!("reforge_manual:{today}:{}", now_ms()),
        true,
        format!("手动洗练 {equipment_id} 目标 {target_stat} 锁定 {locked_stats:?}"),
    );
    Ok(r)
}

/// 交互页：装备锁定/解锁切换
pub async fn equipment_toggle_lock(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    equipment_id: &str,
) -> Result<Value, String> {
    let token = ensure_session(db, api, main).await?;
    api.mutate(&token, "/api/equipment/toggle-lock", json!({ "equipmentId": equipment_id }))
        .await
        .map_err(|e| e.to_string())
}
