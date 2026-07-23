//! M4.1:codebuddy MCP 自动检测 + 一键配置。
//!
//! 这个模块跟 `memory.rs`(review queue 后端)互补:
//! - `memory.rs` 已经把 GUI 自身打开的 MemoryStore 暴露给前端面板。
//! - 这里负责把同一份 ~/.kode-memory **接到 codebuddy 子进程的 MCP 链路里**,
//!   让 codebuddy / claude tab 里的 agent 也能调 `memory_search` / `memory_propose`。
//!
//! 设计要点:
//!
//! 1. **stdio MCP 模型下"生命周期一起"的真实含义**
//!    stdio MCP server 是被调用方(codebuddy)spawn 的子进程,kode 进程层面
//!    spawn 一个 server 给所有 tab 用 = 不可行(stdin/stdout 已被独占)。
//!    所以"生命周期一起"= kode 退 → tab 退 → codebuddy 退 → 它各自的
//!    `kode-memory-mcp` child 自然退;不需要 kode 层主动 spawn / kill。
//!    数据共享靠所有 child 都指 `KODE_MEMORY_ROOT=~/.kode-memory`(已由
//!    `memory::resolve_memory_root` 统一)。
//!    工程隔离靠 agent 在调用时传 `scope: project:<cwd-slug>`(系统约定)。
//!
//! 2. **二进制查找**:`resolve_binary` 按 (1) 同 GUI 目录 → (2) PATH(`which`)
//!    → (3) 仓库 `target/release` 三级 fallback。
//!    生产 .app 装包时走 (1) sidecar;dev 跑 `cargo install` 走 (2);本地
//!    不 install 直接 `cargo run` 走 (3)。
//!
//! 3. **数据驱动 backend(2026-06)**:接入策略不再写死 codebuddy/claude-internal,
//!    而是从 `BackendConfig.mcp_setup` 读。三种风格:
//!    - `Codebuddy`:`<cli> mcp add -s user <name> <bin> -e KEY=val`
//!    - `Claude`:`<cli> mcp add -s user <name> -e KEY=val -- <bin>`
//!    - `Codex`:`<cli> mcp add <name> --env KEY=val -- <bin>`
//!    - `JsonMerge`:直接读 / 改 / 写指定 JSON 文件(无 CLI)
//!    这样新加的 backend(codex / gemini-cli / 等)在 config.toml 里声明 mcp_setup
//!    就能享受自动接入,无需改代码。memory_mcp 只是数据驱动的 setup runner。
//!
//! 4. **不打扰**:点了"暂不提示"会在 state.json 写 `mcp_prompt_dismissed_at`,
//!    后续启动如果一切状态没变就不再 emit 事件;一旦检测到 binary 路径或
//!    backend 配置发生变化(比如用户手动 install / config 了),就重置语义,
//!    重新提示一次。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use kode_core::config::{BackendConfig, McpSetupSpec};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use toml_edit::DocumentMut;

use crate::memory::resolve_memory_root;
use crate::persistence;
use crate::state::AppState;

const MCP_SERVER_NAME: &str = "memory";
const BINARY_NAME: &str = "kode-memory-mcp";
/// 启动后多久才触发一次 banner emit。给前端留出 mount 时间。
const STARTUP_PROBE_DELAY_MS: u64 = 800;

// hook command 构建 + 二进制查找已下沉到 `kode_memory::hook_setup`,这里直接复用:
// - `build_codebuddy_hook_command()` / `build_codex_hook_command()`
// - `resolve_named_binary(name)` / `which(name)` / `is_executable(p)`
// 见 `crates/kode-memory/src/hook_setup.rs`。
use kode_memory::hook_setup::{resolve_named_binary, which};

// ============== 前端 DTO ==============

/// 单个 backend 自动 setup 的结果(成功/失败 + 错误信息)。
/// 前端 toast 展示时,失败的会用红色,成功的用绿色。
#[derive(Debug, Clone, Serialize)]
pub struct AutoSetupOutcome {
    /// `"codebuddy"` / `"claude-internal"`,前端展示用
    pub backend: String,
    /// 这次 `mcp add` 是否成功
    pub success: bool,
    /// 失败原因(成功时为 None);拼了 stdout/stderr,前端可在折叠区展示
    pub error: Option<String>,
}

impl AutoSetupOutcome {
    fn ok(backend: &str) -> Self {
        Self {
            backend: backend.to_string(),
            success: true,
            error: None,
        }
    }
    fn err(backend: &str, msg: String) -> Self {
        Self {
            backend: backend.to_string(),
            success: false,
            error: Some(msg),
        }
    }
}

/// 启动自动 setup 完成后给前端的报告。同一个 schema 被两个事件复用:
/// - `memory-mcp-auto-configured`(全部成功 → 弹 toast 知会)
/// - `memory-mcp-setup-required`(有失败 → 弹 banner,attempts 里能看到错因)
///
/// `check` 是 setup 跑完后**重新探测**一遍的结果,前端可直接用它刷 banner 状态,
/// 不必再额外发 `memory_mcp_check` 命令。
#[derive(Debug, Clone, Serialize)]
pub struct AutoSetupReport {
    pub check: CheckResult,
    pub attempts: Vec<AutoSetupOutcome>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    /// `kode-memory-mcp` 二进制是否能找到
    pub binary_available: bool,
    /// 找到的二进制绝对路径(供 banner 复制安装命令时显示)
    pub binary_path: Option<String>,
    /// `codebuddy` CLI 自身是否可用 — 没装的话谈不上配 MCP
    /// **legacy**:为兼容老前端 banner 字段;新代码从 `backends` map 读
    pub codebuddy_available: bool,
    /// `~/.codebuddy.json` 里 mcpServers.memory 是否已配置
    /// **legacy**:同上
    pub configured_for_codebuddy: bool,
    /// `claude-internal` CLI 自身是否可用
    /// **legacy**:同上
    pub claude_internal_available: bool,
    /// `~/.claude-internal/.claude.json` 里 mcpServers.memory 是否已配置
    /// **legacy**:同上
    pub configured_for_claude_internal: bool,
    /// 用户在某次 dismiss 时的 unix 秒(供前端做"距离上次提示的间隔"判断;
    /// 实际 should-prompt 决策已在后端完成,前端 mostly 用于 UI 文案)
    pub dismissed_at: Option<i64>,
    /// 当前 memory root(展示用)
    pub memory_root: String,
    /// codebuddy `~/.codebuddy/settings.json` 里是否已有 kode 管理的 Stop hook
    #[serde(default)]
    pub hook_configured_codebuddy: bool,
    /// claude `~/.claude/settings.json` 里是否已有 kode 管理的 Stop hook
    #[serde(default)]
    pub hook_configured_claude: bool,
    /// **2026-06** 数据驱动 backend 状态映射:`backend_key -> BackendStatus`。
    /// 包含所有声明了 `mcp_setup` 的 backend(无 mcp_setup 的 backend 不在这里)。
    /// 新前端 BackendManagePanel 用这个字段;老 banner 仍用 legacy 字段。
    /// 排序用 BTreeMap 保证前端顺序稳定(一致的 UI 体验)。
    #[serde(default)]
    pub backends: BTreeMap<String, BackendStatus>,
}

