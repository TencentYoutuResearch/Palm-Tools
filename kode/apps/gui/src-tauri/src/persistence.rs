//! 持久化 — 把 tab 列表存盘,下次启动恢复。
//!
//! 路径(macOS):`~/Library/Application Support/kode/state.json`
//! 路径(Linux):`~/.config/kode/state.json`
//!
//! Schema v1:
//! ```json
//! { "version": 1, "tabs": [{ "backend_key": "codebuddy", "title": "...", "cwd": "..." }] }
//! ```
//!
//! 不存:
//! - session_id —— 每次启动子进程都会新生成
//! - tokens / cost —— runtime 状态,重启即重算
//! - vt100 buffer —— 子进程内部状态,跨进程不可恢复
//!
//! 写入策略:debounce 500ms。频繁的 tabs 变更只触发一次写。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use kode_core::EndpointId;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio::time::sleep;

const SCHEMA_VERSION: u32 = 1;
const APP_DIR_NAME: &str = "kode";
const STATE_FILE: &str = "state.json";
const DEBOUNCE_MS: u64 = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTab {
    pub backend_key: String,
    pub title: String,
    /// 用户是否手动重命名过 tab。老 state 没有该字段时按 false 处理。
    #[serde(default)]
    pub title_pinned: bool,
    /// 启动时的 cwd;恢复时 spawn 用同样 cwd 才能保证 jsonl 路径对得上
    pub cwd: String,
    /// 上次会话的 session uuid;恢复时通过 `--resume <sid>` 让子进程加载历史。
    /// v1 → v2 迁移:旧文件没有此字段 → 反序列化为 None,降级成普通 spawn。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 上次保存时的 model 名(jsonl 自动同步,用户在子进程里 `/model` 切换会被回写)。
    /// 老 v1 文件没有 → None,前端走 backend.default_model。
    #[serde(default)]
    pub model: Option<String>,
    /// 用户视角 permission mode 简称:`None` / `"default"` / `"bypass"` 三态。
    /// 启动子进程时 `Session::new` 把 `bypass` 翻译成 `bypassPermissions`,
    /// `default` / `None` 不注入任何 flag。
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// **Phase 11.2** 本 tab 跑的 transport endpoint。`None` / 缺失 = Local
    /// (向后兼容,老 v1 持久化文件没有这字段);`Some(Remote { id })` 表示
    /// 这条 tab 来自远端 endpoint,restore 时通过 `endpoint_id` 找对应 transport。
    #[serde(default)]
    pub endpoint_id: Option<EndpointId>,
    /// 用户选定的 gallery avatar id(null/缺失 = 用 backend icon fallback)。
    /// 老 state.json 没有该字段 → None → restore 时 backend fallback。
    #[serde(default)]
    pub avatar_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedState {
    pub version: u32,
    pub tabs: Vec<PersistedTab>,
    /// 远程桥(Phase 9.1)鉴权 token。首次启动生成 32 字节 hex,
    /// v1 老文件没有 → 反序列化为 None,启动时立即生成并补写。
    #[serde(default)]
    pub bridge_token: Option<String>,
    /// 用户在 GUI 里选定的「session 工作目录」。
    /// `None` = 走默认解析(KODE_CWD env / current_dir / $HOME)。
    /// 新建 tab 时优先使用这里持久化的值。
    #[serde(default)]
    pub session_cwd: Option<String>,
    /// 用户在 GUI 里选定的「config.toml 文件路径」。
    /// `None` = 用 dirs::config_dir()/kode/config.toml 默认路径。
    /// 切换需要重启 GUI 才能生效(backends 列表只在启动时读一次)。
    #[serde(default)]
    pub config_path: Option<String>,
    /// 全局 UI 主题:`"light"` / `"dark"` / `"system"`(默认)。
    /// 老 v1 文件没有 → None,前端按 system 处理(走 prefers-color-scheme)。
    /// 三态由前端在 `<html data-theme="…">` 上落地,CSS 选择器据此切换。
    #[serde(default)]
    pub theme: Option<String>,
    /// 全局 UI 语言:`"en"` / `"zh-CN"` / `"system"`(默认)。
    /// 只影响 GUI / SpecOps console 的用户可见 UI;agent 生成文档仍按请求语言。
    #[serde(default)]
    pub locale: Option<String>,
    /// 用户在 memory MCP 设置 banner 上点了"暂不提示"的 unix 秒时间戳。
    /// `None` = 从未点过 / 老文件未升级 → 启动时仍会触发 banner。
    /// 检测时若 binary 路径或 codebuddy 配置状态发生变化,我们会无视这个值
    /// 强制再次提示(see `memory_mcp::should_prompt`)。
    #[serde(default)]
    pub mcp_prompt_dismissed_at: Option<i64>,
    /// 是否给所有子进程注入 kode-memory 指令段(prompt-only 方案,2026-06-06)。
    /// `None` / `Some(true)` = 启用(默认);`Some(false)` = 关闭。
    /// 关掉后子进程 spawn 不再 `--append-system-prompt`,行为与 vanilla
    /// codebuddy/claude 一致 —— 适合不想让 agent 看到 kode 注入指令的高级用户。
    #[serde(default)]
    pub kode_memory_prompt_enabled: Option<bool>,
    /// **2026-06 M4.3** Browse 面板的最近 filter 状态,用户重启后恢复。
    /// 老文件没有 → None → Browse 第一次打开 filter 全空。
    #[serde(default)]
    pub memory_browse_state: Option<MemoryBrowseState>,
    /// **Phase 11.4** 用户配置的远端 endpoints。`Vec` 而不是 `HashMap` 是为了
    /// 在 GUI 里保持用户添加顺序;查找的时候 O(N) 也无所谓(N 通常 < 5)。
    /// 老文件没有 → None → 解析为空 Vec。
    ///
    /// **token 存在哪**:本期为简化跨平台,直接放在 state.json 里。state.json
    /// 是 ~/Library/Application Support/kode/(macOS)/ ~/.config/kode/(Linux)
    /// 默认 0700 / 用户私有目录,普通用户级隔离够用。Phase 11+ 真要面向多用户
    /// 共享机器时,改用 `keyring` crate 走系统 keychain — 字段名保留兼容。
    #[serde(default)]
    pub endpoints: Option<Vec<PersistedEndpoint>>,
    /// 用户手动重命名的历史 session 标题索引。key = backend jsonl session uuid。
    /// codebuddy/claude 的 jsonl 不保存 GUI rename,历史列表需要用这里覆盖 aiTitle。
    #[serde(default)]
    pub session_titles: HashMap<String, String>,
    /// **2026-06** 创建 tab 时用过的 cwd 历史(top 5),BackendChooser 下方显示
    /// 供快速选择,避免重复输入。区分本地 / 远端 —— 远端按 endpoint_id 分桶。
    /// key = endpoint_id;本地用 `"local"` 这个固定 key。
    #[serde(default)]
    pub cwd_history: HashMap<String, Vec<String>>,
}

/// **Phase 11.4** 一个远端 endpoint 的持久化形态。
/// 字段命名跟 `transport::RemoteConfig` 对齐,反序列化后能直接构造 RemoteTransport。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedEndpoint {
    /// 用户起的 id(EndpointId::Remote { id }),全局唯一。`add` 时若撞名报错。
    pub id: String,
    /// UI 显示名,可与 id 不同。空 = 用 id。
    #[serde(default)]
    pub display_name: String,
    /// 形如 `http://127.0.0.1:9870` 或 `https://dev.tail.ts.net`。
    ///
    /// **SSH 隧道模式下**:这里存的是「远端视角」的 url(远端 server 自己监听的
    /// 地址,通常 `http://127.0.0.1:9870`)。真正连接用的本地 url 由隧道在运行时
    /// 把 host:port rewrite 成 `127.0.0.1:<动态本地端口>` 后拼出来,**不持久化**。
    pub base_url: String,
    /// bearer token(明文 — 见 `endpoints` 字段注释关于 keychain 的说明)
    pub token: String,
    /// **Phase 11.7 SSH 隧道**:`ssh user@host` 或 `~/.ssh/config` 里的 Host 别名。
    /// 空字符串 = 直连模式(行为与老配置完全一致)。非空 = GUI 起 `ssh -N -L`
    /// 子进程把远端 `ssh_remote_port` 映射到本地动态端口再连。
    #[serde(default)]
    pub ssh_host: String,
    /// SSH 隧道模式下远端 server 监听的端口(隧道 `-L local:127.0.0.1:<这个>`)。
    /// 0 / 缺失 → 直连模式不用;SSH 模式下若为 0,运行时按默认 9870 兜底。
    #[serde(default)]
    pub ssh_remote_port: u16,
    /// SSH 服务端口(`ssh -p <这个>`),0 / 缺失 = 默认 22。
    /// devcloud 等非标环境填实际端口(如 36000)。
    #[serde(default)]
    pub ssh_port: u16,
}

