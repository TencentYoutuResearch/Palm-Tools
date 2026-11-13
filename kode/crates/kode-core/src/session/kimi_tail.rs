//! kimi-code session metadata watcher.
//!
//! kimi-code 的数据根是 `$KIMI_CODE_HOME`(默认 `~/.kimi-code`)。会话目录是
//! `sessions/<workspace-id>/<session-id>/`:
//! - `state.json`:`id` / `cwd` / `title` / `archived` / `createdAt` / `updatedAt`(ms);
//!   title 是 kimi 自己维护的展示名(未生成时是首条 prompt)。
//! - `agents/main/wire.jsonl`:append-only 事件流。`profile.bind` / `config.update`
//!   带 `modelAlias`(`/model` 切换后是 config.update);`usage.record` 是每次请求的
//!   真实用量 `{inputOther, output, inputCacheRead, inputCacheCreation}`;
//!   `token_counting.*` 的 `tokens` 是当前上下文占用。
//!
//! `projects.json` 把 workspace id 映射到 `root` 目录,按 cwd 找会话先查它。
//!
//! 绑定策略:kimi 不接受外部指定 session id,首条消息时才建会话,`-c` 会续用旧会话。
//! 所以与 opencode 兜底一致:按 cwd 认领本次启动后**有活动**、未被别的 tab 认领的
//! 会话;同目录另一个会话更新得更晚(`/new`、`/sessions`)就跟过去。resume
//! (`--session <id>`)从该 id 起步。
//!
//! token 口径:kode 约定 cached 计入 input,所以 input = inputOther + cache read/creation。

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::sleep;

use crate::event::CoreEvent;
use crate::session::SessionId;

/// `$KIMI_CODE_HOME`,未设置时 `<home>/.kimi-code`。
pub fn kimi_home_in(home: &Path) -> PathBuf {
    std::env::var_os("KIMI_CODE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".kimi-code"))
}

pub fn kimi_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| kimi_home_in(&home))
}

#[derive(Debug, Clone, PartialEq)]
pub struct KimiSession {
    pub session_id: String,
    pub dir: PathBuf,
    pub title: Option<String>,
    pub updated_ms: i64,
    pub wire: PathBuf,
}

/// 读 `<dir>/state.json`。归档会话返回 None。
fn read_state(dir: &Path) -> Option<KimiSession> {
    let state: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("state.json")).ok()?).ok()?;
    if state.get("archived").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let session_id = state.get("id")?.as_str()?.to_string();
    let title = state
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let updated_ms = state
        .get("updatedAt")
        .or_else(|| state.get("createdAt"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let wire = state
        .pointer("/agents/main/homedir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join("agents").join("main"))
        .join("wire.jsonl");
    Some(KimiSession {
        session_id,
        dir: dir.to_path_buf(),
        title,
        updated_ms,
        wire,
    })
}

fn state_cwd(dir: &Path) -> Option<String> {
    let state: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("state.json")).ok()?).ok()?;
    state.get("cwd")?.as_str().map(str::to_string)
}

/// 本 cwd 下所有未归档会话,按更新时间倒序。
pub fn list_sessions(kimi_home: &Path, cwd: &Path) -> Vec<KimiSession> {
    let keys = directory_keys(cwd);
    let mut out: Vec<KimiSession> = workspace_dirs(kimi_home, &keys)
        .into_iter()
        .filter_map(|ws| fs::read_dir(ws).ok())
        .flat_map(|entries| entries.flatten().map(|e| e.path()))
        .filter(|dir| state_cwd(dir).is_some_and(|c| keys.contains(&c)))
        .filter_map(|dir| read_state(&dir))
        .collect();
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    out
}

/// 已知 session id 时定位会话目录:先查 cwd 对应的 workspace,再全局扫一遍。
pub fn find_session(kimi_home: &Path, cwd: &Path, session_id: &str) -> Option<KimiSession> {
    let keys = directory_keys(cwd);
    let sessions = kimi_home.join("sessions");
    workspace_dirs(kimi_home, &keys)
        .into_iter()
        .chain(
            fs::read_dir(&sessions)
                .into_iter()
                .flat_map(|entries| entries.flatten().map(|e| e.path())),
        )
        .map(|ws| ws.join(session_id))
        .find(|dir| dir.join("state.json").is_file())
        .and_then(|dir| read_state(&dir))
}

