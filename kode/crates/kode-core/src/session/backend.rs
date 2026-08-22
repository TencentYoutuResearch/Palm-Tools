//! 单个 AI CLI backend 的接入面。
//!
//! 新 backend 实现 [`BackendProfile`] 并登记到 [`all_profiles`],token / 会话列表 /
//! meta tail / hook 用量 / CLI flag 都走这套接口。调用方不要再 `match cursor/codex`。

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::sync::mpsc;

use super::cursor_tail;
use super::jsonl_tail::{self, Backend};
use super::SessionId;
use crate::event::CoreEvent;
use crate::model_alias::sanitize_model_name;

const MAX_JSONL_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeStyle {
    /// `--resume <id>`
    Flag,
    /// 子命令 `resume <id>`(Codex)
    Subcommand,
}

#[derive(Debug, Clone, Default)]
pub struct UsageBucket {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub total: u64,
    pub requests: u64,
}

#[derive(Debug, Clone)]
pub struct UsageEvent {
    pub backend: String,
    pub model: String,
    pub timestamp_ms: Option<i64>,
    pub usage: UsageBucket,
}

#[derive(Debug, Clone)]
pub struct HookUsage {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub model: Option<String>,
    pub generation_id: Option<String>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ListedSession {
    pub session_id: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub total_tokens: Option<u64>,
    pub last_modified_secs: u64,
}

pub struct MetaTailRequest {
    pub id: SessionId,
    pub cwd: PathBuf,
    pub resume_session_id: Option<String>,
    pub injected_session_id: Option<String>,
    pub spawn_started_at: SystemTime,
    pub evt_tx: mpsc::UnboundedSender<CoreEvent>,
    pub retarget_rx: tokio::sync::watch::Receiver<Option<PathBuf>>,
}

pub trait BackendProfile: Send + Sync {
    fn kind(&self) -> Backend;
    fn usage_key(&self) -> &'static str;

    fn supports_session_id_flag(&self) -> bool {
        false
    }
    fn supports_append_system_prompt(&self) -> bool {
        false
    }
    fn persist_title_to_transcript(&self) -> bool {
        true
    }
    fn resume_style(&self) -> ResumeStyle {
        ResumeStyle::Flag
    }
    /// Codex:`resume <id>` 是子命令,model / permission 等 flag 必须放在它前面。
    fn flags_before_resume(&self) -> bool {
        false
    }
    fn usage_file_matches(&self, path: &Path) -> bool {
        path.extension().and_then(|s| s.to_str()) == Some("jsonl")
    }

    fn session_path(&self, cwd: &Path, session_id: &str) -> Option<PathBuf> {
        self.kind().session_path(cwd, session_id)
    }
    fn find_session_path(&self, cwd: &Path, session_id: &str) -> Option<PathBuf> {
        jsonl_tail::resolve_session_path(self.kind(), cwd, session_id)
    }

    fn spawn_tail(&self, req: MetaTailRequest);
    fn list_sessions(&self, cwd: &Path) -> Vec<ListedSession>;

    fn usage_roots(&self, home: &Path) -> Vec<PathBuf>;
    fn parse_usage_file(&self, path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent>;

    fn parse_hook_usage(&self, _event: &str, _doc: &Value) -> Option<HookUsage> {
        None
    }
    fn hook_resets_tokens(&self, _event: &str) -> bool {
        false
    }
    fn bind_conversation(&self, _conversation_id: &str, _tab_id: SessionId) {}
    fn tab_for_conversation(&self, _conversation_id: &str) -> Option<SessionId> {
        None
    }
}

pub fn profile(kind: Backend) -> &'static dyn BackendProfile {
    match kind {
        Backend::Codebuddy => &CodebuddyProfile,
        Backend::Claude => &ClaudeProfile,
        Backend::Codex => &CodexProfile,
        Backend::Cursor => &CursorProfile,
    }
}

pub fn profile_for_key(key: &str) -> Option<&'static dyn BackendProfile> {
    Backend::from_backend_key(key).map(profile)
}

