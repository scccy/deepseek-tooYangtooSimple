# dsh-openai-codex-oauth

[简体中文](README.zh-CN.md)

ChatGPT subscription OAuth for the `openai-codex` provider in DeepSeek Harness.

This package adds interactive login, credential persistence, token refresh, login status, and logout commands. DeepSeek Harness remains the agent runtime. The package uses the OAuth implementation exposed by `@earendil-works/pi-ai` and the model adapter supplied by `@deepseek-ai/dsh-llm-pi-ai`.

Just for fun.

## How it works

```text
DeepSeek Harness
  ├─ dsh-openai-codex-oauth
  │    └─ @earendil-works/pi-ai OAuth implementation
  │         └─ OpenAI browser or device-code authorization
  └─ @deepseek-ai/dsh-llm-pi-ai
       └─ openai-codex model requests
```

`@earendil-works/pi-ai` runs as a JavaScript library inside Harness. The Pi coding-agent application and its agent loop do not participate in this integration.

The browser flow uses OAuth 2.0 Authorization Code with PKCE and a local callback at `http://localhost:1455/auth/callback`. A successful callback may display a Pi-branded local success page because that HTML is provided by the library.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `22.19.0` or newer
- pnpm
- An OpenAI account with Codex subscription access
- Local TCP port `1455` available during browser login

## Build

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

The last command creates `dsh-openai-codex-oauth-0.1.1.tgz`.

## Install into DeepSeek Harness

With a globally available `dsh` command:

```sh
dsh plugin --profile web add ./dsh-openai-codex-oauth-0.1.1.tgz
dsh web
```

With the published Harness package through `npx`:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add ./dsh-openai-codex-oauth-0.1.1.tgz
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

The bundled Cordis patch loads `@deepseek-ai/dsh-llm-pi-ai`, configures its `openai-codex` provider to read `OPENAI_CODEX_ACCESS_TOKEN`, and loads this plugin.

## Sign in

Open the Harness Web interface and submit:

```text
/codex-login
```

Select browser login in the prompt. The command also accepts an explicit method:

```text
/codex-login browser
/codex-login device
```

After authorization, select an `openai-codex` model from the model picker.

## Commands

| Command | Description |
| --- | --- |
| `/codex-login [browser\|device]` | Start OAuth authorization and store the credential. |
| `/codex-status` | Show credential state, source, and access-token expiry. |
| `/codex-logout` | Clear the stored OAuth credential and access token. |

## Configuration

The generated Harness plugin entry accepts:

```yaml
- id: openai-codex-oauth
  name: dsh-openai-codex-oauth
  config:
    oauthCredentialRef: OPENAI_CODEX_OAUTH_CREDENTIAL
    refreshBeforeMs: 300000
```

The plugin stores the complete OAuth credential under `OPENAI_CODEX_OAUTH_CREDENTIAL` and the current access token under `OPENAI_CODEX_ACCESS_TOKEN`. With the default local credential source, Harness commonly writes these values to `~/.dsh/.credentials.yaml` with permissions scoped to the local user.

## Security and service terms

OAuth access and refresh tokens grant access to the associated OpenAI account. Keep the Harness credential file private, keep the account under one user's control, and use the integration within the account's usage allowance. OpenAI service terms and plan-specific rules govern subscription access.

The Codex backend and its request format may change. A future OpenAI or `pi-ai` release can require a compatibility update.

## Acknowledgements

This project uses DeepSeek Harness's official [`@deepseek-ai/dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai) adapter to connect the Harness LLM interface with `pi-ai`. It uses [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) for the OpenAI Codex OAuth and provider implementations.

Both upstream projects are distributed under the MIT License. Their copyright notices and license texts are included in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Project status

This is an independent community integration for DeepSeek Harness. OpenAI, DeepSeek, and Pi retain their respective names and trademarks.

## License

[MIT](LICENSE)