/// `projects.json` 里 root 落在 cwd 上的 workspace 目录;索引缺失或没匹配时
/// 退回 `sessions/` 下全部 workspace(调用方再按 state.json 的 cwd 过滤)。
fn workspace_dirs(kimi_home: &Path, keys: &[String]) -> Vec<PathBuf> {
    let sessions = kimi_home.join("sessions");
    let indexed: Vec<PathBuf> = fs::read_to_string(kimi_home.join("projects.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|doc| {
            let projects = doc.get("projects")?.as_object()?;
            Some(
                projects
                    .iter()
                    .filter(|(_, p)| {
                        p.get("root")
                            .and_then(Value::as_str)
                            .is_some_and(|root| keys.iter().any(|k| k == root))
                    })
                    .map(|(id, _)| sessions.join(id))
                    .filter(|dir| dir.is_dir())
                    .collect(),
            )
        })
        .unwrap_or_default();
    if !indexed.is_empty() {
        return indexed;
    }
    fs::read_dir(&sessions)
        .into_iter()
        .flat_map(|entries| entries.flatten().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect()
}

/// wire.jsonl 累积出来的 model / 用量 / 上下文。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WireStats {
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub context_tokens: Option<u64>,
}

impl WireStats {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    pub fn apply_line(&mut self, line: &str) {
        // profile.bind 行带完整 system prompt,先按子串粗筛,避免每行都反序列化。
        if !(line.contains("modelAlias")
            || line.contains("\"usage.record\"")
            || line.contains("\"token_counting."))
        {
            return;
        }
        if let Ok(rec) = serde_json::from_str::<Value>(line) {
            self.apply_record(&rec);
        }
    }

    pub fn apply_record(&mut self, rec: &Value) {
        let n = |v: &Value, key: &str| v.get(key).and_then(Value::as_u64).unwrap_or(0);
        match rec.get("type").and_then(Value::as_str).unwrap_or_default() {
            "profile.bind" | "config.update" => {
                if let Some(alias) = rec
                    .get("modelAlias")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                {
                    self.model = Some(alias.to_string());
                }
            }
            "usage.record" => {
                let Some(usage) = rec.get("usage") else {
                    return;
                };
                let cached = n(usage, "inputCacheRead") + n(usage, "inputCacheCreation");
                self.input_tokens += n(usage, "inputOther") + cached;
                self.output_tokens += n(usage, "output");
                self.cached_tokens += cached;
            }
            t if t.starts_with("token_counting.") => {
                if let Some(tokens) = rec.get("tokens").and_then(Value::as_u64) {
                    self.context_tokens = Some(tokens);
                }
            }
            _ => {}
        }
    }
}

/// 增量读 wire.jsonl:只解析新追加的完整行,半行留到下次。
#[derive(Debug, Default)]
struct WireReader {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    stats: WireStats,
}

impl WireReader {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            ..Self::default()
        }
    }

    fn poll(&mut self) -> &WireStats {
        let Ok(mut file) = File::open(&self.path) else {
            return &self.stats;
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            // 文件被截断/替换(undo、迁移):从头重算。
            *self = Self::new(std::mem::take(&mut self.path));
        }
        if len == self.offset || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return &self.stats;
        }
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).is_err() {
            return &self.stats;
        }
        self.offset += buf.len() as u64;
        self.partial.extend_from_slice(&buf);
        let complete = self
            .partial
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |i| i + 1);
        let lines: Vec<u8> = self.partial.drain(..complete).collect();
        for line in String::from_utf8_lossy(&lines).lines() {
            self.stats.apply_line(line);
        }
        &self.stats
    }
}

/// 一次性读完整个 wire.jsonl(会话列表 / 用量统计用)。
pub fn read_wire_stats(path: &Path) -> WireStats {
    let mut reader = WireReader::new(path.to_path_buf());
    reader.poll();
    reader.stats
}

