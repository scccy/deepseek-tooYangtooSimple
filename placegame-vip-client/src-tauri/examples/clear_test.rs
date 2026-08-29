use placegame_vip_client_lib::engine::db::Db;
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    let db = Db::open(Path::new(&format!("{home}/Library/Application Support/cn.placegame.vipclient/vip.db")))?;
    let before = db.recent_runs(None, 10000)?.len();
    let deleted = db.clear_runs(None)?;
    let after = db.recent_runs(None, 10000)?.len();
    println!("清空前: {before} 条 → 删除 {deleted} 条 → 清空后: {after} 条");
    Ok(())
}
