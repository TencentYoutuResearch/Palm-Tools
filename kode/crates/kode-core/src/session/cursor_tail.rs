//! Cursor CLI (`cursor-agent`) session metadata watcher.
//!
//! cursor-agent 不写 codebuddy/claude 那种 jsonl usage 行,会话落在
//! `~/.cursor/chats/<workspace-hash>/<chatId>/meta.json`:
//!
//! ```json
//! {"schemaVersion":1,"title":"Palm X H5","cwd":"/path/to/project",...}
//! ```
//!
//! `chatId` 就是 `--resume` 用的 session uuid。title 由 CLI 自己生成后写进
//! meta.json;token 用量不落这个文件,走 Cursor `afterAgentResponse` hook
//! (见 `kode-memory cursor-hook`)。
//!
//! 认领策略对齐 Codex:`cursor-agent` 也不接受外部 `--session-id`,新建 tab
//! 按 cwd + mtime 认领本次启动后出现的 chat 目录;resume 按 chatId 全局扫描。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::sleep;

use crate::event::CoreEvent;
use crate::session::SessionId;

#[derive(Debug, Clone)]
pub struct CursorChatMeta {
    pub session_id: String,
    pub title: Option<String>,
    pub path: PathBuf,
    pub last_modified: SystemTime,
}

#[derive(Debug, Deserialize)]
struct CursorMetaFile {
    title: Option<String>,
    cwd: Option<String>,
}

pub fn spawn_latest(
    id: SessionId,
    cwd: PathBuf,
    not_before: SystemTime,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
    mut retarget_rx: Option<tokio::sync::watch::Receiver<Option<PathBuf>>>,
) {
    tokio::spawn(async move {
        let path = loop {
            if let Some(rx) = retarget_rx.as_mut() {
                let pending: Option<PathBuf> = rx.borrow_and_update().clone();
                if let Some(path) = pending {
                    break path;
                }
            }
            if let Some(path) = find_and_claim_cursor_session(&cwd, not_before) {
                break path;
            }
            if evt_tx.is_closed() {
                return;
            }
            if let Some(rx) = retarget_rx.as_mut() {
                tokio::select! {
                    _ = sleep(Duration::from_millis(500)) => {}
                    changed = rx.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
            } else {
                sleep(Duration::from_millis(500)).await;
            }
        };
        tracing::debug!(?path, "cursor chat meta claimed");
        if let Err(e) = run(id, path, evt_tx, retarget_rx).await {
            tracing::debug!(error = %e, "cursor meta tail exited");
        }
    });
}

pub fn spawn(
    id: SessionId,
    path: PathBuf,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
    retarget_rx: Option<tokio::sync::watch::Receiver<Option<PathBuf>>>,
) {
    tokio::spawn(async move {
        if let Err(e) = run(id, path, evt_tx, retarget_rx).await {
            tracing::debug!(error = %e, "cursor meta tail exited");
        }
    });
}

async fn run(
    id: SessionId,
    mut current_path: PathBuf,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
    mut retarget_rx: Option<tokio::sync::watch::Receiver<Option<PathBuf>>>,
) -> std::io::Result<()> {
    bind_cursor_tab_from_meta_path(id, &current_path);
    let mut last_title: Option<String> = None;
    let mut last_session_uuid: Option<String> = None;
    let mut last_mtime: Option<SystemTime> = None;

    loop {
        if evt_tx.is_closed() {
            return Ok(());
        }
        if let Some(rx) = retarget_rx.as_mut() {
            let pending: Option<PathBuf> = rx.borrow_and_update().clone();
            if let Some(path) = pending {
                if path != current_path {
                    current_path = path;
                    last_title = None;
                    last_session_uuid = None;
                    last_mtime = None;
                    bind_cursor_tab_from_meta_path(id, &current_path);
                }
            }
        }

        let mtime = fs::metadata(&current_path)
            .ok()
            .and_then(|m| m.modified().ok());
        if mtime != last_mtime {
            last_mtime = mtime;
            if let Some(meta) = read_cursor_meta_file(&current_path) {
                let mut new_title = None;
                let mut new_session_uuid = None;
                if last_session_uuid.as_deref() != Some(meta.session_id.as_str()) {
                    last_session_uuid = Some(meta.session_id.clone());
                    bind_cursor_conversation(&meta.session_id, id);
                    new_session_uuid = Some(meta.session_id);
                }
                if let Some(title) = meta.title {
                    if last_title.as_deref() != Some(title.as_str()) {
                        last_title = Some(title.clone());
                        new_title = Some(title);
                    }
                }
                if new_title.is_some() || new_session_uuid.is_some() {
                    if evt_tx
                        .send(CoreEvent::JsonlMeta {
                            id,
                            model: None,
                            title: new_title,
                            session_uuid: new_session_uuid,
                            tokens_reset: false,
                            tokens: None,
                            input_tokens: None,
                            output_tokens: None,
                            cached_tokens: None,
                            cost_usd: None,
                            context_pct: None,
                        })
                        .is_err()
                    {
                        return Ok(());
                    }
                }
            }
        }

        if let Some(rx) = retarget_rx.as_mut() {
            tokio::select! {
                _ = sleep(Duration::from_millis(300)) => {}
                changed = rx.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                }
            }
        } else {
            sleep(Duration::from_millis(300)).await;
        }
    }
}

