# dsh-token-meter-scccy

DSH **token 用量统计插件**(个人定制版,包名带 `-scccy` 后缀,与官方内置的 `@deepseek-ai/dsh-token-meter` 区分;官方那份保留,它的 `ctx.tokenMeter` 服务被 `dsh-compaction-basic` 硬依赖):在设置面板新增「Token 用量」页,统计每一天、每个模型、每个时段的真实 token 消耗(含提示词缓存命中拆分),并提供每日用量热点图。

## 功能

- **采集**:宿主端包装 `llm/stream` 瀑布,从每次模型调用的最后一个 chunk 提取 provider 返回的真实 usage
  - 兼容 `prompt_tokens`/`completion_tokens`(snake_case)、`input_tokens`/`output_tokens`(DeepSeek)、`promptTokens`/`completionTokens`(camelCase) 等字段命名
  - 缓存字段兼容 DeepSeek(`prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`)、Anthropic(`cache_read_input_tokens`/`cache_creation_input_tokens`)、OpenAI Responses(`input_tokens_details.cached_tokens`);只报命中数时按 `input − hit` 推导未命中
- **聚合**:按 天/模型/小时 三维聚合,聚合计算下沉到 SQLite(每天 2 张表的 UPSERT,按需 `GROUP BY` 查询),宿主进程**零聚合缓存,内存不随数据增长**
- **持久化**:`~/.dsh/token-meter/meter.db`(SQLite,`node:sqlite` 内置,无第三方依赖;WAL 模式,宿主直连,无文件沙箱限制)。旧版 `usage-YYYYMM.json` 首次启动自动导入后改名为 `*.json.migrated`
- **缓存拆分**:直接消费宿主 `llm/stream` 末尾的 `{ type: "usage", usage: TokenUsage }` 标准化 chunk(字段为 disjoint camelCase:`inputTokens` 仅含未命中部分,`cacheReadTokens` 命中、`cacheWriteTokens` 写入另计,计费输入 = 三者之和);同时兼容 raw OpenAI/DeepSeek 形状(`prompt_tokens` + `prompt_tokens_details.cached_tokens` 等,只报命中数时按 `input − hit` 推导未命中)
- **API**(浏览器端 fetch):
  - `POST /api/dsh-tokmeter/summary` `{ "month": "YYYY-MM" }` → 月度汇总
  - `POST /api/dsh-tokmeter/months` `{}` → 已统计月份列表
- **界面**(设置 → Token 用量,位于「模型」与「插件」之间):
  - 月份切换(◀ ▶ / 下拉)+ 每 30 秒自动刷新
  - 单位切换:自动 / tok / K / M / B
  - 月度总览:总使用量、输入、输出(附缓存命中/写入拆分)、缓存命中率、请求次数、日均
  - 每日使用量,双视图:用量堆叠(缓存命中 / 未命中输入 / 输出)与缓存命中率
  - 每日用量热点图(GitHub 风格,按周一列起的 7 列月历,支持 用量 / 请求次数 / 缓存命中率 三档强度,悬停显示明细)
  - 按模型分布(比例条 + 输入/输出/缓存率/次数)
  - 按小时时段分布(24 柱)

## 目录

```
dsh-token-meter/              # 包名 dsh-token-meter-scccy
├── package.json          # dsh 双面插件声明 (host + dsh.client)
├── cordis.patch.yml      # 挂载补丁: insert 一条插件行 (id token-meter-scccy)
├── lib/
│   ├── index.js          # 宿主半: 采集 + 聚合 + 持久化 + HTTP API
│   └── client.js         # 浏览器半: 设置页 UI
└── README.md
```

## 安装(web profile)

1. 将本包加入 web profile 的 bundles 与依赖:

```json
{
  "dsh": { "profile": { "bundles": [ "...", "dsh-token-meter-scccy" ] } },
  "dependencies": { "dsh-token-meter-scccy": "file:../dsh-token-meter" }
}
```

2. 在 profile 目录安装依赖:

```bash
pnpm install
```

3. 重启应用(客户端 bundle 在启动时重建并结合 profile patch)。

## 数据说明

- 统计从插件挂载之后开始;历史数据在 SQLite 中持续累积。
- **缓存命中率 = 命中的输入 token ÷ 全部计费输入 token**(`cacheHit / input`,其中 `input` = 未命中输入 + 缓存命中 + 缓存写入);网关/模型不返回任何缓存字段时,界面显示 `—` 并标注「暂无缓存数据」,而不是误导性的 0%。
- 每次模型调用落两条 UPSERT(**日×模型**、**日×小时**),写入即持久,无内存堆积。
- 诊断:当某次调用上报了 usage 但**不含缓存字段**时,会以去重、有上限(40 条)的方式把该 usage 的原始键集合写入 `~/.dsh/token-meter/diag-usage.jsonl`,便于确认网关实际返回的字段形状(可随时删除)。
- 数据库 Schema(v1):

```sql
CREATE TABLE day_model (
  day   TEXT NOT NULL,          -- YYYY-MM-DD
  model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  cache_hit  INTEGER NOT NULL DEFAULT 0,
  cache_miss INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
CREATE TABLE hour_agg (
  day  TEXT NOT NULL,           -- YYYY-MM-DD
  hour INTEGER NOT NULL,        -- 0-23
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour)
);
```