pub fn all_profiles() -> &'static [&'static dyn BackendProfile] {
    static PROFILES: &[&dyn BackendProfile] = &[
        &CodebuddyProfile,
        &ClaudeProfile,
        &CodexProfile,
        &CursorProfile,
    ];
    PROFILES
}

pub fn hook_usage(event: &str, doc: &Value) -> Option<HookUsage> {
    all_profiles()
        .iter()
        .find_map(|profile| profile.parse_hook_usage(event, doc))
}

pub fn hook_resets_tokens(event: &str) -> bool {
    all_profiles()
        .iter()
        .any(|profile| profile.hook_resets_tokens(event))
}

pub fn tab_for_hook_conversation(conversation_id: &str) -> Option<SessionId> {
    all_profiles()
        .iter()
        .find_map(|profile| profile.tab_for_conversation(conversation_id))
}

pub fn bind_hook_conversation(conversation_id: &str, tab_id: SessionId) {
    for profile in all_profiles() {
        profile.bind_conversation(conversation_id, tab_id);
    }
}

struct CodebuddyProfile;
struct ClaudeProfile;
struct CodexProfile;
struct CursorProfile;

impl BackendProfile for CodebuddyProfile {
    fn kind(&self) -> Backend {
        Backend::Codebuddy
    }
    fn usage_key(&self) -> &'static str {
        "codebuddy"
    }
    fn supports_session_id_flag(&self) -> bool {
        true
    }
    fn supports_append_system_prompt(&self) -> bool {
        true
    }
    fn spawn_tail(&self, req: MetaTailRequest) {
        spawn_sid_jsonl_tail(self, req);
    }
    fn list_sessions(&self, cwd: &Path) -> Vec<ListedSession> {
        list_slug_jsonl_sessions(self, cwd)
    }
    fn usage_roots(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".codebuddy/projects")]
    }
    fn parse_usage_file(&self, path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
        request_file_events(path, self.usage_key(), fallback_ms, parse_codebuddy_request)
    }
}

impl BackendProfile for ClaudeProfile {
    fn kind(&self) -> Backend {
        Backend::Claude
    }
    fn usage_key(&self) -> &'static str {
        "claude"
    }
    fn supports_session_id_flag(&self) -> bool {
        true
    }
    fn supports_append_system_prompt(&self) -> bool {
        true
    }
    fn spawn_tail(&self, req: MetaTailRequest) {
        spawn_sid_jsonl_tail(self, req);
    }
    fn list_sessions(&self, cwd: &Path) -> Vec<ListedSession> {
        list_slug_jsonl_sessions(self, cwd)
    }
    fn usage_roots(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".claude/projects")]
    }
    fn parse_usage_file(&self, path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
        request_file_events(path, self.usage_key(), fallback_ms, parse_claude_request)
    }
}

impl BackendProfile for CodexProfile {
    fn kind(&self) -> Backend {
        Backend::Codex
    }
    fn usage_key(&self) -> &'static str {
        "codex"
    }
    fn persist_title_to_transcript(&self) -> bool {
        false
    }
    fn resume_style(&self) -> ResumeStyle {
        ResumeStyle::Subcommand
    }
    fn flags_before_resume(&self) -> bool {
        true
    }
    fn spawn_tail(&self, req: MetaTailRequest) {
        if let Some(path) = req
            .resume_session_id
            .as_deref()
            .and_then(jsonl_tail::find_codex_session_by_id)
        {
            jsonl_tail::spawn(
                req.id,
                Backend::Codex,
                path,
                req.evt_tx,
                Some(req.retarget_rx),
            );
        } else {
            jsonl_tail::spawn_latest(
                req.id,
                Backend::Codex,
                req.cwd,
                req.spawn_started_at,
                req.evt_tx,
                Some(req.retarget_rx),
            );
        }
    }
    fn list_sessions(&self, cwd: &Path) -> Vec<ListedSession> {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        collect_codex_listed(&home.join(".codex/sessions"), cwd, &mut out);
        out
    }
    fn usage_roots(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".codex/sessions")]
    }
    fn parse_usage_file(&self, path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
        codex_file_events(path, fallback_ms)
    }
}

