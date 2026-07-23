//! Backend 管理 tauri commands(2026-06)。
//!
//! 三个职责:
//!
//! 1. **CRUD on `~/.config/kode/config.toml`**:`backend_save` / `backend_delete`
//!    用 `toml_edit` 做 read-modify-write,保留用户的注释和顺序(普通 toml crate
//!    走 parse-then-stringify 会丢这些)。
//!
//! 2. **自动探测内置已知 CLI**:`detect_known_backends` 在 PATH 上扫一遍写死的
//!    candidate 列表(codebuddy / claude / claude-internal / codex),命中的返回
//!    `DetectedBackend`,前端用来弹「检测到 X,要加吗?」对话框。
//!    **范围被刻意限制**(不扫所有 PATH 上跑得了 `mcp add` 的工具) —— 用户已经
//!    答复:false-positive 太烦,不要那条路。
//!
//! 3. **变更通知**:写盘后 emit `backends-changed`(payload 空),同时更新运行时
//!    backend snapshot,前端可以立即重新拉 `list_backends`。`ctx.config` 仍保留
//!    启动时的其他全局配置,backend CRUD 走独立的可刷新 snapshot。

use std::path::PathBuf;

use kode_core::config::{BackendConfig, McpSetupSpec};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use toml_edit::{value, Array, DocumentMut, Item, Table};

use crate::state::AppState;

