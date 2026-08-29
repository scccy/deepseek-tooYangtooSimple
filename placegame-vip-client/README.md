# PlaceGame VIP 收菜客户端（macOS）

为《复古打宝任务栏挂机》VIP 客户定制的**本地桌面收菜 + 公会协同客户端**。

## 📚 文档索引

| 文档 | 位置 |
|---|---|
| **收菜逻辑 + 客户端接口清单**（本工程） | `docs/收菜逻辑与接口文档.md` |
| 使用/构建说明（本工程） | `README.md` |
| 游戏玩法 + 全量 137 接口（游戏逆向） | `../placegame-docs/游戏玩法与流程接口.md` |

- 技术栈：**Tauri v2 + Rust 后端 + 纯静态 Web UI**（前端无需 Node/打包器，全链路只有 cargo）
- 数据：**本机 SQLite**（`~/Library/Application Support/cn.placegame.vipclient/vip.db`）
- 形态：桌面窗口 + 菜单栏托盘（显示主窗口 / 开始·停止收菜 / 退出）

## 它能做什么

1. **定时收菜**：后台常驻调度，自动完成
   - 挂机收益领取（容量 90% 触发，约 11h 一次；含"旅途奇遇"自动择一结算）
   - 邮件一键领取 + 清理（新号福利、每日登录、市场到账都走邮件）
   - 每日签到、每日活跃宝箱、成就奖励
2. **公会协同（养大号）**：
   - 大号当会长：创建公会 → 自动设为免审核入会 → 每日审批入会申请 → 每日领取公会分红
   - 120 个小号流水线：自动建角色 → 自动挂机练级到 **12 级**（公会入会门槛）→ 申请入会 → 加入后每日捐献背包材料
   - 所有状态写入本地 SQLite 的 `runs` 表（run_key 按北京日幂等，重跑安全）

## 构建与运行

前置依赖（仅需这些，**不需要 Node**）：

```bash
xcode-select --install            # 命令行工具（clang）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
```

开发调试（打开窗口）：

```bash
cd src-tauri
cargo run
```

打包成 .app / .dmg：

```bash
cargo install tauri-cli --version ^2 --locked     # 仅首次需要
cargo tauri build                                  # 产物在 target/release/bundle/
```

## 使用流程

1. `cargo run` 打开客户端。
2. **账号页**：添加大号（填正式账号密码，或留空创建游客大号）→ 批量创建小号（数量、职业）。
3. **公会页**：用大号创建公会（会返回 guildId）。
4. 点 **▶ 开始**：后台调度器按 30s tick 自动推进：
   - 大号：每日收菜 + 公会审批 + 分红
   - 小号：建角色 → 每 5 分钟练级一次 → 到 12 级自动入会 → 每日捐献
5. **日志页**实时查看每步结果；错误会记录为失败行，下轮自动重试。

## 架构

```
frontend/ (HTML/JS 调用 window.__TAURI__.core.invoke)
   │
src-tauri/src/
├── lib.rs            入口：窗口/托盘/命令层（add_main/add_alts/create_guild/…）
└── engine/
    ├── api.rs        HTTP 客户端（协议与线上前端一致：headers/responseState/426/401）
    ├── db.rs         SQLite：accounts / runs(幂等) / meta
    ├── auth.rs       guest 注册 / 正式登录 / 会话保活自动重登 / 北京日期
    ├── collect.rs    收菜引擎（邮件/签到/每日/成就/挂机收益+奇遇）
    ├── guild.rs      公会引擎（建会/练级/入会/审批/捐献/分红）
    └── scheduler.rs  后台调度（run_key 幂等 + 容量调度 + 5 分钟练级节流）
```

## 已实测 / 待验证

✅ 已实测（2026-08-25 线上环境）：
- `POST /api/auth/guest` 创建游客小号，返回 `sessionToken + generatedCredential(username/password)`
- `GET /api/client/bootstrap` 全量状态（32 个 section）
- `GET /api/client/catalog` 静态目录
- 公会入会等级约束：`joinRequiredLevel ?? 12`

⚠️ 待你在本地联调确认：
- 公会长视角下"待审批申请"的字段名（代码已做多候选兼容：`applications/pendingApplications/memberRequests`）
- 正式账号 `register` 流程（当前小号用 guest 自动注册；如需正式账号需补 register 接口）
- 街机免费局的 `actionId`（服务端随活动配置下发，本版未做自动街机）

⚠️ 安全提示：本版账号密码明文存于本地 SQLite（本机单用户）。量产给 VIP 前建议：
- 改用 macOS Keychain（`tauri-plugin-keyring` 或 Keychain Services）
- 服务端增加 VIP 权益字段（`bootstrap/profile` 下发）并按账号可回收
- 风控侧对托管账号白名单；频率保持低频（本客户端默认远低于真人操作）

## 已知取舍

- 单进程单实例，调度串行处理账号（120 小号全量一轮较慢，但每步有 meta/run_key 幂等，可随时中断续跑）
- 会话过期自动用本地凭证重登；`426` 版本过低会报错并提示更新客户端