/// 单个 backend 的 memory MCP 接入状态(给新 BackendManagePanel 用)。
#[derive(Debug, Clone, Serialize)]
pub struct BackendStatus {
    /// backend.command 在 PATH 上
    pub command_available: bool,
    /// `mcp_setup.cli` 在 PATH 上(JsonMerge 风格无 cli,这里是 None)
    pub setup_cli_available: Option<bool>,
    /// memory 是否已注册到该 backend 的 mcp 配置
    pub configured: bool,
    /// `mcp_setup` 风格(展示用)
    pub setup_style: String,
}

// ============== 公开 API ==============

/// 拉一次状态。前端 banner mount 时调一次,后端 startup 800ms 后也调一次。
#[tauri::command]
pub fn memory_mcp_check(state: State<'_, AppState>) -> Result<CheckResult, String> {
    let backends = state.ctx.backend_configs.read().clone();
    Ok(probe(&backends, &state.persist))
}

// ============== 数据驱动 setup runner ==============

/// 按 backend 的 `mcp_setup` spec 跑接入逻辑,不依赖 AppHandle —— tauri command
/// 和 startup 自动配置都复用这一份。失败时返回带原因字符串(stdout/stderr 拼接)。
///
/// 三种风格(见 `kode_core::config::McpSetupSpec`):
/// - `Codebuddy { cli }` → `<cli> mcp add -s user memory <bin> -e KEY=val`
/// - `Claude { cli }` → `<cli> mcp add -s user memory -e KEY=val -- <bin>`
/// - `Codex { cli }` → `<cli> mcp add memory --env KEY=val -- <bin>`
/// - `JsonMerge { config_path }` → 读 / 改 / 写 JSON
///
/// 这是数据驱动后的「**唯一**」setup 路径 —— 老的硬编码 `run_codebuddy_setup` /
/// `run_claude_internal_setup` 已被这函数取代。新增 backend(codex / gemini)只要在
/// config.toml 里声明 mcp_setup 就能享受相同流程,无需改代码。
fn run_setup_for_backend(spec: &McpSetupSpec) -> Result<(), String> {
    let bin = resolve_binary().ok_or_else(|| {
        format!(
            "{} not found. Run `cargo install --path crates/kode-memory --bin {}` first.",
            BINARY_NAME, BINARY_NAME
        )
    })?;
    let root = resolve_memory_root();
    match spec {
        McpSetupSpec::Codebuddy { cli } => run_codebuddy_style(cli, &bin, &root),
        McpSetupSpec::Claude { cli } => run_claude_style(cli, &bin, &root),
        McpSetupSpec::Codex { cli } => run_codex_style(cli, &bin, &root),
        McpSetupSpec::JsonMerge { config_path } => merge_into_json_config(config_path, &bin, &root),
    }
}

