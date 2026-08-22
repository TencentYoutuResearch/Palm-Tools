//! 把 jsonl 增量行解析为语义事件(`message` / `tool_use`)并推到 `BridgeBus`。
//!
//! 与 `kode_core::session::jsonl_tail`(只摘 model/title/tokens)互补:
//! 那一份只关心摘要,这一份关心**对话内容**给手机端 / 协议消费。
//!
//! 设计:
//! - 一个 session 对应一个 task,与 jsonl_tail 重复打开文件(浪费可接受)
//! - tail 主循环:open → seek 0 → 逐行 read_line → parse → emit;EOF 等 300ms
//! - 启动时刻文件可能还没创建(子进程慢),最长等 30s
//! - 不维护 message_id 严格唯一性;同一行可能产出多个事件(text + tool_use 混排)
//!
//! 当前覆盖:
//! - ✅ codebuddy: type="message" 提取 user/assistant 文本 + tool_use(待实测)
//! - ✅ claude: type="user|assistant" 提取 content 数组中的 text / tool_use / tool_result
//! - ⏳ ask_user_question / plan_proposed / task_create / task_update — 9.2 联调时按真实 jsonl 实测补
//! - ✅ session.turn_finished:codebuddy/claude/codex 一轮回复完成通知
//!
//! tool_use 当前是 best-effort:把已知工具名 + input 摘要写成卡片。
//! 详细 input/output 在 PROTOCOL.md 里允许 < 4KB 截断。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use kode_core::session::jsonl_tail::Backend;
use kode_core::SessionId;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader, SeekFrom};
use tokio::time::sleep;

use crate::{BridgeBus, EventEnvelope};

/// 启动语义 tail。task 在 bus 不再有强引用 / 文件被删 时自然退出。
///
/// `is_resume`:true 时使用带全局搜索兜底的路径解析(cwd 不确定时也能找到文件)。
pub fn spawn(
    id: SessionId,
    backend: Backend,
    cwd: std::path::PathBuf,
    session_id: String,
    bus: Arc<BridgeBus>,
) {
    if backend == Backend::Cursor {
        let Some(path) = kode_core::session::cursor_tail::cursor_transcript_path(&cwd, &session_id)
        else {
            tracing::debug!(?cwd, %session_id, "no cursor transcript path; semantic tail not spawned");
            return;
        };
        tokio::spawn(async move {
            if let Err(e) = run(id, backend, path, bus).await {
                tracing::debug!(error = %e, "cursor semantic tail exited");
            }
        });
        return;
    }
    // 优先 cwd 推算路径;文件不存在时全局扫描(处理 resume 时 cwd 被 override 的情况)
    let path = match kode_core::session::jsonl_tail::resolve_session_path(
        backend,
        &cwd,
        &session_id,
    ) {
        Some(p) => p,
        None => {
            // resolve 也没找到:文件可能还没创建(新 session),用 cwd 路径让 tail 等待
            match backend.session_path(&cwd, &session_id) {
                Some(p) => p,
                None => {
                    tracing::debug!(?cwd, %session_id, ?backend, "no jsonl path; semantic tail not spawned");
                    return;
                }
            }
        }
    };
    tokio::spawn(async move {
        if let Err(e) = run(id, backend, path, bus).await {
            tracing::debug!(error = %e, "semantic tail exited");
        }
    });
}

async fn run(
    id: SessionId,
    backend: Backend,
    path: PathBuf,
    bus: Arc<BridgeBus>,
) -> std::io::Result<()> {
    let mut attempts = 0;
    let file = loop {
        match File::open(&path).await {
            Ok(f) => break f,
            Err(_) if attempts < 60 => {
                attempts += 1;
                sleep(Duration::from_millis(500)).await;
            }
            Err(e) => return Err(e),
        }
    };

    let mut reader = BufReader::new(file);
    let replay_boundary = reader.get_ref().metadata().await?.len();
    reader.seek(SeekFrom::Start(0)).await?;
    let mut buf = String::new();

    loop {
        buf.clear();
        let line_start = reader.stream_position().await?;
        let n = reader.read_line(&mut buf).await?;
        if n == 0 {
            sleep(Duration::from_millis(300)).await;
            continue;
        }
        let line = buf.trim();
        if line.is_empty() {
            continue;
        }
        let is_replay = line_start < replay_boundary;
        for env in parse_line(id, backend, line) {
            if is_replay && env.r#type == "session.turn_finished" {
                continue;
            }
            bus.emit(env);
        }
    }
}

/// 公开给单元测试用(不需要文件系统)。
pub fn parse_line(id: SessionId, backend: Backend, line: &str) -> Vec<EventEnvelope> {
    match backend {
        Backend::Codebuddy => parse_codebuddy(id, line),
        Backend::Claude => parse_claude(id, line),
        Backend::Codex => parse_codex(id, line),
        Backend::Cursor => parse_cursor(id, line),
    }
}

// ============================================================================
// codebuddy
// ============================================================================

// 注:codebuddy 顶层 type 多种(message / function_call / function_call_result / ...),
// 我们直接用 Value 解析,不定义 CbEntry struct(以前定义过,后撤,因为 codebuddy
// 字段比 claude 的 tagged union 复杂得多,struct 反而更脆)

fn parse_codebuddy(id: SessionId, line: &str) -> Vec<EventEnvelope> {
    // 直接拿 Value:codebuddy 顶层 type 有 message / function_call / function_call_result /
    // file-history-snapshot / summary 等,不能假定字段固定
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

    match ty {
        "message" => parse_codebuddy_message(id, &v),
        "function_call" => parse_codebuddy_function_call(id, &v),
        "function_call_result" => parse_codebuddy_function_call_result(id, &v),
        _ => vec![],
    }
}

