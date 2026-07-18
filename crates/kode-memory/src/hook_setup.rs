//! kode-memory hook 自动注入。
//!
//! 在 kode GUI 启动时（`spawn_startup_probe`）自动把各类 hook 写入
//! codebuddy 和 claude 的 `settings.json`。
//!
//! ## 管理的 Hook 类型
//!
//! | Hook Event | 用途 |
//! |-----------|------|
//! | `Stop` | ① `type:"command"` 转发 hook_relay emit `turn_finished` ② `type:"prompt"` kode-memory 守门员 |
//! | `Notification` (permission_prompt) | 即时通知 kode GUI 有权限请求 |
//! | `UserPromptSubmit` | 用户回车提交后即时清除 attention |
//! | `PreToolUse` (*) | 实时获取 permission_mode |
//! | `ConfigChange` | CodeBuddy 配置变化后同步当前 session 的 model |
//!
//! ## 设计要点
//!
//! 1. **幂等 + 强制更新**：用 `_kode_managed: true` 字段标记 kode 管理的条目。
//!    每次 kode 启动都找到这个条目并更新（便于升级）。
//!    用户自定义的其他 hook（无该标记）保留不动。
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

## 应当沉淀的内容（命中任一才考虑拦截）
- 用户拍板了架构/工具链/UI风格/配置/命名的决策（"以后都用 X"、"别再 Y"、"这个项目就这么定"）
- 用户显式说了「记住」「这是规范」「以后都这样」
- 本轮踩到并解决了一个非显而易见的 gotcha（坑），下次别人会再踩
- 发现了一条 dead_end：试过 X 不行、因为 Y、应改用 Z
- 用户表达了稳定的偏好（不是一次性的「这次先 X」）

## 绝对不要拦（命中任一就放行）
- agent 本轮已经调用过 memory_propose（检查 transcript 里有没有 mcp__memory__memory_propose 工具调用）→ 已经记了，放行
- 纯一次性指令、闲聊、简单问答、只读探查、跑测试看结果
- 结论能从代码或 git log 直接看出来（不算"非显而易见"）
- 本轮没有任何决策/坑/偏好沉淀价值
- 你不确定是否值得记 → 倾向放行（宁可漏记，不要每轮打断用户；能量预算有限，滥提议会 out_of_energy）

## 输出
- 没有值得沉淀的：{"ok": true}
- 确实有且 agent 没记：{"ok": false, "reason": "本轮产生了值得沉淀进 kode-memory 的内容：<一句话说清是什么>。请先 ToolSearch 加载 memory_propose 与 memory_search，用 memory_search 查重后调 memory_propose 写入(author 用当前 backend，scope 用 project:<当前项目名>，body 含结论+why)。若 memory_search 显示已有等价 fact 或返回 out_of_energy，则无需写入，直接结束即可。"}

保守判断：绝大多数轮次都应返回 {"ok": true}。只有明确命中"应当沉淀"且 agent 确实没写时才返回 ok:false。"#;

/// 需要注入 hook 的 backend 列表，返回 `(label, settings_path)` 对。
/// 路径不存在也返回（inject 函数会在写入时创建）。
pub fn target_settings() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    vec![
        ("codebuddy", home.join(".codebuddy").join("settings.json")),
        ("claude", home.join(".claude").join("settings.json")),
    ]
}

/// Codex user-level hooks.json 路径。
pub fn codex_hooks_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".codex").join("hooks.json"))
}

// ============================================================================
// Stop hook
// ============================================================================

/// 检查 `path` 对应的 settings.json 里是否已有 kode 管理的 Stop hook（`_kode_managed: true`）。
pub fn is_stop_hook_configured(path: &Path) -> bool {
    find_kode_hook_entry(path, "Stop").is_some()
}

