//! Codex's `threads.name` is the displayed conversation name. `threads.title`
//! stores the first prompt and is only a fallback, not the generated name.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

#[derive(Debug, Clone)]
pub(super) struct CodexThreadRow {
    pub id: String,
    pub rollout_path: PathBuf,
    pub cwd: PathBuf,
    pub title: String,
    pub name: Option<String>,
    pub first_user_message: Option<String>,
    pub model: Option<String>,
    pub tokens_used: u64,
    pub updated_at: u64,
}

/// The outer `None` means the database could not be read; it must not erase a
/// previously observed name. The inner `None` means the thread has no name.
pub(super) fn read_thread_name(db_path: &Path, session_id: &str) -> Option<Option<String>> {
    read_thread_name_in(db_path, session_id)
}

pub(super) fn thread_names(db_path: &Path) -> HashMap<String, String> {
    thread_names_in(db_path)
}

pub(super) fn thread_rollout_path(db_path: &Path, session_id: &str) -> Option<PathBuf> {
    let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let path: Option<String> = connection
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .ok()?;
    path.map(PathBuf::from).filter(|path| path.is_file())
}

pub(super) fn thread_rows(db_path: &Path) -> Option<Vec<CodexThreadRow>> {
    let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    thread_rows_with_query(
        &connection,
        "SELECT id, rollout_path, cwd, title, name, first_user_message, model, tokens_used, updated_at
         FROM threads
         WHERE archived = 0
         ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC",
    )
    .or_else(|| {
        thread_rows_with_query(
            &connection,
            "SELECT id, rollout_path, cwd, title, NULL, first_user_message, NULL, tokens_used, updated_at
             FROM threads
             ORDER BY updated_at DESC",
        )
    })
}

fn thread_rows_with_query(connection: &Connection, sql: &str) -> Option<Vec<CodexThreadRow>> {
    let mut query = connection.prepare(sql).ok()?;
    let rows = query
        .query_map([], |row| {
            Ok(CodexThreadRow {
                id: row.get(0)?,
                rollout_path: PathBuf::from(row.get::<_, String>(1)?),
                cwd: PathBuf::from(row.get::<_, String>(2)?),
                title: row.get(3)?,
                name: row.get(4)?,
                first_user_message: row.get(5)?,
                model: row.get(6)?,
                tokens_used: row.get::<_, i64>(7)?.max(0) as u64,
                updated_at: row.get::<_, i64>(8)?.max(0) as u64,
            })
        })
        .ok()?;
    Some(rows.flatten().collect())
}

fn thread_names_in(db_path: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    let Ok(connection) = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return names;
    };
    let Ok(mut query) = connection.prepare("SELECT id, name FROM threads WHERE name IS NOT NULL")
    else {
        return names;
    };
    let Ok(rows) = query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return names;
    };
    for row in rows.flatten() {
        let (id, name) = row;
        let name = name.trim();
        if !name.is_empty() {
            names.insert(id, name.to_string());
        }
    }
    names
}

fn read_thread_name_in(db_path: &Path, session_id: &str) -> Option<Option<String>> {
    let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let name: Option<String> = connection
        .query_row(
            "SELECT name FROM threads WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .ok()?
        .flatten();
    Some(
        name.map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_name_takes_priority_and_can_change() {
        let path =
            std::env::temp_dir().join(format!("kode-codex-title-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Connection::open(&path).unwrap();
        db.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads VALUES (?1, ?2, NULL, ?3)",
            ("session-1", "[Image #1] raw prompt", "/tmp/project"),
        )
        .unwrap();
        assert_eq!(read_thread_name_in(&path, "session-1"), Some(None));
        assert!(thread_names_in(&path).is_empty());
        db.execute(
            "UPDATE threads SET name = ?1 WHERE id = ?2",
            ("  修复会话标题  ", "session-1"),
        )
        .unwrap();
        assert_eq!(
            read_thread_name_in(&path, "session-1"),
            Some(Some("修复会话标题".into()))
        );
        assert_eq!(
            thread_names_in(&path).get("session-1").map(String::as_str),
            Some("修复会话标题")
        );
        db.execute(
            "UPDATE threads SET name = ?1 WHERE id = ?2",
            ("新的标题", "session-1"),
        )
        .unwrap();
        assert_eq!(
            read_thread_name_in(&path, "session-1"),
            Some(Some("新的标题".into()))
        );
        db.execute(
            "UPDATE threads SET name = NULL WHERE id = ?1",
            ["session-1"],
        )
        .unwrap();
        assert_eq!(read_thread_name_in(&path, "session-1"), Some(None));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn thread_index_returns_metadata_and_direct_rollout_path() {
        let root =
            std::env::temp_dir().join(format!("kode-codex-thread-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let rollout = root.join("rollout.jsonl");
        std::fs::write(&rollout, "{}\n").unwrap();
        let path = root.join("state_5.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                name TEXT,
                first_user_message TEXT,
                model TEXT,
                tokens_used INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                updated_at_ms INTEGER,
                archived INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)",
            (
                "session-1",
                rollout.to_string_lossy(),
                r"\\?\D:\kode\kode",
                "raw title",
                "Named thread",
                "first user message",
                "gpt-5.4",
                1234_i64,
                99_i64,
                99_000_i64,
            ),
        )
        .unwrap();
        drop(db);

        let rows = thread_rows(&path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name.as_deref(), Some("Named thread"));
        assert_eq!(rows[0].model.as_deref(), Some("gpt-5.4"));
        assert_eq!(rows[0].tokens_used, 1234);
        assert_eq!(thread_rollout_path(&path, "session-1"), Some(rollout));
        std::fs::remove_dir_all(root).unwrap();
    }
}
