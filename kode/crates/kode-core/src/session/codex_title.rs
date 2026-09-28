//! Codex's `threads.name` is the displayed conversation name. `threads.title`
//! stores the first prompt and is only a fallback, not the generated name.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

/// The outer `None` means the database could not be read; it must not erase a
/// previously observed name. The inner `None` means the thread has no name.
pub(super) fn read_thread_name(session_id: &str) -> Option<Option<String>> {
    let home = dirs::home_dir()?;
    read_thread_name_in(&home.join(".codex/state_5.sqlite"), session_id)
}

pub(super) fn thread_names() -> HashMap<String, String> {
    let Some(home) = dirs::home_dir() else {
        return HashMap::new();
    };
    thread_names_in(&home.join(".codex/state_5.sqlite"))
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
}
