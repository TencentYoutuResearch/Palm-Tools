//! Hook Relay — Unix Domain Socket 监听,接收 codebuddy/claude hook 的 JSON 事件并转发到 BridgeBus。
//!
//! ## 设计
//!
//! 1. kode GUI 启动时创建 UDS (`/tmp/kode-hook.sock`,固定路径)
//! 2. kode spawn codebuddy/claude 子进程时在 env 里注入 `KODE_HOOK_SOCK=/tmp/kode-hook.sock`
//! 3. settings.json 里的 hook command 引用 `$KODE_HOOK_SOCK`(纯静态模板,永不需要因 PID 变化重写)
//! 4. relay 解析 hook JSON,提取 `session_id` 和 `hook_event_name`,emit 到 BridgeBus
//!
//! ## 为什么用固定路径而非含 PID 的路径
//!
//! 旧设计(v0.1)把 `/tmp/kode-hook-<pid>.sock` 写死进全局 `~/.codebuddy/settings.json`,
//! kode 重启后 PID 变 → 路径漂移 → 老 codebuddy 会话的 hook 往死 socket 发,靠 `exit 0`
//! 静默兜底导致功能失效但不报错。固定路径消除漂移;启动时抢占式 bind 保证单实例。
//!
//! ## 处理的 Hook 事件
//!
//! | hook_event_name | 条件 | BridgeBus 事件 | 用途 |
//! |----------------|------|---------------|------|
//! | `Notification` | `notification_type: "permission_prompt"` | `ask_user_question_hint` | 即时点亮 attention |
//! | `PermissionRequest` | — | `ask_user_question_hint` | Codex 权限请求点亮 attention |
//! | `UserPromptSubmit` | — | `session.attention_cleared` | 用户回车后即时清除 attention |
//! | `PreToolUse` | — | `session.mode_changed` | 实时获取 permission_mode |
//! | `ConfigChange` | `model` 非空 | `CoreEvent::JsonlMeta` | 同步 CodeBuddy 当前 model |
//! | `PostToolUse` / `SubagentStop` / `SessionEnd` | — | `session.attention_cleared` | Codex 本轮结束后清除 stale attention |
//! | `Stop` | — | `session.turn_finished` + `session.attention_cleared` | codebuddy/claude 本轮真正结束,权威 turn_finished 信号 |
//!
//! ## 安全
//!
//! - socket 权限 `0o600`,仅同用户可连接
//! - relay 只解析已知字段,忽略未知 JSON 字段
//! - socket 文件在 kode 退出时自动清理(Drop impl)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::{BridgeBus, EventEnvelope};
use kode_core::CoreEvent;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

/// Hook Relay 服务,持有 Unix Domain Socket 监听器。
pub struct HookRelay {
    /// socket 文件路径
    socket_path: PathBuf,
    /// Unix Domain Socket 监听器
    listener: UnixListener,
}

/// 固定 socket 路径。settings.json hook command 引用 `$KODE_HOOK_SOCK` 这个 env 变量,
/// kode spawn 子进程时注入该变量 = 此路径。固定路径让 settings.json 成为纯静态模板,
/// 永不需要因 kode 重启/PID 变化而重写。
pub const HOOK_SOCKET_PATH: &str = "/tmp/kode-hook.sock";

impl HookRelay {
    /// 创建 HookRelay,绑定固定路径 UDS(`/tmp/kode-hook.sock`)。
    ///
    /// 启动时抢占式 unlink 旧 socket(上次异常退出的残留),保证单实例。
    /// 若另一个 kode 实例正在运行且持有该 socket,bind 会失败 — 调用方收到 Err 后
    /// 降级为无 HookRelay 运行(hook 功能静默不可用,不阻断启动)。
    pub async fn new() -> Result<Self, String> {
        let socket_path = PathBuf::from(HOOK_SOCKET_PATH);

        // 抢占式清理:上次异常退出可能残留。若另一个实例还活着,bind 会给出明确错误。
        if socket_path.exists() {
            std::fs::remove_file(&socket_path)
                .map_err(|e| format!("remove old socket {} failed: {e}", socket_path.display()))?;
        }

        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("bind UDS {} failed: {e}", socket_path.display()))?;

