//! 调度器 v2：受限并发（Semaphore）+ 失败退避 + 完整每日流水线（M3–M7 编排）
//! 幂等：runs 表 run_key（北京日/实例）；退避：meta.backoff:{id}:{task}
//! 配置：SchedulerOpts（meta["opts.json"]）运行时热载

use super::api::Api;
use super::auth::{beijing_day, now_ms};
use super::collect::collect_round;
use super::db::{Account, Db, RunRow};
use super::guild;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)] // 旧版 opts.json 缺新字段时用 Default 补齐，热升级不丢配置
pub struct SchedulerOpts {
    pub tick_secs: u64,
    pub concurrency: usize,
    pub req_gap_ms: u64,
    pub idle_adventure_pref: String, // 奇遇偏好：exp=经验优先（默认）| gold=金币 | drop=掉落 | first=第一项
    pub auto_equip: bool,
    pub decompose_enabled: bool,
    pub decompose_init_quality: String,
    pub decompose_ready_quality: String,
    pub decompose_joined_quality: String,
    pub decompose_max_level: i64,
    pub guild_equip_min_quality: String,
    pub equip_donate_min_score: i64,
    pub profession_key: String,
    pub profession_craft: bool,
    pub supply_auto: bool,
    pub join_target_level: i64,
    pub auto_map: bool,
    pub boss_daily: bool,
    pub boss_world: bool,
    pub boss_world_assists: i64,
    pub boss_material_boost: bool,
    pub boss_affix_key: String,
    pub boss_main_target_slot: String, // 大号Boss定向部位（大极品模式；空=自动轮换最差部位）
    pub boss_set_quality: String,      // 套装进度达标品质（默认 精良=blue）
    pub boss_set_rareness: String,     // 套装进度达标稀有度（默认 大极品）
    pub arcade_free: bool,
    pub arcade_paid: bool,
    pub lottery_tickets: i64,
    pub market_internal: bool,
    pub market_price_factor: f64,
    pub market_daily_cap: i64,
    pub growth_enabled: bool,
    pub growth_slots: Vec<String>,
    pub reforge_target_stats: Vec<String>,
    pub reforge_max_per_day: i64,
    pub enhance_protect_from: i64,
    pub enhance_max_per_day: i64,
    pub enhance_inherit_enabled: bool,
    pub growth_stop_quality: i64,
    pub growth_gold_budget: i64,
    pub growth_rare_budget: i64,
    pub guild_enabled: bool,
    pub guild_buy_skill_pages: i64, // 大号每日用基金采购技能残页次数（0=关；一次=15页，2000基金/次）
    pub deny_donate: Vec<String>,
    pub base_url: String,
}

impl Default for SchedulerOpts {
    fn default() -> Self {
        SchedulerOpts {
            tick_secs: 30,
            concurrency: 5,
            req_gap_ms: 800,
            idle_adventure_pref: "exp".into(),
            auto_equip: true,
            decompose_enabled: true,
            decompose_init_quality: "white".into(),
            decompose_ready_quality: "green".into(),
            decompose_joined_quality: "blue".into(),
            decompose_max_level: 999,
            guild_equip_min_quality: "purple".into(),
            equip_donate_min_score: 0,
            profession_key: "herbalism".into(),
            profession_craft: false,
            supply_auto: true,
            join_target_level: 12,
            auto_map: true,
            boss_daily: true,
            boss_world: true,
            boss_world_assists: 3,
            boss_material_boost: true,
            boss_affix_key: "none".into(),
            boss_main_target_slot: "".into(),
            boss_set_quality: "blue".into(),
            boss_set_rareness: "大极品".into(),
            arcade_free: true,
            arcade_paid: false,
            lottery_tickets: 0,
            market_internal: false,
            market_price_factor: 1.0,
            market_daily_cap: 20,
            growth_enabled: false,
            growth_slots: vec!["weapon".into()],
            reforge_target_stats: vec!["crit".into(), "critDamage".into(), "bossDamage".into()],
            reforge_max_per_day: 5,
            enhance_protect_from: 11,
            enhance_max_per_day: 3,
            enhance_inherit_enabled: false,
            growth_stop_quality: 3,
            growth_gold_budget: 50_000,
            growth_rare_budget: 0,
            guild_enabled: true,
            guild_buy_skill_pages: 2, // 默认每日采购 2 次（30 页，基金 4000/天）
            deny_donate: vec![
                "boss_ticket".into(),
                "strengthen_stone".into(),
                "advanced_stone".into(),
                "protect_charm".into(),
            ],
            base_url: super::api::DEFAULT_BASE_URL.into(),
        }
    }
}