pub fn list_cursor_chats(cwd: &Path) -> Vec<CursorChatMeta> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    list_cursor_chats_under(&home.join(".cursor").join("chats"), cwd)
}

pub fn find_cursor_session_by_id(session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    find_cursor_session_by_id_under(&home.join(".cursor").join("chats"), session_id)
}

/// Cursor hook 的 `session_id` 是 conversation uuid,不是 kode tab id。
/// tail 认领 meta.json 后把 uuid → tab 登记在这里,供 HookRelay 路由 token。
pub fn bind_cursor_conversation(conversation_id: &str, tab_id: SessionId) {
    if conversation_id.is_empty() {
        return;
    }
    if let Ok(mut map) = cursor_tab_by_uuid().lock() {
        map.insert(conversation_id.to_string(), tab_id);
    }
}

pub fn tab_for_cursor_conversation(conversation_id: &str) -> Option<SessionId> {
    cursor_tab_by_uuid()
        .lock()
        .ok()?
        .get(conversation_id)
        .copied()
}

fn bind_cursor_tab_from_meta_path(tab_id: SessionId, meta_path: &Path) {
    if let Some(uuid) = meta_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
    {
        bind_cursor_conversation(uuid, tab_id);
    }
}

static CURSOR_TAB_BY_UUID: OnceLock<Mutex<HashMap<String, SessionId>>> = OnceLock::new();

fn cursor_tab_by_uuid() -> &'static Mutex<HashMap<String, SessionId>> {
    CURSOR_TAB_BY_UUID.get_or_init(|| Mutex::new(HashMap::new()))
}

fn find_and_claim_cursor_session(cwd: &Path, not_before: SystemTime) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let mut claimed = claimed_cursor_chats().lock().ok()?;
    let path = find_cursor_session_candidate_under(
        &home.join(".cursor").join("chats"),
        cwd,
        not_before,
        &claimed,
    )?;
    claimed.insert(canonicalize_or_owned(&path));
    Some(path)
}

static CLAIMED_CURSOR_CHATS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn claimed_cursor_chats() -> &'static Mutex<HashSet<PathBuf>> {
    CLAIMED_CURSOR_CHATS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn find_cursor_session_candidate_under(
    root: &Path,
    cwd: &Path,
    not_before: SystemTime,
    claimed: &HashSet<PathBuf>,
) -> Option<PathBuf> {
    let cutoff = not_before
        .checked_sub(Duration::from_secs(5))
        .unwrap_or(not_before);
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for meta in collect_cursor_chats(root) {
        if claimed.contains(&canonicalize_or_owned(&meta.path)) {
            continue;
        }
        if meta.last_modified < cutoff {
            continue;
        }
        if !cursor_meta_matches_cwd(&meta.path, cwd) {
            continue;
        }
        let replace = best
            .as_ref()
            .map(|(best_modified, _)| meta.last_modified < *best_modified)
            .unwrap_or(true);
        if replace {
            best = Some((meta.last_modified, meta.path));
        }
    }
    best.map(|(_, path)| path)
}