/// 写盘 / 自动探测时使用的 backend candidate 列表。**只有这几个**会被
/// `detect_known_backends` 扫到,跟用户在 plan 阶段确认的「只在内置列表里扫」
/// 决策对齐。新增 candidate 需要发版 — 主动减小自动探测的攻击面 / 误报。
const KNOWN_CANDIDATES: &[KnownBackend] = &[
    KnownBackend {
        key: "codebuddy",
        command: "codebuddy",
        suggested_setup_style: "codebuddy",
        suggested_setup_cli: "codebuddy",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "claude",
        command: "claude",
        suggested_setup_style: "claude",
        suggested_setup_cli: "claude",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "claude-internal",
        command: "claude-internal",
        suggested_setup_style: "claude",
        suggested_setup_cli: "claude-internal",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "codex",
        command: "codex",
        suggested_setup_style: "codex",
        suggested_setup_cli: "codex",
        suggested_json_path: None,
    },
    // 2026-06:预置一批常见 AI CLI(参考 kooky)。这些大多不是 codebuddy/claude fork,
    // 没有 mcp_setup 风格,所以 suggested_setup_style = "none"。
    KnownBackend {
        key: "gemini",
        command: "gemini",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "opencode",
        command: "opencode",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "amp",
        command: "amp",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "cursor",
        command: "cursor-agent",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "copilot",
        command: "copilot",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "grok",
        command: "grok",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "antigravity",
        command: "agy",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "kimi",
        command: "kimi",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "pi",
        command: "pi",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "kiro",
        command: "kiro-cli",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
    KnownBackend {
        key: "droid",
        command: "droid",
        suggested_setup_style: "none",
        suggested_setup_cli: "",
        suggested_json_path: None,
    },
];

struct KnownBackend {
    key: &'static str,
    command: &'static str,
    suggested_setup_style: &'static str,
    suggested_setup_cli: &'static str,
    suggested_json_path: Option<&'static str>,
}

/// 给前端的「检测到」DTO。`already_in_config` 让前端能区分「装了但未加」/「已加过」。
#[derive(Debug, Clone, Serialize)]
pub struct DetectedBackend {
    /// 默认 backend key(用户可改)
    pub suggested_key: String,
    /// PATH 上的真实绝对路径(给用户审核 — 防钓鱼装错版本)
    pub command_path: String,
    /// CLI 名(用户填进 BackendConfig.command,通常和 key 一样)
    pub command: String,
    /// 推荐的 mcp_setup 风格("codebuddy" / "claude" / "codex" / "json-merge")
    pub suggested_setup_style: String,
    /// 推荐的 mcp_setup.cli(对 json-merge 风格此字段为空)
    pub suggested_setup_cli: String,
    /// 推荐的 mcp_setup.config_path(仅 json-merge 风格)
    pub suggested_json_path: Option<String>,
    /// 当前 config 里已经存在同 key — 前端可以提示「已加过」并禁用「添加」按钮
    pub already_in_config: bool,
}

/// 扫 PATH,返回内置已知 candidate 中**已安装**的那些,附带「是否已在配置里」信号。
/// 前端用这个数据驱动 BackendManagePanel 的「自动探测」按钮。
#[tauri::command]
pub fn detect_known_backends(state: State<'_, AppState>) -> Vec<DetectedBackend> {
    let existing_keys: std::collections::HashSet<String> =
        state.ctx.backend_configs.read().keys().cloned().collect();
    KNOWN_CANDIDATES
        .iter()
        .filter_map(|c| {
            let path = which(c.command)?;
            Some(DetectedBackend {
                suggested_key: c.key.into(),
                command_path: path.display().to_string(),
                command: c.command.into(),
                suggested_setup_style: c.suggested_setup_style.into(),
                suggested_setup_cli: c.suggested_setup_cli.into(),
                suggested_json_path: c.suggested_json_path.map(|s| s.into()),
                already_in_config: existing_keys.contains(c.key),
            })
        })
        .collect()
}

/// 前端传过来的「保存 backend」DTO。比 `BackendConfig` 多一个 `key`(配置 table 名)。
/// `mcp_setup` 部分是扁平结构,后端拼成 `McpSetupSpec` enum。
#[derive(Debug, Clone, Deserialize)]
pub struct BackendSaveRequest {
    /// `[backends.<key>]` 里的 key
    pub key: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub model_flag: Option<String>,
    #[serde(default)]
    pub permission_mode_flag: Option<String>,
    /// 扁平的 mcp setup 字段 — 前端表单更易填
    #[serde(default)]
    pub setup_style: Option<String>,
    #[serde(default)]
    pub setup_cli: Option<String>,
    #[serde(default)]
    pub setup_json_path: Option<String>,
    /// 是否启用(在 BackendChooser 展示)。None = 保留「待探测」语义不写盘;
    /// Some(bool) = 写入显式开关。后端 save 时透传到 BackendConfig。
    #[serde(default)]
    pub enabled: Option<bool>,
}

impl BackendSaveRequest {
    /// 把扁平字段拼成 `Option<McpSetupSpec>`,失败给清晰错因。
    fn build_spec(&self) -> Result<Option<McpSetupSpec>, String> {
        match self.setup_style.as_deref() {
            None | Some("") | Some("none") => Ok(None),
            Some("codebuddy") => {
                let cli = self
                    .setup_cli
                    .clone()
                    .filter(|s| !s.is_empty())
                    .ok_or("codebuddy style requires setup_cli")?;
                Ok(Some(McpSetupSpec::Codebuddy { cli }))
            }
            Some("claude") => {
                let cli = self
                    .setup_cli
                    .clone()
                    .filter(|s| !s.is_empty())
                    .ok_or("claude style requires setup_cli")?;
                Ok(Some(McpSetupSpec::Claude { cli }))
            }
            Some("codex") => {
                let cli = self
                    .setup_cli
                    .clone()
                    .filter(|s| !s.is_empty())
                    .ok_or("codex style requires setup_cli")?;
                Ok(Some(McpSetupSpec::Codex { cli }))
            }
            Some("json-merge") => {
                let path = self
                    .setup_json_path
                    .clone()
                    .filter(|s| !s.is_empty())
                    .ok_or("json-merge style requires setup_json_path")?;
                Ok(Some(McpSetupSpec::JsonMerge { config_path: path }))
            }
            Some(other) => Err(format!("unknown setup_style: {other}")),
        }
    }

    /// 转成 `BackendConfig`(供前端测试 / dry-run 使用)。
    #[allow(dead_code)]
    fn into_backend_config(self) -> Result<BackendConfig, String> {
        let spec = self.build_spec()?;
        Ok(BackendConfig {
            command: self.command,
            args: self.args,
            default_model: self.default_model,
            model_flag: self.model_flag,
            permission_mode_flag: self.permission_mode_flag,
            mcp_setup: spec,
            enabled: self.enabled,
        })
    }
}

/// 创建 / 更新 backend 配置。read-modify-write `~/.config/kode/config.toml`,
/// 用 `toml_edit` 保留用户已有注释和其他配置项。失败时不写文件。
///
/// 写盘后同步运行时 backend snapshot 并 emit `backends-changed`,新 tab 无需重启即可使用。
#[tauri::command]
pub fn backend_save(
    request: BackendSaveRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if request.key.is_empty() {
        return Err("backend key cannot be empty".into());
    }
    if request.command.is_empty() {
        return Err("backend command cannot be empty".into());
    }
    let key = request.key.clone();
    let mut backend = request
        .clone()
        .into_backend_config()
        .map_err(|e| format!("invalid backend config: {e}"))?;

    // 编辑表单为了兼容旧配置可能把 enabled 留成 None;保留已有显式开关,
    // 避免保存其它字段时意外把 backend 重新打开。
    if backend.enabled.is_none() {
        backend.enabled = state
            .ctx
            .backend_configs
            .read()
            .get(&key)
            .and_then(|existing| existing.enabled);
    }

    let path = config_toml_path(&state)?;
    let mut doc = load_or_init_doc(&path)?;
    upsert_backend_table(&mut doc, &key, &backend);
    write_doc(&path, &doc)?;

    state
        .ctx
        .backend_configs
        .write()
        .insert(key.clone(), backend);

    let _ = app.emit("backends-changed", ());
    Ok(())
}

/// 删除指定 backend。同样 read-modify-write,删 `[backends.<key>]` table。
/// 不存在不报错(让前端可以「确保删除」式调用)。
#[tauri::command]
pub fn backend_delete(
    key: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("backend key cannot be empty".into());
    }
    let path = config_toml_path(&state)?;
    if !path.exists() {
        // 没文件 → 不存在,直接 emit 完事
        let _ = app.emit("backends-changed", ());
        return Ok(());
    }
    let mut doc = load_or_init_doc(&path)?;
    if let Some(backends) = doc.get_mut("backends").and_then(|i| i.as_table_mut()) {
        backends.remove(&key);
    }
    write_doc(&path, &doc)?;
    state.ctx.backend_configs.write().remove(&key);
    let _ = app.emit("backends-changed", ());
    Ok(())
}

