//! PlaceGame VIP 收菜客户端 —— Tauri v2 入口
//! 本机 SQLite + Rust 引擎 + 极简 Web UI（无需 Node 打包器）

pub mod engine;

use engine::api::Api;
use engine::auth::{create_guest, login_or_create_main, new_device_id, promote_alt, register_alt, register_or_create_main};
use engine::collect::collect_round;
use engine::db::{Account, Db};
use engine::scheduler::{one_pass, spawn, Shared, SchedulerOpts};
use serde_json::json;
use std::sync::Arc;
use tauri::{Manager, State};

fn build_api(state: &Arc<Shared>) -> Api {
    state.api.clone()
}

// ---------------- commands ----------------

#[tauri::command]
fn get_status(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let (running, base_url, main_guild_id, latest) = {
        let guard = state.db.lock().unwrap();
        let gid = engine::guild::main_guild_id(&guard).unwrap_or_default();
        let latest = state.latest.lock().unwrap().clone();
        (state.running.load(std::sync::atomic::Ordering::SeqCst), state.base_url.clone(), gid, latest)
    };
    let accounts = {
        let guard = state.db.lock().unwrap();
        guard.list_accounts().map_err(|e| e.to_string())?
    };
    let _ = (running, base_url);
    let opts = state.opts.read().unwrap().clone();
    // 与 list_accounts 一致：为每个账号补 phase / level（阶段存于 meta，Account 结构体本身没有）
    let accounts_json: Vec<serde_json::Value> = {
        let guard = state.db.lock().unwrap();
        accounts
            .iter()
            .map(|a| {
                let phase = guard
                    .get_meta(&format!("alt_phase:{}", a.id))
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                json!({
                    "id": a.id,
                    "role": a.role,
                    "username": a.username,
                    "nickname": a.nickname,
                    "job": a.job,
                    "enabled": a.enabled,
                    "phase": phase,
                    "level": guard.get_meta(&format!("alt_level:{}", a.id)).ok().flatten().unwrap_or_default(),
                })
            })
            .collect()
    };
    Ok(json!({
        "running": state.running.load(std::sync::atomic::Ordering::SeqCst),
        "main_guild_id": main_guild_id,
        "latest": latest,
        "accounts": accounts_json,
        "opts": opts,
        "world_window": engine::boss::world_window_active(engine::auth::now_ms()),
    }))
}

#[tauri::command]
fn list_accounts(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let guard = state.db.lock().unwrap();
    let accounts = guard.list_accounts().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for a in &accounts {
        let phase = guard
            .get_meta(&format!("alt_phase:{}", a.id))
            .ok()
            .flatten()
            .unwrap_or_default();
        out.push(json!({
            "id": a.id,
            "role": a.role,
            "username": a.username,
            "nickname": a.nickname,
            "job": a.job,
            "enabled": a.enabled,
            "has_session": a.session_token.is_some(),
            "phase": phase,
            "level": guard.get_meta(&format!("alt_level:{}", a.id)).ok().flatten().unwrap_or_default(),
            "user_id": a.user_id,
        }));
    }
    Ok(json!(out))
}

#[tauri::command]
async fn add_main(
    state: State<'_, Arc<Shared>>,
    username: String,
    password: String,
) -> Result<i64, String> {
    let api = build_api(&state);
    let id = login_or_create_main(&state.db, &api, &username, &password).await?;
    // 添加大号后一次性识别：回读角色职业/昵称 + 记录已建公会（非日常操作，仅此处与手动刷新时执行）
    let acc = {
        let guard = state.db.lock().unwrap();
        guard.get_account(id).ok().flatten()
    };
    if let Some(acc) = acc {
        let _ = engine::guild::sync_main_meta(&state.db, &api, &acc).await;
    }
    Ok(id)
}

#[tauri::command]
async fn register_main(
    state: State<'_, Arc<Shared>>,
    username: String,
    password: String,
) -> Result<i64, String> {
    let api = build_api(&state);
    let id = register_or_create_main(&state.db, &api, &username, &password).await?;
    let acc = {
        let guard = state.db.lock().unwrap();
        guard.get_account(id).ok().flatten()
    };
    if let Some(acc) = acc {
        let _ = engine::guild::sync_main_meta(&state.db, &api, &acc).await;
    }
    Ok(id)
}

#[tauri::command]
async fn add_alts(
    state: State<'_, Arc<Shared>>,
    count: i64,
    job: String,
    account_type: String,
) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let job = if job.trim().is_empty() { "warrior" } else { job.trim() };
    let formal = account_type != "guest";
    // 注册保持顺序执行（批量注册有风控因素，不并发、逐个注册更稳）
    let mut created = 0i64;
    let mut failed = 0i64;
    let mut errors: Vec<String> = Vec::new();
    let max = count.min(300).max(0);
    for _ in 0..max {
        let res = if formal {
            register_alt(&state.db, &api, job).await
        } else {
            create_guest(&state.db, &api, "alt", job).await
        };
        match res {
            Ok(_) => created += 1,
            Err(e) => {
                failed += 1;
                if errors.len() < 5 {
                    errors.push(e);
                }
            }
        }
    }
    Ok(json!({"created": created, "failed": failed, "errors": errors, "type": if formal {"formal"} else {"guest"}}))
}

/// 试玩小号转正式账户（reset-credentials 已实测）
#[tauri::command]
async fn promote_guest(
    state: State<'_, Arc<Shared>>,
    account_id: i64,
    username: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let acc = {
        let guard = state.db.lock().unwrap();
        guard
            .get_account(account_id)
            .map_err(|e| e.to_string())?
            .ok_or("账号不存在")?
    };
    let (u, p) = promote_alt(&state.db, &api, &acc, &username, &password).await?;
    Ok(json!({"username": u, "password": p}))
}

/// 打开该号的游戏网页（默认浏览器），并返回账号密码供前端展示/复制。
/// 打开前先调用登录接口校验凭证，避免"网页里登录失败"无法诊断。
#[tauri::command]
async fn open_web_login(
    state: State<'_, Arc<Shared>>,
    account_id: i64,
) -> Result<serde_json::Value, String> {
    let acc = {
        let guard = state.db.lock().unwrap();
        guard
            .get_account(account_id)
            .map_err(|e| e.to_string())?
            .ok_or("账号不存在")?
    };
    let api = build_api(&state);
    // 先用服务端校验：凭证对则返回 ok；不对则把服务端错误直接暴露（如 账号或密码错误）
    let check = api
        .request(engine::api::Req {
            method: "POST",
            path: "/api/auth/login".into(),
            body: Some(serde_json::json!({"username": acc.username, "password": acc.password})),
            token: None,
            response_state: "full",
            timeout_secs: 20,
        })
        .await;
    match check {
        Ok(_) => {
            let url = state.base_url.clone();
            let _ = std::process::Command::new("open").arg(&url).spawn();
            Ok(serde_json::json!({
                "url": url,
                "username": acc.username,
                "password": acc.password,
                "verified": true,
            }))
        }
        Err(e) => Err(format!(
            "该账号在服务端校验失败：{e}。若密码已改，请到账号页对该号重新登录/删除后重加，或转正后使用新密码。"
        )),
    }
}

fn first_main(state: &Arc<Shared>) -> Result<engine::db::Account, String> {
    let guard = state.db.lock().unwrap();
    guard
        .mains()
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| "还没有主账号，请先添加大号".to_string())
}