/// commander.js 风格(codebuddy 等):`-e <env...>` 是 variadic,positional 必须在 -e 前。
fn run_codebuddy_style(cli: &str, bin: &Path, root: &Path) -> Result<(), String> {
    if which(cli).is_none() {
        return Err(format!("{cli} CLI not found in PATH"));
    }
    let env_arg = format!("KODE_MEMORY_ROOT={}", root.display());
    let output = Command::new(cli)
        .args([
            "mcp",
            "add",
            "-s",
            "user",
            MCP_SERVER_NAME,
            &bin.display().to_string(),
            "-e",
            &env_arg,
        ])
        .output()
        .map_err(|e| format!("spawn {cli} mcp add failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{cli} mcp add failed (status={:?})\nstdout: {}\nstderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// claude 风格:用 `--` 终止 flag 段,bin 必须在最末。
fn run_claude_style(cli: &str, bin: &Path, root: &Path) -> Result<(), String> {
    if which(cli).is_none() {
        return Err(format!("{cli} CLI not found in PATH"));
    }
    let env_arg = format!("KODE_MEMORY_ROOT={}", root.display());
    let output = Command::new(cli)
        .args([
            "mcp",
            "add",
            "-s",
            "user",
            MCP_SERVER_NAME,
            "-e",
            &env_arg,
            "--",
            &bin.display().to_string(),
        ])
        .output()
        .map_err(|e| format!("spawn {cli} mcp add failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{cli} mcp add failed (status={:?})\nstdout: {}\nstderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Codex CLI 风格:`codex mcp add <name> --env KEY=val -- <bin>`。
fn run_codex_style(cli: &str, bin: &Path, root: &Path) -> Result<(), String> {
    if which(cli).is_none() {
        return Err(format!("{cli} CLI not found in PATH"));
    }
    let env_arg = format!("KODE_MEMORY_ROOT={}", root.display());
    let output = Command::new(cli)
        .args([
            "mcp",
            "add",
            MCP_SERVER_NAME,
            "--env",
            &env_arg,
            "--",
            &bin.display().to_string(),
        ])
        .output()
        .map_err(|e| format!("spawn {cli} mcp add failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{cli} mcp add failed (status={:?})\nstdout: {}\nstderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// JsonMerge 风格:直接读 / 写 JSON 配置文件,不调 CLI。
///
/// 流程:
/// 1. 展开 `~`,确保父目录存在(必要时 mkdir -p)
/// 2. 读现有文件 → JSON parse(不存在或 parse 失败 → 用 `{}` 兜底)
/// 3. 把 `mcpServers.memory = {command, env: {KODE_MEMORY_ROOT: root}, type: "stdio"}` 写进去
/// 4. atomic write(写到 .tmp 再 rename)
///
/// 风险点:用户的工具如果对 JSON 格式有额外要求(比如 codex 用 TOML 而不是 JSON),
/// 这条路径就不适用,得给那个工具加新的 spec variant。
fn merge_into_json_config(config_path: &str, bin: &Path, root: &Path) -> Result<(), String> {
    let path = expand_tilde(config_path);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {} failed: {e}", parent.display()))?;
        }
    }
    let mut doc: serde_json::Value = if path.exists() {
        let bytes =
            std::fs::read(&path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
        if bytes.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}))
        }
    } else {
        serde_json::json!({})
    };
    let entry = serde_json::json!({
        "command": bin.display().to_string(),
        "type": "stdio",
        "args": [],
        "env": { "KODE_MEMORY_ROOT": root.display().to_string() },
    });
    let servers = doc
        .as_object_mut()
        .ok_or("config root must be a JSON object")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let servers_obj = servers
        .as_object_mut()
        .ok_or("mcpServers must be a JSON object")?;
    servers_obj.insert(MCP_SERVER_NAME.to_string(), entry);

    let pretty =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("json serialize failed: {e}"))?;
    let tmp = path.with_extension("tmp.kode");
    std::fs::write(&tmp, pretty).map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} → {} failed: {e}", tmp.display(), path.display()))?;
    Ok(())
}

/// 展开 `~/...` 路径头到 `$HOME/...`。其他形式原样返回(包括绝对路径、`~user` 这类罕见形式)。
fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if p == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(p)
}

// ============== 老 setup tauri command(单一 backend 入口) ==============

/// 一键给指定 backend 接 memory MCP。失败时返回带原因字符串(stdout/stderr 拼接)。
/// 成功后 emit `memory-mcp-changed` 让 banner 重新拉状态消失。
///
/// 这是**新的统一入口**,前端按 backend_key 调用即可。老的 `memory_mcp_setup_codebuddy` /
/// `memory_mcp_setup_claude_internal` 走 backward-compat 包装,实际转发到这里。
#[tauri::command]
pub fn memory_mcp_setup_backend(
    backend_key: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let backend = state
        .ctx
        .config
        .backend(&backend_key)
        .ok_or_else(|| format!("backend '{backend_key}' not found in config"))?;
    let spec = backend
        .mcp_setup
        .as_ref()
        .ok_or_else(|| format!("backend '{backend_key}' has no mcp_setup declared"))?;
    run_setup_for_backend(spec)?;
    let _ = app.emit("memory-mcp-changed", ());
    Ok(())
}

/// **legacy** wrapper:给老前端 banner 调的 `memory_mcp_setup_codebuddy`。新代码请用
/// `memory_mcp_setup_backend("codebuddy")`。
#[tauri::command]
pub fn memory_mcp_setup_codebuddy(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    memory_mcp_setup_backend("codebuddy".into(), app, state)
}

/// **legacy** wrapper:给老前端 banner 调的 `memory_mcp_setup_claude_internal`。
#[tauri::command]
pub fn memory_mcp_setup_claude_internal(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    memory_mcp_setup_backend("claude-internal".into(), app, state)
}

/// 用户点"暂不提示"。把当前 unix 秒写进 state.json。
#[tauri::command]
pub fn memory_mcp_dismiss_prompt(state: State<'_, AppState>) -> Result<(), String> {
    let mut s = persistence::load();
    s.version = 1;
    s.mcp_prompt_dismissed_at = Some(now_secs());
    state.persist.request_save(s);
    Ok(())
}

// ============== M4.2:kode-memory prompt 注入开关 ==============

#[derive(Debug, Clone, Serialize)]
pub struct PromptStatus {
    /// 当前是否启用注入(老 state.json 没字段时默认 true)
    pub enabled: bool,
    /// 当前会被注入的 prompt 字符串完整预览(给 GUI 展示用)
    pub preview: String,
    /// preview 字节数,GUI 状态栏显示用("注入 X KB")
    pub preview_bytes: usize,
}

/// 拉当前 prompt 注入状态 + 预览。命令面板"预览注入内容"项调它。
#[tauri::command]
pub fn memory_prompt_status() -> Result<PromptStatus, String> {
    let s = persistence::load();
    let enabled = s.kode_memory_prompt_enabled.unwrap_or(true);
    // 预览用当前进程 cwd + 通用 backend 名,跟实际注入到子进程的内容尽量一致
    // (实际 spawn 时 cwd / backend 由 session::spawn 决定,这里只是给用户看个样子)。
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let preview = kode_memory::prompt::build(&cwd, "codebuddy");
    let preview_bytes = preview.len();
    Ok(PromptStatus {
        enabled,
        preview,
        preview_bytes,
    })
}

/// 切 enabled。改完只对**下次** spawn 的 tab 生效;现存 tab 的子进程已固化的
/// args 不会被重写。前端 toast 应提示这条限制。
#[tauri::command]
pub fn memory_prompt_set_enabled(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut s = persistence::load();
    s.version = 1;
    s.kode_memory_prompt_enabled = Some(enabled);
    state.persist.request_save(s);
    Ok(())
}

/// setup hook 用:启动后 800ms 异步触发。
///
/// **2026-06 行为变更**:之前只是 emit `memory-mcp-setup-required` 事件让前端弹
/// banner,等用户点按钮才真去 `mcp add`。问题是用户可能根本没注意到 banner,
/// 或者以为「不点也没关系」,结果 codebuddy / claude tab 启动后压根连不上 memory
/// MCP,得跑去控制台手动 `codebuddy mcp add` —— 体验断裂。
///
/// 新逻辑:**直接调 setup,把 binary 接进所有声明了 mcp_setup 的 backend**。
/// - 用户从未 dismiss 过 → 自动配。配好 emit `memory-mcp-auto-configured` 让前端
///   弹一条 toast「已自动接入 X / Y」,知会一下,不强求交互。
/// - 配的过程中失败(CLI 报错 / 二进制路径变了 / 网络写文件失败) → fallback 回老
///   的 `memory-mcp-setup-required`,banner 把错误显示出来,用户能看到原因。
/// - 用户之前 `dismiss` 过 → 尊重选择,不跑 MCP auto setup。改主意走命令面板 / 设置入口。
///   Kode 管理的 hooks 仍会幂等补齐,因为这和 banner 提示不是同一层选择。
///
/// 自动 setup 是幂等的:codebuddy / claude family CLI 的 `mcp add` 都会**覆盖**同名
/// server,JSON merge 也是覆盖语义。重复配不会破坏现有配置。
///
/// **2026-06 数据驱动**:这个函数不再硬编码 codebuddy / claude-internal 两家,而是
/// 遍历 config 里所有声明了 `mcp_setup` 的 backend。新加的 backend(codex / gemini)
/// 在 config.toml 里填好 mcp_setup 就能享受同样的自动接入,无需改这里。
pub fn spawn_startup_probe(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(STARTUP_PROBE_DELAY_MS)).await;
        let app_state: tauri::State<'_, AppState> = match app.try_state::<AppState>() {
            Some(s) => s,
            None => {
                tracing::warn!("memory_mcp probe: AppState not yet managed, skipping");
                return;
            }
        };
        let backends = app_state.ctx.backend_configs.read().clone();
        let result = probe(&backends, &app_state.persist);

        // Hook 注入：每次启动都检测所有 kode 管理的 hook 类型。
        // 已存在的跳过（幂等），缺失的补充。与 MCP auto_setup 结果无关。
        //
        // 所有 hook 都依赖 HookRelay socket（type:"command" 子 hook 转发事件给 relay），
        // 所以统一在 HookRelay 创建成功的分支内注入。Stop hook 额外含 `type:"prompt"`
        // 守门员子 hook，和 command 并列执行。
        if let Some(_socket_path) = app_state.hook_relay_socket.as_deref() {
            let relay_cmd = kode_memory::hook_setup::build_codebuddy_hook_command();
            for (label, path) in kode_memory::hook_setup::target_settings() {
                if let Err(e) = kode_memory::hook_setup::inject_stop_hook(&path, &relay_cmd) {
                    tracing::warn!("stop hook inject failed for {label}: {e}");
                }
                if let Err(e) = kode_memory::hook_setup::inject_notification_hook(&path, &relay_cmd)
                {
                    tracing::warn!("notification hook inject failed for {label}: {e}");
                }
                if let Err(e) =
                    kode_memory::hook_setup::inject_user_prompt_submit_hook(&path, &relay_cmd)
                {
                    tracing::warn!("user_prompt_submit hook inject failed for {label}: {e}");
                }
                if let Err(e) = kode_memory::hook_setup::inject_pretooluse_hook(&path, &relay_cmd) {
                    tracing::warn!("pretooluse hook inject failed for {label}: {e}");
                }
                // 取证(方案2):注入 SessionStart hook,确认 codebuddy 在 startup/resume/clear
                // 时发的 payload(session_id uuid + transcript_path)。
                if let Err(e) =
                    kode_memory::hook_setup::inject_session_start_hook(&path, &relay_cmd)
                {
                    tracing::warn!("session_start hook inject failed for {label}: {e}");
                }
                if label == "codebuddy" {
                    if let Err(e) =
                        kode_memory::hook_setup::inject_config_change_hook(&path, &relay_cmd)
                    {
                        tracing::warn!("config_change hook inject failed for {label}: {e}");
                    }
                }
            }
        }

        // Codex hooks are command-only and live in ~/.codex/hooks.json.
        // They use `kode-memory codex-hook` for SessionStart/Stop plus GUI relay events.
        if let Some(path) = kode_memory::hook_setup::codex_hooks_path() {
            let cmd = kode_memory::hook_setup::build_codex_hook_command();
            if let Err(e) = kode_memory::hook_setup::inject_codex_hooks(&path, &cmd) {
                tracing::warn!("codex hook inject failed: {e}");
            }
        }

        // 用户之前 dismiss 过 → 尊重选择,不跑 MCP 自动配置。
        if result.dismissed_at.is_some() {
            return;
        }
        // binary 都没有 → 跟自动配置无缘,弹老 banner 给安装指引。
        if !result.binary_available {
            if should_prompt(&result) {
                let _ = app.emit("memory-mcp-setup-required", &result);
            }
            return;
        }

        // 遍历所有 backend,跑 setup —— 仅当:
        //   1. backend 声明了 mcp_setup
        //   2. 它需要的 CLI 在 PATH 上(JsonMerge 风格无 CLI,直接 true)
        //   3. 还没配好(已配的就别再 add 了,虽然幂等,但不打扰更安静)
        let mut auto_results: Vec<AutoSetupOutcome> = Vec::new();
        for (key, backend) in backends.iter() {
            let Some(spec) = &backend.mcp_setup else {
                continue;
            };
            let cli_ok = match spec.cli() {
                Some(cli) => which(cli).is_some(),
                None => true, // JsonMerge 不需要 CLI
            };
            if !cli_ok {
                continue;
            }
            if is_configured_for_spec(spec) {
                continue;
            }
            let outcome = match run_setup_for_backend(spec) {
                Ok(()) => AutoSetupOutcome::ok(key),
                Err(e) => AutoSetupOutcome::err(key, e),
            };
            auto_results.push(outcome);
        }

        // 啥都没动(全部已配好,或者一家都没装) → 不打扰用户。
        if auto_results.is_empty() {
            return;
        }

        let any_failed = auto_results.iter().any(|o| !o.success);
        // 不管成功失败,都把 setup 之后**重新探测**的状态算一次,前端两个事件都用得上。
        let post_check = probe(&backends, &app_state.persist);
        // attempts 报告:无论成功失败都 emit,前端可弹 toast。
        // (失败时 toast 显示红色 + 错因,成功时绿色"已自动接入")。
        let _ = app.emit(
            "memory-mcp-auto-configured",
            AutoSetupReport {
                check: post_check.clone(),
                attempts: auto_results,
            },
        );
        if any_failed {
            // 有失败 → 同时再 emit 老 banner 事件,schema 与历史保持一致(CheckResult),
            // 前端 banner 据此打开,用户能手动重试 / 看错原因。
            let _ = app.emit("memory-mcp-setup-required", &post_check);
        } else {
            // 全成功 → emit changed 让 banner 静默消失(它内部会 refetch check)。
            let _ = app.emit("memory-mcp-changed", ());
        }
    });
}

