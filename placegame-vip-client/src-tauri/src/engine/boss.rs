//! M4 每日 Boss：个人/地图首领(推演可胜才打) + 世界首领协作(每场N次)
//! 字段已实测：bosses 条目 predictedWin/chance/outputReady/survivalReady；difficultyOptions；
//! worldInstance{status, maxAttemptCount, instanceId}；affixes 在 challengeOptions.affixes
//! 挑战配置字段已实测可解析：difficulty / useMaterialBoost / affixKey

use super::api::Api;
use super::auth::ensure_session;
use super::db::{Account, Db};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// 全部装备部位（定向部位下拉/轮换共用）
pub const SLOTS: [&str; 10] = ["weapon", "armor", "helmet", "necklace", "ring", "belt", "bracelet", "boots", "talisman", "medal"];

/// preview 响应里的实测胜负：真实结构 data.result.predictedWin（实测抓包），兼容 data.predictedWin
fn preview_win(p: &Value) -> bool {
    p.get("data")
        .and_then(|d| {
            d.get("result")
                .and_then(|r| r.get("predictedWin"))
                .or_else(|| d.get("predictedWin"))
        })
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// 单场首领挑战核心（主循环与"倒退刷低图"兜底共用）：对给定 boss 的"列表预判可胜"难度档，
/// **从高到低逐档 preview 实测，第一个实测可胜的档就 challenge**；材料加成普通难度不支持时
/// 自动降级去掉。返回 (played, won, diff_idx, diff_key, challenge响应, 实际生效的材料加成)。
/// - played=false：本 boss 当前无可胜档（预测输/门票/阻挡/预览全败），一场没打；
/// - Err：全部难度预览接口都失败（保留首条错误，方便日志诊断）。
async fn play_boss_one(
    api: &Api,
    token: &str,
    boss_key: &str,
    winnable_list: &[(usize, &serde_json::Value)],
    slot: &str,
    material_boost: bool,
    affix_key: &str,
) -> Result<(bool, bool, i64, String, Option<serde_json::Value>, bool), String> {
    let use_affix = if affix_key != "none" { affix_key } else { "none" };
    let mut first_err: Option<String> = None;
    for (idx, opt) in winnable_list.iter().rev() {
        let diff = opt["key"].as_str().unwrap_or("").to_string();
        if diff.is_empty() {
            continue;
        }
        // 材料加成：普通难度不支持 → 自动降级去掉
        let mut use_boost = material_boost;
        let preview = match api
            .mutate(token, "/api/boss/preview", json!({"bossKey": boss_key, "difficulty": diff, "useMaterialBoost": use_boost, "affixKey": use_affix, "targetSlot": slot}))
            .await
        {
            Ok(p) => Ok(p),
            Err(e) if use_boost && e.to_string().contains("材料加成") => {
                use_boost = false;
                api.mutate(token, "/api/boss/preview", json!({"bossKey": boss_key, "difficulty": diff, "useMaterialBoost": false, "affixKey": use_affix, "targetSlot": slot})).await
            }
            Err(e) => Err(e),
        };
        let win = match preview {
            Ok(p) => preview_win(&p),
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(format!("难度[{diff}] 预览接口失败: {e}"));
                }
                continue; // 该档接口失败，试更低难度
            }
        };
        if !win {
            continue; // 该档实测输，试更低难度
        }
        let resp = api
            .mutate(token, "/api/boss/challenge", json!({"bossKey": boss_key, "difficulty": diff, "useMaterialBoost": use_boost, "affixKey": use_affix, "targetSlot": slot}))
            .await;
        // 胜负以响应内容为准（HTTP 200 但战斗失败不算赢）；字段未识别时按 HTTP 成功兜底
        let won = match &resp {
            Ok(v) => challenge_won(v).unwrap_or(true),
            Err(_) => false,
        };
        let resp_val = resp.ok();
        return Ok((true, won, *idx as i64, diff, resp_val, use_boost));
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok((false, false, -1, String::new(), None, material_boost)),
    }
}

/// 记录"打赢"的首领进度：best_index 只在对账打赢的难度时抬升（只记可胜难度，打输不虚报）
fn record_boss_progress(db: &Mutex<Db>, account_id: i64, boss_key: &str, diff: &str, idx: i64, slot: &str) {
    if let Ok(guard) = db.lock() {
        let _ = guard.set_boss_progress(account_id, boss_key, diff, idx, "win", slot);
    }
}

/// 结构化击杀计数：boss_kills:{id}:{day} = {boss_key: n}，供「Boss统计」页聚合今日实际击杀
fn record_boss_kill(db: &Mutex<Db>, account_id: i64, boss_key: &str) {
    if let Ok(guard) = db.lock() {
        let day = super::auth::beijing_day(super::auth::now_ms());
        let mkey = format!("boss_kills:{}:{}", account_id, day);
        let mut m: std::collections::HashMap<String, i64> = guard
            .get_meta(&mkey)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        *m.entry(boss_key.to_string()).or_insert(0) += 1;
        if let Ok(s) = serde_json::to_string(&m) {
            let _ = guard.set_meta(&mkey, &s);
        }
    }
}

/// 挑战响应胜负解析（字段未实测，多候选兜底）：
/// - data.result.won / data.won / data.battle.won / data.victory / data.success 布尔值优先；
/// - 其次扫描 data.notices 文案（胜利/击败/击杀 = 赢，失败/战败/落败 = 输）；
/// - 均无法识别时返回 None，由调用方按 HTTP 成功兜底（不改变原有行为）。
fn challenge_won(v: &Value) -> Option<bool> {
    fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
        let mut cur = v;
        for seg in path {
            cur = cur.get(*seg)?;
        }
        Some(cur)
    }
    for base in [v.get("data").unwrap_or(v), v] {
        for p in [
            &["result", "won"][..],
            &["won"][..],
            &["battle", "won"][..],
            &["battle", "result", "won"][..],
            &["victory"][..],
            &["success"][..],
            &["result", "success"][..],
        ] {
            if let Some(b) = at(base, p).and_then(|x| x.as_bool()) {
                return Some(b);
            }
        }
    }
    if let Some(arr) = v
        .pointer("/data/notices")
        .or_else(|| v.get("notices"))
        .and_then(|x| x.as_array())
    {
        let mut text = String::new();
        for n in arr {
            if let Some(s) = n.as_str().or_else(|| n.get("text").and_then(|t| t.as_str())) {
                text.push_str(s);
            }
        }
        if text.contains("胜利") || text.contains("击败") || text.contains("击杀") {
            return Some(true);
        }
        if text.contains("失败") || text.contains("战败") || text.contains("落败") {
            return Some(false);
        }
    }
    None
}

/// 对象是否像一件装备（掉落判定的宽松特征）
fn looks_like_item(v: &Value) -> bool {
    v.get("status").is_some()
        || v.get("score").is_some()
        || v.get("setKey").is_some()
        || v.get("itemKey").is_some()
        || v.get("equipmentId").is_some()
}

/// 挑战响应里是否掉落过指定部位的装备（递归查找 slot 匹配的装备对象）
fn drop_has_slot(v: &Value, slot: &str) -> bool {
    if v.get("slot").and_then(|s| s.as_str()) == Some(slot) && looks_like_item(v) {
        return true;
    }
    if let Some(arr) = v.as_array() {
        for c in arr {
            if drop_has_slot(c, slot) {
                return true;
            }
        }
    } else if let Some(obj) = v.as_object() {
        for c in obj.values() {
            if drop_has_slot(c, slot) {
                return true;
            }
        }
    }
    false
}

/// 挑战响应里是否存在任何"像装备"的对象（用于"响应形状未知时兜底视为有掉落"）
fn resp_has_items(v: &Value) -> bool {
    if looks_like_item(v) {
        return true;
    }
    if let Some(arr) = v.as_array() {
        return arr.iter().any(resp_has_items);
    }
    if let Some(obj) = v.as_object() {
        return obj.values().any(resp_has_items);
    }
    false
}

