//! 收菜引擎：挂机收益 / 邮件 / 签到 / 每日宝箱 / 成就 / 领取编排

use super::api::Api;
use super::auth::ensure_session;
use super::db::{Account, Db};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;

pub fn has_gains(s: &Value) -> bool {
    let get = |k: &str| s.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    get("exp") > 0 || get("gold") > 0 || get("killCount") > 0 || get("dropCount") > 0 || get("rareCoinFragments") > 0
}

/// collect_round 是"尽力而为"：部分子步骤失败时（邮件/收益预览 HTTP、网络、超时等）
/// 会把错误拼进结果文字并整体返回 Ok。这里把它转成失败——
/// 避免"收益预览 502 却没领到收益"还被记成"收菜完成"，导致完成度虚高、继续按钮判它已完成。
pub fn collect_result_ok(res: Result<String, String>) -> Result<String, String> {
    match res {
        Ok(msg)
            if msg.contains("HTTP ")
                || msg.contains("失败")
                || msg.contains("网络")
                || msg.contains("超时")
                || msg.contains("错误")
                || msg.contains("会话无效")
                || msg.contains("已过期")
                || msg.contains("版本过低") =>
        {
            Err(msg)
        }
        other => other,
    }
}

pub async fn idle_summary(api: &Api, token: &str) -> Result<Value, String> {
    api.request(super::api::Req {
        method: "GET",
        path: "/api/client/idle-summary".into(),
        body: None,
        token: Some(token),
        response_state: "omit",
        timeout_secs: 20,
    })
    .await
    .map_err(|e| e.to_string())
    .map(|r| r.get("data").cloned().unwrap_or(r))
}

/// 领取挂机收益；若触发旅途奇遇，按偏好选择选项后结算一次（无匹配项则取第一项）
/// pref: "exp"=经验优先（默认）| "gold"=金币优先 | "drop"=掉落优先 | "first"=直接取第一项
/// 409「玩家状态已被其他 worker 更新」= 旧会话/worker 标识冲突（实测重新登录可解）：
/// 自动强制重登换新 token 后重试一次。
pub async fn collect_idle_with_pref(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    token: &str,
    pref: &str,
) -> Result<Value, String> {
    let mut token = token.to_string();
    let first = match api
        .mutate(&token, "/api/client/collect", json!({}))
        .await
    {
        Err(e) if e.to_string().contains("worker 更新") => {
            // 旧会话冲突：重新登录换新会话再领一次
            let _ = super::auth::force_relogin(db, api, acc).await;
            token = super::auth::ensure_session(db, api, acc).await?;
            api.mutate(&token, "/api/client/collect", json!({})).await
        }
        r => r,
    };
    let first = first.map_err(|e| e.to_string())?;
    let data = first.get("data").cloned().unwrap_or(first);
    // 奇遇结算：同一轮只提交一次。
    // 优先用 collect 响应里带的 adventure（新触发的奇遇）；提交成功即认为已结算，
    // 不再二次 bootstrap 重复提交（原来两条路径都可能提交，存在同一轮重复结算风险）。
    let mut adventure_settled = false;
    if data.get("adventure").map(|a| a.is_object()).unwrap_or(false) {
        if let Some(k) = pick_option(&data["adventure"], pref) {
            adventure_settled = api
                .mutate(&token, "/api/client/collect", json!({"adventureOptionKey": k}))
                .await
                .is_ok();
        }
    }
    // 兜底：进行中的奇遇挂在 bootstrap.idleAdventure（登录即可见），collect 不会自动结算，
    // 必须显式按偏好选一项提交 adventureOptionKey（实测「山腰的旧神龛」结构如此）
    if !adventure_settled {
        if let Ok(state) = api.bootstrap(&token).await {
            if let Some(adv) = state.get("idleAdventure").filter(|a| a.is_object()) {
                let has_opts = adv
                    .get("options")
                    .and_then(|o| o.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);
                if has_opts {
                    if let Some(k) = pick_option(adv, pref) {
                        let _ = api
                            .mutate(&token, "/api/client/collect", json!({"adventureOptionKey": k}))
                            .await;
                    }
                }
            }
        }
    }
    Ok(data)
}

