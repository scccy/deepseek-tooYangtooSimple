//! M5 街机免费轮 + 大乐透（默认关）
//! 已实测：actionId=游戏键名（slot）；免费次数字段 arcade.*.freeUsed/freePushesUsed；
//! 免费局也需传 betGold（服务端按默认档结算、costGold=0）；lottery/view 字段全量已抓

use super::api::Api;
use super::auth::ensure_session;
use super::db::{Account, Db};
use serde_json::json;
use std::sync::Mutex;

/// 单张牌点数：A=1（软牌另计）、J/Q/K=10、数字牌原值；未知牌按 0（保守）
fn card_value(rank: &str, _soft_ace: bool) -> i64 {
    match rank {
        "A" => 11,
        "K" | "Q" | "J" => 10,
        "10" => 10,
        "9" => 9,
        "8" => 8,
        "7" => 7,
        "6" => 6,
        "5" => 5,
        "4" => 4,
        "3" => 3,
        "2" => 2,
        _ => 0,
    }
}

/// 发一个 21 点动作（hit/stand/double），返回 (round.status, playerScore, playerSoft)
async fn blackjack_act(api: &Api, token: &str, hand_id: &str, act: &str) -> (String, i64, bool) {
    match api
        .mutate(token, &format!("/api/arcade/blackjack/{}", act), json!({"actionId": hand_id}))
        .await
    {
        Ok(v) => {
            let rd = v
                .get("data")
                .and_then(|d| d.get("result"))
                .and_then(|x| x.get("round"))
                .cloned()
                .unwrap_or(json!({}));
            let status = rd
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("active")
                .to_string();
            let score = rd["playerScore"].as_i64().unwrap_or(0);
            let soft = rd["playerSoft"].as_bool().unwrap_or(false);
            (status, score, soft)
        }
        Err(_) => ("active".to_string(), 0, false),
    }
}

/// 21点基本策略（标准表简化版）：
/// - 硬牌 total vs dealer up（A 视为 11）
/// - 软牌（有 A 算 11 未爆）单独分支
/// - 返回 "hit" / "stand" / "double"
fn blackjack_action(total: i64, soft: bool, dealer: i64) -> String {
    if total >= 21 {
        return "stand".into();
    }
    if soft {
        // 软牌（A=11）：
        // 软 13-16（即 2-5 点显示 +11）：庄 6 以下双，7 以上要牌
        // 软 17：庄 3-6 双，其他停
        // 软 18：庄 3-6 双（8→停），庄 9/A 停，其余要
        // 软 19+：停
        return match total {
            13 | 14 | 15 | 16 => {
                if dealer <= 6 {
                    "double".into()
                } else {
                    "hit".into()
                }
            }
            17 => {
                if (3..=6).contains(&dealer) {
                    "double".into()
                } else {
                    "stand".into()
                }
            }
            18 => {
                if (3..=6).contains(&dealer) {
                    "double".into()
                } else if dealer == 9 || dealer == 10 || dealer == 11 {
                    "stand".into()
                } else {
                    "hit".into()
                }
            }
            _ => "stand".into(),
        };
    }
    // 硬牌：
    // ≤8：必要（double 只在 9/10/11）
    // 9：庄 3-6 double，否则 hit
    // 10：庄 2-9 double，庄 10/A hit
    // 11：庄 2-10 double，庄 A hit
    // 12：庄 4-6 stand，否则 hit
    // 13-16：庄 2-6 stand，否则 hit
    // ≥17：stand
    match total {
        8 => "hit".into(),
        9 => {
            if (3..=6).contains(&dealer) {
                "double".into()
            } else {
                "hit".into()
            }
        }
        10 => {
            if (2..=9).contains(&dealer) {
                "double".into()
            } else {
                "hit".into()
            }
        }
        11 => {
            if (2..=10).contains(&dealer) {
                "double".into()
            } else {
                "hit".into()
            }
        }
        12 => {
            if (4..=6).contains(&dealer) {
                "stand".into()
            } else {
                "hit".into()
            }
        }
        13..=16 => {
            if (2..=6).contains(&dealer) {
                "stand".into()
            } else {
                "hit".into()
            }
        }
        _ => "stand".into(),
    }
}