/// 首领循环（个人/地图）入口：
/// - 小号：走"首领爬梯"策略（见 boss_solo_daily_alt）——打当前梯位 boss 拿装备 → 立刻穿上 →
///   全部位毕业 + 下一个 boss 实测可胜就前进，直到打不动或次数耗尽。
/// - 大号（大极品模式，保持原策略）：打可胜最高难度首领，固定下拉选定的部位，集中刷到 rareRank=大极品；
///   毕业线 grad_quality 随所打难度爬升（打过难度 d → 毕业品质 d+2，封顶金=6）。
/// SQLite：boss_farm 每号记录 (current_boss_key, target_slot, grad_quality)；
/// boss_graduate 记录每号每 boss 每部位毕业状态（小号爬梯用）。
pub async fn boss_solo_daily(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    material_boost: bool,
    affix_key: &str,
    main_slot: Option<&str>,
    set_quality: &str,
    set_rareness: &str,
) -> Result<String, String> {
    // 小号走"首领爬梯"策略（v2）：打当前梯位 boss 拿装备 → 立刻穿上 → 全部位毕业 + 下一个 boss
    // 实测可胜就前进，直到打不动或次数耗尽；大号保持原策略不动（手动刷）。
    if acc.role != "main" {
        return boss_solo_daily_alt(db, api, acc).await;
    }
    let quality_rank = |q: &str| -> i64 {
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
    };

    let token = ensure_session(db, api, acc).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let player = &state["player"];
    let power = player["power"].as_i64().unwrap_or(0);
    let attempts = player["bossAttempts"].clone();
    let mut worn: std::collections::HashMap<String, (i64, i64, String)> = std::collections::HashMap::new();
    if let Some(eqs) = state["equipment"].as_array() {
        for e in eqs {
            if e["status"].as_str() == Some("equipped") {
                let slot = e["slot"].as_str().unwrap_or("").to_string();
                worn.insert(
                    slot,
                    (
                        quality_rank(e["quality"].as_str().unwrap_or("white")),
                        e["score"].as_i64().unwrap_or(0),
                        e["rareRank"].as_str().unwrap_or("").to_string(),
                    ),
                );
            }
        }
    }
    let secs = api.view_sections(&token, &["bosses"]).await.map_err(|e| e.to_string())?;
    let bosses = secs.get("bosses").cloned().unwrap_or(json!([]));
    let solo: Vec<&serde_json::Value> = bosses
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|b| {
                    let t = b["type"].as_str().unwrap_or("");
                    t == "personal" || t == "map"
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // 载入循环状态（毕业线默认 2=精良）；prev_boss/prev_slot 用于"一场没打时不覆盖 farm"
    let (prev_boss, prev_slot, mut grad_q) = {
        let guard = db.lock().unwrap();
        guard
            .get_farm_state(acc.id)
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| (String::new(), String::new(), 2))
    };

    // 每个 solo 首领的"可胜最高难度 index"（可胜且付得起里最大者）
    // 注意：挑战 boss 不消耗金币（goldCost 仅展示，不做门槛）；门票照常检查
    let affordable = |o: &serde_json::Value| {
        let tk = o["ticketCost"].as_i64().unwrap_or(0);
        o["ownedTickets"].as_i64().unwrap_or(0) >= tk || tk == 0
    };
    let winnable = |o: &serde_json::Value| {
        o["predictedWin"].as_bool().unwrap_or(false)
            && o["blockedReason"].as_str().unwrap_or("").is_empty()
            && affordable(o)
    };
    let best_of = |b: &serde_json::Value| -> i64 {
        b["difficultyOptions"]
            .as_array()
            .map(|opts| opts.iter().enumerate().filter(|(_, o)| winnable(o)).map(|(i, _)| i as i64).max().unwrap_or(-1))
            .unwrap_or(-1)
    };

    // 目标 boss：
    // - 小号（地图套装模式）：锁定**当前挂机地图**（player.currentMap）的 boss，集当前地图套装；
    //   当前地图首领打不了时才退到"可胜最高难度"兜底（不空转）。
    // - 大号（大极品模式）：能过的最高难度首领（requiredPower 最高且至少一档可胜）。
    let is_main = acc.role == "main";
    let mut target: Option<&serde_json::Value> = None;
    if !is_main {
        let cur_map = state["player"]["currentMap"].as_str().unwrap_or("");
        let cur_bosses: Vec<&serde_json::Value> = solo
            .iter()
            .filter(|b| b["mapKey"].as_str() == Some(cur_map))
            .copied()
            .collect();
        let cand = cur_bosses
            .iter()
            .find(|b| b["type"].as_str() == Some("personal"))
            .or_else(|| cur_bosses.iter().find(|b| b["type"].as_str() == Some("map")))
            .copied();
        if let Some(b) = cand {
            if best_of(b) >= 0 {
                target = Some(b);
            }
        }
    }
    if target.is_none() {
        target = solo
            .iter()
            .filter(|b| best_of(b) >= 0)
            .max_by_key(|b| (b["requiredPower"].as_i64().unwrap_or(0), best_of(b)))
            .map(|v| *v);
    }
    let Some(t) = target else {
        return Ok("当前无可胜的个人/地图首领".into());
    };
    let mut cur_boss = t["key"].as_str().unwrap_or("").to_string();
    let mut cur_map = t["mapKey"].as_str().unwrap_or("").to_string();

    // ---- 定向部位策略 ----
    // 小号（地图套装模式）：全部位轮换——缺的部位优先、其次穿戴品质低到高，快速集齐当前地图套装；
    // 大号（大极品模式）：固定下拉选定的部位，集中刷到 rareRank=大极品。
    let fixed_slot: Option<String> = if is_main {
        main_slot
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty() && SLOTS.contains(&s.as_str()))
    } else {
        None
    };
    // 全部位按"穿戴品质从低到高"排序（缺的部位最低），供轮换
    let mut pool: Vec<(String, i64)> = SLOTS
        .iter()
        .map(|s| (s.to_string(), worn.get(*s).map(|(q, _, _)| *q).unwrap_or(i64::MIN)))
        .collect();
    pool.sort_by_key(|(_, q)| *q);
    // 大号：指定部位已大极品 → 直接收工（并刷新"已大极品部位"记录）
    if let Some(s) = &fixed_slot {
        let dajipin = worn.get(s.as_str()).map(|(_, _, r)| r == "大极品").unwrap_or(false);
        record_dajipin_slots(db, acc, &worn);
        if dajipin {
            return Ok(format!("大号定向【{s}】已大极品，无需再刷"));
        }
    }
    let mut cur_slot = String::new();
    let mut rot = 0usize;

    // 刷目标 boss：免费次数打完、可胜最高难度（列表预判仅供参考，以 preview 实测为准）、带 targetSlot
    let mut done = 0usize;
    let mut free_used = 0usize;
    let mut free = 0i64;
    let mut max_idx = -1i64;
    let mut skip_reason = String::new(); // 0 场时把真实原因带进日志（预览实测/门票/阻挡），便于诊断
    let mut played_any = false; // 本轮是否真的打过（决定 farm 状态是否推进，防"一场没打被覆盖"）
    // 同部位已实测可胜的缓存：(slot → (diff_idx, diff_key, boost))，同部位重复场次直接 challenge 省 preview
    let mut verified: Option<(String, i64, String, bool)> = None;
    if let Some(b) = solo.iter().find(|b| b["key"].as_str() == Some(cur_boss.as_str())) {
        free = b["personalAttemptPool"]["freeRemaining"]
            .as_i64()
            .or_else(|| attempts.get(cur_boss.as_str()).and_then(|v| v.as_i64()))
            .unwrap_or(1)
            .max(0);
        let options = b["difficultyOptions"].as_array().cloned().unwrap_or_default();
        for _ in 0..free {
            // 每场轮换/固定：大号固定指定部位；小号按"最差→好"轮换全部位
            cur_slot = fixed_slot.clone().unwrap_or_else(|| pool[rot % pool.len()].0.clone());
            rot += 1;
            // 同部位本场已实测可胜 → 直接打同一难度（函数内战力不变，preview 结果稳定，省一次 preview）
            if let Some((s, idx, diff, boost)) = &verified {
                if *s == cur_slot {
                    let use_affix = if affix_key != "none" { affix_key } else { "none" };
                    let resp = api
                        .mutate(&token, "/api/boss/challenge", json!({"bossKey": cur_boss, "difficulty": diff, "useMaterialBoost": boost, "affixKey": use_affix, "targetSlot": cur_slot}))
                        .await;
                    let won = match &resp {
                        Ok(v) => challenge_won(v).unwrap_or(true),
                        Err(_) => false,
                    };
                    free_used += 1;
                    played_any = true;
                    if won {
                        if let Ok(v) = &resp {
                            learn_map_set(db, &cur_map, v);
                        }
                        done += 1;
                        max_idx = max_idx.max(*idx);
                        record_boss_kill(db, acc.id, &cur_boss);
                        record_boss_progress(db, acc.id, &cur_boss, diff, *idx, &cur_slot);
                    }
                    continue;
                }
            }
            let winnable_list: Vec<(usize, &serde_json::Value)> =
                options.iter().enumerate().filter(|(_, o)| winnable(o)).collect();
            if winnable_list.is_empty() {
                if skip_reason.is_empty() {
                    skip_reason = "目标 boss 当前无难度档可胜（预测输/门票或金币不足/被阻挡）".into();
                }
                break;
            }
            match play_boss_one(api, &token, &cur_boss, &winnable_list, &cur_slot, material_boost, affix_key).await {
                Ok((true, won, idx, diff, resp, boost)) => {
                    free_used += 1;
                    played_any = true;
                    if won {
                        if let Some(v) = &resp {
                            learn_map_set(db, &cur_map, v);
                        }
                        done += 1;
                        max_idx = max_idx.max(idx);
                        record_boss_kill(db, acc.id, &cur_boss);
                        record_boss_progress(db, acc.id, &cur_boss, &diff, idx, &cur_slot);
                        // 本场同部位已验证可胜，缓存供后续同部位场次复用
                        verified = Some((cur_slot.clone(), idx, diff, boost));
                    } else if skip_reason.is_empty() {
                        skip_reason = format!("难度[{diff}] 预览实测可胜但挑战失败/接口报错，已试更低难度");
                    }
                }
                Ok((false, _, _, _, _, _)) => {
                    if skip_reason.is_empty() {
                        skip_reason = "目标 boss 所有难度 preview 实测都打不赢（列表预判可胜但实测输）".into();
                    }
                    break; // 本 boss 收手
                }
                Err(e) => {
                    if skip_reason.is_empty() {
                        skip_reason = format!("目标 boss 预览接口失败: {e}");
                    }
                    break;
                }
            }
        }
    }
    // 锁定目标实测 0 场 → 降级备选（**倒退刷装备**）：当前地图 boss 装备没毕业，
    // 就退回下级图 boss：**倒序可达** —— 从高图往低图逐档 preview 实测，
    // 打第一个"实测能赢"的最高图 boss（例：挂机7图只能打赢4图 → 每天刷4图 boss，
    // 而不是打最低的1图，也不是去碰打不过的5/6/7图）
    if done == 0 {
        let mut cands: Vec<&serde_json::Value> = solo
            .iter()
            .filter(|b| b["key"].as_str() != Some(cur_boss.as_str()) && best_of(b) >= 0)
            .copied()
            .collect();
        // 高战力（更高图）优先 —— 降序；第一个 preview 实测可胜的就是"能打的最高图"
        cands.sort_by_key(|b| std::cmp::Reverse((b["requiredPower"].as_i64().unwrap_or(0), best_of(b))));
        let mut rot2 = 0usize;
        for fb in cands {
            if done > 0 {
                break;
            }
            let fkey = fb["key"].as_str().unwrap_or("").to_string();
            let fmap = fb["mapKey"].as_str().unwrap_or("").to_string();
            if fkey.is_empty() {
                continue;
            }
            let ffree = fb["personalAttemptPool"]["freeRemaining"].as_i64().unwrap_or(1).max(0);
            if ffree <= 0 {
                continue;
            }
            let fopts = fb["difficultyOptions"].as_array().cloned().unwrap_or_default();
            let mut fplayed = false;
            for _ in 0..ffree {
                let slot = fixed_slot.clone().unwrap_or_else(|| pool[rot2 % pool.len()].0.clone());
                rot2 += 1;
                let wl: Vec<(usize, &serde_json::Value)> =
                    fopts.iter().enumerate().filter(|(_, o)| winnable(o)).collect();
                if wl.is_empty() {
                    break;
                }
                match play_boss_one(api, &token, &fkey, &wl, &slot, material_boost, affix_key).await {
                    Ok((true, won, idx, diff, resp, _boost)) => {
                        free_used += 1;
                        played_any = true;
                        if won {
                            if let Some(v) = &resp {
                                learn_map_set(db, &fmap, v);
                            }
                            record_boss_progress(db, acc.id, &fkey, &diff, idx, &slot);
                            record_boss_kill(db, acc.id, &fkey);
                            max_idx = max_idx.max(idx);
                            done += 1;
                            // 日志/套装用实际击杀的 boss
                            cur_boss = fkey.clone();
                            cur_map = fmap.clone();
                            cur_slot = slot;
                        }
                        fplayed = true;
                    }
                    Ok((false, _, _, _, _, _)) => {
                        // 该难度档实测全输，换下一个候选 boss
                    }
                    Err(e) => {
                        if skip_reason.is_empty() {
                            skip_reason = format!("备选首领[{fkey}] 预览接口失败: {e}");
                        }
                        fplayed = true; // 接口失败也停，避免空转
                    }
                }
                if fplayed || done > 0 {
                    break;
                }
            }
        }
    }
    // 毕业线随最高已刷难度爬升：难度 d → 毕业品质 d+2（封顶金）
    if max_idx >= 0 {
        grad_q = grad_q.max((max_idx + 2).min(6));
    }
    // 套装进度（两套评分都达标才算 1 件：品质≥达标品质 且 稀有度≥达标稀有度）；
    // 没实际打过时不做套装笔记（cur_map 可能只是"想打但打不赢"的兜底目标，误导）
    let set_note = if !played_any || cur_map.is_empty() {
        String::new()
    } else {
        let sk = db
            .lock()
            .unwrap()
            .get_meta(&format!("map_set:{cur_map}"))
            .ok()
            .flatten()
            .unwrap_or_default();
        if sk.is_empty() {
            "；套装：未识别（打一场学会掉落套装后显示）".to_string()
        } else {
            let (n, total) = set_progress(
                &state,
                &sk,
                super::equip::quality_rank(set_quality),
                super::equip::rare_rank(set_rareness),
            );
            let map_name = super::equip::map_name_by_key(&cur_map).unwrap_or(&cur_map);
            format!(
                "；套装【{map_name}】{}+{} {n}/{total}",
                super::equip::quality_label(set_quality),
                super::equip::rare_label(set_rareness)
            )
        }
    };
    // 持久化循环状态：**只在实际打过时推进**（修复"免费次数已光/全输 → 一场没打却把 farm
    // 覆盖成打不赢的兜底 boss + 空部位"的问题，如 62 号被写成 skeleton_warlord/空部位）
    if played_any {
        let guard = db.lock().unwrap();
        let _ = guard.set_farm_state(acc.id, &cur_boss, &cur_slot, grad_q);
    }
    let _ = power;
    // 没打时日志展示**上次 farm 目标**（不误导成"刷了当前兜底目标"），并给出真实原因
    let (log_boss, log_slot) = if played_any {
        (cur_boss.clone(), cur_slot.clone())
    } else {
        (prev_boss.clone(), prev_slot.clone())
    };
    let reason_txt = if done == 0 && !skip_reason.is_empty() {
        format!("；未打：{skip_reason}")
    } else if !played_any {
        "；今日免费次数已用光或无可胜难度，未打（保留上次 farm 目标）".to_string()
    } else {
        String::new()
    };
    Ok(format!(
        "首领循环：{log_boss} 完成 {done} 场（剩余免费 {free}，用 {free_used}），定向 {log_slot}，毕业线 {grad_q}{set_note}{reason_txt}"
    ))
}

