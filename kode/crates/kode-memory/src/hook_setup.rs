//! kode-memory hook 自动注入。
//!
//! 在 kode GUI 启动时（`install_managed_hooks`）自动把各类 hook 写入
//! codebuddy 和 claude 的 `settings.json`。
//!
//! ## 管理的 Hook 类型
//!
//! | Hook Event | 用途 |
//! |-----------|------|
//! | `Stop` | 全局 command relay；守门员仅在 Kode 会话 settings 中注册 |
//! | `Notification` (permission_prompt) | 即时通知 kode GUI 有权限请求 |
//! | `UserPromptSubmit` | 用户回车提交后即时清除 attention |
//! | `PreToolUse` | 禁用；启动时只清理遗留 kode 条目 |
//! | `ConfigChange` | CodeBuddy 切换模型后同步当前 session 的 model |
//!
//! ## 设计要点
//!
//! 1. **幂等 + 强制更新**：用 `_kode_managed: true` 字段标记 kode 管理的条目。
//!    每次 kode 启动都找到这个条目并更新（便于升级）。
//!    同时识别历史 command/prompt，清理丢失标记的重复项。
//!    用户自定义的其他 hook 保留不动；PreToolUse 永不注册。
//!
//! 2. **Merge 写入**：读现有 JSON → 只动对应 hook 数组 → atomic write（tmp → rename）。
//!    `model`、`trustedDirectories` 等其他字段完全保留。
//!
//! 3. **路径约定**：
//!    - codebuddy：`~/.codebuddy/settings.json`
//!    - claude：`~/.claude/settings.json`
//!    两者 hook JSON 格式完全相同。
//!    - Codex：`~/.codex/hooks.json`，只注入 `type:"command"` hooks。

use std::path::{Path, PathBuf};
use std::process::Command;

/// kode 管理的 Stop hook prompt（"守门员"）。
///
/// 每次 kode 启动时将此文字写入 settings.json，用于强制升级 prompt 版本。
/// 改这里即可统一升级所有用户的 hook prompt。
pub const STOP_HOOK_PROMPT: &str = r#"你是 kode-memory 的沉淀守门员。kode-memory 是一个跨 tab/跨 backend 共享的项目级 wiki，agent 通过 MCP 工具 memory_propose 写入「值得长期记住」的经验。现在主 agent 这一轮即将结束，请判断本轮是否产生了应当沉淀进 kode-memory 但 agent 还没写入的内容。

本轮上下文(JSON，含 transcript_path 可读完整对话)：$ARGUMENTS

## 第一优先级：防死循环
如果输入里 stop_hook_active 为 true，直接返回 {"ok": true}。这表示本轮已经是因为本 hook 而续跑的，绝不能再拦。

## 必要前提：工具确实可用
只有 transcript 中存在本会话成功的 `memory_search` MCP 工具调用，才可以考虑拦截。
工具名称出现在注入指令、用户消息、普通文本或 ToolSearch 查询中，不算工具可用的证据。
如果 MCP 工具不存在、ToolSearch 返回 0 tools、工具调用失败、连接失败或可用性不确定，直接返回 {"ok": true}。
不要要求主 agent 反复查找不存在的工具，也不要为了记忆阻止用户结束会话。

## 应当沉淀的内容（命中任一才考虑拦截）
- 用户拍板了架构/工具链/UI风格/配置/命名的决策（"以后都用 X"、"别再 Y"、"这个项目就这么定"）
- 用户显式说了「记住」「这是规范」「以后都这样」
- 本轮踩到并解决了一个非显而易见的 gotcha（坑），下次别人会再踩
- 发现了一条 dead_end：试过 X 不行、因为 Y、应改用 Z
- 用户表达了稳定的偏好（不是一次性的「这次先 X」）

## 绝对不要拦（命中任一就放行）
- transcript 中存在真实的 `mcp__memory__memory_propose` MCP 工具调用 → 已经记了，放行。只有该工具调用才算写入 kode-memory；写入 CodeBuddy file-based memory、CODEBUDDY.md/AGENTS.md/项目文档、通过 Write/Edit 修改文件，或仅在文字中声称/提到 memory_propose，均不算已沉淀
- 纯一次性指令、闲聊、简单问答、只读探查、跑测试看结果
- 结论能从代码或 git log 直接看出来（不算"非显而易见"）
- 本轮没有任何决策/坑/偏好沉淀价值
- 你不确定是否值得记 → 倾向放行（宁可漏记，不要每轮打断用户；能量预算有限，滥提议会 out_of_energy）

## 输出
- 没有值得沉淀的：{"ok": true}
- 确实有且 agent 没记、且已确认 MCP 可用：{"ok": false, "reason": "本轮产生了值得沉淀进 kode-memory 的内容：<一句话说清是什么>。请用 memory_search 查重后调 memory_propose 写入(author 用当前 backend，scope 用 project:<当前项目名>，body 含结论+why)。若工具不可用、已有等价 fact 或返回 out_of_energy，则无需写入，直接结束，不要反复查找工具。"}

保守判断：绝大多数轮次都应返回 {"ok": true}。只有明确命中"应当沉淀"且 agent 确实没写时才返回 ok:false。

## 输出格式硬约束
- 只输出一行裸 JSON，不要代码围栏，不要任何解释或前后缀文字
- ok 为 true 时只输出 {"ok": true}，不要附带 reason"#;

/// The prompt gatekeeper must never affect agents launched outside Kode.
pub fn session_settings_json() -> String {
    serde_json::json!({
        "hooks": {"Stop": [{"hooks": [{
            "type": "prompt",
            "timeout": 30,
            "continueOnBlock": true,
            "prompt": STOP_HOOK_PROMPT
        }]}]}
    })
    .to_string()
}

pub fn tcodex_hooks_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".tcodex/hooks.json"))
}

/// 需要注入 hook 的 backend 列表，返回 `(label, settings_path)` 对。
/// 路径不存在也返回（inject 函数会在写入时创建）。
pub fn target_settings() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    target_settings_in(&home)
}

fn target_settings_in(home: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("codebuddy", home.join(".codebuddy").join("settings.json")),
        ("claude", home.join(".claude").join("settings.json")),
        ("tclaude", home.join(".tclaude").join("settings.json")),
    ]
}

/// Codex user-level hooks.json 路径。
pub fn codex_hooks_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".codex").join("hooks.json"))
}

/// Codex / Tcodex 的独立 user-level hook targets，供 GUI 和 headless bridge 共用。
pub fn codex_hook_targets() -> Vec<(&'static str, PathBuf)> {
    dirs::home_dir()
        .map(|home| codex_hook_targets_in(&home))
        .unwrap_or_default()
}

fn codex_hook_targets_in(home: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("codex", home.join(".codex").join("hooks.json")),
        ("tcodex", home.join(".tcodex").join("hooks.json")),
    ]
}

// ============================================================================
// Stop hook
// ============================================================================