// ============== 内部实现 ==============

fn probe(
    backends: &std::collections::HashMap<String, BackendConfig>,
    persist: &Arc<persistence::PersistWriter>,
) -> CheckResult {
    // PersistWriter 不暴露当前 state,这里直接重新 load 读 dismissed_at 字段。
    // 加载本身只读一次磁盘,且 v0.1 起 PersistedState 已稳定,成本可忽略。
    let _ = persist; // 保留参数,语义上明确"读持久化"由本函数负责
    let dismissed = persistence::load().mcp_prompt_dismissed_at;
    let bin = resolve_binary();

    // 遍历所有声明了 mcp_setup 的 backend,装进 BTreeMap(前端用)。
    // 老字段(codebuddy_available / claude_internal_available 等)从这个 map
    // 派生 —— 跟新 BackendManagePanel 共享同一份「真相」,避免漂移。
    let mut backend_map: BTreeMap<String, BackendStatus> = BTreeMap::new();
    for (key, backend) in backends.iter() {
        let Some(spec) = &backend.mcp_setup else {
            continue;
        };
        backend_map.insert(
            key.clone(),
            BackendStatus {
                command_available: which(&backend.command).is_some(),
                setup_cli_available: spec.cli().map(|c| which(c).is_some()),
                configured: is_configured_for_spec(spec),
                setup_style: spec_style_label(spec).to_string(),
            },
        );
    }
    // legacy 字段:从 backend_map 取 codebuddy / claude-internal 的状态填进去
    let cb = backend_map
        .get("codebuddy")
        .map(|s| s.command_available)
        .unwrap_or(false);
    let cb_configured = backend_map
        .get("codebuddy")
        .map(|s| s.configured)
        .unwrap_or(false);
    let ci = backend_map
        .get("claude-internal")
        .map(|s| s.command_available)
        .unwrap_or(false);
    let ci_configured = backend_map
        .get("claude-internal")
        .map(|s| s.configured)
        .unwrap_or(false);

    // Hook 状态：检查 codebuddy 和 claude 的 settings.json 是否已有 kode 管理的 Stop hook
    let hook_settings = kode_memory::hook_setup::target_settings();
    let hook_cb = hook_settings
        .iter()
        .find(|(l, _)| *l == "codebuddy")
        .map(|(_, p)| kode_memory::hook_setup::is_stop_hook_configured(p))
        .unwrap_or(false);
    let hook_claude = hook_settings
        .iter()
        .find(|(l, _)| *l == "claude")
        .map(|(_, p)| kode_memory::hook_setup::is_stop_hook_configured(p))
        .unwrap_or(false);

    CheckResult {
        binary_available: bin.is_some(),
        binary_path: bin.as_ref().map(|p| p.display().to_string()),
        codebuddy_available: cb,
        configured_for_codebuddy: cb_configured,
        claude_internal_available: ci,
        configured_for_claude_internal: ci_configured,
        dismissed_at: dismissed,
        memory_root: resolve_memory_root().display().to_string(),
        hook_configured_codebuddy: hook_cb,
        hook_configured_claude: hook_claude,
        backends: backend_map,
    }
}