fn parse_codebuddy_message(id: SessionId, v: &Value) -> Vec<EventEnvelope> {
    let role = v.get("role").and_then(|x| x.as_str()).unwrap_or("");
    if !matches!(role, "user" | "assistant" | "system") {
        return vec![];
    }
    // text:优先顶层 content(string|array),否则 providerData.content
    let content_val = v.get("content").cloned().or_else(|| {
        v.get("providerData")
            .and_then(|pd| pd.get("content").cloned())
    });
    let text = content_val
        .as_ref()
        .and_then(content_to_text)
        .unwrap_or_default();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let out = vec![EventEnvelope::new(
        id,
        "message",
        json!({
            "id": format!("{}-{}", id, fnv_hash(trimmed)),
            "role": role,
            "text": cap_text(trimmed, 16 * 1024),
            "tool_calls": Vec::<Value>::new(),
            "timestamp_ms": source_timestamp_ms(v),
        }),
    )];
    // 不基于 `status=="completed"` emit turn_finished:codebuddy jsonl 里每条
    // assistant message 都标 `status=completed`(语义是"这条 message 流完了",
    // 不是"整轮 turn 结束")。一轮含工具调用的 turn 会有多条 assistant message,
    // 每条都 emit 会导致 Event Center 提前弹 "Response complete" 且反复刷新。
    // turn_finished 改由 hook_relay 的 `Stop` 事件触发(agent 真正停止时发),
    // 见 hook_relay.rs 的 "Stop" 分支。
    out
}

/// codebuddy 顶层 `type=function_call` 行 = 工具调用发起。
/// 关键字段:
///   - `callId`(我们用作 protocol id,与后续 result 关联)
///   - `name`(工具名,codebuddy 在 function_call 顶层有写)
///   - `arguments`:**JSON 字符串**(不是对象!),需要二次 parse 拿到结构化 input
///   - `providerData.argumentsDisplayText`(简短 input 摘要,codebuddy 自己已渲染好)
///   - `providerData.toolResult.content`:**ExitPlanMode 的 plan 全文藏在这里**
///     (arguments 是 `{}` 空)
///
/// 特判:AskUserQuestion / ExitPlanMode / TaskCreate / TaskUpdate 升级成
/// 协议级语义事件(ask_user_question / plan_proposed / task_create / task_update),
/// 跟 claude 端保持一致 — 让 Flutter 能渲染对应卡片。
fn parse_codebuddy_function_call(id: SessionId, v: &Value) -> Vec<EventEnvelope> {
    let call_id = v
        .get("callId")
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("call-{}", fnv_hash(&v.to_string())));
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_string();

    // arguments 是字符串 — 二次 parse 才能拿到 questions/plan/subject 等结构
    let args: Value = v
        .get("arguments")
        .and_then(|a| match a {
            Value::String(s) => serde_json::from_str(s).ok(),
            other => Some(other.clone()),
        })
        .unwrap_or(Value::Null);

    match name.as_str() {
        "AskUserQuestion" => {
            if let Some(questions) = args.get("questions").and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(questions.len());
                for (qi, q) in questions.iter().enumerate() {
                    let qid = format!("{call_id}-{qi}");
                    let question = q
                        .get("question")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let header = q.get("header").and_then(|v| v.as_str()).map(String::from);
                    let multi = q
                        .get("multiSelect")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let options: Vec<Value> = q
                        .get("options")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    out.push(EventEnvelope::new(
                        id,
                        "ask_user_question",
                        json!({
                            "question_id": qid,
                            "question": question,
                            "header": header,
                            "multi_select": multi,
                            "options": options,
                        }),
                    ));
                }
                return out;
            }
            vec![]
        }
        "ExitPlanMode" => {
            // codebuddy 把 plan 文本放在 providerData.toolResult.content,arguments 多为空
            let plan_md = v
                .get("providerData")
                .and_then(|pd| pd.get("toolResult"))
                .and_then(|tr| tr.get("content"))
                .and_then(|c| c.as_str())
                .map(String::from)
                .or_else(|| args.get("plan").and_then(|p| p.as_str()).map(String::from))
                .unwrap_or_default();
            vec![EventEnvelope::new(
                id,
                "plan_proposed",
                json!({
                    "plan_id": call_id,
                    "plan_md": plan_md,
                }),
            )]
        }
        "TaskCreate" => {
            let subject = args
                .get("subject")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let description = args
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            vec![EventEnvelope::new(
                id,
                "task_create",
                json!({
                    "id": call_id,
                    "subject": subject,
                    "description": description,
                    "status": "pending",
                }),
            )]
        }
        "TaskUpdate" => {
            let task_id = args
                .get("taskId")
                .and_then(|v| v.as_str())
                .map(String::from);
            let status = args
                .get("status")
                .and_then(|v| v.as_str())
                .map(String::from);
            vec![EventEnvelope::new(
                id,
                "task_update",
                json!({
                    "id": task_id.unwrap_or_else(|| call_id.clone()),
                    "status": status,
                }),
            )]
        }
        _ => {
            // 普通 tool_use:用 codebuddy 已渲染好的 displayText,fallback 到结构化 summary
            let summary = v
                .get("providerData")
                .and_then(|pd| pd.get("argumentsDisplayText"))
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| {
                    if args.is_null() {
                        name.clone()
                    } else {
                        summarize_tool_input(&name, &args)
                    }
                });
            vec![EventEnvelope::new(
                id,
                "tool_use",
                json!({
                    "id": call_id,
                    "tool": name,
                    "input_summary": summary,
                    "output_preview": null,
                    "status": "running",
                }),
            )]
        }
    }
}