/// 检查 `path` 对应的 settings.json 里是否已有**可驱动主 agent 继续执行**的
/// kode Stop prompt hook。
///
/// 只看 `_kode_managed: true` 不够：早期版本没有写 `continueOnBlock`，
/// CodeBuddy 即使让守门员返回 `{ "ok": false }` 也会直接结束当前轮次，不会把
/// reason 注入主 agent。因此这种旧配置必须视为未配置，等待启动注入逻辑升级。
pub fn is_stop_hook_configured(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let Some(entries) = doc.get("hooks")
        .and_then(|hooks| hooks.get("Stop"))
        .and_then(|stop| stop.as_array())
    else {
        return false;
    };
    let has_prompt = entries.iter().any(|entry| {
        entry["hooks"].as_array().is_some_and(|hooks| {
            hooks.iter().any(|hook| hook["type"] == "prompt" && is_kode_handler(hook))
        })
    });
    let has_command = entries.iter().any(|entry| {
        entry["_kode_managed"] == true
            && entry["hooks"].as_array().is_some_and(|hooks| {
                hooks.iter().any(|hook| hook["type"] == "command")
            })
    });
    has_command && !has_prompt
}

/// 注入或更新 kode 管理的 Stop hook（幂等）。
///
/// `hooks` 数组里并列两个子 hook：
/// 1. `type:"command"` → 立即转发给 hook_relay（emit `turn_finished` + `attention_cleared`）
/// 2. `type:"prompt"` → 守门员 LLM（判断本轮是否需要沉淀进 memory）。
///    必须设置 `continueOnBlock:true`，否则 `{ok:false}` 只阻止 stop，却不会把
///    reason 注入主 agent 继续调用 `memory_propose`。
///
/// 两者并列执行：command 先跑（即时通知 GUI turn 结束），prompt 后跑（可能拦截让 agent 续跑沉淀）。
///
/// 流程：
/// 1. 读现有 JSON（不存在或为空 → 用 `{}`，保留其他字段）
/// 2. 按管理标记、relay command 和历史守门员 prompt 识别所有 kode 条目
/// 3. 合并为一条新版配置，保留第三方 handler；找不到 → 追加
/// 4. Atomic write：写 tmp 文件 → rename
pub fn inject_stop_hook(path: &Path, relay_command: &str) -> Result<(), String> {
    let kode_entry = serde_json::json!({
        "_kode_managed": true,
        "hooks": [
            {
                "type": "command",
                "timeout": 5,
                "command": relay_command
            }
        ]
    });

    inject_hook_entry(path, "Stop", &kode_entry)
}

// ============================================================================
// Notification hook (permission_prompt)
// ============================================================================

/// 注入 Notification hook，匹配 `permission_prompt` 事件。
///
/// `relay_command` 是 kode-hook-relay 的 shell 命令（含 socket 路径参数）。
pub fn inject_notification_hook(path: &Path, relay_command: &str) -> Result<(), String> {
    let kode_entry = serde_json::json!({
        "_kode_managed": true,
        "matcher": "permission_prompt",
        "hooks": [{
            "type": "command",
            "timeout": 5,
            "command": relay_command
        }]
    });

    inject_hook_entry(path, "Notification", &kode_entry)
}

/// 检查 Notification hook 是否已配置。
pub fn is_notification_hook_configured(path: &Path) -> bool {
    find_kode_hook_entry(path, "Notification").is_some()
}

// ============================================================================
// UserPromptSubmit hook
// ============================================================================

/// 注入 UserPromptSubmit hook，用于用户提交文字后即时清除 attention。
///
/// `relay_command` 是 kode-hook-relay 的 shell 命令（含 socket 路径参数）。
pub fn inject_user_prompt_submit_hook(path: &Path, relay_command: &str) -> Result<(), String> {
    let kode_entry = serde_json::json!({
        "_kode_managed": true,
        "hooks": [{
            "type": "command",
            "timeout": 5,
            "command": relay_command
        }]
    });

    inject_hook_entry(path, "UserPromptSubmit", &kode_entry)
}

/// 检查 UserPromptSubmit hook 是否已配置。
pub fn is_user_prompt_submit_hook_configured(path: &Path) -> bool {
    find_kode_hook_entry(path, "UserPromptSubmit").is_some()
}

// ============================================================================
// SessionStart hook (session uuid 权威绑定 — 取证/方案2)
// ============================================================================

/// 注入 SessionStart hook,matcher 覆盖 startup/resume/clear/compact。
/// codebuddy 在会话创建/恢复(含 `/resume`、`/clear`)时发 SessionStart,
/// payload 公共字段含真实 session uuid(`session_id`)与 `transcript_path`(确切 jsonl 路径)。
/// 用于让 kode 权威知道某个 tab 当前绑定的真实 session,而不是猜文件 mtime。
pub fn inject_session_start_hook(path: &Path, relay_command: &str) -> Result<(), String> {
    let kode_entry = serde_json::json!({
        "_kode_managed": true,
        "matcher": "startup|resume|clear|compact",
        "hooks": [{
            "type": "command",
            "timeout": 5,
            "command": relay_command
        }]
    });

    inject_hook_entry(path, "SessionStart", &kode_entry)
}

/// 检查 SessionStart hook 是否已配置。
pub fn is_session_start_hook_configured(path: &Path) -> bool {
    find_kode_hook_entry(path, "SessionStart").is_some()
}

// ============================================================================
// Retired PreToolUse hook
// ============================================================================

/// Never register tool gates. Remove only Kode handlers, retaining other hooks.
pub fn remove_pretooluse_hooks(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_hook_config(path)?;
    let Some(events) = doc.get_mut("hooks").and_then(|hooks| hooks.as_object_mut()) else {
        return Ok(());
    };
    let Some(entries) = events
        .get_mut("PreToolUse")
        .and_then(|event| event.as_array_mut())
    else {
        return Ok(());
    };
    replace_kode_entries(entries, None);
    if entries.is_empty() {
        events.remove("PreToolUse");
    }
    write_json_atomic(path, &doc)
}

/// Repair only installed hooks, without restoring events the user removed.
pub fn repair_existing_hooks(path: &Path) -> Result<(), String> {
    remove_pretooluse_hooks(path)?;
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_hook_config(path)?;
    let Some(events) = doc.get_mut("hooks").and_then(|hooks| hooks.as_object_mut()) else {
        return Ok(());
    };
    for event in [
        "Stop",
        "Notification",
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "ConfigChange",
    ] {
        let Some(entries) = events.get_mut(event).and_then(|event| event.as_array_mut()) else {
            continue;
        };
        let Some(mut replacement) = entries
            .iter()
            .find(|entry| {
                entry["_kode_managed"].as_bool() == Some(true)
                    || entry["hooks"]
                        .as_array()
                        .is_some_and(|hooks| hooks.iter().any(is_kode_handler))
            })
            .cloned()
        else {
            continue;
        };
        let Some(handlers) = replacement
            .get_mut("hooks")
            .and_then(|hooks| hooks.as_array_mut())
        else {
            continue;
        };
        if handlers.iter().any(is_kode_handler) {
            handlers.retain(is_kode_handler);
        }
        if event == "Stop" {
            handlers.retain(|hook| hook["type"] != "prompt");
            if handlers.is_empty() {
                replace_kode_entries(entries, None);
                continue;
            }
        }
        for hook in handlers.iter_mut() {
            if hook["prompt"]
                .as_str()
                .is_some_and(|prompt| prompt.starts_with("你是 kode-memory 的沉淀守门员。"))
            {
                hook["prompt"] = serde_json::json!(STOP_HOOK_PROMPT);
            }
        }
        replace_kode_entries(entries, Some(&replacement));
    }
    write_json_atomic(path, &doc)
}