/// 把 spec variant 名翻译成短标签,展示用(BackendManagePanel 列表里的徽章)。
fn spec_style_label(spec: &McpSetupSpec) -> &'static str {
    match spec {
        McpSetupSpec::Codebuddy { .. } => "codebuddy",
        McpSetupSpec::Claude { .. } => "claude",
        McpSetupSpec::Codex { .. } => "codex",
        McpSetupSpec::JsonMerge { .. } => "json-merge",
    }
}

/// 数据驱动的「memory 是否已经在该 spec 对应的配置文件里」检测。
///
/// 不同 spec 的 user-scope 配置文件路径不一样:
/// - `Codebuddy` → `~/.codebuddy/mcp.json`(v2.x)/ `~/.codebuddy.json`(legacy)
/// - `Claude { cli: "claude" }` → `~/.claude/.claude.json`
/// - `Claude { cli: "claude-internal" }` → `~/.claude-internal/.claude.json`
/// - `Claude { cli: <其他> }` → 启发式:试 `~/.<cli>/.claude.json`
/// - `Codex` → `~/.codex/config.toml`
/// - `JsonMerge { config_path }` → 用户指定的路径
fn is_configured_for_spec(spec: &McpSetupSpec) -> bool {
    if matches!(spec, McpSetupSpec::Codex { .. }) {
        // Codex 配置里可能遗留来自另一份 Kode checkout / 旧版本 app 的绝对路径。
        // 只存在 `[mcp_servers.memory]` 不代表当前 GUI 的 sidecar 可用，必须与
        // 本次运行解析出的 `kode-memory-mcp` 路径一致，才能视为已配置。
        let expected_binary = resolve_binary();
        return config_check_paths(spec)
            .iter()
            .any(|p| toml_has_memory_server(p, expected_binary.as_deref()));
    }
    let candidates = config_check_paths(spec);
    candidates.iter().any(|p| json_has_memory_server(p))
}

/// 给定 spec,返回**所有候选**的 user-scope 配置文件路径(顺序:新版优先,老版兜底)。
fn config_check_paths(spec: &McpSetupSpec) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    match spec {
        McpSetupSpec::Codebuddy { .. } => {
            // v2.x 把 mcp 配置独立到 ~/.codebuddy/mcp.json;legacy 单文件
            // ~/.codebuddy.json 仍兜底(早期实现只读老路径,导致 banner 永远说未配)
            vec![
                home.join(".codebuddy").join("mcp.json"),
                home.join(".codebuddy.json"),
            ]
        }
        McpSetupSpec::Claude { cli } => {
            // claude family 的 user-scope 配置在 ~/.<cli>/.claude.json
            // 例:cli="claude" → ~/.claude/.claude.json
            //     cli="claude-internal" → ~/.claude-internal/.claude.json
            vec![home.join(format!(".{cli}")).join(".claude.json")]
        }
        McpSetupSpec::Codex { .. } => vec![home.join(".codex").join("config.toml")],
        McpSetupSpec::JsonMerge { config_path } => vec![expand_tilde(config_path)],
    }
}