/// 首领梯子排序：战力升序 → 等级升序 → 地图顺序 → key（梯位即"下一个级别"的判定依据）
fn ladder_cmp(a: &Value, b: &Value) -> Ordering {
    a["requiredPower"]
        .as_i64()
        .unwrap_or(0)
        .cmp(&b["requiredPower"].as_i64().unwrap_or(0))
        .then_with(|| {
            a["requiredLevel"]
                .as_i64()
                .unwrap_or(0)
                .cmp(&b["requiredLevel"].as_i64().unwrap_or(0))
        })
        .then_with(|| map_tier_of(a).cmp(&map_tier_of(b)))
        .then_with(|| a["key"].as_str().unwrap_or("").cmp(b["key"].as_str().unwrap_or("")))
}

/// 首领所属地图在 MAP_TIERS 里的顺序（未知地图排最后）
fn map_tier_of(b: &Value) -> i64 {
    let mk = b["mapKey"].as_str().unwrap_or("");
    super::equip::MAP_TIERS
        .iter()
        .position(|(k, _, _)| *k == mk)
        .map(|i| i as i64)
        .unwrap_or(99)
}

/// 某 boss 的挑战词缀列表：按 rewardMultiplier 降序，末尾补 "none"（无词缀兜底）
fn affixes_of(b: &Value) -> Vec<String> {
    let mut v: Vec<(f64, String)> = Vec::new();
    if let Some(arr) = b["challengeOptions"]["affixes"].as_array() {
        for a in arr {
            let k = a["key"].as_str().unwrap_or("").to_string();
            if !k.is_empty() && k != "none" {
                v.push((a["rewardMultiplier"].as_f64().unwrap_or(1.0), k));
            }
        }
    }
    v.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(Ordering::Equal));
    let mut keys: Vec<String> = v.into_iter().map(|(_, k)| k).collect();
    keys.push("none".to_string());
    keys
}