impl BackendProfile for CursorProfile {
    fn kind(&self) -> Backend {
        Backend::Cursor
    }
    fn usage_key(&self) -> &'static str {
        "cursor"
    }
    fn persist_title_to_transcript(&self) -> bool {
        false
    }
    fn spawn_tail(&self, req: MetaTailRequest) {
        if let Some(path) = req
            .resume_session_id
            .as_deref()
            .and_then(cursor_tail::find_cursor_session_by_id)
        {
            cursor_tail::spawn(req.id, path, req.evt_tx, Some(req.retarget_rx));
        } else {
            cursor_tail::spawn_latest(
                req.id,
                req.cwd,
                req.spawn_started_at,
                req.evt_tx,
                Some(req.retarget_rx),
            );
        }
    }
    fn list_sessions(&self, cwd: &Path) -> Vec<ListedSession> {
        cursor_tail::list_cursor_chats(cwd)
            .into_iter()
            .map(|chat| ListedSession {
                session_id: chat.session_id,
                title: chat.title,
                model: None,
                total_tokens: None,
                last_modified_secs: chat
                    .last_modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            })
            .collect()
    }
    fn usage_roots(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".kode/usage")]
    }
    fn usage_file_matches(&self, path: &Path) -> bool {
        path.file_name().and_then(|s| s.to_str()) == Some("cursor.jsonl")
    }
    fn parse_usage_file(&self, path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
        cursor_file_events(path, fallback_ms)
    }
    fn parse_hook_usage(&self, event: &str, doc: &Value) -> Option<HookUsage> {
        if !matches!(event, "afterAgentResponse" | "stop" | "Stop") {
            return None;
        }
        let input = json_u64(doc, "input_tokens");
        let output = json_u64(doc, "output_tokens");
        let cached = json_u64(doc, "cache_read_tokens");
        if input == 0 && output == 0 && cached == 0 {
            return None;
        }
        Some(HookUsage {
            input,
            output,
            cached,
            model: doc
                .get("model")
                .and_then(Value::as_str)
                .map(sanitize_model_name)
                .filter(|model| !model.is_empty()),
            generation_id: doc
                .get("generation_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            conversation_id: doc
                .get("conversation_id")
                .or_else(|| doc.get("session_uuid"))
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }
    fn hook_resets_tokens(&self, event: &str) -> bool {
        matches!(event, "sessionStart")
    }
    fn bind_conversation(&self, conversation_id: &str, tab_id: SessionId) {
        cursor_tail::bind_cursor_conversation(conversation_id, tab_id);
    }
    fn tab_for_conversation(&self, conversation_id: &str) -> Option<SessionId> {
        cursor_tail::tab_for_cursor_conversation(conversation_id)
    }
}

fn spawn_sid_jsonl_tail(profile: &dyn BackendProfile, req: MetaTailRequest) {
    let Some(sid) = req
        .injected_session_id
        .as_deref()
        .or(req.resume_session_id.as_deref())
    else {
        return;
    };
    let path = if req.resume_session_id.is_some() {
        profile.find_session_path(&req.cwd, sid)
    } else {
        profile.session_path(&req.cwd, sid)
    };
    let Some(path) = path else {
        return;
    };
    jsonl_tail::spawn(
        req.id,
        profile.kind(),
        path,
        req.evt_tx,
        Some(req.retarget_rx),
    );
}

fn list_slug_jsonl_sessions(profile: &dyn BackendProfile, cwd: &Path) -> Vec<ListedSession> {
    let Some(probe) = profile.session_path(cwd, "__probe__") else {
        return Vec::new();
    };
    let Some(dir) = probe.parent() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        if session_id.is_empty() {
            continue;
        }
        let snap = transcript_snapshot(&path);
        out.push(ListedSession {
            session_id,
            title: snap.title,
            model: snap.model,
            total_tokens: snap.total_tokens,
            last_modified_secs: modified_secs(&path),
        });
    }
    out
}

fn collect_codex_listed(dir: &Path, cwd: &Path, out: &mut Vec<ListedSession>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_codex_listed(&path, cwd, out);
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some((session_id, session_cwd)) = jsonl_tail::codex_session_cwd(&path) else {
            continue;
        };
        if session_cwd != cwd {
            continue;
        }
        let snap = transcript_snapshot(&path);
        out.push(ListedSession {
            session_id,
            title: snap.title,
            model: snap.model,
            total_tokens: snap.total_tokens,
            last_modified_secs: modified_secs(&path),
        });
    }
}