// ============== 私有 helpers ==============

/// 设置单个 backend 的 enabled 开关。RMW `config.toml`:改 `doc[backends][key][enabled]`,
/// 保留其他字段 / 其他 backend / 注释。
///
/// **table 不存在时自动创建**(从内存里的 `BackendConfig` 完整物化一份再设 enabled)——
/// 因为首次启动时 config.toml 里可能根本没有这个 backend(它只存在于内置默认列表),
/// 用户却需要能直接在 Settings 里关掉它。早期版本在此报错,导致开关全部点不动。
/// 写盘后 emit `backends-changed`,运行时 backend snapshot 立即同步。
#[tauri::command]
pub fn backend_set_enabled(
    key: String,
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if key.is_empty() {
        return Err("backend key cannot be empty".into());
    }
    let path = config_toml_path(&state)?;
    let mut doc = load_or_init_doc(&path)?;

    let table_exists = doc
        .get("backends")
        .and_then(|i| i.as_table())
        .map(|t| t.contains_key(&key))
        .unwrap_or(false);

    if table_exists {
        // 已有 table:surgical 只改 enabled,不动其他字段。
        let backend_table = doc
            .get_mut("backends")
            .and_then(|i| i.as_table_mut())
            .and_then(|t| t.get_mut(&key))
            .and_then(|i| i.as_table_mut())
            .expect("table_exists checked above");
        backend_table.insert("enabled", value(enabled));
    } else {
        // 文件里没有 → 从内存默认物化一份完整 table 再设 enabled。
        let cfg = state
            .ctx
            .backend_configs
            .read()
            .get(&key)
            .cloned()
            .ok_or_else(|| format!("backend '{key}' not found"))?;
        let mut materialized = cfg;
        materialized.enabled = Some(enabled);
        upsert_backend_table(&mut doc, &key, &materialized);
    }

    write_doc(&path, &doc)?;
    if let Some(cfg) = state.ctx.backend_configs.write().get_mut(&key) {
        cfg.enabled = Some(enabled);
    }
    let _ = app.emit("backends-changed", ());
    Ok(())
}

