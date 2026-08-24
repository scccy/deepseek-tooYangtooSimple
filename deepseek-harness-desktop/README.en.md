<p align="center">
  <a href="https://github.com/hairyf/deepseek-harness-desktop">
    <img src="public/favicon.svg" width="96" alt="DeepSeek Harness Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Desktop</h1>

<p align="center">
  Run <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> on your desktop, instantly —<br />
  no Node.js, no pnpm, no Docker. Download, install, go.
</p>

<p align="center">
  <a href="https://github.com/hairyf/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/hairyf/deepseek-harness-desktop?style=flat-square&label=release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/downloads/hairyf/deepseek-harness-desktop/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/hairyf/deepseek-harness-desktop?style=flat-square&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/license/hairyf/deepseek-harness-desktop?style=flat-square&label=license&color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
</p>

<p align="center">
  <samp><strong>English</strong> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
  <img src="./docs/images/hero-en.png" width="100%" alt="DSH Desktop English promotional banner" />
</p>

## Features

- ⚡️ **Zero setup** — First launch bootstraps the bundled Node runtime and Harness core automatically; a compatible local Node / Pnpm setup is reused as-is when present.
- 🔄 **Self-healing core** — Every launch syncs with the latest upstream Harness release, so upstream fixes reach you without reinstalling.
- 🔒 **Local & private by default** — Runs on `127.0.0.1:3080`. Profiles, sessions and settings stay on your machine; telemetry is off by default.
- 🪶 **Native & lightweight** — A Tauri 2 shell (not Electron): smaller installers, lower memory, native windows. Windows / macOS / Linux, bilingual UI.
- ⌨️ **CLI ready** — Registers `dsh` commands (`*/bin`) after install, ready in a new terminal.
- 🧭 **First-run wizard** — On first launch, pick the recommended plugins (e.g. the dsh-market plugin store) and watch the install stream in real time; skip anytime and reopen later from the sidebar.

## Presets

Plugins offered on the first-run wizard; select what you need and install on demand:

- [DSH Win Terminal Inspector](https://github.com/clearkurt/dsh-win-terminal-inspector) — Windows-only fix for Minimal mode
- [DSH Tauri](https://github.com/hairyf/dsh-tauri) — desktop message bridge: a communication channel with the Tauri 2 shell (Recommended)
- [DSH Market](https://github.com/dsh-market/dsh-market) — the visual plugin market: browse, search, and one-click install community plugins (Recommended)
- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — a VSCode-like right sidebar (explorer/editor/terminal/git/browser), isolated per session (Recommended)
- [DSH Notification](https://github.com/omdsh-dev/dsh-notification) — desktop notifications when a turn finishes: per-outcome toggles plus include/exclude keyword rules
- [DSH Session Context Menu](https://github.com/baihejiangnan/dsh-session-context-menu) — right-click context menu for the DSH app shell: quick actions for conversations, workspaces, inputs, and links

> Want to add new presets? Modify [preset-plugins.json](https://github.com/hairyf/deepseek-harness-desktop/blob/main/src-tauri/resources/preset-plugins.json) and submit a PR.

## Quick Start

Download the installer for your platform from [Releases](https://github.com/hairyf/deepseek-harness-desktop/releases), install, and launch.

The first run downloads the Node runtime and Harness core (~a few hundred MB) and takes you straight into the harness at `http://127.0.0.1:3080`. Everything after that runs locally — no network required.

**Requirements:** Windows 10+ (64-bit) · macOS 10.15+ · Linux (AppImage) · network on first launch

## Dev

Want to get involved in the development? See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## How It Works

```text
┌──────────────────────────────────────────────┐
│ Tauri WebView (React)                        │
│   setup state machine → progress → iframe    │
│   loads the dsh web UI + sidebar controls    │
└──────────────────────┬───────────────────────┘
                       │ invoke commands + events
┌──────────────────────┴───────────────────────┐
│ Tauri Rust backend                           │
│   service/download  installer + extraction   │
│   service/workflow  dsh process lifecycle    │
│   task              dsh health checks        │
└──────┬───────────────────────────┬───────────┘
       │                           │
  runtime/ (Node.js v22.22.0)   dependencies/dsh/ (prebuilt bundle)
       └─────────────┬─────────────┘
                     ▼
   dsh --profile web --host 127.0.0.1 --port 3080
                     │  DSH_HOME=<app-data>/data/dsh
                     ▼
        http://127.0.0.1:3080/  ← embedded UI
```

The prebuilt Harness bundle is published by [deepseek-harness-pkg](https://github.com/hairyf/deepseek-harness-pkg). Every launch diffs the installed bundle against the latest release and re-downloads when outdated — keeping the local install when GitHub is unreachable.

## Notes

> [!WARNING]
> **Developer preview** — upstream `dsh` is evolving fast with breaking changes; this project tracks it closely.

> [!IMPORTANT]
> **macOS Gatekeeper** — the app is not notarized; allow it once via System Settings → Privacy & Security → Open Anyway.

> [!NOTE]
> **Security** — `dsh` can execute code locally. For learning / research / testing only; run it in a trusted, isolated environment.

## Related

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — the upstream `dsh` agent platform
- [deepseek-harness-pkg](https://github.com/hairyf/deepseek-harness-pkg) — prebuilt Harness bundles consumed by this app
- [n8n-desktop](https://github.com/tangtao646/n8n-desktop) — reference implementation

## License

[MIT](./LICENSE) with a [Non-Commercial Condition](./LICENSE.details) © deepseek-harness-desktop contributors
