//! 解析 codebuddy / claude / codex jsonl,以及 cursor-agent 的 chat meta。
//!
//! 状态栏的 model / title / tokens 不靠解析 PTY 输出:
//! - codebuddy:`~/.codebuddy/projects/<slug>/<sid>.jsonl`
//! - claude:`~/.claude/projects/<slug>/<sid>.jsonl`
//! - codex:`~/.codex/sessions/**/rollout-*.jsonl`
//! - cursor:`~/.cursor/chats/<hash>/<chatId>/meta.json`(title);token 走 hook
//!
//! 设计:
//! - 启动一个 tokio task 持续 tail 该文件
//! - 文件可能在子进程启动后几秒才创建,所以 open 失败就等
//! - 不读 message 正文(对显示无用),但 claude 没有 ai-title 字段,
//!   所以用第一条非命令前缀的 user message 作 title fallback

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Deserialize;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader, SeekFrom};
use tokio::sync::mpsc;
use tokio::time::sleep;

use crate::event::CoreEvent;
use crate::session::SessionId;

/// 哪种 jsonl 格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Codebuddy,
    Claude,
    Codex,
    Cursor,
}

impl Backend {
    /// 根据 backend_key 选择 jsonl 解析器。未知后端返回 None(不开 tail)。
    pub fn from_backend_key(key: &str) -> Option<Self> {
        match key {
            "codebuddy" => Some(Backend::Codebuddy),
            "claude" | "claude-internal" => Some(Backend::Claude),
            "codex" => Some(Backend::Codex),
            "cursor" => Some(Backend::Cursor),
            _ => None,
        }
    }

    /// 这个 backend 写 jsonl 到哪个文件路径。
    pub fn session_path(self, cwd: &Path, session_id: &str) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        match self {
            Backend::Codebuddy => {
                // ~/.codebuddy/projects/<slug>/<sid>.jsonl
                // slug:去掉开头 /,/ 换成 -
                let slug = cwd
                    .to_string_lossy()
                    .trim_start_matches('/')
                    .replace('/', "-");
                Some(
                    home.join(".codebuddy")
                        .join("projects")
                        .join(slug)
                        .join(format!("{session_id}.jsonl")),
                )
            }
            Backend::Claude => {
                // ~/.claude/projects/<slug>/<sid>.jsonl
                // slug:**前导 dash** + / 换成 -(实测格式:"-Users-foo-bar")
                let raw = cwd.to_string_lossy();
                let slug = format!("-{}", raw.trim_start_matches('/').replace('/', "-"));
                Some(
                    home.join(".claude")
                        .join("projects")
                        .join(slug)
                        .join(format!("{session_id}.jsonl")),
                )
            }
            Backend::Codex | Backend::Cursor => None,
        }
    }

    /// Reject hook-provided transcript paths that belong to another backend.
    ///
    /// SessionStart payloads are routed by the Kode tab id. If a stale or
    /// cross-process hook is routed to the wrong tab, accepting its path would
    /// let (for example) a CodeBuddy JSONL overwrite a Codex tab's model,
    /// title, and conversation id. Keep this check path-based so it also works
    /// before the transcript has been fully written.
    pub fn accepts_transcript_path(self, path: &Path) -> bool {
        let components: Vec<_> = path
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .collect();
        let contains_pair = |first: &str, second: &str| {
            components
                .windows(2)
                .any(|pair| pair[0] == first && pair[1] == second)
        };

        match self {
            Backend::Codebuddy => contains_pair(".codebuddy", "projects"),
            Backend::Claude => contains_pair(".claude", "projects"),
            Backend::Codex => contains_pair(".codex", "sessions"),
            Backend::Cursor => contains_pair(".cursor", "projects"),
        }
    }
}

/// 给 Session 用的便捷封装:已知 backend_key + cwd + sid,返回 jsonl 路径。
pub fn session_path_for(backend_key: &str, cwd: &Path, session_id: &str) -> Option<PathBuf> {
    Backend::from_backend_key(backend_key)?.session_path(cwd, session_id)
}

/// resume 场景专用:在 cwd 算出来的路径不存在时,全局扫描 backend 的 projects
/// 目录,按 session_id 找真实文件。解决 cwd 被错误覆盖(session_cwd_override)
/// 导致 jsonl_tail 路径错误的问题。
///
/// 优先返回 cwd 推算的路径(若存在),回退到全局搜索结果,都没找到返回 None。
pub fn resolve_session_path(backend: Backend, cwd: &Path, session_id: &str) -> Option<PathBuf> {
    if backend == Backend::Codex {
        return find_codex_session_by_id(session_id);
    }
    if backend == Backend::Cursor {
        return crate::session::cursor_tail::find_cursor_session_by_id(session_id);
    }
    // 先用 cwd 推算
    if let Some(p) = backend.session_path(cwd, session_id) {
        if p.exists() {
            return Some(p);
        }
    }
    // cwd 路径不存在时全局扫描
    find_session_file_by_id(backend, session_id)
}

