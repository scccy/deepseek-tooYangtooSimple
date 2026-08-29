use placegame_vip_client_lib::engine::db::Db;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db = Db::open(Path::new(&format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db")))?;
    let id: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(25);
    let limit: i64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(25);
    println!("=== #{} 最近 {} 条运行记录 ===", id, limit);
    let runs = db.recent_runs(Some(id), limit)?;
    for r in runs {
        let ts = r.finished_at;
        let day = ts / 1000 / 86400;
        println!("{} | {:?} | {} | {}", r.task, r.status, ts, r.detail);
    }
    Ok(())
}