/// 某 boss 是否实测可胜：从高难度往低逐档 preview（先测无词缀、再按奖励倍率从低到高），
/// 任一配置实测可胜即 true（前进/修正后正式打时再做完整配置选择）。
/// top_only=true 时只测最高难度（噩梦）档——用于"跳级判定"：
/// 低一级 boss 的噩梦掉落 ≥ 下一级 boss 的普通难度（a3 优于 b1），只为普通难度跳级是浪费。
async fn boss_preview_winnable(
    api: &Api,
    token: &str,
    nb: &Value,
    affixes: &[String],
    progress: &HashMap<String, i64>,
    cache: &mut HashMap<String, bool>,
    boost_ok: &mut bool,
    top_only: bool,
) -> bool {
    let bkey = nb["key"].as_str().unwrap_or("").to_string();
    let opts = nb["difficultyOptions"].as_array().cloned().unwrap_or_default();
    if bkey.is_empty() || opts.is_empty() {
        return false;
    }
    let top_idx = (opts.len() - 1) as i64;
    let affordable = |o: &Value| {
        let tk = o["ticketCost"].as_i64().unwrap_or(0);
        o["ownedTickets"].as_i64().unwrap_or(0) >= tk || tk == 0
    };
    let list_win = |o: &Value| {
        o["predictedWin"].as_bool().unwrap_or(false)
            && o["blockedReason"].as_str().unwrap_or("").is_empty()
            && affordable(o)
    };
    let max_list = opts
        .iter()
        .enumerate()
        .filter(|(_, o)| list_win(o))
        .map(|(i, _)| i as i64)
        .max()
        .unwrap_or(-1);
    let rec = progress.get(&bkey).copied().unwrap_or(-1);
    let anchor = (rec + 1).max(max_list).clamp(0, top_idx);
    // top_only：只测最高难度档（无视记录锚点——玩家战力够的最高难度才算可跳）
    let range: Vec<i64> = if top_only {
        vec![top_idx]
    } else {
        (0..=anchor).rev().collect()
    };
    for idx in range {
        let Some(opt) = opts.get(idx as usize) else { continue };
        let diff = opt["key"].as_str().unwrap_or("").to_string();
        if diff.is_empty() {
            continue;
        }
        // 前进判定保守：先测无词缀（列表末尾为 none，反转后 none 在前），再按奖励倍率升序
        for affix in affixes.iter().rev() {
            let ckey = format!("{bkey}|{idx}|{affix}|{}", if *boost_ok { 1 } else { 0 });
            let win = match cache.get(&ckey) {
                Some(v) => *v,
                None => {
                    let p = api
                        .mutate(
                            token,
                            "/api/boss/preview",
                            json!({
                                "bossKey": bkey, "difficulty": diff,
                                "useMaterialBoost": *boost_ok, "affixKey": affix,
                                "targetSlot": "weapon"
                            }),
                        )
                        .await;
                    let w = match p {
                        Ok(pv) => preview_win(&pv),
                        Err(e) if *boost_ok && e.to_string().contains("材料加成") => {
                            *boost_ok = false;
                            match api
                                .mutate(
                                    token,
                                    "/api/boss/preview",
                                    json!({
                                        "bossKey": bkey, "difficulty": diff,
                                        "useMaterialBoost": false, "affixKey": affix,
                                        "targetSlot": "weapon"
                                    }),
                                )
                                .await
                            {
                                Ok(pv) => preview_win(&pv),
                                Err(_) => false,
                            }
                        }
                        Err(_) => false,
                    };
                    cache.insert(ckey.clone(), w);
                    w
                }
            };
            if win {
                return true;
            }
        }
    }
    false
}