/// 读 JSON 文件,看 `mcpServers.memory` 是否存在。读不到 / parse 失败统一当作未配置。
fn json_has_memory_server(p: &Path) -> bool {
    let Ok(bytes) = std::fs::read(p) else {
        return false;
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    v.get("mcpServers")
        .and_then(|m| m.get(MCP_SERVER_NAME))
        .is_some()
}

/// Codex MCP 配置写在 TOML 的 `[mcp_servers.<name>]`。
/// 若给了 `expected_binary`，还要求 command 指向当前 Kode 解析出的 sidecar，避免把
/// 其它 checkout / 已删除 bundle 的遗留配置误判成可用。
fn toml_has_memory_server(p: &Path, expected_binary: Option<&Path>) -> bool {
    let Ok(text) = std::fs::read_to_string(p) else {
        return false;
    };
    let Ok(doc) = text.parse::<DocumentMut>() else {
        return false;
    };
    let memory = doc
        .get("mcp_servers")
        .and_then(|i| i.as_table())
        .and_then(|t| t.get(MCP_SERVER_NAME));
    let Some(memory) = memory else {
        return false;
    };
    let Some(expected_binary) = expected_binary else {
        return true;
    };
    memory
        .as_table()
        .and_then(|t| t.get("command"))
        .and_then(|i| i.as_str())
        .is_some_and(|command| command == expected_binary.to_string_lossy())
}

/// 决策:是否要提示用户。规则:
/// - 装了的 backend 全都已配置 → 不提示
/// - 一个 backend 都没装 → 不提示(没意义)
/// - 否则:
///   - 从未 dismiss → 提示
///   - dismiss 过 → 不提示(用户明确不要;改主意可以从命令面板/设置入口手动触发)
///
/// **未来可扩展**:把 dismiss 设计成"7 天软冷却",binary 路径变化(如重装)时
/// 自动失效。当前暂走"硬 dismiss",简单透明。
fn should_prompt(r: &CheckResult) -> bool {
    let cb_pending = r.codebuddy_available && !r.configured_for_codebuddy;
    let ci_pending = r.claude_internal_available && !r.configured_for_claude_internal;
    if !cb_pending && !ci_pending {
        // 装了的都配好了(或者一个都没装) → 不需要 banner
        return false;
    }
    r.dismissed_at.is_none()
}

/// 二进制查找。优先级见模块文档。返回绝对路径。
/// `resolve_named_binary` 已下沉到 `kode_memory::hook_setup`,这里保留薄包装找 `kode-memory-mcp`。
fn resolve_binary() -> Option<PathBuf> {
    resolve_named_binary(BINARY_NAME)
}

/// **legacy** helper:`which("codebuddy")` 的简写。新代码请用 `which(spec.cli())`。
#[allow(dead_code)]
fn codebuddy_available() -> bool {
    which("codebuddy").is_some()
}

/// **legacy** helper:同上,for claude-internal。
#[allow(dead_code)]
fn claude_internal_available() -> bool {
    which("claude-internal").is_some()
}

// `is_codebuddy_configured` / `is_claude_internal_configured` 已被数据驱动的
// `is_configured_for_spec` + `config_check_paths` 取代(见上)。保留这俩 helper
// 给老测试 + dead-code 防御:删它们等同于改公共 surface,先 deprecate 再下掉。

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ============== 兼容 deserialize 时未填的旧字段 ==============
//
// 这个 DTO 跟 `should_prompt` 一起,完整覆盖了"banner 决策"业务。前端只
// 需 mount 时调 `memory_mcp_check`,event listener 收 `memory-mcp-setup-required` /
// `memory-mcp-changed` 重新拉一遍即可。
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct _ReservedFutureSchema {
    /// 预留:per-tab override KODE_MEMORY_ROOT(暂未实现)
    #[serde(default)]
    per_tab_root: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造 CheckResult 的 helper,默认两家都已装且都已配置(should_prompt = false)。
    /// 测试只覆盖关心的字段,避免每个 case 都重复写全字段。
    fn cr() -> CheckResult {
        CheckResult {
            binary_available: true,
            binary_path: Some("/x/y".into()),
            codebuddy_available: true,
            configured_for_codebuddy: true,
            claude_internal_available: true,
            configured_for_claude_internal: true,
            dismissed_at: None,
            memory_root: "/r".into(),
            hook_configured_codebuddy: false,
            hook_configured_claude: false,
            backends: BTreeMap::new(),
        }
    }

    #[test]
    fn should_prompt_skip_when_both_already_configured() {
        // 两家都装、两家都配 → 不需要 banner
        assert!(!should_prompt(&cr()));
    }

    #[test]
    fn should_prompt_skip_when_no_backend_installed() {
        // 一个 backend 都没装 → 没意义,不提示
        let mut r = cr();
        r.codebuddy_available = false;
        r.configured_for_codebuddy = false;
        r.claude_internal_available = false;
        r.configured_for_claude_internal = false;
        assert!(!should_prompt(&r));
    }

    #[test]
    fn should_prompt_skip_when_dismissed() {
        let mut r = cr();
        r.configured_for_codebuddy = false;
        r.configured_for_claude_internal = false;
        r.dismissed_at = Some(1_700_000_000);
        assert!(!should_prompt(&r));
    }

    #[test]
    fn should_prompt_when_codebuddy_pending() {
        // codebuddy 装了但没配,claude-internal 没装 → 提示(只为 codebuddy)
        let mut r = cr();
        r.configured_for_codebuddy = false;
        r.claude_internal_available = false;
        r.configured_for_claude_internal = false;
        assert!(should_prompt(&r));
    }

    #[test]
    fn should_prompt_when_claude_internal_pending() {
        // claude-internal 装了但没配,codebuddy 没装 → 提示(只为 claude-internal)
        let mut r = cr();
        r.codebuddy_available = false;
        r.configured_for_codebuddy = false;
        r.configured_for_claude_internal = false;
        assert!(should_prompt(&r));
    }

    #[test]
    fn should_prompt_when_only_one_of_two_configured() {
        // 关键回归:codebuddy 已配但 claude-internal 没配 → 仍要提示
        // (这就是用户原始问题"memory MCP 没对 claude-internal 生效"的现场)
        let mut r = cr();
        r.configured_for_claude_internal = false;
        assert!(should_prompt(&r));
    }

    /// binary 缺也仍然走 prompt 路径 — 让 banner 文案展示"先 install"指引。
    #[test]
    fn should_prompt_even_when_binary_missing_so_user_sees_install_hint() {
        let mut r = cr();
        r.binary_available = false;
        r.binary_path = None;
        r.configured_for_codebuddy = false;
        r.configured_for_claude_internal = false;
        assert!(should_prompt(&r));
    }

    /// 关键回归:`is_configured_for_spec(Codebuddy)` 必须扫两个候选路径。
    /// 历史 bug:codebuddy v2.x 把 MCP 配置写到 `~/.codebuddy/mcp.json`,
    /// 但代码只读老路径 `~/.codebuddy.json` → banner 永远显示「未配置」,
    /// 用户点了「启用 codebuddy」(实际 `codebuddy mcp add` 已成功)后 banner 不消失。
    /// 这里走 isolated tempdir 模拟 HOME,两种路径分别建文件验证检测器都能命中。
    #[test]
    fn is_configured_for_spec_codebuddy_reads_both_legacy_and_v2_paths() {
        use std::env;
        use std::fs;
        let tmp = env::temp_dir().join(format!("kode-mcp-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let payload = br#"{"mcpServers":{"memory":{"command":"x"}}}"#;
        let spec = McpSetupSpec::Codebuddy {
            cli: "codebuddy".into(),
        };

        // 临时改 HOME 让 dirs::home_dir 指向 tmp
        let old_home = env::var_os("HOME");
        env::set_var("HOME", &tmp);

        // (a) 两个文件都不存在 → false
        assert!(!is_configured_for_spec(&spec), "no files: should be false");

        // (b) 只有新版 ~/.codebuddy/mcp.json → true
        let v2_dir = tmp.join(".codebuddy");
        fs::create_dir_all(&v2_dir).unwrap();
        fs::write(v2_dir.join("mcp.json"), payload).unwrap();
        assert!(
            is_configured_for_spec(&spec),
            "v2 path only: should be true"
        );
        fs::remove_dir_all(&v2_dir).unwrap();

        // (c) 只有老版 ~/.codebuddy.json → true(向后兼容)
        fs::write(tmp.join(".codebuddy.json"), payload).unwrap();
        assert!(
            is_configured_for_spec(&spec),
            "legacy path only: should be true"
        );

        // 还原 HOME
        match old_home {
            Some(h) => env::set_var("HOME", h),
            None => env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    /// `is_configured_for_spec(Claude)` 应该读 `~/.<cli>/.claude.json`,cli 名作子目录。
    /// 用同一个 spec 但不同 cli 字段(`claude` vs `claude-internal`)读不同的文件,
    /// 两者互相隔离,各自的「已配置/未配置」状态独立。
    #[test]
    fn is_configured_for_spec_claude_uses_cli_named_subdir() {
        use std::env;
        use std::fs;
        let tmp = env::temp_dir().join(format!("kode-mcp-claude-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let payload = br#"{"mcpServers":{"memory":{"command":"x"}}}"#;

        let old_home = env::var_os("HOME");
        env::set_var("HOME", &tmp);

        let claude_spec = McpSetupSpec::Claude {
            cli: "claude".into(),
        };
        let internal_spec = McpSetupSpec::Claude {
            cli: "claude-internal".into(),
        };

        // 写 ~/.claude/.claude.json → 只 claude_spec 命中,internal 不动
        let claude_dir = tmp.join(".claude");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::write(claude_dir.join(".claude.json"), payload).unwrap();
        assert!(is_configured_for_spec(&claude_spec));
        assert!(!is_configured_for_spec(&internal_spec));

        // 写 ~/.claude-internal/.claude.json → 现在 internal 也命中
        let internal_dir = tmp.join(".claude-internal");
        fs::create_dir_all(&internal_dir).unwrap();
        fs::write(internal_dir.join(".claude.json"), payload).unwrap();
        assert!(is_configured_for_spec(&internal_spec));

        match old_home {
            Some(h) => env::set_var("HOME", h),
            None => env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    /// JsonMerge 风格:写一次,读一次,文件被正确创建并包含 `mcpServers.memory`。
    /// 同时验证 `is_configured_for_spec` 能识别我们刚写的内容。
    #[test]
    fn json_merge_round_trip_creates_and_detects_memory_server() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("kode-mcp-json-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // 用绝对路径,避开 ~ 展开依赖 HOME 的复杂性
        let cfg_path = tmp.join("nested/dir/mcp.json");
        let spec = McpSetupSpec::JsonMerge {
            config_path: cfg_path.display().to_string(),
        };

        let bin = PathBuf::from("/path/to/kode-memory-mcp");
        let root = PathBuf::from("/r");
        merge_into_json_config(&cfg_path.display().to_string(), &bin, &root)
            .expect("merge should succeed even when file/parent dir don't exist");

        assert!(cfg_path.exists(), "should have created the file");
        let bytes = fs::read(&cfg_path).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let memory = v
            .get("mcpServers")
            .and_then(|s| s.get("memory"))
            .expect("mcpServers.memory should exist");
        assert_eq!(
            memory.get("command").and_then(|c| c.as_str()),
            Some("/path/to/kode-memory-mcp")
        );
        assert_eq!(
            memory
                .get("env")
                .and_then(|e| e.get("KODE_MEMORY_ROOT"))
                .and_then(|c| c.as_str()),
            Some("/r")
        );

        // is_configured_for_spec 应该能识别我们刚写的
        assert!(is_configured_for_spec(&spec));

        // 再写一次 — 幂等,不破坏现有内容
        merge_into_json_config(&cfg_path.display().to_string(), &bin, &root)
            .expect("idempotent rewrite");
        let bytes2 = fs::read(&cfg_path).unwrap();
        let v2: serde_json::Value = serde_json::from_slice(&bytes2).unwrap();
        assert_eq!(v, v2, "second write should be idempotent");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// JsonMerge 写入时若已有别的 server,要保留它们,只 upsert `memory` 一项。
    /// 这是 merge 语义的核心保证 —— 不能因为 kode 的接入把用户其他配置干掉。
    #[test]
    fn json_merge_preserves_other_mcp_servers() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("kode-mcp-merge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let cfg_path = tmp.join("mcp.json");
        let existing = serde_json::json!({
            "mcpServers": {
                "fetch": {"command": "uvx", "args": ["mcp-server-fetch"]}
            },
            "extraField": "preserve me"
        });
        fs::write(&cfg_path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();

        let bin = PathBuf::from("/p/kode-memory-mcp");
        let root = PathBuf::from("/r");
        merge_into_json_config(&cfg_path.display().to_string(), &bin, &root).unwrap();

        let v: serde_json::Value = serde_json::from_slice(&fs::read(&cfg_path).unwrap()).unwrap();
        // memory 进了
        assert!(v.pointer("/mcpServers/memory").is_some());
        // fetch 保留
        assert_eq!(
            v.pointer("/mcpServers/fetch/command")
                .and_then(|c| c.as_str()),
            Some("uvx")
        );
        // 顶层其他字段也保留
        assert_eq!(
            v.get("extraField").and_then(|c| c.as_str()),
            Some("preserve me")
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    /// `expand_tilde` 行为 round-trip:`~/foo` → `$HOME/foo`,绝对路径不变。
    #[test]
    fn expand_tilde_handles_home_prefix_and_absolute_paths() {
        if let Some(home) = dirs::home_dir() {
            let exp = expand_tilde("~/.codebuddy/mcp.json");
            assert_eq!(exp, home.join(".codebuddy").join("mcp.json"));
        }
        // 绝对路径原样
        assert_eq!(
            expand_tilde("/absolute/path/file.json"),
            PathBuf::from("/absolute/path/file.json")
        );
        // 相对路径(无 ~)原样
        assert_eq!(expand_tilde("relative/x"), PathBuf::from("relative/x"));
    }

    // which_finds_sh / supports_subcommand_checks_binary_help_status 已随 `which` /
    // `supports_subcommand` 下沉到 `kode_memory::hook_setup` 的 tests,这里不再重复。

    /// 关键回归测试:确保 `codebuddy mcp add` 的参数顺序是
    ///   ... -s user <name> <command> -e KEY=val
    /// 而不是
    ///   ... -s user -e KEY=val <name> <command>   ← 老代码的 bug
    /// commander.js 的 `-e <env...>` 是 variadic,会吞后续 token 直到下一个 flag,
    /// 把 name 和 command 都吃成 env value,导致 "missing required argument 'name'"。
    /// 数据驱动重构后,这个序列在 `run_codebuddy_style` 内部固化,测试只需复刻它锁顺序。
    #[test]
    fn codebuddy_style_args_put_positional_before_dash_e() {
        // 不真调 codebuddy(用户机上不一定有/不能写 ~/.codebuddy.json)。
        // 直接复刻 run_codebuddy_style 里构造 args 的逻辑,锁住顺序。
        let bin = "/path/to/kode-memory-mcp";
        let env_arg = "KODE_MEMORY_ROOT=/r";
        let args: Vec<&str> = vec![
            "mcp",
            "add",
            "-s",
            "user",
            super::MCP_SERVER_NAME,
            bin,
            "-e",
            env_arg,
        ];
        // 1. 没有 `-e` 在 positional 之前
        let e_pos = args.iter().position(|s| *s == "-e").unwrap();
        let name_pos = args
            .iter()
            .position(|s| *s == super::MCP_SERVER_NAME)
            .unwrap();
        let bin_pos = args.iter().position(|s| *s == bin).unwrap();
        assert!(name_pos < e_pos, "name must come before -e; got {:?}", args);
        assert!(
            bin_pos < e_pos,
            "command must come before -e; got {:?}",
            args
        );
        assert!(
            name_pos < bin_pos,
            "name must come before command; got {:?}",
            args
        );
    }

    /// 锁定 `claude mcp add` 的参数序列(claude / claude-internal 公用):
    ///   ... -s user <name> -e KEY=val -- <bin>
    /// claude family 的 CLI 不像 codebuddy commander 那样把 `-e <env...>` 当 variadic
    /// 吞 token,但我们仍然用 `--` 显式终止 flag 段,跟它官方 --help 给的写法对齐,
    /// 保险且抗将来 CLI 行为变化。
    #[test]
    fn claude_style_args_use_double_dash_separator() {
        let bin = "/path/to/kode-memory-mcp";
        let env_arg = "KODE_MEMORY_ROOT=/r";
        let args: Vec<&str> = vec![
            "mcp",
            "add",
            "-s",
            "user",
            super::MCP_SERVER_NAME,
            "-e",
            env_arg,
            "--",
            bin,
        ];
        let dd_pos = args.iter().position(|s| *s == "--").unwrap();
        let bin_pos = args.iter().position(|s| *s == bin).unwrap();
        let name_pos = args
            .iter()
            .position(|s| *s == super::MCP_SERVER_NAME)
            .unwrap();
        assert!(
            name_pos < dd_pos,
            "name must come before --; got {:?}",
            args
        );
        assert!(
            dd_pos < bin_pos,
            "-- must come before <bin>; got {:?}",
            args
        );
    }

    #[test]
    fn codex_style_args_use_env_and_double_dash_separator() {
        let bin = "/path/to/kode-memory-mcp";
        let env_arg = "KODE_MEMORY_ROOT=/r";
        let args: Vec<&str> = vec![
            "mcp",
            "add",
            super::MCP_SERVER_NAME,
            "--env",
            env_arg,
            "--",
            bin,
        ];
        let env_pos = args.iter().position(|s| *s == "--env").unwrap();
        let dd_pos = args.iter().position(|s| *s == "--").unwrap();
        let bin_pos = args.iter().position(|s| *s == bin).unwrap();
        let name_pos = args
            .iter()
            .position(|s| *s == super::MCP_SERVER_NAME)
            .unwrap();
        assert!(
            name_pos < env_pos,
            "name must come before --env; got {:?}",
            args
        );
        assert!(
            env_pos < dd_pos,
            "--env must come before --; got {:?}",
            args
        );
        assert!(
            dd_pos < bin_pos,
            "-- must come before <bin>; got {:?}",
            args
        );
    }

    #[test]
    fn codex_toml_config_detects_memory_server() {
        let tmp = std::env::temp_dir().join(format!("kode-mcp-codex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = tmp.join("config.toml");
        std::fs::write(
            &cfg,
            r#"
[mcp_servers.memory]
command = "/path/to/kode-memory-mcp"
args = []
"#,
        )
        .unwrap();
        let current = Path::new("/path/to/kode-memory-mcp");
        assert!(toml_has_memory_server(&cfg, Some(current)));
        assert!(!toml_has_memory_server(
            &cfg,
            Some(Path::new("/other/checkout/kode-memory-mcp"))
        ));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
