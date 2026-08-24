# dsh-openai-codex-oauth

[English](README.md)

为 DeepSeek Harness 的 `openai-codex` 提供方增加 ChatGPT 订阅 OAuth 登录能力。

这个包提供交互式登录、凭据保存、令牌刷新、登录状态查询和退出登录命令。Agent 运行时由 DeepSeek Harness 提供。OAuth 流程来自 `@earendil-works/pi-ai`，模型请求适配由 `@deepseek-ai/dsh-llm-pi-ai` 提供。

只是为了好玩。

## 工作方式

```text
DeepSeek Harness
  ├─ dsh-openai-codex-oauth
  │    └─ @earendil-works/pi-ai OAuth 实现
  │         └─ OpenAI 浏览器授权或设备码授权
  └─ @deepseek-ai/dsh-llm-pi-ai
       └─ openai-codex 模型请求
```

`@earendil-works/pi-ai` 以 JavaScript 库的形式运行在 Harness 进程中。Pi coding agent 应用及其 Agent 循环不参与这条调用链。

浏览器登录使用带 PKCE 的 OAuth 2.0 授权码流程，本机回调地址为 `http://localhost:1455/auth/callback`。回调成功页面可能显示 Pi 名称，因为页面 HTML 来自这个库。

## 环境要求

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `22.19.0` 或更高版本
- pnpm
- 具有 Codex 订阅访问权限的 OpenAI 账户
- 浏览器登录期间本机 TCP 端口 `1455` 可用

## 构建

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

最后一条命令会生成 `dsh-openai-codex-oauth-0.1.1.tgz`。

## 安装到 DeepSeek Harness

系统已经提供 `dsh` 命令时：

```sh
dsh plugin --profile web add ./dsh-openai-codex-oauth-0.1.1.tgz
dsh web
```

通过 `npx` 使用发布版 Harness 时：

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add ./dsh-openai-codex-oauth-0.1.1.tgz
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

包内的 Cordis 补丁会加载 `@deepseek-ai/dsh-llm-pi-ai`，把 `openai-codex` 提供方的访问令牌引用设为 `OPENAI_CODEX_ACCESS_TOKEN`，并加载当前插件。

## 登录

打开 Harness Web 界面并提交：

```text
/codex-login
```

在问题窗口中选择浏览器登录。命令也接受明确的登录方式：

```text
/codex-login browser
/codex-login device
```

授权完成后，在模型选择器中选择 `openai-codex` 提供方的模型。

## 命令

| 命令 | 功能 |
| --- | --- |
| `/codex-login [browser\|device]` | 发起 OAuth 授权并保存凭据。 |
| `/codex-status` | 显示凭据状态、来源和访问令牌到期时间。 |
| `/codex-logout` | 清除 OAuth 凭据和当前访问令牌。 |

## 配置

Harness 插件条目接受以下配置：

```yaml
- id: openai-codex-oauth
  name: dsh-openai-codex-oauth
  config:
    oauthCredentialRef: OPENAI_CODEX_OAUTH_CREDENTIAL
    refreshBeforeMs: 300000
```

完整 OAuth 凭据保存在 `OPENAI_CODEX_OAUTH_CREDENTIAL` 引用中，当前访问令牌保存在 `OPENAI_CODEX_ACCESS_TOKEN` 引用中。采用默认本机凭据来源时，Harness 通常会把这些值写入 `~/.dsh/.credentials.yaml`，文件权限由当前本机用户持有。

## 凭据安全与服务条款

OAuth 访问令牌和刷新令牌能够访问对应的 OpenAI 账户。请保护 Harness 凭据文件，将账户控制权保持在本人范围内，并在账户用量额度内使用。订阅访问受 OpenAI 服务条款和对应套餐规则约束。

Codex 后端及其请求格式可能发生变化。后续 OpenAI 或 `pi-ai` 版本可能带来兼容性更新需求。

## 致谢

本项目使用 DeepSeek Harness 官方的 [`@deepseek-ai/dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai) 适配器连接 Harness 大语言模型接口与 `pi-ai`，并使用 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) 提供的 OpenAI Codex OAuth 和模型提供方实现。

两个上游项目均采用 MIT 许可证发布。相关版权声明和完整许可文本收录在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。

## 项目说明

这是面向 DeepSeek Harness 的独立社区集成。OpenAI、DeepSeek 和 Pi 的名称及商标归各自权利人所有。

## 许可证

[MIT](LICENSE)