/// 小号首领爬梯（v2，替代原"锁定当前挂机地图"策略）：
/// - 梯子：个人/地图首领按战力升序排；每号记住当前梯位（boss_farm.current_boss_key）。
/// - 每日链式推进：打当前 boss 的免费次数（难度锚 = 已记录最高可胜 +1 向上爬；
///   词缀按 rewardMultiplier 从高到低试，打实测能赢的最高奖励配置）→ 每赢一场立刻换装
///   （战力实时提升）→ 当前 boss 最高难度全部位毕业且下一个 boss preview 实测可胜 →
///   梯位 +1 继续打，直到打不动或次数耗尽。
/// - 部位：只轮换未毕业部位（缺的部位优先、穿戴品质低→高）；
///   毕业 = 该 boss 最高难度打赢且掉落含该部位装备（写入 SQLite boss_graduate）。
/// - 0 场返回 Err 走退避重试（当天不锁死）；免费次数已用完/全部位已毕业则 Ok 收工。
async fn boss_solo_daily_alt(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    let quality_rank = |q: &str| -> i64 {
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
    };

    let token = ensure_session(db, api, acc).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let player_power = state["player"]["power"].as_i64().unwrap_or(0);
    let attempts = state["player"]["bossAttempts"].clone();
    // 材料持有快照（itemKey→数量，含叠加）。boss 难度档的 materialKey/materialCost 是
    // useMaterialBoost（材料加成）的消耗：骨粉/解毒叶/黑铁矿… 不够时先由公会仓库 redeem 补。
    let mut mats: HashMap<String, i64> = HashMap::new();
    if let Some(items) = state["items"].as_array() {
        for it in items {
            let k = it["itemKey"].as_str().unwrap_or("").to_string();
            if k.is_empty() {
                continue;
            }
            let v = it["amount"].as_i64().unwrap_or(0);
            *mats.entry(k).or_insert(0) += v;
        }
    }
    // 穿戴部位快照（品质档，轮换排序用：缺的部位排最前）
    let mut worn: HashMap<String, i64> = HashMap::new();
    if let Some(eqs) = state["equipment"].as_array() {
        for e in eqs {
            if e["status"].as_str() == Some("equipped") {
                let slot = e["slot"].as_str().unwrap_or("").to_string();
                worn.insert(slot, quality_rank(e["quality"].as_str().unwrap_or("white")));
            }
        }
    }

    let secs = api.view_sections(&token, &["bosses"]).await.map_err(|e| e.to_string())?;
    let bosses = secs.get("bosses").cloned().unwrap_or(json!([]));
    let mut solo: Vec<Value> = bosses
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|b| {
                    let t = b["type"].as_str().unwrap_or("");
                    t == "personal" || t == "map"
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if solo.is_empty() {
        return Err("服务端未下发个人/地图首领".into());
    }
    solo.sort_by(ladder_cmp);

    // 列表预判（仅供初筛/梯位入口，实战以 preview 实测为准）
    let affordable = |o: &Value| {
        let tk = o["ticketCost"].as_i64().unwrap_or(0);
        o["ownedTickets"].as_i64().unwrap_or(0) >= tk || tk == 0
    };
    let list_win = |o: &Value| {
        o["predictedWin"].as_bool().unwrap_or(false)
            && o["blockedReason"].as_str().unwrap_or("").is_empty()
            && affordable(o)
    };
    let best_of = |b: &Value| -> i64 {
        b["difficultyOptions"]
            .as_array()
            .map(|opts| {
                opts.iter()
                    .enumerate()
                    .filter(|(_, o)| list_win(o))
                    .map(|(i, _)| i as i64)
                    .max()
                    .unwrap_or(-1)
            })
            .unwrap_or(-1)
    };
    // 每 boss 可打次数（快照，取自 personalAttemptPool / player.bossAttempts）。
    // 实测（2026-08-30）：每天 = freeLimit 免费 + ticketLimit 门票追加，门票自动扣；
    // 免费+门票都打满后再打报"今日个人首领门票追加次数已用尽"。
    // 门票够才计入追加次数（背包 boss_ticket 数量由 mats 快照统计）。
    let tickets_owned = mats.get("boss_ticket").copied().unwrap_or(0);
    let pool_of = |b: &Value| -> i64 {
        let key = b["key"].as_str().unwrap_or("");
        let pool = b["personalAttemptPool"].clone();
        let free = pool["freeRemaining"]
            .as_i64()
            .or_else(|| attempts.get(key).and_then(|v| v.as_i64()))
            .unwrap_or(1)
            .max(0);
        let ticket_limit = pool["ticketLimit"].as_i64().unwrap_or(0);
        let ticket_used = pool["ticketUsed"].as_i64().unwrap_or(0);
        let extra = (ticket_limit - ticket_used).max(0);
        let extra = if tickets_owned >= extra { extra } else { tickets_owned.max(0) };
        free + extra
    };

    // 历史进度：boss_key -> 最高可胜难度 idx（仅胜利写入，做爬档锚点）
    let progress: HashMap<String, i64> = {
        let guard = db.lock().map_err(|e| e.to_string())?;
        guard
            .get_boss_progress(acc.id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(bk, _, i, _, _)| (bk, i))
            .collect()
    };
    let (prev_boss, prev_slot, mut grad_q) = {
        let guard = db.lock().map_err(|e| e.to_string())?;
        guard
            .get_farm_state(acc.id)
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| (String::new(), String::new(), 2))
    };

    // 梯位：有记录用记录；新号/脏数据 → 列表预判可胜的最高级 boss，全不可胜则从最低级开始
    let start_pos: usize = solo
        .iter()
        .position(|b| b["key"].as_str() == Some(prev_boss.as_str()))
        .or_else(|| solo.iter().rposition(|b| best_of(b) >= 0).or(Some(0)))
        .unwrap_or(0);
    let mut pos = start_pos;

    let mut total_done = 0usize;
    let mut total_used = 0usize;
    let mut max_win_idx = -1i64;
    let mut last_slot = prev_slot;
    let mut rot = 0usize;
    let mut preview_cache: HashMap<String, bool> = HashMap::new();
    let mut boost_ok = true; // 材料加成：普通难度不支持时本次运行降级为 false
    let mut redeem_tried: HashSet<String> = HashSet::new(); // 本次运行已尝试兑换失败的材料 key，不再重试
    let mut ladder_log: Vec<String> = Vec::new();
    // 末轮状态（供收尾判定 0 场原因）
    let mut last_bkey = String::new();
    let mut last_pool = 0i64;
    let mut last_all_grad = false;
    let mut stop: Option<String> = None;
    // 本次运行是否已向下修正过梯位（修正后不再跳级，防"跳上→打不动→拉回→再跳"拉锯）
    let mut moved_down = false;

    // 链式推进（上限 = 梯子长度，防异常死循环）
    for _step in 0..solo.len().max(1) {
        // 战力跳级：当前 boss 的下一档 requiredPower 已由本号战力覆盖 → 直接上更高级 boss。
        // （爬梯的"全部位毕业才前进"是给同级刷装备用的；战力已达标还钉在低级 boss
        //   毫无意义——55 级战力 1.2 万的号不该死磕野猪王。双保险：
        //   下一档 requiredPower <= 玩家战力 且 preview **最高难度**实测可胜。）
        // 注意：跳级只看最高难度（top_only）——低一级 boss 的噩梦掉落 ≥ 下一级 boss 的普通难度，
        //   只为普通难度跳上去反而变差（a3 > b1）；打不赢噩梦就留在低阶刷噩梦。
        // 向下修正过的不再跳（防拉锯）；跳级后实际打不动会由下方"前进/修正判定"处理。
        while !stop.is_some() && !moved_down && pos + 1 < solo.len() {
            let next_req = solo[pos + 1]["requiredPower"].as_i64().unwrap_or(0);
            if next_req == 0 {
                break;
            }
            if (player_power as i64) < next_req {
                break; // 下一档门槛还没够 → 停在当前档
            }
            let nb = &solo[pos + 1];
            let naffixes = affixes_of(nb);
            if !boss_preview_winnable(
                api,
                &token,
                nb,
                &naffixes,
                &progress,
                &mut preview_cache,
                &mut boost_ok,
                true,
            )
            .await
            {
                break; // 最高难度实测打不赢 → 不跳（留在当前档刷噩梦，掉落更优）
            }
            pos += 1;
        }
        let b = &solo[pos];
        let bkey = b["key"].as_str().unwrap_or("").to_string();
        let bmap = b["mapKey"].as_str().unwrap_or("").to_string();
        let bname = b["name"].as_str().unwrap_or("").to_string();
        let opts = b["difficultyOptions"].as_array().cloned().unwrap_or_default();
        let top_idx = opts.len().saturating_sub(1) as i64;
        // 记录本号当前 boss 需要的材料（捐献侧据此保留，避免"捐进仓库又赎回"白花贡献）
        {
            let mk = opts
                .get(top_idx as usize)
                .and_then(|o| {
                    if o["materialCost"].as_i64().unwrap_or(0) > 0 {
                        o["materialKey"].as_str()
                    } else {
                        None
                    }
                })
                .unwrap_or("");
            if let Ok(g) = db.lock() {
                let _ = g.set_meta(&format!("boss_material:{}", acc.id), mk);
            }
        }
        let pool = pool_of(b);
        let affixes = affixes_of(b);
        // 列表预判可胜最高档（爬档下限；即使列表全输也至少实测最低档一次）
        let max_list = opts
            .iter()
            .enumerate()
            .filter(|(_, o)| list_win(o))
            .map(|(i, _)| i as i64)
            .max()
            .unwrap_or(-1);
        let mut best_rec = progress.get(&bkey).copied().unwrap_or(-1);

        // 未毕业部位轮换池（缺的部位优先、穿戴品质低→高）
        let grads: Vec<String> = {
            let guard = db.lock().map_err(|e| e.to_string())?;
            guard.get_boss_graduate(acc.id, &bkey).map_err(|e| e.to_string())?
        };
        let mut grad_set: HashSet<String> = grads
            .into_iter()
            .filter(|s| SLOTS.contains(&s.as_str()))
            .collect();
        let mut rot_pool: Vec<String> = SLOTS
            .iter()
            .filter(|s| !grad_set.contains(**s))
            .map(|s| s.to_string())
            .collect();
        rot_pool.sort_by_key(|s| worn.get(s.as_str()).copied().unwrap_or(i64::MIN));

        let mut done_boss = 0usize;
        let mut used_boss = 0usize;

        if opts.is_empty() {
            stop = Some(format!("[{bkey}] 无难度配置"));
        } else if pool > 0 {
            'attempts: for _attempt in 0..pool {
                // 部位：未毕业部位轮换；全部位已毕业仍继续打（收益最大化：本 boss 噩梦
                // 掉落 > 下一只 boss 普通难度，毕业不该停手也不该为了"毕业新 boss"跳去打低难度）
                let slot = if rot_pool.is_empty() {
                    if last_slot.is_empty() {
                        "weapon".to_string()
                    } else {
                        last_slot.clone()
                    }
                } else {
                    let s = rot_pool[rot % rot_pool.len()].clone();
                    rot += 1;
                    s
                };
                last_slot = slot.clone();
                // 难度锚：已记录最高+1 向上爬；不低于列表预判可胜最高档
                let anchor = (best_rec + 1).max(max_list).clamp(0, top_idx);
                let mut fought = false;
                for idx in (0..=anchor).rev() {
                    let Some(opt) = opts.get(idx as usize) else { continue };
                    let diff = opt["key"].as_str().unwrap_or("").to_string();
                    if diff.is_empty() {
                        continue;
                    }
                    // 材料加成开关：该难度要消耗 boss 专属材料（materialKey/materialCost）。
                    // 背包够 → 带加成（掉落更好）；不够 → 先尝试用公会贡献度从仓库 redeem 补一口；
                    // 补到 → 带加成；补不到/仓库没货 → **同一最高难度不带加成照打**（照样毕业，仅掉落品质略差）
                    let mat_key = opt["materialKey"]
                        .as_str()
                        .map(|s| s.to_string())
                        .filter(|s| !s.is_empty());
                    let mat_cost = opt["materialCost"].as_i64().unwrap_or(0);
                    let mut use_boost = boost_ok;
                    if use_boost && mat_cost > 0 {
                        if let Some(mk) = &mat_key {
                            if mats.get(mk).copied().unwrap_or(0) < mat_cost
                                && !redeem_tried.contains(mk)
                            {
                                let need = mat_cost - mats.get(mk).copied().unwrap_or(0);
                                match super::guild::guild_redeem(db, api, acc, mk, need).await {
                                    Ok(_) => {
                                        *mats.entry(mk.clone()).or_insert(0) += need;
                                    }
                                    Err(_) => {
                                        redeem_tried.insert(mk.clone()); // 本次运行不再重试该材料
                                    }
                                }
                            }
                            if mats.get(mk).copied().unwrap_or(0) < mat_cost {
                                use_boost = false; // 补不到 → 不带加成照打
                            }
                        }
                    }
                    for affix in &affixes {
                        let ckey = format!("{bkey}|{idx}|{affix}|{}", if use_boost { 1 } else { 0 });
                        let win = match preview_cache.get(&ckey) {
                            Some(v) => *v,
                            None => {
                                let p = api
                                    .mutate(
                                        &token,
                                        "/api/boss/preview",
                                        json!({
                                            "bossKey": bkey, "difficulty": diff,
                                            "useMaterialBoost": use_boost, "affixKey": affix,
                                            "targetSlot": slot
                                        }),
                                    )
                                    .await;
                                let w = match p {
                                    Ok(pv) => preview_win(&pv),
                                    Err(e) if use_boost && e.to_string().contains("材料加成") => {
                                        // 该 boss 不支持材料加成 → 本次运行降级重试
                                        boost_ok = false;
                                        use_boost = false;
                                        match api
                                            .mutate(
                                                &token,
                                                "/api/boss/preview",
                                                json!({
                                                    "bossKey": bkey, "difficulty": diff,
                                                    "useMaterialBoost": false, "affixKey": affix,
                                                    "targetSlot": slot
                                                }),
                                            )
                                            .await
                                        {
                                            Ok(pv) => preview_win(&pv),
                                            Err(_) => false,
                                        }
                                    }
                                    Err(_) => false,
                                };
                                preview_cache.insert(ckey.clone(), w);
                                w
                            }
                        };
                        if !win {
                            continue;
                        }
                        // 打实测能赢的最高奖励配置
                        let resp = api
                            .mutate(
                                &token,
                                "/api/boss/challenge",
                                json!({
                                    "bossKey": bkey, "difficulty": diff,
                                    "useMaterialBoost": use_boost, "affixKey": affix,
                                    "targetSlot": slot
                                }),
                            )
                            .await;
                        match resp {
                            Ok(v) => {
                                // 材料已投入（服务端扣了）→ 本地扣除，保持后续场次的判断准确
                                if use_boost && mat_cost > 0 {
                                    if let Some(mk) = &mat_key {
                                        if let Some(cur) = mats.get_mut(mk) {
                                            *cur = cur.saturating_sub(mat_cost);
                                        }
                                    }
                                }
                                let won = challenge_won(&v).unwrap_or(true);
                                if !won {
                                    // 该配置实测输 → 同难度更低词缀 / 更低难度（失败返还机会，不空耗）
                                    used_boss += 1;
                                    fought = true;
                                    continue;
                                }
                                // 胜利
                                done_boss += 1;
                                used_boss += 1;
                                best_rec = best_rec.max(idx);
                                max_win_idx = max_win_idx.max(idx);
                                if let Ok(g) = db.lock() {
                                    let _ = g.set_boss_progress(acc.id, &bkey, &diff, idx, "win", &slot);
                                }
                                record_boss_kill(db, acc.id, &bkey);
                                learn_map_set(db, &bmap, &v);
                                // 毕业：最高难度打赢且掉落含该部位（响应无任何装备字段时兜底视为掉落）
                                if idx == top_idx && (drop_has_slot(&v, &slot) || !resp_has_items(&v)) {
                                    if let Ok(g) = db.lock() {
                                        let _ = g.set_boss_graduate(acc.id, &bkey, &slot);
                                    }
                                    grad_set.insert(slot.clone());
                                    rot_pool.retain(|s| *s != slot);
                                }
                                // 立刻换装：战力实时提升（解决"打完没穿新装备"），换装后 preview 缓存失效
                                let _ = super::equip::auto_equip_best(db, api, acc).await;
                                preview_cache.clear();
                                continue 'attempts; // 打赢一场后继续下一场（免费次数打满），不是只打 1 场就撒手
                            }
                            Err(e) => {
                                let emsg = e.to_string();
                                // 材料在服务端不足（本地快照滞后/贡献没补上）：同一难度去掉材料加成补打一次，
                                // 不硬停、不降难度（材料只是加成，不是能不能打的开关）
                                if use_boost && (emsg.contains("不足") || emsg.contains("材料")) {
                                    if let Some(mk) = mat_key.clone() {
                                        redeem_tried.insert(mk);
                                    }
                                    match api
                                        .mutate(
                                            &token,
                                            "/api/boss/challenge",
                                            json!({
                                                "bossKey": bkey, "difficulty": diff,
                                                "useMaterialBoost": false, "affixKey": affix,
                                                "targetSlot": slot
                                            }),
                                        )
                                        .await
                                    {
                                        Ok(v) => {
                                            let won = challenge_won(&v).unwrap_or(true);
                                            used_boss += 1;
                                            fought = true;
                                            if won {
                                                done_boss += 1;
                                                best_rec = best_rec.max(idx);
                                                max_win_idx = max_win_idx.max(idx);
                                                if let Ok(g) = db.lock() {
                                                    let _ = g.set_boss_progress(acc.id, &bkey, &diff, idx, "win", &slot);
                                                }
                                                record_boss_kill(db, acc.id, &bkey);
                                                learn_map_set(db, &bmap, &v);
                                                if idx == top_idx
                                                    && (drop_has_slot(&v, &slot) || !resp_has_items(&v))
                                                {
                                                    if let Ok(g) = db.lock() {
                                                        let _ = g.set_boss_graduate(acc.id, &bkey, &slot);
                                                    }
                                                    grad_set.insert(slot.clone());
                                                    rot_pool.retain(|s| *s != slot);
                                                }
                                                let _ = super::equip::auto_equip_best(db, api, acc).await;
                                                preview_cache.clear();
                                                continue 'attempts;
                                            }
                                            continue; // 不带加成也输 → 更低词缀/难度
                                        }
                                        Err(_) => {
                                            stop = Some(format!("[{bkey}] 挑战接口失败: {e}"));
                                            break 'attempts;
                                        }
                                    }
                                }
                                stop = Some(format!("[{bkey}] 挑战接口失败: {e}"));
                                break 'attempts; // 接口错误不继续降配置（大概率全局问题，交给退避重试）
                            }
                        }
                    }
                }
                if !fought {
                    break;
                }
            }
        }

        let grad_n = grad_set.len();
        let disp = if bname.is_empty() { bkey.clone() } else { bname.clone() };
        ladder_log.push(format!("{disp} 打 {done_boss} 场（毕业 {grad_n}/10）"));
        total_done += done_boss;
        total_used += used_boss;
        last_bkey = bkey.clone();
        last_pool = pool;
        last_all_grad = SLOTS.iter().all(|s| grad_set.contains(*s));

        // 前进/修正判定：
        // 1) 打不赢当前梯位（0 场且还有未毕业部位）→ 向下找"实测能赢的最高 boss"修正梯位
        //    （不空转重试，也不一路掉到最低；多发生在旧数据/列表预判与实测不一致时）；
        // 2) 当前 boss 全部位毕业 且 下一个 boss 实测可胜 → 梯位 +1。
        let mut moved = false;
        if stop.is_none() {
            if done_boss == 0 && pool > 0 && !rot_pool.is_empty() && pos > 0 {
                // 只有"有免费次数但实测打不赢"才向下修正；次数用光是正常收工（明日继续），不降梯位。
                for p in (0..pos).rev() {
                    if boss_preview_winnable(
                        api,
                        &token,
                        &solo[p],
                        &affixes_of(&solo[p]),
                        &progress,
                        &mut preview_cache,
                        &mut boost_ok,
                        false,
                    )
                    .await
                    {
                        pos = p;
                        moved = true;
                        moved_down = true;
                        break;
                    }
                }
            } else if last_all_grad && pos + 1 < solo.len() {
                // 毕业前进：下一只 boss 的**最高难度**实测可胜才前进（top_only）。
                // 低一级 boss 噩梦掉落 ≥ 下一级 boss 普通难度——为"毕业新 boss"跳去打
                // 普通难度反而收益更低；已毕业的当前 boss 会继续打（rot_pool 空也不停）。
                if boss_preview_winnable(
                    api,
                    &token,
                    &solo[pos + 1],
                    &affixes_of(&solo[pos + 1]),
                    &progress,
                    &mut preview_cache,
                    &mut boost_ok,
                    true,
                )
                .await
                {
                    pos += 1;
                    moved = true;
                }
            }
        }
        if !moved {
            break;
        }
    }

    // 毕业线随最高已刷难度爬升（展示用）：难度 d → 毕业品质 d+2（封顶金）
    if max_win_idx >= 0 {
        grad_q = grad_q.max((max_win_idx + 2).min(6));
    }
    // 持久化梯位：实际打过或梯位前进过才写（防"0 场把 farm 覆盖成打不赢的目标"）
    if total_done > 0 || pos != start_pos {
        let guard = db.lock().map_err(|e| e.to_string())?;
        let cur_key = solo[pos]["key"].as_str().unwrap_or("").to_string();
        let _ = guard.set_farm_state(acc.id, &cur_key, &last_slot, grad_q);
    }

    let cur_name = {
        let b = &solo[pos];
        let k = b["key"].as_str().unwrap_or("");
        b["name"].as_str().unwrap_or(k).to_string()
    };
    if let Some(e) = stop {
        return Err(format!("首领爬梯：{e}，稍后重试"));
    }
    if total_done == 0 {
        if last_pool == 0 {
            return Ok(format!("首领爬梯：{cur_name} 今日免费次数已用完，明日继续"));
        }
        if last_all_grad {
            return Ok(format!(
                "首领爬梯：{cur_name} 全部位已毕业（{last_bkey}），等待下一个首领可胜"
            ));
        }
        return Err(format!(
            "首领爬梯：{cur_name} 今日 0 场（免费 {last_pool} 次内实测无可胜配置），装备提升后自动重试"
        ));
    }
    Ok(format!(
        "首领爬梯：{}；共 {total_done} 场（用 {total_used} 次），当前目标 {cur_name}，毕业线 {grad_q}",
        ladder_log.join(" → ")
    ))
}