fn find_cursor_session_by_id_under(root: &Path, session_id: &str) -> Option<PathBuf> {
    collect_cursor_chats(root)
        .into_iter()
        .find(|meta| meta.session_id == session_id)
        .map(|meta| meta.path)
}

fn list_cursor_chats_under(root: &Path, cwd: &Path) -> Vec<CursorChatMeta> {
    collect_cursor_chats(root)
        .into_iter()
        .filter(|meta| cursor_meta_matches_cwd(&meta.path, cwd))
        .collect()
}

fn collect_cursor_chats(root: &Path) -> Vec<CursorChatMeta> {
    let mut out = Vec::new();
    let Ok(workspaces) = fs::read_dir(root) else {
        return out;
    };
    for workspace in workspaces.flatten() {
        let workspace_path = workspace.path();
        if !workspace_path.is_dir() {
            continue;
        }
        let Ok(chats) = fs::read_dir(&workspace_path) else {
            continue;
        };
        for chat in chats.flatten() {
            let chat_dir = chat.path();
            if !chat_dir.is_dir() {
                continue;
            }
            let meta_path = chat_dir.join("meta.json");
            if let Some(meta) = read_cursor_meta_file(&meta_path) {
                out.push(meta);
            }
        }
    }
    out
}

pub fn read_cursor_meta_file(path: &Path) -> Option<CursorChatMeta> {
    let text = fs::read_to_string(path).ok()?;
    let parsed: CursorMetaFile = serde_json::from_str(&text).ok()?;
    let session_id = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(String::from)?;
    let last_modified = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut title = parsed
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if title.is_none() {
        title = extract_cursor_user_title(path, &session_id);
    }
    Some(CursorChatMeta {
        session_id,
        title,
        path: path.to_path_buf(),
        last_modified,
    })
}

fn cursor_meta_matches_cwd(path: &Path, cwd: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<CursorMetaFile>(&text) else {
        return false;
    };
    let Some(found) = parsed.cwd else {
        return false;
    };
    paths_equal(Path::new(&found), cwd)
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(aa), Ok(bb)) => aa == bb,
        _ => false,
    }
}

fn canonicalize_or_owned(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn extract_cursor_user_title(meta_path: &Path, session_id: &str) -> Option<String> {
    let chat_cwd = {
        let text = fs::read_to_string(meta_path).ok()?;
        let parsed: CursorMetaFile = serde_json::from_str(&text).ok()?;
        parsed.cwd.map(PathBuf::from)?
    };
    let transcript = cursor_transcript_path(&chat_cwd, session_id)?;
    extract_user_title_from_transcript(&transcript)
}

/// Cursor's semantic conversation log is separate from `chats/**/meta.json`.
/// Unlike the chat database directory, its workspace folder is derived
/// directly from cwd, so it is deterministic once Cursor reports the UUID.
pub fn cursor_transcript_path(cwd: &Path, session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let slug = cwd
        .to_string_lossy()
        .trim_start_matches('/')
        .replace('/', "-");
    Some(
        home.join(".cursor")
            .join("projects")
            .join(slug)
            .join("agent-transcripts")
            .join(session_id)
            .join(format!("{session_id}.jsonl")),
    )
}

fn extract_user_title_from_transcript(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Some(title) = cursor_user_title_from_line(&line) {
            return Some(title);
        }
    }
    None
}

fn cursor_user_title_from_line(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let content = v.get("message").and_then(|m| m.get("content"))?;
    let text = cursor_content_text(content)?;
    let trimmed = extract_user_query(&text);
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with('/') {
        return None;
    }
    Some(trimmed.chars().take(60).collect())
}