/// Browse 面板上次离开时的 filter 状态。前端 `BrowseFilterState` 镜像。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryBrowseState {
    #[serde(default)]
    pub last_scope: Option<String>,
    #[serde(default)]
    pub last_kinds: Vec<String>,
    #[serde(default)]
    pub include_deprecated: bool,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            tabs: Vec::new(),
            bridge_token: None,
            session_cwd: None,
            config_path: None,
            theme: None,
            locale: None,
            mcp_prompt_dismissed_at: None,
            kode_memory_prompt_enabled: None,
            memory_browse_state: None,
            endpoints: None,
            session_titles: HashMap::new(),
            cwd_history: HashMap::new(),
        }
    }
}

/// 加载或生成 bridge token。
///
/// 行为:
/// 1. 读 state.json 的 `bridge_token` —— 有就用
/// 2. 没有(老文件 / 新装) → 生成 32 hex 字符,**立即同步写回**
/// 3. 写盘失败也照常返回 token(下次启动会再生成,不影响当前运行)
pub fn load_or_init_bridge_token() -> String {
    let mut s = load();
    if let Some(t) = s.bridge_token.as_ref() {
        if !t.is_empty() {
            return t.clone();
        }
    }
    let token = generate_token();
    s.bridge_token = Some(token.clone());
    if let Err(e) = save_sync(&s) {
        tracing::warn!(error = %e, "failed to persist bridge_token; will regen next start");
    }
    token
}