/// 从挑战响应里递归找一个装备的 setKey（学会"某地图掉落哪套装备"）
fn learn_map_set(db: &Mutex<Db>, map_key: &str, resp: &serde_json::Value) {
    if map_key.is_empty() {
        return;
    }
    let key = format!("map_set:{map_key}");
    let known = db
        .lock()
        .ok()
        .and_then(|g| g.get_meta(&key).ok().flatten())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if known {
        return;
    }
    if let Some(sk) = find_set_key(resp) {
        if let Ok(guard) = db.lock() {
            let _ = guard.set_meta(&key, &sk);
        }
    }
}

fn find_set_key(v: &serde_json::Value) -> Option<String> {
    if let Some(sk) = v.get("setKey").and_then(|x| x.as_str()) {
        if !sk.is_empty() && (v.get("slot").is_some() || v.get("status").is_some()) {
            return Some(sk.to_string());
        }
    }
    if let Some(arr) = v.as_array() {
        for c in arr {
            if let Some(s) = find_set_key(c) {
                return Some(s);
            }
        }
    } else if let Some(obj) = v.as_object() {
        for c in obj.values() {
            if let Some(s) = find_set_key(c) {
                return Some(s);
            }
        }
    }
    None
}

/// 套装进度：state.equipment 里该套装（setKey）每部位最强一件，品质与稀有度双双达标才算 1 件
fn set_progress(state: &serde_json::Value, set_key: &str, min_q: i64, min_r: i64) -> (usize, usize) {
    use std::collections::HashMap;
    const ALL_SLOTS: [&str; 10] = ["weapon", "armor", "helmet", "necklace", "ring", "belt", "bracelet", "boots", "talisman", "medal"];
    let mut best: HashMap<&str, (i64, i64)> = HashMap::new();
    if let Some(arr) = state.get("equipment").and_then(|v| v.as_array()) {
        for e in arr {
            if e["setKey"].as_str() != Some(set_key) {
                continue;
            }
            let slot = e["slot"].as_str().unwrap_or("");
            if slot.is_empty() {
                continue;
            }
            let cand = (
                super::equip::quality_rank(e["quality"].as_str().unwrap_or("")),
                super::equip::rare_rank(e["rareRank"].as_str().unwrap_or("")),
            );
            let cur = best.get(slot).copied().unwrap_or((-1, -1));
            if cand > cur {
                best.insert(slot, cand);
            }
        }
    }
    let n = ALL_SLOTS
        .iter()
        .filter(|s| best.get(**s).map(|(q, r)| *q >= min_q && *r >= min_r).unwrap_or(false))
        .count();
    (n, ALL_SLOTS.len())
}