/// 在 backend 的 projects 根目录下全局扫描 `{session_id}.jsonl`。
/// 用于 resume 时 cwd 不确定的场景。
fn find_session_file_by_id(backend: Backend, session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let projects_root = match backend {
        Backend::Codebuddy => home.join(".codebuddy").join("projects"),
        Backend::Claude => home.join(".claude").join("projects"),
        Backend::Codex | Backend::Cursor => return None,
    };
    let filename = format!("{session_id}.jsonl");
    let entries = fs::read_dir(&projects_root).ok()?;
    for entry in entries.flatten() {
        let slug_dir = entry.path();
        if !slug_dir.is_dir() {
            continue;
        }
        let candidate = slug_dir.join(&filename);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// 在 `~/.codex/sessions/**` 中按 Codex session uuid 找 rollout jsonl。
pub fn find_codex_session_by_id(session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    find_codex_session_by_id_under(&home.join(".codex").join("sessions"), session_id)
}

/// 兼容旧 API 名(只用于 codebuddy);新代码请用 `Backend::session_path` 或 `session_path_for`。
#[doc(hidden)]
pub fn codebuddy_session_path(cwd: &Path, session_id: &str) -> Option<PathBuf> {
    Backend::Codebuddy.session_path(cwd, session_id)
}

/// in-TUI `/resume <target>` 自驱动 retarget 用:已知源文件路径 + target uuid,
/// 算出 target jsonl 路径。target 与源在同一个 slug 目录下(同 cwd),所以优先
/// 用 `<源目录>/<target>.jsonl`;若不存在(理论上不该,但 cwd override 等情况兜底)
/// 回退到全局扫描。target 文件还没落盘时返回 None,调用方保持在当前文件继续等。
fn resolve_retarget_path(
    backend: Backend,
    current_path: &Path,
    target_uuid: &str,
) -> Option<PathBuf> {
    if let Some(dir) = current_path.parent() {
        let candidate = dir.join(format!("{target_uuid}.jsonl"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    find_session_file_by_id(backend, target_uuid)
}

/// 启动后台 tail 任务。task 在 evt_tx 关闭时自然退出。
///
/// `retarget_rx`:可选的权威 retarget 通道(SessionStart hook 驱动)。当 codebuddy 在进程内
/// `/resume` / `/clear` 切换 session 时,上层把新 transcript_path 通过 watch 发进来,
/// tail 据此精确切到正确文件。`None` = 不支持 retarget(如 codex)。
pub fn spawn(
    id: SessionId,
    backend: Backend,
    path: PathBuf,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
    retarget_rx: Option<tokio::sync::watch::Receiver<Option<PathBuf>>>,
) {
    tokio::spawn(async move {
        if let Err(e) = run(id, backend, &path, &evt_tx, retarget_rx).await {
            tracing::debug!(?path, error = %e, "jsonl tail exited");
        }
    });
}

/// Codex CLI 不支持由外部指定 `--session-id`。优先等 Codex `SessionStart`
/// hook 带回该 PTY 的 `transcript_path` 做精确绑定；hook 缺失时才按 cwd + mtime
/// 认领新 rollout 作为降级路径。
pub fn spawn_latest(
    id: SessionId,
    backend: Backend,
    cwd: PathBuf,
    not_before: SystemTime,
    evt_tx: mpsc::UnboundedSender<CoreEvent>,
    mut retarget_rx: Option<tokio::sync::watch::Receiver<Option<PathBuf>>>,
) {
    tokio::spawn(async move {
        if backend != Backend::Codex {
            return;
        }
        // Codex can create the rollout file promptly but delay writing the
        // `session_meta` line with cwd until much later. Keep the claim task
        // alive for the tab lifetime; it exits when the session/event channel
        // is closed.
        let path = loop {
            if let Some(rx) = retarget_rx.as_mut() {
                let pending: Option<PathBuf> = rx.borrow_and_update().clone();
                if let Some(path) = pending {
                    break path;
                }
            }
            if let Some(path) = find_and_claim_codex_session(&cwd, not_before) {
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
        tracing::debug!(?path, "codex jsonl session claimed");
        if let Err(e) = run(id, backend, &path, &evt_tx, retarget_rx).await {
            tracing::debug!(?path, error = %e, "codex jsonl tail exited");
        }
    });
}

/// 累积状态(单 session 持续维护)
struct TailState {
    total_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    /// 上次 LLM 实际使用的 model(来自 assistant providerData 的其他字段)。
    /// 用于 cost / context_pct 计算 —— 这反映"这次请求实际花的钱用什么算"。
    last_model: Option<String>,
    /// 上次 emit 给前端 UI 的实际 model，用于去重。
    last_emitted_model: Option<String>,
    /// `/model` 切换后的用户意图。在下一次真实请求到来前先让 UI 跟随，
    /// 后续由 providerData 里的实际模型校正。
    user_pinned_model: Option<String>,
    last_title: Option<String>,
    /// 当前 jsonl 行声明的真实 session uuid。codebuddy `/clear` 会换新 session/jsonl,
    /// 必须把它同步回 GUI 持久化,否则 restore 会继续 `--resume` 旧 uuid。
    last_session_uuid: Option<String>,
    /// 当前 tail 期望读取的 session uuid。通常来自 jsonl 文件名。若同一个文件里混入
    /// 其它 sessionId,不要把它当作当前 tab 的元数据,避免持久化 session_id 串台。
    expected_session_uuid: Option<String>,
    /// claude 后端没有 ai-title;若已用第一条 user message 设过 fallback,标记之
    title_fallback_used: bool,
}

impl TailState {
    fn new() -> Self {
        Self {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            last_model: None,
            last_emitted_model: None,
            user_pinned_model: None,
            last_title: None,
            last_session_uuid: None,
            expected_session_uuid: None,
            title_fallback_used: false,
        }
    }
}

#[derive(Default)]
struct LineUpdate {
    new_model: Option<String>,
    new_title: Option<String>,
    new_session_uuid: Option<String>,
    tokens_reset: bool,
    new_total: Option<u64>,
    new_input: Option<u64>,
    new_output: Option<u64>,
    new_cached: Option<u64>,
    /// token 字段是否已经是 session 累计值。Codex 的 total_token_usage 是累计值;
    /// codebuddy / claude usage 是单次请求增量。
    tokens_are_cumulative: bool,
    /// 最新一次请求占用的上下文 token,只用于 context_pct,不参与 session 累计。
    latest_context_tokens: Option<u64>,
    /// codebuddy in-TUI `/resume <target>` 在**源文件**里写一行
    /// `<local-command-stdout>change session <uuid></local-command-stdout>`,
    /// 之后真实对话全写进 target 文件。这个字段携带 target uuid,run() 据此
    /// resolve target jsonl 路径并把 tail 切过去(自驱动 retarget,不依赖 hook)。
    /// 见 parse_codebuddy_line / extract_change_session_target。
    retarget_to: Option<String>,
}

impl LineUpdate {
    fn changed(&self) -> bool {
        self.new_model.is_some()
            || self.new_title.is_some()
            || self.new_session_uuid.is_some()
            || self.tokens_reset
            || self.new_total.is_some()
            || self.new_input.is_some()
            || self.new_output.is_some()
            || self.new_cached.is_some()
            || self.retarget_to.is_some()
    }
}

async fn run(
    id: SessionId,
    backend: Backend,
    path: &Path,
    evt_tx: &mpsc::UnboundedSender<CoreEvent>,
    mut retarget_rx: Option<tokio::sync::watch::Receiver<Option<PathBuf>>>,
) -> std::io::Result<()> {
    let mut current_path = path.to_path_buf();

    // 1. 等文件出现(最长 30 秒)
    let mut attempts = 0;
    let file = loop {
        match File::open(&current_path).await {
            Ok(f) => break f,
            Err(_) if attempts < 60 => {
                attempts += 1;
                sleep(Duration::from_millis(500)).await;
            }
            Err(e) => return Err(e),
        }
        if evt_tx.is_closed() {
            return Ok(());
        }
    };

    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(0)).await?;
    let mut replay_boundary = reader.get_ref().metadata().await?.len();

    let mut buf = String::new();
    let mut state = TailState::new();
    state.expected_session_uuid = session_id_from_path(&current_path);

    // 是否已追上文件末尾(读到过 EOF)。in-TUI `/resume` 的 `change session` 行
    // 是**实时追加**才代表当前切换意图;初始全量回放阶段读到的历史 `change session`
    // 行是过去的事件,绝不能据此 retarget(否则 restore 一个有历史 /resume 的 tab
    // 会被勾到历史 target 文件)。
    //
    // 但不能只靠 caught_up:长 jsonl 初始回放还没到 EOF 时,用户可能已经执行完
    // `/resume` 并追加了新的 `change session` 行。为避免误丢这种实时事件,
    // replay_boundary 记录打开文件那一刻的长度;起始 offset >= boundary 的行
    // 即使 caught_up=false,也视为本轮 tail 启动后的实时追加。
    // 每次切到新文件后重新 seek(0) 全量回放,也要重置 caught_up/boundary。
    let mut caught_up = false;
    // `change session <target>` 可能先写进源文件,目标 jsonl 稍后才创建。
    // 若一次 resolve 失败就丢弃 target,tab 会永久停在旧 session。这里记住待切换
    // 的 target,在 EOF 轮询里持续重试直到文件出现或 tab 结束。
    let mut pending_retarget_uuid: Option<String> = None;
    let mut pending_retarget_path: Option<PathBuf> = None;

    loop {
        // 优先消费权威 retarget 信号(SessionStart hook 给出的 transcript_path):
        // codebuddy `/resume` `/clear` 在进程内切换 session 时,hook 会发新文件路径,
        // 据此把 tail 精确切到正确文件(取代历史靠 mtime 猜"最新 /clear 文件"的盲扫)。
        if let Some(rx) = retarget_rx.as_mut() {
            // 先把值 clone 出来,立刻释放 watch::Ref guard(它非 Send,不能跨 await 持有)。
            let pending: Option<PathBuf> = rx.borrow_and_update().clone();
            if let Some(new_path) = pending {
                if new_path != current_path {
                    if let Ok(file) = File::open(&new_path).await {
                        reader = BufReader::new(file);
                        reader.seek(SeekFrom::Start(0)).await?;
                        replay_boundary = reader.get_ref().metadata().await?.len();
                        current_path = new_path;
                        state = TailState::new();
                        state.expected_session_uuid = session_id_from_path(&current_path);
                        caught_up = false;
                        pending_retarget_uuid = None;
                        pending_retarget_path = None;
                        tracing::info!(target: "kode_hook_probe", ?current_path, %id, "jsonl tail retargeted via hook");
                        continue;
                    } else {
                        pending_retarget_path = Some(new_path);
                    }
                }
            }
        }

        buf.clear();
        let line_start = reader.stream_position().await?;
        let n = reader.read_line(&mut buf).await?;
        if n == 0 {
            // 检测同文件被重写的两种情况:
            // 1) 原文件被 truncate:路径上的文件长度小于当前 fd 偏移;
            // 2) 原文件被 atomic replace/rename:当前 fd 仍指向旧 inode,路径已指向新文件。
            let current_pos = reader.stream_position().await?;
            let fd_meta = reader.get_ref().metadata().await?;
            if let Ok(path_meta) = tokio::fs::metadata(&current_path).await {
                if path_meta.len() < current_pos || !same_file(&fd_meta, &path_meta) {
                    let file = File::open(&current_path).await?;
                    reader = BufReader::new(file);
                    reader.seek(SeekFrom::Start(0)).await?;
                    replay_boundary = reader.get_ref().metadata().await?.len();
                    state = TailState::new();
                    state.expected_session_uuid = session_id_from_path(&current_path);
                    caught_up = false;
                    continue;
                }
            }

            // 真正读到文件末尾(没有重写/截断):标记已追上历史。此后新追加的
            // `change session` 行才被当作实时 in-TUI `/resume` 信号触发 retarget。
            caught_up = true;

            if let Some(new_path) = pending_retarget_path.as_ref() {
                if new_path != &current_path {
                    if let Ok(file) = File::open(new_path).await {
                        reader = BufReader::new(file);
                        reader.seek(SeekFrom::Start(0)).await?;
                        replay_boundary = reader.get_ref().metadata().await?.len();
                        current_path = new_path.clone();
                        state = TailState::new();
                        state.expected_session_uuid = session_id_from_path(&current_path);
                        caught_up = false;
                        pending_retarget_uuid = None;
                        pending_retarget_path = None;
                        if let Some(session_uuid) = state.expected_session_uuid.clone() {
                            let _ = evt_tx.send(CoreEvent::JsonlMeta {
                                id,
                                model: None,
                                title: None,
                                session_uuid: Some(session_uuid),
                                tokens_reset: true,
                                tokens: None,
                                input_tokens: None,
                                output_tokens: None,
                                cached_tokens: None,
                                cost_usd: None,
                                context_pct: None,
                            });
                        }
                        tracing::info!(
                            target: "kode_hook_probe",
                            ?current_path, %id,
                            "jsonl tail retargeted after delayed path appeared"
                        );
                        continue;
                    }
                } else {
                    pending_retarget_path = None;
                }
            }

            if let Some(target_uuid) = pending_retarget_uuid.as_deref() {
                if let Some(new_path) = resolve_retarget_path(backend, &current_path, target_uuid) {
                    if new_path != current_path {
                        if let Ok(file) = File::open(&new_path).await {
                            reader = BufReader::new(file);
                            reader.seek(SeekFrom::Start(0)).await?;
                            replay_boundary = reader.get_ref().metadata().await?.len();
                            current_path = new_path;
                            state = TailState::new();
                            state.expected_session_uuid = session_id_from_path(&current_path);
                            caught_up = false;
                            pending_retarget_path = None;
                            let target_uuid = pending_retarget_uuid.take().unwrap_or_default();
                            let _ = evt_tx.send(CoreEvent::JsonlMeta {
                                id,
                                model: None,
                                title: None,
                                session_uuid: Some(target_uuid.clone()),
                                tokens_reset: true,
                                tokens: None,
                                input_tokens: None,
                                output_tokens: None,
                                cached_tokens: None,
                                cost_usd: None,
                                context_pct: None,
                            });
                            tracing::info!(
                                target: "kode_hook_probe",
                                ?current_path, %id, %target_uuid,
                                "jsonl tail retargeted after delayed target file appeared"
                            );
                            continue;
                        }
                    } else {
                        pending_retarget_uuid = None;
                    }
                }
            }

            // EOF:等待新行或 retarget 信号(谁先来都唤醒,避免 300ms 盲睡导致 retarget 延迟)。
            if let Some(rx) = retarget_rx.as_mut() {
                tokio::select! {
                    _ = sleep(Duration::from_millis(300)) => {}
                    changed = rx.changed() => {
                        if changed.is_err() {
                            // sender 已 drop(session 销毁)→ 退出
                            return Ok(());
                        }
                        // 有 retarget 信号,回到循环顶部应用
                        continue;
                    }
                }
            } else {
                sleep(Duration::from_millis(300)).await;
            }
            if evt_tx.is_closed() {
                return Ok(());
            }
            continue;
        }
        let line = buf.trim();
        if line.is_empty() {
            continue;
        }

        let upd = match backend {
            Backend::Codebuddy => parse_codebuddy_line(line, &mut state),
            Backend::Claude => parse_claude_line(line, &mut state),
            Backend::Codex => parse_codex_line(line, &mut state),
            Backend::Cursor => LineUpdate::default(),
        };

        // 自驱动 retarget:源文件里读到 `change session <target>`(in-TUI `/resume`)。
        // 仅在 caught_up(已追上文件末尾)或这行是本次打开文件后新追加的情况下生效 ——
        // 回放历史阶段读到的旧 change-session 行是过去事件,触发 retarget 会把 restore
        // 中的 tab 误勾到历史 target 文件。
        // resolve target jsonl 路径,切 reader 并 seek(0) 全量回放,重建 target session 的
        // model/title/tokens/session_uuid —— tab 元信息从此精确等于 target session 当前状态。
        if let Some(target_uuid) = upd.retarget_to.as_deref() {
            let is_live_retarget = caught_up || line_start >= replay_boundary;
            if !is_live_retarget {
                // 历史里的 change-session 行,跳过(不 retarget,也不参与元数据)
                continue;
            }
            if let Some(new_path) = resolve_retarget_path(backend, &current_path, target_uuid) {
                if new_path != current_path {
                    if let Ok(file) = File::open(&new_path).await {
                        reader = BufReader::new(file);
                        reader.seek(SeekFrom::Start(0)).await?;
                        replay_boundary = reader.get_ref().metadata().await?.len();
                        current_path = new_path;
                        state = TailState::new();
                        state.expected_session_uuid = session_id_from_path(&current_path);
                        caught_up = false;
                        pending_retarget_uuid = None;
                        // 显式通知 UI 清空旧 token/context(切到新 session 前先归零)。
                        let _ = evt_tx.send(CoreEvent::JsonlMeta {
                            id,
                            model: None,
                            title: None,
                            session_uuid: Some(target_uuid.to_string()),
                            tokens_reset: true,
                            tokens: None,
                            input_tokens: None,
                            output_tokens: None,
                            cached_tokens: None,
                            cost_usd: None,
                            context_pct: None,
                        });
                        tracing::info!(
                            target: "kode_hook_probe",
                            ?current_path, %id, %target_uuid,
                            "jsonl tail retargeted via change-session line (in-TUI /resume)"
                        );
                        continue;
                    }
                }
            } else {
                pending_retarget_uuid = Some(target_uuid.to_string());
                tracing::debug!(
                    %target_uuid, %id,
                    "change-session target jsonl not found yet; will retry"
                );
            }
            continue;
        }

        if !upd.changed() {
            continue;
        }

        if upd.tokens_reset {
            state.total_tokens = 0;
            state.input_tokens = 0;
            state.output_tokens = 0;
            state.cached_tokens = 0;
        }

        let has_token_update = upd.new_total.is_some()
            || upd.new_input.is_some()
            || upd.new_output.is_some()
            || upd.new_cached.is_some();

        if upd.tokens_are_cumulative {
            if let Some(t) = upd.new_total {
                state.total_tokens = t;
            }
            if let Some(t) = upd.new_input {
                state.input_tokens = t;
            }
            if let Some(t) = upd.new_output {
                state.output_tokens = t;
            }
            if let Some(t) = upd.new_cached {
                state.cached_tokens = t;
            }
        } else {
            state.total_tokens = state
                .total_tokens
                .saturating_add(upd.new_total.unwrap_or(0));
            state.input_tokens = state
                .input_tokens
                .saturating_add(upd.new_input.unwrap_or(0));
            state.output_tokens = state
                .output_tokens
                .saturating_add(upd.new_output.unwrap_or(0));
            state.cached_tokens = state
                .cached_tokens
                .saturating_add(upd.new_cached.unwrap_or(0));
        }

        if let Some(m) = upd.new_model.as_ref() {
            state.last_model = Some(m.clone());
        }
        if let Some(t) = upd.new_title.as_ref() {
            state.last_title = Some(t.clone());
        }

        // context_pct 使用最新一次请求的输入 token,不是历史最大值或累计值。
        let latest_ctx_used = upd.latest_context_tokens.unwrap_or(0);
        let context_pct = match state.last_model.as_deref() {
            Some(m) if latest_ctx_used > 0 => crate::context::context_pct(m, latest_ctx_used),
            _ => None,
        };

        if evt_tx
            .send(CoreEvent::JsonlMeta {
                id,
                model: upd.new_model,
                title: upd.new_title,
                session_uuid: upd.new_session_uuid,
                tokens_reset: upd.tokens_reset,
                tokens: has_token_update.then_some(state.total_tokens),
                input_tokens: has_token_update.then_some(state.input_tokens),
                output_tokens: has_token_update.then_some(state.output_tokens),
                cached_tokens: has_token_update.then_some(state.cached_tokens),
                cost_usd: None,
                context_pct,
            })
            .is_err()
        {
            return Ok(());
        }
    }
}

#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_file(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
    true
}

fn session_id_from_path(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| is_uuid_like(s))
        .map(String::from)
}

fn is_uuid_like(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    parts.len() == lens.len()
        && parts
            .iter()
            .zip(lens)
            .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

// ============================================================================
// codebuddy jsonl 解析
// ============================================================================

#[derive(Debug, Deserialize)]
struct CbEntry {
    #[serde(rename = "type")]
    r#type: Option<String>,
    /// "user" / "assistant"。用于区分 message 行是用户输入还是 LLM 回复
    /// (两者都是 type=="message" 且都带 providerData,只能靠 role 区分)。
    #[serde(default)]
    role: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    #[serde(rename = "providerData")]
    provider_data: Option<CbProviderData>,
    /// content 可能是 string 或 [{type:"input_text",text:"..."}]
    #[serde(default)]
    content: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct CbProviderData {
    model: Option<String>,
    #[serde(rename = "requestModelId")]
    request_model_id: Option<String>,
    // CodeBuddy 的 `requestModelName` 在模型切换后可能保留旧值，生产解析不读取它。
    // 仅保留给现有测试夹具反序列化，避免测试数据格式本身被误删。
    #[cfg(test)]
    #[serde(rename = "requestModelName")]
    request_model_name: Option<String>,
    usage: Option<CbUsage>,
}

impl CbProviderData {
    fn reported_model(&self) -> Option<String> {
        let model = self.request_model_id.clone().or_else(|| self.model.clone());
        #[cfg(test)]
        let model = model.or_else(|| self.request_model_name.clone());
        model
    }
}

#[derive(Debug, Deserialize)]
struct CbUsage {
    #[serde(rename = "totalTokens")]
    total_tokens: Option<u64>,
    #[serde(rename = "inputTokens")]
    input_tokens: Option<u64>,
    #[serde(rename = "outputTokens")]
    output_tokens: Option<u64>,
    #[serde(rename = "inputTokensDetails")]
    input_tokens_details: Option<Vec<CbInputDetail>>,
}

#[derive(Debug, Deserialize)]
struct CbInputDetail {
    cached_tokens: Option<u64>,
}

fn parse_codebuddy_line(line: &str, state: &mut TailState) -> LineUpdate {
    let mut upd = LineUpdate::default();
    let entry: CbEntry = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return upd,
    };

    // in-TUI `/resume <target>`:源文件里写一行 `change session <target-uuid>`,target uuid
    // 只在这行 stdout 文本里(该行 sessionId 仍是源)。检测到就把 target 透出去让 run()
    // 切文件 —— 这是唯一能捕获 in-TUI resume 的信号(hook 不 fire,见 extract_change_session_target)。
    // 提前 return:这行不属于当前 session 的元数据,不要参与 token/model/title 处理,
    // 也不要被下面的 expected_session_uuid 检查干扰。
    if let Some(target) = extract_change_session_target(&entry.content) {
        upd.retarget_to = Some(target);
        return upd;
    }

    let is_session_switch = is_session_switch_command(&entry.content);

    if let Some(sid) = entry.session_id.as_ref() {
        if let Some(expected) = state.expected_session_uuid.as_deref() {
            if sid != expected && !is_session_switch {
                return upd;
            }
        }
        if state.last_session_uuid.as_deref() != Some(sid) {
            state.last_session_uuid = Some(sid.clone());
            upd.new_session_uuid = Some(sid.clone());
        }
        if is_session_switch {
            state.expected_session_uuid = Some(sid.clone());
        } else if state.expected_session_uuid.is_none() {
            state.expected_session_uuid = Some(sid.clone());
        }
    }

    if entry.r#type.as_deref() == Some("ai-title") {
        if let Some(t) = entry.ai_title {
            if state.last_title.as_deref() != Some(&t) {
                upd.new_title = Some(t.clone());
            }
            // 记录下来,既能正确去重,也保证之后 user-message fallback 不会覆盖已有 ai-title。
            state.last_title = Some(t);
            state.title_fallback_used = true;
        }
    }

    // codebuddy 在产生 ai-title 之前,用第一条非命令 user message 当 title fallback。
    // 对齐 BackendChooser 列表 extract_user_title_from_line(commands.rs)的行为,
    // 否则没有 ai-title 的历史 session 被 resume / 选中建 tab 时,tail 永远 emit 不出 title,
    // tab 一直停在初始 "tab · <backend>"(与列表里显示的 user-message title 不一致)。
    //
    // codebuddy 行结构:user 输入与 assistant 回复都是 type=="message" 且都带 providerData,
    // 只能用 role 区分;系统注入块(<system-reminder>/<command-name>/<local-command-stdout>)
    // 也是 role=="user" 但内容以 `<` 开头,用 is_command_prefix 滤掉。
    if !state.title_fallback_used
        && !is_session_switch
        && entry.r#type.as_deref() == Some("message")
        && entry.role.as_deref() == Some("user")
    {
        if let Some(text) = extract_cb_content_text(&entry.content) {
            let trimmed = text.trim();
            if !trimmed.is_empty()
                && !is_command_prefix(trimmed)
                && !trimmed.starts_with('/')
                && !trimmed.starts_with("C-b")
            {
                let title: String = trimmed.chars().take(60).collect();
                if state.last_title.as_deref() != Some(&title) {
                    upd.new_title = Some(title.clone());
                }
                state.last_title = Some(title);
                state.title_fallback_used = true;
            }
        }
    }

    // 检测 session 切换命令 -- 重置 TailState,并显式通知 UI 清空旧 token/context。
    if is_session_switch {
        let session_uuid = upd.new_session_uuid.clone();
        let expected_session_uuid = state.expected_session_uuid.clone();
        *state = TailState::new();
        state.expected_session_uuid = expected_session_uuid;
        upd.tokens_reset = true;
        if let Some(sid) = session_uuid {
            state.last_session_uuid = Some(sid.clone());
            upd.new_session_uuid = Some(sid);
        }
        return upd;
    }

    // CodeBuddy 会把 `/model` 的结果写成 local-command stdout。这是当前使用者选择，
    // 先反映到状态栏；如果之后真实请求仍报旧 model，不要立刻覆盖这个选择。
    if let Some(model) = extract_model_switch(&entry.content) {
        let model = crate::model_alias::sanitize_model_name(&model);
        if !model.is_empty() {
            state.user_pinned_model = Some(model.clone());
            if state.last_emitted_model.as_deref() != Some(&model) {
                upd.new_model = Some(model.clone());
                state.last_emitted_model = Some(model);
            }
        }
        return upd;
    }

    if let Some(pd) = &entry.provider_data {
        if let Some(name) = pd.reported_model() {
            let name = crate::model_alias::sanitize_model_name(&name);
            if !name.is_empty() {
                // 只有 providerData 里的结构化字段才代表本次请求实际使用的模型。
                // `/model` 只是选择下一次请求的意图，不用它预判 UI 状态。
                state.last_model = Some(name.clone());
                let should_emit = match &state.user_pinned_model {
                    Some(pinned) if !names_match(pinned, &name) => false,
                    Some(_) => {
                        state.user_pinned_model = None;
                        state.last_emitted_model.as_deref() != Some(&name)
                    }
                    None => state.last_emitted_model.as_deref() != Some(&name),
                };
                if should_emit {
                    upd.new_model = Some(name.clone());
                    state.last_emitted_model = Some(name);
                }
            }
        }
        if let Some(u) = &pd.usage {
            // codebuddy 的 usage 字段是单次模型请求用量,不是 session 累计值。
            // run() 把每次请求的 usage 累加成 session 总量。
            let raw_input = u.input_tokens.unwrap_or(0);
            let raw_output = u.output_tokens.unwrap_or(0);
            let raw_total = u
                .total_tokens
                .unwrap_or_else(|| raw_input.saturating_add(raw_output));
            let raw_cached = u
                .input_tokens_details
                .as_ref()
                .and_then(|arr| arr.first())
                .and_then(|d| d.cached_tokens)
                .unwrap_or(0);

            if raw_total > 0 {
                upd.new_total = Some(raw_total);
            }
            if raw_input > 0 {
                upd.new_input = Some(raw_input);
            }
            if raw_output > 0 {
                upd.new_output = Some(raw_output);
            }
            if raw_cached > 0 {
                upd.new_cached = Some(raw_cached);
            }
            upd.latest_context_tokens = (raw_input > 0).then_some(raw_input);
        }
    }
    upd
}

fn names_match(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        crate::model_alias::sanitize_model_name(s)
            .chars()
            .filter(|c| !matches!(c, '-' | '_' | '.' | ' '))
            .flat_map(|c| c.to_lowercase())
            .collect()
    }
    norm(a) == norm(b)
}

fn extract_model_switch(content: &Option<serde_json::Value>) -> Option<String> {
    const PREFIX: &str = "<local-command-stdout>Switch model to ";
    const SUFFIX: &str = "</local-command-stdout>";
    let text = extract_cb_content_text(content)?.trim().to_string();
    text.strip_prefix(PREFIX)
        .and_then(|s| s.strip_suffix(SUFFIX))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// 检测 content 字段中是否包含会切换 codebuddy session 的命令。
///
/// Pattern: `<command-name>/clear</command-name>` 或
/// `<command-name>/resume</command-name>`。
fn is_session_switch_command(content: &Option<serde_json::Value>) -> bool {
    let text = match extract_cb_content_text(content) {
        Some(t) => t,
        None => return false,
    };
    matches!(
        text.trim(),
        "<command-name>/clear</command-name>" | "<command-name>/resume</command-name>"
    )
}

/// 从 `<local-command-stdout>change session <uuid></local-command-stdout>` 行解析出 target uuid。
///
/// 这是 codebuddy in-TUI `/resume <target>` 的**权威 target 信号**:逆向 codebuddy.js 证实
/// in-TUI `/resume` 走 setCurrent + notifySessionReset(只通知 ACP connection,不 fire
/// SessionStart hook),所以无法靠 hook 捕获 —— 唯一可读到 target 的地方就是源文件里这行
/// stdout 文本。注意:**这行本身的 sessionId 字段仍是源 session(不是 target)**,
/// target uuid 只藏在 stdout 文本里。run() 据此 resolve target jsonl 路径并切过去。
fn extract_change_session_target(content: &Option<serde_json::Value>) -> Option<String> {
    const PREFIX: &str = "<local-command-stdout>change session ";
    const SUFFIX: &str = "</local-command-stdout>";

    let text = extract_cb_content_text(content)?;
    let text = text.trim();
    if text.starts_with(PREFIX) && text.ends_with(SUFFIX) {
        let target = text[PREFIX.len()..text.len() - SUFFIX.len()].trim();
        if is_uuid_like(target) {
            return Some(target.to_string());
        }
    }
    None
}

/// 从 codebuddy 的 content 字段(string 或 array)中提取首个 text。
fn extract_cb_content_text(c: &Option<serde_json::Value>) -> Option<String> {
    let v = c.as_ref()?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(obj) = item.as_object() {
                if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

// ============================================================================
// claude jsonl 解析
// ============================================================================

#[derive(Debug, Deserialize)]
struct ClEntry {
    #[serde(rename = "type")]
    r#type: Option<String>,
    message: Option<ClMessage>,
}

#[derive(Debug, Deserialize)]
struct ClMessage {
    model: Option<String>,
    /// content 可能是 string 或 [{type:"text",text:"..."}, ...]
    #[serde(default)]
    content: Option<serde_json::Value>,
    usage: Option<ClUsage>,
}

#[derive(Debug, Deserialize)]
struct ClUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

fn parse_claude_line(line: &str, state: &mut TailState) -> LineUpdate {
    let mut upd = LineUpdate::default();
    let entry: ClEntry = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return upd,
    };

    let ty = entry.r#type.as_deref();
    let Some(msg) = entry.message else {
        return upd;
    };

    if ty == Some("assistant") {
        if let Some(m) = msg.model {
            if state.last_model.as_deref() != Some(&m) {
                upd.new_model = Some(m);
            }
        }
        if let Some(u) = msg.usage {
            // claude 的 input_tokens 不含 cached;total = input + output + cached_creation + cached_read
            // 我们语义对齐 codebuddy:
            //   - input_tokens(JsonlMeta):current request 全部 input(含 cached)
            //   - cached_tokens:cache_read 部分(已折扣 90%)
            let cache_creation = u.cache_creation_input_tokens.unwrap_or(0);
            let cached = u.cache_read_input_tokens.unwrap_or(0);
            let raw_input = u.input_tokens.unwrap_or(0);
            // Anthropic 把普通 input、cache write、cache read 分开报告;三者都属于 input。
            let input_total = raw_input + cache_creation + cached;
            let output = u.output_tokens.unwrap_or(0);
            let total = input_total + output;
            if input_total > 0 {
                upd.new_input = Some(input_total);
            }
            if output > 0 {
                upd.new_output = Some(output);
            }
            if cached > 0 {
                upd.new_cached = Some(cached);
            }
            if total > 0 {
                upd.new_total = Some(total);
            }
            upd.latest_context_tokens = (input_total > 0).then_some(input_total);
        }
    }

    // claude 不写 ai-title;用第一条非命令前缀的 user message 作 fallback
    if ty == Some("user") && !state.title_fallback_used {
        if let Some(text) = extract_user_text(&msg.content) {
            let trimmed = text.trim();
            if !trimmed.is_empty() && !is_command_prefix(trimmed) {
                let title: String = trimmed.chars().take(60).collect();
                if state.last_title.as_deref() != Some(&title) {
                    upd.new_title = Some(title);
                }
                state.title_fallback_used = true;
            }
        }
    }

    upd
}

/// content 可能是 string 或 array,提取首个 text 值
fn extract_user_text(c: &Option<serde_json::Value>) -> Option<String> {
    let v = c.as_ref()?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(obj) = item.as_object() {
                if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

/// 跳过 claude code 内嵌的命令型 user message:
///   `<local-command-caveat>...` / `<command-name>...` / `<command-message>...`
///   `<bash-stdout>...` 等等。简单规则:以 `<` 开头就跳。
fn is_command_prefix(s: &str) -> bool {
    s.starts_with('<')
}

// ============================================================================
// codex jsonl 解析
// ============================================================================

#[derive(Debug, Deserialize)]
struct CodexEntry {
    #[serde(rename = "type")]
    r#type: Option<String>,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct CodexTokenInfo {
    total_token_usage: Option<CodexUsage>,
    last_token_usage: Option<CodexUsage>,
}

#[derive(Debug, Deserialize)]
struct CodexUsage {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

fn parse_codex_line(line: &str, state: &mut TailState) -> LineUpdate {
    let mut upd = LineUpdate::default();
    let entry: CodexEntry = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return upd,
    };

    let payload_type = entry.payload.get("type").and_then(|v| v.as_str());

    if entry.r#type.as_deref() == Some("session_meta") {
        if let Some(sid) = entry
            .payload
            .get("session_id")
            .or_else(|| entry.payload.get("id"))
            .and_then(|v| v.as_str())
        {
            if state.last_session_uuid.as_deref() != Some(sid) {
                state.last_session_uuid = Some(sid.to_string());
                upd.new_session_uuid = Some(sid.to_string());
            }
        }
    }

    if entry.r#type.as_deref() == Some("turn_context") {
        if let Some(model) = entry.payload.get("model").and_then(|v| v.as_str()) {
            if state.last_model.as_deref() != Some(model) {
                upd.new_model = Some(model.to_string());
            }
        }
    }

    if entry.r#type.as_deref() == Some("event_msg") && payload_type == Some("token_count") {
        if let Some(info_value) = entry.payload.get("info") {
            if let Ok(info) = serde_json::from_value::<CodexTokenInfo>(info_value.clone()) {
                let latest_context_tokens = info
                    .last_token_usage
                    .as_ref()
                    .and_then(|u| u.input_tokens.or(u.total_tokens));
                if let Some(u) = info.total_token_usage.or(info.last_token_usage) {
                    upd.new_total = u.total_tokens;
                    upd.new_input = u.input_tokens;
                    upd.new_output = u.output_tokens;
                    upd.new_cached = u.cached_input_tokens;
                    upd.tokens_are_cumulative = true;
                    upd.latest_context_tokens = latest_context_tokens;
                }
            }
        }
    }

    if entry.r#type.as_deref() == Some("response_item")
        && payload_type == Some("message")
        && entry.payload.get("role").and_then(|v| v.as_str()) == Some("user")
        && !state.title_fallback_used
    {
        if let Some(text) = extract_codex_title_text(entry.payload.get("content")) {
            let trimmed = text.trim();
            let title: String = trimmed.chars().take(60).collect();
            if state.last_title.as_deref() != Some(&title) {
                upd.new_title = Some(title);
            }
            state.title_fallback_used = true;
        }
    }

    upd
}

fn is_codex_title_noise(s: &str) -> bool {
    s.starts_with("# AGENTS.md instructions")
        || s.starts_with("<environment_context>")
        || s.starts_with("<kode-memory>")
        || s.starts_with("<permissions instructions>")
        || s.starts_with("<collaboration_mode>")
        || s.starts_with("<skills_instructions>")
        || s.starts_with("● DeferExecuteTool(")
}

fn extract_codex_title_text(v: Option<&serde_json::Value>) -> Option<String> {
    let v = v?;
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        return (!trimmed.is_empty()
            && !is_command_prefix(trimmed)
            && !is_codex_title_noise(trimmed))
        .then(|| s.to_string());
    }
    if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(obj) = item.as_object() {
                for key in ["text", "input_text", "output_text"] {
                    if let Some(t) = obj.get(key).and_then(|v| v.as_str()) {
                        let trimmed = t.trim();
                        if !trimmed.is_empty()
                            && !is_command_prefix(trimmed)
                            && !is_codex_title_noise(trimmed)
                        {
                            return Some(t.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

static CLAIMED_CODEX_ROLLOUTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn claimed_codex_rollouts() -> &'static Mutex<HashSet<PathBuf>> {
    CLAIMED_CODEX_ROLLOUTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn find_and_claim_codex_session(cwd: &Path, not_before: SystemTime) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let mut claimed = claimed_codex_rollouts().lock().ok()?;
    let path = find_codex_session_candidate_under(
        &home.join(".codex").join("sessions"),
        cwd,
        not_before,
        &claimed,
    )?;
    claimed.insert(path.clone());
    Some(path)
}

fn find_codex_session_candidate_under(
    root: &Path,
    cwd: &Path,
    not_before: SystemTime,
    claimed: &HashSet<PathBuf>,
) -> Option<PathBuf> {
    let cutoff = not_before
        .checked_sub(Duration::from_secs(5))
        .unwrap_or(not_before);
    let mut best: Option<(SystemTime, PathBuf)> = None;
    collect_codex_sessions(root, cwd, cutoff, claimed, &mut best);
    best.map(|(_, path)| path)
}

fn find_codex_session_by_id_under(root: &Path, session_id: &str) -> Option<PathBuf> {
    let mut found = None;
    // The rollout filename (and session_meta.id) identifies the actual Codex
    // conversation. A derived/sub-agent rollout may carry the parent's UUID in
    // session_meta.session_id, so metadata fallback must never beat an exact
    // filename match elsewhere in the tree.
    collect_codex_session_by_filename(root, session_id, &mut found);
    if found.is_some() {
        return found;
    }
    collect_codex_session_by_id(root, session_id, &mut found);
    found
}

fn collect_codex_session_by_filename(dir: &Path, session_id: &str, found: &mut Option<PathBuf>) {
    if found.is_some() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_codex_session_by_filename(&path, session_id, found);
            if found.is_some() {
                return;
            }
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let matches = path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|stem| stem.ends_with(session_id));
        if matches {
            *found = Some(path);
            return;
        }
    }
}

fn collect_codex_session_by_id(dir: &Path, session_id: &str, found: &mut Option<PathBuf>) {
    if found.is_some() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_codex_session_by_id(&path, session_id, found);
            if found.is_some() {
                return;
            }
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if codex_session_meta_id(&path).as_deref() == Some(session_id) {
            *found = Some(path);
            return;
        }
    }
}

pub fn codex_session_meta_id(path: &Path) -> Option<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return None;
    };
    for line in text.lines().take(8) {
        let Ok(entry) = serde_json::from_str::<CodexEntry>(line) else {
            continue;
        };
        if entry.r#type.as_deref() != Some("session_meta") {
            continue;
        }
        return entry
            .payload
            .get("id")
            .or_else(|| entry.payload.get("session_id"))
            .and_then(|v| v.as_str())
            .map(String::from);
    }
    None
}

pub fn codex_session_cwd(path: &Path) -> Option<(String, PathBuf)> {
    let Ok(text) = fs::read_to_string(path) else {
        return None;
    };
    for line in text.lines().take(8) {
        let Ok(entry) = serde_json::from_str::<CodexEntry>(line) else {
            continue;
        };
        if entry.r#type.as_deref() != Some("session_meta") {
            continue;
        }
        let sid = entry
            .payload
            .get("id")
            .or_else(|| entry.payload.get("session_id"))
            .and_then(|v| v.as_str())?;
        let cwd = entry.payload.get("cwd").and_then(|v| v.as_str())?;
        return Some((sid.to_string(), PathBuf::from(cwd)));
    }
    None
}

fn collect_codex_sessions(
    dir: &Path,
    cwd: &Path,
    cutoff: SystemTime,
    claimed: &HashSet<PathBuf>,
    best: &mut Option<(SystemTime, PathBuf)>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_codex_sessions(&path, cwd, cutoff, claimed, best);
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if claimed.contains(&path) {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if modified < cutoff {
            continue;
        }
        if !codex_session_meta_matches_cwd(&path, cwd) {
            continue;
        }
        let replace = best
            .as_ref()
            .map(|(best_modified, _)| modified < *best_modified)
            .unwrap_or(true);
        if replace {
            *best = Some((modified, path));
        }
    }
}

fn codex_session_meta_matches_cwd(path: &Path, cwd: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    for line in text.lines().take(8) {
        let Ok(entry) = serde_json::from_str::<CodexEntry>(line) else {
            continue;
        };
        if entry.r#type.as_deref() != Some("session_meta") {
            continue;
        }
        let Some(found) = entry.payload.get("cwd").and_then(|v| v.as_str()) else {
            return false;
        };
        return Path::new(found) == cwd;
    }
    false
}