fn generate_token() -> String {
    // 不引新依赖:用 uuid v4 拼两次,32 hex 字符,熵 ≈ 256 bits
    let a = uuid::Uuid::new_v4().simple().to_string(); // 32 hex
    a // 32 hex 已经够用(122 bits)
}

/// 状态文件全路径(macOS: ~/Library/Application Support/kode/state.json)。
/// `dirs::config_dir()` 在 macOS 即为 Application Support。
pub fn state_file_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(base.join(APP_DIR_NAME).join(STATE_FILE))
}

/// 启动时一次性读取。文件不存在 / 解析失败 → 返回 default(空)。
pub fn load() -> PersistedState {
    let Some(p) = state_file_path() else {
        return PersistedState::default();
    };
    let Ok(bytes) = std::fs::read(&p) else {
        return PersistedState::default();
    };
    match serde_json::from_slice::<PersistedState>(&bytes) {
        Ok(s) if s.version == SCHEMA_VERSION => s,
        Ok(other) => {
            tracing::warn!(
                "state.json schema mismatch: got v{}, expected v{}; ignoring",
                other.version,
                SCHEMA_VERSION
            );
            PersistedState::default()
        }
        Err(e) => {
            tracing::warn!(error = %e, "state.json parse failed; ignoring");
            PersistedState::default()
        }
    }
}

/// 同步写入(创建目录、原子替换)。
pub fn save_sync(state: &PersistedState) -> std::io::Result<()> {
    let Some(p) = state_file_path() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no config dir",
        ));
    };
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

/// cwd 历史最大保留条数。
pub const CWD_HISTORY_MAX: usize = 5;

/// 把一个 cwd 推进历史 bucket(top 5,去重,最新的放最前)。
///
/// - `bucket`:区分本地 / 远端。本地用 `"local"`,远端用 endpoint_id。
/// - 空 cwd 不记录。
/// - 已存在的 cwd 会从旧位置提到最前(不重复)。
/// - 超过 `CWD_HISTORY_MAX` 条截断尾部。
///
/// 修改 `state.cwd_history` 后**不落盘** —— 调用方负责 `save_sync`。
pub fn push_cwd_history(state: &mut PersistedState, bucket: &str, cwd: &str) {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return;
    }
    let entry = state.cwd_history.entry(bucket.to_string()).or_default();
    // 去重:移除已存在的同名条目(大小写敏感精确匹配)
    entry.retain(|c| c != cwd);
    entry.insert(0, cwd.to_string());
    if entry.len() > CWD_HISTORY_MAX {
        entry.truncate(CWD_HISTORY_MAX);
    }
}

