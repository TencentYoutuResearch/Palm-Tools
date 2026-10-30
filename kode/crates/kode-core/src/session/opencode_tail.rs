//! opencode session metadata watcher.
//!
//! opencode 不写 jsonl,会话落在 SQLite `$XDG_DATA_HOME/opencode/opencode.db`
//! (默认 `~/.local/share/opencode/opencode.db`)的 `session` 表:title / model /
//! 累计 tokens / cost 都在同一行,随每个 step 更新。
//!
//! 绑定策略:opencode 不接受外部指定 session id,TUI 还会续用已有会话、首条消息前
//! 不建会话。权威来源是 kode 的 opencode 插件(`kode-memory` 安装到
//! `~/.config/opencode/plugin/kode.js`):每条用户消息经 HookRelay 带上
//! `opencode_session_uuid`,调 [`bind`] 精确绑定本 tab。收到过绑定的 tab 只认插件。
//!
//! 没装插件时兜底:按 `directory` + `time_updated` 认领本次启动后**有活动**、
//! 未被别的 tab 认领的根会话,同目录另一个未认领会话更新得更晚(`/new`、`/sessions`)
//! 就跟过去。resume(`--session <id>`)从该 id 起步。只读打开数据库,不碰写锁。
//!
//! token 口径:opencode 的 `tokens_input` 不含 cache 命中,kode 约定 cached 计入
//! input,所以这里把 cache read/write 加回 input,reasoning 计入 output。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use tokio::sync::mpsc;
use tokio::time::sleep;

use crate::event::CoreEvent;
use crate::session::SessionId;

/// opencode 新会话的占位标题前缀,AI 标题生成前不展示。
const PLACEHOLDER_TITLE_PREFIX: &str = "New session - ";

#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeSession {
    pub session_id: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub cost_usd: f64,
    pub updated_ms: i64,
}

impl OpencodeSession {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

pub fn db_path() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")))?;
    Some(data.join("opencode").join("opencode.db"))
}

pub fn spawn(
    id: SessionId,
    cwd: PathBuf,
    resume_session_id: Option<String>,
    not_before: SystemTime,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
) {
    let Some(db) = db_path() else { return };
    tokio::spawn(run(id, db, cwd, resume_session_id, not_before, evt_tx));
}

async fn run(
    id: SessionId,
    db: PathBuf,
    cwd: PathBuf,
    resume_session_id: Option<String>,
    not_before: SystemTime,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
) {
    let not_before_ms = not_before
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut session_id = resume_session_id;
    if let Some(sid) = session_id.as_deref() {
        claim(sid);
    }
    let mut last: Option<OpencodeSession> = None;
    let mut plugin_bound = false;
    loop {
        if evt_tx.is_closed() {
            break;
        }
        let switched = if let Some(sid) = bound_session(id) {
            plugin_bound = true;
            (session_id.as_deref() != Some(sid.as_str()) && is_root_session(&db, &sid)).then(|| {
                claim(&sid);
                sid
            })
        } else if plugin_bound {
            None
        } else {
            let active_since = last.as_ref().map_or(not_before_ms, |s| s.updated_ms);
            claim_active_session(&db, &cwd, active_since, session_id.as_deref())
        };
        let reset = switched.is_some() && session_id.is_some();
        if let Some(sid) = switched {
            if let Some(old) = session_id.replace(sid) {
                release(&old);
            }
            last = None;
        }
        if let Some(current) = session_id.as_deref().and_then(|sid| read_session(&db, sid)) {
            if let Some(event) = meta_event(id, last.as_ref(), &current, reset) {
                if evt_tx.send(event).is_err() {
                    break;
                }
            }
            last = Some(current);
        }
        sleep(Duration::from_millis(if session_id.is_some() {
            1000
        } else {
            300
        }))
        .await;
    }
    if let Some(sid) = session_id.as_deref() {
        release(sid);
    }
    if let Ok(mut bindings) = plugin_bindings().lock() {
        bindings.remove(&id);
    }
}

/// HookRelay 收到 opencode 插件上报时调用:tab `id` 当前在用 opencode 会话 `sid`。
pub fn bind(id: SessionId, sid: &str) {
    if let Ok(mut bindings) = plugin_bindings().lock() {
        bindings.insert(id, sid.to_string());
    }
}