#[derive(Debug, Clone, Default)]
pub struct TranscriptSnapshot {
    pub title: Option<String>,
    pub model: Option<String>,
    pub total_tokens: Option<u64>,
}

pub fn transcript_snapshot(path: &Path) -> TranscriptSnapshot {
    if path.file_name().and_then(|s| s.to_str()) == Some("meta.json") {
        return TranscriptSnapshot {
            title: cursor_tail::read_cursor_meta_file(path).and_then(|meta| meta.title),
            ..TranscriptSnapshot::default()
        };
    }
    let Ok(file) = File::open(path) else {
        return TranscriptSnapshot::default();
    };
    let mut title = None;
    let mut model = None;
    let mut total_tokens = 0_u64;
    let mut saw_tokens = false;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Some(t) = extract_title_from_line(&line) {
            title = Some(t);
        } else if title.is_none() {
            title = extract_user_title_from_line(&line).or_else(|| extract_codex_user_title(&line));
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(found) = extract_model_from_value(&v) {
            model = Some(found);
        }
        if let Some(t) = v
            .get("providerData")
            .and_then(|pd| pd.get("usage"))
            .and_then(|u| u.get("totalTokens"))
            .and_then(Value::as_u64)
        {
            total_tokens = t;
            saw_tokens = true;
        } else if let Some(t) = v
            .get("payload")
            .filter(|_| v.get("type").and_then(Value::as_str) == Some("event_msg"))
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count"))
            .and_then(|p| p.get("info"))
            .and_then(|i| {
                i.get("last_token_usage")
                    .or_else(|| i.get("total_token_usage"))
            })
            .and_then(|u| u.get("total_tokens"))
            .and_then(Value::as_u64)
        {
            total_tokens = t;
            saw_tokens = true;
        }
    }
    TranscriptSnapshot {
        title,
        model,
        total_tokens: saw_tokens.then_some(total_tokens),
    }
}

fn modified_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn extract_model_from_value(v: &Value) -> Option<String> {
    if let Some(pd) = v.get("providerData") {
        return pd
            .get("requestModelId")
            .or_else(|| pd.get("requestModelName"))
            .or_else(|| pd.get("model"))
            .and_then(Value::as_str)
            .map(sanitize_model_name);
    }
    if v.get("type").and_then(Value::as_str) == Some("turn_context") {
        return v
            .get("payload")
            .and_then(|p| p.get("model"))
            .and_then(Value::as_str)
            .map(sanitize_model_name);
    }
    None
}

fn extract_title_from_line(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(Value::as_str) == Some("ai-title") {
        v.get("aiTitle").and_then(Value::as_str).map(String::from)
    } else {
        None
    }
}

fn extract_user_title_from_line(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let role_is_user = v.get("role").and_then(Value::as_str) == Some("user")
        || v.get("type").and_then(Value::as_str) == Some("user");
    if !role_is_user {
        return None;
    }
    let text = json_content_to_text(
        v.get("content")
            .or_else(|| v.get("message").and_then(|m| m.get("content")))?,
    )?;
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.starts_with("C-b") {
        return None;
    }
    Some(trimmed.chars().take(60).collect())
}