fn cursor_content_text(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let arr = content.as_array()?;
    for item in arr {
        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn extract_user_query(text: &str) -> String {
    if let Some(start) = text.find("<user_query>") {
        let rest = &text[start + "<user_query>".len()..];
        let body = rest.split("</user_query>").next().unwrap_or(rest);
        return body.trim().to_string();
    }
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!(
            "kode-cursor-{}-{}-{}",
            std::process::id(),
            name,
            nanos
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_chat(
        root: &Path,
        workspace: &str,
        sid: &str,
        title: Option<&str>,
        cwd: &str,
    ) -> PathBuf {
        let dir = root.join(workspace).join(sid);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meta.json");
        let title_json = match title {
            Some(t) => format!(r#""title":"{t}","#),
            None => String::new(),
        };
        std::fs::write(
            &path,
            format!(r#"{{"schemaVersion":1,{title_json}"cwd":"{cwd}"}}"#),
        )
        .unwrap();
        path
    }

    #[test]
    fn lists_chats_for_matching_cwd_only() {
        let root = temp_root("list");
        let cwd = "/tmp/kode-cursor-cwd";
        let keep = write_chat(&root, "hash-a", "chat-keep", Some("Keep Me"), cwd);
        write_chat(&root, "hash-a", "chat-other", Some("Other"), "/tmp/other");
        let listed = list_cursor_chats_under(&root, Path::new(cwd));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "chat-keep");
        assert_eq!(listed[0].title.as_deref(), Some("Keep Me"));
        assert_eq!(listed[0].path, keep);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_session_by_id_across_workspaces() {
        let root = temp_root("by-id");
        let expected = write_chat(
            &root,
            "hash-b",
            "e3e9a409-7742-49e5-97ef-e3adccf24df9",
            Some("Cursor Token Title"),
            "/tmp/p",
        );
        write_chat(&root, "hash-c", "other-id", Some("Nope"), "/tmp/p");
        let found = find_cursor_session_by_id_under(&root, "e3e9a409-7742-49e5-97ef-e3adccf24df9");
        assert_eq!(found.as_deref(), Some(expected.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claims_unclaimed_chat_matching_cwd() {
        let root = temp_root("claim");
        let cwd = "/tmp/kode-cursor-claim";
        let old = write_chat(&root, "hash", "old", Some("Old"), cwd);
        let expected = write_chat(&root, "hash", "new", Some("New"), cwd);
        write_chat(&root, "hash", "other", Some("Other"), "/tmp/other");
        let mut claimed = HashSet::new();
        claimed.insert(canonicalize_or_owned(&old));
        let found = find_cursor_session_candidate_under(
            &root,
            Path::new(cwd),
            SystemTime::UNIX_EPOCH,
            &claimed,
        );
        assert_eq!(found.as_deref(), Some(expected.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extracts_user_query_from_transcript_line() {
        let line = r#"{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Wed</timestamp>\n<user_query>\n你看看cursor 为啥没有显示记录统计token以及更新title\n</user_query>"}]}}"#;
        assert_eq!(
            cursor_user_title_from_line(line).as_deref(),
            Some("你看看cursor 为啥没有显示记录统计token以及更新title")
        );
    }

    #[test]
    fn cursor_transcript_path_uses_workspace_slug_and_session_id() {
        let path = cursor_transcript_path(Path::new("/Users/test/My App"), "session-1").unwrap();
        assert!(path.ends_with(
            ".cursor/projects/Users-test-My App/agent-transcripts/session-1/session-1.jsonl"
        ));
    }

    #[test]
    fn bind_cursor_conversation_round_trips_tab_id() {
        bind_cursor_conversation("bind-test-uuid", 1234);
        assert_eq!(tab_for_cursor_conversation("bind-test-uuid"), Some(1234));
        assert_eq!(tab_for_cursor_conversation("missing"), None);
    }
}
