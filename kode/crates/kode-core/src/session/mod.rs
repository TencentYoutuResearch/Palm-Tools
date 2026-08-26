//! Session = 一个 tab 的全部状态:子进程 PTY + vt100 终端模拟 + 元信息。

pub mod backend;
pub mod cursor_tail;
pub mod heuristic;
pub mod jsonl_tail;
pub mod state;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;
use portable_pty::PtySize;
use tokio::sync::mpsc;

use crate::config::BackendConfig;
use crate::event::CoreEvent;
use crate::pty::PtyHost;

use self::heuristic::BusyHeuristic;
use self::state::{SessionState, Status};

pub type SessionId = u64;

pub struct Session {
    pub id: SessionId,
    pub backend_key: String,
    pub cwd: PathBuf,
    pub command: String,
    pub args: Vec<String>,
    /// 子进程的 --session-id(若 backend 支持注入)。
    /// codebuddy / claude / claude-internal 都支持。用于:
    ///   1) 定位 jsonl 文件做 tail
    ///   2) 持久化时存下来,下次启动用 --resume <sid> 恢复
    pub session_id: Option<String>,
    pub pty: Option<PtyHost>, // 已退出的 tab 这里是 None
    pub parser: vt100::Parser,
    pub state: SessionState,
    pub busy: BusyHeuristic,
    pub cols: u16,
    pub rows: u16,
    /// 权威 retarget 通道:SessionStart hook 给出新 transcript_path 时,
    /// 通过它通知本 session 的 jsonl tail 切到正确文件(codebuddy `/resume` `/clear`)。
    /// codex / 不支持 jsonl tail 的 backend 为 None。
    retarget_tx: Option<tokio::sync::watch::Sender<Option<PathBuf>>>,
    /// 上次 feed 末尾截断的 UTF-8 字节(用于跨 chunk 拼接,消除乱码)。
    /// PTY reader 可能在多字节 UTF-8 序列中间切割 8KB chunk,本缓冲
    /// 将截断部分保留到下次 feed 与后续字节拼接后再送入 vt100 parser。
    feed_remnant: Vec<u8>,
}

impl Session {
    pub fn new(
        id: SessionId,
        backend_key: &str,
        backend: &BackendConfig,
        cols: u16,
        rows: u16,
        idle_threshold: Duration,
        scrollback_lines: usize,
        cwd: &std::path::Path,
        evt_tx: mpsc::UnboundedSender<CoreEvent>,
        // 若提供:走 --resume <sid>,跳过新生成 uuid,jsonl tail 复用旧路径
        resume_session_id: Option<&str>,
        // 用户视角的 permission mode 简称:None / Some("default") = 不注入任何 flag,
        // Some("bypass") → 注入 `<permission_mode_flag> bypassPermissions`。
        // 任何其它值原样透传给子进程(给 advanced 用户从 config 走 acceptEdits/plan 留口子)。
        permission_mode: Option<&str>,
        // 用户在 GUI(BackendChooser)选定的 model;restore 时也会回填上次保存的值。
        // None → 走 backend.default_model(老语义)。Some(_) → 优先于 backend.default_model
        // 一同走 inject_model_flag,需要 backend.model_flag 也已设(出厂三个 backend
        // 默认 model_flag = Some("--model"),所以 Some(model) 必然落到子进程命令行)。
        model: Option<&str>,
        // 是否给子进程 system prompt 末尾注入 kode-memory 指令段(教 agent 用
        // memory_search / memory_propose 工具)。GUI 通过 PersistedState
        // .kode_memory_prompt_enabled 控制;默认 true。用户已在 backend.args 里显式
        // 给了 --append-system-prompt / --system-prompt / --system-prompt-file 时
        // 会被 inject_kode_memory_prompt 自动 short-circuit(尊重用户)。
        kode_memory_prompt_enabled: bool,
        // kode 在 spawn 前查好的项目 facts 字符串（bullet list）。
        // `None` = 跳过；非空时追加到 `<kode-memory-context>` 块里。
        memory_context: Option<&str>,
        // 注入到子进程 env 的额外键值对。空切片 = 不注入额外 env。
        // GUI 用此传 KODE_HOOK_SOCK,让 hook command 的 $KODE_HOOK_SOCK 能定位 relay。
        extra_env: &[(String, String)],
        // Initial prompt passed as a positional arg. Inserted into backend.args
        // BEFORE any flag injection, so variadic flags like --add-dir don't consume it.
        initial_prompt: Option<&str>,
    ) -> Result<Self> {
        // scrollback_lines 控制 vt100 内部环形缓冲行数,Scroll 模式下用 set_scrollback(N) 翻看
        let parser = vt100::Parser::new(rows, cols, scrollback_lines);

        let title = format!("tab · {}", backend_key);
        // 状态栏初始 model:优先用 spawn 时传入的 model,其次 backend.default_model,
        // 都没有时退化为 "auto"(jsonl_tail 起来后会被真实 model 名覆盖)。
        let effective_model: Option<String> = model
            .map(|s| s.to_string())
            .or_else(|| backend.default_model.clone());
        let model_label = effective_model.clone().unwrap_or_else(|| "auto".into());
        let mut state = SessionState::new(title, model_label);
        state.status = Status::Starting;

        // 1) session-id / resume 注入。两条互斥路径:
        //    - 有 resume_session_id → **只**注入 `--resume <sid>`,不注入 `--session-id`
        //      claude code 明确禁止两个同时用(除非加 --fork-session,那会生成新 sid 失去意义)。
        //      jsonl_tail 直接拿提供的 sid 监听旧文件,历史立刻能读到。
        //    - 无 resume → 走老逻辑,生成新 uuid 注入 `--session-id <sid>`,jsonl_tail 用之
        //
        //    如果传了 initial_prompt,先把它作为 positional arg 插到 backend.args
        //    **之前**,这样 variadic flag(如 --add-dir)不会把它吞掉。
        let args_with_prompt: Vec<String> = if let Some(prompt) = initial_prompt {
            let mut v = vec![prompt.to_string()];
            v.extend(backend.args.iter().cloned());
            v
        } else {
            backend.args.clone()
        };
        let flags_before_resume =
            backend::profile_for_key(backend_key).is_some_and(|p| p.flags_before_resume());
        let (final_args_pre_prompt, session_id) = if let Some(sid) = resume_session_id {
            if flags_before_resume {
                // Codex resume is a subcommand. Keep global/session options before
                // `resume <id>` so the CLI does not treat them as resume prompt text.
                let args = inject_model_flag(
                    &args_with_prompt,
                    backend.model_flag.as_deref(),
                    effective_model.as_deref(),
                );
                let args = inject_permission_mode_flag(
                    &args,
                    backend.permission_mode_flag.as_deref(),
                    permission_mode,
                );
                (
                    inject_resume_flag(backend_key, &args, sid),
                    Some(sid.to_string()),
                )
            } else {
                let args = inject_resume_flag(backend_key, &args_with_prompt, sid);
                let args = inject_model_flag(
                    &args,
                    backend.model_flag.as_deref(),
                    effective_model.as_deref(),
                );
                let args = inject_permission_mode_flag(
                    &args,
                    backend.permission_mode_flag.as_deref(),
                    permission_mode,
                );
                (args, Some(sid.to_string()))
            }
        } else {
            let (args, session_id) =
                inject_session_id(&backend.command, &args_with_prompt, backend_key, None);
            let args = inject_model_flag(
                &args,
                backend.model_flag.as_deref(),
                effective_model.as_deref(),
            );
            let args = inject_permission_mode_flag(
                &args,
                backend.permission_mode_flag.as_deref(),
                permission_mode,
            );
            (args, session_id)
        };
        // 2) 模型注入(根据 backend.model_flag + effective_model)。
        //    effective_model = spawn 传入 model 优先,否则 backend.default_model。
        //    两者都 None 时不注入(行为与历史版本一致)。
        // 3) permission-mode 注入。"default" / None 短路;"bypass" 翻译成 "bypassPermissions"。
        // 4) kode-memory system prompt 注入(2026-06-06)。
        //    教 agent 用 memory_search / memory_propose 工具记/查共享 memory 池。
        //    用户在 backend.args 里已显式给 --append-system-prompt 等 flag 时会
        //    short-circuit(尊重)。enabled=false(GUI 关掉)也 short-circuit。
        let final_args = inject_kode_memory_prompt(
            &final_args_pre_prompt,
            backend_key,
            cwd,
            kode_memory_prompt_enabled,
            memory_context,
        );

        let spawn_started_at = SystemTime::now();
        tracing::info!(command = %backend.command, ?final_args, "spawning session");
        let pty = PtyHost::spawn(
            id,
            &backend.command,
            &final_args,
            PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            },
            cwd,
            evt_tx.clone(),
            extra_env,
        )?;