/// 记录大号已大极品的部位（meta: main_dajipin_slots:{acc}，逗号分隔，供页面/日志展示）
fn record_dajipin_slots(
    db: &Mutex<Db>,
    acc: &Account,
    worn: &std::collections::HashMap<String, (i64, i64, String)>,
) {
    let mut done: Vec<&str> = SLOTS
        .iter()
        .filter(|s| worn.get(**s).map(|(_, _, r)| r == "大极品").unwrap_or(false))
        .copied()
        .collect();
    done.sort_unstable();
    let s = done.join(",");
    if let Ok(guard) = db.lock() {
        let _ = guard.set_meta(&format!("main_dajipin_slots:{}", acc.id), &s);
    }
}

/// 世界首领固定列表（实测：7 个，场次定时开放；assist 只需 bossKey，无需轮询侦测场次）
pub const WORLD_BOSS_KEYS: [&str; 7] = [
    "golden_goblet_guard", // 金杯守卫 Lv24
    "scarlet_duke",        // 猩红公爵 Lv50
    "relic_dragon",        // 遗迹魔龙 Lv68
    "ancient_king",        // 远古王座 Lv68
    "void_star_eater",     // 虚空吞星兽 Lv88
    "frostfire_cataclysm", // 霜烬天灾 Lv112
    "paradox_cataclysm",   // 悖时天灾 Lv140
];

/// 世界首领等级门槛（与 WORLD_BOSS_KEYS 一一对应）
/// 参与前先本地预检等级，避免对"等级不足"的 boss 发请求（服务端返回 400）
pub const WORLD_BOSS_LEVELS: [(&str, i64); 7] = [
    ("golden_goblet_guard", 24),
    ("scarlet_duke", 50),
    ("relic_dragon", 68),
    ("ancient_king", 68),
    ("void_star_eater", 88),
    ("frostfire_cataclysm", 112),
    ("paradox_cataclysm", 140),
];

pub fn world_boss_required_level(key: &str) -> i64 {
    WORLD_BOSS_LEVELS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, lv)| *lv)
        .unwrap_or(0)
}

/// 世界boss 实例状态记录键（按场次隔离：新场次新实例不会继承旧状态）
pub fn world_boss_status_key(session: &str, boss_key: &str) -> String {
    format!("world_boss_status:{session}#{boss_key}")
}

/// 记录一批世界boss 实例状态（从 bosses section 提取），供"已阵亡/已结束就跳过"判断
pub fn record_world_boss_statuses(db: &Mutex<Db>, session: &str, secs: &serde_json::Value) {
    let Some(bosses) = secs.get("bosses").and_then(|v| v.as_array()) else { return };
    if let Ok(guard) = db.lock() {
        for b in bosses {
            if b["type"].as_str() != Some("world") {
                continue;
            }
            let key = b["key"].as_str().unwrap_or("");
            let status = b["worldInstance"]["status"].as_str().unwrap_or("");
            if key.is_empty() || status.is_empty() {
                continue;
            }
            let hp = b["worldInstance"]["hpPercent"].as_f64().unwrap_or(0.0);
            let _ = guard.set_meta(&world_boss_status_key(session, key), &format!("{status}|{hp:.1}"));
        }
    }
}

/// 该 boss 本场是否还值得参与：
/// - 无记录 / active → 参与；
/// - ended（客户端标记：服务端报"没有可参与/已结束/已击败"）或服务端下发的其他状态
///   （defeated 等）→ 本场次不再参与。服务端定时开放、无提前/复活/二阶段，
///   当个场次的状态就是终态——永久跳过，新场次（session key 变化）自动重置。
pub fn world_boss_participable(db: &Mutex<Db>, session: &str, boss_key: &str) -> bool {
    let v = db
        .lock()
        .ok()
        .and_then(|g| g.get_meta(&world_boss_status_key(session, boss_key)).ok().flatten());
    match v {
        None => true,
        Some(s) => s.split('|').next().unwrap_or("") == "active",
    }
}

/// 服务端报"本场无法参与/已结束/已击败"时把该 boss 记为 ended（本场后续跳过）
pub fn mark_world_boss_ended(db: &Mutex<Db>, session: &str, boss_key: &str) {
    if let Ok(guard) = db.lock() {
        let _ = guard.set_meta(&world_boss_status_key(session, boss_key), "ended");
    }
}

/// 从 assist 响应里提取 worldInstance 状态并记录（事件驱动，避免 60s 轮询拉取）
fn record_status_from_assist(db: &Mutex<Db>, instance_id: &str, boss_key: &str, resp: &serde_json::Value) {
    let Some((session, _)) = instance_id.rsplit_once('#') else { return };
    let Some(wi) = find_world_instance(resp) else { return };
    let status = wi["status"].as_str().unwrap_or("");
    if status.is_empty() {
        return;
    }
    let hp = wi["hpPercent"].as_f64().unwrap_or(0.0);
    if let Ok(guard) = db.lock() {
        let _ = guard.set_meta(&world_boss_status_key(session, boss_key), &format!("{status}|{hp:.1}"));
    }
}

fn find_world_instance(v: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(wi) = v.get("worldInstance") {
        if wi.is_object() {
            return Some(wi.clone());
        }
    }
    if let Some(obj) = v.as_object() {
        for val in obj.values() {
            if let Some(wi) = find_world_instance(val) {
                return Some(wi);
            }
        }
    } else if let Some(arr) = v.as_array() {
        for val in arr {
            if let Some(wi) = find_world_instance(val) {
                return Some(wi);
            }
        }
    }
    None
}

/// 世界首领中文名（页面展示用）
pub fn world_boss_name(key: &str) -> &'static str {
    match key {
        "golden_goblet_guard" => "金杯守卫",
        "scarlet_duke" => "猩红公爵",
        "relic_dragon" => "遗迹魔龙",
        "ancient_king" => "远古王座",
        "void_star_eater" => "虚空吞星兽",
        "frostfire_cataclysm" => "霜烬天灾",
        "paradox_cataclysm" => "悖时天灾",
        _ => "世界首领",
    }
}