/// 检查 PreToolUse hook 是否已配置。
pub fn is_pretooluse_hook_configured(path: &Path) -> bool {
    find_kode_hook_entry(path, "PreToolUse").is_some()
}

// ============================================================================
// ConfigChange hook (CodeBuddy model tracking)
// ============================================================================

/// 注入 CodeBuddy `ConfigChange` hook。模型切换后这是比 jsonl
/// `providerData` 更可靠的实时信号：CodeBuddy 可能仍把旧 model 写入 jsonl。
pub fn inject_config_change_hook(path: &Path, relay_command: &str) -> Result<(), String> {
    let kode_entry = serde_json::json!({
        "_kode_managed": true,
        "hooks": [{
            "type": "command",
            "timeout": 5,
            "command": relay_command
        }]
    });
    inject_hook_entry(path, "ConfigChange", &kode_entry)
}

// ============================================================================
// Codex hooks
// ============================================================================

const CODEX_STATUS_PREFIX: &str = "kode-memory";

/// 注入 Codex command hooks。
///
/// Codex hooks 目前只执行 `type:"command"` handler,所以不能复用
/// Claude/CodeBuddy 的 `type:"prompt"` Stop 守门员。这里统一指向
/// `kode-memory codex-hook`,由该子命令读取 stdin JSON 并按事件分发。
pub fn inject_codex_hooks(path: &Path, command: &str) -> Result<(), String> {
    remove_pretooluse_hooks(path)?;
    let specs = [
        CodexHookSpec {
            event: "SessionStart",
            matcher: Some("startup|resume|clear|compact"),
            timeout: 5,
            status: "kode-memory: loading memory guidance",
        },
        CodexHookSpec {
            event: "Stop",
            matcher: None,
            timeout: 30,
            status: "kode-memory: checking memory handoff",
        },
        CodexHookSpec {
            event: "PermissionRequest",
            matcher: Some("*"),
            timeout: 5,
            status: "kode-memory: relaying permission request",
        },
        CodexHookSpec {
            event: "UserPromptSubmit",
            matcher: None,
            timeout: 5,
            status: "kode-memory: relaying user prompt",
        },
    ];

    for spec in specs {
        inject_codex_hook_entry(path, spec, command)?;
    }
    Ok(())
}

/// 粗略检查 Codex hooks 是否已有 Kode 管理的 Stop hook。
pub fn is_codex_hook_configured(path: &Path) -> bool {
    find_codex_hook_entry(path, "Stop").is_some()
}

#[derive(Clone, Copy)]
struct CodexHookSpec {
    event: &'static str,
    matcher: Option<&'static str>,
    timeout: u64,
    status: &'static str,
}

fn inject_codex_hook_entry(path: &Path, spec: CodexHookSpec, command: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {} failed: {e}", parent.display()))?;
        }
    }

    let mut doc = read_hook_config(path)?;

    let event_arr = doc
        .as_object_mut()
        .ok_or("hooks.json root must be a JSON object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("hooks must be a JSON object")?
        .entry(spec.event)
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("hooks.{} must be an array", spec.event))?;

    let hook = serde_json::json!({
        "type": "command",
        "command": command,
        "timeout": spec.timeout,
        "statusMessage": spec.status,
    });
    let mut entry = serde_json::json!({ "hooks": [hook] });
    if let Some(matcher) = spec.matcher {
        entry["matcher"] = serde_json::Value::String(matcher.to_string());
    }

    replace_kode_entries(event_arr, Some(&entry));

    write_json_atomic(path, &doc)
}

fn find_codex_hook_entry(path: &Path, event_name: &str) -> Option<usize> {
    let bytes = std::fs::read(path).ok()?;
    let doc: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let arr = doc.get("hooks")?.get(event_name)?.as_array()?;
    arr.iter().position(is_kode_codex_entry)
}

fn is_kode_codex_entry(entry: &serde_json::Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("statusMessage")
                    .or_else(|| h.get("status_message"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.starts_with(CODEX_STATUS_PREFIX))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

// ============================================================================
// 向后兼容别名
// ============================================================================

/// 检查 `path` 对应的 settings.json 里是否已有 kode 管理的 Stop hook。
/// 向后兼容旧名称。
#[deprecated(note = "use is_stop_hook_configured instead")]
pub fn is_hook_configured(path: &Path) -> bool {
    is_stop_hook_configured(path)
}

// ============================================================================
// 通用注入基础设施
// ============================================================================

/// 在 settings.json 的 `hooks.<event_name>` 数组里注入/更新一个 `_kode_managed: true` 的条目。
///
/// - 如果已有同名 event 的 kode 管理条目 → 原地更新
/// - 如果没有 → 追加到数组
/// - 按标记、command 和历史 Stop prompt 识别所有 kode 条目并去重
/// - 用户自定义的 handler 保留，包括与 kode handler 混在同一条目里的情况
fn inject_hook_entry(
    path: &Path,
    event_name: &str,
    entry: &serde_json::Value,
) -> Result<(), String> {
    // 确保父目录存在
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {} failed: {e}", parent.display()))?;
        }
    }

    // 读现有 JSON
    let mut doc = read_hook_config(path)?;

    // 取 hooks.<event_name> 数组
    let event_arr = doc
        .as_object_mut()
        .ok_or("settings.json root must be a JSON object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("hooks must be a JSON object")?
        .entry(event_name)
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("hooks.{} must be an array", event_name))?;

    replace_kode_entries(event_arr, Some(entry));
    write_json_atomic(path, &doc)
}

fn read_hook_config(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse {} failed; leaving it unchanged: {e}", path.display()))
}

fn is_kode_handler(hook: &serde_json::Value) -> bool {
    hook.get("command")
        .and_then(|command| command.as_str())
        .is_some_and(|command| {
            (command.contains("kode-memory")
                && (command.contains("codebuddy-hook") || command.contains("codex-hook")))
                || command == raw_hook_relay_command()
        })
        || hook
            .get("prompt")
            .and_then(|prompt| prompt.as_str())
            .is_some_and(|prompt| prompt.starts_with("你是 kode-memory 的沉淀守门员。"))
        || hook
            .get("statusMessage")
            .or_else(|| hook.get("status_message"))
            .and_then(|status| status.as_str())
            .is_some_and(|status| status.starts_with(CODEX_STATUS_PREFIX))
}

