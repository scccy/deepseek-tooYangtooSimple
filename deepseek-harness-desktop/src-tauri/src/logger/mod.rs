use log::{Level, LevelFilter, Metadata, Record};
use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

/// 日志级别对应数值（数值越大，日志越不敏感/级别越高）
const TRACE: u8 = 0;
const DEBUG: u8 = 1;
const INFO: u8 = 2;
const WARN: u8 = 3;
const ERROR: u8 = 4;
const OFF: u8 = 5;

/// 将 `log::Level` 转换为内部比较数值
#[inline]
const fn level_to_u8(level: Level) -> u8 {
    match level {
        Level::Trace => TRACE,
        Level::Debug => DEBUG,
        Level::Info => INFO,
        Level::Warn => WARN,
        Level::Error => ERROR,
    }
}

/// 模块级过滤规则
struct FilterRule {
    target: String,
    level: u8,
}

/// 第三方网络库默认降噪规则：即使全局开启 Debug，也不打印 reqwest/hyper 的调试刷屏。
/// 如果用户显式指定了类似 `RUST_LOG=reqwest=debug`，会优先覆盖此处的默认值。
const DEFAULT_NOISY_RULES: &[(&str, u8)] = &[("reqwest", WARN), ("hyper", WARN)];

static FILTER_LEVEL: AtomicU8 = AtomicU8::new(INFO);
static FILTER_RULES: OnceLock<Vec<FilterRule>> = OnceLock::new();

/// 自定义轻量级日志格式化器
struct SimpleLogger;

impl log::Log for SimpleLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let record_level = level_to_u8(metadata.level());
        let current_level = FILTER_LEVEL.load(Ordering::Relaxed);
        let module_path = metadata.target();

        let mut effective_level = current_level;

        if let Some(rules) = FILTER_RULES.get() {
            // 1. 优先匹配显式配置的模块规则（匹配前缀最长者优先）
            if let Some(rule) = most_specific_rule(module_path, rules) {
                effective_level = rule.level;
            } else {
                // 2. 未显式配置时，对指定的第三方高噪库应用默认过滤规则
                for &(target, default_level) in DEFAULT_NOISY_RULES {
                    if module_matches(module_path, target) {
                        effective_level = effective_level.max(default_level);
                        break;
                    }
                }
            }
        }

        record_level >= effective_level
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let module_path = record.module_path().unwrap_or("unknown");

        // 优化点：获取 I/O 句柄锁并使用 writeln! 直接输出，避免 format! 导致的额外内存分配
        if record.level() == Level::Error {
            let stderr = std::io::stderr();
            let mut handle = stderr.lock();
            let _ = writeln!(handle, "[{}]: {}", module_path, record.args());
            let _ = handle.flush();
        } else {
            let stdout = std::io::stdout();
            let mut handle = stdout.lock();
            let _ = writeln!(handle, "[{}]: {}", module_path, record.args());
            let _ = handle.flush();
        }
    }

    fn flush(&self) {
        let _ = std::io::stdout().lock().flush();
        let _ = std::io::stderr().lock().flush();
    }
}

static LOGGER: SimpleLogger = SimpleLogger;

/// 将字符串解析为日志级别，无法识别时返回 `None`
fn parse_level(input: &str) -> Option<u8> {
    match input.trim().to_ascii_lowercase().as_str() {
        "trace" => Some(TRACE),
        "debug" => Some(DEBUG),
        "info" => Some(INFO),
        "warn" => Some(WARN),
        "error" => Some(ERROR),
        "off" => Some(OFF),
        _ => None,
    }
}

/// 判断 `module_path` 是否命中 `target`（如 `reqwest` 可匹配 `reqwest::connect`）
fn module_matches(module_path: &str, target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    module_path == target
        || module_path
            .strip_prefix(target)
            .is_some_and(|rest| rest.starts_with("::"))
}

/// 获取匹配最精确的显式规则（匹配前缀越长，优先级越高）
fn most_specific_rule<'a>(module_path: &str, rules: &'a [FilterRule]) -> Option<&'a FilterRule> {
    rules
        .iter()
        .filter(|rule| module_matches(module_path, &rule.target))
        .max_by_key(|rule| rule.target.len())
}

/// 解析 `RUST_LOG` 指令，支持形如 `debug,reqwest=warn,hyper=warn` 的过滤语法
fn parse_directives(input: &str) -> (Option<u8>, Vec<FilterRule>) {
    let mut global = None;
    let mut rules = Vec::new();

    for part in input.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((target, level_str)) = part.split_once('=') {
            let target = target.trim();
            if let Some(level) = parse_level(level_str) {
                if !target.is_empty() {
                    rules.push(FilterRule {
                        target: target.to_string(),
                        level,
                    });
                }
            }
        } else if let Some(level) = parse_level(part) {
            global = Some(level);
        }
    }

    (global, rules)
}

/// 初始化日志系统
///
/// 默认日志级别为 `info`，可以通过环境变量 `RUST_LOG` 进行控制。
/// 例如: `RUST_LOG=debug` 或 `RUST_LOG=debug,reqwest=warn,hyper=warn`
pub fn init() {
    let log_level = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());

    let (global, rules) = parse_directives(&log_level);
    let filter = global.unwrap_or(INFO);

    FILTER_LEVEL.store(filter, Ordering::Relaxed);
    let _ = FILTER_RULES.set(rules);

    log::set_logger(&LOGGER)
        .map(|()| log::set_max_level(LevelFilter::Trace))
        .expect("Failed to initialize logger");
}