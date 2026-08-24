use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

/// 检查 Harness 是否真正在运行（探测指定端口，随配置端口联动）
pub async fn is_dsh_running(port: u16) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok(); // 将 Result 转为 Option

    // 如果 client 创建失败，直接返回 false
    let client = match client {
        Some(c) => c,
        None => return false,
    };

    let url = format!("{}/", crate::config::get_dsh_service_url(port));

    // 发送请求并判断是否就绪
    let check_status = async {
        let resp = client.get(&url).send().await.ok()?;
        if resp.status() != reqwest::StatusCode::OK {
            return None;
        }
        Some(true)
    };

    check_status.await.unwrap_or(false)
}

/// 检查指定端口是否被占用（通过尝试连接来判断）
pub fn is_port_in_use(port: u16) -> bool {
    // 尝试连接到端口，设置较短的超时时间（100ms）以快速检测
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap_or_else(|_| {
        // 如果解析失败，返回一个默认地址（虽然不太可能发生）
        "127.0.0.1:0".parse().unwrap()
    });

    TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok()
}

/// 在独立线程中读取子进程的输出，同时写入日志文件
///
/// # 参数
/// - `stdout`: 子进程的标准输出
/// - `stderr`: 子进程的标准错误输出
/// - `log_path`: 前端日志面板读取的日志文件
pub fn spawn_output_readers<R1, R2>(
    stdout: Option<R1>,
    stderr: Option<R2>,
    log_path: PathBuf,
) where
    R1: Read + Send + 'static,
    R2: Read + Send + 'static,
{
    // 在独立线程中读取 stdout
    if let Some(stdout) = stdout {
        let log_path = log_path.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        log::info!("[dsh::stdout]: {}", line);
                        append_log(&log_path, &line);
                    }
                    Err(e) => {
                        log::error!("Failed to read dsh stdout: {}", e);
                        break;
                    }
                }
            }
        });
    }

    // 在独立线程中读取 stderr
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        log::warn!("[dsh::stderr]: {}", line);
                        append_log(&log_path, &line);
                    }
                    Err(e) => {
                        log::error!("Failed to read dsh stderr: {}", e);
                        break;
                    }
                }
            }
        });
    }
}

fn append_log(log_path: &PathBuf, line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(file, "{}", line);
    }
}