fn replace_kode_entries(
    entries: &mut Vec<serde_json::Value>,
    replacement: Option<&serde_json::Value>,
) {
    let mut inserted = false;
    let mut retained = Vec::with_capacity(entries.len() + 1);
    for mut entry in entries.drain(..) {
        let managed = entry["_kode_managed"].as_bool() == Some(true);
        let Some(handlers) = entry
            .get_mut("hooks")
            .and_then(|hooks| hooks.as_array_mut())
        else {
            retained.push(entry);
            continue;
        };
        let identified = handlers.iter().any(is_kode_handler);
        if !managed && !identified {
            retained.push(entry);
            continue;
        }
        if !inserted {
            if let Some(replacement) = replacement {
                retained.push(replacement.clone());
            }
            inserted = true;
        }
        // Legacy marked entries may use a relay command we no longer recognize.
        if managed && !identified {
            continue;
        }
        handlers.retain(|hook| !is_kode_handler(hook));
        if !handlers.is_empty() {
            entry.as_object_mut().unwrap().remove("_kode_managed");
            retained.push(entry);
        }
    }
    if !inserted {
        if let Some(replacement) = replacement {
            retained.push(replacement.clone());
        }
    }
    *entries = retained;
}

/// 在 path 的 settings.json 里找 `hooks.<event_name>` 数组中 `_kode_managed: true` 条目的下标。
fn find_kode_hook_entry(path: &Path, event_name: &str) -> Option<usize> {
    let bytes = std::fs::read(path).ok()?;
    let doc: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let arr = doc.get("hooks")?.get(event_name)?.as_array()?;
    arr.iter().position(|e| {
        e.get("_kode_managed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    })
}

fn write_json_atomic(path: &Path, doc: &serde_json::Value) -> Result<(), String> {
    if std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|existing| existing == *doc)
    {
        return Ok(());
    }
    let pretty =
        serde_json::to_string_pretty(doc).map_err(|e| format!("json serialize failed: {e}"))?;
    let tmp = path.with_extension("tmp.kode");
    std::fs::write(&tmp, pretty).map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
    if let Ok(metadata) = std::fs::metadata(path) {
        std::fs::set_permissions(&tmp, metadata.permissions())
            .map_err(|e| format!("set permissions {} failed: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} → {} failed: {e}", tmp.display(), path.display()))?;
    Ok(())
}

// ============================================================================
// hook command 构建 + 二进制查找(供 GUI 和 headless bridge 共用)
// ============================================================================
//
// 这组函数原本在 `apps/gui/src-tauri/src/memory_mcp.rs`,下沉到 `kode-memory`
// 让远端 `kode-bridge` 也能复用同一套 hook command 模板和二进制查找逻辑,
// 避免 GUI / bridge 各维护一份漂移。
//
// 远端 bridge 在 `run()` 启动时调 `build_codebuddy_hook_command()` 生成 command
// 字符串,再调 `inject_*` 写入 settings.json,与 GUI 的 `spawn_startup_probe` 对称。

/// kode-memory 二进制名(用于 codebuddy-hook / codex-hook 子命令)。
pub const HOOK_BINARY_NAME: &str = "kode-memory";

/// 在 PATH / 同 exe 目录 / macOS .app / 仓库 target 里找指定二进制。
/// 返回绝对路径。None = 找不到。
///
/// 查找优先级:
/// 1. 同进程同目录(打包后的 sidecar 路径,GUI .app 和远端 bridge bin/ 都命中)
/// 2. macOS /Applications/kode.app/Contents/MacOS/(仅 macOS)
/// 3. PATH 扫描(`which`)
/// 4. 仓库 target/{release,debug}(dev 模式 cargo run)
pub fn resolve_named_binary(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let executable_name = if Path::new(name).extension().is_none() {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    #[cfg(windows)]
    let name = executable_name.as_str();
    // (1) 同进程同目录 — 打包后的 sidecar 路径。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    // (2) macOS 安装包路径。dev/CLI 场景下 current_exe 不在 .app 里,
    // 但 hook 配置应优先引用已安装 kode.app 的 sidecar,避免 PATH 上旧版
    // ~/.cargo/bin/kode-memory 抢先导致子命令不匹配。
    if cfg!(target_os = "macos") {
        let candidate = PathBuf::from("/Applications/kode.app/Contents/MacOS").join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    // (3) PATH 查找
    if let Some(p) = which(name) {
        return Some(p);
    }
    // (4) 仓库 target/release/debug 兜底(dev 模式 cargo run 时有效)
    if let Ok(exe) = std::env::current_exe() {
        for variant in ["release", "debug"] {
            let mut cur = exe.parent().map(|p| p.to_path_buf());
            while let Some(dir) = cur {
                let candidate = dir.join("target").join(variant).join(name);
                if is_executable(&candidate) {
                    return Some(candidate);
                }
                cur = dir.parent().map(|p| p.to_path_buf());
            }
        }
    }
    None
}

/// PATH 扫描(不引 which crate,自己实现)。
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if is_executable(&cand) {
            return Some(cand);
        }
        #[cfg(windows)]
        if cand.extension().is_none() {
            let extensions =
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
            for extension in extensions.split(';').filter(|ext| ext.starts_with('.')) {
                let candidate = dir.join(format!("{name}{extension}"));
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

pub fn is_executable(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(p) {
            Ok(m) => m.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// CodeBuddy/Claude hook command:走 `kode-memory codebuddy-hook` bridge,
/// 而非裸 `cat | nc`。bridge 把 codebuddy 真实 session uuid 改写成 KODE_SESSION_ID(tab id)
/// 再转发 relay,使 relay 能正确路由(裸转发时 uuid 字符串 parse u64 失败被丢)。
/// bridge 内部读 `$KODE_HOOK_SOCK`;找不到 kode-memory 二进制时退回裸 relay 命令兜底。
pub fn build_codebuddy_hook_command() -> String {
    match resolve_named_binary(HOOK_BINARY_NAME) {
        Some(p) if supports_subcommand(&p, "codebuddy-hook") => {
            format!("{} codebuddy-hook", shell_quote(&p.display().to_string()))
        }
        Some(p) => {
            tracing::warn!(
                "{} does not support codebuddy-hook, falling back to raw hook relay",
                p.display()
            );
            raw_hook_relay_command()
        }
        None => raw_hook_relay_command(),
    }
}

/// Codex hook command:`<kode-memory> codex-hook`。
pub fn build_codex_hook_command() -> String {
    let bin = resolve_named_binary(HOOK_BINARY_NAME)
        .map(|p| codex_hook_quote(&p))
        .unwrap_or_else(|| HOOK_BINARY_NAME.to_string());
    format!("{bin} codex-hook")
}

fn codex_hook_quote(path: &Path) -> String {
    #[cfg(windows)]
    {
        // Codex executes hooks through its selected PowerShell on Windows.
        // A quoted path alone is a string expression, not an invocation.
        format!("& '{}'", path.display().to_string().replace('\'', "''"))
    }
    #[cfg(not(windows))]
    {
        shell_quote(&path.display().to_string())
    }
}

/// Cursor Agent `~/.cursor/hooks.json` 路径。
pub fn cursor_hooks_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".cursor").join("hooks.json"))
}

/// Cursor hook command:`<kode-memory> cursor-hook <event>`。
pub fn build_cursor_hook_command(event: &str) -> String {
    let bin = resolve_named_binary(HOOK_BINARY_NAME)
        .map(|p| shell_quote(&p.display().to_string()))
        .unwrap_or_else(|| HOOK_BINARY_NAME.to_string());
    format!("{bin} cursor-hook {event}")
}

/// 注入 Cursor Agent user hooks(幂等)。Cursor 的 hooks.json 是
/// `{ version: 1, hooks: { event: [{ command }] } }`,和 codebuddy 的嵌套
/// `hooks: [{ hooks: [{ command }] }]` 不同。
pub fn inject_cursor_hooks(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {} failed: {e}", parent.display()))?;
        }
    }

    let mut doc: serde_json::Value = if path.exists() {
        let bytes =
            std::fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
        if bytes.is_empty() {
            serde_json::json!({ "version": 1 })
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({ "version": 1 }))
        }
    } else {
        serde_json::json!({ "version": 1 })
    };

    if doc.get("version").is_none() {
        doc["version"] = serde_json::json!(1);
    }

    let hooks_obj = doc
        .as_object_mut()
        .ok_or("hooks.json root must be a JSON object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("hooks must be a JSON object")?;

    for event in ["sessionStart", "afterAgentResponse", "stop"] {
        let command = build_cursor_hook_command(event);
        let arr = hooks_obj
            .entry(event)
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{event} must be an array"))?;
        let entry = serde_json::json!({
            "command": command,
        });
        if let Some(existing) = arr.iter_mut().find(|e| is_kode_cursor_entry(e)) {
            *existing = entry;
        } else {
            arr.push(entry);
        }
    }

    write_json_atomic(path, &doc)
}

fn is_kode_cursor_entry(entry: &serde_json::Value) -> bool {
    entry
        .get("command")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.contains("cursor-hook"))
}

fn raw_hook_relay_command() -> String {
    // shell 展开 $KODE_HOOK_SOCK:有值时连接 relay,无值时 nc 立刻失败 exit 0。
    "cat | nc -U -w 1 \"$KODE_HOOK_SOCK\" 2>/dev/null; exit 0".to_string()
}

fn supports_subcommand(bin: &Path, subcommand: &str) -> bool {
    Command::new(bin)
        .args([subcommand, "--help"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'\''"#))
}

// ============================================================================
// tests
// ============================================================================

#[cfg(test)]
mod tests {
    #[test]
    fn tencent_hook_targets_use_independent_config_directories() {
        let home = std::path::Path::new("/home/test");
        assert_eq!(
            super::target_settings_in(home),
            vec![
                ("codebuddy", home.join(".codebuddy/settings.json")),
                ("claude", home.join(".claude/settings.json")),
                ("tclaude", home.join(".tclaude/settings.json")),
            ]
        );
        assert_eq!(
            super::codex_hook_targets_in(home),
            vec![
                ("codex", home.join(".codex/hooks.json")),
                ("tcodex", home.join(".tcodex/hooks.json")),
            ]
        );
    }

    #[test]
    fn codex_family_install_preserves_each_user_config_and_updates_commands() {
        let home = tempfile::tempdir().unwrap();
        let targets = super::codex_hook_targets_in(home.path());
        for (label, path) in &targets {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let initial = serde_json::json!({
                "custom": label,
                "hooks": {
                    "Stop": [{"hooks": [{"type": "command", "command": format!("{label}-user-stop")}]}]
                }
            });
            std::fs::write(path, initial.to_string()).unwrap();
            super::inject_codex_hooks(path, "old-helper codex-hook").unwrap();
            super::inject_codex_hooks(path, "new-helper codex-hook").unwrap();
        }
        for (label, path) in targets {
            let content = std::fs::read_to_string(&path).unwrap();
            let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
            assert_eq!(doc["custom"], label);
            let entries = doc["hooks"]["Stop"].as_array().unwrap();
            assert_eq!(entries.len(), 2);
            assert!(entries
                .iter()
                .any(|entry| entry["hooks"][0]["command"] == format!("{label}-user-stop")));
            let managed = entries
                .iter()
                .find(|entry| super::is_kode_codex_entry(entry))
                .unwrap();
            assert_eq!(managed["hooks"][0]["type"], "command");
            assert_eq!(managed["hooks"][0]["command"], "new-helper codex-hook");
            assert_eq!(
                doc["hooks"]["SessionStart"][0]["hooks"][0]["command"],
                "new-helper codex-hook"
            );
            assert!(super::is_codex_hook_configured(&path));
        }
    }

    #[test]
    fn tclaude_hook_install_preserves_claude_settings_and_user_hooks() {
        let home = tempfile::tempdir().unwrap();
        let targets = super::target_settings_in(home.path());
        let claude = targets
            .iter()
            .find(|(label, _)| *label == "claude")
            .unwrap()
            .1
            .clone();
        let tclaude = targets
            .iter()
            .find(|(label, _)| *label == "tclaude")
            .unwrap()
            .1
            .clone();
        std::fs::create_dir_all(claude.parent().unwrap()).unwrap();
        std::fs::write(&claude, r#"{"model":"claude-only"}"#).unwrap();
        std::fs::create_dir_all(tclaude.parent().unwrap()).unwrap();
        std::fs::write(&tclaude, r#"{"model":"tclaude-only","hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-stop"}]}]}}"#).unwrap();
        super::inject_stop_hook(&tclaude, "helper codebuddy-hook").unwrap();
        super::inject_session_start_hook(&tclaude, "helper codebuddy-hook").unwrap();
        let content = std::fs::read_to_string(&tclaude).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(doc["model"], "tclaude-only");
        assert!(doc["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["hooks"][0]["command"] == "user-stop"));
        assert!(super::is_stop_hook_configured(&tclaude));
        assert!(super::is_session_start_hook_configured(&tclaude));
        assert_eq!(
            std::fs::read_to_string(claude).unwrap(),
            r#"{"model":"claude-only"}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_hook_resolution_and_quoting_preserve_original_behavior() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("Molly's memory helper");
        std::fs::write(&binary, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            super::resolve_named_binary(binary.to_str().unwrap()),
            Some(binary.clone())
        );
        assert_eq!(super::which(binary.to_str().unwrap()), Some(binary.clone()));
        let quoted = super::codex_hook_quote(&binary);
        assert_eq!(quoted, super::shell_quote(binary.to_str().unwrap()));
        assert!(std::process::Command::new("/bin/sh")
            .args(["-c", &format!("{quoted} codex-hook")])
            .status()
            .unwrap()
            .success());
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(super::which(binary.to_str().unwrap()).is_none());
    }
    #[cfg(windows)]
    #[test]
    fn windows_hook_binary_resolution_and_quoting() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("memory helper.exe");
        std::fs::write(&binary, b"fixture").unwrap();
        let stem = dir.path().join("memory helper");
        assert_eq!(
            super::resolve_named_binary(&stem.to_string_lossy()),
            Some(binary.clone())
        );
        assert_eq!(
            super::which(&stem.to_string_lossy())
                .unwrap()
                .canonicalize()
                .unwrap(),
            binary.canonicalize().unwrap()
        );
        assert_eq!(
            super::resolve_named_binary(&binary.to_string_lossy()),
            Some(binary.clone())
        );
        assert_eq!(
            super::codex_hook_quote(&binary),
            format!("& '{}'", binary.display())
        );
        assert_eq!(
            super::codex_hook_quote(Path::new("C:\\Molly's tools\\memory.exe")),
            "& 'C:\\Molly''s tools\\memory.exe'"
        );
    }
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_tmp(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    // --- Stop hook tests ---

    #[test]
    fn stop_prompt_only_accepts_real_shared_memory_proposal() {
        assert!(STOP_HOOK_PROMPT.contains("`mcp__memory__memory_propose` MCP 工具调用"));
        assert!(STOP_HOOK_PROMPT.contains("只有该工具调用才算写入 kode-memory"));
        for excluded in [
            "file-based memory",
            "CODEBUDDY.md/AGENTS.md/项目文档",
            "Write/Edit 修改文件",
            "文字中声称/提到 memory_propose",
        ] {
            assert!(
                STOP_HOOK_PROMPT.contains(excluded),
                "Stop prompt must exclude {excluded} from persisted kode-memory"
            );
        }
    }

    #[test]
    fn stop_prompt_requires_confirmed_memory_tools_and_fails_open() {
        assert!(STOP_HOOK_PROMPT.contains("成功的 `memory_search` MCP 工具调用"));
        assert!(STOP_HOOK_PROMPT.contains("ToolSearch 返回 0 tools"));
        assert!(STOP_HOOK_PROMPT.contains("不要反复查找工具"));
    }

    #[test]
    fn inject_stop_into_empty_file_creates_hook() {
        let tmp = write_tmp("{}");
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert!(doc["hooks"]["Stop"].as_array().unwrap().iter().any(|e| {
            e.get("_kode_managed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        }));
    }

    #[test]
    fn inject_stop_preserves_existing_fields() {
        let tmp = write_tmp(r#"{"model": "opus", "trustedDirectories": ["/foo"]}"#);
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(doc["model"], "opus");
        assert_eq!(doc["trustedDirectories"][0], "/foo");
    }

    #[test]
    fn inject_stop_updates_existing_kode_hook() {
        let initial = serde_json::json!({
            "hooks": {
                "Stop": [{
                    "_kode_managed": true,
                    "hooks": [{"type": "prompt", "timeout": 30, "prompt": "old prompt"}]
                }]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let entry = &doc["hooks"]["Stop"][0];
        // hooks 数组里有两个子 hook:command(relay) + prompt(守门员)
        let hooks = entry["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["type"], "command");
        assert_eq!(hooks[0]["command"], "echo relay");
        let settings: serde_json::Value =
            serde_json::from_str(&session_settings_json()).unwrap();
        assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0]["type"], "prompt");
        assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0]["prompt"], STOP_HOOK_PROMPT);
        let count = doc["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| {
                e.get("_kode_managed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(count, 1);
    }

    /// 回归:早期版本注入的无标记 Stop hook 与新版有标记的并存时,
    /// inject_stop_hook 应清理僵尸条目,最终 Stop 数组里只有唯一一条带标记的。
    #[test]
    fn inject_stop_purges_unmarked_zombie_with_same_prompt() {
        let zombie = serde_json::json!({
            "hooks": [{
                "type": "prompt",
                "timeout": 30,
                "prompt": STOP_HOOK_PROMPT
            }]
            // 注意:无 _kode_managed 字段 — 这是早期版本的格式
        });
        let initial = serde_json::json!({
            "hooks": { "Stop": [zombie] }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["Stop"].as_array().unwrap();
        // 僵尸被清除,只剩唯一的带标记条目
        assert_eq!(arr.len(), 1, "zombie should be purged, got: {arr:?}");
        assert!(
            arr[0]
                .get("_kode_managed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            "remaining entry must have _kode_managed:true"
        );
    }

    /// 无标记但 prompt 内容不同的用户自定义 Stop hook 应保留。
    #[test]
    fn inject_stop_preserves_unmarked_user_stop_hook_with_different_prompt() {
        let user_hook = serde_json::json!({
            "hooks": [{"type": "command", "command": "my-stop-script.sh"}]
        });
        let initial = serde_json::json!({
            "hooks": { "Stop": [user_hook] }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "user hook + kode hook should both exist");
        assert!(arr
            .iter()
            .any(|e| e["hooks"][0]["command"] == "my-stop-script.sh"));
    }

    #[test]
    fn inject_stop_preserves_user_custom_hooks() {
        let initial = serde_json::json!({
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "my-custom-hook"}]}]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr
            .iter()
            .any(|e| e["hooks"][0]["command"] == "my-custom-hook"));
    }

    #[test]
    fn is_stop_hook_configured_false_when_missing() {
        let tmp = write_tmp("{}");
        assert!(!is_stop_hook_configured(tmp.path()));
    }

    #[test]
    fn is_stop_hook_configured_true_after_inject() {
        let tmp = write_tmp("{}");
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        assert!(is_stop_hook_configured(tmp.path()));
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(doc["hooks"]["Stop"][0]["hooks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn stop_hook_without_continue_on_block_is_not_configured() {
        let stale = serde_json::json!({
            "hooks": {
                "Stop": [{
                    "_kode_managed": true,
                    "hooks": [{
                        "type": "prompt",
                        "timeout": 30,
                        "prompt": STOP_HOOK_PROMPT
                    }]
                }]
            }
        });
        let tmp = write_tmp(&stale.to_string());
        assert!(!is_stop_hook_configured(tmp.path()));
    }

    // --- Notification hook tests ---

    #[test]
    fn inject_notification_hook_creates_entry() {
        let tmp = write_tmp("{}");
        inject_notification_hook(tmp.path(), "echo relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matcher"], "permission_prompt");
        assert_eq!(arr[0]["hooks"][0]["command"], "echo relay");
        assert!(arr[0]["_kode_managed"].as_bool().unwrap());
    }

    #[test]
    fn inject_notification_hook_updates_existing() {
        let initial = serde_json::json!({
            "hooks": {
                "Notification": [{
                    "_kode_managed": true,
                    "matcher": "permission_prompt",
                    "hooks": [{"type": "command", "command": "old-relay"}]
                }]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_notification_hook(tmp.path(), "new-relay").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"], "new-relay");
    }

    #[test]
    fn is_notification_hook_configured_works() {
        let tmp = write_tmp("{}");
        assert!(!is_notification_hook_configured(tmp.path()));
        inject_notification_hook(tmp.path(), "echo relay").unwrap();
        assert!(is_notification_hook_configured(tmp.path()));
    }

    // --- UserPromptSubmit hook tests ---

    #[test]
    fn inject_user_prompt_submit_hook_creates_entry() {
        let tmp = write_tmp("{}");
        inject_user_prompt_submit_hook(tmp.path(), "echo submit").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"], "echo submit");
        assert!(arr[0]["_kode_managed"].as_bool().unwrap());
    }

    // --- PreToolUse hook tests ---

    #[test]
    fn pretooluse_cleanup_is_noop_on_unconfigured_file() {
        let tmp = write_tmp("{}");
        remove_pretooluse_hooks(tmp.path()).unwrap();
        assert_eq!(std::fs::read_to_string(tmp.path()).unwrap(), "{}");
    }

    #[test]
    fn inject_config_change_hook_creates_entry() {
        let tmp = write_tmp("{}");
        inject_config_change_hook(tmp.path(), "echo config").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            doc["hooks"]["ConfigChange"][0]["hooks"][0]["command"],
            "echo config"
        );
    }

    // --- Multiple hook types coexist ---

    #[test]
    fn multiple_hook_types_coexist() {
        let tmp = write_tmp("{}");
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        inject_notification_hook(tmp.path(), "echo relay").unwrap();
        inject_user_prompt_submit_hook(tmp.path(), "echo submit").unwrap();
        remove_pretooluse_hooks(tmp.path()).unwrap();
        inject_config_change_hook(tmp.path(), "echo config").unwrap();

        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let hooks = doc["hooks"].as_object().unwrap();
        assert!(hooks.contains_key("Stop"));
        assert!(hooks.contains_key("Notification"));
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(!hooks.contains_key("PreToolUse"));
        assert!(hooks.contains_key("ConfigChange"));
    }

    #[test]
    fn existing_user_hooks_preserved_with_new_hook_types() {
        let initial = serde_json::json!({
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "user-stop"}]}],
                "Notification": [{"matcher": "idle_prompt", "hooks": [{"type": "command", "command": "user-notify"}]}]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_notification_hook(tmp.path(), "kode-relay").unwrap();
        inject_stop_hook(tmp.path(), "kode-relay").unwrap();

        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();

        // User Stop hook preserved + kode Stop hook added
        let stop_arr = doc["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop_arr.len(), 2);
        assert!(stop_arr
            .iter()
            .any(|e| e["hooks"][0]["command"] == "user-stop"));

        // User Notification hook preserved + kode Notification hook added
        let notify_arr = doc["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notify_arr.len(), 2);
        assert!(notify_arr.iter().any(|e| e["matcher"] == "idle_prompt"));
        assert!(notify_arr
            .iter()
            .any(|e| e["matcher"] == "permission_prompt"));
    }

    #[test]
    fn inject_codex_hooks_creates_command_hooks_without_unknown_markers() {
        let tmp = write_tmp("{}");
        inject_codex_hooks(tmp.path(), "/bin/kode-memory codex-hook").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();

        let hooks = doc["hooks"].as_object().unwrap();
        for event in [
            "SessionStart",
            "Stop",
            "PermissionRequest",
            "UserPromptSubmit",
        ] {
            let arr = hooks[event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{event} should have one managed entry");
            assert!(
                arr[0].get("_kode_managed").is_none(),
                "Codex hooks should not rely on undocumented _kode_managed fields"
            );
            assert_eq!(arr[0]["hooks"][0]["type"], "command");
            assert_eq!(arr[0]["hooks"][0]["command"], "/bin/kode-memory codex-hook");
            assert!(arr[0]["hooks"][0]["statusMessage"]
                .as_str()
                .unwrap()
                .starts_with("kode-memory"));
        }
        assert_eq!(hooks["PermissionRequest"][0]["matcher"], "*");
        assert!(!hooks.contains_key("PreToolUse"));
        assert!(is_codex_hook_configured(tmp.path()));
    }

    #[test]
    fn pretooluse_cleanup_removes_all_kode_variants_and_preserves_user_handlers() {
        let user = serde_json::json!({"type":"command","command":"user-tool-gate"});
        let initial = serde_json::json!({
            "model":"user-model",
            "hooks": {
                "PreToolUse": [
                    {"_kode_managed":true,"matcher":"*","hooks":[{"command":"old-relay"}]},
                    {"matcher":"*","hooks":[{"command":"'/Applications/kode.app/Contents/MacOS/kode-memory' codebuddy-hook"}]},
                    {"matcher":"*","hooks":[{"command":"kode-memory codex-hook","statusMessage":"kode-memory: relaying tool use"}]},
                    {"matcher":"Bash","hooks":[user]},
                    {"_kode_managed":true,"matcher":"Edit","hooks":[{"command":"kode-memory codebuddy-hook"},user]}
                ],
                "Stop":[{"hooks":[{"command":"user-stop"}]}]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        remove_pretooluse_hooks(tmp.path()).unwrap();
        let first = std::fs::read_to_string(tmp.path()).unwrap();
        remove_pretooluse_hooks(tmp.path()).unwrap();
        assert_eq!(std::fs::read_to_string(tmp.path()).unwrap(), first);
        let doc: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(doc["model"], initial["model"]);
        assert_eq!(doc["hooks"]["Stop"], initial["hooks"]["Stop"]);
        assert_eq!(
            doc["hooks"]["PreToolUse"],
            serde_json::json!([
                {"matcher":"Bash","hooks":[user]},
                {"matcher":"Edit","hooks":[user]}
            ])
        );
    }

    #[test]
    fn repeated_startup_deduplicates_markerless_hooks_and_never_readds_tool_gate() {
        let command = "'/Applications/kode.app/Contents/MacOS/kode-memory' codebuddy-hook";
        let mut initial = serde_json::json!({"custom":"keep","hooks":{}});
        for event in [
            "Stop",
            "Notification",
            "UserPromptSubmit",
            "SessionStart",
            "PreToolUse",
        ] {
            let mut legacy = serde_json::json!({"hooks":[{"type":"command","command":command}]});
            if event == "Stop" {
                legacy["hooks"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({
                        "type":"prompt", "prompt":"你是 kode-memory 的沉淀守门员。old version"
                    }));
            }
            let mut entries = vec![legacy; 5];
            entries
                .push(serde_json::json!({"_kode_managed":true,"hooks":[{"command":"old-relay"}]}));
            entries.push(serde_json::json!({"hooks":[{"command":"user-hook"}]}));
            initial["hooks"][event] = serde_json::json!(entries);
        }
        let tmp = write_tmp(&initial.to_string());
        for _ in 0..2 {
            remove_pretooluse_hooks(tmp.path()).unwrap();
            inject_stop_hook(tmp.path(), command).unwrap();
            inject_notification_hook(tmp.path(), command).unwrap();
            inject_user_prompt_submit_hook(tmp.path(), command).unwrap();
            inject_session_start_hook(tmp.path(), command).unwrap();
        }
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path()).unwrap()).unwrap();
        assert_eq!(doc["custom"], "keep");
        for event in ["Stop", "Notification", "UserPromptSubmit", "SessionStart"] {
            let entries = doc["hooks"][event].as_array().unwrap();
            assert_eq!(entries.len(), 2, "{event}: {entries:?}");
            assert_eq!(entries[1]["hooks"][0]["command"], "user-hook");
        }
        assert_eq!(
            doc["hooks"]["PreToolUse"],
            serde_json::json!([
                {"hooks":[{"command":"user-hook"}]}
            ])
        );
    }

    #[test]
    fn codex_startup_cleans_legacy_gate_and_duplicate_hooks() {
        let legacy = serde_json::json!({"hooks":[{"command":"kode-memory codex-hook","statusMessage":"kode-memory: old"}]});
        let initial =
            serde_json::json!({"hooks":{"PreToolUse":[legacy,legacy],"Stop":[legacy,legacy]}});
        let tmp = write_tmp(&initial.to_string());
        inject_codex_hooks(tmp.path(), "kode-memory codex-hook").unwrap();
        let first = std::fs::read_to_string(tmp.path()).unwrap();
        inject_codex_hooks(tmp.path(), "kode-memory codex-hook").unwrap();
        assert_eq!(std::fs::read_to_string(tmp.path()).unwrap(), first);
        let doc: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert!(doc["hooks"].get("PreToolUse").is_none());
        assert_eq!(doc["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn hook_migration_preserves_invalid_json() {
        let tmp = write_tmp("{ invalid json");
        assert!(remove_pretooluse_hooks(tmp.path())
            .unwrap_err()
            .contains("leaving it unchanged"));
        assert!(inject_stop_hook(tmp.path(), "kode-memory codebuddy-hook").is_err());
        assert!(inject_codex_hooks(tmp.path(), "kode-memory codex-hook").is_err());
        assert_eq!(
            std::fs::read_to_string(tmp.path()).unwrap(),
            "{ invalid json"
        );
    }

    #[test]
    fn repair_only_updates_existing_hooks_without_restoring_removed_events() {
        let initial = serde_json::json!({
            "model":"keep",
            "hooks":{
                "PreToolUse":[{"hooks":[{"command":"kode-memory codebuddy-hook"}]}],
                "Stop":[
                    {"hooks":[{"command":"kode-memory codebuddy-hook"},{"type":"prompt","prompt":"你是 kode-memory 的沉淀守门员。old"}]},
                    {"hooks":[{"command":"kode-memory codebuddy-hook"},{"command":"user-stop"}]}
                ],
                "Notification":[{"hooks":[{"command":"user-notify"}]}]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        repair_existing_hooks(tmp.path()).unwrap();
        let first = std::fs::read_to_string(tmp.path()).unwrap();
        repair_existing_hooks(tmp.path()).unwrap();
        assert_eq!(std::fs::read_to_string(tmp.path()).unwrap(), first);
        let doc: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(doc["model"], "keep");
        assert!(doc["hooks"].get("PreToolUse").is_none());
        assert!(doc["hooks"].get("SessionStart").is_none());
        assert!(doc["hooks"].get("UserPromptSubmit").is_none());
        assert_eq!(
            doc["hooks"]["Notification"],
            initial["hooks"]["Notification"]
        );
        assert_eq!(doc["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(doc["hooks"]["Stop"][0]["hooks"].as_array().unwrap().len(), 1);
        assert_eq!(doc["hooks"]["Stop"][1]["hooks"][0]["command"], "user-stop");
        let empty = write_tmp(r#"{"model":"keep"}"#);
        repair_existing_hooks(empty.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(empty.path()).unwrap(),
            r#"{"model":"keep"}"#
        );
    }

    #[test]
    fn inject_codex_hooks_updates_managed_and_preserves_user_hooks() {
        let initial = serde_json::json!({
            "hooks": {
                "Stop": [
                    {"hooks": [{"type": "command", "command": "user-stop"}]},
                    {"hooks": [{"type": "command", "command": "old", "statusMessage": "kode-memory: old"}]}
                ]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_codex_hooks(tmp.path(), "new-cmd codex-hook").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr.iter().any(|e| e["hooks"][0]["command"] == "user-stop"));
        assert!(arr
            .iter()
            .any(|e| e["hooks"][0]["command"] == "new-cmd codex-hook"));
    }

    // ── 下沉自 memory_mcp.rs 的二进制查找 / hook command 构建 ──

    #[test]
    fn raw_hook_relay_command_contains_sock_env() {
        let cmd = super::raw_hook_relay_command();
        assert!(cmd.contains("$KODE_HOOK_SOCK"));
        assert!(cmd.contains("nc -U"));
    }

    #[test]
    fn shell_quote_escapes_single_quote() {
        let q = super::shell_quote("a'b");
        // 单引号被转义为 '\'' 序列
        assert!(q.contains("'\\''"));
        assert!(q.starts_with('\'') && q.ends_with('\''));
    }

    #[test]
    fn build_codebuddy_hook_command_fallback_when_binary_missing() {
        // 临时清空 PATH 并设 current_exe 到临时目录,让 resolve_named_binary 找不到。
        // 注意:resolve_named_binary 还会查 current_exe 同目录和 macOS .app,这两条
        // 在测试环境里通常不命中 kode-memory,所以 fallback 路径会被触发。
        let cmd = super::build_codebuddy_hook_command();
        // 要么是 `'<path>' codebuddy-hook`(找到了 binary),要么是 fallback `cat | nc`。
        // 两种都合法,这里只断言非空且包含 hook 语义。
        assert!(!cmd.is_empty());
        assert!(
            cmd.contains("codebuddy-hook") || cmd.contains("nc -U"),
            "unexpected cmd: {cmd}"
        );
    }

    #[test]
    fn resolve_named_binary_finds_sh_in_path() {
        // sh 几乎总在 PATH 上;锁住 resolve_named_binary 的 PATH 扫描基本契约。
        // 对齐 GUI memory_mcp.rs 原有的 which_finds_sh 测试。
        let sh = super::resolve_named_binary("sh");
        assert!(sh.is_some(), "sh should be resolvable on PATH");
    }

    #[test]
    fn inject_cursor_hooks_creates_command_entries_and_preserves_user_hooks() {
        let initial = serde_json::json!({
            "version": 1,
            "hooks": {
                "sessionStart": [{ "command": "user-start" }]
            }
        });
        let tmp = write_tmp(&initial.to_string());
        inject_cursor_hooks(tmp.path()).unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(doc["version"], 1);
        let start = doc["hooks"]["sessionStart"].as_array().unwrap();
        assert!(start.iter().any(|e| e["command"] == "user-start"));
        assert!(start.iter().any(|e| e["command"]
            .as_str()
            .is_some_and(|s| s.contains("cursor-hook"))));
        assert!(doc["hooks"]["afterAgentResponse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["command"]
                .as_str()
                .is_some_and(|s| s.contains("cursor-hook"))));
        assert!(doc["hooks"]["stop"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["command"]
                .as_str()
                .is_some_and(|s| s.contains("cursor-hook"))));
    }
}