impl SchedulerOpts {
    pub fn load(db: &Db) -> Self {
        db.get_meta("opts.json")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<SchedulerOpts>(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, db: &Db) -> Result<(), String> {
        db.set_meta(
            "opts.json",
            &serde_json::to_string(self).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.tick_secs < 10 {
            return Err("调度间隔不能小于 10 秒".into());
        }
        if !(1..=20).contains(&self.concurrency) {
            return Err("并发账号数需在 1-20 之间".into());
        }
        if self.req_gap_ms < 100 {
            return Err("请求间隔下限不能小于 100ms".into());
        }
        if !(0..=10).contains(&self.boss_world_assists) {
            return Err("世界首领每场次数需在 0-10 之间".into());
        }
        if !(0..=100).contains(&self.lottery_tickets) {
            return Err("大乐透每日张数需在 0-100 之间".into());
        }
        if !(0.8..=1.5).contains(&self.market_price_factor) {
            return Err("内部价目系数需在 0.8-1.5 之间".into());
        }
        Ok(())
    }
}

pub struct Shared {
    pub db: Mutex<Db>,
    pub running: AtomicBool,
    pub pass_busy: AtomicBool,
    pub cancel: AtomicBool, // 批量任务取消标志：前端「⏹ 停止」置 true，各批量入口检查后停止分派剩余账号
    pub latest: Mutex<String>,
    pub base_url: String,
    pub api: Api,
    pub opts: RwLock<SchedulerOpts>,
}

// ---------------- 退避 ----------------

fn backoff_key(id: i64, task: &str) -> String {
    format!("backoff:{id}:{task}")
}

fn in_backoff(db: &Db, id: i64, task: &str) -> bool {
    db.get_meta(&backoff_key(id, task))
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .map(|t| t > now_ms())
        .unwrap_or(false)
}

/// 是否还需要进行入会（一次性流程，非每日任务）：
/// - 有未入会的启用小号，且
/// - 公会未满员（memberLimit，如 120）
/// 全员入会或公会满员后均无需再做。
fn alt_pending_join(db: &Mutex<Db>) -> bool {
    let guard = match db.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    // 公会满员检查（guild_info 由 sync_main_meta/刷新公会时写入）
    let info: serde_json::Value = guard
        .get_meta("guild_info")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    let locked = info["memberCount"].as_i64().unwrap_or(0);
    let limit = info["memberLimit"].as_i64().unwrap_or(120);
    if limit > 0 && locked >= limit {
        return false;
    }
    let accounts = guard.list_accounts().unwrap_or_default();
    accounts.iter().any(|a| {
        a.enabled
            && a.role == "alt"
            && guard
                .get_meta(&format!("alt_phase:{}", a.id))
                .ok()
                .flatten()
                .map(|p| p != "joined")
                .unwrap_or(true)
    })
}

pub(crate) async fn record(db: &Mutex<Db>, account_id: i64, task: &str, run_key: &str, res: Result<String, String>) {
    let now = now_ms();
    let (status, detail) = match res {
        Ok(s) => ("ok", s),
        Err(e) => ("failed", e),
    };
    let row = RunRow {
        account_id,
        task: task.into(),
        run_key: run_key.into(),
        status: status.into(),
        detail,
        started_at: now,
        finished_at: now,
    };
    if let Ok(guard) = db.lock() {
        let _ = guard.touch_run(&row, true);
        // 退避：成功清除，失败按次数阶梯退避 1m→5m→15m→1h
        if status == "ok" {
            let _ = guard.set_meta(&backoff_key(account_id, task), "0");
            let _ = guard.set_meta(&format!("backoff_cnt:{account_id}:{task}"), "0");
        } else {
            let cnt = guard
                .get_meta(&format!("backoff_cnt:{account_id}:{task}"))
                .ok()
                .flatten()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0)
                + 1;
            let wait = [60_000i64, 300_000, 900_000, 3_600_000][cnt.min(3) as usize];
            let _ = guard.set_meta(&backoff_key(account_id, task), &(now + wait).to_string());
            let _ = guard.set_meta(&format!("backoff_cnt:{account_id}:{task}"), &cnt.to_string());
        }
    }
}

// ---------------- 每日流水线 ----------------

/// 按 run_key 幂等执行一个可选步骤（退避中则跳过）
macro_rules! step {
    ($db:expr, $id:expr, $task:expr, $run_key:expr, $fut:expr) => {{
        if !in_backoff(&$db.lock().unwrap(), $id, $task) {
            let key = $run_key;
            let already = $db
                .lock()
                .unwrap()
                .get_run($id, $task, &key)
                .ok()
                .flatten()
                .is_some();
            if !already {
                let res = $fut.await;
                record($db, $id, $task, &key, res).await;
            }
        }
    }};
}

/// 世界首领参与：场次窗口内直接遍历**固定世界首领列表**（世界boss定时开放、key 固定，
/// 无需轮询侦测场次），每个 boss 都打满本场次数（每 boss 每场默认 3 次）。
/// 幂等键 = 北京日期#窗口段#bossKey（跨场次自动续）；每账号每 boss 每场次 2 分钟节流。
pub(crate) async fn maybe_world_assist(db: &Mutex<Db>, api: &Api, acc: &Account, opts: &SchedulerOpts) -> String {
    let now = now_ms();
    if !super::boss::world_window_active(now) {
        return "场次外，待机".to_string();
    }
    let session = super::boss::world_session_key(now);
    // 自动参与固定全部场次（10/16/20），不再有场次勾选配置
    // 等级预检：低于 boss 门槛直接跳过（不再打服务端 400"等级不足"）
    let level = db
        .lock()
        .unwrap()
        .get_meta(&format!("alt_level:{}", acc.id))
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let max = opts.boss_world_assists.max(1).clamp(1, 10);
    let mut out: Vec<String> = Vec::new();
    for boss_key in super::boss::WORLD_BOSS_KEYS {
        if level < super::boss::world_boss_required_level(boss_key) {
            continue; // 等级不足，跳过
        }
        if !super::boss::world_boss_participable(db, &session, boss_key) {
            continue; // 已阵亡/已结束/未开始，跳过（不再让全员尝试）
        }
        let iid = format!("{session}#{boss_key}");
        let done_key = format!("world_done:{}:{}", acc.id, iid);
        let done = db
            .lock()
            .unwrap()
            .get_meta(&done_key)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if done >= max {
            continue; // 该 boss 本场已打满 3 次
        }
        // 节流：每账号每 boss 每场次 2 分钟尝试一次（避免打满后反复请求）
        let last_key = format!("w_last:{}:{}", acc.id, iid);
        let last = db
            .lock()
            .unwrap()
            .get_meta(&last_key)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if now - last < 120_000 {
            continue;
        }
        let _ = db.lock().unwrap().set_meta(&last_key, &now.to_string());
        let res = super::boss::world_assist(db, api, acc, boss_key, &iid, max).await;
        let txt = match &res {
            Ok(s) => s.clone(),
            Err(e) => e.clone(),
        };
        // 已结束/已击败的状态由 world_assist 内部从响应/报错记录，这里只写日志
        record(db, acc.id, "boss_world", &format!("boss_world:{iid}"), res).await;
        out.push(format!("{boss_key}:{txt}"));
    }
    if out.is_empty() {
        "本场参与完毕".to_string()
    } else {
        out.join("；")
    }
}

async fn process_account(shared: &Shared, opts: &SchedulerOpts, api: &Api, acc: &Account) -> String {
    let today = beijing_day(now_ms());
    let db = &shared.db;

    // ---- 通用每日收菜（邮件/签到/活跃/成就/挂机收益）----
    let daily_key = format!("daily:{today}");
    let done_daily = {
        let guard = db.lock().unwrap();
        guard.get_run(acc.id, "collect", &daily_key).ok().flatten().is_some()
    };

    if acc.role == "main" {
        // 0) 背包预清理：换装 + 按 9 档模板分解（每次收菜都做，防背包占满领不了邮件）
        for (t, res) in super::equip::pre_clean_bag(db, api, acc, opts.auto_equip, opts.decompose_enabled).await {
            record(db, acc.id, &t, &format!("{t}:{}", now_ms() / 1000), res).await;
        }
        // 公会/角色识别不是日常操作：添加大号时识别一次 + 公会页手动「刷新公会」。
        // 手动收菜模式：每天首次完整收菜（含签到/活跃），之后重复点只领收益+刷新快照
        //（服务端幂等，重复领取自动忽略）。
        if !done_daily {
            let res = collect_round(db, api, acc, true).await;
            record(db, acc.id, "collect", &daily_key, super::collect::collect_result_ok(res)).await;
        } else {
            let res = collect_round(db, api, acc, false).await;
            record(db, acc.id, "collect_idle", &format!("idle:{}", now_ms() / 1000), res).await;
        }
        // 3) 副职业循环
        step!(db, acc.id, "prof", format!("prof:{today}"), super::profession::professions_loop(db, api, acc, opts));
        // 4) 大号养成（默认关）
        step!(db, acc.id, "growth", format!("growth:{today}"), super::reforge::growth_main(db, api, acc, opts));
        // 5) 公会审批 + 分红
        if opts.guild_enabled {
            let gid = {
                let guard = db.lock().unwrap();
                guild::main_guild_id(&guard).unwrap_or_default()
            };
            if !gid.is_empty() {
                // 审批入会：一次性流程，不是每日任务。只在还有未入会小号时每 2 分钟放行；
                // 全员入会（或公会满 120 人达标）后彻底停止轮询。
                if alt_pending_join(db) {
                    let last_a = db.lock().unwrap().get_meta("guild_approve_last").ok().flatten().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                    if now_ms() - last_a >= 120_000 {
                        let _ = db.lock().unwrap().set_meta("guild_approve_last", &now_ms().to_string());
                        let res = guild::main_approve_all(db, api, acc)
                            .await
                            .map(|n| format!("审批 {n} 个申请"));
                        record(db, acc.id, "guild_approve", &format!("guild_approve:{today}"), res).await;
                    }
                } else {
                    // 全员已入会：一次性收尾标记（只写一次），入会审批彻底关闭
                    let done = db.lock().unwrap().get_meta("guild_onboard_done").ok().flatten().map(|v| v == "1").unwrap_or(false);
                    if !done {
                        let _ = db.lock().unwrap().set_meta("guild_onboard_done", "1");
                    }
                }
                // 分红：每日一次
                step!(db, acc.id, "guild_dividend", format!("guild_dividend:{today}"), async {
                    guild::main_claim_dividend(db, api, acc).await?;
                    Ok("分红已领取".into())
                });
                // 公会宝箱（捐献进度里程碑）：每日一次，可领档位全领
                step!(db, acc.id, "guild_chest", format!("guild_chest:{today}"), async {
                    guild::main_claim_progress(db, api, acc).await
                });
                // 技能残页采购：用公会基金买 skill 补给 → 仓库，供小号缺页时 redeem（每日，可配）
                step!(db, acc.id, "guild_supply", format!("guild_supply:{today}"), async {
                    super::skills::purchase_skill_pages(db, api, acc, opts.guild_buy_skill_pages).await
                });
            }
        }
        // 6) 每日个人/地图首领（大号：评分裕量带词缀策略，affix_key 可配；设计 §5.7）
        if opts.boss_daily {
            let affix = opts.boss_affix_key.clone();
            step!(db, acc.id, "boss_solo", format!("boss_solo:{today}"), super::boss::boss_solo_daily(db, api, acc, opts.boss_material_boost, &affix, Some(opts.boss_main_target_slot.as_str()), &opts.boss_set_quality, &opts.boss_set_rareness));
        }
        // 6b) 世界首领：定时开放、key 固定，不轮询侦测——场次窗口内直接参与固定列表
        if opts.boss_world {
            let line = maybe_world_assist(db, api, acc, opts).await;
            let _ = line;
        }
        // 6b2) 首领奖励领取（个人/地图/世界首领结算后领奖，每人每天一次）
        if opts.boss_daily || opts.boss_world {
            step!(db, acc.id, "boss_claim", format!("boss_claim:{today}"), super::boss::claim_boss_rewards(db, api, acc));
        }
        // 6b3) 首领领奖后换装：boss 掉落/领奖可能出更高评分装备，立即穿上（独立幂等键，当天一次）
        if opts.auto_equip {
            step!(db, acc.id, "equip_boss", format!("equip_boss:{today}"), super::equip::auto_equip_best(db, api, acc));
        }
        // 6c) 换图判断并入收菜轮：每次收菜检查能否进更优图（挂机游戏，不设频率节流）
        if opts.auto_map {
            let res = async {
                let token = super::auth::ensure_session(db, api, acc).await?;
                let map = guild::change_best_map(api, &token).await?;
                Ok(format!("换图:{map}"))
            }
            .await;
            record(db, acc.id, "map", &format!("map:{}", now_ms() / 60_000), res).await;
        }
        // 7) 内部市场（默认关）
        step!(db, acc.id, "market", format!("market:{today}"), super::market::market_internal_loop(db, api, acc, opts));
        // 7) 街机免费轮 + 大乐透
        if opts.arcade_free || opts.arcade_paid {
            step!(db, acc.id, "arcade", format!("arcade:{today}"), super::arcade::arcade_free(db, api, acc));
        }
        if opts.lottery_tickets > 0 {
            let n = opts.lottery_tickets;
            step!(db, acc.id, "lottery", format!("lottery:{today}"), super::arcade::lottery_buy(db, api, acc, n));
        }
        return format!("main#{} done", acc.id);
    }

    // ---- 小号 ----
    if !opts.guild_enabled {
        return format!("alt#{} 公会协同未开启", acc.id);
    }

    let phase = db
        .lock()
        .unwrap()
        .get_meta(&format!("alt_phase:{}", acc.id))
        .ok()
        .flatten()
        .unwrap_or_default();

    // 阶段推进判断（设计 §5.1 顺序：收菜→副职业→换装→捐赠→分解→换图→Boss→街机→大乐透→市场）
    let guild_id = {
        let guard = db.lock().unwrap();
        guild::main_guild_id(&guard).unwrap_or_default()
    };

    // 0) 背包预清理（必须在领邮件/挂机收益之前）：先换装（绑定优先），再按**当前地图档位模板**分解，
    //    腾出背包空间，避免"背包空间不足"导致邮件/收益领取失败。每次收菜都做（不按日幂等）。
    // 0.5) 新号建角色必须最先做：collect/equip 等角色级接口在无角色时全部 400"请先创建角色"，
    //     且 ensure_character 失败必须保持 phase=""（下次重试），不能吞错后照常推进到 init
    //     ——否则角色没建成、phase 却定格 init，永远不再建（曾导致 #113/114/115 收菜全失败）。
    if phase.is_empty() {
        match guild::ensure_character(db, api, acc).await {
            Ok(created) => {
                if created {
                    record(db, acc.id, "char", &format!("char:{}", now_ms() / 1000), Ok("已创建角色".into())).await;
                }
                let _ = db.lock().unwrap().set_meta(&format!("alt_phase:{}", acc.id), "init");
            }
            Err(e) => {
                // 建角色失败：保持 phase=""（下次自动重试），本轮的 collect 会因无角色报错，
                // 记录明确错误而不是静默吞掉。
                record(db, acc.id, "char", &format!("char:{}", now_ms() / 1000), Err(format!("建角色失败:{e}"))).await;
            }
        }
    }
    for (t, res) in super::equip::pre_clean_bag(db, api, acc, opts.auto_equip, opts.decompose_enabled).await {
        record(db, acc.id, &t, &format!("{t}:{}", now_ms() / 1000), res).await;
    }

    // 1) 收菜（领邮件/签到/活跃/成就/挂机收益 + 本地快照）—— 背包已腾出空间
    if !done_daily {
        let res = collect_round(db, api, acc, true).await;
        record(db, acc.id, "collect", &daily_key, super::collect::collect_result_ok(res)).await;
    } else {
        // 手动收菜模式：今天已完整收过，重复点仍领挂机收益+刷新本地快照（服务端幂等）
        let res = collect_round(db, api, acc, false).await;
        record(db, acc.id, "collect_idle", &format!("idle:{}", now_ms() / 1000), res).await;
    }

    // 2) 副职业循环
    step!(db, acc.id, "prof", format!("prof:{today}"), super::profession::professions_loop(db, api, acc, opts));
    // 3) 阶段推进 + 入会后的捐献链（必须在分解之前，防误销硬约束）
    //    建角色已在最前面处理（phase="" → init）；这里 "" 只会出现在"建角色失败"的当轮，跳过等重试。
    let phase_line = match phase.as_str() {
        "" => "角色初始化失败，等待重试".to_string(),
        "init" => {
            // 练级并入收菜：挂机游戏不设练级频率，每次收菜轮顺带收一次挂机经验/推进等级
            let res = guild::level_once(db, api, acc, opts.join_target_level).await;
            record(db, acc.id, "level", &format!("level:{}", now_ms() / 1000), res).await;
            "练级中".to_string()
        }
        "ready" => {
            if !guild_id.is_empty() && !in_backoff(&db.lock().unwrap(), acc.id, "join") {
                // 入会：退避重试直到成功（申请未生效/需审批时不会当天锁死）
                let res = guild::alt_join(db, api, acc, &guild_id).await;
                let key = format!("join:{today}");
                match res {
                    Ok(true) => {
                        let _ = db.lock().unwrap().set_meta(&format!("alt_phase:{}", acc.id), "joined");
                        record(db, acc.id, "join", &key, Ok("已入会".into())).await;
                    }
                    Ok(false) => {
                        record(db, acc.id, "join", &key, Err("申请未生效（待审批或需审核）".to_string())).await;
                    }
                    Err(e) => {
                        record(db, acc.id, "join", &key, Err(e.clone())).await;
                        // 服务端/网络类瞬时错误（502/网络/连接/版本过低/超时）不按 join 长退避，
                        // 压到 90 秒短退避尽快重试——避免"游戏里已入会、本地因请求失败卡在 ready"的情况
                        let msg = e.to_string();
                        if msg.contains("502") || msg.contains("网络") || msg.contains("连接")
                            || msg.contains("版本过低") || msg.contains("超时")
                        {
                            let _ = db
                                .lock()
                                .unwrap()
                                .set_meta(&backoff_key(acc.id, "join"), &(now_ms() + 90_000).to_string());
                        }
                    }
                }
            }
            "入会".to_string()
        }
        "joined" => {
            // 持续练级：小号没有目标等级上限，入会后继续无限升级产出（挂机游戏，练级并入收菜轮）
            let res = guild::level_once(db, api, acc, i64::MAX).await;
            record(db, acc.id, "level", &format!("level:{}", now_ms() / 1000), res).await;
            // 1) 技能自动学习（先于捐献：用掉自己的书/页；缺页先从公会仓库 redeem）
            step!(db, acc.id, "skills", format!("skills:{today}"), super::skills::skills_loop(db, api, acc));
            // 材料捐献（未绑定材料；技能残页保留自用）
            step!(db, acc.id, "donate", format!("donate:{today}"), async {
                let deny = opts.deny_donate.clone();
                let n = guild::alt_donate(db, api, acc, &deny).await?;
                Ok(format!("捐献 {n} 种材料"))
            });
            // 公会宝箱（个人捐献进度里程碑 30/60/90/120，每人独立可领；先捐献后领，幂等）
            step!(db, acc.id, "guild_chest", format!("guild_chest:{today}"), async {
                guild::main_claim_progress(db, api, acc).await
            });
            // 装备捐献（条件触发：仅捐评分 ≥ equip_donate_min_score 的达标装备，不是每日必做）
            let min_q = opts.guild_equip_min_quality.clone();
            let min_score = opts.equip_donate_min_score;
            step!(db, acc.id, "equip_donate", format!("equip_donate:{today}"), async {
                let n = guild::alt_equip_donate(db, api, acc, &min_q, min_score).await?;
                Ok(format!("装备捐仓 {n} 件"))
            });
            "已入会，持续练级+捐献".to_string()
        }
        other => format!("未知阶段 {other}"),
    };
    // 5) 换图并入收菜练级：level_once 内部已做 change_best_map（练级时顺带切更优图），
    //    不再单独设换图检查（挂机游戏，无频率设定）
    // 7) 每日个人/地图首领（小号：材料加成+35% farm 定位，不带词缀；设计 §5.7）
    if opts.boss_daily {
        step!(db, acc.id, "boss_solo", format!("boss_solo:{today}"), super::boss::boss_solo_daily(db, api, acc, true, "none", None, &opts.boss_set_quality, &opts.boss_set_rareness));
    }
    // 7b) 世界首领定时参与（独立于 boss_daily，场次窗口内直接打固定列表）
    if opts.boss_world {
        let _ = maybe_world_assist(db, api, acc, opts).await;
    }
    // 7c) 首领奖励领取（个人/地图/世界首领结算后领奖，每人每天一次）
    if opts.boss_daily || opts.boss_world {
        step!(db, acc.id, "boss_claim", format!("boss_claim:{today}"), super::boss::claim_boss_rewards(db, api, acc));
    }
    // 7c2) 首领领奖后换装：boss 掉落/领奖可能出更高评分装备，立即穿上（独立幂等键，当天一次）
    if opts.auto_equip {
        step!(db, acc.id, "equip_boss", format!("equip_boss:{today}"), super::equip::auto_equip_best(db, api, acc));
    }
    // 8) 街机免费轮
    if opts.arcade_free {
        step!(db, acc.id, "arcade", format!("arcade:{today}"), super::arcade::arcade_free(db, api, acc));
    }
    // 9) 大乐透（可选）
    if opts.lottery_tickets > 0 {
        let n = opts.lottery_tickets;
        step!(db, acc.id, "lottery", format!("lottery:{today}"), super::arcade::lottery_buy(db, api, acc, n));
    }
    // 10) 内部市场（小号侧：交付大号求购/溢出挂单/超时撤单）
    step!(db, acc.id, "market", format!("market:{today}"), super::market::market_internal_loop(db, api, acc, opts));
    format!("alt#{} {}", acc.id, phase_line)
}

// ---------------- 单遍处理：受限并发 ----------------

/// 批量执行互斥守卫：所有批量入口（one_pass / run_task_batch / donate_round / run_collect 等）
/// 共用 pass_busy，防止两个批量任务叠加打到同一批账号（重复请求/重复操作，风控风险）。
/// drop 时自动释放，即使任务中途 panic 也不会永久锁死。
pub struct PassGuard {
    state: Arc<Shared>,
}

impl Drop for PassGuard {
    fn drop(&mut self) {
        self.state.pass_busy.store(false, Ordering::SeqCst);
    }
}

pub fn acquire_pass(shared: &Arc<Shared>) -> Result<PassGuard, String> {
    if shared
        .pass_busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("另一批任务正在执行，请等待完成后再试".into());
    }
    Ok(PassGuard {
        state: shared.clone(),
    })
}