/// 首次启动探测落地:遍历**内存里的全部 backend**(含内置默认列表),对
/// `enabled == None` 的 backend 按 PATH 探测 `command`,命中 → 写 `enabled = true`,
/// 未命中 → `enabled = false`,**并把整条 backend 物化进 config.toml**(table 不存在
/// 就创建)。已是 `Some(_)` 的不动(用户手改 / 之前探测过)。
///
/// 设计要点:
/// - **不依赖 config.toml 是否已存在该 backend** —— 内置默认 backend 首次启动时
///   多半还没落盘,这里负责把探测结果连同 backend 定义一起写下去,这样:
///   ① BackendChooser 下次启动只看到已安装的;② Settings 的开关有 table 可改。
/// - 只对 `enabled == None` 的项动手,用户在 Settings 设过的 `Some` 永不被覆盖。
/// - 用 `toml_edit` 保留已有注释 / 其他字段。
/// - 返回是否有改动。无 None 项 → 不写盘。
pub fn resolve_pending_enabled(state: &State<'_, AppState>) -> Result<bool, String> {
    let path = config_toml_path(state)?;
    let mut doc = load_or_init_doc(&path)?;
    let mut changed = false;

    // 遍历运行时 backend snapshot,稳定顺序方便测试 / 阅读。
    let mut entries: Vec<(String, BackendConfig)> = state
        .ctx
        .backend_configs
        .read()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    for (key, cfg) in entries {
        // 用户 / 之前探测已定 → 跳过。
        if cfg.enabled.is_some() {
            continue;
        }
        let installed = which(&cfg.command).is_some();

        // 文件里已有该 table → 只补 enabled 字段(保留用户其他字段)。
        let has_table = doc
            .get("backends")
            .and_then(|i| i.as_table())
            .map(|t| t.contains_key(&key))
            .unwrap_or(false);

        if has_table {
            if let Some(t) = doc
                .get_mut("backends")
                .and_then(|i| i.as_table_mut())
                .and_then(|t| t.get_mut(&key))
                .and_then(|i| i.as_table_mut())
            {
                // 只在文件里还没写过 enabled 时补(避免覆盖手编值)。
                if !t.contains_key("enabled") {
                    t.insert("enabled", value(installed));
                    changed = true;
                }
            }
        } else {
            // 文件里没有 → 物化整条 backend 定义 + enabled。
            let mut materialized = cfg;
            materialized.enabled = Some(installed);
            upsert_backend_table(&mut doc, &key, &materialized);
            changed = true;
        }
    }

    if changed {
        write_doc(&path, &doc)?;
    }
    Ok(changed)
}

/// 读 config.toml,返回每个 backend key 的 `enabled` 字段实时值(文件没写过该字段 → None)。
/// 命令层(`list_backends` / `list_all_backends`)用它覆盖冷快照,这样开关 / 探测落地
/// 写盘后**当前进程立刻反映正确状态**,无需重启。文件 / 解析失败 → 空 map(回落冷快照)。
pub fn read_enabled_overrides(
    state: &State<'_, AppState>,
) -> std::collections::HashMap<String, bool> {
    let mut out = std::collections::HashMap::new();
    let path = match config_toml_path(state) {
        Ok(p) => p,
        Err(_) => return out,
    };
    let doc = match load_or_init_doc(&path) {
        Ok(d) => d,
        Err(_) => return out,
    };
    if let Some(backends) = doc.get("backends").and_then(|i| i.as_table()) {
        for (key, item) in backends.iter() {
            if let Some(t) = item.as_table() {
                if let Some(b) = t.get("enabled").and_then(|v| v.as_bool()) {
                    out.insert(key.to_string(), b);
                }
            }
        }
    }
    out
}