/// 插件最近一次上报的会话 id。
pub fn bound_session(id: SessionId) -> Option<String> {
    plugin_bindings().lock().ok()?.get(&id).cloned()
}

fn plugin_bindings() -> &'static Mutex<HashMap<SessionId, String>> {
    static BINDINGS: OnceLock<Mutex<HashMap<SessionId, String>>> = OnceLock::new();
    BINDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// subagent 会话(有 parent_id)也会触发插件的 `chat.message`,不能抢走主会话。
fn is_root_session(db: &Path, sid: &str) -> bool {
    open(db)
        .and_then(|c| {
            c.query_row(
                "SELECT parent_id IS NULL FROM session WHERE id = ?1",
                [sid],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .ok()
            .flatten()
        })
        .unwrap_or(false)
}

/// 只发生变化的字段;首次读到时带上 session uuid 供持久化 / resume。
/// `reset`:从另一个会话切过来,清掉旧会话的 token 展示。
fn meta_event(
    id: SessionId,
    last: Option<&OpencodeSession>,
    current: &OpencodeSession,
    reset: bool,
) -> Option<CoreEvent> {
    let changed = |f: fn(&OpencodeSession) -> Option<String>| {
        f(current).filter(|v| last.and_then(f).as_ref() != Some(v))
    };
    let title = changed(|s| s.title.clone());
    let model = changed(|s| s.model.clone());
    let session_uuid = last.is_none().then(|| current.session_id.clone());
    let tokens_changed = reset
        || last.map_or(current.total_tokens() > 0, |l| {
            (l.input_tokens, l.output_tokens, l.cached_tokens)
                != (
                    current.input_tokens,
                    current.output_tokens,
                    current.cached_tokens,
                )
        });
    if title.is_none() && model.is_none() && session_uuid.is_none() && !tokens_changed {
        return None;
    }
    let tokens = |v: u64| tokens_changed.then_some(v);
    Some(CoreEvent::JsonlMeta {
        id,
        model,
        title,
        session_uuid,
        tokens_reset: reset,
        tokens: tokens(current.total_tokens()),
        input_tokens: tokens(current.input_tokens),
        output_tokens: tokens(current.output_tokens),
        cached_tokens: tokens(current.cached_tokens),
        cost_usd: (tokens_changed && current.cost_usd > 0.0).then_some(current.cost_usd),
        context_pct: None,
    })
}

fn open(db: &Path) -> Option<Connection> {
    let connection = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    // opencode 写 WAL;并发读时偶发 busy,等一下而不是直接失败。
    let _ = connection.busy_timeout(Duration::from_millis(200));
    Some(connection)
}

const SESSION_COLUMNS: &str = "id, title, model, tokens_input, tokens_output, tokens_reasoning, \
     tokens_cache_read, tokens_cache_write, cost, time_updated";

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<OpencodeSession> {
    let input: i64 = row.get(3)?;
    let output: i64 = row.get(4)?;
    let reasoning: i64 = row.get(5)?;
    let cache_read: i64 = row.get(6)?;
    let cache_write: i64 = row.get(7)?;
    let non_negative = |v: i64| v.max(0) as u64;
    let cached = non_negative(cache_read) + non_negative(cache_write);
    Ok(OpencodeSession {
        session_id: row.get(0)?,
        title: display_title(&row.get::<_, String>(1)?),
        model: row
            .get::<_, Option<String>>(2)?
            .as_deref()
            .and_then(model_name),
        input_tokens: non_negative(input) + cached,
        output_tokens: non_negative(output) + non_negative(reasoning),
        cached_tokens: cached,
        cost_usd: row.get(8)?,
        updated_ms: row.get(9)?,
    })
}

fn display_title(raw: &str) -> Option<String> {
    let title = raw.trim();
    (!title.is_empty() && !title.starts_with(PLACEHOLDER_TITLE_PREFIX)).then(|| title.to_string())
}

/// `{"id":"gpt-6-astra","providerID":"shared"}` → `shared/gpt-6-astra`,与 `-m` 的写法一致。
fn model_name(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let model = value.get("id")?.as_str()?.trim();
    if model.is_empty() {
        return None;
    }
    Some(match value.get("providerID").and_then(|p| p.as_str()) {
        Some(provider) if !provider.is_empty() => format!("{provider}/{model}"),
        _ => model.to_string(),
    })
}

pub fn read_session(db: &Path, session_id: &str) -> Option<OpencodeSession> {
    open(db)?
        .query_row(
            &format!("SELECT {SESSION_COLUMNS} FROM session WHERE id = ?1"),
            [session_id],
            row_to_session,
        )
        .optional()
        .ok()?
}

/// 本 cwd 下所有根会话(不含 subagent 子会话),按更新时间倒序。
pub fn list_sessions(db: &Path, cwd: &Path) -> Vec<OpencodeSession> {
    let Some(connection) = open(db) else {
        return Vec::new();
    };
    let Ok(mut query) = connection.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM session \
         WHERE directory = ?1 AND parent_id IS NULL AND time_archived IS NULL \
         ORDER BY time_updated DESC"
    )) else {
        return Vec::new();
    };
    directory_keys(cwd)
        .iter()
        .flat_map(|dir| {
            query
                .query_map([dir], row_to_session)
                .map(|rows| rows.flatten().collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .collect()
}

/// 本 cwd 下 `since_ms` 之后有活动、且未被别的 tab 认领的最新根会话。
/// 返回 `None` 表示仍是 `current`(或还没有可认领的会话);返回的新会话已登记认领。
fn claim_active_session(
    db: &Path,
    cwd: &Path,
    since_ms: i64,
    current: Option<&str>,
) -> Option<String> {
    let connection = open(db)?;
    let mut query = connection
        .prepare(
            "SELECT id FROM session \
             WHERE directory = ?1 AND parent_id IS NULL AND time_archived IS NULL \
             AND time_updated > ?2 ORDER BY time_updated DESC",
        )
        .ok()?;
    let mut claimed = claimed_sessions().lock().ok()?;
    for dir in directory_keys(cwd) {
        let Ok(rows) = query.query_map(rusqlite::params![dir, since_ms], |row| {
            row.get::<_, String>(0)
        }) else {
            continue;
        };
        for sid in rows.flatten() {
            if Some(sid.as_str()) == current {
                return None;
            }
            if claimed.insert(sid.clone()) {
                return Some(sid);
            }
        }
    }
    None
}

fn claim(sid: &str) {
    if let Ok(mut claimed) = claimed_sessions().lock() {
        claimed.insert(sid.to_string());
    }
}

fn release(sid: &str) {
    if let Ok(mut claimed) = claimed_sessions().lock() {
        claimed.remove(sid);
    }
}

fn claimed_sessions() -> &'static Mutex<HashSet<String>> {
    static CLAIMED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLAIMED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// opencode 记录的是 realpath(`/tmp` → `/private/tmp`),两种写法都查。
fn directory_keys(cwd: &Path) -> Vec<String> {
    let mut keys = vec![cwd.to_string_lossy().into_owned()];
    if let Ok(real) = std::fs::canonicalize(cwd) {
        let real = real.to_string_lossy().into_owned();
        if !keys.contains(&real) {
            keys.push(real);
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!("kode-opencode-{}.db", uuid::Uuid::new_v4()));
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, \
             title TEXT NOT NULL, model TEXT, cost REAL NOT NULL DEFAULT 0, \
             tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0, \
             tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, \
             tokens_cache_write INTEGER NOT NULL DEFAULT 0, time_created INTEGER NOT NULL, \
             time_updated INTEGER NOT NULL, time_archived INTEGER);",
        )
        .unwrap();
        (path, db)
    }

    #[test]
    fn session_row_maps_title_model_and_cache_inclusive_tokens() {
        let (path, db) = fixture();
        db.execute(
            "INSERT INTO session VALUES ('ses_a', NULL, '/w', 'Listing files', \
             '{\"id\":\"gpt-5.6-sol\",\"providerID\":\"shared\"}', 0.5, 210, 24, 6, 11520, 0, 1, 2, NULL)",
            [],
        )
        .unwrap();
        let s = read_session(&path, "ses_a").unwrap();
        assert_eq!(s.title.as_deref(), Some("Listing files"));
        assert_eq!(s.model.as_deref(), Some("shared/gpt-5.6-sol"));
        assert_eq!(
            (s.input_tokens, s.output_tokens, s.cached_tokens),
            (11730, 30, 11520)
        );
        assert_eq!(s.total_tokens(), 11760);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn placeholder_title_is_hidden_until_generated() {
        assert_eq!(
            display_title("New session - 2026-10-29T07:44:56.376Z"),
            None
        );
        assert_eq!(display_title(" 中文问候 "), Some("中文问候".into()));
    }

    fn insert(
        db: &Connection,
        dir: &str,
        id: &str,
        parent: Option<&str>,
        created: i64,
        updated: i64,
    ) {
        db.execute(
            "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) \
             VALUES (?1, ?2, ?3, 't', ?4, ?5)",
            rusqlite::params![id, parent, dir, created, updated],
        )
        .unwrap();
    }

    /// 回归:TUI 续用启动前就存在的会话(只更新 time_updated),也要认领到。
    #[test]
    fn claims_continued_session_active_after_spawn() {
        let (path, db) = fixture();
        let dir = format!("/w-{}", uuid::Uuid::new_v4());
        insert(&db, &dir, &format!("{dir}-idle"), None, 1, 5);
        insert(&db, &dir, &format!("{dir}-old"), None, 1, 15);
        insert(&db, &dir, &format!("{dir}-child"), Some("x"), 1, 20);
        let cwd = PathBuf::from(&dir);
        let old = format!("{dir}-old");
        assert_eq!(
            claim_active_session(&path, &cwd, 10, None),
            Some(old.clone())
        );
        // 仍是当前会话 → 不切换;已被认领 → 别的 tab 拿不到
        assert_eq!(claim_active_session(&path, &cwd, 10, Some(&old)), None);
        assert_eq!(claim_active_session(&path, &cwd, 10, None), None);
        release(&old);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn subagent_sessions_are_not_root() {
        let (path, db) = fixture();
        let dir = format!("/w-{}", uuid::Uuid::new_v4());
        insert(&db, &dir, "main", None, 1, 2);
        insert(&db, &dir, "sub", Some("main"), 1, 3);
        assert!(is_root_session(&path, "main"));
        assert!(!is_root_session(&path, "sub"));
        assert!(!is_root_session(&path, "missing"));
        let _ = std::fs::remove_file(path);
    }

    /// `/new` 或 `/sessions` 后另一个会话更新得更晚 → 跟过去。
    #[test]
    fn follows_newer_session_in_same_directory() {
        let (path, db) = fixture();
        let dir = format!("/w-{}", uuid::Uuid::new_v4());
        let (a, b) = (format!("{dir}-a"), format!("{dir}-b"));
        insert(&db, &dir, &a, None, 1, 15);
        insert(&db, &dir, &b, None, 16, 30);
        let cwd = PathBuf::from(&dir);
        claim(&a);
        assert_eq!(
            claim_active_session(&path, &cwd, 15, Some(&a)),
            Some(b.clone())
        );
        release(&a);
        release(&b);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn meta_event_reports_uuid_once_and_only_changed_fields() {
        let base = OpencodeSession {
            session_id: "ses_a".into(),
            title: None,
            model: Some("shared/gpt-6-astra".into()),
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cost_usd: 0.0,
            updated_ms: 1,
        };
        let Some(CoreEvent::JsonlMeta {
            session_uuid,
            model,
            tokens,
            ..
        }) = meta_event(1, None, &base, false)
        else {
            panic!("first read must emit");
        };
        assert_eq!(session_uuid.as_deref(), Some("ses_a"));
        assert_eq!(model.as_deref(), Some("shared/gpt-6-astra"));
        assert_eq!(tokens, None);
        assert!(meta_event(1, Some(&base), &base, false).is_none());

        let next = OpencodeSession {
            title: Some("中文问候".into()),
            input_tokens: 100,
            output_tokens: 5,
            ..base.clone()
        };
        let Some(CoreEvent::JsonlMeta {
            session_uuid,
            model,
            title,
            tokens,
            ..
        }) = meta_event(1, Some(&base), &next, false)
        else {
            panic!("changes must emit");
        };
        assert_eq!((session_uuid, model), (None, None));
        assert_eq!(title.as_deref(), Some("中文问候"));
        assert_eq!(tokens, Some(105));
    }
}