fn extract_codex_user_title(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let payload = v.get("payload")?;
    if v.get("type").and_then(Value::as_str) != Some("response_item")
        || payload.get("type").and_then(Value::as_str) != Some("message")
        || payload.get("role").and_then(Value::as_str) != Some("user")
    {
        return None;
    }
    let text = json_content_to_text(payload.get("content")?)?;
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with("C-b")
        || is_codex_title_noise(trimmed)
    {
        return None;
    }
    Some(trimmed.chars().take(60).collect())
}

fn is_codex_title_noise(s: &str) -> bool {
    s.starts_with("# AGENTS.md instructions")
        || s.starts_with("<environment_context>")
        || s.starts_with("<kode-memory>")
        || s.starts_with("<permissions instructions>")
        || s.starts_with("<collaboration_mode>")
        || s.starts_with("<skills_instructions>")
}

fn json_content_to_text(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let arr = v.as_array()?;
    let text = arr
        .iter()
        .filter_map(|item| {
            item.get("text")
                .or_else(|| item.get("input_text"))
                .or_else(|| item.get("output_text"))
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

fn request_file_events(
    path: &Path,
    backend: &str,
    fallback_ms: Option<i64>,
    parse: fn(&Value) -> Option<(String, UsageBucket)>,
) -> Vec<UsageEvent> {
    let mut events = Vec::new();
    for_each_json_line(path, |value| {
        if let Some((model, usage)) = parse(value) {
            events.push(UsageEvent {
                backend: backend.to_string(),
                model,
                timestamp_ms: event_timestamp_ms(value).or(fallback_ms),
                usage,
            });
        }
    });
    events
}

pub(crate) fn parse_codebuddy_request(value: &Value) -> Option<(String, UsageBucket)> {
    let provider = value.get("providerData")?;
    let raw_model = provider
        .get("requestModelId")
        .or_else(|| provider.get("model"))?
        .as_str()?;
    let model = clean_model(raw_model);
    if model.is_empty() {
        return None;
    }
    let usage = provider.get("usage")?;
    let input = json_u64(usage, "inputTokens");
    let output = json_u64(usage, "outputTokens");
    let total = json_u64(usage, "totalTokens").max(input.saturating_add(output));
    if total == 0 {
        return None;
    }
    let cached = usage
        .get("inputTokensDetails")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .map(|item| json_u64(item, "cached_tokens"))
        .unwrap_or(0);
    Some((
        model,
        UsageBucket {
            input,
            output,
            cached,
            total,
            requests: 1,
        },
    ))
}

pub(crate) fn parse_claude_request(value: &Value) -> Option<(String, UsageBucket)> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = value.get("message")?;
    let model = clean_model(message.get("model")?.as_str()?);
    if model.is_empty() {
        return None;
    }
    let usage = message.get("usage")?;
    let fresh_input = json_u64(usage, "input_tokens");
    let cache_write = json_u64(usage, "cache_creation_input_tokens");
    let cached =
        json_u64(usage, "cache_read_input_tokens").max(json_u64(usage, "cache_read_tokens"));
    let input = fresh_input
        .saturating_add(cache_write)
        .saturating_add(cached);
    let output = json_u64(usage, "output_tokens");
    let total = input.saturating_add(output);
    if total == 0 {
        return None;
    }
    Some((
        model,
        UsageBucket {
            input,
            output,
            cached,
            total,
            requests: 1,
        },
    ))
}

fn cursor_file_events(path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
    let mut events = Vec::new();
    let mut seen_generations = HashSet::new();
    for_each_json_line(path, |value| {
        let Some((model, bucket, generation_id)) = parse_cursor_request(value) else {
            return;
        };
        if let Some(generation_id) = generation_id {
            if !seen_generations.insert(generation_id) {
                return;
            }
        }
        events.push(UsageEvent {
            backend: "cursor".to_string(),
            model,
            timestamp_ms: event_timestamp_ms(value).or(fallback_ms),
            usage: bucket,
        });
    });
    events
}

pub(crate) fn parse_cursor_request(value: &Value) -> Option<(String, UsageBucket, Option<String>)> {
    let input = json_u64(value, "input_tokens");
    let output = json_u64(value, "output_tokens");
    let cached = json_u64(value, "cache_read_tokens");
    let total = input.saturating_add(output);
    if total == 0 && cached == 0 {
        return None;
    }
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .map(clean_model)
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let generation_id = value
        .get("generation_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some((
        model,
        UsageBucket {
            input,
            output,
            cached,
            total,
            requests: 1,
        },
        generation_id,
    ))
}

fn codex_file_events(path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
    let mut events = Vec::new();
    let mut model = String::from("unknown");
    let mut previous = UsageBucket::default();
    for_each_json_line(path, |value| {
        let entry_type = value.get("type").and_then(Value::as_str);
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if entry_type == Some("turn_context") {
            if let Some(raw) = payload.get("model").and_then(Value::as_str) {
                let next = clean_model(raw);
                if !next.is_empty() {
                    model = next;
                }
            }
            return;
        }
        if entry_type != Some("event_msg")
            || payload.get("type").and_then(Value::as_str) != Some("token_count")
        {
            return;
        }
        let Some(info) = payload.get("info") else {
            return;
        };
        let (current, cumulative) = if let Some(total) = info.get("total_token_usage") {
            (codex_usage(total), true)
        } else if let Some(last) = info.get("last_token_usage") {
            (codex_usage(last), false)
        } else {
            return;
        };
        let delta = if cumulative {
            let delta = usage_delta(&current, &previous);
            previous = current;
            delta
        } else {
            current
        };
        if delta.total > 0 {
            events.push(UsageEvent {
                backend: "codex".to_string(),
                model: model.clone(),
                timestamp_ms: event_timestamp_ms(value).or(fallback_ms),
                usage: UsageBucket {
                    requests: 1,
                    ..delta
                },
            });
        }
    });
    events
}

fn codex_usage(value: &Value) -> UsageBucket {
    let input = json_u64(value, "input_tokens");
    let output = json_u64(value, "output_tokens");
    let cached = json_u64(value, "cached_input_tokens");
    let total = json_u64(value, "total_tokens").max(input.saturating_add(output));
    UsageBucket {
        input,
        output,
        cached,
        total,
        requests: 0,
    }
}

pub(crate) fn usage_delta(current: &UsageBucket, previous: &UsageBucket) -> UsageBucket {
    fn delta(current: u64, previous: u64) -> u64 {
        if current >= previous {
            current - previous
        } else {
            current
        }
    }
    UsageBucket {
        input: delta(current.input, previous.input),
        output: delta(current.output, previous.output),
        cached: delta(current.cached, previous.cached),
        total: delta(current.total, previous.total),
        requests: 0,
    }
}

fn for_each_json_line(path: &Path, mut visit: impl FnMut(&Value)) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(read) = reader.read_line(&mut line) else {
            break;
        };
        if read == 0 {
            break;
        }
        if read > MAX_JSONL_LINE_BYTES {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            visit(&value);
        }
    }
}