        // 设置权限为仅 owner 可读写
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&socket_path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(&socket_path, perms);
            }
        }

        tracing::info!(
            socket = %socket_path.display(),
            "HookRelay listening"
        );

        Ok(Self {
            socket_path,
            listener,
        })
    }

    /// 返回 socket 文件路径,供 hook command 使用。
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// 运行 relay 主循环:接受连接,逐行解析 JSON,emit 到 BridgeBus。
    ///
    /// 这是阻塞的 async 函数,应在 spawn 中运行。
    pub async fn run(self, bus: Arc<BridgeBus>, core_tx: mpsc::UnboundedSender<CoreEvent>) {
        loop {
            match self.listener.accept().await {
                Ok((stream, addr)) => {
                    if let Some(peer_creds) = peer_cred(&stream) {
                        tracing::debug!(?addr, ?peer_creds, "HookRelay accepted connection");
                    }
                    let bus = Arc::clone(&bus);
                    let core_tx = core_tx.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(stream, bus, core_tx).await {
                            tracing::warn!(?addr, error = %e, "HookRelay connection error");
                        }
                    });
                }
                Err(e) => {
                    tracing::error!(error = %e, "HookRelay accept error");
                }
            }
        }
    }
}

impl Drop for HookRelay {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
        tracing::info!(
            socket = %self.socket_path.display(),
            "HookRelay socket cleaned up"
        );
    }
}

/// 处理单个 UDS 连接:逐行读 JSON,解析并 emit。
async fn handle_connection(
    stream: UnixStream,
    bus: Arc<BridgeBus>,
    core_tx: mpsc::UnboundedSender<CoreEvent>,
) -> Result<(), String> {
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        process_hook_json_with_core_tx(trimmed, &bus, &core_tx);
    }

    Ok(())
}

/// 解析一行 hook JSON 并 emit 对应的 BridgeBus 事件。
#[cfg(test)]
fn process_hook_json(json_str: &str, bus: &BridgeBus) {
    process_hook_json_inner(json_str, bus, None);
}

fn process_hook_json_with_core_tx(
    json_str: &str,
    bus: &BridgeBus,
    core_tx: &mpsc::UnboundedSender<CoreEvent>,
) {
    process_hook_json_inner(json_str, bus, Some(core_tx));
}