/// 免复制直登：在客户端内嵌窗口打开游戏网页，直接注入该号会话 token + 设备指纹（无需复制密码）
#[tauri::command]
async fn open_web_direct(
    app: tauri::AppHandle,
    state: State<'_, Arc<Shared>>,
    account_id: i64,
) -> Result<(), String> {
    let acc = {
        let guard = state.db.lock().unwrap();
        guard
            .get_account(account_id)
            .map_err(|e| e.to_string())?
            .ok_or("账号不存在")?
    };
    let api = build_api(&state);
    // 确保拿到有效会话（过期自动用本地凭证重登）
    let token = engine::auth::ensure_session(&state.db, &api, &acc).await?;
    api.request(engine::api::Req {
        method: "GET",
        path: "/api/users/list".into(),
        body: None,
        token: Some(&token),
        response_state: "omit",
        timeout_secs: 10,
    })
    .await
    .map_err(|e| format!("会话校验失败：{e}"))?;
    let device_id = state
        .db
        .lock()
        .unwrap()
        .get_meta("device_id")
        .ok()
        .flatten()
        .unwrap_or_default();

    let label = format!("pgweb_{account_id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let parsed: url::Url = state
        .base_url
        .parse()
        .map_err(|e: url::ParseError| format!("URL 解析失败: {e}"))?;
    // 网页启动脚本：写入游戏前端读取的会话 localStorage key（已逆向确认 key 名）
    let script = format!(
        "localStorage.setItem('place-game-session-token', {:?}); localStorage.setItem('place-game-device-id', {:?});",
        token, device_id
    );
    let win = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(parsed))
        .title(format!("{} 游戏网页（自动登录）", acc.nickname))
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.show();
    Ok(())
}

/// 公会页批量审批：大号同意所有待入会申请（手动触发；入会为一次性流程）。
/// 返回 {approved, pending_before, names}：本次审批数 / 审批前待审批总数 / 被审批昵称列表。
#[tauri::command]
async fn approve_all(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    // 先取待审批名单（/api/guild/view）
    let pending = engine::guild::pending_applications(&state.db, &api, &main).await?;
    let before = pending.len();
    let names: Vec<String> = pending
        .iter()
        .filter_map(|a| a["nickname"].as_str().map(|s| s.to_string()))
        .collect();
    let mut g = engine::guild::main_approve_all(&state.db, &api, &main).await;
    if let Err(e) = &g {
        if e.contains("会话无效") || e.contains("已过期") {
            if engine::auth::force_relogin(&state.db, &api, &main).await.is_ok() {
                g = engine::guild::main_approve_all(&state.db, &api, &main).await;
            }
        }
    }
    let approved = g.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "approved": approved, "pending_before": before, "names": names }))
}

/// 世界boss 页：每个世界首领的参与进度（等级门槛/场次状态/可参与/已参与 + 本地全员聚合）
#[tauri::command]
async fn get_world_boss_stats(state: State<'_, Arc<Shared>>, session: Option<String>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    engine::boss::world_boss_stats(&state.db, &api, &main, session.as_deref()).await
}

/// 个人/地图首领统计（Boss统计页）：boss 列表（主号 bosses 段样本）+ 今日实际击杀/参与号数/最高难度（本地聚合）
#[tauri::command]
async fn get_solo_boss_stats(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    use std::collections::HashMap;
    let api = build_api(&state);
    let main = first_main(&state)?;
    let token = engine::auth::ensure_session(&state.db, &api, &main).await?;
    let secs = api.view_sections(&token, &["bosses"]).await.map_err(|e| e.to_string())?;
    let bosses = secs.get("bosses").cloned().unwrap_or(json!([]));
    let day = engine::auth::beijing_day(engine::auth::now_ms());
    let accounts = {
        let guard = state.db.lock().unwrap();
        guard.list_accounts().map_err(|e| e.to_string())?
    };
    // 今日实际击杀（boss_kills:{id}:{day} = {boss_key: n}）聚合 + 参与号数
    let mut kills: HashMap<String, i64> = HashMap::new();
    let mut actives: HashMap<String, i64> = HashMap::new();
    for a in accounts.iter().filter(|a| a.enabled) {
        let meta = {
            let guard = state.db.lock().unwrap();
            guard
                .get_meta(&format!("boss_kills:{}:{}", a.id, day))
                .ok()
                .flatten()
                .unwrap_or_default()
        };
        if let Ok(map) = serde_json::from_str::<HashMap<String, i64>>(&meta) {
            for (k, v) in map {
                *kills.entry(k.clone()).or_insert(0) += v;
                *actives.entry(k).or_insert(0) += 1;
            }
        }
    }
    // 最高打过难度（跨账号聚合 get_boss_progress 的 idx）
    let mut max_diff: HashMap<String, i64> = HashMap::new();
    for a in accounts.iter().filter(|a| a.enabled) {
        if let Ok(prog) = state.db.lock().unwrap().get_boss_progress(a.id) {
            for (bk, _dk, idx, _st, _sl) in prog {
                let cur = max_diff.entry(bk).or_insert(-1);
                *cur = (*cur).max(idx);
            }
        }
    }
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = bosses.as_array() {
        for b in arr {
            let t = b["type"].as_str().unwrap_or("");
            if t != "personal" && t != "map" {
                continue;
            }
            let key = b["key"].as_str().unwrap_or("").to_string();
            let opts = b["difficultyOptions"].as_array().cloned().unwrap_or_default();
            let free = b["personalAttemptPool"]["freeRemaining"].as_i64().unwrap_or(1).max(0);
            let mi = max_diff.get(&key).copied().unwrap_or(-1);
            let highest_diff = if mi >= 0 {
                opts.get(mi as usize).and_then(|o| o["key"].as_str()).unwrap_or("").to_string()
            } else {
                String::new()
            };
            out.push(json!({
                "key": key,
                "name": b["name"].as_str().unwrap_or(&key),
                "map": b["mapName"].as_str().or_else(|| b["mapKey"].as_str()).unwrap_or(""),
                "type": t,
                "requiredPower": b["requiredPower"].as_i64().unwrap_or(0),
                "diff_count": opts.len() as i64,
                "highest_diff": highest_diff,
                "free": free,
                "kills": kills.get(&key).copied().unwrap_or(0),
                "accounts": actives.get(&key).copied().unwrap_or(0),
            }));
        }
    }
    out.sort_by(|a, b| {
        b["requiredPower"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["requiredPower"].as_i64().unwrap_or(0))
    });
    Ok(json!({ "day": day, "bosses": out }))
}

/// 用主号 guild/view 的成员 userId 名单校准本地 alt_phase：
/// 游戏里已入会（名单里）的小号，本地阶段直接翻成 joined（不依赖每个小号自证，绕开 bootstrap 502/退避卡死）
fn sync_joined_from_members(state: &State<'_, Arc<Shared>>, g: &serde_json::Value) {
    let Some(members) = g.get("members").and_then(|v| v.as_array()) else { return };
    let mut member_uids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in members {
        if let Some(uid) = m["userId"].as_str() {
            member_uids.insert(uid.to_string());
        }
    }
    if member_uids.is_empty() {
        return;
    }
    let guard = state.db.lock().unwrap();
    if let Ok(accounts) = guard.list_accounts() {
        for a in accounts.iter().filter(|a| a.enabled && a.role == "alt" && member_uids.contains(&a.user_id)) {
            let key = format!("alt_phase:{}", a.id);
            let cur = guard.get_meta(&key).ok().flatten().unwrap_or_default();
            if cur != "joined" {
                let _ = guard.set_meta(&key, "joined");
            }
        }
    }
}