fn parse_codebuddy_function_call_result(id: SessionId, v: &Value) -> Vec<EventEnvelope> {
    let call_id = v
        .get("callId")
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("call-{}", fnv_hash(&v.to_string())));
    let name = v.get("name").and_then(|x| x.as_str()).map(String::from);
    // 协议级工具的 result 在 function_call 时已升级成 ask_user_question / plan_proposed
    // / task_create / task_update,这里再 emit tool_use 会让 Flutter 多出一张空卡片。
    if let Some(n) = name.as_deref() {
        match n {
            "AskUserQuestion" => {
                // AskUserQuestion 完成 → 用户已回答,清掉 attention 脉冲动效。
                // scan_loop 只在 PTY idle + detect=None 时才清,
                // 但 detect() 可能因屏幕残留内容短暂误判,导致 banner 黏住不消。
                // 从 jsonl 拿到 result 是"用户确实回答了"的可靠信号,直接清。
                return vec![EventEnvelope::new(
                    id,
                    "session.attention_cleared",
                    serde_json::json!({ "reason": "ask_user_question_completed" }),
                )];
            }
            "ExitPlanMode" => {
                // ExitPlanMode 完成 → 用户已决策(批准/拒绝),清掉 plan attention。
                // output 结构:{type:"text", text:"..."}
                let text = v
                    .get("output")
                    .and_then(|o| o.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                let reason = if text.starts_with("ExitPlanMode is not available to sub-agents") {
                    // 子 agent 误调 → 不该有 plan attention,但即使有也清掉
                    "plan_subagent_noise"
                } else {
                    // approved (status=completed) 或 rejected/keep-planning (status=incomplete)
                    // 统一熄灭 — 用户已决策
                    "plan_resolved"
                };
                return vec![EventEnvelope::new(
                    id,
                    "session.attention_cleared",
                    serde_json::json!({ "reason": reason }),
                )];
            }
            "TaskCreate" | "TaskUpdate" => {
                return vec![];
            }
            _ => {}
        }
    }
    let status_raw = v.get("status").and_then(|x| x.as_str()).unwrap_or("");
    let status = match status_raw {
        "completed" | "ok" | "success" => "ok",
        "failed" | "error" | "errored" | "incomplete" => "error",
        _ => "ok",
    };
    let preview = v
        .get("output")
        .map(|o| value_to_preview(o, 4 * 1024))
        .unwrap_or_default();
    vec![EventEnvelope::new(
        id,
        "tool_use",
        json!({
            "id": call_id,
            "tool": name,
            "input_summary": null,
            "output_preview": preview,
            "status": status,
        }),
    )]
}

// ============================================================================
// claude
// ============================================================================

#[derive(Debug, Deserialize)]
struct ClEntry {
    #[serde(rename = "type")]
    r#type: Option<String>,
    message: Option<ClMessage>,
}

#[derive(Debug, Deserialize)]
struct ClMessage {
    role: Option<String>,
    content: Option<Value>,
    stop_reason: Option<String>,
}