/// 解析当前生效的 config.toml 路径。优先级和 `Config::load` 一致:
///   1. AppState.ctx.config_path 的 override(用户在 PathsBanner 设过)
///   2. dirs::config_dir()/kode/config.toml
fn config_toml_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    if let Some(p) = state.ctx.config_path.lock().clone() {
        return Ok(p);
    }
    dirs::config_dir()
        .map(|d| d.join("kode").join("config.toml"))
        .ok_or_else(|| "cannot resolve user config dir".into())
}

/// 读 toml_edit Document;文件不存在或为空 → 用空白 document 起步。
fn load_or_init_doc(path: &std::path::Path) -> Result<DocumentMut, String> {
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let txt = std::fs::read_to_string(path)
        .map_err(|e| format!("read {} failed: {e}", path.display()))?;
    txt.parse::<DocumentMut>()
        .map_err(|e| format!("parse {} failed: {e}", path.display()))
}

/// atomic write:.tmp 写完再 rename,保证半个写入不会留下损坏文件。
/// 父目录不存在自动 mkdir -p(用户首次保存时 ~/.config/kode/ 可能不存在)。
fn write_doc(path: &std::path::Path, doc: &DocumentMut) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {} failed: {e}", parent.display()))?;
        }
    }
    let tmp = path.with_extension("tmp.kode");
    std::fs::write(&tmp, doc.to_string())
        .map_err(|e| format!("write {} failed: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} → {} failed: {e}", tmp.display(), path.display()))?;
    Ok(())
}

/// 在 `[backends.<key>]` 下 upsert 这个 backend 的字段。
/// **现有的其他 backend / 顶层字段 / 注释完全不动** — 这是用 toml_edit 而非 toml 的核心动机。
fn upsert_backend_table(doc: &mut DocumentMut, key: &str, backend: &BackendConfig) {
    // 确保有 [backends] 顶层
    let backends = doc
        .entry("backends")
        .or_insert_with(|| Item::Table(Table::new()))
        .as_table_mut()
        .expect("backends must be a table");

    // 用一个全新的 Table 替换该 key 的旧值 — 完整覆盖该 backend 的所有字段。
    // 字段顺序固定为 command → args → 选项,跟 BackendConfig struct 一致便于人读。
    let mut t = Table::new();
    t.insert("command", value(backend.command.as_str()));

    let mut args_arr = Array::new();
    for a in &backend.args {
        args_arr.push(a.as_str());
    }
    t.insert("args", value(args_arr));

    if let Some(m) = &backend.default_model {
        t.insert("default_model", value(m.as_str()));
    }
    if let Some(f) = &backend.model_flag {
        t.insert("model_flag", value(f.as_str()));
    }
    if let Some(f) = &backend.permission_mode_flag {
        t.insert("permission_mode_flag", value(f.as_str()));
    }

    // mcp_setup 是嵌套 table:
    //   [backends.<key>.mcp_setup]
    //   style = "codebuddy"
    //   cli = "..."
    if let Some(spec) = &backend.mcp_setup {
        let mut sub = Table::new();
        match spec {
            McpSetupSpec::Codebuddy { cli } => {
                sub.insert("style", value("codebuddy"));
                sub.insert("cli", value(cli.as_str()));
            }
            McpSetupSpec::Claude { cli } => {
                sub.insert("style", value("claude"));
                sub.insert("cli", value(cli.as_str()));
            }
            McpSetupSpec::Codex { cli } => {
                sub.insert("style", value("codex"));
                sub.insert("cli", value(cli.as_str()));
            }
            McpSetupSpec::JsonMerge { config_path } => {
                sub.insert("style", value("json-merge"));
                sub.insert("config_path", value(config_path.as_str()));
            }
        }
        t.insert("mcp_setup", Item::Table(sub));
    }

    // enabled 仅在 Some 时写 — None 保持「待探测」语义不落盘,避免把
    // 出厂默认固化成显式 true/false 后,首次探测逻辑就再也认不出它了。
    if let Some(b) = backend.enabled {
        t.insert("enabled", value(b));
    }

    backends.insert(key, Item::Table(t));
}

