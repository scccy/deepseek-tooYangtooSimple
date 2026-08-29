# PlaceGame 官方 CLI 0.2.50 —— 接口差异审计

> 审计对象：`/Users/scccy/Downloads/PlaceGame-CLI-0.2.50/placegame-cli.mjs`
> 对比基准：线上 web bundle 0.2.50（`index-DU2n-9tk.js`）+ 我们既有文档《游戏玩法与流程接口.md》/客户端实现
> 审计日期：2026-08-26

## 结论概览

官方 CLI 暴露了一套 **web 前端不用的"只读查询视图层"（read-model API）**，以及少量新动作接口。web 前端走 `bootstrap + view-sections`，CLI 走 `dynamic-view + */list|view` —— 两者是**两套查询入口，同一份后端状态**。以下为**我们文档里没有记录在案**的部分。

---

## 一、新增接口（未记录在案）

### A. 只读查询视图层（CLI 专用）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/client/status` | GET | 挂机实时状态（realtimeChannel=game） |
| `/api/client/dynamic-view` | POST | **通用列表查询**：`select` 参数 + responseState=patch；CLI 的 `listFromView` 用它读 首领/背包 等列表（相对 view-sections 的另一套查询） |
| `/api/client/drop-notices` | GET | 掉落/通知日志（presenter=messages） |
| `/api/character/profile` | GET | 角色资料（presenter=profile） |
| `/api/equipment/list` | GET | 装备列表（presenter=equipment） |
| `/api/inventory/list` | GET | 背包列表（presenter=inventory） |
| `/api/mail/list` | GET | 邮件列表 |
| `/api/guild/view` | GET | 公会视图（referenceSelect=directory） |
| `/api/arcade/view` | GET | 街机/娱乐场视图 |
| `/api/professions/view` | GET | 副职业视图 |
| `/api/boss/world-status` | GET | 世界首领状态（realtimeChannel=worldBoss） |
| `/api/market/orders` | GET | 市场列表（filter=marketSales） |
| `/api/market/order-detail` | GET **bodyOnGet** | 订单详情（GET 带 body `orderId`） |
| `/api/market/my-trades` | GET | 我的成交记录 |

### B. 排行查询（web 动态拼、未列字面路径，现补全 12 条）

`/api/ranking/summary`、`/api/ranking/power`（战力榜）、`/api/ranking/level`（等级榜）、`/api/ranking/wealth`（财富榜）、`/api/ranking/boss`（首领击杀榜）、`/api/ranking/equipment`（装备评分榜）、`/api/ranking/guild`（公会榜）、`/api/ranking/market`（市场成交榜）、`/api/ranking/popularity`（人气榜）、`/api/ranking/season`（赛季榜）、`/api/ranking/arcadeWin`、`/api/ranking/arcadeLoss`（街机盈亏榜）

### C. 新动作接口（未记录在案，可能有功能缺口）

| 接口 | 方法 | 说明 | 影响 |
|---|---|---|---|
| `/api/boss/claim-reward` | POST | **首领战奖励领取**（realtimeChannel=worldBoss） | ⚠️ 我们客户端挑战/assist 后**没有调用领奖**，奖励可能未入账 → 需要补 |
| `/api/client/read-notice` | POST | 通知标已读（`noticeId`） | 小，可忽略 |

### D. 功能已记录、路径未字面记录

- `POST /api/auth/ws-ticket` —— 我们文档已记录（web 前端模板拼接，字面量未命中属正常）。
- `POST /api/chat/world/image` —— 聊天图片上传：`filePath/content/replyToMessageId/mentionUserIds`，上限 **2MB**（头像 3MB）。

---

## 二、web 有 / CLI 无（反向差异）

- `linuxdo/{bind,register,start}` —— **CLI 不支持 Linux DO 登录**；
- `/api/client/collect`、`/api/client/view-sections`、`/api/client/window-state`、`/api/client/announcements`、`/api/character/change-map` —— CLI 分别用 `idle-summary/collect?`、`dynamic-view`、无窗口概念、`drop-notices` 等替代，属形态差异。

---

## 三、CLI 客户端行为差异（未记录在案）

- **会话存储**：`~/.placegame-cli/PlaceGame CLI/session.json`（Windows 下 DPAPI 加密）；设备指纹 `device-id.txt`（`device_<24字节hex>`，192 位）。
- **自动更新**：拉取更新清单 manifest（`version/url/sha256/size`）→ 校验 **SHA-256** 后下载替换；`426` → 退出码 `UPDATE_REQUIRED=4`。
- 退出码协议：`OK0 / USAGE2 / AUTH3 / UPDATE_REQUIRED4 / NETWORK5 / SERVER6 / CANCELLED130`。
- 请求封装与 web 一致：`x-placegame-client-version: 0.2.50`、`x-placegame-response-state`、`authorization Bearer`。

---

## 四、建议行动（按优先级）

1. **补 `/api/boss/claim-reward`**：首领（个人/地图/世界）结算后调用领奖，否则奖励漏领（realtimeChannel=worldBoss，说明与实时场次联动）。
2. **可选接入 read-model**：`/api/*/list|view` + `dynamic-view` 可作为轻量查询替代 bootstrap，减少拉取体积。
3. 将本文件中 C/A 两节并入主接口文档。