/// 公会页：拉公会信息（含需求报表/仓库/审核），顺带自动识别游戏内已建公会
#[tauri::command]
async fn get_guild_info(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    // 会话过期时自动重登一次再试，避免用户手动重新登录
    let mut g = engine::guild::fetch_guild_info(&state.db, &api, &main).await;
    if let Err(e) = &g {
        if e.contains("会话无效") || e.contains("已过期") {
            if engine::auth::force_relogin(&state.db, &api, &main).await.is_ok() {
                g = engine::guild::fetch_guild_info(&state.db, &api, &main).await;
            }
        }
    }
    let g = g?;
    // 主号成员名单校准本地 joined（游戏里已入会的小号，本地阶段直接翻 joined）
    sync_joined_from_members(&state, &g);
    let joined = g["joined"].as_bool().unwrap_or(false);
    let today = engine::auth::beijing_day(engine::auth::now_ms());
    // 分母 = 本地已入会(joined) 且启用的 alt 数；分子 = 今日成功执行捐献的去重账号数
    // （SQL 直查 runs，不再被 recent_runs 1000 条窗口截断）
    let (total, ok_materials, ok_equip) = {
        let guard = state.db.lock().unwrap();
        let joined_alts = guard
            .list_accounts()
            .unwrap_or_default()
            .iter()
            .filter(|a| a.role == "alt" && a.enabled)
            .filter(|a| {
                guard
                    .get_meta(&format!("alt_phase:{}", a.id))
                    .ok()
                    .flatten()
                    .map(|p| p == "joined")
                    .unwrap_or(false)
            })
            .count() as i64;
        let ok_m = guard.count_ok_accounts("donate", &format!("donate:{today}")).unwrap_or(0);
        let ok_e = guard.count_ok_accounts("equip_donate", &format!("equip_donate:{today}")).unwrap_or(0);
        (joined_alts, ok_m, ok_e)
    };
    Ok(json!({
        "joined": joined,
        "guild": g,
        "donate_materials": {"ok": ok_materials, "total": total},
        "donate_equip": {"ok": ok_equip, "total": total},
    }))
}

/// 主号提交物资需求（需求报表输入）
#[tauri::command]
async fn submit_request(
    state: State<'_, Arc<Shared>>,
    item_key: String,
    amount: i64,
) -> Result<(), String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    engine::guild::submit_material_request(&state.db, &api, &main, &item_key, amount).await
}

/// 主号补充（满足）物资需求
#[tauri::command]
async fn fulfill_request(
    state: State<'_, Arc<Shared>>,
    request_id: String,
    amount: i64,
) -> Result<(), String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    engine::guild::fulfill_material_request(&state.db, &api, &main, &request_id, amount).await
}

/// 小号捐献一轮：mode = materials | equipment | all
#[tauri::command]
async fn donate_round(
    state: State<'_, Arc<Shared>>,
    mode: String,
) -> Result<serde_json::Value, String> {
    let _pass = engine::scheduler::acquire_pass(&state)?;
    let api = build_api(&state);
    let opts = state.opts.read().unwrap().clone();
    let accounts = {
        let guard = state.db.lock().unwrap();
        guard.list_accounts().map_err(|e| e.to_string())?
    };
    // 只跑「已入会且启用」的小号
    let pool: Vec<Account> = {
        let guard = state.db.lock().unwrap();
        accounts
            .into_iter()
            .filter(|a| {
                a.role == "alt"
                    && a.enabled
                    && guard
                        .get_meta(&format!("alt_phase:{}", a.id))
                        .ok()
                        .flatten()
                        .map(|p| p == "joined")
                        .unwrap_or(false)
            })
            .collect()
    };
    let today = engine::auth::beijing_day(engine::auth::now_ms());
    let api_owned = api.clone();
    let opts_owned = opts.clone();
    let mode_owned = mode.clone();
    let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
        let api = api_owned.clone();
        let opts = opts_owned.clone();
        let mode = mode_owned.clone();
        let donate_key = format!("donate:{today}");
        let equip_key = format!("equip_donate:{today}");
        async move {
            let db = &shared.db;
            let mut rows: Vec<serde_json::Value> = Vec::new();
            if mode == "materials" || mode == "all" {
                let deny = opts.deny_donate.clone();
                match engine::guild::alt_donate(db, &api, &a, &deny).await {
                    Ok(n) => {
                        record_run(db, a.id, "donate", &donate_key, Ok(format!("捐献 {n} 种")));
                        rows.push(json!({"account_id": a.id, "task": "donate", "ok": n}));
                    }
                    Err(e) => {
                        record_run(db, a.id, "donate", &donate_key, Err(e.clone()));
                        rows.push(json!({"account_id": a.id, "task": "donate", "error": e}));
                    }
                }
            }
            if mode == "equipment" || mode == "all" {
                let min_q = opts.guild_equip_min_quality.clone();
                let min_score = opts.equip_donate_min_score;
                match engine::guild::alt_equip_donate(db, &api, &a, &min_q, min_score).await {
                    Ok(n) => {
                        record_run(db, a.id, "equip_donate", &equip_key, Ok(format!("捐仓 {n} 件")));
                        rows.push(json!({"account_id": a.id, "task": "equip_donate", "ok": n}));
                    }
                    Err(e) => {
                        record_run(db, a.id, "equip_donate", &equip_key, Err(e.clone()));
                        rows.push(json!({"account_id": a.id, "task": "equip_donate", "error": e}));
                    }
                }
            }
            rows
        }
    })
    .await;
    let out: Vec<serde_json::Value> = items.into_iter().flat_map(|(_, rows)| rows).collect();
    Ok(json!(out))
}

/// 总览：今日任务完成度统计（按北京日聚合 runs 与阶段，纯本地）
#[tauri::command]
fn get_daily_stats(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    use std::collections::{HashMap, HashSet};
    let guard = state.db.lock().unwrap();
    let today = engine::auth::beijing_day(engine::auth::now_ms());
    let accounts = guard.list_accounts().map_err(|e| e.to_string())?;
    let total = accounts.iter().filter(|a| a.enabled).count() as i64;
    let alts = accounts.iter().filter(|a| a.role == "alt" && a.enabled).count() as i64;
    // 今日已完成集合：按 finished_at ≥ 北京今日 0 点直接查，不用 recent_runs 窗口扫描
    //（runs 行数超过窗口时窗口法会漏算，导致完成度虚低、补收误判重跑）
    let today_start = engine::auth::beijing_day_start_ms(engine::auth::now_ms());
    let mut done: HashMap<String, HashSet<i64>> = HashMap::new();
    for t in [
        "collect", "collect_idle", "sign_in", "daily_claim", "boss_solo", "boss_world",
        "arcade", "lottery", "prof", "join", "donate", "equip_donate",
    ] {
        if let Ok(ids) = guard.done_account_ids_since(t, today_start) {
            for id in ids {
                done.entry(t.to_string()).or_default().insert(id);
            }
        }
    }
    let leveled = accounts
        .iter()
        .filter(|a| {
            a.role == "alt"
                && guard
                    .get_meta(&format!("alt_phase:{}", a.id))
                    .ok()
                    .flatten()
                    .map(|p| p == "ready" || p == "joined")
                    .unwrap_or(false)
        })
        .count() as i64;
    let c = |t: &str| -> i64 { done.get(t).map(|s| s.len() as i64).unwrap_or(0) };
    Ok(json!({
        "today": today,
        "total": total,
        "alts": alts,
        "collect": c("collect"),
        "collect_idle": c("collect_idle"),
        "sign_in": c("sign_in"),
        "daily_claim": c("daily_claim"),
        "boss_solo": c("boss_solo"),
        "boss_world": c("boss_world"),
        "arcade": c("arcade"),
        "lottery": c("lottery"),
        "prof": c("prof"),
        "join": c("join"),
        "donate": c("donate"),
        "equip_donate": c("equip_donate"),
        "leveled": leveled,
    }))
}