fn event_timestamp_ms(value: &Value) -> Option<i64> {
    let raw = value
        .get("timestamp")
        .or_else(|| value.get("created_at"))
        .or_else(|| value.get("createdAt"))?;
    if let Some(number) = raw.as_i64() {
        return Some(if number.abs() < 100_000_000_000 {
            number * 1_000
        } else {
            number
        });
    }
    let text = raw.as_str()?.trim();
    if let Ok(number) = text.parse::<i64>() {
        return Some(if number.abs() < 100_000_000_000 {
            number * 1_000
        } else {
            number
        });
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn clean_model(model: &str) -> String {
    sanitize_model_name(model).trim().to_string()
}

fn json_u64(doc: &Value, key: &str) -> u64 {
    doc.get(key)
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_f64().map(|n| n as u64))
                .or_else(|| v.as_str()?.parse().ok())
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_known_keys() {
        assert!(profile_for_key("codebuddy").is_some());
        assert!(profile_for_key("claude-internal").is_some());
        assert!(profile_for_key("codex").unwrap().resume_style() == ResumeStyle::Subcommand);
        assert!(!profile_for_key("cursor")
            .unwrap()
            .supports_session_id_flag());
        assert!(profile_for_key("foo").is_none());
        assert_eq!(all_profiles().len(), 4);
    }

    #[test]
    fn codebuddy_request_is_grouped_by_model() {
        let value = serde_json::json!({
            "type": "message",
            "providerData": {
                "requestModelId": "claude-opus-4.7",
                "usage": {
                    "totalTokens": 120,
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "inputTokensDetails": [{"cached_tokens": 40}]
                }
            }
        });
        let (model, usage) = parse_codebuddy_request(&value).unwrap();
        assert_eq!(model, "claude-opus-4.7");
        assert_eq!(
            (usage.input, usage.output, usage.cached, usage.total),
            (100, 20, 40, 120)
        );
    }

    #[test]
    fn claude_cache_write_and_read_are_input() {
        let value = serde_json::json!({
            "type": "assistant",
            "message": {"model": "claude-sonnet-4", "usage": {
                "input_tokens": 10,
                "cache_creation_input_tokens": 30,
                "cache_read_input_tokens": 50,
                "output_tokens": 20
            }}
        });
        let (_, usage) = parse_claude_request(&value).unwrap();
        assert_eq!(
            (usage.input, usage.output, usage.cached, usage.total),
            (90, 20, 50, 110)
        );
    }

    #[test]
    fn cursor_hook_usage_comes_from_stop() {
        let doc = serde_json::json!({
            "input_tokens": 8,
            "output_tokens": 1,
            "model": "grok-4.6",
            "generation_id": "g1",
            "conversation_id": "chat"
        });
        let usage = hook_usage("stop", &doc).unwrap();
        assert_eq!((usage.input, usage.output), (8, 1));
        assert_eq!(usage.model.as_deref(), Some("grok-4.6"));
        assert!(hook_usage("Stop", &doc).is_some());
        assert!(hook_usage("UserPromptSubmit", &doc).is_none());
    }

    #[test]
    fn cursor_file_dedupes_generation_id() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kode-backend-cursor-{}-{unique}.jsonl",
            std::process::id()
        ));
        fs::write(
            &path,
            r#"{"timestamp":"2026-08-20T00:00:00Z","model":"grok-4.6","input_tokens":10,"output_tokens":2,"generation_id":"g1"}
{"timestamp":"2026-08-20T00:00:01Z","model":"grok-4.6","input_tokens":10,"output_tokens":2,"generation_id":"g1"}
{"timestamp":"2026-08-20T00:00:02Z","model":"grok-4.6","input_tokens":4,"output_tokens":1,"generation_id":"g2"}
"#,
        )
        .unwrap();
        let events = CursorProfile.parse_usage_file(&path, None);
        fs::remove_file(&path).ok();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].usage.total, 12);
        assert_eq!(events[1].usage.total, 5);
    }

    #[test]
    fn parses_rfc3339_event_timestamp() {
        let value = serde_json::json!({"timestamp": "2026-01-01T00:00:00Z"});
        assert_eq!(event_timestamp_ms(&value), Some(1_767_225_600_000));
    }

    #[test]
    fn codex_cumulative_usage_uses_delta() {
        let previous = UsageBucket {
            input: 100,
            output: 20,
            cached: 40,
            total: 120,
            requests: 0,
        };
        let current = UsageBucket {
            input: 160,
            output: 35,
            cached: 70,
            total: 195,
            requests: 0,
        };
        let delta = usage_delta(&current, &previous);
        assert_eq!(
            (delta.input, delta.output, delta.cached, delta.total),
            (60, 15, 30, 75)
        );
    }
}