/// 世界boss 页统计：服务端每 boss 状态（等级门槛/进行中/可参与/已参与，以主号为样本）
/// + 本地全员聚合（当前会话各 boss 已参与/完成/未参与的小号数）。
/// 服务端为权威计数（assist 结果 myAttempt/remaining），本地 world_done 记录参与数。
pub async fn world_boss_stats(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    want_session: Option<&str>, // None=当前场次；Some("10"/"16"/"20")=查看今日该窗口的参与结果
) -> Result<serde_json::Value, String> {
    let token = ensure_session(db, api, main).await?;
    let secs = api
        .view_sections(&token, &["bosses"])
        .await
        .map_err(|e| e.to_string())?;
    let bosses = secs
        .get("bosses")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let now = super::auth::now_ms();
    let current_session = world_session_key(now);
    // 查看筛选：指定窗口则按"今日#该窗口"统计该场次的参与结果；否则当前场次
    let session = match want_session {
        Some(w) if w == "10" || w == "16" || w == "20" => format!("{}#{w}", super::auth::beijing_day(now)),
        _ => current_session,
    };
    // 顺带记录本场世界boss 实例状态（页面刷新也能更新"已阵亡跳过"的状态）
    record_world_boss_statuses(db, &session, &secs);
    // 服务端口径：每 boss 的门槛与场次状态（全员通用；不取主号个人进度，那个没意义）
    let mut server_by_key: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    for b in &bosses {
        if b["type"].as_str() != Some("world") {
            continue;
        }
        let key = b["key"].as_str().unwrap_or("").to_string();
        if key.is_empty() {
            continue;
        }
        let wi = b.get("worldInstance").cloned().unwrap_or(json!({}));
        server_by_key.insert(
            key.clone(),
            json!({
                "key": key,
                "name": world_boss_name(&key),
                "requiredLevel": b["requiredLevel"].as_i64().unwrap_or(0),
                "requiredPower": b["requiredPower"].as_i64().unwrap_or(0),
                "status": wi["status"].as_str().unwrap_or(""),
                "maxAttempt": wi["maxAttemptCount"].as_i64().unwrap_or(3),
            }),
        );
    }
    // 本地全员聚合：按（账号等级, 本场参与次数）统计每个 boss 的可参与/已参与/次数。
    // 包含全部启用账号（含大号）：每个轮次所有号都参与（世界boss随挂机流水线全员自动打）。
    let accounts = db.lock().unwrap().list_accounts().unwrap_or_default();
    let accs: Vec<&Account> = accounts.iter().filter(|a| a.enabled).collect();
    let all_total = accs.len() as i64;
    // 每 boss 累计量
    let mut eligible: std::collections::HashMap<String, i64> = std::collections::HashMap::new(); // 等级达标
    let mut participated: std::collections::HashMap<String, i64> = std::collections::HashMap::new(); // 至少参与1次
    let mut completed: std::collections::HashMap<String, i64> = std::collections::HashMap::new(); // 打满
    let mut done_total: std::collections::HashMap<String, i64> = std::collections::HashMap::new(); // 已参与总次数
    let mut left_total: std::collections::HashMap<String, i64> = std::collections::HashMap::new(); // 剩余可参与总次数
    for a in &accs {
        let lv = db
            .lock()
            .unwrap()
            .get_meta(&format!("alt_level:{}", a.id))
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        for key in WORLD_BOSS_KEYS {
            let req = server_by_key
                .get(key)
                .and_then(|v| v["requiredLevel"].as_i64())
                .unwrap_or(0);
            let max_attempt = server_by_key
                .get(key)
                .and_then(|v| v["maxAttempt"].as_i64())
                .unwrap_or(3)
                .max(1);
            let done = db
                .lock()
                .unwrap()
                .get_meta(&format!("world_done:{}:{}#{}", a.id, session, key))
                .ok()
                .flatten()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0);
            let fit = lv >= req;
            if fit {
                *eligible.entry(key.to_string()).or_insert(0) += 1;
            }
            if done > 0 {
                *participated.entry(key.to_string()).or_insert(0) += 1;
                *done_total.entry(key.to_string()).or_insert(0) += done;
            }
            if fit && done < max_attempt {
                *left_total.entry(key.to_string()).or_insert(0) += max_attempt - done;
            }
            if done >= max_attempt {
                *completed.entry(key.to_string()).or_insert(0) += 1;
            }
        }
    }
    let mut list: Vec<serde_json::Value> = WORLD_BOSS_KEYS
        .iter()
        .map(|key| {
            let server = server_by_key.get(*key).cloned().unwrap_or_else(|| {
                json!({
                    "key": key,
                    "name": world_boss_name(key),
                    "requiredLevel": 0,
                    "requiredPower": 0,
                    "status": "",
                    "maxAttempt": 3,
                })
            });
            let mut v = server.clone();
            let k = key.to_string();
            let max_attempt = v["maxAttempt"].as_i64().unwrap_or(3);
            let compl = completed.get(&k).copied().unwrap_or(0);
            let part = participated.get(&k).copied().unwrap_or(0);
            v["total"] = json!(all_total);
            v["eligible"] = json!(eligible.get(&k).copied().unwrap_or(0));
            v["can_participate"] = json!(eligible.get(&k).copied().unwrap_or(0) - part); // 未参与人数（达标-已参与，与已参与互补）
            v["participated"] = json!(part);
            v["completed"] = json!(compl);
            v["done_times"] = json!(done_total.get(&k).copied().unwrap_or(0)); // 已参与总次数
            v["left_times"] = json!(left_total.get(&k).copied().unwrap_or(0)); // 剩余可参与总次数
            v["max_attempt"] = json!(max_attempt);
            v
        })
        .collect();
    list.sort_by_key(|v| v["requiredLevel"].as_i64().unwrap_or(0));
    Ok(json!({
        "window_active": world_window_active(now),
        "session": session,
        "now": now,
        "bosses": list,
    }))
}

/// 当前场次 id（北京日期 + 窗口时段），用于"每场每 boss 3 次"的幂等计数
pub fn world_session_key(now: i64) -> String {
    let day = super::auth::beijing_day(now);
    let (h, _m) = super::auth::beijing_hour_minute(now);
    let win = if (10..16).contains(&h) {
        10
    } else if (16..20).contains(&h) {
        16
    } else {
        20
    };
    format!("{day}#{win}")
}

/// 世界首领场次窗口（北京时间定时开放：10:00-11:00 / 16:00-17:00 / 20:00-21:00）。
/// **严格按开放时间**：不提前进场（此前"提前 15 分钟"会在 9:45 就去打未开放的 boss，
/// 既报错又会被 world_session_key 错误归到晚场）。场次外完全待机（不请求服务器）。
pub fn world_window_active(now: i64) -> bool {
    let (h, m) = super::auth::beijing_hour_minute(now);
    let cur = h * 60 + m;
    let in_win = |start: i32| {
        let begin = start * 60;
        let end = (start + 1) * 60;
        cur >= begin && cur < end
    };
    in_win(10) || in_win(16) || in_win(20)
}

/// 世界首领协作：场次窗口内按固定世界首领列表 assist 到目标次数（每场每 boss 默认 3 次）。
/// 每账号每场次用 meta:world_done:{acc}:{iid} 记录进度，跨场次（新 iid）自动续。
/// 以服务端为准：失败时返回真实原因（等级不足/本场已满/门票不足），不吞成"成功 0/3"。
pub async fn world_assist(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    boss_key: &str,
    instance_id: &str,
    target: i64,
) -> Result<String, String> {
    if boss_key.is_empty() || instance_id.is_empty() {
        return Err("缺少世界首领场次标记".into());
    }
    let token = ensure_session(db, api, acc).await?;
    let meta_key = format!("world_done:{}:{}", acc.id, instance_id);
    let done = {
        let guard = db.lock().unwrap();
        guard
            .get_meta(&meta_key)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
    };
    let mut n = done;
    let mut last_err: Option<String> = None;
    while n < target {
        match api
            .mutate(&token, "/api/boss/assist", json!({"bossKey": boss_key}))
            .await
        {
            Ok(resp) => {
                n += 1;
                if let Ok(guard) = db.lock() {
                    let _ = guard.set_meta(&meta_key, &n.to_string());
                }
                // 参与成功：从响应里更新世界boss实例状态（血量/生死），事件驱动，无需轮询
                record_status_from_assist(db, instance_id, boss_key, &resp);
            }
            Err(e) => {
                // 记录真实原因；等级不足/已满/门票不足时停止本次
                last_err = Some(e.to_string());
                // 服务端拒绝时，若该 boss 本场已打满，把本地计数对齐到 target，
                // 避免反复盲打"本场最多参与 3 次"
                let msg = last_err.as_deref().unwrap_or("");
                if msg.contains("最多参与") {
                    if let Ok(guard) = db.lock() {
                        let _ = guard.set_meta(&meta_key, &target.to_string());
                    }
                    n = target;
                }
                // 世界boss 本场已结束/已击败/无法参与：记录状态，本场后续全账号跳过
                if msg.contains("没有可参与") || msg.contains("已结束") || msg.contains("已击败") || msg.contains("已被击杀") {
                    if let Some((session, _)) = instance_id.rsplit_once('#') {
                        mark_world_boss_ended(db, session, boss_key);
                        // "当前没有可参与的世界首领场次" = 整场都没有：全部 boss 一起标记，
                        // 避免第一个号把 7 个 boss 逐个盲打一遍 400
                        if msg.contains("没有可参与的世界首领场次") || msg.contains("当前没有可参与") {
                            for k in WORLD_BOSS_KEYS {
                                mark_world_boss_ended(db, session, k);
                            }
                        }
                    }
                }
                break;
            }
        }
        if n >= 50 {
            break;
        }
    }
    if n > done {
        Ok(format!("已参与 {n}/{target} 次"))
    } else if let Some(e) = last_err {
        Err(format!("参与失败：{e}"))
    } else {
        Ok(format!("已参与 {n}/{target} 次"))
    }
}

/// 首领奖励领取：POST /api/boss/claim-reward（空 body，领全部待领奖励；官方 CLI 已确认用法）
/// 幂等：无待领奖励时服务端返回空/直通。每人每天一次即可（覆盖个人/地图/世界首领结算）。
pub async fn claim_boss_rewards(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    let token = ensure_session(db, api, acc).await?;
    let r = api
        .mutate(&token, "/api/boss/claim-reward", json!({}))
        .await
        .map_err(|e| e.to_string())?;
    let data = r.get("data").cloned().unwrap_or(r);
    // 尽力提取奖励摘要（字段未实测，多候选兜底）
    let mut parts: Vec<String> = Vec::new();
    for key in ["claimedRewards", "rewards", "items"] {
        if let Some(arr) = data.get(key).and_then(|v| v.as_array()) {
            if !arr.is_empty() {
                parts.push(format!("{} 项", arr.len()));
                break;
            }
        }
    }
    if let Some(p) = data.get("successText").and_then(|v| v.as_str()) {
        parts.push(p.to_string());
    }
    if parts.is_empty() {
        Ok("首领奖励：已领取（或无待领）".into())
    } else {
        Ok(format!("首领奖励已领取：{}", parts.join("，")))
    }
}