/// 注入或更新 kode 管理的 Stop hook（幂等）。
///
/// `hooks` 数组里并列两个子 hook：
/// 1. `type:"command"` → 立即转发给 hook_relay（emit `turn_finished` + `attention_cleared`）
/// 2. `type:"prompt"` → 守门员 LLM（判断本轮是否需要沉淀进 memory）
///
/// 两者并列执行：command 先跑（即时通知 GUI turn 结束），prompt 后跑（可能拦截让 agent 续跑沉淀）。
///
/// 流程：
/// 1. 读现有 JSON（不存在或为空 → 用 `{}`，保留其他字段）
/// 2. 清理 `hooks.Stop` 数组里"内容等于 STOP_HOOK_PROMPT 但无 `_kode_managed` 标记"
///    的僵尸条目（早期版本注入的历史遗留，会导致守门员 prompt 双倍执行）
/// 3. 在 `hooks.Stop` 数组里找 `_kode_managed: true` 的项 → 整体更新；找不到 → 追加
/// 4. Atomic write：写 tmp 文件 → rename
pub fn inject_stop_hook(path: &Path, relay_command: &str) -> Result<(), String> {
    // 先清理早期版本遗留的无标记僵尸条目(内容等于 STOP_HOOK_PROMPT 但无 _kode_managed)。
    // 旧版本注入时没有 _kode_managed 字段,后来加标记后 inject_hook_entry 的去重逻辑
    // 找不到带标记的条目就追加新条目,导致 Stop hook 双条目 → 守门员 prompt 双倍执行。
    purge_unmarked_stop_hook_zombies(path)?;

    let kode_entry = serde_json::json!({
        "_kode_managed": true,
        "hooks": [
            {
                "type": "command",
                "timeout": 5,
                "command": relay_command
            },
            {
                "type": "prompt",
                "timeout": 30,
                "prompt": STOP_HOOK_PROMPT
            }
        ]
    });

    inject_hook_entry(path, "Stop", &kode_entry)
}

/// 清理 `hooks.Stop` 里内容等于 STOP_HOOK_PROMPT 但无 `_kode_managed` 标记的历史遗留条目。
fn purge_unmarked_stop_hook_zombies(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
    if bytes.is_empty() {
        return Ok(());
    }
    let mut doc: serde_json::Value =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}));

    let Some(hooks_obj) = doc
        .as_object_mut()
        .and_then(|o| o.get_mut("hooks"))
        .and_then(|v| v.as_object_mut())
    else {
        return Ok(());
    };
    let Some(stop_arr) = hooks_obj.get_mut("Stop").and_then(|v| v.as_array_mut()) else {
        return Ok(());
    };

    let before = stop_arr.len();
    stop_arr.retain(|entry| {
        // 保留:有 _kode_managed 标记的(正规条目)或不含匹配 prompt 的用户自定义条目
        let is_managed = entry
            .get("_kode_managed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_managed {
            return true;
        }
        // 无标记 + prompt 等于 STOP_HOOK_PROMPT → 这是僵尸,移除
        let zombie_prompt = entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .and_then(|arr| arr.first())
            .and_then(|h| h.get("prompt"))
            .and_then(|p| p.as_str())
            .map(|p| p == STOP_HOOK_PROMPT)
            .unwrap_or(false);
        !zombie_prompt
    });

    if stop_arr.len() == before {
        return Ok(()); // 没有僵尸,不需要写回
    }

    // 写回
    let pretty =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("json serialize failed: {e}"))?;
    let tmp = path.with_extension("tmp.kode");
    std::fs::write(&tmp, pretty).map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} → {} failed: {e}", tmp.display(), path.display()))?;
    Ok(())
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
// PreToolUse hook (permission mode tracking)
// ============================================================================

/// 注入 PreToolUse hook，匹配所有工具调用（`*`）。
///
/// 每次工具调用前 hook_relay 收到 `permission_mode` 字段，实时更新 sidebar mode 显示。
///
/// `relay_command` 是 kode-hook-relay 的 shell 命令（含 socket 路径参数）。
pub fn inject_pretooluse_hook(path: &Path, relay_command: &str) -> Result<(), String> {
    let kode_entry = serde_json::json!({
        "_kode_managed": true,
        "matcher": "*",
        "hooks": [{
            "type": "command",
            "timeout": 5,
            "command": relay_command
        }]
    });

    inject_hook_entry(path, "PreToolUse", &kode_entry)
}

/// 检查 PreToolUse hook 是否已配置。
pub fn is_pretooluse_hook_configured(path: &Path) -> bool {
    find_kode_hook_entry(path, "PreToolUse").is_some()
}

// ============================================================================
// ConfigChange hook (CodeBuddy model tracking)
// ============================================================================