fn parse_claude(id: SessionId, line: &str) -> Vec<EventEnvelope> {
    let raw: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let timestamp_ms = source_timestamp_ms(&raw);
    let entry: ClEntry = match serde_json::from_value(raw) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let ty = entry.r#type.as_deref().unwrap_or("");
    if !matches!(ty, "user" | "assistant" | "system") {
        return vec![];
    }
    let Some(msg) = entry.message else {
        return vec![];
    };
    let role = msg.role.as_deref().unwrap_or(ty).to_string();
    let stop_reason = msg.stop_reason.as_deref().map(str::to_string);

    let mut out: Vec<EventEnvelope> = Vec::new();
    let mut tool_call_ids: Vec<Value> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();

    if let Some(content) = msg.content {
        if let Some(s) = content.as_str() {
            // user 命令前缀(<command-name> 等)直接跳
            if !s.trim_start().starts_with('<') {
                text_parts.push(s.to_string());
            }
        } else if let Some(arr) = content.as_array() {
            for item in arr {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                let item_ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match item_ty {
                    "text" => {
                        if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                            if !t.trim_start().starts_with('<') {
                                text_parts.push(t.to_string());
                            }
                        }
                    }
                    "tool_use" => {
                        let tool = obj
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?")
                            .to_string();
                        let tool_id = obj
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                            .unwrap_or_else(|| format!("tu-{}", fnv_hash(&tool)));
                        let input = obj.get("input").unwrap_or(&Value::Null);

                        // 特判:AskUserQuestion / ExitPlanMode / TaskCreate / TaskUpdate
                        // 升级成对应的协议级语义事件,而不只是平凡 tool_use 卡片。
                        match tool.as_str() {
                            "AskUserQuestion" => {
                                // input.questions 是数组,但桌面端通常一次只问一题。
                                // 协议 ask_user_question 一次只描述一题 → 多题展开成多个事件。
                                if let Some(questions) =
                                    input.get("questions").and_then(|v| v.as_array())
                                {
                                    for (qi, q) in questions.iter().enumerate() {
                                        let qid = format!("{tool_id}-{qi}");
                                        let question = q
                                            .get("question")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let header = q
                                            .get("header")
                                            .and_then(|v| v.as_str())
                                            .map(String::from);
                                        let multi = q
                                            .get("multiSelect")
                                            .and_then(|v| v.as_bool())
                                            .unwrap_or(false);
                                        let options: Vec<Value> = q
                                            .get("options")
                                            .and_then(|v| v.as_array())
                                            .cloned()
                                            .unwrap_or_default();
                                        out.push(EventEnvelope::new(
                                            id,
                                            "ask_user_question",
                                            json!({
                                                "question_id": qid,
                                                "question": question,
                                                "header": header,
                                                "multi_select": multi,
                                                "options": options,
                                            }),
                                        ));
                                    }
                                }
                            }
                            "ExitPlanMode" => {
                                let plan_md = input
                                    .get("plan")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                out.push(EventEnvelope::new(
                                    id,
                                    "plan_proposed",
                                    json!({
                                        "plan_id": tool_id,
                                        "plan_md": plan_md,
                                    }),
                                ));
                            }
                            "TaskCreate" => {
                                let subject = input
                                    .get("subject")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let description = input
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                out.push(EventEnvelope::new(
                                    id,
                                    "task_create",
                                    json!({
                                        "id": tool_id,
                                        "subject": subject,
                                        "description": description,
                                        "status": "pending",
                                    }),
                                ));
                            }
                            "TaskUpdate" => {
                                let task_id = input
                                    .get("taskId")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                let status = input
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                out.push(EventEnvelope::new(
                                    id,
                                    "task_update",
                                    json!({
                                        "id": task_id.unwrap_or_else(|| tool_id.clone()),
                                        "status": status,
                                    }),
                                ));
                            }
                            _ => {
                                let summary = summarize_tool_input(&tool, input);
                                out.push(EventEnvelope::new(
                                    id,
                                    "tool_use",
                                    json!({
                                        "id": tool_id,
                                        "tool": tool,
                                        "input_summary": summary,
                                        "output_preview": null,
                                        "status": "running",
                                    }),
                                ));
                            }
                        }
                        tool_call_ids.push(
                            json!({ "tool_use_id": obj.get("id").cloned().unwrap_or(Value::Null) }),
                        );
                    }
                    "tool_result" => {
                        let tool_use_id = obj
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?")
                            .to_string();
                        let is_error = obj
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let preview = obj
                            .get("content")
                            .map(|c| value_to_preview(c, 4 * 1024))
                            .unwrap_or_default();
                        out.push(EventEnvelope::new(
                            id,
                            "tool_use",
                            json!({
                                "id": tool_use_id,
                                "tool": null,
                                "input_summary": null,
                                "output_preview": preview,
                                "status": if is_error { "error" } else { "ok" },
                            }),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }

    let merged = text_parts.join("\n").trim().to_string();
    if !merged.is_empty() {
        let mut payload = json!({
            "id": format!("{}-{}", id, fnv_hash(&merged)),
            "role": role,
            "text": cap_text(&merged, 16 * 1024),
            "tool_calls": tool_call_ids,
            "timestamp_ms": timestamp_ms,
        });
        // 把 message 放在 tool_use 之前,符合 jsonl 时序(text 先于工具调用结果)
        let env = EventEnvelope::new(id, "message", payload.take());
        out.insert(0, env);
    }
    if role == "assistant" && stop_reason.as_deref() == Some("end_turn") {
        out.push(turn_finished_event(
            id,
            "completed",
            (!merged.is_empty()).then_some(merged.as_str()),
            None,
            None,
        ));
    }

    out
}

// ============================================================================
// codex
// ============================================================================

fn parse_codex(id: SessionId, line: &str) -> Vec<EventEnvelope> {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    match v.get("type").and_then(|x| x.as_str()) {
        Some("response_item") => parse_codex_response_item(id, &v),
        Some("event_msg") => parse_codex_event_msg(id, &v),
        _ => vec![],
    }
}

fn parse_codex_response_item(id: SessionId, v: &Value) -> Vec<EventEnvelope> {
    let payload = v.get("payload").unwrap_or(&Value::Null);
    if payload.get("type").and_then(|x| x.as_str()) != Some("message") {
        return vec![];
    }
    let role = payload.get("role").and_then(|x| x.as_str()).unwrap_or("");
    if !matches!(role, "user" | "assistant" | "system") {
        return vec![];
    }
    let text = payload
        .get("content")
        .and_then(content_to_text)
        .unwrap_or_default();
    let trimmed = text.trim();
    if trimmed.is_empty() || is_codex_control_message(role, trimmed) {
        return vec![];
    }

    vec![EventEnvelope::new(
        id,
        "message",
        json!({
            "id": format!("{}-{}", id, fnv_hash(trimmed)),
            "role": role,
            "text": cap_text(trimmed, 16 * 1024),
            "tool_calls": Vec::<Value>::new(),
            "timestamp_ms": source_timestamp_ms(v),
        }),
    )]
}

fn parse_codex_event_msg(id: SessionId, v: &Value) -> Vec<EventEnvelope> {
    let payload = v.get("payload").unwrap_or(&Value::Null);
    if payload.get("type").and_then(|x| x.as_str()) != Some("task_complete") {
        return vec![];
    }
    let summary = payload
        .get("last_agent_message")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty());
    let duration_ms = payload.get("duration_ms").and_then(|x| x.as_u64());
    let turn_id = payload.get("turn_id").and_then(|x| x.as_str());
    vec![turn_finished_event(
        id,
        "completed",
        summary,
        duration_ms,
        turn_id,
    )]
}

fn is_codex_control_message(role: &str, s: &str) -> bool {
    role == "user"
        && (s.starts_with('<')
            || s.starts_with('/')
            || s.starts_with("C-b")
            || s.starts_with("# AGENTS.md instructions")
            || s.starts_with("<environment_context>")
            || s.starts_with("<kode-memory>")
            || s.starts_with("<permissions instructions>")
            || s.starts_with("<collaboration_mode>")
            || s.starts_with("<skills_instructions>")
            || s.starts_with("● DeferExecuteTool("))
}

// ============================================================================
// cursor
// ============================================================================

fn parse_cursor(id: SessionId, line: &str) -> Vec<EventEnvelope> {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    if v.get("type").and_then(Value::as_str) == Some("turn_ended") {
        let status = match v.get("status").and_then(Value::as_str) {
            Some("success") => "completed",
            Some("cancelled") => "cancelled",
            _ => "failed",
        };
        return vec![turn_finished_event(id, status, None, None, None)];
    }

    let role = v.get("role").and_then(Value::as_str).unwrap_or("");
    if !matches!(role, "user" | "assistant" | "system") {
        return Vec::new();
    }
    let Some(content) = v.get("message").and_then(|message| message.get("content")) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    if let Some(text) = content_to_text(content) {
        let text = if role == "user" {
            cursor_user_query(&text)
        } else {
            text.trim().to_string()
        };
        if !text.is_empty() {
            events.push(EventEnvelope::new(
                id,
                "message",
                json!({
                    "id": format!("{}-{}-{}", id, role, fnv_hash(&text)),
                    "role": role,
                    "text": cap_text(&text, 16 * 1024),
                    "tool_calls": Vec::<Value>::new(),
                    "timestamp_ms": source_timestamp_ms(&v),
                }),
            ));
        }
    }
    if let Some(items) = content.as_array() {
        for (index, item) in items.iter().enumerate() {
            if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let tool = item.get("name").and_then(Value::as_str).unwrap_or("?");
            let input = item.get("input").cloned().unwrap_or(Value::Null);
            events.push(EventEnvelope::new(
                id,
                "tool_use",
                json!({
                    "id": format!("cursor-{}-{}-{}", id, fnv_hash(line), index),
                    "tool": tool,
                    "input_summary": summarize_tool_input(tool, &input),
                    "output_preview": Value::Null,
                    "status": "running",
                }),
            ));
        }
    }
    events
}

fn cursor_user_query(text: &str) -> String {
    if let Some(start) = text.find("<user_query>") {
        let rest = &text[start + "<user_query>".len()..];
        return rest
            .split("</user_query>")
            .next()
            .unwrap_or(rest)
            .trim()
            .to_string();
    }
    text.trim().to_string()
}

// ============================================================================
// helpers
// ============================================================================

fn turn_finished_event(
    id: SessionId,
    status: &str,
    summary: Option<&str>,
    duration_ms: Option<u64>,
    turn_id: Option<&str>,
) -> EventEnvelope {
    EventEnvelope::new(
        id,
        "session.turn_finished",
        json!({
            "status": status,
            "summary": summary.map(|s| cap_text(s.trim(), 512)),
            "duration_ms": duration_ms,
            "turn_id": turn_id,
        }),
    )
}

fn content_to_text(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = v.as_array() {
        let mut parts = Vec::new();
        for item in arr {
            if let Some(obj) = item.as_object() {
                let ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                // codebuddy 用 "input_text" / "output_text",claude 用 "text" — 都收
                if matches!(ty, "text" | "input_text" | "output_text") {
                    if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                        parts.push(t.to_string());
                    }
                }
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n"));
        }
    }
    None
}

/// Read the message's own timestamp from a backend transcript record.
///
/// `EventEnvelope.ts` intentionally remains the bridge ingestion time because
/// it is also the `/history?from=` cursor. Reusing it in the UI makes a replayed
/// session look as if every historical message arrived at the replay minute.
/// Backends currently use either unix milliseconds (CodeBuddy) or RFC 3339
/// strings (Claude/Codex). Cursor transcripts do not contain a reliable time,
/// so callers receive `None` and the mobile UI omits the label.
fn source_timestamp_ms(v: &Value) -> Option<i64> {
    let raw = ["timestamp", "created_at", "createdAt", "ts"]
        .iter()
        .find_map(|key| v.get(*key))?;

    match raw {
        Value::Number(number) => {
            let value = number.as_i64()?;
            // Accept unix seconds defensively, while preserving the millisecond
            // values emitted by CodeBuddy.
            Some(if value.abs() < 100_000_000_000 {
                value.saturating_mul(1000)
            } else {
                value
            })
        }
        Value::String(value) => chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|timestamp| timestamp.timestamp_millis()),
        _ => None,
    }
}

/// 简单 FNV-1a 32-bit,用于事件 id 去重(不需要密码学强度)
pub(crate) fn fnv_hash(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

fn cap_text(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push_str("\n…[truncated]");
    out
}

/// 工具 input 摘要为单行(< 120 字符)。已知工具按字段挑;未知工具回退到 keys。
pub(crate) fn summarize_tool_input(tool: &str, input: &Value) -> String {
    let one_line = |s: &str| -> String {
        let single = s.replace('\n', " ").replace('\r', " ");
        let trimmed = single.trim();
        if trimmed.chars().count() > 120 {
            let prefix: String = trimmed.chars().take(117).collect();
            format!("{prefix}…")
        } else {
            trimmed.to_string()
        }
    };
    let s = match (tool, input) {
        ("Read", v) => format!(
            "Read {}",
            v.get("file_path")
                .or_else(|| v.get("path"))
                .and_then(|x| x.as_str())
                .unwrap_or("?")
        ),
        ("Write", v) => format!(
            "Write {}",
            v.get("file_path")
                .or_else(|| v.get("path"))
                .and_then(|x| x.as_str())
                .unwrap_or("?")
        ),
        ("Edit" | "StrReplace", v) => format!(
            "Edit {}",
            v.get("file_path")
                .or_else(|| v.get("path"))
                .and_then(|x| x.as_str())
                .unwrap_or("?")
        ),
        ("Bash" | "Shell", v) => format!(
            "$ {}",
            v.get("command").and_then(|x| x.as_str()).unwrap_or("?")
        ),
        (_, v) => match v {
            Value::Object(map) => {
                let keys: Vec<&str> = map.keys().take(3).map(|s| s.as_str()).collect();
                format!("{tool}({})", keys.join(", "))
            }
            _ => tool.to_string(),
        },
    };
    one_line(&s)
}

pub(crate) fn value_to_preview(v: &Value, max_bytes: usize) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|item| {
                item.as_object()
                    .and_then(|o| o.get("text"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    };
    cap_text(&s, max_bytes)
}

// ============================================================================
// tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codebuddy_user_message_string_content() {
        let line = r#"{"type":"message","role":"user","content":"please refactor","timestamp":1787294626109}"#;
        let evs = parse_line(1, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "message");
        assert_eq!(evs[0].payload["role"], "user");
        assert_eq!(evs[0].payload["text"], "please refactor");
        assert_eq!(evs[0].payload["timestamp_ms"], 1_787_294_626_109_i64);
    }

    #[test]
    fn codebuddy_assistant_message_array_content() {
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"sure thing"}]}"#;
        let evs = parse_line(1, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].payload["text"], "sure thing");
    }

    #[test]
    fn codebuddy_assistant_completed_does_not_emit_turn_finished() {
        // codebuddy 的 status=completed 是"这条 message 流完",不是"整轮 turn 结束"。
        // turn_finished 改由 hook_relay 的 Stop 事件触发,见 hook_relay.rs。
        let line = r#"{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}"#;
        let evs = parse_line(1, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "message");
    }

    #[test]
    fn codebuddy_skips_non_message_lines() {
        let line = r#"{"type":"ai-title","aiTitle":"x"}"#;
        let evs = parse_line(1, Backend::Codebuddy, line);
        assert!(evs.is_empty());
    }

    #[test]
    fn codebuddy_user_input_text_array_content() {
        // 真实 codebuddy 格式:user message 用 input_text 包裹
        let line = r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"查看下进展"}]}"#;
        let evs = parse_line(5, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "message");
        assert_eq!(evs[0].payload["role"], "user");
        assert_eq!(evs[0].payload["text"], "查看下进展");
    }

    #[test]
    fn codebuddy_assistant_output_text() {
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"我先看下"}]}"#;
        let evs = parse_line(5, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].payload["text"], "我先看下");
    }

    #[test]
    fn codebuddy_function_call_emits_tool_use() {
        let line = r#"{"type":"function_call","callId":"toolu_X","providerData":{"argumentsDisplayText":"ROADMAP.md"}}"#;
        let evs = parse_line(5, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "tool_use");
        assert_eq!(evs[0].payload["id"], "toolu_X");
        assert_eq!(evs[0].payload["input_summary"], "ROADMAP.md");
        assert_eq!(evs[0].payload["status"], "running");
    }

    #[test]
    fn codebuddy_function_call_result_for_ask_user_question_emits_attention_cleared() {
        // function_call 阶段已升级为 ask_user_question;
        // result 完成时应 emit session.attention_cleared 让前端消掉 banner,
        // 而不是 tool_use(那样会多出空卡片)。
        let line = r#"{"type":"function_call_result","callId":"toolu_q","name":"AskUserQuestion","status":"completed","output":{"type":"text","text":"a → b"}}"#;
        let evs = parse_line(20, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1, "expected exactly 1 event, got {evs:?}");
        assert_eq!(evs[0].r#type, "session.attention_cleared");
        assert_eq!(evs[0].payload["reason"], "ask_user_question_completed");
    }

    #[test]
    fn codebuddy_function_call_result_emits_tool_use_ok() {
        let line = r#"{"type":"function_call_result","callId":"toolu_X","name":"Read","status":"completed","output":{"type":"text","text":"file contents..."}}"#;
        let evs = parse_line(5, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "tool_use");
        assert_eq!(evs[0].payload["id"], "toolu_X");
        assert_eq!(evs[0].payload["tool"], "Read");
        assert_eq!(evs[0].payload["status"], "ok");
        assert!(evs[0].payload["output_preview"]
            .as_str()
            .unwrap()
            .contains("file contents"));
    }

    #[test]
    fn claude_user_string_content_emits_message() {
        let line = r#"{"type":"user","timestamp":"2026-07-22T09:14:00.649Z","message":{"role":"user","content":"hi there"}}"#;
        let evs = parse_line(2, Backend::Claude, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].payload["role"], "user");
        assert_eq!(evs[0].payload["text"], "hi there");
        assert_eq!(evs[0].payload["timestamp_ms"], 1_784_711_640_649_i64);
    }

    #[test]
    fn claude_user_command_caveat_skipped() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<command-name>/x</command-name>"}}"#;
        let evs = parse_line(2, Backend::Claude, line);
        assert!(evs.is_empty(), "command-prefixed user should be skipped");
    }

    #[test]
    fn claude_assistant_with_text_and_tool_use() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":"reading the file"},
            {"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/tmp/x.rs"}}
        ]}}"#;
        let evs = parse_line(3, Backend::Claude, line);
        assert_eq!(evs.len(), 2, "should produce message + tool_use");
        assert_eq!(evs[0].r#type, "message");
        assert_eq!(evs[0].payload["text"], "reading the file");
        assert_eq!(evs[1].r#type, "tool_use");
        assert_eq!(evs[1].payload["tool"], "Read");
        assert_eq!(evs[1].payload["input_summary"], "Read /tmp/x.rs");
        assert_eq!(evs[1].payload["status"], "running");
        assert_eq!(evs[1].payload["id"], "tu_1");
    }

    #[test]
    fn claude_end_turn_emits_turn_finished() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[
            {"type":"text","text":"all set"}
        ]}}"#;
        let evs = parse_line(3, Backend::Claude, line);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].r#type, "message");
        assert_eq!(evs[1].r#type, "session.turn_finished");
        assert_eq!(evs[1].payload["summary"], "all set");
    }

    #[test]
    fn claude_user_tool_result_emits_tool_use_ok_status() {
        let line = r#"{"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"tu_1","content":"file contents..."}
        ]}}"#;
        let evs = parse_line(3, Backend::Claude, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "tool_use");
        assert_eq!(evs[0].payload["id"], "tu_1");
        assert_eq!(evs[0].payload["status"], "ok");
        assert!(evs[0].payload["output_preview"]
            .as_str()
            .unwrap()
            .contains("file contents"));
    }

    #[test]
    fn claude_user_tool_result_with_error_flag() {
        let line = r#"{"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"tu_2","content":"bash: not found","is_error":true}
        ]}}"#;
        let evs = parse_line(3, Backend::Claude, line);
        assert_eq!(evs[0].payload["status"], "error");
    }

    #[test]
    fn malformed_lines_dont_panic() {
        assert!(parse_line(1, Backend::Codebuddy, "not json").is_empty());
        assert!(parse_line(1, Backend::Claude, "{}").is_empty());
    }

    #[test]
    fn claude_ask_user_question_emits_dedicated_event() {
        // 真实 jsonl 格式:tool_use name=AskUserQuestion + input.questions[]
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"tu_q1","name":"AskUserQuestion","input":{
                "questions":[{
                    "question":"Which approach?",
                    "header":"Approach",
                    "multiSelect":false,
                    "options":[
                        {"label":"OAuth","description":"..."},
                        {"label":"JWT","description":"..."}
                    ]
                }]
            }}
        ]}}"#;
        let evs = parse_line(7, Backend::Claude, line);
        // 应该 emit 1 个 ask_user_question(no plain tool_use)
        let q_events: Vec<_> = evs
            .iter()
            .filter(|e| e.r#type == "ask_user_question")
            .collect();
        assert_eq!(q_events.len(), 1);
        let p = &q_events[0].payload;
        assert_eq!(p["question"], "Which approach?");
        assert_eq!(p["header"], "Approach");
        assert_eq!(p["multi_select"], false);
        assert_eq!(p["options"].as_array().unwrap().len(), 2);
        assert!(p["question_id"].as_str().unwrap().starts_with("tu_q1"));
        // 不应当再 emit 一个 generic tool_use(避免重复)
        assert!(evs.iter().all(|e| e.r#type != "tool_use"));
    }

    #[test]
    fn claude_exit_plan_mode_emits_plan_proposed() {
        // 用普通 string + escape,避免 raw string 跟 ## 冲突
        let line = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[\
            {\"type\":\"tool_use\",\"id\":\"tu_p1\",\"name\":\"ExitPlanMode\",\"input\":{\
                \"plan\":\"## Plan\\n- step 1\\n- step 2\"\
            }}\
        ]}}";
        let evs = parse_line(8, Backend::Claude, line);
        let plans: Vec<_> = evs.iter().filter(|e| e.r#type == "plan_proposed").collect();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].payload["plan_id"], "tu_p1");
        assert!(plans[0].payload["plan_md"]
            .as_str()
            .unwrap()
            .contains("step 1"));
    }

    #[test]
    fn claude_task_create_and_update() {
        let create_line = r#"{"type":"assistant","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"tu_t1","name":"TaskCreate","input":{
                "subject":"run tests","description":"all the things"
            }}
        ]}}"#;
        let evs = parse_line(9, Backend::Claude, create_line);
        let creates: Vec<_> = evs.iter().filter(|e| e.r#type == "task_create").collect();
        assert_eq!(creates.len(), 1);
        assert_eq!(creates[0].payload["subject"], "run tests");
        assert_eq!(creates[0].payload["status"], "pending");

        let update_line = r#"{"type":"assistant","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"tu_t2","name":"TaskUpdate","input":{
                "taskId":"123","status":"completed"
            }}
        ]}}"#;
        let evs = parse_line(9, Backend::Claude, update_line);
        let updates: Vec<_> = evs.iter().filter(|e| e.r#type == "task_update").collect();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].payload["id"], "123");
        assert_eq!(updates[0].payload["status"], "completed");
    }

    #[test]
    fn codebuddy_ask_user_question_emits_dedicated_event() {
        // codebuddy 真实格式:type=function_call, name=AskUserQuestion,
        // arguments 是 JSON 字符串
        let line = r#"{"type":"function_call","callId":"toolu_q","name":"AskUserQuestion","arguments":"{\"questions\":[{\"question\":\"用什么栈?\",\"header\":\"栈\",\"multiSelect\":false,\"options\":[{\"label\":\"Rust\",\"description\":\"...\"},{\"label\":\"Go\",\"description\":\"...\"}]}]}"}"#;
        let evs = parse_line(11, Backend::Codebuddy, line);
        let qs: Vec<_> = evs
            .iter()
            .filter(|e| e.r#type == "ask_user_question")
            .collect();
        assert_eq!(qs.len(), 1, "should emit 1 ask_user_question, got {evs:?}");
        assert_eq!(qs[0].payload["question"], "用什么栈?");
        assert_eq!(qs[0].payload["header"], "栈");
        assert_eq!(qs[0].payload["multi_select"], false);
        assert_eq!(qs[0].payload["options"].as_array().unwrap().len(), 2);
        assert!(qs[0].payload["question_id"]
            .as_str()
            .unwrap()
            .starts_with("toolu_q"));
        // 不再 emit 普通 tool_use(避免在 Flutter 上同时显示卡片 + 选择题)
        assert!(evs.iter().all(|e| e.r#type != "tool_use"));
    }

    #[test]
    fn codebuddy_exit_plan_mode_uses_provider_data_tool_result() {
        // codebuddy ExitPlanMode 的 arguments 是空 {},plan 全文藏在 providerData.toolResult.content
        let line = "{\"type\":\"function_call\",\"callId\":\"toolu_p\",\"name\":\"ExitPlanMode\",\"arguments\":\"{}\",\"providerData\":{\"toolResult\":{\"content\":\"# Plan\\n- step 1\\n- step 2\"}}}";
        let evs = parse_line(12, Backend::Codebuddy, line);
        let plans: Vec<_> = evs.iter().filter(|e| e.r#type == "plan_proposed").collect();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].payload["plan_id"], "toolu_p");
        let md = plans[0].payload["plan_md"].as_str().unwrap();
        assert!(md.contains("step 1"), "plan_md missing content: {md}");
    }

    #[test]
    fn codebuddy_task_create_extracts_from_arguments_string() {
        let line = r#"{"type":"function_call","callId":"toolu_t1","name":"TaskCreate","arguments":"{\"subject\":\"build it\",\"description\":\"all the things\"}"}"#;
        let evs = parse_line(13, Backend::Codebuddy, line);
        let creates: Vec<_> = evs.iter().filter(|e| e.r#type == "task_create").collect();
        assert_eq!(creates.len(), 1);
        assert_eq!(creates[0].payload["subject"], "build it");
        assert_eq!(creates[0].payload["status"], "pending");
        assert_eq!(creates[0].payload["id"], "toolu_t1");
    }

    #[test]
    fn codebuddy_task_update_extracts_task_id() {
        let line = r#"{"type":"function_call","callId":"toolu_t2","name":"TaskUpdate","arguments":"{\"taskId\":\"7\",\"status\":\"in_progress\"}"}"#;
        let evs = parse_line(14, Backend::Codebuddy, line);
        let updates: Vec<_> = evs.iter().filter(|e| e.r#type == "task_update").collect();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].payload["id"], "7");
        assert_eq!(updates[0].payload["status"], "in_progress");
    }

    #[test]
    fn codebuddy_generic_function_call_still_uses_display_text() {
        // 非协议级特判工具,继续走普通 tool_use 路径
        let line = r#"{"type":"function_call","callId":"toolu_R","name":"Read","arguments":"{\"file_path\":\"/tmp/x.rs\"}","providerData":{"argumentsDisplayText":"/tmp/x.rs"}}"#;
        let evs = parse_line(15, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "tool_use");
        assert_eq!(evs[0].payload["tool"], "Read");
        assert_eq!(evs[0].payload["input_summary"], "/tmp/x.rs");
    }

    #[test]
    fn codex_task_complete_emits_turn_finished() {
        let line = r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn_1","duration_ms":1234,"last_agent_message":"fixed it"}}"#;
        let evs = parse_line(16, Backend::Codex, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "session.turn_finished");
        assert_eq!(evs[0].payload["status"], "completed");
        assert_eq!(evs[0].payload["summary"], "fixed it");
        assert_eq!(evs[0].payload["duration_ms"], 1234);
        assert_eq!(evs[0].payload["turn_id"], "turn_1");
    }

    #[test]
    fn codex_response_item_user_message_emits_message() {
        let line = r#"{"timestamp":"2026-08-19T10:53:04.194Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"为什么 mobile 详情没有消息"}]}}"#;
        let evs = parse_line(17, Backend::Codex, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "message");
        assert_eq!(evs[0].payload["role"], "user");
        assert_eq!(evs[0].payload["text"], "为什么 mobile 详情没有消息");
        assert_eq!(evs[0].payload["timestamp_ms"], 1_787_136_784_194_i64);
    }

    #[test]
    fn codex_response_item_assistant_message_emits_message() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"我会检查 bridge semantic parser。"}]}}"#;
        let evs = parse_line(18, Backend::Codex, line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "message");
        assert_eq!(evs[0].payload["role"], "assistant");
        assert_eq!(evs[0].payload["text"], "我会检查 bridge semantic parser。");
    }

    #[test]
    fn cursor_user_message_extracts_user_query_wrapper() {
        let line = r#"{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Wed</timestamp>\n<user_query>\n同步这个内容\n</user_query>"}]}}"#;
        let events = parse_line(20, Backend::Cursor, line);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].r#type, "message");
        assert_eq!(events[0].payload["role"], "user");
        assert_eq!(events[0].payload["text"], "同步这个内容");
        assert!(events[0].payload["timestamp_ms"].is_null());
    }

    #[test]
    fn cursor_assistant_message_and_tool_are_semantic_events() {
        let line = r#"{"role":"assistant","message":{"content":[{"type":"text","text":"我来检查"},{"type":"tool_use","name":"Read","input":{"path":"/tmp/a.rs"}}]}}"#;
        let events = parse_line(21, Backend::Cursor, line);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].r#type, "message");
        assert_eq!(events[0].payload["text"], "我来检查");
        assert_eq!(events[1].r#type, "tool_use");
        assert_eq!(events[1].payload["input_summary"], "Read /tmp/a.rs");
    }

    #[test]
    fn cursor_turn_ended_emits_turn_finished() {
        let events = parse_line(
            22,
            Backend::Cursor,
            r#"{"type":"turn_ended","status":"success"}"#,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].r#type, "session.turn_finished");
        assert_eq!(events[0].payload["status"], "completed");
    }

    #[test]
    fn codex_injected_startup_context_is_skipped() {
        let line = r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/p\n\n<INSTRUCTIONS>...</INSTRUCTIONS>"}]}}"##;
        let evs = parse_line(19, Backend::Codex, line);
        assert!(evs.is_empty());
    }

    #[test]
    fn cap_text_handles_unicode_boundary() {
        // 中文 3 字节,确保截断不破坏 UTF-8
        let s = "abc中文中文中文";
        let out = cap_text(s, 5);
        assert!(out.is_char_boundary(out.len() - "\n…[truncated]".len()));
    }

    #[test]
    fn summarize_bash_command() {
        let v = json!({"command": "ls -la /tmp"});
        assert_eq!(summarize_tool_input("Bash", &v), "$ ls -la /tmp");
    }

    #[test]
    fn summarize_unknown_tool_lists_keys() {
        let v = json!({"foo": 1, "bar": 2});
        let s = summarize_tool_input("MyCustom", &v);
        assert!(s.starts_with("MyCustom("));
        assert!(s.contains("foo"));
    }

    #[tokio::test]
    async fn tail_publishes_codebuddy_intake_result_to_history() {
        let path = std::env::temp_dir().join(format!(
            "kode-semantic-{}.jsonl",
            uuid::Uuid::new_v4().simple()
        ));
        let line = serde_json::json!({
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": "<SPECOPS_DOCUMENT>\n{\"classification\":\"feature\"}\n</SPECOPS_DOCUMENT>"
            }]
        });
        tokio::fs::write(&path, format!("{line}\n")).await.unwrap();

        let bus = Arc::new(BridgeBus::new());
        let task = tokio::spawn(run(42, Backend::Codebuddy, path.clone(), Arc::clone(&bus)));
        let events = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let events = bus.history_for(42, 0, 10);
                if !events.is_empty() {
                    break events;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("semantic tail did not publish history");

        task.abort();
        let _ = tokio::fs::remove_file(path).await;
        assert_eq!(events[0].r#type, "message");
        assert_eq!(events[0].payload["role"], "assistant");
        assert!(events[0].payload["text"]
            .as_str()
            .unwrap()
            .contains("<SPECOPS_DOCUMENT>"));
    }

    // ============ ExitPlanMode result 熄灭测试 ============

    #[test]
    fn exit_plan_result_approved_emits_attention_cleared() {
        // 批准:status=completed, output.text 以 "User has approved" 开头
        let line = r#"{"type":"function_call_result","callId":"toolu_p","name":"ExitPlanMode","status":"completed","output":{"type":"text","text":"User has approved your plan. You can now start coding."}}"#;
        let evs = parse_line(30, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1, "expected exactly 1 event");
        assert_eq!(evs[0].r#type, "session.attention_cleared");
        assert_eq!(evs[0].payload["reason"], "plan_resolved");
    }

    #[test]
    fn exit_plan_result_rejected_emits_attention_cleared() {
        // 拒绝:status=incomplete, output.text 以 "The user doesn't want" 开头
        let line = r#"{"type":"function_call_result","callId":"toolu_p","name":"ExitPlanMode","status":"incomplete","output":{"type":"text","text":"The user doesn't want to proceed with this plan yet. They want to keep planning."}}"#;
        let evs = parse_line(31, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1, "expected exactly 1 event");
        assert_eq!(evs[0].r#type, "session.attention_cleared");
        assert_eq!(evs[0].payload["reason"], "plan_resolved");
    }

    #[test]
    fn exit_plan_result_subagent_emits_attention_cleared() {
        // 子 agent 误调 ExitPlanMode:status=completed, 但 output.text 以子 agent 拒绝信息开头
        let line = r#"{"type":"function_call_result","callId":"toolu_p","name":"ExitPlanMode","status":"completed","output":{"type":"text","text":"ExitPlanMode is not available to sub-agents. Plan mode is owned by the main agent."}}"#;
        let evs = parse_line(32, Backend::Codebuddy, line);
        assert_eq!(evs.len(), 1, "expected exactly 1 event");
        assert_eq!(evs[0].r#type, "session.attention_cleared");
        assert_eq!(evs[0].payload["reason"], "plan_subagent_noise");
    }
}
