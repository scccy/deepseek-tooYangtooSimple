//! M4 装备增强：自动换装 / 一键分解（规则跟随阶段）/ 智能换图（复用 guild::change_best_map）
//! 字段已实测：equipment[].score=穿戴评分、status in_bag/equipped、locked、level、slot

use super::api::Api;
use super::auth::ensure_session;
use super::db::{Account, Db};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

const QUALITIES: [&str; 7] = ["white", "green", "blue", "purple", "orange", "red", "gold"];

/// 分解模板档位：按地图等级段，一档一套（由用户在「分解模板」页配置）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecomposeTier {
    pub map_key: String,
    pub label: String,
    pub min_level: i64,
    pub max_quality: String,     // 品质上限（只分解 <= 该品质）
    pub keep_score_above: i64,   // 保底评分：低于此分才分解，0=不限
    pub keep_rare_affixes: bool, // 保留稀有词条（大极品/极品/小极品）
    pub max_level: i64,          // 装备等级上限（超过不分解）
}

/// 地图档位表（按 requiredLevel 升序；阶段 = 当前地图命中的档位）
pub const MAP_TIERS: [(&str, &str, i64); 9] = [
    ("novice_field", "新手村外", 1),
    ("skeleton_cave", "骷髅洞穴", 12),
    ("abandoned_mine", "废弃矿洞", 24),
    ("viper_valley", "毒蛇峡谷", 36),
    ("dark_forest", "黑暗森林", 50),
    ("demon_temple", "恶魔神殿", 68),
    ("astral_rift", "星渊圣域", 88),
    ("frostfire_sky", "霜火天穹", 112),
    ("time_ruin_sanctum", "时墟神庭", 140),
];

/// 默认 9 档模板（品质随等级抬升；评分不限、稀有保留、等级不限）
pub fn default_tiers() -> Vec<DecomposeTier> {
    const QUALITY_LADDER: [&str; 9] = ["white", "white", "green", "green", "blue", "blue", "purple", "purple", "orange"];
    MAP_TIERS
        .iter()
        .enumerate()
        .map(|(i, (map_key, label, min_level))| DecomposeTier {
            map_key: (*map_key).to_string(),
            label: (*label).to_string(),
            min_level: *min_level,
            max_quality: QUALITY_LADDER[i].to_string(),
            keep_score_above: 0,
            keep_rare_affixes: true,
            max_level: 999,
        })
        .collect()
}

/// 读取用户配置的分解模板（meta["decompose_tiers"]），未配置用默认 9 档
pub fn load_tiers(db: &Mutex<Db>) -> Vec<DecomposeTier> {
    db.lock()
        .ok()
        .and_then(|g| g.get_meta("decompose_tiers").ok().flatten())
        .and_then(|s| serde_json::from_str::<Vec<DecomposeTier>>(&s).ok())
        .unwrap_or_else(default_tiers)
}

/// 背包预清理（领邮件/挂机收益之前必做）：先换装（绑定优先），再按**当前地图档位模板**分解低品质装备。
/// 每次收菜都执行（不按日幂等），避免背包被挂机掉落塞满后"背包空间不足"领不了邮件。
/// 返回 [(task, result)]，供调用方写运行日志。
pub async fn pre_clean_bag(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    auto_equip: bool,
    decompose_enabled: bool,
) -> Vec<(String, Result<String, String>)> {
    let mut out: Vec<(String, Result<String, String>)> = Vec::new();
    if auto_equip {
        out.push(("equip".to_string(), auto_equip_best(db, api, acc).await));
    }
    if decompose_enabled {
        let res = (async {
            let tiers = load_tiers(db);
            let token = ensure_session(db, api, acc).await?;
            let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
            // 小号爬梯不下地图跑图，标准随等级抬升；主号按实际地图
            let idx = if acc.role == "alt" {
                tier_index_for_alt(&state)
            } else {
                tier_index_for(&state)
            };
            let tier = tiers
                .get(idx)
                .ok_or_else(|| format!("未找到档位模板(idx={idx})"))?;
            auto_decompose_tier(db, api, acc, tier).await
        })
        .await;
        out.push(("decompose".to_string(), res));
    }
    out
}

