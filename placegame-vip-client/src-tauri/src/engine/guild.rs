//! 公会协同引擎：大号建会 / 小号练级入会 / 小号捐献 / 大号审批与分红
//! 已从代码确认：公会入会需等级 12（joinRequiredLevel ?? 12）

use super::api::Api;
use super::auth::{default_nickname, ensure_session};
use super::collect::{collect_idle, has_gains, idle_summary};
use super::db::{Account, Db};
use serde_json::{json, Value};
use std::sync::Mutex;

pub fn player_level(state: &Value) -> i64 {
    if let Some(p) = state.get("player") {
        if let Some(l) = p["level"].as_i64() {
            return l;
        }
    }
    state["profile"]["level"].as_i64().unwrap_or(1)
}

pub fn player_power(state: &Value) -> i64 {
    if let Some(p) = state.get("player") {
        if let Some(v) = p["power"].as_i64() {
            return v;
        }
    }
    state["profile"]["power"].as_i64().unwrap_or(0)
}

pub fn current_map_key(state: &Value) -> String {
    if let Some(p) = state.get("player") {
        if let Some(m) = p["currentMap"].as_str() {
            return m.to_string();
        }
    }
    state["profile"]["currentMap"].as_str().unwrap_or("").to_string()
}

pub fn has_character(state: &Value) -> bool {
    state.get("player").map(|p| p.is_object() && !p.is_null()).unwrap_or(false)
        || state.get("profile").map(|p| p.is_object()).unwrap_or(false)
}

/// 小号建角色（幂等）
/// 安全网：bootstrap 返回空对象/null（维护期/坏响应）时状态未知，直接报错重试，
/// 绝不在"不知道有没有角色"的情况下调 create（可能重建角色、清空账号数据）。
pub async fn ensure_character(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<bool, String> {
    let token = ensure_session(db, api, acc).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    if has_character(&state) {
        return Ok(false);
    }
    // 状态未知防护：整个 state 为空/非对象时视为异常（正常新号 bootstrap 也会带其他 section）
    let empty = state
        .as_object()
        .map(|o| o.is_empty())
        .unwrap_or(true);
    if empty {
        return Err("bootstrap 返回空状态，跳过建角色（稍后重试）".into());
    }
    let nick = default_nickname(&acc.username);
    api.post_omit(
        &token,
        "/api/character/create",
        json!({"nickname": nick, "job": acc.job}),
    )
    .await
    .map_err(|e| e.to_string())?;
    {
        let db = db.lock().unwrap();
        let _ = db.update_nickname_job(acc.id, &nick, &acc.job);
    }
    Ok(true)
}

/// 尝试推进到当前可进的最优地图（换图失败不阻塞）
/// 地图列表在 view-sections(["maps"]) 里（bootstrap 的 maps 为空，导致之前换图失效）
pub async fn change_best_map(api: &Api, token: &str) -> Result<String, String> {
    let state = api.bootstrap(token).await.map_err(|e| e.to_string())?;
    let level = player_level(&state);
    let power = player_power(&state);
    let cur = current_map_key(&state);
    // 地图列表单独拉（bootstrap 不带 maps section）。拉取失败必须暴露——
    // 否则"没有更优图"和"列表没拉到"无法区分，角色会永远卡在当前图还不报错
    let maps = api
        .view_sections(token, &["maps"])
        .await
        .map_err(|e| format!("view-sections(maps) 失败: {e}"))?
        .get("maps")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| "view-sections 未返回 maps 列表".to_string())?;
    if maps.is_empty() {
        return Err("view-sections maps 列表为空".into());
    }
    let mut best: Option<(i64, String)> = None; // (requiredLevel, key)
    for m in &maps {
        let key = m["key"]
            .as_str()
            .or_else(|| m["mapKey"].as_str())
            .unwrap_or("")
            .to_string();
        if key.is_empty() {
            continue;
        }
        // 未解锁/被阻挡的地图不要当候选（不然会对着 blockedReason 的图反复发 change-map 请求）
        if m["unlocked"].as_bool() == Some(false)
            || m["blockedReason"].as_str().map(|b| !b.is_empty()).unwrap_or(false)
        {
            continue;
        }
        let rl = m["requiredLevel"].as_i64().unwrap_or(i64::MAX);
        // entryPower 缺失时不要默认 i64::MAX（会把所有图判为不可进入 → 角色永远卡图）：
        // 用 pressurePower 兜底，再缺失按 0（让服务端 change-map 做最终校验）
        let ep = m["entryPower"]
            .as_i64()
            .or_else(|| m["pressurePower"].as_i64())
            .unwrap_or(0);
        if rl <= level && ep <= power {
            if best.as_ref().map_or(true, |(brl, _)| rl > *brl) {
                best = Some((rl, key));
            }
        }
    }
    if let Some((_, key)) = best {
        if key != cur {
            // 换图失败必须暴露（之前吞掉后本地 alt_map 会记成已切换 → 分解模板/套装统计按错误地图）
            api.mutate(token, "/api/battle/change-map", json!({"mapKey": key}))
                .await
                .map_err(|e| format!("换图失败({key}): {e}"))?;
            return Ok(key);
        }
    }
    Ok(cur)
}