/// 读某个 bucket 的 cwd 历史(可能为空)。
pub fn get_cwd_history(state: &PersistedState, bucket: &str) -> Vec<String> {
    state.cwd_history.get(bucket).cloned().unwrap_or_default()
}

/// Debounced writer:外部多次调用 `request_save(state)` 只触发一次落盘(500ms 静默后)。
///
/// 用法:`AppState::new` 里建一个 `PersistWriter`,每次 tabs 变化时调 `request_save`。
pub struct PersistWriter {
    pending: Arc<Mutex<Option<PersistedState>>>,
    notify: Arc<Notify>,
}

impl PersistWriter {
    pub fn new() -> Self {
        let pending: Arc<Mutex<Option<PersistedState>>> = Arc::new(Mutex::new(None));
        let notify = Arc::new(Notify::new());

        // 后台 task:被 notify 唤醒 → 等 DEBOUNCE_MS → flush。
        // 简单 debounce:每次 request_save 都把当前 state 覆盖到 pending,
        // 后台 task 唤醒一次就走一个固定 sleep 再 flush。多次密集调用时,
        // 第一次唤醒 sleep 期间后续的 request_save 只更新 pending,
        // sleep 结束 flush 时取的就是最新 state。
        let pending_bg = Arc::clone(&pending);
        let notify_bg = Arc::clone(&notify);
        tauri::async_runtime::spawn(async move {
            loop {
                notify_bg.notified().await;
                sleep(Duration::from_millis(DEBOUNCE_MS)).await;
                let snap = pending_bg.lock().take();
                if let Some(s) = snap {
                    if let Err(e) = save_sync(&s) {
                        tracing::warn!(error = %e, "state save failed");
                    }
                }
            }
        });

        Self { pending, notify }
    }

    /// 请求落盘。多次调用会被合并;最后一次的 state 胜出。
    pub fn request_save(&self, state: PersistedState) {
        *self.pending.lock() = Some(state);
        self.notify.notify_one();
    }

    /// 退出前同步 flush —— 调用方应在窗口关闭 handler 里调。
    #[allow(dead_code)]
    pub fn flush_sync(&self) {
        let snap = self.pending.lock().take();
        if let Some(s) = snap {
            let _ = save_sync(&s);
        }
    }
}

