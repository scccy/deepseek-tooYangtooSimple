//! 本地 SQLite 存储：账号 / 任务运行记录（幂等）/ meta 元数据
//! 数据库文件：~/Library/Application Support/cn.placegame.vipclient/vip.db

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct Account {
    pub id: i64,
    pub role: String, // "main" | "alt"
    pub username: String,
    pub password: String,
    pub user_id: String,
    pub nickname: String,
    pub job: String,
    pub device_id: String,
    pub session_token: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunRow {
    pub account_id: i64,
    pub task: String,
    pub run_key: String,
    pub status: String,
    pub detail: String,
    pub started_at: i64,
    pub finished_at: i64,
}

pub struct Db {
    conn: Connection,
}

fn row_to_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        account_id: r.get(0)?,
        task: r.get(1)?,
        run_key: r.get(2)?,
        status: r.get(3)?,
        detail: r.get(4)?,
        started_at: r.get(5)?,
        finished_at: r.get(6)?,
    })
}

impl Db {
    // （见下方 recent_runs）
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS accounts(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              role TEXT NOT NULL DEFAULT 'alt',
              username TEXT NOT NULL,
              password TEXT NOT NULL DEFAULT '',
              user_id TEXT NOT NULL DEFAULT '',
              nickname TEXT NOT NULL DEFAULT '',
              job TEXT NOT NULL DEFAULT 'warrior',
              device_id TEXT NOT NULL DEFAULT '',
              session_token TEXT,
              enabled INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs(
              account_id INTEGER NOT NULL,
              task TEXT NOT NULL,
              run_key TEXT NOT NULL,
              status TEXT NOT NULL,
              detail TEXT NOT NULL DEFAULT '',
              started_at INTEGER NOT NULL,
              finished_at INTEGER NOT NULL,
              PRIMARY KEY(account_id, task, run_key)
            );
            CREATE TABLE IF NOT EXISTS meta(
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_runs_finished ON runs(finished_at DESC);
            CREATE TABLE IF NOT EXISTS inventory_snapshot(
              account_id INTEGER NOT NULL,
              item_key TEXT NOT NULL,
              item_type TEXT NOT NULL DEFAULT '',
              item_name TEXT NOT NULL DEFAULT '',
              amount INTEGER NOT NULL DEFAULT 0,
              bind_status TEXT NOT NULL DEFAULT '',
              captured_at INTEGER NOT NULL,
              PRIMARY KEY(account_id, item_key)
            );
            CREATE TABLE IF NOT EXISTS boss_progress(
              account_id INTEGER NOT NULL,
              boss_key TEXT NOT NULL,
              best_difficulty TEXT NOT NULL DEFAULT 'normal',
              best_index INTEGER NOT NULL DEFAULT 0,
              last_result TEXT NOT NULL DEFAULT '',
              target_slot TEXT NOT NULL DEFAULT '',
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(account_id, boss_key)
            );
            CREATE TABLE IF NOT EXISTS boss_farm(
              account_id INTEGER PRIMARY KEY,
              current_boss_key TEXT NOT NULL DEFAULT '',
              target_slot TEXT NOT NULL DEFAULT '',
              grad_quality INTEGER NOT NULL DEFAULT 2,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS boss_graduate(
              account_id INTEGER NOT NULL,
              boss_key TEXT NOT NULL,
              slot TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(account_id, boss_key, slot)
            );
            CREATE TABLE IF NOT EXISTS equipment_snapshot(
              account_id INTEGER NOT NULL,
              equipment_id TEXT NOT NULL,
              slot TEXT NOT NULL DEFAULT '',
              name TEXT NOT NULL DEFAULT '',
              quality TEXT NOT NULL DEFAULT '',
              enhance_level INTEGER NOT NULL DEFAULT 0,
              score INTEGER NOT NULL DEFAULT 0,
              bind_status TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT '',
              equip_level INTEGER NOT NULL DEFAULT 0,
              set_key TEXT NOT NULL DEFAULT '',
              rare_rank TEXT NOT NULL DEFAULT '',
              captured_at INTEGER NOT NULL,
              PRIMARY KEY(account_id, equipment_id)
            );
            "#,
        )?;
        // 旧库迁移：补 item_name 列（重复执行无害）
        let _ = conn.execute("ALTER TABLE inventory_snapshot ADD COLUMN item_name TEXT NOT NULL DEFAULT ''", []);
        // 旧库迁移：boss_farm 补 grad_quality 列（重复执行无害）
        let _ = conn.execute("ALTER TABLE boss_farm ADD COLUMN grad_quality INTEGER NOT NULL DEFAULT 2", []);
        // 旧库迁移：equipment_snapshot 补 set_key / rare_rank 列（套装进度统计用）
        let _ = conn.execute("ALTER TABLE equipment_snapshot ADD COLUMN set_key TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE equipment_snapshot ADD COLUMN rare_rank TEXT NOT NULL DEFAULT ''", []);
        // runs 表自动修剪：时间戳型 run_key（idle/equip/decompose/level/map…）每轮写新行，
        // 不清理会无限膨胀。保留最近 14 天（所有幂等键都是日粒度，14 天足够安全）。
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if now_ms > 0 {
            let cutoff = now_ms - 14 * 24 * 3600_000i64;
            let _ = conn.execute("DELETE FROM runs WHERE finished_at < ?1 AND finished_at > 0", params![cutoff]);
        }
        Ok(Self { conn })
    }

    fn row_to_account(r: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
        Ok(Account {
            id: r.get(0)?,
            role: r.get(1)?,
            username: r.get(2)?,
            password: r.get(3)?,
            user_id: r.get(4)?,
            nickname: r.get(5)?,
            job: r.get(6)?,
            device_id: r.get(7)?,
            session_token: r.get(8)?,
            enabled: r.get::<_, i64>(9)? != 0,
            created_at: r.get(10)?,
        })
    }

    pub fn insert_account(&self, a: &Account) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO accounts(role,username,password,user_id,nickname,job,device_id,session_token,enabled,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                a.role,
                a.username,
                a.password,
                a.user_id,
                a.nickname,
                a.job,
                a.device_id,
                a.session_token,
                i64::from(a.enabled),
                a.created_at,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn find_by_username(&self, username: &str) -> rusqlite::Result<Option<Account>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,role,username,password,user_id,nickname,job,device_id,session_token,enabled,created_at FROM accounts WHERE username=?1")?;
        let mut rows = stmt.query(params![username])?;
        match rows.next()? {
            Some(r) => Ok(Some(Self::row_to_account(r)?)),
            None => Ok(None),
        }
    }

    pub fn get_account(&self, id: i64) -> rusqlite::Result<Option<Account>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,role,username,password,user_id,nickname,job,device_id,session_token,enabled,created_at FROM accounts WHERE id=?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(r) => Ok(Some(Self::row_to_account(r)?)),
            None => Ok(None),
        }
    }

    pub fn list_accounts(&self) -> rusqlite::Result<Vec<Account>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,role,username,password,user_id,nickname,job,device_id,session_token,enabled,created_at FROM accounts ORDER BY role DESC, id ASC")?;
        let rows = stmt.query_map([], |r| Self::row_to_account(r))?;
        rows.collect()
    }

    pub fn mains(&self) -> rusqlite::Result<Vec<Account>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,role,username,password,user_id,nickname,job,device_id,session_token,enabled,created_at FROM accounts WHERE role='main' ORDER BY id ASC LIMIT 1")?;
        let rows = stmt.query_map([], |r| Self::row_to_account(r))?;
        rows.collect()
    }

    pub fn update_session(&self, id: i64, token: Option<&str>) -> rusqlite::Result<()> {
        self.conn
            .execute("UPDATE accounts SET session_token=?1 WHERE id=?2", params![token, id])?;
        Ok(())
    }

    pub fn update_nickname_job(&self, id: i64, nickname: &str, job: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE accounts SET nickname=?1, job=?2 WHERE id=?3",
            params![nickname, job, id],
        )?;
        Ok(())
    }

    pub fn update_credentials(&self, id: i64, username: &str, password: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE accounts SET username=?1, password=?2 WHERE id=?3",
            params![username, password, id],
        )?;
        Ok(())
    }

    pub fn set_enabled(&self, id: i64, enabled: bool) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE accounts SET enabled=?1 WHERE id=?2",
            params![i64::from(enabled), id],
        )?;
        Ok(())
    }

    pub fn delete_account(&self, id: i64) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM accounts WHERE id=?1", params![id])?;
        self.conn
            .execute("DELETE FROM runs WHERE account_id=?1", params![id])?;
        Ok(())
    }

    pub fn touch_run(
        &self,
        row: &RunRow,
        force_replace: bool,
    ) -> rusqlite::Result<()> {
        let sql = if force_replace {
            "INSERT OR REPLACE INTO runs(account_id,task,run_key,status,detail,started_at,finished_at) VALUES(?1,?2,?3,?4,?5,?6,?7)"
        } else {
            "INSERT OR IGNORE INTO runs(account_id,task,run_key,status,detail,started_at,finished_at) VALUES(?1,?2,?3,?4,?5,?6,?7)"
        };
        self.conn.execute(
            sql,
            params![
                row.account_id,
                row.task,
                row.run_key,
                row.status,
                row.detail,
                row.started_at,
                row.finished_at
            ],
        )?;
        Ok(())
    }

    pub fn get_run(&self, account_id: i64, task: &str, run_key: &str) -> rusqlite::Result<Option<RunRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT account_id,task,run_key,status,detail,started_at,finished_at FROM runs WHERE account_id=?1 AND task=?2 AND run_key=?3",
        )?;
        let mut rows = stmt.query(params![account_id, task, run_key])?;
        match rows.next()? {
            Some(r) => Ok(Some(RunRow {
                account_id: r.get(0)?,
                task: r.get(1)?,
                run_key: r.get(2)?,
                status: r.get(3)?,
                detail: r.get(4)?,
                started_at: r.get(5)?,
                finished_at: r.get(6)?,
            })),
            None => Ok(None),
        }
    }

    pub fn recent_runs(&self, account_id: Option<i64>, limit: i64) -> rusqlite::Result<Vec<RunRow>> {
        let sql = match account_id {
            Some(_) => "SELECT account_id,task,run_key,status,detail,started_at,finished_at FROM runs WHERE account_id=?1 ORDER BY finished_at DESC LIMIT ?2".to_string(),
            None => "SELECT account_id,task,run_key,status,detail,started_at,finished_at FROM runs ORDER BY finished_at DESC LIMIT ?1".to_string(),
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = if let Some(id) = account_id {
            stmt.query_map(params![id, limit], row_to_run)?
        } else {
            stmt.query_map(params![limit], row_to_run)?
        };
        rows.collect()
    }

    /// 自某时间点起某任务已完成(ok)的账号 id 集合。
    /// 替代"recent_runs 大窗口扫描"：runs 行数超过窗口时窗口法会漏算旧账号的今日记录，
    /// 导致「今日完成度/补收」误判未完成而重复执行。
    pub fn done_account_ids_since(&self, task: &str, since_ms: i64) -> rusqlite::Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT account_id FROM runs WHERE task=?1 AND status='ok' AND finished_at>=?2",
        )?;
        let rows = stmt.query_map(params![task, since_ms], |r| r.get::<_, i64>(0))?;
        rows.collect()
    }

    /// 删除某账号某任务、run_key 以给定前缀开头的记录（用于手动重试）
    pub fn delete_runs_like(&self, account_id: i64, task: &str, run_key_prefix: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "DELETE FROM runs WHERE account_id=?1 AND task=?2 AND run_key LIKE ?3",
            params![account_id, task, format!("{run_key_prefix}%")],
        )
    }

    /// 统计某 task 指定 run_key（精确）成功记录的去重账号数（今日完成度/捐献口径）
    pub fn count_ok_accounts(&self, task: &str, run_key: &str) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "SELECT COUNT(DISTINCT account_id) FROM runs WHERE task=?1 AND run_key=?2 AND status='ok'",
            params![task, run_key],
            |r| r.get(0),
        )
    }

    /// 统计某账号某任务、run_key 以给定前缀开头的成功记录数（每日次数熔断用）
    pub fn count_runs_with_prefix(&self, account_id: i64, task: &str, run_key_prefix: &str) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM runs WHERE account_id=?1 AND task=?2 AND run_key LIKE ?3 AND status='ok'",
            params![account_id, task, format!("{run_key_prefix}%")],
            |r| r.get(0),
        )
    }

    /// 清空运行日志（可选按账号过滤）；返回删除条数
    pub fn clear_runs(&self, account_id: Option<i64>) -> rusqlite::Result<usize> {
        match account_id {
            Some(id) => self.conn.execute("DELETE FROM runs WHERE account_id=?1", params![id]),
            None => self.conn.execute("DELETE FROM runs", []),
        }
    }

    pub fn get_meta(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT value FROM meta WHERE key=?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn set_meta(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// 覆盖式写入某账号背包快照（来自 bootstrap.items）
    pub fn snapshot_inventory(&self, account_id: i64, items: &serde_json::Value) -> rusqlite::Result<usize> {
        let mut n = 0usize;
        if let Some(arr) = items.as_array() {
            self.conn
                .execute("DELETE FROM inventory_snapshot WHERE account_id=?1", params![account_id])?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            for it in arr {
                let key = it["itemKey"].as_str().unwrap_or("");
                if key.is_empty() {
                    continue;
                }
                let amount = it["amount"].as_i64().unwrap_or(0);
                if amount <= 0 {
                    continue;
                }
                self.conn.execute(
                    "INSERT OR REPLACE INTO inventory_snapshot(account_id,item_key,item_type,item_name,amount,bind_status,captured_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![account_id, key, it["itemType"].as_str().unwrap_or(""), it["name"].as_str().unwrap_or(""), amount, it["bindStatus"].as_str().unwrap_or(""), now],
                )?;
                n += 1;
            }
        }
        Ok(n)
    }

    /// 读取某账号背包快照：(item_key, item_type, amount, bind_status)
    pub fn get_inventory(&self, account_id: i64) -> rusqlite::Result<Vec<(String, String, i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT item_key,item_type,amount,bind_status FROM inventory_snapshot WHERE account_id=?1 ORDER BY amount DESC",
        )?;
        let rows = stmt.query_map(params![account_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        rows.collect()
    }

    /// 全账号背包快照：(account_id, username, item_key, item_type, item_name, amount, bind_status)
    pub fn get_all_inventory(&self) -> rusqlite::Result<Vec<(i64, String, String, String, String, i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT i.account_id, a.username, i.item_key, i.item_type, i.item_name, i.amount, i.bind_status
             FROM inventory_snapshot i LEFT JOIN accounts a ON a.id=i.account_id
             ORDER BY a.username, i.amount DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?;
        rows.collect()
    }

    /// 读取某账号各首领的最高可胜难度记录：(boss_key, best_difficulty, best_index, last_result)
    pub fn get_boss_progress(&self, account_id: i64) -> rusqlite::Result<Vec<(String, String, i64, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT boss_key, best_difficulty, best_index, last_result, target_slot FROM boss_progress WHERE account_id=?1 ORDER BY best_index DESC, boss_key",
        )?;
        let rows = stmt.query_map(params![account_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        rows.collect()
    }

    /// 更新首领进度：best_index 只升不降（保留"最高可胜难度目标"），结果/定向部位同步更新
    pub fn set_boss_progress(
        &self,
        account_id: i64,
        boss_key: &str,
        difficulty: &str,
        index: i64,
        result: &str,
        target_slot: &str,
    ) -> rusqlite::Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO boss_progress(account_id,boss_key,best_difficulty,best_index,last_result,target_slot,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(account_id,boss_key) DO UPDATE SET
               best_difficulty = CASE WHEN excluded.best_index >= best_index THEN excluded.best_difficulty ELSE best_difficulty END,
               best_index = MAX(best_index, excluded.best_index),
               last_result = excluded.last_result,
               target_slot = CASE WHEN excluded.target_slot <> '' THEN excluded.target_slot ELSE target_slot END,
               updated_at = excluded.updated_at",
            params![account_id, boss_key, difficulty, index, result, target_slot, now],
        )?;
        Ok(())
    }

    /// 读取某账号首领循环状态：(current_boss_key, target_slot, grad_quality)
    pub fn get_farm_state(&self, account_id: i64) -> rusqlite::Result<Option<(String, String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT current_boss_key, target_slot, grad_quality FROM boss_farm WHERE account_id=?1",
        )?;
        let mut rows = stmt.query(params![account_id])?;
        match rows.next()? {
            Some(r) => Ok(Some((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)?))),
            None => Ok(None),
        }
    }

    /// 写入某账号首领循环状态
    pub fn set_farm_state(
        &self,
        account_id: i64,
        current_boss_key: &str,
        target_slot: &str,
        grad_quality: i64,
    ) -> rusqlite::Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "INSERT OR REPLACE INTO boss_farm(account_id,current_boss_key,target_slot,grad_quality,updated_at) VALUES(?1,?2,?3,?4,?5)",
            params![account_id, current_boss_key, target_slot, grad_quality, now],
        )?;
        Ok(())
    }

    /// 读取某账号某首领已毕业部位列表（毕业 = 该首领最高难度打赢且掉落该部位装备）
    pub fn get_boss_graduate(&self, account_id: i64, boss_key: &str) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT slot FROM boss_graduate WHERE account_id=?1 AND boss_key=?2")?;
        let rows = stmt.query_map(params![account_id, boss_key], |r| r.get::<_, String>(0))?;
        rows.collect()
    }

    /// 记录某账号某首领某部位毕业（重复记录无害）
    pub fn set_boss_graduate(&self, account_id: i64, boss_key: &str, slot: &str) -> rusqlite::Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "INSERT OR REPLACE INTO boss_graduate(account_id,boss_key,slot,updated_at) VALUES(?1,?2,?3,?4)",
            params![account_id, boss_key, slot, now],
        )?;
        Ok(())
    }

    /// 覆盖式写入某账号装备快照（bootstrap.equipment，收菜时一并刷新）
    pub fn snapshot_equipment(&self, account_id: i64, equipment: &serde_json::Value) -> rusqlite::Result<usize> {
        let mut n = 0usize;
        if let Some(arr) = equipment.as_array() {
            self.conn
                .execute("DELETE FROM equipment_snapshot WHERE account_id=?1", params![account_id])?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            for e in arr {
                let eid = e["id"].as_str().unwrap_or("");
                if eid.is_empty() {
                    continue;
                }
                self.conn.execute(
                    "INSERT OR REPLACE INTO equipment_snapshot(account_id,equipment_id,slot,name,quality,enhance_level,score,bind_status,status,equip_level,set_key,rare_rank,captured_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    params![
                        account_id,
                        eid,
                        e["slot"].as_str().unwrap_or(""),
                        e["name"].as_str().unwrap_or(""),
                        e["quality"].as_str().unwrap_or(""),
                        e["enhanceLevel"].as_i64().unwrap_or(0),
                        e["score"].as_i64().unwrap_or(0),
                        e["bindStatus"].as_str().unwrap_or(""),
                        e["status"].as_str().unwrap_or(""),
                        e["level"].as_i64().unwrap_or(0),
                        e["setKey"].as_str().unwrap_or(""),
                        e["rareRank"].as_str().unwrap_or(""),
                        now,
                    ],
                )?;
                n += 1;
            }
        }
        Ok(n)
    }

    /// 读取某账号装备快照：装备列表
    pub fn get_equipment_snapshot(&self, account_id: i64) -> rusqlite::Result<Vec<(String, String, String, String, i64, i64, String, String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT equipment_id, slot, name, quality, enhance_level, score, bind_status, status, equip_level
             FROM equipment_snapshot WHERE account_id=?1 ORDER BY score DESC",
        )?;
        let rows = stmt.query_map(params![account_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
            ))
        })?;
        rows.collect()
    }

    /// 装备快照精简字段（套装进度统计用）：(slot, quality, rare_rank, set_key)
    pub fn equipment_brief(&self, account_id: i64) -> rusqlite::Result<Vec<(String, String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT slot, quality, rare_rank, set_key FROM equipment_snapshot WHERE account_id=?1",
        )?;
        let rows = stmt.query_map(params![account_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        rows.collect()
    }
}