/// 收一次挂机经验，返回当前等级
/// target = i64::MAX 表示无上限（入会后持续练级）；否则达到 target 后进入 ready（入会门槛）
pub async fn level_once(db: &Mutex<Db>, api: &Api, acc: &Account, target: i64) -> Result<String, String> {
    // 建角色失败（含"状态未知"防护）必须中止本轮，不能在空状态上继续练级/换图
    ensure_character(db, api, acc).await?;
    let token = ensure_session(db, api, acc).await?;
    // 换图：成功立即把新地图写回本地 alt_map（否则 decompose 模板/boss 套装一直按旧地图，
    // 例：#62 被换到 24 图但本地仍是新手村 → 分解卡新手村档、套装按新手村统计）；
    // 失败必须记录成可见的 map 日志（不再静默吞掉——之前 alt 卡新手村没有任何报错）
    match change_best_map(api, &token).await {
        Ok(new_map) => {
            if !new_map.is_empty() {
                let prev = db
                    .lock()
                    .unwrap()
                    .get_meta(&format!("alt_map:{}", acc.id))
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                if let Ok(guard) = db.lock() {
                    let _ = guard.set_meta(&format!("alt_map:{}", acc.id), &new_map);
                }
                // 真正发生地图切换时也写一条可见的成功日志（否则只报失败，看不到"换成功了"）；
                // 仍是同一张最优图时保持安静，避免每轮刷屏
                if new_map != prev {
                    crate::engine::scheduler::record(
                        db,
                        acc.id,
                        "map",
                        &format!("map:{}", super::auth::now_ms() / 60_000),
                        Ok(format!("换图:{new_map}")),
                    )
                    .await;
                }
            }
        }
        Err(e) => {
            crate::engine::scheduler::record(
                db,
                acc.id,
                "map",
                &format!("map:{}", super::auth::now_ms() / 60_000),
                Err(e),
            )
            .await;
        }
    }
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let level = player_level(&state);
    if let Ok(sum) = idle_summary(api, &token).await {
        if has_gains(&sum) {
            let _ = collect_idle(db, api, acc, &token).await;
        }
    }
    if level >= target {
        let db = db.lock().unwrap();
        let _ = db.set_meta(&format!("alt_phase:{}", acc.id), "ready");
    } else if let Ok(guard) = db.lock() {
        let _ = guard.set_meta(&format!("alt_level:{}", acc.id), &level.to_string());
    }
    if target == i64::MAX {
        Ok(format!("当前等级 {level}（无上限，持续练级）"))
    } else {
        Ok(format!("当前等级 {level} / 目标 {target}"))
    }
}

/// 大号建会；尽量设为免审核入会；返回 guildId
pub async fn create_guild(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    name: &str,
    motto: &str,
) -> Result<String, String> {
    let token = ensure_session(db, api, main).await?;
    api.mutate(&token, "/api/guild/create", json!({"name": name, "motto": motto}))
        .await
        .map_err(|e| e.to_string())?;
    let _ = api.mutate(&token, "/api/guild/join-policy", json!({"requiresApproval": false})).await;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let gid = state["guild"]["guildId"].as_str().unwrap_or("").to_string();
    if gid.is_empty() {
        return Err("建会后读不到 guildId".into());
    }
    {
        let db = db.lock().unwrap();
        db.set_meta("main_guild_id", &gid).map_err(|e| e.to_string())?;
    }
    Ok(gid)
}