/// 写入一条运行记录（与调度器 record 同构；不含退避副作用）。
/// 手动批量执行也落 runs 表，让「今日任务完成度」统计即时反映本次执行。
fn record_run(db: &std::sync::Mutex<Db>, account_id: i64, task: &str, run_key: &str, res: Result<String, String>) {
    let now = engine::auth::now_ms();
    let (status, detail) = match res {
        Ok(s) => ("ok".to_string(), s),
        Err(e) => ("failed".to_string(), e),
    };
    let row = engine::db::RunRow {
        account_id,
        task: task.into(),
        run_key: run_key.into(),
        status,
        detail,
        started_at: now,
        finished_at: now,
    };
    if let Ok(guard) = db.lock() {
        let _ = guard.touch_run(&row, true);
    }
}

/// 并发批量执行：Semaphore 按「并发账号数」限流 + req_gap_ms 错峰启动（与 one_pass 一致）。
/// 返回 [(account_id, R)]（完成顺序不定，按 id 定位）。
async fn run_concurrent<F, Fut, R>(
    shared: &Arc<Shared>,
    _api: &Api,
    opts: &SchedulerOpts,
    accounts: Vec<Account>,
    f: F,
) -> Vec<(i64, R)>
where
    F: Fn(Arc<Shared>, Account) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = R> + Send + 'static,
    R: Send + 'static,
{
    let sem = Arc::new(tokio::sync::Semaphore::new(opts.concurrency.max(1)));
    let mut set = tokio::task::JoinSet::new();
    let f = Arc::new(f);
    // 先清取消标志（新一轮批量开始时复位）；每个账号分派前检查，若已取消则停止分派剩余账号
    shared.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    for a in accounts {
        if shared.cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(opts.req_gap_ms)).await;
        let shared2 = shared.clone();
        let sem2 = sem.clone();
        let f2 = f.clone();
        let id = a.id;
        set.spawn(async move {
            let _permit = sem2.acquire_owned().await.expect("semaphore closed");
            (id, f2(shared2, a).await)
        });
    }
    let mut out = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(pair) = res {
            out.push(pair);
        }
    }
    out
}