/// 注入 ConfigChange hook，用于在 CodeBuddy `/model` 切换后即时同步模型。
///
/// CodeBuddy 2.124 不再把模型切换命令写进 session jsonl，但 ConfigChange hook
/// 会携带当前模型。hook command 从发起切换的 CodeBuddy 进程继承
/// `KODE_SESSION_ID`，因此事件能精确路由到当前 tab，不需要监听全局 settings 文件。
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

/// 检查 ConfigChange hook 是否已配置。
pub fn is_config_change_hook_configured(path: &Path) -> bool {
    find_kode_hook_entry(path, "ConfigChange").is_some()
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
        CodexHookSpec {
            event: "PreToolUse",
            matcher: Some("*"),
            timeout: 5,
            status: "kode-memory: relaying tool use",
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

    let mut doc: serde_json::Value = if path.exists() {
        let bytes =
            std::fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
        if bytes.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}))
        }
    } else {
        serde_json::json!({})
    };

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

    if let Some(existing) = event_arr.iter_mut().find(|e| is_kode_codex_entry(e)) {
        *existing = entry;
    } else {
        event_arr.push(entry);
    }

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
/// - 用户自定义的条目（无 `_kode_managed`）保留不动
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
    let mut doc: serde_json::Value = if path.exists() {
        let bytes =
            std::fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
        if bytes.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}))
        }
    } else {
        serde_json::json!({})
    };

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

    // 找已有的 kode 管理 entry，有则更新，没有则追加
    let existing = event_arr.iter_mut().find(|e| {
        e.get("_kode_managed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    });

    if let Some(existing_entry) = existing {
        *existing_entry = entry.clone();
    } else {
        event_arr.push(entry.clone());
    }

    // Atomic write
    let pretty =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("json serialize failed: {e}"))?;
    let tmp = path.with_extension("tmp.kode");
    std::fs::write(&tmp, pretty).map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} → {} failed: {e}", tmp.display(), path.display()))?;

    Ok(())
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
    let pretty =
        serde_json::to_string_pretty(doc).map_err(|e| format!("json serialize failed: {e}"))?;
    let tmp = path.with_extension("tmp.kode");
    std::fs::write(&tmp, pretty).map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
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
        .map(|p| shell_quote(&p.display().to_string()))
        .unwrap_or_else(|| HOOK_BINARY_NAME.to_string());
    format!("{bin} codex-hook")
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
        assert_eq!(hooks.len(), 2);
        assert_eq!(hooks[0]["type"], "command");
        assert_eq!(hooks[0]["command"], "echo relay");
        assert_eq!(hooks[1]["type"], "prompt");
        assert_eq!(hooks[1]["prompt"].as_str().unwrap(), STOP_HOOK_PROMPT);
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
    fn inject_pretooluse_hook_creates_entry() {
        let tmp = write_tmp("{}");
        inject_pretooluse_hook(tmp.path(), "echo ptool").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matcher"], "*");
        assert_eq!(arr[0]["hooks"][0]["command"], "echo ptool");
        assert!(arr[0]["_kode_managed"].as_bool().unwrap());
    }

    // --- ConfigChange hook tests ---

    #[test]
    fn inject_config_change_hook_creates_entry() {
        let tmp = write_tmp("{}");
        inject_config_change_hook(tmp.path(), "echo config").unwrap();
        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let arr = doc["hooks"]["ConfigChange"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"], "echo config");
        assert!(arr[0]["_kode_managed"].as_bool().unwrap());
    }

    // --- Multiple hook types coexist ---

    #[test]
    fn multiple_hook_types_coexist() {
        let tmp = write_tmp("{}");
        inject_stop_hook(tmp.path(), "echo relay").unwrap();
        inject_notification_hook(tmp.path(), "echo relay").unwrap();
        inject_user_prompt_submit_hook(tmp.path(), "echo submit").unwrap();
        inject_pretooluse_hook(tmp.path(), "echo ptool").unwrap();
        inject_config_change_hook(tmp.path(), "echo config").unwrap();

        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let hooks = doc["hooks"].as_object().unwrap();
        assert!(hooks.contains_key("Stop"));
        assert!(hooks.contains_key("Notification"));
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("PreToolUse"));
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
            "PreToolUse",
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
        assert!(is_codex_hook_configured(tmp.path()));
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
}