pub fn main_guild_id(db: &Db) -> Option<String> {
    db.get_meta("main_guild_id")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

/// 小号申请入会；返回是否已入会
pub async fn alt_join(db: &Mutex<Db>, api: &Api, alt: &Account, guild_id: &str) -> Result<bool, String> {
    let token = ensure_session(db, api, alt).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    if state["guild"]["joined"].as_bool().unwrap_or(false) {
        return Ok(true);
    }
    let _ = api
        .mutate(&token, "/api/guild/apply", json!({"guildId": guild_id}))
        .await
        .map_err(|e| e.to_string())?;
    let state2 = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    Ok(state2["guild"]["joined"].as_bool().unwrap_or(false))
}

/// 小号捐献：把背包里未绑定、未锁定、非保留的材料的全部数量捐给公会
pub async fn alt_donate(
    db: &Mutex<Db>,
    api: &Api,
    alt: &Account,
    deny: &[String],
) -> Result<usize, String> {
    let token = ensure_session(db, api, alt).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    if !state["guild"]["joined"].as_bool().unwrap_or(false) {
        return Err("未入会，无法捐献".into());
    }
    // 保留清单（不捐）：① 当前 boss 需要的材料（ladder 写入 boss_material:{id}，供带材料加成打最高难度）；
    // ② 技能残页 skill_page（升级技能自用）；③ 首领门票 boss_ticket（小号打个人/地图 boss 付费次数自用）
    // ——避免"捐进仓库又赎回"白花贡献/没页没票可用
    let keep: std::collections::HashSet<String> = {
        let mut s = std::collections::HashSet::new();
        s.insert("skill_page".to_string());
        s.insert("boss_ticket".to_string());
        let boss_mat = db
            .lock()
            .unwrap()
            .get_meta(&format!("boss_material:{}", alt.id))
            .ok()
            .flatten()
            .unwrap_or_default();
        if !boss_mat.is_empty() {
            s.insert(boss_mat);
        }
        s
    };
    let mut n = 0usize;
    if let Some(items) = state.get("items").and_then(|v| v.as_array()) {
        for it in items {
            let bind = it["bindStatus"].as_str().unwrap_or("");
            let status = it["status"].as_str().unwrap_or("");
            let itype = it["itemType"].as_str().unwrap_or("");
            let key = it["itemKey"].as_str().unwrap_or("");
            let amount = it["amount"].as_i64().unwrap_or(0);
            let id = it["id"].as_str().unwrap_or("").to_string();
            if !id.is_empty()
                && amount > 0
                && bind == "unbound"
                && status == "in_bag"
                && itype == "material"
                && !deny.iter().any(|d| d == key)
                && !keep.contains(key)
            {
                if api
                    .mutate(&token, "/api/guild/donate", json!({"itemId": id, "amount": amount}))
                    .await
                    .is_ok()
                {
                    n += 1;
                }
            }
        }
    }
    Ok(n)
}

/// 大号每日领取公会分红
pub async fn main_claim_dividend(db: &Mutex<Db>, api: &Api, main: &Account) -> Result<(), String> {
    let token = ensure_session(db, api, main).await?;
    api.mutate(&token, "/api/guild/claim-dividend", json!({}))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 大号每日领取公会捐献进度里程碑奖励（工会宝箱：30/60 点 → 金币/技能残页）。
/// 幂等：已领档位服务端返回 ok:false 忽略；只领 canClaim 的档位。
pub async fn main_claim_progress(db: &Mutex<Db>, api: &Api, main: &Account) -> Result<String, String> {
    let token = ensure_session(db, api, main).await?;
    let view = api
        .request(super::api::Req {
            method: "GET",
            path: "/api/guild/view".into(),
            body: None,
            token: Some(&token),
            response_state: "omit",
            timeout_secs: 30,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = view.get("data").cloned().unwrap_or(view);
    let rewards = data
        .get("progressRewards")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut got = 0usize;
    for r in &rewards {
        if r["claimed"].as_bool().unwrap_or(false) {
            continue;
        }
        if !r["canClaim"].as_bool().unwrap_or(false) {
            continue;
        }
        let Some(pt) = r["point"].as_i64() else { continue };
        let r = api
            .mutate(&token, "/api/guild/claim-progress", json!({"point": pt}))
            .await;
        match r {
            Ok(v) => {
                // 幂等：ok:false（已领取/未达标）不算失败
                if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                    got += 1;
                }
            }
            Err(_) => {}
        }
    }
    Ok(format!("公会宝箱领取 {got} 档"))
}

fn quality_rank_g(q: &str) -> i32 {
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

/// 小号装备一键捐赠公会共享仓库（养大号关键链路）
/// 范围：未绑定 + 未锁定 + 未穿戴 + 品质 ≥ 服务端 equipmentDonationMinQuality（默认 purple 实测）
/// + 评分 ≥ min_score（0 = 不限，条件触发：只有出现达标装备才捐，不是每日必做）
pub async fn alt_equip_donate(
    db: &Mutex<Db>,
    api: &Api,
    alt: &Account,
    fallback_min_quality: &str,
    min_score: i64,
) -> Result<usize, String> {
    let token = ensure_session(db, api, alt).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    if !state["guild"]["joined"].as_bool().unwrap_or(false) {
        return Err("未入会，无法捐献装备".into());
    }
    let server_min = state["guild"]["equipmentDonationMinQuality"]
        .as_str()
        .unwrap_or(fallback_min_quality);
    let min_rank = quality_rank_g(server_min);
    let mut n = 0usize;
    if let Some(eqs) = state.get("equipment").and_then(|v| v.as_array()) {
        for e in eqs {
            if e["status"].as_str() != Some("in_bag") {
                continue;
            }
            if e["locked"].as_bool().unwrap_or(false) {
                continue;
            }
            if e["bindStatus"].as_str() != Some("unbound") {
                continue;
            }
            if quality_rank_g(e["quality"].as_str().unwrap_or("white")) < min_rank {
                continue;
            }
            // 评分门槛：只有达到设定评分的装备才捐（0 = 不限）
            if min_score > 0 && e["score"].as_i64().unwrap_or(0) < min_score {
                continue;
            }
            let eq_id = e["id"].as_str().unwrap_or("").to_string();
            if eq_id.is_empty() {
                continue;
            }
            if api
                .mutate(&token, "/api/guild/equipment/donate", json!({"equipmentId": eq_id}))
                .await
                .is_ok()
            {
                n += 1;
            }
        }
    }
    Ok(n)
}

/// 主号一键同步：识别已在游戏内创建的公会 + 回读角色职业（调度器每日调用）
pub async fn sync_main_meta(db: &Mutex<Db>, api: &Api, main: &Account) -> Result<String, String> {
    let token = ensure_session(db, api, main).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    // 角色信息（真实职业/昵称）
    if let Some(job) = state["player"]["job"].as_str() {
        let nick = state["player"]["nickname"].as_str().unwrap_or("");
        if let Ok(guard) = db.lock() {
            let _ = guard.update_nickname_job(main.id, nick, job);
        }
    }
    // 公会识别：游戏内已建会/已入会 → 自动写入 main_guild_id
    let g = &state["guild"];
    let gid = g["guildId"].as_str().unwrap_or("").to_string();
    let joined = g["joined"].as_bool().unwrap_or(false);
    if !gid.is_empty() && joined {
        let info = json!({
            "guildId": gid,
            "name": g["name"].as_str().unwrap_or(""),
            "level": g["level"].as_i64().unwrap_or(0),
            "memberCount": g["memberCount"].as_i64().unwrap_or(0),
            "memberLimit": g["memberLimit"].as_i64().unwrap_or(0),
            "fundGold": g["fundGold"].as_i64().unwrap_or(0),
            "equipmentStorageLimit": g["equipmentStorageLimit"].as_i64().unwrap_or(0),
            "equipmentDonationMinQuality": g["equipmentDonationMinQuality"].as_str().unwrap_or(""),
            "requiresApproval": g["requiresApproval"].as_bool().unwrap_or(true),
        })
        .to_string();
        if let Ok(guard) = db.lock() {
            let _ = guard.set_meta("main_guild_id", &gid);
            let _ = guard.set_meta("guild_info", &info);
        }
        // 需审核公会 → 一次性转免审核入会（养号自动入会需要；仅尝试一次，失败不阻塞）
        if g["requiresApproval"].as_bool().unwrap_or(true) {
            let done_policy = {
                let guard = db.lock().unwrap();
                guard
                    .get_meta("join_policy_off")
                    .ok()
                    .flatten()
                    .map(|v| v == "1")
                    .unwrap_or(false)
            };
            if !done_policy {
                let _ = api
                    .mutate(&token, "/api/guild/join-policy", json!({"requiresApproval": false}))
                    .await;
                if let Ok(guard) = db.lock() {
                    let _ = guard.set_meta("join_policy_off", "1");
                }
            }
        }
        Ok(format!(
            "已识别公会：{} (Lv.{})",
            g["name"].as_str().unwrap_or(&gid),
            g["level"].as_i64().unwrap_or(0)
        ))
    } else {
        Ok("主号尚未加入公会".into())
    }
}

/// 主号提交物资需求（需求报表输入）
pub async fn submit_material_request(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    item_key: &str,
    amount: i64,
) -> Result<(), String> {
    let token = ensure_session(db, api, main).await?;
    api.mutate(
        &token,
        "/api/guild/material-request",
        json!({"itemKey": item_key, "amount": amount}),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 主号补充（满足）某个物资需求
pub async fn fulfill_material_request(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    request_id: &str,
    amount: i64,
) -> Result<(), String> {
    let token = ensure_session(db, api, main).await?;
    api.mutate(
        &token,
        "/api/guild/material-request/fulfill",
        json!({"requestId": request_id, "amount": amount}),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 从公会仓库用贡献度兑换材料（实测：1 材料 = 2 贡献；仓库扣库存、材料进背包、基金不变）。
/// 仓库没货 / 贡献不足时返回 Err，调用方据此决定"不带材料加成照打"。
pub async fn guild_redeem(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    item_key: &str,
    amount: i64,
) -> Result<(), String> {
    if amount <= 0 {
        return Ok(());
    }
    let token = ensure_session(db, api, acc).await?;
    api.mutate(
        &token,
        "/api/guild/redeem",
        json!({"itemKey": item_key, "amount": amount}),
    )
    .await
    .map_err(|e| format!("公会兑换失败({item_key}x{amount}): {e}"))?;
    Ok(())
}

/// 拉取公会信息（含需求报表/仓库/审核开关），公会页展示用；顺带识别写入 main_guild_id
pub async fn fetch_guild_info(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
) -> Result<serde_json::Value, String> {
    let token = ensure_session(db, api, main).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let g = &state["guild"];
    let gid = g["guildId"].as_str().unwrap_or("").to_string();
    let joined = g["joined"].as_bool().unwrap_or(false);
    if !gid.is_empty() && joined {
        if let Ok(guard) = db.lock() {
            let _ = guard.set_meta("main_guild_id", &gid);
        }
    }
    // 用 /api/guild/view 补全待审批申请列表（bootstrap 里 applications 为空）
    if joined {
        if let Ok(view) = api
            .request(super::api::Req {
                method: "GET",
                path: "/api/guild/view".into(),
                body: None,
                token: Some(&token),
                response_state: "omit",
                timeout_secs: 30,
            })
            .await
        {
            let data = view.get("data").cloned().unwrap_or(view);
            let mut out = g.clone();
            if let Some(obj) = out.as_object_mut() {
                if let Some(apps) = data.get("applications").and_then(|v| v.as_array()) {
                    obj.insert("applications".into(), json!(apps));
                }
                if let Some(members) = data.get("members").and_then(|v| v.as_array()) {
                    obj.insert("members".into(), json!(members));
                }
            }
            return Ok(out);
        }
    }
    Ok(g.clone())
}

/// 读取待审批申请列表（数据源 /api/guild/view；bootstrap 里该列表为空，不能用）
pub async fn pending_applications(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
) -> Result<Vec<serde_json::Value>, String> {
    let token = ensure_session(db, api, main).await?;
    let view = api
        .request(super::api::Req {
            method: "GET",
            path: "/api/guild/view".into(),
            body: None,
            token: Some(&token),
            response_state: "omit",
            timeout_secs: 30,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = view.get("data").cloned().unwrap_or(view);
    Ok(data
        .get("applications")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// 大号审批所有待入会申请；返回 (审批通过数, 待审批总数)。
/// 数据源：/api/guild/view 的 applications（bootstrap 里该列表为空，不能用）。
pub async fn main_approve_all(db: &Mutex<Db>, api: &Api, main: &Account) -> Result<usize, String> {
    let token = ensure_session(db, api, main).await?;
    let view = api
        .request(super::api::Req {
            method: "GET",
            path: "/api/guild/view".into(),
            body: None,
            token: Some(&token),
            response_state: "omit",
            timeout_secs: 30,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = view.get("data").cloned().unwrap_or(view);
    let apps = data
        .get("applications")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut ids: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for a in &apps {
        let uid = a["userId"]
            .as_str()
            .or_else(|| a["id"].as_str())
            .unwrap_or("");
        if !uid.is_empty() && seen.insert(uid.to_string()) {
            ids.push(uid.to_string());
        }
    }
    // 并发审批（每次最多 5 个在途），避免 62 个申请串行请求卡死界面
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(5));
    let mut set = tokio::task::JoinSet::new();
    for uid in ids {
        let sem = sem.clone();
        let token = token.clone();
        let api = api.clone();
        set.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return false,
            };
            api.mutate(&token, "/api/guild/application/approve", json!({"userId": uid}))
                .await
                .is_ok()
        });
    }
    let mut n = 0usize;
    while let Some(res) = set.join_next().await {
        if res.map(|ok| ok).unwrap_or(false) {
            n += 1;
        }
    }
    Ok(n)
}