// ============================================================================
// tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn codebuddy_slug_strips_leading_slash_and_replaces_seps() {
        let p = PathBuf::from("/Users/tester/Projects/example/kode");
        let path = Backend::Codebuddy.session_path(&p, "abc").unwrap();
        let s = path.to_string_lossy();
        assert!(
            s.contains("/.codebuddy/projects/Users-tester-Projects-example-kode/abc.jsonl"),
            "got {s}"
        );
    }

    #[test]
    fn claude_slug_has_leading_dash() {
        let p = PathBuf::from("/Users/tester/Projects/example/kode");
        let path = Backend::Claude.session_path(&p, "abc").unwrap();
        let s = path.to_string_lossy();
        assert!(
            s.contains("/.claude/projects/-Users-tester-Projects-example-kode/abc.jsonl"),
            "got {s}"
        );
    }

    #[test]
    fn from_key_routes() {
        assert_eq!(
            Backend::from_backend_key("codebuddy"),
            Some(Backend::Codebuddy)
        );
        assert_eq!(Backend::from_backend_key("claude"), Some(Backend::Claude));
        assert_eq!(
            Backend::from_backend_key("claude-internal"),
            Some(Backend::Claude)
        );
        assert_eq!(Backend::from_backend_key("codex"), Some(Backend::Codex));
        assert_eq!(Backend::from_backend_key("cursor"), Some(Backend::Cursor));
        assert_eq!(Backend::from_backend_key("foo"), None);
    }

    #[test]
    fn cursor_session_path_is_discovered_not_session_id_based() {
        let p = PathBuf::from("/Users/tester/Projects/example/kode");
        assert!(Backend::Cursor.session_path(&p, "abc").is_none());
    }

    #[test]
    fn codex_session_path_is_discovered_not_session_id_based() {
        let p = PathBuf::from("/Users/tester/Projects/example/kode");
        assert!(Backend::Codex.session_path(&p, "abc").is_none());
    }

    #[test]
    fn parses_codebuddy_assistant_message_with_model_and_usage() {
        let line = r#"{"type":"message","role":"assistant","providerData":{"model":"claude-opus-4.7-1m","requestModelName":"Claude-Opus-4.7-1M","usage":{"totalTokens":36263,"inputTokens":30000,"outputTokens":6263,"inputTokensDetails":[{"cached_tokens":12345}]}}}"#;
        let mut state = TailState::new();
        let upd = parse_codebuddy_line(line, &mut state);
        assert_eq!(upd.new_model.as_deref(), Some("claude-opus-4.7-1m"));
        assert_eq!(upd.new_total, Some(36263));
        assert_eq!(upd.new_input, Some(30000));
        assert_eq!(upd.new_output, Some(6263));
        assert_eq!(upd.new_cached, Some(12345));
    }

    #[test]
    fn codebuddy_line_reports_session_uuid_changes() {
        let mut state = TailState::new();
        let first = r#"{"type":"message","role":"user","sessionId":"old-sid","content":"hello"}"#;
        let upd = parse_codebuddy_line(first, &mut state);
        assert_eq!(upd.new_session_uuid.as_deref(), Some("old-sid"));

        let same = r#"{"type":"message","role":"user","sessionId":"old-sid","content":"again"}"#;
        let upd = parse_codebuddy_line(same, &mut state);
        assert!(upd.new_session_uuid.is_none());

        let next = r#"{"type":"message","role":"user","sessionId":"new-sid","content":[{"type":"input_text","text":"<command-name>/clear</command-name>"}]}"#;
        let upd = parse_codebuddy_line(next, &mut state);
        assert_eq!(upd.new_session_uuid.as_deref(), Some("new-sid"));
    }

    #[test]
    fn codebuddy_line_ignores_unrelated_session_id_when_expected_is_set() {
        let mut state = TailState::new();
        state.expected_session_uuid = Some("11111111-1111-4111-8111-111111111111".to_string());

        let other = r#"{"type":"message","role":"assistant","sessionId":"22222222-2222-4222-8222-222222222222","providerData":{"requestModelName":"Wrong","usage":{"totalTokens":999}}}"#;
        let upd = parse_codebuddy_line(other, &mut state);
        assert!(!upd.changed());
        assert_eq!(
            state.expected_session_uuid.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );

        let clear = r#"{"type":"message","role":"user","sessionId":"22222222-2222-4222-8222-222222222222","content":[{"type":"input_text","text":"<command-name>/clear</command-name>"}]}"#;
        let upd = parse_codebuddy_line(clear, &mut state);
        assert!(upd.tokens_reset);
        assert_eq!(
            upd.new_session_uuid.as_deref(),
            Some("22222222-2222-4222-8222-222222222222")
        );
        assert_eq!(
            state.expected_session_uuid.as_deref(),
            Some("22222222-2222-4222-8222-222222222222")
        );
    }

    #[test]
    fn codebuddy_resume_command_allows_session_id_switch() {
        let mut state = TailState::new();
        state.expected_session_uuid = Some("11111111-1111-4111-8111-111111111111".to_string());

        let resume = r#"{"type":"message","role":"user","sessionId":"33333333-3333-4333-8333-333333333333","content":[{"type":"input_text","text":"<command-name>/resume</command-name>"}]}"#;
        let upd = parse_codebuddy_line(resume, &mut state);
        assert!(upd.tokens_reset);
        assert_eq!(
            upd.new_session_uuid.as_deref(),
            Some("33333333-3333-4333-8333-333333333333")
        );
        assert_eq!(
            state.expected_session_uuid.as_deref(),
            Some("33333333-3333-4333-8333-333333333333")
        );
    }

    #[test]
    fn extract_change_session_target_parses_uuid() {
        // content 为 array 格式
        let c = Some(serde_json::json!([{
            "type": "input_text",
            "text": "<local-command-stdout>change session da4f4c23-2779-4122-82ab-1147d9b7f532</local-command-stdout>"
        }]));
        assert_eq!(
            extract_change_session_target(&c).as_deref(),
            Some("da4f4c23-2779-4122-82ab-1147d9b7f532")
        );

        // content 为 string 格式
        let c = Some(serde_json::json!(
            "<local-command-stdout>change session 11111111-1111-4111-8111-111111111111</local-command-stdout>"
        ));
        assert_eq!(
            extract_change_session_target(&c).as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );

        // 非 uuid 的 target 不解析(防御 noise)
        let c = Some(serde_json::json!(
            "<local-command-stdout>change session not-a-uuid</local-command-stdout>"
        ));
        assert_eq!(extract_change_session_target(&c), None);

        // 其它 stdout 行不命中
        let c = Some(serde_json::json!(
            "<local-command-stdout>Switch model to gpt-5.5</local-command-stdout>"
        ));
        assert_eq!(extract_change_session_target(&c), None);
    }

    #[test]
    fn codebuddy_change_session_line_sets_retarget_to() {
        // in-TUI `/resume <target>` 在源文件里写的 `change session <target>` 行:
        // 该行 sessionId 仍是源(不是 target),但应透出 retarget_to=target,
        // 且不参与当前 session 的元数据(不动 expected_session_uuid)。
        let mut state = TailState::new();
        state.expected_session_uuid = Some("11111111-1111-4111-8111-111111111111".to_string());

        let line = r#"{"type":"message","role":"user","sessionId":"11111111-1111-4111-8111-111111111111","content":[{"type":"input_text","text":"<local-command-stdout>change session 22222222-2222-4222-8222-222222222222</local-command-stdout>"}]}"#;
        let upd = parse_codebuddy_line(line, &mut state);
        assert_eq!(
            upd.retarget_to.as_deref(),
            Some("22222222-2222-4222-8222-222222222222")
        );
        assert!(upd.changed());
        // expected 不被这行改动(retarget 由 run() 切文件时重置)
        assert_eq!(
            state.expected_session_uuid.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
    }

    #[test]
    fn codebuddy_uses_user_message_as_title_fallback_without_ai_title() {
        // 没有 ai-title 的 session:第一条真正的 user message 应被当作 title fallback,
        // 系统注入块(以 < 开头)和 assistant 行都不应触发。
        let mut state = TailState::new();

        // 系统注入块 — 不当 title
        let caveat = r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<system-reminder>caveat</system-reminder>"}]}"#;
        let upd = parse_codebuddy_line(caveat, &mut state);
        assert!(upd.new_title.is_none());

        // 第一条真实 user message — 当 title
        let user = r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"能不能在ui中加入emoji"}]}"#;
        let upd = parse_codebuddy_line(user, &mut state);
        assert_eq!(upd.new_title.as_deref(), Some("能不能在ui中加入emoji"));
        assert!(state.title_fallback_used);

        // 之后的 assistant 行不再覆盖 title
        let assistant = r#"{"type":"message","role":"assistant","content":[{"type":"input_text","text":"I will add emoji support"}],"providerData":{"requestModelName":"Claude-Opus","usage":{"totalTokens":10}}}"#;
        let upd = parse_codebuddy_line(assistant, &mut state);
        assert!(upd.new_title.is_none());
    }

    #[test]
    fn codebuddy_ai_title_overrides_user_fallback() {
        // user message 在前,ai-title 在后 → 最终 title 取 ai-title,user message 不再覆盖。
        let mut state = TailState::new();

        let user = r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"first user prompt"}]}"#;
        let upd = parse_codebuddy_line(user, &mut state);
        assert_eq!(upd.new_title.as_deref(), Some("first user prompt"));

        let ai = r#"{"type":"ai-title","aiTitle":"Add Emoji Support"}"#;
        let upd = parse_codebuddy_line(ai, &mut state);
        assert_eq!(upd.new_title.as_deref(), Some("Add Emoji Support"));
        assert_eq!(state.last_title.as_deref(), Some("Add Emoji Support"));

        // 再来一条 user message 不应把 ai-title 覆盖掉
        let user2 = r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"second user prompt"}]}"#;
        let upd = parse_codebuddy_line(user2, &mut state);
        assert!(upd.new_title.is_none());
    }

    #[test]
    fn codebuddy_title_fallback_skips_command_lines() {
        // slash 命令 / 命令注入块 / C-b 都不当 title。
        let cases = [
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<command-name>/clear</command-name>"}]}"#,
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<local-command-stdout>change session abc</local-command-stdout>"}]}"#,
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"/help"}]}"#,
            r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"C-b c"}]}"#,
        ];
        for line in cases {
            let mut state = TailState::new();
            let upd = parse_codebuddy_line(line, &mut state);
            assert!(
                upd.new_title.is_none(),
                "should not set title for command line: {line}"
            );
            assert!(!state.title_fallback_used);
        }
    }

    #[test]
    fn codebuddy_model_switch_command_updates_ui_until_actual_model_arrives() {
        let mut state = TailState::new();

        let old_request = r#"{"type":"message","role":"assistant","providerData":{"requestModelName":"GLM-5.2","usage":{"totalTokens":100,"inputTokens":80,"outputTokens":20}}}"#;
        let upd = parse_codebuddy_line(old_request, &mut state);
        assert_eq!(upd.new_model.as_deref(), Some("GLM-5.2"));

        // CodeBuddy 会把 `/model` 的选择结果写成 local-command stdout，先更新 UI。
        let switch = r#"{"type":"message","role":"user","content":"<local-command-stdout>Switch model to gpt-5.6-sol</local-command-stdout>","providerData":{"skipRun":true}}"#;
        let upd = parse_codebuddy_line(switch, &mut state);
        assert_eq!(upd.new_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(state.user_pinned_model.as_deref(), Some("gpt-5.6-sol"));

        // 直到新请求的 providerData 报告实际模型，UI 才更新。
        let new_request = r#"{"type":"message","role":"assistant","providerData":{"requestModelName":"GLM-5.2","usage":{"totalTokens":120,"inputTokens":90,"outputTokens":30}}}"#;
        let upd = parse_codebuddy_line(new_request, &mut state);
        assert!(upd.new_model.is_none());
        assert_eq!(state.last_model.as_deref(), Some("GLM-5.2"));

        let actual_new = r#"{"type":"message","role":"assistant","providerData":{"requestModelName":"gpt-5.6-sol","usage":{"totalTokens":140,"inputTokens":100,"outputTokens":40}}}"#;
        let upd = parse_codebuddy_line(actual_new, &mut state);
        assert!(upd.new_model.is_none());
        assert_eq!(state.last_model.as_deref(), Some("gpt-5.6-sol"));
        assert!(state.user_pinned_model.is_none());
    }

    #[test]
    fn codebuddy_assistant_model_note_suffix_is_sanitized() {
        let mut state = TailState::new();
        let line = r#"{"type":"message","role":"assistant","providerData":{"requestModelName":"Claude-Opus-4.8-1M Note: The model was saved to user settings","usage":{"totalTokens":100,"inputTokens":80,"outputTokens":20}}}"#;
        let upd = parse_codebuddy_line(line, &mut state);
        assert_eq!(upd.new_model.as_deref(), Some("Claude-Opus-4.8-1M"));
        assert_eq!(state.last_model.as_deref(), Some("Claude-Opus-4.8-1M"));
    }

    /// /clear command should reset the actual-model and token state.
    #[test]
    fn codebuddy_clear_command_resets_tail_state() {
        let mut state = TailState::new();
        state.last_model = Some("GLM-5.2".to_string());
        state.last_emitted_model = Some("GLM-5.2".to_string());
        state.total_tokens = 5000;
        state.input_tokens = 4000;

        let clear =
            r#"{"type":"message","role":"user","content":"<command-name>/clear</command-name>"}"#;
        let upd = parse_codebuddy_line(clear, &mut state);
        assert!(upd.changed());
        assert!(upd.tokens_reset);
        assert!(state.last_model.is_none());
        assert!(state.last_emitted_model.is_none());
        assert_eq!(state.total_tokens, 0);
        assert_eq!(state.input_tokens, 0);
        assert_eq!(state.output_tokens, 0);
        assert_eq!(state.cached_tokens, 0);
    }

    /// /clear in array content format should also reset TailState.
    #[test]
    fn codebuddy_clear_command_array_format_resets_state() {
        let mut state = TailState::new();
        state.last_model = Some("GLM-5.2".to_string());
        state.last_emitted_model = Some("GLM-5.2".to_string());
        state.total_tokens = 5000;
        state.input_tokens = 4000;

        let clear = r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<command-name>/clear</command-name>"}]}"#;
        let upd = parse_codebuddy_line(clear, &mut state);
        assert!(upd.changed());
        assert!(upd.tokens_reset);
        assert!(state.last_model.is_none());
        assert!(state.last_emitted_model.is_none());
        assert_eq!(state.total_tokens, 0);
        assert_eq!(state.input_tokens, 0);
    }

    /// End-to-end: when the jsonl file is truncated and rewritten (simulating
    /// codebuddy /clear), the tail task should detect truncation, reset state,
    /// and continue reading from the beginning.
    #[tokio::test(flavor = "multi_thread")]
    async fn tail_detects_file_truncation_and_resets_state() {
        use std::io::Write;
        let tmp = tempfile_path("kode_tail_trunc_test.jsonl");

        // Write initial content
        let mut f = std::fs::File::create(&tmp).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"Session One","sessionId":"x"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"Claude-Opus-4.7-1M","usage":{{"totalTokens":1000,"inputTokens":800,"outputTokens":200}}}}}}"#
        )
        .unwrap();
        drop(f);

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(88, Backend::Codebuddy, tmp.clone(), tx, None);

        // Wait for tail to read initial content
        sleep(Duration::from_millis(300)).await;

        // Now truncate and rewrite (simulating /clear)
        let mut f = std::fs::File::create(&tmp).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"Session Two","sessionId":"x"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"Kimi-K2.6-IOA","usage":{{"totalTokens":500,"inputTokens":400,"outputTokens":100}}}}}}"#
        )
        .unwrap();
        drop(f);

        // Collect all events
        let mut events = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            for _ in 0..10 {
                match rx.recv().await {
                    Some(ev) => events.push(ev),
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_file(&tmp);

        // Find the second session's title (must appear after truncation)
        let titles: Vec<_> = events
            .iter()
            .filter_map(|ev| match ev {
                CoreEvent::JsonlMeta { title, .. } => title.clone(),
                _ => None,
            })
            .collect();
        assert!(
            titles.contains(&"Session Two".to_string()),
            "truncation re-read should find Session Two title, got titles: {:?}",
            titles
        );

        // Find the second session's model
        let models: Vec<_> = events
            .iter()
            .filter_map(|ev| match ev {
                CoreEvent::JsonlMeta { model, .. } => model.clone(),
                _ => None,
            })
            .collect();
        assert!(
            models.contains(&"Kimi-K2.6-IOA".to_string()),
            "truncation re-read should find Kimi model, got models: {:?}",
            models
        );
    }

    /// End-to-end: when /clear rewrites jsonl via atomic rename, the old fd stays
    /// at EOF on the removed inode. The tail task must reopen the path and read
    /// the new file, otherwise later actual request metadata never reaches the tab UI.
    #[tokio::test(flavor = "multi_thread")]
    async fn tail_detects_file_replacement_and_resets_state() {
        use std::io::Write;
        let tmp = tempfile_path("kode_tail_replace_test.jsonl");
        let replacement = tempfile_path("kode_tail_replace_test.new.jsonl");

        let mut f = std::fs::File::create(&tmp).unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"Claude-Sonnet-4.6-1M","usage":{{"totalTokens":1000,"inputTokens":800,"outputTokens":200}}}}}}"#
        )
        .unwrap();
        drop(f);

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(89, Backend::Codebuddy, tmp.clone(), tx, None);

        sleep(Duration::from_millis(300)).await;

        let mut f = std::fs::File::create(&replacement).unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"user","content":[{{"type":"input_text","text":"<command-name>/clear</command-name>"}}],"providerData":{{"skipRun":true}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"gpt-5.5","usage":{{"totalTokens":120,"inputTokens":90,"outputTokens":30}}}}}}"#
        )
        .unwrap();
        drop(f);
        std::fs::rename(&replacement, &tmp).unwrap();

        let mut events = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            for _ in 0..10 {
                match rx.recv().await {
                    Some(ev) => events.push(ev),
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&replacement);

        let models: Vec<_> = events
            .iter()
            .filter_map(|ev| match ev {
                CoreEvent::JsonlMeta { model, .. } => model.clone(),
                _ => None,
            })
            .collect();
        assert!(
            models.contains(&"gpt-5.5".to_string()),
            "replacement re-read should find actual model gpt-5.5, got models: {:?}",
            models
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tail_retargets_via_watch_channel_to_new_session_file() {
        // 模拟 SessionStart hook 给出新 transcript_path:tail 应切到新文件并 emit 新 session 的
        // model / session_uuid。这取代了旧的 /clear mtime 盲扫 retarget。
        use std::io::Write;
        let dir = tempfile_dir("kode_tail_watch_retarget_test");
        let old_id = "11111111-1111-4111-8111-111111111111";
        let new_id = "22222222-2222-4222-8222-222222222222";
        let old_path = dir.join(format!("{old_id}.jsonl"));
        let new_path = dir.join(format!("{new_id}.jsonl"));

        let mut f = std::fs::File::create(&old_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"Claude-Sonnet-4.6-1M","usage":{{"totalTokens":100,"inputTokens":80,"outputTokens":20}}}},"sessionId":"{old_id}"}}"#
        )
        .unwrap();
        drop(f);

        // 新 session 文件(resume 切过去的目标),带不同 model
        let mut f = std::fs::File::create(&new_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"GPT-5.5","usage":{{"totalTokens":50,"inputTokens":40,"outputTokens":10}}}},"sessionId":"{new_id}"}}"#
        )
        .unwrap();
        drop(f);

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        let (retarget_tx, retarget_rx) = tokio::sync::watch::channel::<Option<PathBuf>>(None);
        spawn(
            90,
            Backend::Codebuddy,
            old_path.clone(),
            tx,
            Some(retarget_rx),
        );
        sleep(Duration::from_millis(300)).await;

        // 发 retarget 信号(等价于 SessionStart hook 的 transcript_path)
        retarget_tx.send(Some(new_path.clone())).unwrap();

        let mut models = Vec::new();
        let mut session_uuids = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while !models.iter().any(|m| m == "GPT-5.5")
                || !session_uuids.iter().any(|sid| sid == new_id)
            {
                match rx.recv().await {
                    Some(CoreEvent::JsonlMeta {
                        model,
                        session_uuid,
                        ..
                    }) => {
                        if let Some(m) = model {
                            models.push(m);
                        }
                        if let Some(sid) = session_uuid {
                            session_uuids.push(sid);
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            models.iter().any(|m| m == "GPT-5.5"),
            "retargeted tail should emit model from new session file, got: {models:?}"
        );
        assert!(
            session_uuids.iter().any(|sid| sid == new_id),
            "retargeted tail should emit new session uuid, got: {session_uuids:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tail_self_retargets_on_change_session_line() {
        // 模拟 codebuddy in-TUI `/resume <target>`:源文件追加一行
        // `change session <target>`,tail 应自动 resolve 同目录的 target jsonl、
        // 切过去并全量回放,emit target 的 model / session_uuid。
        // 这是 in-TUI resume 的权威路径(不依赖 hook / watch channel)。
        use std::io::Write;
        let dir = tempfile_dir("kode_tail_change_session_test");
        let src_id = "11111111-1111-4111-8111-111111111111";
        let tgt_id = "22222222-2222-4222-8222-222222222222";
        let src_path = dir.join(format!("{src_id}.jsonl"));
        let tgt_path = dir.join(format!("{tgt_id}.jsonl"));

        // 源文件:有自己的 model
        let mut f = std::fs::File::create(&src_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","sessionId":"{src_id}","providerData":{{"requestModelName":"Claude-Sonnet-4.6-1M","usage":{{"totalTokens":100,"inputTokens":80,"outputTokens":20}}}}}}"#
        )
        .unwrap();
        drop(f);

        // target 文件:已有历史(全量回放要能读到它的 title + model)
        let mut f = std::fs::File::create(&tgt_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"Target Session","sessionId":"{tgt_id}"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","sessionId":"{tgt_id}","providerData":{{"requestModelName":"GPT-5.5","usage":{{"totalTokens":777,"inputTokens":700,"outputTokens":77}}}}}}"#
        )
        .unwrap();
        drop(f);

        // codebuddy backend 但用 find_session_file_by_id 兜底需要 ~/.codebuddy 目录,
        // 这里 target 与源同目录,resolve_retarget_path 走「同目录」分支即可命中,无需全局扫描。
        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(91, Backend::Codebuddy, src_path.clone(), tx, None);
        sleep(Duration::from_millis(300)).await;

        // 模拟 /resume:源文件追加 change session 行
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&src_path)
            .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"user","sessionId":"{src_id}","content":[{{"type":"input_text","text":"<local-command-stdout>change session {tgt_id}</local-command-stdout>"}}]}}"#
        )
        .unwrap();
        drop(f);

        let mut models = Vec::new();
        let mut titles = Vec::new();
        let mut session_uuids = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while !models.iter().any(|m| m == "GPT-5.5")
                || !titles.iter().any(|t| t == "Target Session")
                || !session_uuids.iter().any(|sid| sid == tgt_id)
            {
                match rx.recv().await {
                    Some(CoreEvent::JsonlMeta {
                        model,
                        title,
                        session_uuid,
                        ..
                    }) => {
                        if let Some(m) = model {
                            models.push(m);
                        }
                        if let Some(t) = title {
                            titles.push(t);
                        }
                        if let Some(sid) = session_uuid {
                            session_uuids.push(sid);
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            models.iter().any(|m| m == "GPT-5.5"),
            "after /resume, tail should emit target model GPT-5.5, got: {models:?}"
        );
        assert!(
            titles.iter().any(|t| t == "Target Session"),
            "after /resume, tail should emit target title, got: {titles:?}"
        );
        assert!(
            session_uuids.iter().any(|sid| sid == tgt_id),
            "after /resume, tail should emit target session uuid, got: {session_uuids:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tail_treats_change_session_appended_during_initial_replay_as_live() {
        // 真实复现:老 session jsonl 很长,tail 还在初始回放时用户已经执行 `/resume`
        // 并选中目标 session。`change session <target>` 是本次 tail 启动后追加的,
        // 即使 caught_up=false,也必须按实时 retarget 处理。
        use std::io::Write;
        let dir = tempfile_dir("kode_tail_live_change_during_replay_test");
        let src_id = "77777777-7777-4777-8777-777777777777";
        let tgt_id = "88888888-8888-4888-8888-888888888888";
        let src_path = dir.join(format!("{src_id}.jsonl"));
        let tgt_path = dir.join(format!("{tgt_id}.jsonl"));

        let mut f = std::fs::File::create(&src_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","sessionId":"{src_id}","providerData":{{"requestModelName":"Claude-Sonnet-4.6","usage":{{"totalTokens":100,"inputTokens":80,"outputTokens":20}}}}}}"#
        )
        .unwrap();
        // 让初始回放保持一段时间,确保下面 append 发生时 caught_up 仍可能为 false。
        writeln!(f, "{}", "not-json ".repeat(512 * 1024)).unwrap();
        drop(f);

        let mut f = std::fs::File::create(&tgt_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"Live Target","sessionId":"{tgt_id}"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","sessionId":"{tgt_id}","providerData":{{"requestModelName":"GPT-5.5","usage":{{"totalTokens":999,"inputTokens":900,"outputTokens":99}}}}}}"#
        )
        .unwrap();
        drop(f);

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(94, Backend::Codebuddy, src_path.clone(), tx, None);

        // 收到源 session 第一条 meta,说明 tail 已打开文件并记录 replay_boundary。
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(ev) = rx.recv().await {
                if matches!(ev, CoreEvent::JsonlMeta { .. }) {
                    break;
                }
            }
        })
        .await;

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&src_path)
            .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"user","sessionId":"{src_id}","content":[{{"type":"input_text","text":"<local-command-stdout>change session {tgt_id}</local-command-stdout>"}}]}}"#
        )
        .unwrap();
        drop(f);

        let mut models = Vec::new();
        let mut titles = Vec::new();
        let mut session_uuids = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(4), async {
            while !models.iter().any(|m| m == "GPT-5.5")
                || !titles.iter().any(|t| t == "Live Target")
                || !session_uuids.iter().any(|sid| sid == tgt_id)
            {
                match rx.recv().await {
                    Some(CoreEvent::JsonlMeta {
                        model,
                        title,
                        session_uuid,
                        ..
                    }) => {
                        if let Some(m) = model {
                            models.push(m);
                        }
                        if let Some(t) = title {
                            titles.push(t);
                        }
                        if let Some(sid) = session_uuid {
                            session_uuids.push(sid);
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            models.iter().any(|m| m == "GPT-5.5"),
            "live change during replay should emit target model, got: {models:?}"
        );
        assert!(
            titles.iter().any(|t| t == "Live Target"),
            "live change during replay should emit target title, got: {titles:?}"
        );
        assert!(
            session_uuids.iter().any(|sid| sid == tgt_id),
            "live change during replay should emit target session uuid, got: {session_uuids:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tail_retries_change_session_until_target_file_exists() {
        // codebuddy 可能先把 `change session <target>` 写进源文件,目标 jsonl 稍后
        // 才创建。tail 必须记住 target 并在 EOF 轮询里重试,否则 tab 会永久停在源 session。
        use std::io::Write;
        let dir = tempfile_dir("kode_tail_delayed_change_session_test");
        let src_id = "55555555-5555-4555-8555-555555555555";
        let tgt_id = "66666666-6666-4666-8666-666666666666";
        let src_path = dir.join(format!("{src_id}.jsonl"));
        let tgt_path = dir.join(format!("{tgt_id}.jsonl"));

        let mut f = std::fs::File::create(&src_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","sessionId":"{src_id}","providerData":{{"requestModelName":"Claude-Sonnet-4.6","usage":{{"totalTokens":100,"inputTokens":80,"outputTokens":20}}}}}}"#
        )
        .unwrap();
        drop(f);

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(93, Backend::Codebuddy, src_path.clone(), tx, None);
        sleep(Duration::from_millis(300)).await;

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&src_path)
            .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"user","sessionId":"{src_id}","content":[{{"type":"input_text","text":"<local-command-stdout>change session {tgt_id}</local-command-stdout>"}}]}}"#
        )
        .unwrap();
        drop(f);

        sleep(Duration::from_millis(700)).await;

        let mut f = std::fs::File::create(&tgt_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"Delayed Target","sessionId":"{tgt_id}"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","sessionId":"{tgt_id}","providerData":{{"requestModelName":"GPT-5.5","usage":{{"totalTokens":888,"inputTokens":800,"outputTokens":88}}}}}}"#
        )
        .unwrap();
        drop(f);

        let mut models = Vec::new();
        let mut titles = Vec::new();
        let mut session_uuids = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(4), async {
            while !models.iter().any(|m| m == "GPT-5.5")
                || !titles.iter().any(|t| t == "Delayed Target")
                || !session_uuids.iter().any(|sid| sid == tgt_id)
            {
                match rx.recv().await {
                    Some(CoreEvent::JsonlMeta {
                        model,
                        title,
                        session_uuid,
                        ..
                    }) => {
                        if let Some(m) = model {
                            models.push(m);
                        }
                        if let Some(t) = title {
                            titles.push(t);
                        }
                        if let Some(sid) = session_uuid {
                            session_uuids.push(sid);
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            models.iter().any(|m| m == "GPT-5.5"),
            "delayed target should eventually emit target model, got: {models:?}"
        );
        assert!(
            titles.iter().any(|t| t == "Delayed Target"),
            "delayed target should eventually emit target title, got: {titles:?}"
        );
        assert!(
            session_uuids.iter().any(|sid| sid == tgt_id),
            "delayed target should eventually emit target session uuid, got: {session_uuids:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tail_ignores_historical_change_session_during_initial_replay() {
        // 关键回归(用户报告:tab 无法恢复):restore 一个**已含历史 `change session`
        // 行**的源文件时,tail 从头全量回放,绝不能被历史 change-session 行勾走 ——
        // 必须停在源文件、读出源 session 自己的 model/title。retarget 只对 caught_up
        // 之后实时追加的 change-session 行生效。
        use std::io::Write;
        let dir = tempfile_dir("kode_tail_historical_change_session_test");
        let src_id = "33333333-3333-4333-8333-333333333333";
        let other_id = "44444444-4444-4444-8444-444444444444";
        let src_path = dir.join(format!("{src_id}.jsonl"));
        let other_path = dir.join(format!("{other_id}.jsonl"));

        // 干扰文件(历史 /resume 的旧 target)—— 若 bug 复现会被错误切到这里
        let mut f = std::fs::File::create(&other_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"WRONG Session","sessionId":"{other_id}"}}"#
        )
        .unwrap();
        drop(f);

        // 源文件:含历史 change-session 行(过去做过 /resume),但之后又续写了自己的内容
        let mut f = std::fs::File::create(&src_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"Correct Source","sessionId":"{src_id}"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"user","sessionId":"{src_id}","content":[{{"type":"input_text","text":"<local-command-stdout>change session {other_id}</local-command-stdout>"}}]}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","sessionId":"{src_id}","providerData":{{"requestModelName":"Claude-Sonnet-4.6-1M","usage":{{"totalTokens":555,"inputTokens":500,"outputTokens":55}}}}}}"#
        )
        .unwrap();
        drop(f);

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(92, Backend::Codebuddy, src_path.clone(), tx, None);

        // 收集 1.5s 内所有 meta,断言全部来自源 session,从未出现 WRONG / other_id
        let mut models = Vec::new();
        let mut titles = Vec::new();
        let mut session_uuids = Vec::new();
        let _ = tokio::time::timeout(Duration::from_millis(1500), async {
            loop {
                match rx.recv().await {
                    Some(CoreEvent::JsonlMeta {
                        model,
                        title,
                        session_uuid,
                        ..
                    }) => {
                        if let Some(m) = model {
                            models.push(m);
                        }
                        if let Some(t) = title {
                            titles.push(t);
                        }
                        if let Some(sid) = session_uuid {
                            session_uuids.push(sid);
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            !titles.iter().any(|t| t == "WRONG Session"),
            "must NOT retarget to historical change-session target; titles: {titles:?}"
        );
        assert!(
            !session_uuids.iter().any(|sid| sid == other_id),
            "must NOT emit other session uuid from historical change-session line; uuids: {session_uuids:?}"
        );
        assert!(
            titles.iter().any(|t| t == "Correct Source"),
            "should read the source session's own title; titles: {titles:?}"
        );
        assert!(
            models.iter().any(|m| m == "Claude-Sonnet-4.6-1M"),
            "should read the source session's own model; models: {models:?}"
        );
    }

    #[test]
    fn parses_claude_assistant_message_with_model_and_usage() {
        let line = r#"{"type":"assistant","message":{"model":"claude-4.7-opus","usage":{"input_tokens":33087,"cache_creation_input_tokens":33081,"cache_read_input_tokens":1000,"output_tokens":4666}}}"#;
        let mut state = TailState::new();
        let upd = parse_claude_line(line, &mut state);
        assert_eq!(upd.new_model.as_deref(), Some("claude-4.7-opus"));
        // 普通 input + cache creation + cache read 都属于 input token。
        assert_eq!(upd.new_input, Some(33087 + 33081 + 1000));
        assert_eq!(upd.new_output, Some(4666));
        assert_eq!(upd.new_cached, Some(1000));
        // total = input_total + output
        assert_eq!(upd.new_total, Some(33087 + 33081 + 1000 + 4666));
    }

    #[test]
    fn parses_codex_turn_context_and_token_count() {
        let mut state = TailState::new();
        let model_line = r#"{"timestamp":"2026-06-14T08:16:30Z","type":"turn_context","payload":{"cwd":"/tmp/p","model":"gpt-5.5"}}"#;
        let upd = parse_codex_line(model_line, &mut state);
        assert_eq!(upd.new_model.as_deref(), Some("gpt-5.5"));

        let token_line = r#"{"timestamp":"2026-06-14T08:16:40Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9999999,"cached_input_tokens":8888888,"output_tokens":7777,"reasoning_output_tokens":255,"total_tokens":10007776},"last_token_usage":{"input_tokens":20767,"cached_input_tokens":11136,"output_tokens":463,"reasoning_output_tokens":255,"total_tokens":21230},"model_context_window":258400}}}"#;
        let upd = parse_codex_line(token_line, &mut state);
        assert_eq!(upd.new_total, Some(10007776));
        assert_eq!(upd.new_input, Some(9999999));
        assert_eq!(upd.new_output, Some(7777));
        assert_eq!(upd.new_cached, Some(8888888));
        assert_eq!(upd.latest_context_tokens, Some(20767));
    }

    #[test]
    fn codex_session_meta_reports_session_uuid() {
        let mut state = TailState::new();
        let line = r#"{"type":"session_meta","payload":{"session_id":"019f1ca5-47a9-72f3-a0be-86a8f37fb67a","cwd":"/tmp/p"}}"#;
        let upd = parse_codex_line(line, &mut state);
        assert_eq!(
            upd.new_session_uuid.as_deref(),
            Some("019f1ca5-47a9-72f3-a0be-86a8f37fb67a")
        );
    }

    #[test]
    fn codex_user_message_becomes_title() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我适配 codex cli backend"}]}}"#;
        let mut state = TailState::new();
        let upd = parse_codex_line(line, &mut state);
        assert_eq!(upd.new_title.as_deref(), Some("帮我适配 codex cli backend"));
        assert!(state.title_fallback_used);
    }

    #[test]
    fn codex_title_skips_image_markup_before_user_text() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<image name=[Image #1] path=\"/tmp/example.png\">"},{"type":"input_image","image_url":"data:image/png;base64,abc"},{"type":"input_text","text":"</image>"},{"type":"input_text","text":"你看看为啥这个tab显示不正常"}]}}"#;
        let mut state = TailState::new();
        let upd = parse_codex_line(line, &mut state);
        assert_eq!(
            upd.new_title.as_deref(),
            Some("你看看为啥这个tab显示不正常")
        );
        assert!(state.title_fallback_used);
    }

    #[test]
    fn codex_title_skips_injected_startup_context() {
        let mut state = TailState::new();
        let noise = r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/p\n\n<INSTRUCTIONS>...</INSTRUCTIONS>"},{"type":"input_text","text":"<environment_context>...</environment_context>"}]}}"##;
        let upd = parse_codex_line(noise, &mut state);
        assert!(upd.new_title.is_none());
        assert!(!state.title_fallback_used);

        let real = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"为啥当前title还是没有更新，codex的tab"}]}}"#;
        let upd = parse_codex_line(real, &mut state);
        assert_eq!(
            upd.new_title.as_deref(),
            Some("为啥当前title还是没有更新，codex的tab")
        );
        assert!(state.title_fallback_used);
    }

    #[test]
    fn codex_title_skips_deferred_tool_output() {
        let mut state = TailState::new();
        let noise = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"● DeferExecuteTool(mcp__memory__memory_search)\n╭────────────"}]}}"#;
        let upd = parse_codex_line(noise, &mut state);
        assert!(upd.new_title.is_none());
        assert!(!state.title_fallback_used);

        let real = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"为什么codex有三个tab"}]}}"#;
        let upd = parse_codex_line(real, &mut state);
        assert_eq!(upd.new_title.as_deref(), Some("为什么codex有三个tab"));
        assert!(state.title_fallback_used);
    }

    #[test]
    fn backend_rejects_cross_backend_transcript_paths() {
        let codebuddy = Path::new("/Users/test/.codebuddy/projects/Users-test-app/session.jsonl");
        let codex = Path::new("/Users/test/.codex/sessions/2026/08/24/rollout-session.jsonl");

        assert!(Backend::Codebuddy.accepts_transcript_path(codebuddy));
        assert!(!Backend::Codex.accepts_transcript_path(codebuddy));
        assert!(Backend::Codex.accepts_transcript_path(codex));
        assert!(!Backend::Codebuddy.accepts_transcript_path(codex));
    }

    #[test]
    fn finds_earliest_unclaimed_codex_session_matching_cwd() {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kode-codex-session-test-{stamp}"));
        let day = root.join("2026/06/14");
        std::fs::create_dir_all(&day).unwrap();
        let cwd = PathBuf::from("/tmp/kode-cwd");
        let other = day.join("rollout-other.jsonl");
        std::fs::write(
            &other,
            r#"{"type":"session_meta","payload":{"cwd":"/tmp/other"}}"#,
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(10));
        let expected = day.join("rollout-match.jsonl");
        std::fs::write(
            &expected,
            r#"{"type":"session_meta","payload":{"cwd":"/tmp/kode-cwd"}}"#,
        )
        .unwrap();

        let found = find_codex_session_candidate_under(
            &root,
            &cwd,
            SystemTime::UNIX_EPOCH,
            &HashSet::new(),
        );
        assert_eq!(found.as_deref(), Some(expected.as_path()));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_session_claim_skips_already_claimed_rollout() {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kode-codex-session-claim-test-{stamp}"));
        let day = root.join("2026/07/02");
        std::fs::create_dir_all(&day).unwrap();
        let cwd = PathBuf::from("/tmp/kode-cwd");

        let first = day.join("rollout-first.jsonl");
        std::fs::write(
            &first,
            r#"{"type":"session_meta","payload":{"cwd":"/tmp/kode-cwd","session_id":"first"}}"#,
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(10));
        let second = day.join("rollout-second.jsonl");
        std::fs::write(
            &second,
            r#"{"type":"session_meta","payload":{"cwd":"/tmp/kode-cwd","session_id":"second"}}"#,
        )
        .unwrap();

        let mut claimed = HashSet::new();
        claimed.insert(first.clone());
        let found =
            find_codex_session_candidate_under(&root, &cwd, SystemTime::UNIX_EPOCH, &claimed);
        assert_eq!(found.as_deref(), Some(second.as_path()));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_codex_session_by_id() {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kode-codex-session-id-test-{stamp}"));
        let day = root.join("2026/07/01");
        std::fs::create_dir_all(&day).unwrap();
        let sid = "019f1ca5-47a9-72f3-a0be-86a8f37fb67a";
        let expected = day.join(format!("rollout-2026-07-01T15-47-01-{sid}.jsonl"));
        std::fs::write(
            &expected,
            format!(r#"{{"type":"session_meta","payload":{{"session_id":"{sid}","cwd":"/tmp/kode-cwd"}}}}"#),
        )
        .unwrap();

        let found = find_codex_session_by_id_under(&root, sid);
        assert_eq!(found.as_deref(), Some(expected.as_path()));
        assert_eq!(codex_session_meta_id(&expected).as_deref(), Some(sid));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_session_lookup_prefers_rollout_id_over_parent_session_id() {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("kode-codex-parent-id-test-{stamp}"));
        let earlier = root.join("2026/08/19/a");
        let later = root.join("2026/08/19/z");
        std::fs::create_dir_all(&earlier).unwrap();
        std::fs::create_dir_all(&later).unwrap();
        let target = "01a019a6-c89a-7690-b2ce-f61c87d3f1e8";
        let derived = "01a019a6-ca06-7183-9f51-0a407b654077";
        let misleading = earlier.join(format!("rollout-{derived}.jsonl"));
        std::fs::write(
            &misleading,
            format!(r#"{{"type":"session_meta","payload":{{"id":"{derived}","session_id":"{target}","cwd":"/tmp/maestro"}}}}"#),
        )
        .unwrap();
        let expected = later.join(format!("rollout-{target}.jsonl"));
        std::fs::write(
            &expected,
            format!(r#"{{"type":"session_meta","payload":{{"id":"{target}","session_id":"{target}","cwd":"/tmp/maestro"}}}}"#),
        )
        .unwrap();

        assert_eq!(codex_session_meta_id(&misleading).as_deref(), Some(derived));
        assert_eq!(
            codex_session_cwd(&misleading).map(|(id, _)| id),
            Some(derived.to_string())
        );
        assert_eq!(
            find_codex_session_by_id_under(&root, target).as_deref(),
            Some(expected.as_path())
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_user_message_string_content_becomes_title() {
        let line = r#"{"type":"user","message":{"content":"我想做人物移动到遮挡物后面,但也需要把遮挡部分用轮廓填充"}}"#;
        let mut state = TailState::new();
        let upd = parse_claude_line(line, &mut state);
        assert!(upd.new_title.is_some());
        let t = upd.new_title.unwrap();
        assert!(t.starts_with("我想做人物移动"));
        assert!(t.chars().count() <= 60);
        assert!(state.title_fallback_used);
    }

    #[test]
    fn claude_user_message_array_content_takes_first_text() {
        let line =
            r#"{"type":"user","message":{"content":[{"type":"text","text":"hello world"}]}}"#;
        let mut state = TailState::new();
        let upd = parse_claude_line(line, &mut state);
        assert_eq!(upd.new_title.as_deref(), Some("hello world"));
    }

    #[test]
    fn claude_user_message_skips_command_caveat_prefix() {
        // 第一条是 <local-command-caveat>... 应跳过
        let line1 = r#"{"type":"user","message":{"content":"<local-command-caveat>Caveat: ..."}}"#;
        let mut state = TailState::new();
        let upd = parse_claude_line(line1, &mut state);
        assert!(upd.new_title.is_none());
        assert!(!state.title_fallback_used);

        // 第二条命令名也跳
        let line2 =
            r#"{"type":"user","message":{"content":"<command-name>/effort</command-name>"}}"#;
        let upd = parse_claude_line(line2, &mut state);
        assert!(upd.new_title.is_none());

        // 第三条真实输入 → 设 title
        let line3 = r#"{"type":"user","message":{"content":"please refactor"}}"#;
        let upd = parse_claude_line(line3, &mut state);
        assert_eq!(upd.new_title.as_deref(), Some("please refactor"));
        assert!(state.title_fallback_used);
    }

    #[test]
    fn claude_user_title_only_set_once() {
        let line = r#"{"type":"user","message":{"content":"first prompt"}}"#;
        let mut state = TailState::new();
        let upd1 = parse_claude_line(line, &mut state);
        assert!(upd1.new_title.is_some());
        // 第二条 user 不再覆盖
        let line2 = r#"{"type":"user","message":{"content":"second prompt"}}"#;
        let upd2 = parse_claude_line(line2, &mut state);
        assert!(upd2.new_title.is_none());
    }

    #[test]
    fn malformed_claude_line_doesnt_panic() {
        let mut state = TailState::new();
        let upd = parse_claude_line("not json", &mut state);
        assert!(!upd.changed());
    }

    /// 端到端:在临时 jsonl 文件里追加几行,验证 tail 任务正确发出 JsonlMeta(codebuddy 路径)
    #[tokio::test(flavor = "multi_thread")]
    async fn tail_codebuddy_extracts_model_title_and_tokens() {
        use std::io::Write;
        let tmp = tempfile_path("kode_tail_cb_test.jsonl");
        std::fs::write(&tmp, "").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(99, Backend::Codebuddy, tmp.clone(), tx, None);

        sleep(Duration::from_millis(100)).await;

        let mut f = std::fs::OpenOptions::new().append(true).open(&tmp).unwrap();
        writeln!(
            f,
            r#"{{"type":"ai-title","aiTitle":"My Title","sessionId":"x"}}"#
        )
        .unwrap();
        // codebuddy 的 totalTokens / inputTokens / outputTokens 是单次请求用量。
        // UI 展示 session 累计用量。
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"Claude-Opus-4.7-1M","usage":{{"totalTokens":2500,"inputTokens":2000,"outputTokens":500}}}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"message","role":"assistant","providerData":{{"requestModelName":"Claude-Opus-4.7-1M","usage":{{"totalTokens":3100,"inputTokens":2500,"outputTokens":600}}}}}}"#
        )
        .unwrap();
        drop(f);

        let mut got_title = None;
        let mut got_model = None;
        let mut got_tokens = None;

        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while got_title.is_none() || got_model.is_none() || got_tokens != Some(5600) {
                match rx.recv().await {
                    Some(CoreEvent::JsonlMeta {
                        model,
                        title,
                        tokens,
                        ..
                    }) => {
                        if title.is_some() {
                            got_title = title;
                        }
                        if model.is_some() {
                            got_model = model;
                        }
                        if let Some(t) = tokens {
                            got_tokens = Some(t);
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_file(&tmp);

        assert_eq!(got_title.as_deref(), Some("My Title"));
        assert_eq!(got_model.as_deref(), Some("Claude-Opus-4.7-1M"));
        assert_eq!(got_tokens, Some(5600));
    }

    /// 端到端:claude 路径
    #[tokio::test(flavor = "multi_thread")]
    async fn tail_claude_extracts_model_tokens_and_title_fallback() {
        use std::io::Write;
        let tmp = tempfile_path("kode_tail_cl_test.jsonl");
        std::fs::write(&tmp, "").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
        spawn(77, Backend::Claude, tmp.clone(), tx, None);

        sleep(Duration::from_millis(100)).await;

        let mut f = std::fs::OpenOptions::new().append(true).open(&tmp).unwrap();
        // command 前缀 user(不应作 title)
        writeln!(
            f,
            r#"{{"type":"user","message":{{"content":"<command-name>/effort</command-name>"}}}}"#
        )
        .unwrap();
        // 真 user(应作 title)
        writeln!(
            f,
            r#"{{"type":"user","message":{{"content":"please refactor jsonl tail"}}}}"#
        )
        .unwrap();
        // assistant(应给 model + tokens)
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-4.7-opus","usage":{{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":300}}}}}}"#
        )
        .unwrap();
        drop(f);

        let mut got_title = None;
        let mut got_model = None;
        let mut got_input = None;
        let mut got_cached = None;

        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while got_title.is_none()
                || got_model.is_none()
                || got_input.is_none()
                || got_cached.is_none()
            {
                match rx.recv().await {
                    Some(CoreEvent::JsonlMeta {
                        model,
                        title,
                        input_tokens,
                        cached_tokens,
                        ..
                    }) => {
                        if title.is_some() {
                            got_title = title;
                        }
                        if model.is_some() {
                            got_model = model;
                        }
                        if input_tokens.is_some() {
                            got_input = input_tokens;
                        }
                        if cached_tokens.is_some() {
                            got_cached = cached_tokens;
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        })
        .await;

        let _ = std::fs::remove_file(&tmp);

        assert_eq!(got_title.as_deref(), Some("please refactor jsonl tail"));
        assert_eq!(got_model.as_deref(), Some("claude-4.7-opus"));
        // input_total = raw input + cached = 1000 + 300 = 1300
        assert_eq!(got_input, Some(1300));
        assert_eq!(got_cached, Some(300));
    }

    fn tempfile_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let unique = format!("{}_{}", std::process::id(), name);
        p.push(unique);
        p
    }

    fn tempfile_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("{}_{}_{}", std::process::id(), name, nanos));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