/// 跟 `memory_mcp::which` 同义 —— 这俩模块都需要 PATH 扫描,但**故意不共享**:
/// memory_mcp 是独立关注点(MCP setup),将来可能加 `KODE_MCP_BIN_OVERRIDE` env 之类
/// 的搜索增强而不影响这里。复制一份函数体可以接受。
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(m) = std::fs::metadata(&cand) {
                    if m.permissions().mode() & 0o111 != 0 {
                        return Some(cand);
                    }
                }
            }
            #[cfg(not(unix))]
            {
                return Some(cand);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    /// 关键回归:`upsert_backend_table` 必须**保留**用户写的注释和其他 backend。
    /// 这是 toml_edit 选型的核心理由 —— 普通 toml::to_string 会全删。
    #[test]
    fn upsert_preserves_user_comments_and_other_backends() {
        let original = r#"# user-written header comment
default_backend = "codebuddy"

# Notes about this backend
[backends.codebuddy]
command = "codebuddy"
args = []

[backends.claude]
command = "claude"

[ui]
sidebar_width = 30
"#;
        let mut doc: DocumentMut = original.parse().unwrap();
        let new_backend = BackendConfig {
            command: "/usr/local/bin/codex".into(),
            args: vec!["--no-banner".into()],
            default_model: None,
            model_flag: Some("--model".into()),
            permission_mode_flag: None,
            mcp_setup: Some(McpSetupSpec::JsonMerge {
                config_path: "~/.codex/mcp.json".into(),
            }),
            enabled: None,
        };
        upsert_backend_table(&mut doc, "codex", &new_backend);
        let s = doc.to_string();
        // 用户的 header 注释保留
        assert!(s.contains("# user-written header comment"));
        // 用户的 backend 注释保留
        assert!(s.contains("# Notes about this backend"));
        // 老 backend 还在
        assert!(s.contains("[backends.codebuddy]"));
        assert!(s.contains("[backends.claude]"));
        // 新 backend 写进去了
        assert!(s.contains("[backends.codex]"));
        assert!(s.contains("/usr/local/bin/codex"));
        assert!(s.contains("--no-banner"));
        assert!(s.contains("style = \"json-merge\""));
        assert!(s.contains("config_path = \"~/.codex/mcp.json\""));
        // ui section 也没动
        assert!(s.contains("sidebar_width"));
    }

    /// 重复 upsert 同一个 backend(模拟用户「编辑保存」)→ 完全替换该 backend 字段,
    /// 不会出现「老字段+新字段」的混合。
    #[test]
    fn upsert_replaces_existing_backend_fully() {
        let original = r#"
[backends.foo]
command = "old-command"
args = ["a", "b", "c"]
default_model = "old-model"
model_flag = "--model"
"#;
        let mut doc: DocumentMut = original.parse().unwrap();
        let updated = BackendConfig {
            command: "new-command".into(),
            args: vec![],
            default_model: None,
            model_flag: Some("--m".into()),
            permission_mode_flag: None,
            mcp_setup: None,
            enabled: None,
        };
        upsert_backend_table(&mut doc, "foo", &updated);
        let s = doc.to_string();
        assert!(s.contains("\"new-command\""));
        assert!(!s.contains("old-command"), "old command should be gone");
        assert!(!s.contains("old-model"), "old model should be gone");
        assert!(!s.contains("\"a\""), "old args should be gone");
    }

    /// `backend_delete` 流程:read-modify-write 后,目标 table 被移除,其他保留。
    /// 注:toml_edit 会把附着在被删 table 头上的「前缀注释」(`# foo` 紧接 `[backends.foo]`)
    /// 一起删,因为它视作 table 的 decoration。这个行为符合预期 — 删 backend 顺手清掉
    /// 「关于这个 backend 的注释」更干净。所以测试只断言 sibling backend 与文件级
    /// 注释保留,不检查紧邻被删 table 的注释。
    #[test]
    fn delete_removes_target_table_only() {
        let tmp = env::temp_dir().join(format!("kode-cfg-del-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("config.toml");
        fs::write(
            &path,
            r#"# top-of-file kode config
default_backend = "foo"

[backends.foo]
command = "foo"

[backends.bar]
command = "bar"

[ui]
sidebar_width = 30
"#,
        )
        .unwrap();
        let mut doc = load_or_init_doc(&path).unwrap();
        let backends = doc
            .get_mut("backends")
            .and_then(|i| i.as_table_mut())
            .unwrap();
        backends.remove("foo");
        write_doc(&path, &doc).unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(!after.contains("[backends.foo]"));
        assert!(after.contains("[backends.bar]"));
        // 文件顶部的全局注释保留
        assert!(after.contains("# top-of-file kode config"));
        // ui section 不被波及
        assert!(after.contains("sidebar_width"));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// `BackendSaveRequest::build_spec` 把扁平表单字段拼回 enum,covering 所有分支。
    #[test]
    fn build_spec_handles_all_styles() {
        let none = BackendSaveRequest {
            key: "x".into(),
            command: "x".into(),
            args: vec![],
            default_model: None,
            model_flag: None,
            permission_mode_flag: None,
            setup_style: None,
            setup_cli: None,
            setup_json_path: None,
            enabled: None,
        };
        assert!(none.build_spec().unwrap().is_none());

        let cb = BackendSaveRequest {
            setup_style: Some("codebuddy".into()),
            setup_cli: Some("codebuddy".into()),
            ..none.clone()
        };
        match cb.build_spec().unwrap() {
            Some(McpSetupSpec::Codebuddy { cli }) => assert_eq!(cli, "codebuddy"),
            _ => panic!("expected Codebuddy"),
        }

        let claude = BackendSaveRequest {
            setup_style: Some("claude".into()),
            setup_cli: Some("claude-internal".into()),
            ..none.clone()
        };
        match claude.build_spec().unwrap() {
            Some(McpSetupSpec::Claude { cli }) => assert_eq!(cli, "claude-internal"),
            _ => panic!("expected Claude"),
        }

        let codex = BackendSaveRequest {
            setup_style: Some("codex".into()),
            setup_cli: Some("codex".into()),
            ..none.clone()
        };
        match codex.build_spec().unwrap() {
            Some(McpSetupSpec::Codex { cli }) => assert_eq!(cli, "codex"),
            _ => panic!("expected Codex"),
        }

        let jm = BackendSaveRequest {
            setup_style: Some("json-merge".into()),
            setup_json_path: Some("~/x.json".into()),
            ..none.clone()
        };
        match jm.build_spec().unwrap() {
            Some(McpSetupSpec::JsonMerge { config_path }) => assert_eq!(config_path, "~/x.json"),
            _ => panic!("expected JsonMerge"),
        }

        // 错路径:codebuddy 没填 cli → Err
        let bad = BackendSaveRequest {
            setup_style: Some("codebuddy".into()),
            setup_cli: None,
            ..none.clone()
        };
        assert!(bad.build_spec().is_err());

        // 错路径:json-merge 没填路径 → Err
        let bad2 = BackendSaveRequest {
            setup_style: Some("json-merge".into()),
            setup_json_path: None,
            ..none
        };
        assert!(bad2.build_spec().is_err());
    }
}