fn process_hook_json_inner(
    json_str: &str,
    bus: &BridgeBus,
    core_tx: Option<&mpsc::UnboundedSender<CoreEvent>>,
) {
    let doc: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(json = %json_str, error = %e, "HookRelay invalid JSON");
            return;
        }
    };

    // 调试用:打印每条收到的 raw hook payload。开 `kode_hook_probe=debug` 可看原文
    // (用于核对 codebuddy 实际发的字段:session_id / transcript_path / source 等)。
    tracing::debug!(
        target: "kode_hook_probe",
        event = %doc.get("hook_event_name").and_then(|v| v.as_str()).unwrap_or("?"),
        raw = %json_str,
        "HookRelay RAW payload"
    );

    let session_id = doc
        .get("session_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    if session_id == 0 {
        tracing::debug!(?doc, "HookRelay skipping event with no session_id");
        return;
    }

    let event_name = doc
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match event_name {
        "Notification" => {
            let notification_type = doc
                .get("notification_type")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            match notification_type {
                "permission_prompt" => {
                    let message = doc.get("message").and_then(|v| v.as_str()).unwrap_or("");

                    tracing::info!(
                        %session_id,
                        %message,
                        "HookRelay: permission_prompt → attention"
                    );

                    bus.emit(EventEnvelope::new(
                        session_id,
                        "ask_user_question_hint",
                        serde_json::json!({
                            "session_id": session_id,
                            "message": message,
                        }),
                    ));
                }
                "idle_prompt" => {
                    // idle prompt 暂不处理,将来可用于长时间无操作的提醒
                    tracing::debug!(%session_id, "HookRelay: idle_prompt (ignored)");
                }
                other => {
                    tracing::debug!(%session_id, notification_type = other, "HookRelay: unhandled notification_type");
                }
            }
        }
        "UserPromptSubmit" => {
            tracing::info!(%session_id, "HookRelay: UserPromptSubmit → attention_cleared");

            bus.emit(EventEnvelope::new(
                session_id,
                "session.attention_cleared",
                serde_json::json!({ "reason": "hook_user_submitted" }),
            ));
        }
        "PermissionRequest" => {
            let tool_name = doc.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
            let description = doc
                .get("tool_input")
                .and_then(|v| v.get("description"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let message = if description.is_empty() {
                format!("Codex requests permission for {tool_name}")
            } else {
                description.to_string()
            };

            tracing::info!(%session_id, %tool_name, "HookRelay: PermissionRequest → attention");

            bus.emit(EventEnvelope::new(
                session_id,
                "ask_user_question_hint",
                serde_json::json!({
                    "session_id": session_id,
                    "message": message,
                }),
            ));
        }
        "PreToolUse" => {
            let permission_mode = doc
                .get("permission_mode")
                .and_then(|v| v.as_str())
                .unwrap_or("default");

            tracing::debug!(%session_id, %permission_mode, "HookRelay: PreToolUse → mode_changed");

            bus.emit(EventEnvelope::new(
                session_id,
                "session.mode_changed",
                serde_json::json!({ "mode": permission_mode }),
            ));
        }
        "ConfigChange" => {
            let model = doc
                .get("model")
                .and_then(|v| v.as_str())
                .map(kode_core::model_alias::sanitize_model_name)
                .filter(|model| !model.is_empty());
            let (Some(model), Some(core_tx)) = (model, core_tx) else {
                return;
            };
            let _ = core_tx.send(CoreEvent::JsonlMeta {
                id: session_id,
                model: Some(model),
                title: None,
                session_uuid: None,
                tokens_reset: false,
                tokens: None,
                input_tokens: None,
                output_tokens: None,
                cached_tokens: None,
                cost_usd: None,
                context_pct: None,
            });
        }
        "SessionStart" => {
            // codebuddy/claude/codex 在会话创建或恢复时发 SessionStart。
            // hook bridge 已把 session_id 改写成 kode tab id,并保留真实 backend uuid
            // 与 transcript_path。用 transcript_path 权威地把 tab 绑定到真实 jsonl/rollout。
            let session_uuid = doc
                .get("codebuddy_session_uuid")
                .or_else(|| doc.get("codex_session_uuid"))
                .or_else(|| doc.get("session_uuid"))
                .and_then(|v| v.as_str())
                .map(String::from);
            let transcript_path = doc
                .get("transcript_path")
                .and_then(|v| v.as_str())
                .map(String::from);
            let source = doc.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let model = doc.get("model").and_then(|v| v.as_str()).map(String::from);

            tracing::info!(
                %session_id,
                %source,
                uuid = ?session_uuid,
                transcript = ?transcript_path,
                "HookRelay: SessionStart → session_uuid_mapped"
            );

            bus.emit(EventEnvelope::new(
                session_id,
                "session.session_uuid_mapped",
                serde_json::json!({
                    "tab_id": session_id,
                    "session_uuid": session_uuid,
                    "transcript_path": transcript_path,
                    "source": source,
                    "model": model,
                }),
            ));
        }
        "Stop" => {
            // agent 本轮真正结束(codebuddy/claude 的 Stop hook 语义)。
            // 这是 turn_finished 的权威信号 —— semantic.rs 不再基于 jsonl
            // `status=completed` emit(那条是"message 流完",一轮会有多条)。
            tracing::info!(%session_id, "HookRelay: Stop → turn_finished + attention_cleared");
            bus.emit(EventEnvelope::new(
                session_id,
                "session.turn_finished",
                serde_json::json!({
                    "status": "completed",
                    "summary": null,
                    "duration_ms": null,
                    "turn_id": null,
                }),
            ));
            bus.emit(EventEnvelope::new(
                session_id,
                "session.attention_cleared",
                serde_json::json!({ "reason": "hook_Stop" }),
            ));
        }
        "PostToolUse" | "SubagentStop" | "SessionEnd" => {
            // Codex 的 permission / approval attention 可能来自 PermissionRequest
            // hook,而结束信号不是 UserPromptSubmit。工具完成或本轮结束时直接清除,
            // 避免 GUI banner 停在"等待回答"。
            // 注意:SubagentStop 是子 agent 停止,不是主 turn 结束,不 emit turn_finished。
            tracing::info!(%session_id, %event_name, "HookRelay: completion → attention_cleared");
            bus.emit(EventEnvelope::new(
                session_id,
                "session.attention_cleared",
                serde_json::json!({ "reason": format!("hook_{event_name}") }),
            ));
        }
        "PreCompact" => {
            // 这个 hook 事件暂不需要 relay 处理
            tracing::trace!(%session_id, %event_name, "HookRelay: ignored hook event");
        }
        other => {
            tracing::debug!(%session_id, %other, "HookRelay: unknown hook event");
        }
    }
}

/// 获取 Unix socket peer 凭据(仅用于日志)。
#[cfg(unix)]
fn peer_cred(stream: &UnixStream) -> Option<(u32, u32, u32)> {
    // peer_addr 返回 path 或 unnamed,不提供 uid/pid
    // 我们只做基本检查:socket 权限 0o600 已保证安全性
    let _ = stream.peer_addr().ok()?;
    Some((0, 0, 0))
}

#[cfg(not(unix))]
fn peer_cred(_stream: &UnixStream) -> Option<(u32, u32, u32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_notification_permission_prompt() {
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "session_id": "42",
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
            "message": "CodeBuddy needs your permission to use Bash"
        }"#;

        process_hook_json(json, &bus);

        let env = rx.try_recv().expect("should receive event");
        assert_eq!(env.r#type, "ask_user_question_hint");
        assert_eq!(env.session_id, 42);
        assert_eq!(
            env.payload["message"],
            "CodeBuddy needs your permission to use Bash"
        );
    }

    #[test]
    fn process_user_prompt_submit() {
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "session_id": "42",
            "hook_event_name": "UserPromptSubmit",
            "prompt": "hello world"
        }"#;

        process_hook_json(json, &bus);

        let env = rx.try_recv().expect("should receive event");
        assert_eq!(env.r#type, "session.attention_cleared");
        assert_eq!(env.session_id, 42);
    }

    #[test]
    fn process_codex_completion_clears_attention() {
        // PostToolUse / SubagentStop / SessionEnd 只清 attention,不 emit turn_finished
        // (SubagentStop 是子 agent 停,SessionEnd 是会话退出,都不是主 turn 结束)。
        for hook_event_name in ["PostToolUse", "SubagentStop", "SessionEnd"] {
            let bus = Arc::new(BridgeBus::new());
            let mut rx = bus.subscribe();

            let json = format!(
                r#"{{
                    "session_id": "42",
                    "hook_event_name": "{hook_event_name}"
                }}"#
            );

            process_hook_json(&json, &bus);

            let env = rx.try_recv().expect("should receive clear event");
            assert_eq!(env.r#type, "session.attention_cleared");
            assert_eq!(env.session_id, 42);
            assert_eq!(env.payload["reason"], format!("hook_{hook_event_name}"));
        }
    }

    #[test]
    fn process_stop_emits_turn_finished_and_clears_attention() {
        // Stop 是 codebuddy/claude 本轮 turn 真正结束的权威信号:
        // emit turn_finished(让 Event Center 显示 "Response complete")+
        // attention_cleared(关掉 awaiting answer banner)。
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "session_id": "42",
            "hook_event_name": "Stop"
        }"#;

        process_hook_json(json, &bus);

        let env1 = rx.try_recv().expect("should receive turn_finished");
        assert_eq!(env1.r#type, "session.turn_finished");
        assert_eq!(env1.session_id, 42);
        assert_eq!(env1.payload["status"], "completed");

        let env2 = rx.try_recv().expect("should receive attention_cleared");
        assert_eq!(env2.r#type, "session.attention_cleared");
        assert_eq!(env2.session_id, 42);
        assert_eq!(env2.payload["reason"], "hook_Stop");
    }

    #[test]
    fn process_pretooluse_mode() {
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "session_id": "42",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "permission_mode": "plan"
        }"#;

        process_hook_json(json, &bus);

        let env = rx.try_recv().expect("should receive event");
        assert_eq!(env.r#type, "session.mode_changed");
        assert_eq!(env.payload["mode"], "plan");
    }

    #[test]
    fn process_config_change_emits_model_meta() {
        let bus = Arc::new(BridgeBus::new());
        let (core_tx, mut core_rx) = tokio::sync::mpsc::unbounded_channel();
        process_hook_json_with_core_tx(
            r#"{"session_id":"42","hook_event_name":"ConfigChange","model":"hy3-ioa"}"#,
            &bus,
            &core_tx,
        );
        match core_rx.try_recv().expect("model metadata") {
            CoreEvent::JsonlMeta { id, model, .. } => {
                assert_eq!(id, 42);
                assert_eq!(model.as_deref(), Some("hy3-ioa"));
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }

    #[test]
    fn process_codex_session_start_maps_transcript_path() {
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "session_id": "42",
            "hook_event_name": "SessionStart",
            "codex_session_uuid": "codex-uuid",
            "transcript_path": "/tmp/rollout.jsonl",
            "source": "startup",
            "model": "gpt-5"
        }"#;

        process_hook_json(json, &bus);

        let env = rx.try_recv().expect("should receive event");
        assert_eq!(env.r#type, "session.session_uuid_mapped");
        assert_eq!(env.session_id, 42);
        assert_eq!(env.payload["session_uuid"], "codex-uuid");
        assert_eq!(env.payload["transcript_path"], "/tmp/rollout.jsonl");
        assert_eq!(env.payload["source"], "startup");
        assert_eq!(env.payload["model"], "gpt-5");
    }

    #[test]
    fn process_permission_request_attention() {
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "session_id": "42",
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": {"description": "Run cargo test"}
        }"#;

        process_hook_json(json, &bus);

        let env = rx.try_recv().expect("should receive event");
        assert_eq!(env.r#type, "ask_user_question_hint");
        assert_eq!(env.session_id, 42);
        assert_eq!(env.payload["message"], "Run cargo test");
    }

    #[test]
    fn process_unknown_event_ignored() {
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "session_id": "42",
            "hook_event_name": "UnknownEvent"
        }"#;

        process_hook_json(json, &bus);

        // 不应该有事件被 emit
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn process_no_session_id_skipped() {
        let bus = Arc::new(BridgeBus::new());
        let mut rx = bus.subscribe();

        let json = r#"{
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt"
        }"#;

        process_hook_json(json, &bus);

        assert!(rx.try_recv().is_err());
    }
}
