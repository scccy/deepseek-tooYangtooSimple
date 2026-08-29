//! 游戏 HTTP API 客户端 —— 请求/响应封装（与前端逆向一致的协议）
//! 已实测：POST /api/auth/guest + GET /api/client/bootstrap + GET /api/client/catalog

use serde_json::{json, Value};
use std::time::Duration;

pub const CLIENT_VERSION: &str = "0.2.50";
pub const BUILD_REVISION: &str = "20260829.1";
pub const DEFAULT_BASE_URL: &str = "https://game.placegame.cn";

#[derive(Debug, Clone)]
pub enum ApiError {
    Http { status: u16, msg: Option<String> },
    VersionRequired,
    SessionExpired,
    Network(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Http { status, msg } => write!(
                f,
                "HTTP {status}: {}",
                msg.as_deref().unwrap_or("服务器返回异常")
            ),
            ApiError::VersionRequired => write!(f, "客户端版本过低（426），需要更新"),
            ApiError::SessionExpired => write!(f, "会话无效或已过期，需要重新登录"),
            ApiError::Network(e) => write!(f, "网络错误: {e}"),
        }
    }
}

impl std::error::Error for ApiError {}

#[derive(Clone)]
pub struct Api {
    pub base: String,
    pub device_id: String,
    client: reqwest::Client,
}

pub struct Req<'a> {
    pub method: &'static str,
    pub path: String,
    pub body: Option<Value>,
    pub token: Option<&'a str>,
    pub response_state: &'static str, // full | patch | omit
    pub timeout_secs: u64,
}

impl Api {
    pub fn new(base: String, device_id: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .expect("failed to build http client");
        Self { base, device_id, client }
    }

    pub async fn request(&self, r: Req<'_>) -> Result<Value, ApiError> {
        for attempt in 0..2 {
            match self.request_once(&r).await {
                Err(ApiError::Http { status, msg })
                    if status >= 400
                        && msg
                            .as_deref()
                            .map(|m| m.contains("worker 更新"))
                            .unwrap_or(false)
                        && attempt == 0 =>
                {
                    // 挂机战斗 worker 并发更新导致的乐观锁冲突：等一拍重试一次
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    continue;
                }
                r => return r,
            }
        }
        unreachable!()
    }

    async fn request_once(&self, r: &Req<'_>) -> Result<Value, ApiError> {
        let url = format!("{}{}", self.base.trim_end_matches('/'), r.path);
        let method = reqwest::Method::from_bytes(r.method.as_bytes())
            .unwrap_or(reqwest::Method::GET);
        let mut req = self
            .client
            .request(method, &url)
            .header("content-type", "application/json")
            .header("x-placegame-client-version", CLIENT_VERSION)
            .header("x-placegame-client-platform", "web")
            .header("x-placegame-device-id", &self.device_id)
            .header("x-placegame-web-build-revision", BUILD_REVISION)
            .header("x-placegame-response-state", r.response_state);
        if let Some(t) = r.token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        if r.method == "POST" {
            req = req.json(&r.body.clone().unwrap_or(Value::Null));
        }
        let resp = req
            .timeout(Duration::from_secs(r.timeout_secs))
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        // 2xx 但响应不是 JSON（限流页/网关 HTML/截断）→ 显式报错，绝不把空状态当成功喂给上层
        // （否则空 player/profile 会被下游当作"没有角色"，触发重建角色等破坏性动作）
        let body: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) if (200..300).contains(&status) => {
                return Err(ApiError::Http {
                    status,
                    msg: Some(format!("响应非 JSON（{} 字节）", text.len())),
                });
            }
            Err(_) => Value::Null,
        };

        if status == 426 {
            return Err(ApiError::VersionRequired);
        }
        if !(200..300).contains(&status) {
            let msg = body
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(m) = &msg {
                if m.contains("会话无效或已过期") {
                    return Err(ApiError::SessionExpired);
                }
            }
            return Err(ApiError::Http { status, msg });
        }
        // 2xx 但 body.ok=false + error：少数"致命拒绝"以 200 返回（实测"网页版本已更新，请刷新网页"）。
        // 若被上层当成功会误判（如挑战被当成击杀），必须转错误。
        // 注意：多数 ok:false 是幂等的"已领取/已签到/无可领取"类正常返回，**不能**全转 Err，
        // 否则每日宝箱/领取重复时误报失败。这里只拦截版本门与会话过期。
        if body.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            if let Some(m) = body.get("error").and_then(|v| v.as_str()) {
                if m.contains("会话无效或已过期") {
                    return Err(ApiError::SessionExpired);
                }
                if m.contains("版本已更新") || m.contains("刷新网页") || m.contains("版本过低") {
                    return Err(ApiError::VersionRequired);
                }
            }
        }
        Ok(body)
    }

    /// GET bootstrap 全量状态（omit 模式，data 即 state）；data 为 null/缺失视为服务端异常
    pub async fn bootstrap(&self, token: &str) -> Result<Value, ApiError> {
        let r = self
            .request(Req {
                method: "GET",
                path: "/api/client/bootstrap".into(),
                body: None,
                token: Some(token),
                response_state: "omit",
                timeout_secs: 20,
            })
            .await?;
        match r.get("data") {
            Some(d) if !d.is_null() => Ok(d.clone()),
            Some(_) => Err(ApiError::Http {
                status: 200,
                msg: Some("bootstrap 返回空 data（服务端异常/维护中）".into()),
            }),
            None => Ok(r),
        }
    }

    /// 按需拉取状态 section（view-sections），返回合并后的 section 对象
    pub async fn view_sections(&self, token: &str, sections: &[&str]) -> Result<Value, ApiError> {
        let r = self
            .request(Req {
                method: "POST",
                path: "/api/client/view-sections".into(),
                body: Some(json!({"sections": sections})),
                token: Some(token),
                response_state: "omit",
                timeout_secs: 25,
            })
            .await?;
        Ok(r.get("data").cloned().unwrap_or(r))
    }

    /// POST 变更（patch 模式返回 {result, statePatch, ...}）
    pub async fn mutate(
        &self,
        token: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        self.request(Req {
            method: "POST",
            path: path.into(),
            body: Some(body),
            token: Some(token),
            response_state: "patch",
            timeout_secs: 25,
        })
        .await
    }

    /// 简单 POST（无需状态，如邮件/签到类）
    pub async fn post_omit(
        &self,
        token: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        self.request(Req {
            method: "POST",
            path: path.into(),
            body: Some(body),
            token: Some(token),
            response_state: "omit",
            timeout_secs: 20,
        })
        .await
    }
}