impl Default for PersistWriter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_round_trip() {
        let s = PersistedState {
            version: 1,
            tabs: vec![PersistedTab {
                backend_key: "codebuddy".into(),
                title: "Test".into(),
                title_pinned: true,
                cwd: "/tmp".into(),
                session_id: Some("abc-123".into()),
                model: Some("claude-opus-4.7".into()),
                permission_mode: Some("bypass".into()),
                endpoint_id: None,
                avatar_id: None,
            }],
            bridge_token: Some("deadbeef".into()),
            session_cwd: Some("/Users/me/projects/foo".into()),
            config_path: Some("/Users/me/.config/kode/config.toml".into()),
            theme: Some("dark".into()),
            locale: Some("zh-CN".into()),
            mcp_prompt_dismissed_at: Some(1_780_000_000),
            kode_memory_prompt_enabled: Some(false),
            memory_browse_state: None,
            endpoints: None,
            session_titles: HashMap::from([("abc-123".into(), "Pinned".into())]),
            cwd_history: HashMap::new(),
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.version, 1);
        assert_eq!(back.tabs.len(), 1);
        assert_eq!(back.tabs[0].backend_key, "codebuddy");
        assert!(back.tabs[0].title_pinned);
        assert_eq!(back.tabs[0].session_id.as_deref(), Some("abc-123"));
        assert_eq!(back.tabs[0].model.as_deref(), Some("claude-opus-4.7"));
        assert_eq!(back.tabs[0].permission_mode.as_deref(), Some("bypass"));
        assert_eq!(back.bridge_token.as_deref(), Some("deadbeef"));
        assert_eq!(
            back.session_titles.get("abc-123").map(String::as_str),
            Some("Pinned")
        );
        assert_eq!(back.session_cwd.as_deref(), Some("/Users/me/projects/foo"));
        assert_eq!(
            back.config_path.as_deref(),
            Some("/Users/me/.config/kode/config.toml")
        );
        assert_eq!(back.theme.as_deref(), Some("dark"));
        assert_eq!(back.locale.as_deref(), Some("zh-CN"));
        assert_eq!(back.mcp_prompt_dismissed_at, Some(1_780_000_000));
        assert_eq!(back.kode_memory_prompt_enabled, Some(false));
    }

    /// 老 v1 schema 没有 model / permission_mode / theme / locale 字段 → 全部反序列化为 None
    /// 不影响其它字段。覆盖跨版本兼容性最重要的回归场景。
    #[test]
    fn v1_without_new_fields_deserializes_to_none() {
        let json = r#"{
            "version":1,
            "tabs":[{"backend_key":"codebuddy","title":"old","cwd":"/x","session_id":"sid-1"}],
            "bridge_token":"abc"
        }"#;
        let s: PersistedState = serde_json::from_str(json).unwrap();
        assert_eq!(s.tabs.len(), 1);
        assert_eq!(s.tabs[0].model, None);
        assert_eq!(s.tabs[0].permission_mode, None);
        assert_eq!(s.theme, None);
        assert_eq!(s.locale, None);
        assert_eq!(s.session_cwd, None);
        assert_eq!(s.mcp_prompt_dismissed_at, None);
        assert_eq!(s.kode_memory_prompt_enabled, None);
        // 旧字段保持
        assert_eq!(s.tabs[0].session_id.as_deref(), Some("sid-1"));
        assert_eq!(s.bridge_token.as_deref(), Some("abc"));
    }

    #[test]
    fn v1_without_bridge_token_deserializes_to_none() {
        let json = r#"{"version":1,"tabs":[]}"#;
        let s: PersistedState = serde_json::from_str(json).unwrap();
        assert_eq!(s.bridge_token, None);
    }

    #[test]
    fn v1_without_session_id_deserializes_to_none() {
        // 老 v1 schema 没有 session_id 字段 → serde(default) 兜底为 None
        let json = r#"{"version":1,"tabs":[{"backend_key":"codebuddy","title":"old","cwd":"/x"}]}"#;
        let s: PersistedState = serde_json::from_str(json).unwrap();
        assert_eq!(s.tabs[0].session_id, None);
    }

    #[test]
    fn unknown_schema_yields_default() {
        let json = r#"{"version":99,"tabs":[]}"#;
        let parsed: PersistedState = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.version, 99);
        // 我们的 load() 会拒绝并返回 default,但纯 schema 解析允许任何版本号
    }

    #[test]
    fn endpoint_without_ssh_fields_deserializes_to_direct_mode() {
        // 老 11.4 endpoint 没有 ssh_host / ssh_remote_port → serde(default)
        // 兜底为空串 / 0,等价直连模式。这是 SSH 隧道功能的向后兼容回归。
        let json = r#"{
            "id":"host-a",
            "display_name":"Host A",
            "base_url":"http://127.0.0.1:9870",
            "token":"tok-1"
        }"#;
        let ep: PersistedEndpoint = serde_json::from_str(json).unwrap();
        assert_eq!(ep.id, "host-a");
        assert_eq!(ep.ssh_host, "");
        assert_eq!(ep.ssh_remote_port, 0);
    }

    #[test]
    fn endpoint_with_ssh_fields_roundtrip() {
        let ep = PersistedEndpoint {
            id: "dev".into(),
            display_name: "Dev box".into(),
            base_url: "http://127.0.0.1:9870".into(),
            token: "tok".into(),
            ssh_host: "user@remote".into(),
            ssh_remote_port: 9870,
            ssh_port: 36000,
        };
        let txt = serde_json::to_string(&ep).unwrap();
        let back: PersistedEndpoint = serde_json::from_str(&txt).unwrap();
        assert_eq!(back, ep);
        assert_eq!(back.ssh_host, "user@remote");
        assert_eq!(back.ssh_remote_port, 9870);
        assert_eq!(back.ssh_port, 36000);
    }

    #[test]
    fn endpoint_without_ssh_port_defaults_to_zero() {
        // 老 11.7 endpoint 没有 ssh_port → serde(default) 兜底为 0(表示 22)
        let json = r#"{
            "id":"host-b",
            "display_name":"Host B",
            "base_url":"http://127.0.0.1:9870",
            "token":"tok-1",
            "ssh_host":"user@devcloud",
            "ssh_remote_port":9870
        }"#;
        let ep: PersistedEndpoint = serde_json::from_str(json).unwrap();
        assert_eq!(ep.ssh_port, 0); // 向后兼容:0 = 使用 ssh 默认端口 22
    }

    #[test]
    fn memory_browse_state_roundtrip_and_legacy_compat() {
        // M4.3:老 v1 文件没有 memory_browse_state → None
        let legacy = r#"{"version":1,"tabs":[]}"#;
        let parsed: PersistedState = serde_json::from_str(legacy).unwrap();
        assert!(parsed.memory_browse_state.is_none());

        // 设置 + 序列化 + 反序列化往返
        let mut s = PersistedState::default();
        s.memory_browse_state = Some(MemoryBrowseState {
            last_scope: Some("project:kode".into()),
            last_kinds: vec!["dead_end".into(), "gotcha".into()],
            include_deprecated: true,
        });
        let txt = serde_json::to_string(&s).unwrap();
        let back: PersistedState = serde_json::from_str(&txt).unwrap();
        let bs = back.memory_browse_state.unwrap();
        assert_eq!(bs.last_scope.as_deref(), Some("project:kode"));
        assert_eq!(bs.last_kinds, vec!["dead_end".to_string(), "gotcha".into()]);
        assert!(bs.include_deprecated);
    }

    // ── cwd_history ──

    #[test]
    fn cwd_history_push_dedup_and_moves_to_front() {
        let mut s = PersistedState::default();
        push_cwd_history(&mut s, "local", "/a");
        push_cwd_history(&mut s, "local", "/b");
        push_cwd_history(&mut s, "local", "/c");
        // 再次推 /a → 应该移到最前,不重复
        push_cwd_history(&mut s, "local", "/a");
        assert_eq!(get_cwd_history(&s, "local"), vec!["/a", "/c", "/b"]);
    }

    #[test]
    fn cwd_history_truncates_at_max() {
        let mut s = PersistedState::default();
        for i in 0..(CWD_HISTORY_MAX + 3) {
            push_cwd_history(&mut s, "local", &format!("/dir{i}"));
        }
        let h = get_cwd_history(&s, "local");
        assert_eq!(h.len(), CWD_HISTORY_MAX);
        // 最新的在最前
        assert_eq!(h[0], format!("/dir{}", CWD_HISTORY_MAX + 2));
    }

    #[test]
    fn cwd_history_separates_buckets() {
        let mut s = PersistedState::default();
        push_cwd_history(&mut s, "local", "/local-path");
        push_cwd_history(&mut s, "ep-1", "/remote-1");
        push_cwd_history(&mut s, "ep-2", "/remote-2");
        assert_eq!(get_cwd_history(&s, "local"), vec!["/local-path"]);
        assert_eq!(get_cwd_history(&s, "ep-1"), vec!["/remote-1"]);
        assert_eq!(get_cwd_history(&s, "ep-2"), vec!["/remote-2"]);
        assert!(get_cwd_history(&s, "nonexistent").is_empty());
    }

    #[test]
    fn cwd_history_ignores_empty() {
        let mut s = PersistedState::default();
        push_cwd_history(&mut s, "local", "");
        push_cwd_history(&mut s, "local", "   ");
        assert!(get_cwd_history(&s, "local").is_empty());
    }

    #[test]
    fn cwd_history_persists_through_serde() {
        let mut s = PersistedState::default();
        push_cwd_history(&mut s, "local", "/a");
        push_cwd_history(&mut s, "local", "/b");
        push_cwd_history(&mut s, "ep-1", "/remote");
        let json = serde_json::to_string(&s).unwrap();
        let back: PersistedState = serde_json::from_str(&json).unwrap();
        assert_eq!(get_cwd_history(&back, "local"), vec!["/b", "/a"]);
        assert_eq!(get_cwd_history(&back, "ep-1"), vec!["/remote"]);
    }
}