pub async fn one_pass(shared: &Arc<Shared>, api: &Api, opts: &SchedulerOpts) -> Vec<String> {
    let _pass = match acquire_pass(shared) {
        Ok(p) => p,
        Err(_) => return vec!["上一轮处理尚未结束".into()],
    };
    let accounts = shared
        .db
        .lock()
        .unwrap()
        .list_accounts()
        .unwrap_or_default();
    let sem = Arc::new(tokio::sync::Semaphore::new(opts.concurrency.max(1)));
    let mut set = tokio::task::JoinSet::new();
    shared.cancel.store(false, Ordering::SeqCst); // 新一批复位
    for acc in &accounts {
        if shared.cancel.load(Ordering::SeqCst) {
            break; // 已点「停止」，不再分派剩余号
        }
        if !acc.enabled {
            continue;
        }
        // 每账号启动错峰（req_gap_ms，模拟真人节奏）
        tokio::time::sleep(std::time::Duration::from_millis(opts.req_gap_ms)).await;
        let shared = shared.clone();
        let api = api.clone();
        let opts = opts.clone();
        let acc = acc.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return "信号量已关闭".to_string(),
            };
            process_account(&shared, &opts, &api, &acc).await
        });
    }
    let mut out: Vec<String> = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(line) = res {
            out.push(line);
        }
    }
    // pass_busy 由 PassGuard drop 释放（panic 也不会锁死）
    if let Ok(mut guard) = shared.latest.lock() {
        *guard = json!({"tick": now_ms(), "items": out}).to_string();
    }
    out
}