pub async fn arcade_free(db: &Mutex<Db>, api: &Api, acc: &Account) -> Result<String, String> {
    let token = ensure_session(db, api, acc).await?;
    let state = api.bootstrap(&token).await.map_err(|e| e.to_string())?;
    let arc = &state["arcade"];
    let mut parts: Vec<String> = Vec::new();

    // 老虎机
    if !arc["slot"]["freeUsed"].as_bool().unwrap_or(true) {
        if let Ok(r) = api.mutate(&token, "/api/arcade/slot/spin", json!({"actionId": "slot", "betGold": 100})).await {
            let win_type = r.get("data").and_then(|d| d.get("winType")).and_then(|v| v.as_str()).unwrap_or("");
            parts.push(format!("老虎机:{}", win_type));
        }
    }
    // 翻牌寻宝：保守策略，翻到奖励 ≥2 档即收手
    if !arc["treasure"]["freeUsed"].as_bool().unwrap_or(true) {
        if let Ok(r) = api.mutate(&token, "/api/arcade/treasure/start", json!({"actionId": "treasure", "betGold": 100})).await {
            let data = r.get("data").cloned().unwrap_or(json!({}));
            // 前端策略：翻到第 2 档(700) 即 collect 收手；遇塌方结束
            let mut keep = true;
            let mut idx = 0usize;
            let mut reward = 0i64;
            while keep && idx < 6 {
                match api.mutate(&token, "/api/arcade/treasure/reveal", json!({"actionId": "treasure", "cardIndex": idx})).await {
                    Ok(rr) => {
                        let d = rr.get("data").cloned().unwrap_or(json!({}));
                        if d["trap"].as_bool().unwrap_or(false) {
                            keep = false;
                        } else if let Some(v) = d["rewardGold"].as_i64() {
                            reward = v;
                            if reward >= 700 {
                                keep = false;
                            }
                        }
                    }
                    Err(_) => keep = false,
                }
                idx += 1;
            }
            let _ = reward;
            let _ = data;
            let _ = api.mutate(&token, "/api/arcade/treasure/collect", json!({"actionId": "treasure"})).await;
            parts.push("寻宝完成".into());
        }
    }
    // 21点：标准基本策略。
    // 实测（2026-08-30）：hit/stand/double/split 的 actionId 必须传 **handId**（不是 "blackjack"）
    // start 返回 data.result.round：playerScore/playerSoft/dealerCards(明牌)/hands[].id
    // stand/double 是结算动作：庄家补牌，round.status=won/lost/push，rewardGold 为净胜。
    if !arc["blackjack"]["freeUsed"].as_bool().unwrap_or(true) {
        if let Ok(r) = api
            .mutate(&token, "/api/arcade/blackjack/start", json!({"actionId": "blackjack", "betGold": 100}))
            .await
        {
            let rd = r.get("data").and_then(|d| d.get("result")).and_then(|x| x.get("round")).cloned().unwrap_or(json!({}));
            let hand_id = rd["hands"]
                .as_array()
                .and_then(|hs| hs.first())
                .and_then(|h| h["id"].as_str())
                .unwrap_or("")
                .to_string();
            let mut score = rd["playerScore"].as_i64().unwrap_or(0);
            let mut soft = rd["playerSoft"].as_bool().unwrap_or(false);
            let dealer = rd["dealerCards"]
                .as_array()
                .and_then(|cs| cs.first())
                .and_then(|c| c["rank"].as_str())
                .map(|s| card_value(s, false))
                .unwrap_or(0);
            // 结算动作（stand/double）发出去后，响应里 status 可能仍 active（庄家异步补牌），
            // 需要再补一次 stand 确认结果；hit 后达到 21/爆牌同理。
            let mut settled = 0usize; // 已发结算动作次数（≤1）
            let mut status = rd["status"].as_str().unwrap_or("active").to_string();
            let mut acts: Vec<&str> = Vec::new();
            for _ in 0..8 {
                if status != "active" || settled > 0 {
                    break;
                }
                if score >= 21 {
                    // 到 21/爆了直接停
                    let (st, sc, so) = blackjack_act(api, &token, &hand_id, "stand").await;
                    status = st;
                    score = sc;
                    soft = so;
                    settled += 1;
                    break;
                }
                let action = blackjack_action(score, soft, dealer);
                // double 只对基本策略允许的点数生效（免费局不赌大）
                let act: &str = if action == "double" {
                    "double"
                } else {
                    action.as_str()
                };
                let (st, sc, so) = blackjack_act(api, &token, &hand_id, act).await;
                status = st;
                score = sc;
                soft = so;
                acts.push(if act == "double" { "双" } else if act == "hit" { "要" } else { "停" });
                if act == "stand" || act == "double" {
                    settled += 1;
                }
                if status == "active" && act == "stand" {
                    // stand 已发但响应未收尾（庄家异步补牌）→ 再确认一次
                    let (st2, sc2, so2) = blackjack_act(api, &token, &hand_id, "stand").await;
                    status = st2;
                    score = sc2;
                    soft = so2;
                }
            }
            if settled == 0 && status == "active" {
                let (st, sc, so) = blackjack_act(api, &token, &hand_id, "stand").await;
                status = st;
                score = sc;
                soft = so;
            }
            let verdict = match status.as_str() {
                "won" => "胜",
                "lost" | "bust" => "负",
                "push" | "tie" => "平",
                _ => "停",
            };
            let _ = soft;
            parts.push(format!("21点:{}（{}{}）", verdict, acts.join(""), score));
        }
    }
    // 推币机：免费 push + 领全服里程碑
    if let Ok(v) = api.request(super::api::Req {
        method: "GET",
        path: "/api/arcade/coin-pusher/view".into(),
        body: None,
        token: Some(&token),
        response_state: "omit",
        timeout_secs: 20,
    })
    .await
    {
        let data = v.get("data").cloned().unwrap_or(json!({}));
        let free = data["config"]["freePushesRemaining"].as_i64().unwrap_or(0);
        for _ in 0..free {
            let _ = api
                .mutate(&token, "/api/arcade/coin-pusher/push", json!({"actionId": "coinPusher", "laneIndex": 0, "betGold": 100}))
                .await;
        }
        let _ = api.mutate(&token, "/api/arcade/coin-pusher/claim-global", json!({})).await;
        parts.push(format!("推币机:免费{free}"));
    }

    Ok(parts.join("；"))
}

pub async fn lottery_buy(db: &Mutex<Db>, api: &Api, acc: &Account, tickets: i64) -> Result<String, String> {
    if tickets <= 0 {
        return Ok("大乐透未开启".into());
    }
    let token = ensure_session(db, api, acc).await?;
    let v = api
        .request(super::api::Req {
            method: "GET",
            path: "/api/lottery/view".into(),
            body: None,
            token: Some(&token),
            response_state: "omit",
            timeout_secs: 20,
        })
        .await
        .map_err(|e| e.to_string())?;
    let data = v.get("data").cloned().unwrap_or(json!({}));
    if data["status"].as_str() == Some("selling") {
        let n = tickets.min(data["personalRemaining"].as_i64().unwrap_or(0));
        if n > 0 {
            api.mutate(&token, "/api/lottery/buy", json!({"actionId": "lottery", "quantity": n}))
                .await
                .map_err(|e| e.to_string())?;
            return Ok(format!("大乐透购票 {n} 张"));
        }
    }
    Ok("大乐透未在售或已购满".into())
}