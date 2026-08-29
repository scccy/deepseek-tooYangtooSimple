//! 技能自动学习：先用技能书学习(0→1)，再用技能残页升级(1+→)；每天把所有"可升"的技能尽量升满。
//! 决策字段来自 skills section（view-sections）实测：level/maxLevel/unlockLevel/
//! prerequisites/missingPrerequisites/blockedReason/ownedBooks/ownedPages/pageCost/jobBias。
//! 坑（已实测）：
//! - `/api/skills/upgrade {skillKey}` 一个接口通吃：0→1 学（耗技能书）、1+→升（耗 pageCost 页）；
//!   响应 data.skills 返回更新后的全部技能 → 串行连升。
//! - 技能书**不能捐入公会仓库**（服务端拒绝）、公会补给也**没有技能书** → 书只能自己掉落/市场，自用。
//! - 技能残页可捐/可 redeem/公会可采购（supplyKey=skill，2000 基金/15 页）→ 缺页先仓库 redeem 补。

use super::api::Api;
use super::auth::ensure_session;
use super::db::{Account, Db};
use serde_json::{json, Value};
use std::sync::Mutex;

/// 小号技能循环：把当前可学/可升的技能尽量升满（策略：按服务端 section 顺序 = 主职业主线在前 +
/// 通用树，无前置的通用树根（如 毒云术）会自动先被处理）。缺页先尝试从公会仓库 redeem 技能残页。
/// 返回摘要（升级次数/跳过原因）。日幂等由调度器 step! run_key=skills:{today} 保证。
pub async fn skills_loop(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    let token = ensure_session(db, api, acc).await?;
    let secs = api
        .view_sections(&token, &["skills"])
        .await
        .map_err(|e| e.to_string())?;
    let mut skills: Vec<Value> = secs
        .get("skills")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if skills.is_empty() {
        return Ok("技能：无数据（skills section 为空）".into());
    }

    let mut acted = 0usize;
    let mut skip_reasons: std::collections::HashSet<String> = std::collections::HashSet::new();

    for _round in 0..100 {
        // 找一个可升级技能：未满级 + 前置已满足 + 未被阻挡
        let idx = skills.iter().position(|s| {
            let lv = s["level"].as_i64().unwrap_or(0);
            let max = s["maxLevel"].as_i64().unwrap_or(5);
            lv < max
                && s["missingPrerequisites"]
                    .as_array()
                    .map(|a| a.is_empty())
                    .unwrap_or(true)
                && s["blockedReason"].as_str().unwrap_or("").is_empty()
        });
        let Some(i) = idx else { break };
        let key = skills[i]["key"].as_str().unwrap_or("").to_string();
        let name = skills[i]["name"].as_str().unwrap_or(&key).to_string();
        if key.is_empty() {
            break;
        }
        let lv = skills[i]["level"].as_i64().unwrap_or(0);
        let max = skills[i]["maxLevel"].as_i64().unwrap_or(5);
        let have_books = skills[i]["ownedBooks"].as_i64().unwrap_or(0);
        let page_cost = skills[i]["pageCost"].as_i64().unwrap_or(0);
        // 0→1 需要技能书（书没有工会通道，缺书跳过）
        if lv == 0 && have_books <= 0 {
            skip_reasons.insert(format!("{name}(缺技能书)"));
            skills[i]["blockedReason"] = json!("跳过（无技能书）");
            continue;
        }
        // 升级/学习：**错误驱动补资源**。skills section 的 ownedPages/ownedBooks 是开局快照，
        // 升级消耗后本地仍可能是旧值 → 不依赖本地预判 redeem；直接试 upgrade，
        // 服务端报"技能残页不足"时解析数量 → 公会仓库 redeem 补一次 → 同技能重试一次。
        let mut upgraded = false;
        let mut retried_pages = false;
        while !upgraded {
            match api
                .mutate(&token, "/api/skills/upgrade", json!({"skillKey": key}))
                .await
            {
                Ok(v) => {
                    upgraded = true;
                    acted += 1;
                    // 刷新技能数组（响应 data.skills 返回全部）
                    if let Some(arr) = v
                        .get("data")
                        .and_then(|d| d.get("skills"))
                        .and_then(|x| x.as_array())
                    {
                        skills = arr.clone();
                    } else if let Some(cur) = skills[i]["level"].as_i64() {
                        // 无响应数组：本地把该技能等级 +1，避免死循环
                        skills[i]["level"] = json!((cur + 1).min(max));
                    } else {
                        skills[i]["level"] = json!(max);
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    if !retried_pages && msg.contains("技能残页不足") {
                        retried_pages = true;
                        let need = parse_need(&msg).unwrap_or(page_cost.max(4));
                        match super::guild::guild_redeem(db, api, acc, "skill_page", need).await {
                            Ok(_) => continue, // 补到 → 同技能重试一次
                            Err(_) => {
                                skip_reasons.insert(format!("{name}(仓库无技能残页/贡献不足)"));
                                skills[i]["blockedReason"] = json!("跳过（技能残页不足且仓库无货）");
                                break;
                            }
                        }
                    }
                    // 服务端拒绝（前置/等级/资源仍不足）：标记该技能跳过，避免死循环
                    skip_reasons.insert(format!("{name}({})", msg.chars().take(30).collect::<String>()));
                    skills[i]["blockedReason"] = json!("跳过（升级被拒）");
                    break;
                }
            }
        }
        if acted >= 100 {
            break;
        }
    }

    let mut note = String::new();
    if !skip_reasons.is_empty() {
        let mut v: Vec<String> = skip_reasons.into_iter().collect();
        v.sort();
        note = format!("；跳过：{}", v.join("、"));
    }
    Ok(format!("技能：学/升 {acted} 级{note}"))
}

/// 从服务端错误文案里解析"需要数量"（如 "技能残页不足，需要 8。" → 8）
fn parse_need(msg: &str) -> Option<i64> {
    msg.split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse::<i64>().ok())
        .last()
}

/// 大号用公会基金采购技能残页补给（supplyKey=skill，一次 15 页，2000 基金）→ 入公会仓库，
/// 供小号 skills_loop 缺页时 redeem。次数由 opts.guild_buy_skill_pages 控制（每日，0=关）。
pub async fn purchase_skill_pages(
    db: &Mutex<Db>,
    api: &Api,
    main: &Account,
    buys: i64,
) -> Result<String, String> {
    if buys <= 0 {
        return Ok("技能残页采购未开启".into());
    }
    let token = ensure_session(db, api, main).await?;
    let mut ok = 0i64;
    for _ in 0..buys.min(20) {
        match api
            .mutate(&token, "/api/guild/supply/purchase", json!({"supplyKey": "skill", "count": 1}))
            .await
        {
            Ok(_) => ok += 1,
            Err(e) => return Ok(format!("技能残页采购 {ok}/{} 次后终止（{e}）", buys.min(20))),
        }
    }
    Ok(format!("技能残页采购 {ok} 次（{} 页）", ok * 15))
}