/// `config.toml` 里 `[models."<alias>"].max_context_size`,没有时按模型名推断。
fn context_pct(kimi_home: &Path, model: &str, used: u64) -> Option<f32> {
    let window = fs::read_to_string(kimi_home.join("config.toml"))
        .ok()
        .and_then(|text| toml::from_str::<toml::Value>(&text).ok())
        .and_then(|cfg| {
            cfg.get("models")?
                .get(model)?
                .get("max_context_size")?
                .as_integer()
        })
        .filter(|w| *w > 0);
    match window {
        Some(window) => Some(((used as f64 / window as f64) * 100.0).min(999.9) as f32),
        None => crate::context::context_pct(model, used),
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Snapshot {
    session_id: String,
    title: Option<String>,
    stats: WireStats,
}

pub fn spawn(
    id: SessionId,
    cwd: PathBuf,
    resume_session_id: Option<String>,
    not_before: SystemTime,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
) {
    let Some(home) = kimi_home() else { return };
    tokio::spawn(run(id, home, cwd, resume_session_id, not_before, evt_tx));
}

async fn run(
    id: SessionId,
    home: PathBuf,
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
    let mut reader: Option<WireReader> = None;
    let mut last: Option<Snapshot> = None;
    let mut last_updated_ms = not_before_ms;
    loop {
        if evt_tx.is_closed() {
            break;
        }
        let switched = claim_active_session(&home, &cwd, last_updated_ms, session_id.as_deref());
        let reset = switched.is_some() && session_id.is_some();
        if let Some(sid) = switched {
            if let Some(old) = session_id.replace(sid) {
                release(&old);
            }
            reader = None;
            last = None;
        }
        if let Some(session) = session_id
            .as_deref()
            .and_then(|sid| find_session(&home, &cwd, sid))
        {
            last_updated_ms = last_updated_ms.max(session.updated_ms);
            let reader = reader.get_or_insert_with(|| WireReader::new(session.wire.clone()));
            let current = Snapshot {
                session_id: session.session_id.clone(),
                title: session.title.clone(),
                stats: reader.poll().clone(),
            };
            if let Some(event) = meta_event(id, &home, last.as_ref(), &current, reset) {
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
}

/// 只发生变化的字段;首次读到时带上 session id 供持久化 / resume。
/// `reset`:从另一个会话切过来,清掉旧会话的 token 展示。
fn meta_event(
    id: SessionId,
    home: &Path,
    last: Option<&Snapshot>,
    current: &Snapshot,
    reset: bool,
) -> Option<CoreEvent> {
    let title = current
        .title
        .clone()
        .filter(|t| last.and_then(|l| l.title.as_ref()) != Some(t));
    let model = current
        .stats
        .model
        .clone()
        .filter(|m| last.and_then(|l| l.stats.model.as_ref()) != Some(m));
    let session_uuid = last.is_none().then(|| current.session_id.clone());
    let usage = |s: &WireStats| (s.input_tokens, s.output_tokens, s.cached_tokens);
    let tokens_changed = reset
        || last.map_or(current.stats.total_tokens() > 0, |l| {
            usage(&l.stats) != usage(&current.stats)
        });
    let context_changed = current.stats.context_tokens.is_some()
        && (model.is_some()
            || last.map(|l| l.stats.context_tokens) != Some(current.stats.context_tokens));
    if title.is_none()
        && model.is_none()
        && session_uuid.is_none()
        && !tokens_changed
        && !context_changed
    {
        return None;
    }
    let context_pct = context_changed
        .then(|| {
            let model = current.stats.model.as_deref()?;
            context_pct(home, model, current.stats.context_tokens?)
        })
        .flatten();
    let tokens = |v: u64| tokens_changed.then_some(v);
    Some(CoreEvent::JsonlMeta {
        id,
        model,
        title,
        session_uuid,
        tokens_reset: reset,
        tokens: tokens(current.stats.total_tokens()),
        input_tokens: tokens(current.stats.input_tokens),
        output_tokens: tokens(current.stats.output_tokens),
        cached_tokens: tokens(current.stats.cached_tokens),
        cost_usd: None,
        context_pct,
    })
}

/// 本 cwd 下 `since_ms` 之后有活动、且未被别的 tab 认领的最新会话。
/// 返回 `None` 表示仍是 `current`(或还没有可认领的会话);返回的新会话已登记认领。
fn claim_active_session(
    kimi_home: &Path,
    cwd: &Path,
    since_ms: i64,
    current: Option<&str>,
) -> Option<String> {
    let mut claimed = claimed_sessions().lock().ok()?;
    for session in list_sessions(kimi_home, cwd) {
        if session.updated_ms <= since_ms {
            break;
        }
        if Some(session.session_id.as_str()) == current {
            return None;
        }
        if claimed.insert(session.session_id.clone()) {
            return Some(session.session_id);
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

/// 用户传入的 cwd 和 kimi 记录的路径可能一个是 symlink 一个是 realpath,两种都比。
fn directory_keys(cwd: &Path) -> Vec<String> {
    let mut keys = vec![cwd.to_string_lossy().into_owned()];
    if let Ok(real) = fs::canonicalize(cwd) {
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

    struct Fixture {
        home: PathBuf,
        cwd: String,
    }

    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir().join(format!("kode-kimi-{}", uuid::Uuid::new_v4()));
            let cwd = format!("/w-{}", uuid::Uuid::new_v4());
            fs::create_dir_all(home.join("sessions/wd_w_1")).unwrap();
            fs::write(
                home.join("projects.json"),
                format!(r#"{{"schema_version":2,"projects":{{"wd_w_1":{{"root":"{cwd}"}}}}}}"#),
            )
            .unwrap();
            Self { home, cwd }
        }

        fn session(&self, id: &str, title: &str, updated: i64, archived: bool) -> PathBuf {
            let dir = self.home.join("sessions/wd_w_1").join(id);
            fs::create_dir_all(dir.join("agents/main")).unwrap();
            fs::write(
                dir.join("state.json"),
                format!(
                    r#"{{"id":"{id}","cwd":"{}","archived":{archived},"title":"{title}","createdAt":1,"updatedAt":{updated}}}"#,
                    self.cwd
                ),
            )
            .unwrap();
            dir
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    const WIRE: &str = concat!(
        r#"{"type":"metadata","protocol_version":"1.5"}"#,
        "\n",
        r#"{"type":"profile.bind","agentId":"main","modelAlias":"kimi-code/kimi-for-coding","systemPrompt":"x"}"#,
        "\n",
        r#"{"type":"usage.record","agentId":"main","model":"kimi-code/kimi-for-coding","usage":{"inputOther":100,"output":20,"inputCacheRead":1000,"inputCacheCreation":5}}"#,
        "\n",
        r#"{"type":"token_counting.turn_recorded","agentId":"main","turnId":0,"length":2,"tokens":1125}"#,
        "\n",
        r#"{"type":"config.update","agentId":"main","modelAlias":"kimi-code/kimi-for-coding-highspeed"}"#,
        "\n",
        r#"{"type":"usage.record","agentId":"main","model":"kimi-code/kimi-for-coding-highspeed","usage":{"inputOther":7,"output":3,"inputCacheRead":0,"inputCacheCreation":0}}"#,
        "\n",
    );

    #[test]
    fn wire_stats_follow_model_switch_and_sum_cache_inclusive_usage() {
        let mut stats = WireStats::default();
        WIRE.lines().for_each(|l| stats.apply_line(l));
        assert_eq!(
            stats.model.as_deref(),
            Some("kimi-code/kimi-for-coding-highspeed")
        );
        assert_eq!(
            (stats.input_tokens, stats.output_tokens, stats.cached_tokens),
            (1112, 23, 1005)
        );
        assert_eq!(stats.total_tokens(), 1135);
        assert_eq!(stats.context_tokens, Some(1125));
    }

    #[test]
    fn wire_reader_keeps_partial_line_until_complete() {
        let fx = Fixture::new();
        let dir = fx.session("session_a", "t", 2, false);
        let path = dir.join("agents/main/wire.jsonl");
        let (head, tail) = WIRE.split_at(WIRE.find("inputOther\":7").unwrap());
        fs::write(&path, head).unwrap();
        let mut reader = WireReader::new(path.clone());
        assert_eq!(reader.poll().output_tokens, 20);
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, tail.as_bytes()))
            .unwrap();
        assert_eq!(reader.poll().output_tokens, 23);
        assert_eq!(reader.poll().output_tokens, 23, "no double counting");
    }

    #[test]
    fn lists_cwd_sessions_newest_first_and_skips_archived() {
        let fx = Fixture::new();
        fx.session("session_old", "旧", 10, false);
        fx.session("session_new", "你好", 20, false);
        fx.session("session_gone", "x", 30, true);
        let listed = list_sessions(&fx.home, Path::new(&fx.cwd));
        let ids: Vec<_> = listed.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, ["session_new", "session_old"]);
        assert_eq!(listed[0].title.as_deref(), Some("你好"));
        assert!(list_sessions(&fx.home, Path::new("/elsewhere")).is_empty());
        assert_eq!(
            find_session(&fx.home, Path::new("/elsewhere"), "session_old").map(|s| s.updated_ms),
            Some(10),
            "known id resolves even when cwd differs"
        );
    }

    #[test]
    fn claims_only_sessions_active_after_spawn() {
        let fx = Fixture::new();
        let a = format!("session_{}", uuid::Uuid::new_v4());
        let b = format!("session_{}", uuid::Uuid::new_v4());
        fx.session(&a, "a", 15, false);
        let cwd = PathBuf::from(&fx.cwd);
        assert_eq!(claim_active_session(&fx.home, &cwd, 20, None), None);
        assert_eq!(
            claim_active_session(&fx.home, &cwd, 10, None),
            Some(a.clone())
        );
        assert_eq!(claim_active_session(&fx.home, &cwd, 10, Some(&a)), None);
        fx.session(&b, "b", 30, false);
        assert_eq!(
            claim_active_session(&fx.home, &cwd, 15, Some(&a)),
            Some(b.clone())
        );
        release(&a);
        release(&b);
    }

    #[test]
    fn meta_event_reports_id_once_and_context_from_kimi_config() {
        let fx = Fixture::new();
        fs::write(
            fx.home.join("config.toml"),
            "[models.\"kimi-code/k\"]\nmax_context_size = 1000\n",
        )
        .unwrap();
        let base = Snapshot {
            session_id: "session_a".into(),
            title: Some("你好".into()),
            stats: WireStats {
                model: Some("kimi-code/k".into()),
                context_tokens: Some(250),
                ..WireStats::default()
            },
        };
        let Some(CoreEvent::JsonlMeta {
            session_uuid,
            title,
            model,
            tokens,
            context_pct,
            ..
        }) = meta_event(1, &fx.home, None, &base, false)
        else {
            panic!("first read must emit");
        };
        assert_eq!(session_uuid.as_deref(), Some("session_a"));
        assert_eq!(title.as_deref(), Some("你好"));
        assert_eq!(model.as_deref(), Some("kimi-code/k"));
        assert_eq!(tokens, None);
        assert_eq!(context_pct, Some(25.0));
        assert!(meta_event(1, &fx.home, Some(&base), &base, false).is_none());

        let next = Snapshot {
            stats: WireStats {
                input_tokens: 100,
                output_tokens: 5,
                ..base.stats.clone()
            },
            ..base.clone()
        };
        let Some(CoreEvent::JsonlMeta {
            session_uuid,
            title,
            tokens,
            input_tokens,
            context_pct,
            ..
        }) = meta_event(1, &fx.home, Some(&base), &next, false)
        else {
            panic!("usage change must emit");
        };
        assert_eq!((session_uuid, title, context_pct), (None, None, None));
        assert_eq!((tokens, input_tokens), (Some(105), Some(100)));
    }
}