/// 当前地图对应的档位下标；地图未知返回 None
fn map_tier_index(state: &Value) -> Option<usize> {
    let map = state["player"]["currentMap"]
        .as_str()
        .or_else(|| state["profile"]["currentMap"].as_str())?;
    MAP_TIERS.iter().position(|(k, _, _)| *k == map)
}

/// 等级对应的档位下标（满足等级的最后一档）
fn level_tier_index(state: &Value) -> usize {
    let level = state["player"]["level"]
        .as_i64()
        .or_else(|| state["profile"]["level"].as_i64())
        .unwrap_or(1);
    let mut idx = 0;
    for (i, (_, _, lv)) in MAP_TIERS.iter().enumerate() {
        if level >= *lv {
            idx = i;
        }
    }
    idx
}

/// 按账号当前状态选档位下标：地图优先，地图未知按等级兜底
pub fn tier_index_for(state: &Value) -> usize {
    map_tier_index(state).unwrap_or_else(|| level_tier_index(state))
}

/// 小号专用：爬梯策略不换图（角色可能一直站新手村），分解标准应随等级/爬梯进度抬升，
/// 取"地图档位 vs 等级档位"较高者——否则出现 49 级还按新手村外档分解的问题。
pub fn tier_index_for_alt(state: &Value) -> usize {
    map_tier_index(state).unwrap_or(0).max(level_tier_index(state))
}

/// 品质档位：white=0 … gold=6（套装达标品质）
pub fn quality_rank(q: &str) -> i64 {
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

pub fn quality_label(q: &str) -> String {
    let s = match q {
        "white" => "普通",
        "green" => "优秀",
        "blue" => "精良",
        "purple" => "稀有",
        "orange" => "史诗",
        "red" => "传说",
        "gold" => "神话",
        _ => q,
    };
    s.to_string()
}

/// 稀有度档位：普通装备=0 小极品=1 极品=2 大极品=3（rareRank，与品质独立）
pub fn rare_rank(r: &str) -> i64 {
    match r {
        "小极品" => 1,
        "极品" => 2,
        "大极品" => 3,
        _ => 0,
    }
}

pub fn rare_label(r: &str) -> String {
    let s = match r {
        "普通装备" => "普通",
        "小极品" => "小极品",
        "极品" => "极品",
        "大极品" => "大极品",
        _ => r,
    };
    s.to_string()
}

/// 地图档位表 mapKey → 中文名
pub fn map_name_by_key(key: &str) -> Option<&'static str> {
    MAP_TIERS.iter().find(|(k, _, _)| *k == key).map(|(_, n, _)| *n)
}

/// 自动换装：逐部位把背包里评分更高的可用装备穿上（锁定/等级不达标的跳过，换装失败不阻塞）
/// 绑定优先（设计 §5.2）：同部位先选绑定装备（未绑定是捐赠/市场货源，不往身上焊）；
/// 仅当绑定候选无提升时，才考虑未绑定候选。
pub async fn auto_equip_best(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    let token = ensure_session(db, api, acc).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let level = state["player"]["level"].as_i64().unwrap_or(1);
    let eqs = state
        .get("equipment")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // 每个部位选背包内最佳候选（未锁定、等级达标），绑定/未绑定分开挑
    let mut cand_bound: HashMap<String, (String, f64)> = HashMap::new();
    let mut cand_unbound: HashMap<String, (String, f64)> = HashMap::new();
    for e in &eqs {
        let status = e["status"].as_str().unwrap_or("");
        if status != "in_bag" {
            continue;
        }
        if e["locked"].as_bool().unwrap_or(false) {
            continue;
        }
        if e["level"].as_i64().unwrap_or(i64::MAX) > level {
            continue;
        }
        let slot = e["slot"].as_str().unwrap_or("").to_string();
        if slot.is_empty() {
            continue;
        }
        let sc = e["score"].as_f64().unwrap_or(0.0);
        let map = if e["bindStatus"].as_str() == Some("unbound") {
            &mut cand_unbound
        } else {
            &mut cand_bound
        };
        let cur = map.get(&slot).map(|(_, s)| *s).unwrap_or(0.0);
        if sc > cur {
            map.insert(slot, (e["id"].as_str().unwrap_or("").to_string(), sc));
        }
    }

    let mut changed = 0usize;
    let slots: std::collections::HashSet<&String> = cand_bound.keys().chain(cand_unbound.keys()).collect();
    for slot in slots {
        let worn_score = eqs
            .iter()
            .filter(|e| e["slot"].as_str() == Some(slot.as_str()) && e["status"].as_str() == Some("equipped"))
            .map(|e| e["score"].as_f64().unwrap_or(0.0))
            .fold(0.0, f64::max);
        // 绑定候选优先；绑定无提升才看未绑定候选
        let pick = cand_bound
            .get(slot)
            .filter(|(_, s)| *s > worn_score)
            .or_else(|| cand_unbound.get(slot).filter(|(_, s)| *s > worn_score));
        let Some((cid, _)) = pick else { continue };
        if cid.is_empty() {
            continue;
        }
        if api
            .mutate(&token, "/api/equipment/wear", json!({"equipmentId": cid}))
            .await
            .is_ok()
        {
            changed += 1;
        }
    }
    Ok(format!("自动换装：更换 {changed} 件"))
}

