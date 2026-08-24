use std::time::Duration;

/// 捆绑的 Node.js 运行时版本（满足 v22.15.0+ / v23.8.0+ 的要求）
pub const NODE_VERSION: &str = "v22.22.0";

/// Node.js 官方下载地址
pub const NODE_BASE_URL: &str = "https://nodejs.org/dist/";

/// 打包的 DeepSeek Harness 发行版下载地址（GitHub Release）
pub const DSH_CORE_URL: &str =
    "https://github.com/hairyf/deepseek-harness-pkg/releases/latest/download/";

/// 捆绑的 pnpm 版本（与 deepseek-harness-pkg 的 packageManager: pnpm@11.7.0 对齐）
pub const PNPM_VERSION: &str = "11.7.0";

/// pnpm 官方 npm registry tarball 下载地址前缀（纯 JS 发行，全平台同一 URL）
pub const PNPM_BASE_URL: &str = "https://registry.npmjs.org/pnpm/-/";

/// Harness 服务地址与默认端口
pub const DSH_HOST: &str = "http://127.0.0.1";
/// 生产（release）默认端口
pub const DSH_PORT: u16 = 3080;
/// 开发（debug）默认端口：与生产隔离，避免 `pnpm tauri dev` 与已安装桌面端
/// 争用同一个 3080 端口冲突。
pub const DSH_DEV_PORT: u16 = 3081;

/// 安装目录与 CLI 入口（相对安装目录）
pub const DSH_CORE_DIR: &str = "dsh";
pub const DSH_ENTRY_RELATIVE: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";
pub const DSH_MANIFEST_RELATIVE: &str = "package.json";

/// pnpm 安装目录与 CLI 入口（相对安装目录）
pub const PNPM_CORE_DIR: &str = "pnpm";
pub const PNPM_ENTRY_RELATIVE: &str = "bin/pnpm.cjs";

/// 数据目录名（$DSH_HOME 的相对目录）
pub const DSH_DATA_DIR_NAME: &str = "dsh";

/// 简单 Store 持久化
pub const STORE_DAT_FILE: &str = ".store.dat";
pub const STORE_SETTING_KEY: &str = "setting";

/// 健康检查超时
pub const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