/// 批量立即执行单个任务（全部账号；幂等/退避友好）。
/// only_pending=true 时（「继续/补收」）只执行今天（北京时间）还没有成功记录该任务的账号，
/// 口径与 get_daily_stats 的「今日任务完成度」完全一致。
#[tauri::command]
async fn run_task_batch(
    state: State<'_, Arc<Shared>>,
    task: String,
    only_pending: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _pass = engine::scheduler::acquire_pass(&state)?;
    let api = build_api(&state);
    let opts = state.opts.read().unwrap().clone();
    let accounts = {
        let guard = state.db.lock().unwrap();
        guard.list_accounts().map_err(|e| e.to_string())?
    };
    let phase_of = |id: i64| -> String {
        state
            .db
            .lock()
            .unwrap()
            .get_meta(&format!("alt_phase:{id}"))
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    fn push(out: &mut Vec<serde_json::Value>, id: i64, r: Result<String, String>) {
        out.push(json!({"id": id, "r": r.unwrap_or_else(|e| format!("失败:{e}"))}));
    }
    // 补收模式：今天（北京时间）已成功完成该任务的账号集合（与 get_daily_stats 口径一致）
    let only_pending = only_pending.unwrap_or(false);
    let today = engine::auth::beijing_day(engine::auth::now_ms());
    let done_ids: std::collections::HashSet<i64> = if only_pending {
        let stat_task = if task == "world" { "boss_world" } else { task.as_str() };
        let guard = state.db.lock().unwrap();
        // 按 finished_at ≥ 北京今日 0 点直查（避免 recent_runs 窗口漏算导致重复执行）
        guard
            .done_account_ids_since(stat_task, engine::auth::beijing_day_start_ms(engine::auth::now_ms()))
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect()
    } else {
        std::collections::HashSet::new()
    };
    let should_run = |a: &engine::db::Account| -> bool { a.enabled && !(only_pending && done_ids.contains(&a.id)) };
    let mut out: Vec<serde_json::Value> = Vec::new();
    match task.as_str() {
        "collect" | "sign_in" | "daily_claim" => {
            let pool: Vec<Account> = accounts.iter().filter(|a| should_run(a)).cloned().collect();
            let today = today.clone();
            let api_owned = api.clone();
            let opts_owned = opts.clone();
            let is_collect = task == "collect";
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let opts = opts_owned.clone();
                let collect_key = format!("daily:{}", today);
                async move {
                    let db = &shared.db;
                    // 背包预清理：换装 + 按 9 档模板分解，腾出空间再领邮件/收益
                    for (t, res) in engine::equip::pre_clean_bag(db, &api, &a, opts.auto_equip, opts.decompose_enabled).await {
                        record_run(db, a.id, &t, &format!("{t}:{}", engine::auth::now_ms() / 1000), res);
                    }
                    // 部分子步骤失败（如收益预览 HTTP 502）→ 记为失败，不算完成，继续按钮下轮再补
                    let res = engine::collect::collect_result_ok(collect_round(db, &api, &a, true).await);
                    if is_collect {
                        record_run(db, a.id, "collect", &collect_key, res.clone());
                    }
                    res
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "prof" => {
            let pool: Vec<Account> = accounts.iter().filter(|a| should_run(a)).cloned().collect();
            let today = today.clone();
            let api_owned = api.clone();
            let opts_owned = opts.clone();
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let opts = opts_owned.clone();
                let key = format!("prof:{}", today);
                async move {
                    let db = &shared.db;
                    let res = engine::profession::professions_loop(db, &api, &a, &opts).await;
                    record_run(db, a.id, "prof", &key, res.clone());
                    res
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "boss_solo" => {
            let pool: Vec<Account> = accounts.iter().filter(|a| should_run(a)).cloned().collect();
            let today = today.clone();
            let api_owned = api.clone();
            let opts_owned = opts.clone();
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let opts = opts_owned.clone();
                let key = format!("boss_solo:{}", today);
                async move {
                    let db = &shared.db;
                    let main_slot = if a.role == "main" { Some(opts.boss_main_target_slot.as_str()) } else { None };
                    let res = engine::boss::boss_solo_daily(db, &api, &a, opts.boss_material_boost, "none", main_slot, &opts.boss_set_quality, &opts.boss_set_rareness).await;
                    record_run(db, a.id, "boss_solo", &key, res.clone());
                    res
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "world" => {
            // 世界boss 定时开放、key 固定：场次窗口内每个号独立打完它可参加的全部 boss；
            // 账号间按 concurrency 并发（与后台 world_pass 一致）
            let pool: Vec<Account> = accounts.iter().filter(|a| should_run(a)).cloned().collect();
            let api_owned = api.clone();
            let opts_owned = opts.clone();
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let opts = opts_owned.clone();
                async move {
                    let db = &shared.db;
                    Ok(engine::scheduler::maybe_world_assist(db, &api, &a, &opts).await)
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "arcade" => {
            let pool: Vec<Account> = accounts.iter().filter(|a| should_run(a)).cloned().collect();
            let today = today.clone();
            let api_owned = api.clone();
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let key = format!("arcade:{}", today);
                async move {
                    let db = &shared.db;
                    let res = engine::arcade::arcade_free(db, &api, &a).await;
                    record_run(db, a.id, "arcade", &key, res.clone());
                    res
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "lottery" => {
            let n = opts.lottery_tickets;
            if n > 0 {
                let pool: Vec<Account> = accounts.iter().filter(|a| should_run(a)).cloned().collect();
                let today = today.clone();
                let api_owned = api.clone();
                let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                    let api = api_owned.clone();
                    let key = format!("lottery:{}", today);
                    async move {
                        let db = &shared.db;
                        let res = engine::arcade::lottery_buy(db, &api, &a, n).await;
                        record_run(db, a.id, "lottery", &key, res.clone());
                        res
                    }
                })
                .await;
                for (id, r) in items {
                    push(&mut out, id, r);
                }
            } else {
                return Ok(json!([{"info": "大乐透未开启（设置页 lottery_tickets = 0）"}]));
            }
        }
        "level" => {
            let pool: Vec<Account> = accounts
                .iter()
                .filter(|a| a.role == "alt" && a.enabled && phase_of(a.id) == "init")
                .cloned()
                .collect();
            let api_owned = api.clone();
            let target = opts.join_target_level;
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                async move {
                    let db = &shared.db;
                    engine::guild::level_once(db, &api, &a, target).await
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "join" => {
            let gid = {
                let g = state.db.lock().unwrap();
                g.get_meta("main_guild_id").ok().flatten().unwrap_or_default()
            };
            if gid.is_empty() {
                return Err("主号尚未识别公会".into());
            }
            let pool: Vec<Account> = accounts
                .iter()
                .filter(|a| a.role == "alt" && a.enabled && phase_of(a.id) == "ready")
                .cloned()
                .collect();
            let api_owned = api.clone();
            let gid_owned = gid.clone();
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let gid = gid_owned.clone();
                async move {
                    let db = &shared.db;
                    engine::guild::alt_join(db, &api, &a, &gid).await.map(|joined| {
                        if joined { "已入会".into() } else { "申请已提交（待生效）".into() }
                    })
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "donate" => {
            let pool: Vec<Account> = accounts
                .iter()
                .filter(|a| a.role == "alt" && a.enabled && phase_of(a.id) == "joined" && should_run(a))
                .cloned()
                .collect();
            let today = today.clone();
            let api_owned = api.clone();
            let deny = opts.deny_donate.clone();
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let deny = deny.clone();
                let key = format!("donate:{}", today);
                async move {
                    let db = &shared.db;
                    let res = engine::guild::alt_donate(db, &api, &a, &deny).await.map(|n| format!("捐献 {n} 种"));
                    record_run(db, a.id, "donate", &key, res.clone());
                    res
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        "equip_donate" => {
            let pool: Vec<Account> = accounts
                .iter()
                .filter(|a| a.role == "alt" && a.enabled && phase_of(a.id) == "joined" && should_run(a))
                .cloned()
                .collect();
            let today = today.clone();
            let api_owned = api.clone();
            let min_q = opts.guild_equip_min_quality.clone();
            let min_score = opts.equip_donate_min_score;
            let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
                let api = api_owned.clone();
                let min_q = min_q.clone();
                let key = format!("equip_donate:{}", today);
                async move {
                    let db = &shared.db;
                    let res = engine::guild::alt_equip_donate(db, &api, &a, &min_q, min_score).await.map(|n| format!("捐仓 {n} 件"));
                    record_run(db, a.id, "equip_donate", &key, res.clone());
                    res
                }
            })
            .await;
            for (id, r) in items {
                push(&mut out, id, r);
            }
        }
        _ => return Err("未知任务（可选：collect/prof/boss_solo/world/arcade/lottery/level/join/donate/equip_donate）".into()),
    }
    Ok(json!(out))
}

/// 公会页按钮：等级达标但尚未入会的小号，手动批量提交入会申请。
/// 达标 = 本地 alt_level >= 设置里的入会等级（join_target_level）；未入会 = 阶段不是 joined
/// （含卡在 init/ready/空阶段的号）。与「批量入会」按钮不同：不只看 ready 阶段，也不读服务端门槛。
#[tauri::command]
async fn run_join_eligible(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let opts = state.opts.read().unwrap().clone();
    let gid = {
        let g = state.db.lock().unwrap();
        g.get_meta("main_guild_id").ok().flatten().unwrap_or_default()
    };
    if gid.is_empty() {
        return Err("主号尚未识别公会".into());
    }
    let accounts = {
        let guard = state.db.lock().unwrap();
        guard.list_accounts().map_err(|e| e.to_string())?
    };
    let target = opts.join_target_level;
    let pool: Vec<Account> = {
        let guard = state.db.lock().unwrap();
        accounts
            .into_iter()
            .filter(|a| {
                if a.role != "alt" || !a.enabled {
                    return false;
                }
                let phase = guard
                    .get_meta(&format!("alt_phase:{}", a.id))
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                if phase == "joined" {
                    return false;
                }
                let lv = guard
                    .get_meta(&format!("alt_level:{}", a.id))
                    .ok()
                    .flatten()
                    .and_then(|v| v.parse::<i64>().ok())
                    .unwrap_or(0);
                lv >= target
            })
            .collect()
    };
    if pool.is_empty() {
        return Ok(json!([]));
    }
    let gid_owned = gid.clone();
    let api_owned = api.clone();
    let items = run_concurrent(&state, &api, &opts, pool, move |shared, a| {
        let gid = gid_owned.clone();
        let api = api_owned.clone();
        async move {
            let db = &shared.db;
            match engine::guild::alt_join(db, &api, &a, &gid).await {
                Ok(true) => {
                    // 与调度器一致：入会成功 → 本地阶段翻 joined
                    let _ = db
                        .lock()
                        .unwrap()
                        .set_meta(&format!("alt_phase:{}", a.id), "joined");
                    Ok("已入会".to_string())
                }
                Ok(false) => Ok("申请已提交（待生效）".to_string()),
                Err(e) => Err(e),
            }
        }
    })
    .await;
    let out: Vec<serde_json::Value> = items
        .iter()
        .map(|(id, r)| json!({"id": id, "r": r.clone().unwrap_or_else(|e| format!("失败:{e}"))}))
        .collect();
    Ok(json!(out))
}

// ---------------- 分解模板（按地图 9 档，用户可配置） ----------------

fn decompose_tiers(db: &std::sync::Mutex<Db>) -> Vec<engine::equip::DecomposeTier> {
    engine::equip::load_tiers(db)
}

#[tauri::command]
fn get_decompose_tiers(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    serde_json::to_value(decompose_tiers(&state.db)).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_decompose_tiers(state: State<'_, Arc<Shared>>, tiers: serde_json::Value) -> Result<(), String> {
    let parsed: Vec<engine::equip::DecomposeTier> =
        serde_json::from_value(tiers).map_err(|e| format!("模板格式错误: {e}"))?;
    if parsed.len() != engine::equip::MAP_TIERS.len() {
        return Err(format!(
            "分解模板需要 {} 档（当前 {} 档）",
            engine::equip::MAP_TIERS.len(),
            parsed.len()
        ));
    }
    let s = serde_json::to_string(&parsed).map_err(|e| e.to_string())?;
    let guard = state.db.lock().unwrap();
    guard.set_meta("decompose_tiers", &s).map_err(|e| e.to_string())
}

/// 地图套装进度：全部启用账号，本地快照 + 自学习 setKey，按"品质+稀有度双达标"计数 n/10
#[tauri::command]
fn get_set_progress(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    use std::collections::HashMap;
    let opts = state.opts.read().unwrap().clone();
    let guard = state.db.lock().unwrap();
    let min_q = engine::equip::quality_rank(&opts.boss_set_quality);
    let min_r = engine::equip::rare_rank(&opts.boss_set_rareness);
    let accounts = guard.list_accounts().map_err(|e| e.to_string())?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    for a in accounts.iter().filter(|a| a.enabled) {
        let map = guard
            .get_meta(&format!("alt_map:{}", a.id))
            .ok()
            .flatten()
            .unwrap_or_default();
        let set_key = if map.is_empty() {
            String::new()
        } else {
            guard
                .get_meta(&format!("map_set:{map}"))
                .ok()
                .flatten()
                .unwrap_or_default()
        };
        let mut n = 0i64;
        let mut slots: Vec<String> = Vec::new();
        if !set_key.is_empty() {
            if let Ok(rows) = guard.equipment_brief(a.id) {
                let mut best: HashMap<String, (i64, i64)> = HashMap::new();
                for (slot, quality, rare, sk) in rows {
                    if sk != set_key || slot.is_empty() {
                        continue;
                    }
                    let cand = (engine::equip::quality_rank(&quality), engine::equip::rare_rank(&rare));
                    let cur = best.get(&slot).copied().unwrap_or((-1, -1));
                    if cand > cur {
                        best.insert(slot.clone(), cand);
                    }
                }
                for (slot, (q, r)) in best {
                    if q >= min_q && r >= min_r {
                        n += 1;
                        slots.push(slot);
                    }
                }
            }
        }
        out.push(json!({
            "account_id": a.id,
            "map": map,
            "map_name": engine::equip::map_name_by_key(&map).unwrap_or(&map),
            "set_key": set_key,
            "quality": opts.boss_set_quality,
            "rareness": opts.boss_set_rareness,
            "n": n,
            "total": 10,
            "slots": slots,
        }));
    }
    Ok(json!(out))
}

/// 总览：战力区间（合并 个人/地图/世界 boss 需求战力门槛）+ 收益评分区间（200 一档）分布。
/// 数据来自收菜时缓存的 alt_power / alt_revenue，纯本地聚合。
#[tauri::command]
fn get_bracket_stats(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    // 战力档边界 = 全部 boss requiredPower 合并去重（升序；'0' 为开放用占位不参与）
    const GATES: [i64; 20] = [
        880, 4400, 10500, 20400, 25800, 47000, 57400, 76500, 96000, 117000,
        147000, 168000, 205000, 220000, 310000, 380000, 460000, 520000, 640000, 780000,
    ];
    use std::collections::BTreeMap;
    let guard = state.db.lock().unwrap();
    let accounts = guard.list_accounts().unwrap_or_default();
    let mut power: Vec<i64> = vec![0; GATES.len() + 1];
    let mut revenue: BTreeMap<i64, i64> = BTreeMap::new();
    let mut n_power = 0i64;
    let mut n_rev = 0i64;
    for a in accounts.iter().filter(|a| a.enabled) {
        if let Ok(Some(p)) = guard.get_meta(&format!("alt_power:{}", a.id)) {
            if let Ok(pv) = p.parse::<i64>() {
                let idx = GATES.partition_point(|&g| pv >= g);
                power[idx] += 1;
                n_power += 1;
            }
        }
        if let Ok(Some(r)) = guard.get_meta(&format!("alt_revenue:{}", a.id)) {
            if let Ok(rv) = r.parse::<i64>() {
                let bucket = (rv / 200) * 200;
                *revenue.entry(bucket).or_insert(0) += 1;
                n_rev += 1;
            }
        }
    }
    let pow_list: Vec<serde_json::Value> = GATES
        .iter()
        .enumerate()
        .map(|(i, &g)| {
            json!({
                "min": if i == 0 { 0 } else { GATES[i - 1] },
                "max": g,
                "count": power[i],
            })
        })
        .chain(std::iter::once(json!({
            "min": *GATES.last().unwrap(),
            "max": 0, // 0=开放档（780k+）
            "count": power[GATES.len()],
        })))
        .collect();
    Ok(json!({
        "power_gates": GATES,
        "power": pow_list,
        "revenue": revenue.iter().map(|(k, v)| json!({"min": k, "count": v})).collect::<Vec<_>>(),
        "n_power": n_power,
        "n_rev": n_rev,
        "total": accounts.iter().filter(|a| a.enabled).count(),
    }))
}

/// 全账号背包快照（本地 SQLite，收菜时自动写入）
#[tauri::command]
fn get_alt_inventories(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let guard = state.db.lock().unwrap();
    let rows = guard.get_all_inventory().map_err(|e| e.to_string())?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    for (aid, uname, key, itype, iname, amount, bind) in rows {
        items.push(
            json!({"account_id": aid, "username": uname, "item_key": key, "item_type": itype, "item_name": iname, "amount": amount, "bind_status": bind}),
        );
    }
    Ok(json!(items))
}

/// 装备页：大号装备/背包/货币（一次拉取供展示与操作）
#[tauri::command]
async fn get_equipment(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    let token = engine::auth::ensure_session(&state.db, &api, &main).await?;
    let st = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let p = &st["player"];
    Ok(json!({
        "player": {
            "level": p["level"].as_i64().unwrap_or(0),
            "gold": p["gold"].as_i64().unwrap_or(0),
            "rareCoin": p["rareCoin"].as_i64().unwrap_or(0),
            "rareCoinFragment": p["rareCoinFragment"].as_i64().unwrap_or(0),
            "power": p["power"].as_i64().unwrap_or(0)
        },
        "equipment": st.get("equipment").cloned().unwrap_or(json!([])),
        "items": st.get("items").cloned().unwrap_or(json!([])),
    }))
}

/// 装备操作统一网关：act 白名单映射接口；preview=true 时调 -preview
#[tauri::command]
async fn equip_run(
    state: State<'_, Arc<Shared>>,
    act: String,
    payload: serde_json::Value,
    preview: bool,
) -> Result<serde_json::Value, String> {
    const MAP: &[(&str, &str)] = &[
        ("enhance", "/api/equipment/enhance"),
        ("reforge", "/api/equipment/reforge"),
        ("quality_upgrade", "/api/equipment/quality-upgrade"),
        ("decompose", "/api/equipment/decompose"),
        ("affix_inherit", "/api/equipment/affix-inherit"),
        ("enhance_inherit", "/api/equipment/enhance-inherit"),
        ("wear", "/api/equipment/wear"),
        ("take_off", "/api/equipment/take-off"),
        ("toggle_lock", "/api/equipment/toggle-lock"),
        ("unbind", "/api/equipment/unbind"),
    ];
    let mut path = MAP
        .iter()
        .find(|(k, _)| *k == act)
        .ok_or("未知装备动作")?
        .1
        .to_string();
    let no_preview = matches!(act.as_str(), "wear" | "take_off" | "toggle_lock" | "unbind");
    if preview && !no_preview {
        path.push_str("-preview");
    }
    let api = build_api(&state);
    let main = first_main(&state)?;
    let token = engine::auth::ensure_session(&state.db, &api, &main).await?;
    let r = api
        .mutate(&token, &path, payload)
        .await
        .map_err(|e| e.to_string())?;
    let mut data = r.get("data").cloned().unwrap_or(r);
    if let Some(obj) = data.as_object_mut() {
        obj.remove("statePatch");
        obj.remove("changedSections");
        obj.remove("sectionEtags");
    }
    Ok(data)
}

#[tauri::command]
fn remove_account(state: State<'_, Arc<Shared>>, id: i64) -> Result<(), String> {
    let guard = state.db.lock().unwrap();
    guard.delete_account(id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_enabled(state: State<'_, Arc<Shared>>, id: i64, enabled: bool) -> Result<(), String> {
    let guard = state.db.lock().unwrap();
    guard.set_enabled(id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_daemon(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    // 挂机游戏收菜驱动：开启后台后仅世界 boss 定时参与。
    // 练级、换图等已并入手动收菜（一键收菜全部），无需预热逻辑。
    state.running.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn stop_daemon(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    state.running.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn clear_runs(state: State<'_, Arc<Shared>>, account_id: Option<i64>) -> Result<usize, String> {
    let guard = state.db.lock().unwrap();
    guard.clear_runs(account_id).map_err(|e| e.to_string())
}

/// 停止当前批量任务：置取消标志 true，正在跑的 run_concurrent / one_pass 会停止分派剩余账号
#[tauri::command]
fn cancel_task(state: State<'_, Arc<Shared>>) -> Result<(), String> {
    state.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn create_guild(
    state: State<'_, Arc<Shared>>,
    name: String,
    motto: String,
) -> Result<String, String> {
    let api = build_api(&state);
    let main = {
        let guard = state.db.lock().unwrap();
        guard
            .mains()
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .ok_or("还没有主账号，请先添加大号")?
    };
    let name = if name.trim().is_empty() {
        "VIP 军团".to_string()
    } else {
        name.trim().to_string()
    };
    engine::guild::create_guild(&state.db, &api, &main, &name, &motto).await
}

#[tauri::command]
async fn run_collect(
    state: State<'_, Arc<Shared>>,
    account_id: i64,
    with_daily: bool,
) -> Result<String, String> {
    let _pass = engine::scheduler::acquire_pass(&state)?;
    let api = build_api(&state);
    let opts = state.opts.read().unwrap().clone();
    let acc = {
        let guard = state.db.lock().unwrap();
        guard
            .get_account(account_id)
            .map_err(|e| e.to_string())?
            .ok_or("账号不存在")?
    };
    // 背包预清理：换装 + 按 9 档模板分解，腾出空间再领奖励
    for (t, res) in engine::equip::pre_clean_bag(&state.db, &api, &acc, opts.auto_equip, opts.decompose_enabled).await {
        record_run(&state.db, acc.id, &t, &format!("{t}:{}", engine::auth::now_ms() / 1000), res);
    }
    let res = collect_round(&state.db, &api, &acc, with_daily).await;
    // 完整收菜（with_daily）时落 collect 日志，口径与 run_task_batch/调度器一致，
    // 否则单号收菜后「今日完成度/账号页 ✓」不更新（旧数据误导）
    if with_daily {
        let key = format!("daily:{}", engine::auth::beijing_day(engine::auth::now_ms()));
        let final_res = engine::collect::collect_result_ok(res);
        record_run(&state.db, acc.id, "collect", &key, final_res.clone());
        final_res
    } else {
        res
    }
}

/// 一键收菜全部账号：对所有启用账号跑一轮完整流水线（收菜+签到/活跃+副职业+换装+
/// 捐献+分解+换图+个人首领+街机+市场）。挂机练级游戏采用手动收菜模式，
/// 后台只保留世界首领定时参与，故这是主要的操作入口。
#[tauri::command]
async fn run_collect_all(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let opts = state.opts.read().unwrap().clone();
    let out = one_pass(&state, &api, &opts).await;
    Ok(json!({"items": out}))
}

#[tauri::command]
async fn run_guild_sync(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let opts = state.opts.read().unwrap().clone();
    let out = one_pass(&state, &api, &opts).await;
    Ok(json!(out))
}

/// 领取收益流程（所有启用账号）：领挂机收益（奇遇按偏好，默认经验）
/// → 高分装备换装 → 按当前地图档位分解 → 刷新本地快照
#[tauri::command]
async fn run_collect_rewards(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let _pass = engine::scheduler::acquire_pass(&state)?;
    let api = build_api(&state);
    let opts = state.opts.read().unwrap().clone();
    let tiers = decompose_tiers(&state.db);
    let accounts: Vec<Account> = {
        let guard = state.db.lock().unwrap();
        guard.list_accounts().map_err(|e| e.to_string())?
    };
    let accounts: Vec<Account> = accounts.into_iter().filter(|a| a.enabled).collect();
    let api_owned = api.clone();
    let opts_owned = opts.clone();
    let items = run_concurrent(&state, &api, &opts, accounts, move |shared, a| {
        let api = api_owned.clone();
        let opts = opts_owned.clone();
        let tiers = tiers.clone();
        async move {
            let db = &shared.db;
            let r = collect_rewards_one(db, &api, &opts, &tiers, &a).await;
            record_run(
                db,
                a.id,
                "collect_rewards",
                &format!("rewards:{}", engine::auth::now_ms()),
                r.clone(),
            );
            r
        }
    })
    .await;
    let out: Vec<serde_json::Value> = items
        .iter()
        .map(|(id, r)| json!({"id": id, "r": r.clone().unwrap_or_else(|e| format!("失败:{e}"))}))
        .collect();
    Ok(json!(out))
}

async fn collect_rewards_one(
    db: &std::sync::Mutex<Db>,
    api: &Api,
    opts: &SchedulerOpts,
    tiers: &[engine::equip::DecomposeTier],
    acc: &Account,
) -> Result<String, String> {
    let token = engine::auth::ensure_session(db, api, acc).await?;
    let mut parts: Vec<String> = Vec::new();
    // 收益评分（profile.revenueScore.total）顺带缓存，供总览分档
    engine::collect::refresh_revenue(db, api, acc, &token).await;
    // 1) 领挂机收益（奇遇按偏好，默认经验优先）——领取结果必须如实判断：
    //    否则 409"玩家状态已被其他 worker 更新"时日志仍显示"收益已领"（实际没领到）
    match engine::collect::idle_summary(api, &token).await {
        Ok(sum) if engine::collect::has_gains(&sum) => {
            match engine::collect::collect_idle_with_pref(db, api, acc, &token, &opts.idle_adventure_pref).await {
                Ok(_) => parts.push("收益已领".into()),
                Err(e) => parts.push(format!("收益领取失败:{e}")),
            }
        }
        Ok(_) => parts.push("暂无收益".into()),
        Err(e) => parts.push(format!("收益预览:{e}")),
    }
    // 2) 高分装备换装（绑定优先）
    match engine::equip::auto_equip_best(db, api, acc).await {
        Ok(s) => parts.push(s),
        Err(e) => parts.push(format!("换装:{e}")),
    }
    // 3) 按当前地图档位分解 + 刷新本地快照
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    engine::collect::snapshot_local(db, acc, &state);
    let idx = if acc.role == "alt" {
        engine::equip::tier_index_for_alt(&state)
    } else {
        engine::equip::tier_index_for(&state)
    };
    match tiers.get(idx) {
        Some(tier) => match engine::equip::auto_decompose_tier(db, api, acc, tier).await {
            Ok(s) => parts.push(s),
            Err(e) => parts.push(format!("分解:{e}")),
        },
        None => parts.push(format!("未找到档位模板(idx={idx})")),
    }
    Ok(parts.join("；"))
}

#[tauri::command]
fn get_settings(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let opts = state.opts.read().unwrap().clone();
    serde_json::to_value(opts).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(state: State<'_, Arc<Shared>>, opts: serde_json::Value) -> Result<(), String> {
    let parsed: SchedulerOpts = serde_json::from_value(opts).map_err(|e| format!("配置格式错误: {e}"))?;
    parsed.validate()?;
    {
        let guard = state.db.lock().unwrap();
        parsed.save(&guard)?;
    }
    {
        let mut w = state.opts.write().unwrap();
        *w = parsed;
    }
    Ok(())
}

#[tauri::command]
fn get_runs(
    state: State<'_, Arc<Shared>>,
    account_id: Option<i64>,
    limit: i64,
) -> Result<serde_json::Value, String> {
    let guard = state.db.lock().unwrap();
    // 日志展示上限：200 条在 112 号每天上千条日志下只显示最近几小时（看着像"只保留一天"），
    // 放宽到 5000，能翻回好几天
    let limit = limit.clamp(1, 5000);
    let runs = guard
        .recent_runs(account_id, limit)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(runs).map_err(|e| e.to_string())?)
}

/// 重试某账号某任务：删除今日 run_key 并清退避，下一轮调度自动重做
#[tauri::command]
fn retry_run(state: State<'_, Arc<Shared>>, account_id: i64, task: String) -> Result<(), String> {
    let today = engine::auth::beijing_day(engine::auth::now_ms());
    let guard = state.db.lock().unwrap();
    guard
        .delete_runs_like(account_id, &task, &format!("{today}%"))
        .map_err(|e| e.to_string())?;
    guard
        .set_meta(&format!("backoff:{account_id}:{task}"), "0")
        .map_err(|e| e.to_string())?;
    guard
        .set_meta(&format!("backoff_cnt:{account_id}:{task}"), "0")
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------- 装备洗练（独立 tab，交互式） ----------------

#[tauri::command]
async fn get_reforge_state(state: State<'_, Arc<Shared>>) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    engine::reforge::fetch_reforge_state(&state.db, &api, &main).await
}

#[tauri::command]
async fn reforge_preview(
    state: State<'_, Arc<Shared>>,
    equipment_id: String,
    locked_stats: Vec<String>,
    target_stat: String,
) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    engine::reforge::reforge_preview(&state.db, &api, &main, &equipment_id, &locked_stats, &target_stat).await
}

#[tauri::command]
async fn reforge_exec(
    state: State<'_, Arc<Shared>>,
    equipment_id: String,
    locked_stats: Vec<String>,
    target_stat: String,
) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    engine::reforge::reforge_exec(&state.db, &api, &main, &equipment_id, &locked_stats, &target_stat).await
}

#[tauri::command]
async fn equipment_toggle_lock(
    state: State<'_, Arc<Shared>>,
    equipment_id: String,
) -> Result<serde_json::Value, String> {
    let api = build_api(&state);
    let main = first_main(&state)?;
    engine::reforge::equipment_toggle_lock(&state.db, &api, &main, &equipment_id).await
}

// ---------------- app setup ----------------

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 1) 数据目录 + SQLite
            let dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&dir).expect("failed to create app data dir");
            let db_path = dir.join("vip.db");
            let db = Db::open(&db_path).expect("failed to open vip.db");

            // 2) 设备指纹（一次性生成，持久化）
            let device_id = match db.get_meta("device_id").ok().flatten() {
                Some(d) if !d.is_empty() => d,
                _ => {
                    let d = new_device_id();
                    let _ = db.set_meta("device_id", &d);
                    d
                }
            };

            // 3) 配置：从 meta 加载（缺省用默认），构造 API 客户端
            let opts = SchedulerOpts::load(&db);
            let opts_default = opts.clone();
            let api = Api::new(opts.base_url.clone(), device_id.clone());

            let shared = Arc::new(Shared {
                db: std::sync::Mutex::new(db),
                running: std::sync::atomic::AtomicBool::new(true),
                pass_busy: std::sync::atomic::AtomicBool::new(false),
                cancel: std::sync::atomic::AtomicBool::new(false),
                latest: std::sync::Mutex::new(String::new()),
                base_url: opts_default.base_url.clone(),
                api,
                opts: std::sync::RwLock::new(opts_default),
            });
            let state_handle = shared.clone();
            app.manage(state_handle);

            // 4) 启动后台调度器（配置每 tick 从 Shared.opts 热读）
            {
                let app2 = app.handle().clone();
                let shared2 = shared.clone();
                spawn(app2, shared2);
            }

            // 5) 托盘
            build_tray(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_daily_stats,
            run_task_batch,
            run_collect_rewards,
            get_decompose_tiers,
            save_decompose_tiers,
            get_set_progress,
            get_bracket_stats,
            list_accounts,
            add_main,
            register_main,
            add_alts,
            remove_account,
            set_enabled,
            start_daemon,
            stop_daemon,
            create_guild,
            run_collect,
            run_collect_all,
            run_guild_sync,
            get_runs,
            retry_run,
            clear_runs,
            cancel_task,
            get_settings,
            save_settings,
            promote_guest,
            open_web_login,
            open_web_direct,
            get_guild_info,
            approve_all,
            get_world_boss_stats,
            get_solo_boss_stats,
            run_join_eligible,
            submit_request,
            fulfill_request,
            donate_round,
            get_alt_inventories,
            get_equipment,
            equip_run,
            get_reforge_state,
            reforge_preview,
            reforge_exec,
            equipment_toggle_lock,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "开始/停止收菜", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;

    let mut builder = TrayIconBuilder::with_id("tray")
        .menu(&menu)
        .tooltip("PlaceGame VIP 收菜客户端")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "toggle" => {
                if let Some(state) = app.try_state::<Arc<Shared>>() {
                    let on = !state.running.load(std::sync::atomic::Ordering::SeqCst);
                    state.running.store(on, std::sync::atomic::Ordering::SeqCst);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}