/// 默认行为：永远选"经验"项（无经验项则取第一项）——兼容旧调用
pub async fn collect_idle(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    token: &str,
) -> Result<Value, String> {
    collect_idle_with_pref(db, api, acc, token, "exp").await
}

/// 旅途奇遇：优先按"正收益文本"匹配（如 effectText「经验收益 +8%」→ 经验偏好选它），
/// 再按偏好关键词兜底（跳过显式负收益「-」），最后取第一项。
/// 实测结构：bootstrap.idleAdventure = { title, key, options:[{key,label,description,effectText}] }。
fn pick_option(adv: &Value, pref: &str) -> Option<String> {
    let opts = adv["options"].as_array()?;
    let hay = |o: &Value| {
        format!(
            "{} {} {} {}",
            o["key"].as_str().unwrap_or(""),
            o["label"].as_str().unwrap_or(""),
            o["description"].as_str().unwrap_or(""),
            o["effectText"].as_str().unwrap_or("")
        )
    };
    // 1) 正收益文本（用户要求：匹配「经验 +」这类字段，如 经验收益 +8%）
    let pos: &[&str] = match pref {
        "gold" => &["金币收益 +", "金币+"],
        "drop" => &["掉落收益 +", "掉落+", "爆率+"],
        "first" => &[],
        _ => &["经验收益 +", "经验+"],
    };
    if !pos.is_empty() {
        if let Some(o) = opts
            .iter()
            .find(|o| pos.iter().any(|p| hay(o).contains(p)))
        {
            return o["key"].as_str().map(|s| s.to_string());
        }
    }
    // 2) 关键词兜底（跳过显式负收益，如「经验收益 -5%」）
    let keywords: &[&str] = match pref {
        "gold" => &["金币", "gold"],
        "drop" => &["掉落", "爆率", "drop"],
        "first" => &[],
        _ => &["经验", "exp"],
    };
    if !keywords.is_empty() {
        if let Some(o) = opts
            .iter()
            .find(|o| {
                let h = hay(o);
                keywords
                    .iter()
                    .any(|k| h.contains(k) || h.eq_ignore_ascii_case(k))
                    && !h.contains('−')
                    && !h.contains("-")
            })
        {
            return o["key"].as_str().map(|s| s.to_string());
        }
    }
    opts.first().and_then(|o| o["key"].as_str().map(|s| s.to_string()))
}

/// 本地记录一条"完成"（供总览统计；run_key 幂等，重复调用覆盖）
async fn record_local(db: &Mutex<Db>, account_id: i64, task: &str, run_key: &str) {
    let now = super::auth::now_ms();
    let row = super::db::RunRow {
        account_id,
        task: task.into(),
        run_key: run_key.into(),
        status: "ok".into(),
        detail: String::new(),
        started_at: now,
        finished_at: now,
    };
    if let Ok(guard) = db.lock() {
        let _ = guard.touch_run(&row, true);
    }
}

/// 收益评分：网页"收益评分" = profile.revenueScore.total（base 100 + 经验/金币/掉落/稀有掉落/
/// boss掉落/挂机效率/幸运加成）。收菜时顺带缓存 alt_revenue:{id}，供总览 200 一档分布统计。
pub async fn refresh_revenue(db: &Mutex<Db>, api: &Api, acc: &Account, token: &str) {
    if let Ok(v) = api.view_sections(token, &["profile"]).await {
        let total = v
            .get("profile")
            .and_then(|p| p.get("revenueScore"))
            .and_then(|r| r.get("total"))
            .and_then(|t| t.as_f64())
            .unwrap_or(0.0);
        if total > 0.0 {
            if let Ok(guard) = db.lock() {
                let _ = guard.set_meta(&format!("alt_revenue:{}", acc.id), &format!("{total:.0}"));
            }
        }
    }
}