        // 启动 jsonl / meta tail。具体认领策略由 BackendProfile::spawn_tail 决定:
        // codebuddy/claude 用注入的 session-id 精确定位;Codex/Cursor 不接受外部
        // --session-id,按 cwd + mtime 认领本次启动后的文件,resume 则按 uuid 扫描。
        // retarget 通道:hook 给出 transcript_path 时通知 tail 切到正确文件。
        let mut retarget_tx: Option<tokio::sync::watch::Sender<Option<PathBuf>>> = None;
        if let Some(profile) = backend::profile_for_key(backend_key) {
            tracing::debug!(
                ?cwd,
                resume_session_id = ?resume_session_id,
                kind = ?profile.kind(),
                "spawn backend meta tail"
            );
            let (tx, rx) = tokio::sync::watch::channel::<Option<PathBuf>>(None);
            retarget_tx = Some(tx);
            profile.spawn_tail(backend::MetaTailRequest {
                id,
                cwd: cwd.to_path_buf(),
                resume_session_id: resume_session_id.map(str::to_string),
                injected_session_id: session_id.clone(),
                spawn_started_at,
                evt_tx,
                retarget_rx: rx,
            });
        }

        Ok(Self {
            id,
            backend_key: backend_key.to_string(),
            cwd: cwd.to_path_buf(),
            command: backend.command.clone(),
            args: final_args,
            session_id,
            pty: Some(pty),
            parser,
            state,
            busy: BusyHeuristic::new(idle_threshold),
            cols,
            rows,
            retarget_tx,
            feed_remnant: Vec::with_capacity(8),
        })
    }

    /// 权威 retarget:SessionStart hook 给出新 session 的 jsonl/rollout 路径
    /// (transcript_path),通过它通知本 session 的 tail 切过去。
    /// 返回 false 表示本 session 不支持 tail retarget 或 tail 已退出。
    pub fn retarget_tail(&self, transcript_path: PathBuf) -> bool {
        if !self.accepts_transcript_path(&transcript_path) {
            return false;
        }
        match &self.retarget_tx {
            Some(tx) => tx.send(Some(transcript_path)).is_ok(),
            None => false,
        }
    }

    /// 只校验 hook 提供的 transcript 是否属于当前 tab backend。
    /// Cursor 的 meta watcher 与 semantic transcript watcher 不是同一个 tail，
    /// 因此 GUI 需要先校验路径，再单独启动 semantic tail。
    pub fn accepts_transcript_path(&self, transcript_path: &Path) -> bool {
        let Some(backend) = jsonl_tail::Backend::from_backend_key(&self.backend_key) else {
            return false;
        };
        if !backend.accepts_transcript_path(transcript_path) {
            tracing::warn!(
                tab_id = self.id,
                backend = %self.backend_key,
                path = %transcript_path.display(),
                "rejected transcript retarget for mismatched backend"
            );
            return false;
        }
        true
    }

    /// PTY/jsonl 兜底 retarget:只知道目标 session uuid 时,按 backend + cwd 推出
    /// 目标 jsonl 路径并通知 tail 切过去。目标文件可能尚未创建;jsonl_tail 会保留
    /// 这个 path 并在 EOF 轮询中重试。
    pub fn retarget_tail_to_session_id(&self, session_id: &str) -> bool {
        let Some(profile) = backend::profile_for_key(&self.backend_key) else {
            return false;
        };
        let Some(path) = profile
            .find_session_path(&self.cwd, session_id)
            .or_else(|| profile.session_path(&self.cwd, session_id))
        else {
            return false;
        };
        self.retarget_tail(path)
    }

    /// 喂字节给 vt100 + 更新启发式 + 标 unread / 状态翻 busy。
    ///
    /// 内部做 UTF-8 序列跨 chunk 拼接:PTY reader 可能在多字节字符中间
    /// 切断 8KB chunk,本方法将截断字节与上次 feed 的 remnant 拼接后再
    /// 送入 vt100 parser,消除乱码根因。
    pub fn feed(&mut self, bytes: &[u8], is_active: bool) {
        // UTF-8 跨 chunk 拼接:先把上次截断的 remnant 与本次 bytes 合并
        let merged = if self.feed_remnant.is_empty() {
            bytes.to_vec()
        } else {
            let mut m = std::mem::take(&mut self.feed_remnant);
            m.extend_from_slice(bytes);
            m
        };

        // 从末尾分离出可能不完整的 UTF-8 序列,保留到下次 feed
        let (complete, remnant) = split_at_complete_utf8(&merged);
        self.feed_remnant = remnant;

        self.parser.process(complete);
        self.busy.touch();
        if matches!(self.state.status, Status::Starting | Status::Idle) {
            self.state.status = Status::Busy;
        }
        if !is_active {
            self.state.unread = true;
        }
    }

    /// 主循环周期性调用:把启发式翻转的状态同步到 state.status
    pub fn tick_status(&mut self) {
        if matches!(self.state.status, Status::Exited(_)) {
            return;
        }
        if self.busy.is_busy() {
            self.state.status = Status::Busy;
        } else if matches!(self.state.status, Status::Busy) {
            self.state.status = Status::Idle;
        }
    }

    /// 用户提交了一轮。PTY 之后即使长时间无输出也保持 busy,直到 [`mark_turn_end`]。
    pub fn mark_turn_start(&mut self) {
        if matches!(self.state.status, Status::Exited(_)) {
            return;
        }
        self.busy.hold_turn();
        self.state.status = Status::Busy;
    }

    /// Stop / turn_finished。下一拍 `tick_status` 若 PTY 也静默则翻 idle。
    pub fn mark_turn_end(&mut self) {
        self.busy.release_turn();
    }

    pub fn mark_exited(&mut self, code: Option<i32>) {
        self.busy.release_turn();
        self.state.status = Status::Exited(code);
        // 释放 PTY,reader/reaper 线程会因 EOF 自行退出
        self.pty = None;
    }

    pub fn write_input(&self, bytes: &[u8]) {
        if looks_like_turn_submit(bytes) {
            self.busy.hold_turn();
        } else if looks_like_turn_cancel(bytes) {
            // Bare Escape is the terminal-level cancel gesture. Some backends
            // (notably Codex) return to their composer without writing a
            // task_complete/turn_aborted transcript event, so the semantic
            // tail cannot release the local turn hold. Drop only that hold;
            // any continuing PTY output still keeps the session busy through
            // the ordinary activity threshold.
            self.busy.release_turn();
        }
        if let Some(p) = &self.pty {
            if let Err(e) = p.write_all(bytes) {
                tracing::warn!(?e, "pty write failed");
            }
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        self.parser.screen_mut().set_size(rows, cols);
        if let Some(p) = self.pty.as_mut() {
            if let Err(e) = p.resize(cols, rows) {
                tracing::warn!(?e, "pty resize failed");
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.pty.is_some()
    }

    /// 当前 scrollback offset(0 = 实时屏幕)
    pub fn scrollback_offset(&self) -> usize {
        self.parser.screen().scrollback()
    }

    /// vt100 已渲染的当前屏幕纯文本(去掉 ANSI 控制序列、按行换行)。
    /// 用于 bridge 端识别子进程 PTY-prompt(Ink select 等待输入)。
    /// 注意:每行末有空格 padding 到 cols 宽度,需要的话由调用方 trim_end。
    pub fn screen_text(&self) -> String {
        self.parser.screen().contents()
    }

    /// vt100 当前屏幕的 ANSI 快照,**附带 DEC private mode 重放序列**。
    ///
    /// 背景:GUI 端 tab 切换走 LRU,非缓存 tab 的 xterm 实例会被 dispose,切回时
    /// 用本快照重建画面。`vt100::Screen::contents_formatted()` 只重放可见 cell +
    /// SGR 颜色 + 光标位置,**不重放** DEC private modes(鼠标上报 1000/1002/1003 +
    /// 编码 1005/1006、bracketed-paste 2004、application-cursor/keypad)。
    ///
    /// 后果:子进程开启鼠标上报时(codebuddy 输入框/菜单态),重建出的新 xterm 实例
    /// 不认为自己在 mouse-tracking 模式 → 鼠标移动/拖动回退成文本选择(用户看到
    /// "移动鼠标变选中")。bracketed-paste / application-cursor 同理会丢。
    ///
    /// 修法:在 contents_formatted() 之后补上当前各 private mode 的 enable 序列,
    /// xterm 写入快照时一并恢复这些模式。顺序无关紧要 —— 各模式互不依赖。
    pub fn screen_snapshot_bytes(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut out = screen.contents_formatted();

        // 鼠标上报模式
        match screen.mouse_protocol_mode() {
            vt100::MouseProtocolMode::None => {}
            vt100::MouseProtocolMode::Press => out.extend_from_slice(b"\x1b[?9h"),
            vt100::MouseProtocolMode::PressRelease => out.extend_from_slice(b"\x1b[?1000h"),
            vt100::MouseProtocolMode::ButtonMotion => out.extend_from_slice(b"\x1b[?1002h"),
            vt100::MouseProtocolMode::AnyMotion => out.extend_from_slice(b"\x1b[?1003h"),
        }
        // 鼠标上报编码
        match screen.mouse_protocol_encoding() {
            vt100::MouseProtocolEncoding::Default => {}
            vt100::MouseProtocolEncoding::Utf8 => out.extend_from_slice(b"\x1b[?1005h"),
            vt100::MouseProtocolEncoding::Sgr => out.extend_from_slice(b"\x1b[?1006h"),
        }
        // bracketed paste
        if screen.bracketed_paste() {
            out.extend_from_slice(b"\x1b[?2004h");
        }
        // application cursor keys (DECCKM)
        if screen.application_cursor() {
            out.extend_from_slice(b"\x1b[?1h");
        }
        // application keypad (DECKPAM)
        if screen.application_keypad() {
            out.extend_from_slice(b"\x1b=");
        }

        out
    }

    /// 是否处于 scrollback 翻看状态
    pub fn is_scrolled_back(&self) -> bool {
        self.scrollback_offset() > 0
    }

    /// 向上翻 n 行(看更早的历史)
    pub fn scroll_up(&mut self, n: usize) {
        let cur = self.scrollback_offset();
        self.parser
            .screen_mut()
            .set_scrollback(cur.saturating_add(n));
    }

    /// 向下翻 n 行(回到更新的位置)
    pub fn scroll_down(&mut self, n: usize) {
        let cur = self.scrollback_offset();
        self.parser
            .screen_mut()
            .set_scrollback(cur.saturating_sub(n));
    }

    /// 跳到 scrollback 顶端(尽可能早)。vt100 会 clamp 到实际缓冲长度。
    pub fn scroll_home(&mut self) {
        self.parser.screen_mut().set_scrollback(usize::MAX / 2);
    }

    /// 回到实时屏幕(scrollback=0)
    pub fn scroll_end(&mut self) {
        self.parser.screen_mut().set_scrollback(0);
    }
}

// ---------------------------------------------------------------------------
// UTF-8 边界检测工具函数
// ---------------------------------------------------------------------------

/// 返回 UTF-8 首字节指示的序列长度(字节数)。
///
/// 首字节不在 0x80..0xBF 范围(续字节)时才有意义;ASCII 返回 1。
/// 不检查 overlong / surrogate / 超过 U+10FFFF 等非法序列 — 这些不会出现在
/// 合法的终端输出中,vt100-ctt 的 VTE 状态机也会自行处理。
fn utf8_sequence_len(first_byte: u8) -> usize {
    if first_byte < 0x80 {
        1
    } else if first_byte < 0xE0 {
        2
    } else if first_byte < 0xF0 {
        3
    } else {
        4
    }
}

/// 从字节切片末尾向前扫描,找到最后一个完整的 UTF-8 序列边界,返回
/// `(完整部分, 截断部分)`。
///
/// 截断部分为空 Vec 表示整个切片都是完整 UTF-8 序列。
/// 截断部分最多 3 字节(UTF-8 最长序列 4 字节,最少需要 1 个首字节)。
///
/// 行为约定:
/// - 纯 ASCII 切片 → 完整返回,截断为空
/// - 末尾是续字节(0x80..0xBF) → 向前找到序列首字节,判断是否完整
/// - 末尾是序列首字节 → 直接视为截断(因为续字节还没到)
pub fn split_at_complete_utf8(bytes: &[u8]) -> (&[u8], Vec<u8>) {
    if bytes.is_empty() {
        return (bytes, Vec::new());
    }

    // 从末尾向前扫描,跳过所有 UTF-8 续字节(0x80..0xBF),
    // 找到最后一个非续字节。这个字节要么是 ASCII(序列完整),
    // 要么是多字节序列的首字节(需要检查是否完整)。
    let mut trailing = 0usize;
    while trailing < bytes.len() {
        let b = bytes[bytes.len() - 1 - trailing];
        if (0x80..0xC0).contains(&b) {
            trailing += 1;
        } else {
            break;
        }
    }

    if trailing == bytes.len() {
        // 整个切片全是续字节(没有首字节) — 全部视为截断
        return (b"", bytes.to_vec());
    }

    // 现在 bytes[len-1-trailing] 是一个序列首字节(ASCII 或多字节)
    let seq_start = bytes.len() - 1 - trailing;
    let seq_len = utf8_sequence_len(bytes[seq_start]);
    if seq_start + seq_len > bytes.len() {
        // 序列不完整:保留 [0..seq_start) 为完整, [seq_start..) 为截断
        (&bytes[..seq_start], bytes[seq_start..].to_vec())
    } else {
        // 序列完整,但需要检查后面是否有孤儿续字节
        // (例如 ASCII 'b' 后跟两个续字节 0x80 0x80 — 续字节不属于任何序列)
        let after_seq = bytes.len() - (seq_start + seq_len);
        if after_seq > 0 {
            // 序列结束后还有字节,且首字节是续字节 → 它们是孤儿
            // 截断点 = seq_start + seq_len
            let cut = seq_start + seq_len;
            (&bytes[..cut], bytes[cut..].to_vec())
        } else {
            (bytes, Vec::new())
        }
    }
}

// ---------------------------------------------------------------------------

/// 通用 --session-id 注入。codebuddy / claude / claude-internal 都支持。
///
/// 行为:
///   1) 不是已知的 jsonl-tail 后端 → 不动 args,session_id = None
///   2) args 已显式带 --session-id → 用用户的 sid
///   3) 提供了 resume_session_id → 用它,**不**生成新 uuid
///   4) 否则生成新 uuid v4
fn inject_session_id(
    command: &str,
    args: &[String],
    backend_key: &str,
    resume_session_id: Option<&str>,
) -> (Vec<String>, Option<String>) {
    let supports = backend::profile_for_key(backend_key)
        .map(|p| p.supports_session_id_flag())
        .unwrap_or_else(|| {
            // 兼容老逻辑:命令名兜底(用户改了 backend_key 但命令还是 codebuddy/claude)
            std::path::Path::new(command)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.contains("codebuddy") || s == "cbc" || s.starts_with("claude"))
                .unwrap_or(false)
        });

    if !supports {
        return (args.to_vec(), None);
    }

    // 已显式带 --session-id 就用用户的
    if let Some(pos) = args.iter().position(|a| a == "--session-id") {
        let sid = args.get(pos + 1).cloned();
        return (args.to_vec(), sid);
    }

    let sid = match resume_session_id {
        Some(s) => s.to_string(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    let mut new_args = args.to_vec();
    new_args.push("--session-id".into());
    new_args.push(sid.clone());
    (new_args, Some(sid))
}

/// 把 `--resume <sid>` 注入 args(若用户没已显式提供)。
/// codebuddy 用 `-r/--resume`,claude 也是 `-r/--resume`,统一注入 long form。
fn inject_resume_flag(backend_key: &str, args: &[String], sid: &str) -> Vec<String> {
    let style = backend::profile_for_key(backend_key)
        .map(|p| p.resume_style())
        .unwrap_or(backend::ResumeStyle::Flag);
    if style == backend::ResumeStyle::Subcommand {
        if args.iter().any(|a| a == "resume") {
            return args.to_vec();
        }
        let mut new_args = args.to_vec();
        new_args.push("resume".into());
        new_args.push(sid.to_string());
        return new_args;
    }
    if args.iter().any(|a| a == "--resume" || a == "-r") {
        return args.to_vec();
    }
    let mut new_args = args.to_vec();
    new_args.push("--resume".into());
    new_args.push(sid.to_string());
    new_args
}

/// 把 permission mode 注入到 args 里。
///
/// 翻译规则(用户视角 → 子进程 CLI 取值):
///   - `None` / `Some("default")` / `Some("")` → 短路不注入(子进程默认就是 default,
///     注入会增加噪声且 codebuddy/claude 都接受不传)
///   - `Some("bypass")` → `bypassPermissions`(codebuddy/claude CLI 实际取值);
///     Codex 的 `--ask-for-approval` 风格映射成 `never` + full sandbox bypass
///   - 其它 `Some(s)` → 原样 `s`(给 acceptEdits / plan / bypassPermissions 留通道,
///     用户从 config / 命令面板高级模式可触达,但当前 GUI 默认只暴露 default/bypass)
///
/// 还有以下短路条件:
///   - `flag` 为 None 或空 → 不注入
///   - args 里已经有 `flag` → 不覆盖(尊重用户在 backend.args 里手写的)
fn inject_permission_mode_flag(
    args: &[String],
    flag: Option<&str>,
    mode: Option<&str>,
) -> Vec<String> {
    let requested = match mode {
        None => return args.to_vec(),
        Some("") | Some("default") => return args.to_vec(),
        Some("bypass") => "bypassPermissions",
        Some(other) => other,
    };
    let Some(flag) = flag else {
        return args.to_vec();
    };
    if flag.is_empty() {
        return args.to_vec();
    }
    if args.iter().any(|a| a == flag) {
        // 用户已显式指定,不覆盖
        return args.to_vec();
    }
    if flag == "--ask-for-approval" {
        let mut new_args = args.to_vec();
        if matches!(mode, Some("bypass")) {
            if !args
                .iter()
                .any(|a| a == "--dangerously-bypass-approvals-and-sandbox")
            {
                new_args.push("--dangerously-bypass-approvals-and-sandbox".into());
            }
            return new_args;
        }
        new_args.push(flag.to_string());
        new_args.push(requested.to_string());
        return new_args;
    }
    let mut new_args = args.to_vec();
    new_args.push(flag.to_string());
    new_args.push(requested.to_string());
    new_args
}

/// 把 `[model_flag, default_model]` 注入到 args 里,前提是:
///   1) 配置里设了 model_flag(如 "--model")
///   2) 配置里设了 default_model
///   3) 用户没在 args 里手写过 model_flag(尊重用户已显式指定的值)
fn inject_model_flag(
    args: &[String],
    model_flag: Option<&str>,
    default_model: Option<&str>,
) -> Vec<String> {
    let (Some(flag), Some(model)) = (model_flag, default_model) else {
        return args.to_vec();
    };
    if flag.is_empty() || model.is_empty() {
        return args.to_vec();
    }
    if args.iter().any(|a| a == flag) {
        // 用户已显式指定,不覆盖
        return args.to_vec();
    }
    let mut new_args = args.to_vec();
    new_args.push(flag.to_string());
    new_args.push(model.to_string());
    new_args
}

/// 给子进程 system prompt 末尾注入 `kode-memory` 指令段。
///
/// 三种短路条件,任一命中就原样返回 args:
/// 1. `enabled = false`(用户在 GUI 关掉了,或者老 persistence 升级时尚未写入)
/// 2. `args` 已含 `--append-system-prompt` / `--system-prompt` / `--system-prompt-file`
///    —— 用户已显式接管 system prompt,我们不应静默追加
/// 3. `kode_memory::prompt::build` 返回空(将来动态拼装时可能因没数据返回空)
///
/// Codex CLI 不支持 `--append-system-prompt`;Codex 走 `SessionStart` hook 注入
/// developer context,这里显式跳过。
///
/// 否则在末尾追加 `--append-system-prompt <prompt>` 两个 args。codebuddy / claude /
/// claude-internal 都支持这个 flag(2026-06-06 实测 codebuddy --help)。
///
/// 这里**不**校验 backend.command 是否真支持这个 flag —— 校验放在 BackendConfig 层
/// 的实现也行,但当前出厂三个 backend 都支持 --append-system-prompt,所以零校验
/// 简单透传。如果将来加了不支持的 backend(eg. raw shell),那个 backend 的 args
/// 不应被 kode 自动注入,改 BackendConfig 加 `kode_memory_prompt_supported: bool`
/// 字段拦下即可。
fn inject_kode_memory_prompt(
    args: &[String],
    backend_key: &str,
    cwd: &std::path::Path,
    enabled: bool,
    memory_context: Option<&str>,
) -> Vec<String> {
    if !enabled {
        return args.to_vec();
    }
    if !backend::profile_for_key(backend_key).is_some_and(|p| p.supports_append_system_prompt()) {
        return args.to_vec();
    }
    if args.iter().any(|a| {
        a == "--append-system-prompt" || a == "--system-prompt" || a == "--system-prompt-file"
    }) {
        return args.to_vec();
    }
    let prompt = kode_memory::prompt::build(cwd, backend_key);
    if prompt.is_empty() {
        return args.to_vec();
    }
    // 把 facts 快照追加到指令 prompt 后面，让 agent 一开始就看到项目记忆
    let mut full = prompt;
    if let Some(ctx) = memory_context {
        if !ctx.trim().is_empty() {
            full.push_str("\n\n<kode-memory-context>\n");
            full.push_str(ctx);
            full.push_str("\n</kode-memory-context>");
        }
    }
    let mut new_args = args.to_vec();
    new_args.push("--append-system-prompt".into());
    new_args.push(full);
    new_args
}

fn looks_like_turn_submit(bytes: &[u8]) -> bool {
    bytes.iter().any(|b| *b == b'\n' || *b == b'\r')
}

fn looks_like_turn_cancel(bytes: &[u8]) -> bool {
    bytes == b"\x1b"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_session_id_for_codebuddy_backend() {
        let (args, sid) = inject_session_id("codebuddy", &["code".to_string()], "codebuddy", None);
        assert_eq!(args.len(), 3);
        assert_eq!(&args[0], "code");
        assert_eq!(&args[1], "--session-id");
        assert!(sid.is_some());
        assert_eq!(args[2], sid.unwrap());
    }

    #[test]
    fn inject_session_id_for_claude_backend() {
        let (args, sid) = inject_session_id("claude-internal", &[], "claude-internal", None);
        assert_eq!(args.len(), 2);
        assert_eq!(&args[0], "--session-id");
        assert!(sid.is_some());
    }

    #[test]
    fn inject_session_id_skips_for_unknown_backend() {
        let (args, sid) = inject_session_id("foo-cli", &[], "foo", None);
        assert!(args.is_empty());
        assert!(sid.is_none());
    }

    #[test]
    fn inject_session_id_skips_for_codex_backend() {
        let (args, sid) = inject_session_id("codex", &[], "codex", None);
        assert!(
            args.is_empty(),
            "codex must not receive unsupported --session-id"
        );
        assert!(sid.is_none());
    }

    #[test]
    fn inject_session_id_skips_for_cursor_backend() {
        let (args, sid) = inject_session_id("cursor-agent", &[], "cursor", None);
        assert!(
            args.is_empty(),
            "cursor-agent must not receive unsupported --session-id"
        );
        assert!(sid.is_none());
    }

    #[test]
    fn respect_existing_session_id_in_args() {
        let provided = "my-fixed-uuid";
        let (args, sid) = inject_session_id(
            "codebuddy",
            &["code".into(), "--session-id".into(), provided.into()],
            "codebuddy",
            None,
        );
        assert_eq!(args.len(), 3);
        assert_eq!(sid.as_deref(), Some(provided));
    }

    #[test]
    fn inject_session_id_uses_resume_uuid_when_provided() {
        let (args, sid) = inject_session_id("codebuddy", &[], "codebuddy", Some("recall-me"));
        assert_eq!(sid.as_deref(), Some("recall-me"));
        assert!(args.contains(&"recall-me".to_string()));
    }

    #[test]
    fn resume_path_does_not_inject_session_id() {
        // 关键回归:resume 模式不能注入 --session-id —— claude code 明确禁止两者并存。
        // (这测试的是 Session::new 的注入流程语义,不是单一函数。简单串测两个 helper 即可。)
        let resume_sid = "abc-123";
        let with_resume = inject_resume_flag("codebuddy", &[], resume_sid);
        assert!(with_resume.contains(&"--resume".to_string()));
        assert!(with_resume.contains(&resume_sid.to_string()));
        // 没调 inject_session_id → args 里不应出现 --session-id
        assert!(!with_resume.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn inject_resume_flag_appends() {
        let out = inject_resume_flag("codebuddy", &["--session-id".into(), "abc".into()], "abc");
        assert_eq!(out.last().map(|s| s.as_str()), Some("abc"));
        assert!(out.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn inject_resume_flag_skips_if_present() {
        let already = vec!["--resume".into(), "x".into()];
        let out = inject_resume_flag("codebuddy", &already, "y");
        assert_eq!(out, already);
    }

    #[test]
    fn inject_resume_flag_uses_codex_subcommand() {
        let out = inject_resume_flag("codex", &["--model".into(), "gpt-5.3-codex".into()], "abc");
        assert_eq!(
            out,
            vec!["--model", "gpt-5.3-codex", "resume", "abc"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert!(!out.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn codex_resume_keeps_global_options_before_subcommand() {
        let args = inject_model_flag(&[], Some("--model"), Some("gpt-5.3-codex"));
        let args = inject_permission_mode_flag(&args, Some("--ask-for-approval"), Some("bypass"));
        let out = inject_resume_flag("codex", &args, "abc");

        assert_eq!(
            out,
            vec![
                "--model",
                "gpt-5.3-codex",
                "--dangerously-bypass-approvals-and-sandbox",
                "resume",
                "abc",
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn inject_model_flag_appends_when_not_present() {
        let out = inject_model_flag(
            &["--session-id".into(), "abc".into()],
            Some("--model"),
            Some("opus-4.7"),
        );
        assert_eq!(
            out,
            vec!["--session-id", "abc", "--model", "opus-4.7"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn inject_model_flag_skips_when_user_already_passed() {
        let out = inject_model_flag(
            &["--model".into(), "haiku".into()],
            Some("--model"),
            Some("opus"),
        );
        assert_eq!(
            out,
            vec!["--model", "haiku"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn inject_model_flag_noop_when_flag_or_model_missing() {
        let base = vec!["x".to_string()];
        assert_eq!(inject_model_flag(&base, None, Some("opus")), base);
        assert_eq!(inject_model_flag(&base, Some("--model"), None), base);
        assert_eq!(inject_model_flag(&base, None, None), base);
    }

    /// 回归:Session::new 拼装 effective_model 的优先级 ——
    /// 显式传入的 model > backend.default_model;以"是否被 inject 到最终 args"为锚验证。
    /// 这里直接复刻 Session::new 里那段优先级表达式,避免真启 PTY。
    #[test]
    fn effective_model_prefers_spawn_arg_over_backend_default() {
        let backend_default = Some("backend-default".to_string());
        let spawn_arg: Option<&str> = Some("user-pick");

        // 复刻 Session::new:90 那段优先级
        let effective: Option<String> = spawn_arg
            .map(|s| s.to_string())
            .or_else(|| backend_default.clone());
        assert_eq!(effective.as_deref(), Some("user-pick"));

        let final_args = inject_model_flag(&[], Some("--model"), effective.as_deref());
        assert_eq!(
            final_args,
            vec!["--model".to_string(), "user-pick".to_string()]
        );
    }

    #[test]
    fn effective_model_falls_back_to_backend_default() {
        let backend_default = Some("backend-default".to_string());
        let spawn_arg: Option<&str> = None;

        let effective: Option<String> = spawn_arg
            .map(|s| s.to_string())
            .or_else(|| backend_default.clone());
        assert_eq!(effective.as_deref(), Some("backend-default"));

        let final_args = inject_model_flag(&[], Some("--model"), effective.as_deref());
        assert_eq!(
            final_args,
            vec!["--model".to_string(), "backend-default".to_string()]
        );
    }

    #[test]
    fn effective_model_none_when_neither_set() {
        let backend_default: Option<String> = None;
        let spawn_arg: Option<&str> = None;

        let effective: Option<String> = spawn_arg
            .map(|s| s.to_string())
            .or_else(|| backend_default.clone());
        assert!(effective.is_none());

        // None → inject 短路,args 不变
        let final_args = inject_model_flag(&[], Some("--model"), effective.as_deref());
        assert!(final_args.is_empty());
    }

    #[test]
    fn inject_permission_mode_translates_bypass() {
        // 用户视角的 "bypass" → CLI 实际取值 bypassPermissions
        let out = inject_permission_mode_flag(
            &["--model".into(), "opus".into()],
            Some("--permission-mode"),
            Some("bypass"),
        );
        assert_eq!(
            out,
            vec!["--model", "opus", "--permission-mode", "bypassPermissions"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn inject_permission_mode_maps_codex_bypass() {
        let out = inject_permission_mode_flag(
            &["--model".into(), "gpt-5.5".into()],
            Some("--ask-for-approval"),
            Some("bypass"),
        );
        assert_eq!(
            out,
            vec![
                "--model",
                "gpt-5.5",
                "--dangerously-bypass-approvals-and-sandbox",
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn inject_permission_mode_skips_default_and_none() {
        // default / None / "" 三态都不注入(子进程默认行为本身就是 default)
        let base = vec!["--model".into(), "opus".into()];
        assert_eq!(
            inject_permission_mode_flag(&base, Some("--permission-mode"), None),
            base
        );
        assert_eq!(
            inject_permission_mode_flag(&base, Some("--permission-mode"), Some("default")),
            base
        );
        assert_eq!(
            inject_permission_mode_flag(&base, Some("--permission-mode"), Some("")),
            base
        );
    }

    #[test]
    fn inject_permission_mode_passthrough_unknown_value() {
        // 给 acceptEdits / plan 等高级值留通道,原样透传
        let out = inject_permission_mode_flag(&[], Some("--permission-mode"), Some("acceptEdits"));
        assert_eq!(out, vec!["--permission-mode", "acceptEdits"]);
    }

    #[test]
    fn inject_permission_mode_skips_when_flag_missing() {
        // backend 没配 permission_mode_flag → 即便用户选了 bypass 也不注入
        let base = vec!["x".to_string()];
        assert_eq!(
            inject_permission_mode_flag(&base, None, Some("bypass")),
            base
        );
    }

    #[test]
    fn inject_permission_mode_respects_existing_user_args() {
        // 用户已在 backend.args 里手写 --permission-mode → 不覆盖
        let already = vec!["--permission-mode".into(), "plan".into()];
        let out = inject_permission_mode_flag(&already, Some("--permission-mode"), Some("bypass"));
        assert_eq!(out, already);
    }

    // ============== inject_kode_memory_prompt ==============

    #[test]
    fn inject_kode_memory_prompt_appends_when_enabled() {
        let cwd = std::path::PathBuf::from("/tmp");
        let out = inject_kode_memory_prompt(&[], "codebuddy", &cwd, true, None);
        // 至少 2 个 args:flag + prompt 内容
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], "--append-system-prompt");
        // prompt 内容必须包含 <kode-memory> 标签(prompt::build 的契约)
        assert!(
            out[1].contains("<kode-memory>"),
            "appended prompt must include <kode-memory> marker"
        );
    }

    #[test]
    fn inject_kode_memory_prompt_skips_when_disabled() {
        let cwd = std::path::PathBuf::from("/tmp");
        let original = vec!["code".to_string()];
        let out = inject_kode_memory_prompt(&original, "codebuddy", &cwd, false, None);
        assert_eq!(out, original);
    }

    #[test]
    fn inject_kode_memory_prompt_skips_for_codex_backend() {
        let cwd = std::path::PathBuf::from("/tmp");
        let out = inject_kode_memory_prompt(&[], "codex", &cwd, true, None);
        assert!(
            out.is_empty(),
            "Codex must not receive unsupported --append-system-prompt args"
        );
    }

    #[test]
    fn inject_kode_memory_prompt_skips_for_cursor_backend() {
        let cwd = std::path::PathBuf::from("/tmp");
        let out = inject_kode_memory_prompt(&[], "cursor", &cwd, true, None);
        assert!(
            out.is_empty(),
            "Cursor must not receive unsupported --append-system-prompt args"
        );
    }

    /// 关键回归:用户已显式给 --append-system-prompt 时不重复注入。
    /// (跟 codebuddy 双 --append 实测会以最后一份为准 → 不会语义错误,
    ///  但用户既然明确指定就 100% 尊重)
    #[test]
    fn inject_kode_memory_prompt_respects_user_append_system_prompt() {
        let cwd = std::path::PathBuf::from("/tmp");
        let already = vec!["--append-system-prompt".into(), "user-custom".into()];
        let out = inject_kode_memory_prompt(&already, "codebuddy", &cwd, true, None);
        assert_eq!(out, already);
    }

    /// --system-prompt(全覆盖型 flag)被指定时也跳过 —— 用户已经接管了 system prompt
    /// 就不应再静默追加。
    #[test]
    fn inject_kode_memory_prompt_respects_user_system_prompt() {
        let cwd = std::path::PathBuf::from("/tmp");
        let already = vec!["--system-prompt".into(), "user-takeover".into()];
        let out = inject_kode_memory_prompt(&already, "codebuddy", &cwd, true, None);
        assert_eq!(out, already);
    }

    #[test]
    fn inject_kode_memory_prompt_respects_user_system_prompt_file() {
        let cwd = std::path::PathBuf::from("/tmp");
        let already = vec!["--system-prompt-file".into(), "/path/to/sys.txt".into()];
        let out = inject_kode_memory_prompt(&already, "codebuddy", &cwd, true, None);
        assert_eq!(out, already);
    }

    #[test]
    fn parser_with_scrollback_holds_history_and_set_scrollback_works() {
        // 直接构造 vt100 Parser,验证 scrollback API 的契约 ——
        // Session::new 走 PTY,这里只测我们依赖的内核行为。
        let mut p = vt100::Parser::new(3, 20, 100);
        // 喂 10 行,最近 3 行才在屏上,前 7 行在 scrollback
        for i in 0..10u8 {
            let line = format!("line{}\r\n", i);
            p.process(line.as_bytes());
        }
        // 默认 scrollback offset = 0,看到的应是末尾几行
        assert_eq!(p.screen().scrollback(), 0);
        // 翻 5 行
        p.screen_mut().set_scrollback(5);
        assert_eq!(p.screen().scrollback(), 5);
        // clamp:翻得过多时被限到实际缓冲长度
        p.screen_mut().set_scrollback(usize::MAX / 2);
        let clamped = p.screen().scrollback();
        assert!(clamped > 0 && clamped < usize::MAX / 2);
        // 回到底端
        p.screen_mut().set_scrollback(0);
        assert_eq!(p.screen().scrollback(), 0);
    }

    #[test]
    fn parser_resize_does_not_leave_orphan_wide_cell() {
        let mut parser = vt100::Parser::new(2, 10, 0);
        // Put a double-width glyph in columns 9-10, then shrink so its first
        // half becomes the final cell. vt100-ctt 0.17.1 used to retain the
        // wide flag while dropping the continuation cell; a later ED sequence
        // then indexed column 10 and panicked, aborting the release GUI.
        parser.process("\x1b[1;9H中".as_bytes());
        parser.screen_mut().set_size(2, 9);
        parser.process(b"\x1b[1;9H\x1b[J");

        assert_eq!(parser.screen().size(), (2, 9));
    }

    // ============== UTF-8 边界检测 ==============

    #[test]
    fn utf8_split_all_ascii_returns_complete() {
        let (complete, remnant) = split_at_complete_utf8(b"hello world");
        assert_eq!(complete, b"hello world");
        assert!(remnant.is_empty());
    }

    #[test]
    fn utf8_split_empty_returns_complete() {
        let (complete, remnant) = split_at_complete_utf8(b"");
        assert_eq!(complete, b"");
        assert!(remnant.is_empty());
    }

    #[test]
    fn utf8_split_2byte_truncated() {
        // UTF-8 "é" = 0xC3 0xA9, 只给首字节
        let (complete, remnant) = split_at_complete_utf8(b"abc\xC3");
        assert_eq!(complete, b"abc");
        assert_eq!(remnant, vec![0xC3]);
    }

    #[test]
    fn utf8_split_2byte_complete() {
        // UTF-8 "é" = 0xC3 0xA9, 完整
        let (complete, remnant) = split_at_complete_utf8(b"abc\xC3\xA9");
        assert_eq!(complete, b"abc\xC3\xA9");
        assert!(remnant.is_empty());
    }

    #[test]
    fn utf8_split_3byte_truncated_1_remaining() {
        // 中文 "中" = 0xE4 0xB8 0xAD, 只给首字节
        let (complete, remnant) = split_at_complete_utf8(b"ab\xE4");
        assert_eq!(complete, b"ab");
        assert_eq!(remnant, vec![0xE4]);
    }

    #[test]
    fn utf8_split_3byte_truncated_2_remaining() {
        // 中文 "中" = 0xE4 0xB8 0xAD, 给前两字节
        let (complete, remnant) = split_at_complete_utf8(b"ab\xE4\xB8");
        assert_eq!(complete, b"ab");
        assert_eq!(remnant, vec![0xE4, 0xB8]);
    }

    #[test]
    fn utf8_split_3byte_complete() {
        // 中文 "中" = 0xE4 0xB8 0xAD, 完整
        let (complete, remnant) = split_at_complete_utf8(b"ab\xE4\xB8\xAD");
        assert_eq!(complete, b"ab\xE4\xB8\xAD");
        assert!(remnant.is_empty());
    }

    #[test]
    fn utf8_split_4byte_truncated() {
        // Emoji "😀" = 0xF0 0x9F 0x98 0x80, 只给前两字节
        let (complete, remnant) = split_at_complete_utf8(b"a\xF0\x9F");
        assert_eq!(complete, b"a");
        assert_eq!(remnant, vec![0xF0, 0x9F]);
    }

    #[test]
    fn utf8_split_4byte_complete() {
        // Emoji "😀" = 0xF0 0x9F 0x98 0x80, 完整
        let (complete, remnant) = split_at_complete_utf8(b"a\xF0\x9F\x98\x80");
        assert_eq!(complete, b"a\xF0\x9F\x98\x80");
        assert!(remnant.is_empty());
    }

    #[test]
    fn utf8_split_all_continuation_bytes_no_header() {
        // 整个切片全是续字节(0x80..0xBF),没有序列首字节 — 极端情况
        let (complete, remnant) = split_at_complete_utf8(b"\x80\x80\x80");
        assert!(complete.is_empty());
        assert_eq!(remnant, vec![0x80, 0x80, 0x80]);
    }

    #[test]
    fn utf8_split_orphan_continuation_after_ascii() {
        // 实际不会出现:ASCII 后跟孤儿续字节。算法保守处理,将续字节保留。
        // `b"ab"` + 续字节 `0x80 0x80` — 续字节不属于任何序列,保留到下次
        let (complete, remnant) = split_at_complete_utf8(b"ab\x80\x80");
        // 行为:算法认为 ASCII `b` 是完整序列,但续字节是孤儿。
        // 实际上 PTY 输出不会产生这种数据,但为防御性保留。
        // 这里验证的是:不会 panic,remnant 非空(保守保留孤儿字节)。
        assert!(
            !remnant.is_empty(),
            "orphan continuation bytes should be kept"
        );
        assert!(!complete.is_empty());
    }

    #[test]
    fn utf8_split_mixed_ascii_and_multibyte() {
        // "hello中world" — "中" 完整在末尾
        let s = "hello中world";
        let (complete, remnant) = split_at_complete_utf8(s.as_bytes());
        assert_eq!(complete, s.as_bytes());
        assert!(remnant.is_empty());
    }

    #[test]
    fn utf8_split_mixed_with_truncated_at_end() {
        // "hello" + 截断的 "中"(0xE4 0xB8)
        let mut data = b"hello".to_vec();
        data.extend_from_slice(&[0xE4, 0xB8]);
        let (complete, remnant) = split_at_complete_utf8(&data);
        assert_eq!(complete, b"hello");
        assert_eq!(remnant, vec![0xE4, 0xB8]);
    }

    // ============== Session::feed UTF-8 拼接 ==============

    #[test]
    fn feed_stitches_truncated_utf8_across_chunks() {
        // 模拟两次 feed:第一次末尾截断,第二次补全
        let mut s = Session::new(
            99,
            "test",
            &BackendConfig {
                command: "echo".into(),
                args: vec![],
                default_model: None,
                model_flag: None,
                permission_mode_flag: None,
                mcp_setup: None,
                enabled: None,
            },
            80,
            24,
            Duration::from_secs(1),
            100,
            std::path::Path::new("/tmp"),
            tokio::sync::mpsc::unbounded_channel().0,
            None,
            None,
            None,
            false,
            None,
            &[],
            None,
        )
        .unwrap();

        // "你好" = E4 BD A0 E5 A5 BD
        // 第一块:前 4 字节(E4 BD A0 E5) — "你"完整 + "好"首字节
        s.feed(b"\xE4\xBD\xA0\xE5", false);
        // 第二块:剩余字节(A5 BD) — 应拼接成 "好"
        s.feed(b"\xA5\xBD", false);

        // 验证:vt100 screen 应包含 "你好"
        let contents = s.parser.screen().contents();
        assert!(
            contents.contains("你好"),
            "screen should contain '你好' after cross-chunk feed, got: {:?}",
            contents
        );
    }

    #[test]
    fn feed_handles_emoji_across_chunks() {
        let mut s = Session::new(
            100,
            "test",
            &BackendConfig {
                command: "echo".into(),
                args: vec![],
                default_model: None,
                model_flag: None,
                permission_mode_flag: None,
                mcp_setup: None,
                enabled: None,
            },
            80,
            24,
            Duration::from_secs(1),
            100,
            std::path::Path::new("/tmp"),
            tokio::sync::mpsc::unbounded_channel().0,
            None,
            None,
            None,
            false,
            None,
            &[],
            None,
        )
        .unwrap();

        // "😀" = F0 9F 98 80
        s.feed(b"\xF0\x9F", false);
        s.feed(b"\x98\x80", false);

        let contents = s.parser.screen().contents();
        assert!(
            contents.contains("😀"),
            "screen should contain '😀' after cross-chunk feed, got: {:?}",
            contents
        );
    }

    #[test]
    fn enter_is_a_turn_submit_arrow_keys_are_not() {
        assert!(looks_like_turn_submit(b"hello\r"));
        assert!(looks_like_turn_submit(b"hello\n"));
        assert!(!looks_like_turn_submit(b"hello"));
        assert!(!looks_like_turn_submit(&[0x1b, b'[', b'A']));
    }

    #[test]
    fn bare_escape_is_a_turn_cancel_escape_sequences_are_not() {
        assert!(looks_like_turn_cancel(b"\x1b"));
        assert!(!looks_like_turn_cancel(b"\x1b[A"));
        assert!(!looks_like_turn_cancel(b"\x1bb"));
        assert!(!looks_like_turn_cancel(b""));
    }

    #[test]
    fn feed_no_truncation_pure_ascii_is_unchanged() {
        let mut s = Session::new(
            101,
            "test",
            &BackendConfig {
                command: "echo".into(),
                args: vec![],
                default_model: None,
                model_flag: None,
                permission_mode_flag: None,
                mcp_setup: None,
                enabled: None,
            },
            80,
            24,
            Duration::from_secs(1),
            100,
            std::path::Path::new("/tmp"),
            tokio::sync::mpsc::unbounded_channel().0,
            None,
            None,
            None,
            false,
            None,
            &[],
            None,
        )
        .unwrap();

        s.feed(b"hello ", false);
        s.feed(b"world\r\n", false);

        let contents = s.parser.screen().contents();
        assert!(
            contents.contains("hello world"),
            "pure ASCII feed should not be affected, got: {:?}",
            contents
        );
    }
}