pub fn spawn(app: AppHandle, shared: Arc<Shared>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let opts = shared.opts.read().unwrap().clone();
            // 挂机练级游戏：不需要循环调度。后台只保留世界 boss 定时参与
            //（场次窗口内自动打固定列表；其余动作全部在手动「收菜」时一次性处理）。
            // 每 10 秒醒来一次，内部靠场次窗口 + w_last 节流兜底频率。
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if !shared.running.load(Ordering::SeqCst) {
                continue;
            }
            if !opts.boss_world {
                continue;
            }
            let api = shared.api.clone();
            let out = world_pass(&shared, &api, &opts).await;
            if !out.is_empty() {
                let _ = app.emit("scheduler-tick", json!({"items": out}));
            }
        }
    });
}

/// 世界 boss 定时中枢：只在场次窗口内运行（全员自动参与固定世界首领列表）。
/// 场次窗口：北京时间 10-11 / 16-17 / 20-21（含前后 15 分钟缓冲）。
/// 场次外完全待机：零请求、不写日志。
pub(crate) async fn world_pass(shared: &Arc<Shared>, api: &Api, opts: &SchedulerOpts) -> Vec<String> {
    if !super::boss::world_window_active(super::auth::now_ms()) {
        return Vec::new(); // 场次外待机
    }
    let accounts = shared
        .db
        .lock()
        .unwrap()
        .list_accounts()
        .unwrap_or_default();
    // 参与方式：**每个号独立跑完它可参加的全部 boss**（maybe_world_assist 内按 WORLD_BOSS_KEYS
    // 顺序遍历）；账号间用 semaphore 并发（concurrency 上限），不再按 boss 维度聚合。
    // 节流：每号每 boss 每场 2 分钟（w_last），打满即停；已完成的号快速跳过、不发请求。
    let sem = Arc::new(tokio::sync::Semaphore::new(opts.concurrency.max(1)));
    let mut set = tokio::task::JoinSet::new();
    for acc in accounts.iter().filter(|a| a.enabled) {
        tokio::time::sleep(std::time::Duration::from_millis(opts.req_gap_ms)).await;
        let shared = shared.clone();
        let api = api.clone();
        let opts = opts.clone();
        let acc = acc.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return String::new(),
            };
            maybe_world_assist(&shared.db, &api, &acc, &opts).await
        });
    }
    let mut out: Vec<String> = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(line) = res {
            if !line.is_empty() {
                out.push(line);
            }
        }
    }
    out
}