/// 每日活跃宝箱：先补一次装备强化（活跃 100 需要当天有 enhanceCount），再按档位领取。
/// 实测：point 是数字档位（20/40/60/80/100），不是任务名；100 档要求活跃度 100，
/// 而活跃度包含"强化装备"动作 —— 当天没强化过就先随机对一件装备强化 +1。
async fn claim_daily_activity(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    token: &str,
    state: &Value,
) -> String {
    let today = state["daily"]["key"].as_str().unwrap_or("").to_string();
    // 已领档位（服务端幂等，重复领取返回 400；过滤后只领未领的）
    let claimed: HashSet<String> = state["daily"]["claimedActivity"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let enhance_count = state["daily"]["enhanceCount"].as_i64().unwrap_or(0);

    let mut parts: Vec<String> = Vec::new();
    if !claimed.contains("100") && enhance_count == 0 {
        // 活跃 100 需要强化动作：随机对一件已装备/背包装备做 +1 强化（先 preview 核成本）
        if let Some(eq) = pick_enhance_candidate(state) {
            let eq_id = eq["id"].as_str().unwrap_or("");
            if !eq_id.is_empty() {
                let prev = api
                    .mutate(token, "/api/equipment/enhance-preview", json!({"equipmentId": eq_id, "useProtectCharm": false}))
                    .await;
                match prev {
                    Ok(p) => {
                        let gold = p["data"]["result"]["goldCost"].as_i64().unwrap_or(0);
                        let stone = p["data"]["result"]["stoneCost"].as_i64().unwrap_or(0);
                        let owned_gold = p["data"]["result"]["ownedGold"].as_i64().unwrap_or(0);
                        let owned_stone = p["data"]["result"]["ownedStone"].as_i64().unwrap_or(0);
                        if gold <= owned_gold && stone <= owned_stone && stone >= 0 {
                            match api
                                .mutate(token, "/api/equipment/enhance", json!({"equipmentId": eq_id, "useProtectCharm": false}))
                                .await
                            {
                                Ok(_) => parts.push("活跃补强化+1".into()),
                                Err(e) => parts.push(format!("活跃补强化失败:{e}")),
                            }
                        }
                    }
                    Err(_) => {}
                }
            }
        }
    }

    let mut errs = 0usize;
    let mut got = 0usize;
    for p in [20i64, 40, 60, 80, 100] {
        if claimed.contains(&p.to_string()) {
            got += 1;
            continue;
        }
        match api.mutate(token, "/api/daily/claim", json!({"point": p})).await {
            Ok(v) => {
                // 档位领取重复/档位不存在/活跃度不足：服务端 ok:false 正常返回，不视为失败
                if v.get("ok").and_then(|x| x.as_bool()) == Some(false) {
                    continue;
                }
                got += 1;
            }
            Err(_) => errs += 1,
        }
    }
    if errs == 0 && got >= 5 {
        record_local(db, acc.id, "daily_claim", &format!("daily_claim:{today}")).await;
    }
    let verdict = if got >= 5 {
        "成功"
    } else if errs > 0 {
        "失败"
    } else {
        "部分"
    };
    parts.push(format!("活跃宝箱:{got}/5 领取{verdict}"));
    parts.join("；")
}

/// 挑一件强化候选：优先背包/闲置里强化等级最低的装备（成本最低），其次任意未满级装备
fn pick_enhance_candidate(state: &Value) -> Option<Value> {
    let eqs = state["equipment"].as_array().cloned().unwrap_or_default();
    if eqs.is_empty() {
        return None;
    }
    let mut best: Option<(&Value, i64)> = None;
    for e in &eqs {
        let lv = e["enhanceLevel"].as_i64().unwrap_or(0);
        if lv >= 12 {
            continue;
        }
        if best.map(|(_, bl)| lv < bl).unwrap_or(true) {
            best = Some((e, lv));
        }
    }
    best.map(|(e, _)| e.clone())
}

/// 一轮收菜。with_daily=true 时额外做签到/每日宝箱/成就。
/// 所有动作天然幂等：重跑无害（服务端累积收益，领取重复点返回已领）。
pub async fn collect_round(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    with_daily: bool,
) -> Result<String, String> {
    let token = ensure_session(db, api, acc).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    // 收益评分（接口 profile.revenueScore.total）顺带缓存，供总览分档
    refresh_revenue(db, api, acc, &token).await;
    let today = state["daily"]["key"].as_str().unwrap_or("").to_string();
    let mut parts: Vec<String> = Vec::new();

    // 1) 邮件（新号福利/每日登录/市场到账都走邮件）
    match api
        .post_omit(&token, "/api/mail/claim-all", json!({}))
        .await
    {
        Ok(_) => parts.push("邮件已领".into()),
        Err(e) => parts.push(format!("邮件:{e}")),
    }
    let _ = api.post_omit(&token, "/api/mail/delete-read", json!({})).await;

    if with_daily {
        // 2) 签到（记录完成，供总览"今日任务完成度"统计）
        let last = state["retention"]["signIn"]["lastClaimedKey"]
            .as_str()
            .unwrap_or("");
        if last != today {
            match api
                .post_omit(&token, "/api/retention/sign-in", json!({}))
                .await
            {
                Ok(_) => {
                    parts.push("签到成功".into());
                    record_local(db, acc.id, "sign_in", &format!("sign_in:{today}")).await;
                }
                Err(e) => parts.push(format!("签到:{e}")),
            }
        }
        // 3) 每日活跃宝箱：point 是数字档位（20/40/60/80/100）；100 档要求当天有强化动作
        let ab = claim_daily_activity(db, api, acc, &token, &state).await;
        parts.push(ab);
        // 4) 成就（只领未领取的；已领的重复领取会 400，不算失败）
        let mut ach_errs = 0usize;
        let claimed_ach: HashSet<String> = state["achievements"]["claimedKeys"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if let Some(arr) = state["achievements"]["unlockedKeys"].as_array() {
            for k in arr {
                if let Some(s) = k.as_str() {
                    if claimed_ach.contains(s) {
                        continue;
                    }
                    if api
                        .mutate(&token, "/api/achievements/claim", json!({"achievementKey": s}))
                        .await
                        .is_err()
                    {
                        ach_errs += 1;
                    }
                }
            }
        }
        if ach_errs > 0 {
            parts.push(format!("成就:{ach_errs} 领取失败"));
        }
    }

    // 5) 挂机收益
    match idle_summary(api, &token).await {
        Ok(sum) if has_gains(&sum) => {
            let gold = sum["gold"].as_i64().unwrap_or(0);
            let frags = sum["rareCoinFragments"].as_i64().unwrap_or(0);
            let kills = sum["killCount"].as_i64().unwrap_or(0);
            let drops = sum["dropCount"].as_i64().unwrap_or(0);
            // 领取结果如实上报：409"玩家状态已被其他 worker 更新"时不能显示"已领"
            match collect_idle(db, api, acc, &token).await {
                Ok(_) => parts.push(format!("挂机收益:金币+{gold} 元宝碎片+{frags} 击杀{kills} 掉落{drops}")),
                Err(e) => parts.push(format!("挂机收益领取失败:{e}（金币+{gold} 元宝碎片+{frags} 击杀{kills} 掉落{drops}）")),
            }
        }
        Ok(_) => parts.push("挂机暂无收益".into()),
        Err(e) => parts.push(format!("收益预览:{e}")),
    }

    // 6) 收菜时本地记录：等级 + 背包快照 + 装备快照（无需再打网络，每次收菜都刷新）
    snapshot_local(db, acc, &state);

    Ok(parts.join("；"))
}

/// 本地快照：等级 + 战力 + 当前地图 + 背包 + 装备（供捐赠/分解模板/套装进度/总览展示，无网络请求）
pub fn snapshot_local(db: &Mutex<Db>, acc: &Account, state: &Value) {
    if let Some(lv) = state["player"]["level"].as_i64() {
        if let Ok(guard) = db.lock() {
            let _ = guard.set_meta(&format!("alt_level:{}", acc.id), &lv.to_string());
        }
    }
    if let Some(pw) = state["player"]["power"].as_i64() {
        if let Ok(guard) = db.lock() {
            let _ = guard.set_meta(&format!("alt_power:{}", acc.id), &pw.to_string());
        }
    }
    if let Some(m) = state["player"]["currentMap"].as_str() {
        if let Ok(guard) = db.lock() {
            let _ = guard.set_meta(&format!("alt_map:{}", acc.id), m);
        }
    }
    if let Some(items) = state.get("items") {
        if let Ok(guard) = db.lock() {
            let _ = guard.snapshot_inventory(acc.id, items);
        }
    }
    if let Some(eqs) = state.get("equipment") {
        if let Ok(guard) = db.lock() {
            let _ = guard.snapshot_equipment(acc.id, eqs);
        }
    }
}