fn qualities_up_to(max: &str) -> Vec<String> {
    let mut out = Vec::new();
    for q in QUALITIES {
        out.push(q.to_string());
        if q == max {
            break;
        }
    }
    out
}

/// 一键分解（按模板档位）：先写服务端规则再执行（评分/稀有词条可配）
pub async fn auto_decompose_tier(
    db: &Mutex<Db>,
    api: &Api,
    acc: &Account,
    tier: &DecomposeTier,
) -> Result<String, String> {
    let token = ensure_session(db, api, acc).await?;
    let score_rule = if tier.keep_score_above > 0 {
        format!(
            "评分<{} 才分解，≥{} 高价值保留",
            tier.keep_score_above, tier.keep_score_above
        )
    } else {
        "评分不限".to_string()
    };
    // 保底评分语义（服务端 keepScoreAbove = "保留评分在此之上"）：传 0 会被解读为"销毁 0 分以下的装备"
    // = 一件都不销毁 → 背包永远清不掉（#48 邮件 400 背包不足的根因）。
    // 0=不限 时改传大保底线：让"品质达标且非稀有词条且等级≤上限"的装备全被回收；
    // 误删风险由 autoRecycleQualities 品质上限 + keepRareAffixes 稀有词条保留 + autoRecycleMaxLevel 三重兜底。
    let keep = if tier.keep_score_above > 0 {
        tier.keep_score_above
    } else {
        1_000_000
    };
    let patch = json!({
        "autoRecycleQualities": qualities_up_to(&tier.max_quality),
        "keepScoreAbove": keep,
        "keepRareAffixes": tier.keep_rare_affixes,
        "autoRecycleMaxLevel": tier.max_level.max(1),
        "autoRecycleProtectedStats": []
    });
    // 先写规则；规则设置失败必须暴露，否则 execute 会按旧/默认规则跑（误销毁或"销毁 0"假成功）
    api.mutate(&token, "/api/equipment/auto-decompose-rules", json!({"patch": patch}))
        .await
        .map_err(|e| format!("设置分解规则失败: {e}"))?;
    let r = api
        .mutate(&token, "/api/equipment/auto-decompose", json!({}))
        .await;
    // "没有符合自动分解条件的装备" = 背包无符合条件装备（无可分解），属于正常状态，
    // 不应记成失败（会触发退避、污染失败统计）
    let r = match r {
        Err(e) if e.to_string().contains("没有符合自动分解条件的装备") => {
            return Ok(format!(
                "按【{}档·{}级起】分解：背包无符合条件装备，无可分解（品质≤{}；{}；稀有{}；等级≤{}）",
                tier.label,
                tier.min_level,
                tier.max_quality,
                score_rule,
                if tier.keep_rare_affixes { "保留" } else { "不保留" },
                tier.max_level
            ));
        }
        other => other,
    };
    let r = r.map_err(|e| e.to_string())?;
    let destroyed = r
        .get("data")
        .and_then(|d| d.get("destroyedCount"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Ok(format!(
        "按【{}档·{}级起】分解：品质≤{}；{}；稀有{}；等级≤{}；销毁 {destroyed}",
        tier.label,
        tier.min_level,
        tier.max_quality,
        score_rule,
        if tier.keep_rare_affixes { "保留" } else { "不保留" },
        tier.max_level
    ))
}

// 让 Value 避免未使用告警（保留给后续增强使用）
#[allow(dead_code)]
fn _unused(v: &Value) -> bool {
    v.is_null()
}