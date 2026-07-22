//! Tauri command —— 前端 invoke 的入口。
//!
//! 共享状态:`AppState.ctx: Arc<BridgeCtx>` 与 axum router 完全一份;
//! 任何在桌面 GUI 上做的会话改动也会自动反映给手机端 / 协议消费者。
//!
//! Phase 11.2 改造:spawn / write / resize / kill 走 `SessionTransport` trait。
//! 默认 endpoint = `Local`,与改造前行为完全一致;Phase 11.3 起前端可以传
//! `endpoint_id = Remote { id }` 让命令走远端。

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use kode_core::{config::BackendConfig, EndpointId, SessionId, SessionTransport, SpawnSpec};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

use crate::bridge::events::EventEnvelope;
use crate::memory::MemoryHandle;
use crate::specops::SpecOpsSession;
use crate::state::{AppState, SessionByteBuffer};

#[tauri::command]
pub async fn specops_open(
    workspace: String,
    state: State<'_, AppState>,
) -> Result<SpecOpsSession, String> {
    let manager = Arc::clone(&state.specops);
    let path = PathBuf::from(workspace);
    let token = state.ctx.token.as_ref().clone();
    let address = wait_for_bridge_addr(Arc::clone(&state.ctx.listen_addr)).await?;
    let port = address.port();
    tauri::async_runtime::spawn_blocking(move || {
        manager.open(&path, &format!("http://127.0.0.1:{port}"), &token)
    })
    .await
    .map_err(|e| format!("SpecOps task failed: {e}"))?
}

#[tauri::command]
pub async fn specops_init_git_workspace(workspace: String) -> Result<(), String> {
    let path = PathBuf::from(workspace);
    let canonical =
        std::fs::canonicalize(&path).map_err(|e| format!("invalid SpecOps workspace: {e}"))?;
    if !canonical.is_dir() {
        return Err("the selected SpecOps workspace is not a directory".into());
    }
    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("git")
            .arg("init")
            .arg("--")
            .arg(&canonical)
            .output()
    })
    .await
    .map_err(|e| format!("Git initialization task failed: {e}"))?
    .map_err(|e| format!("failed to launch git init: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("git init failed with {}", output.status)
        } else {
            format!("git init failed: {detail}")
        });
    }
    Ok(())
}

async fn wait_for_bridge_addr(
    listen_addr: Arc<parking_lot::Mutex<Option<SocketAddr>>>,
) -> Result<SocketAddr, String> {
    const ATTEMPTS: usize = 50;
    const RETRY_DELAY: Duration = Duration::from_millis(20);

    for _ in 0..ATTEMPTS {
        if let Some(address) = *listen_addr.lock() {
            return Ok(address);
        }
        tokio::time::sleep(RETRY_DELAY).await;
    }
    Err("kode bridge did not start; check whether KODE_BRIDGE_DISABLE is set".to_string())
}

#[tauri::command]
pub async fn specops_close(workspace: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = Arc::clone(&state.specops);
    tauri::async_runtime::spawn_blocking(move || manager.close(Path::new(&workspace)))
        .await
        .map_err(|e| format!("SpecOps task failed: {e}"))?
}

/// 探测本机有效的局域网 IPv4 地址。
///
/// 枚举所有网络接口,返回第一个非 loopback、非 link-local、且处于 UP 状态的 IPv4 地址。
/// 没有则 fallback 到 "127.0.0.1"。
fn detect_lan_ip() -> String {
    use local_ip_address::list_afinet_netifas;
    if let Ok(ifs) = list_afinet_netifas() {
        for (name, ip) in &ifs {
            if name.starts_with("utun") || name.starts_with("llw") || name.starts_with("anpi") {
                continue; // 跳过 VPN / 隧道 / 虚拟接口
            }
            let ip_str = ip.to_string();
            // 过滤掉 loopback (127.x) 和 link-local (169.254.x)
            if ip_str.starts_with("127.") || ip_str.starts_with("169.254.") {
                continue;
            }
            if ip_str.starts_with("192.168.")
                || ip_str.starts_with("10.")
                || (ip_str.starts_with("172.") && {
                    let second = ip_str
                        .split('.')
                        .nth(1)
                        .and_then(|s| s.parse::<u32>().ok())
                        .unwrap_or(0);
                    (16..=31).contains(&second)
                })
            {
                return ip_str;
            }
        }
        // 没有 RFC1918 私有地址,回退到任意非 loopback IPv4
        for (_name, ip) in &ifs {
            let ip_str = ip.to_string();
            if !ip_str.starts_with("127.") && !ip_str.starts_with("169.254.") {
                return ip_str;
            }
        }
    }
    "127.0.0.1".to_string()
}

#[derive(Debug, Serialize)]
pub struct BackendInfo {
    pub key: String,
    pub command: String,
    pub default_model: Option<String>,
    pub model_flag: Option<String>,
}

/// Settings 面板用的 backend 列表项 —— 比 `BackendInfo` 多一个 `enabled`,
/// 因为 Settings 要展示**全部**(含被关掉的)backend 及其开关状态。
/// `enabled` 是 `is_enabled()` 折算后的 bool(None / Some(true) → true),
/// 前端 toggle 写回时用 `backend_set_enabled` 写显式 true/false。
#[derive(Debug, Serialize)]
pub struct BackendListItem {
    pub key: String,
    pub command: String,
    pub default_model: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct AvatarSet {
    pub name: String,
    /// Four frame data URLs, ready to use as <img src="..."> on the frontend.
    pub frames: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct AvatarLibrary {
    pub running: Vec<AvatarSet>,
    pub awaiting: Vec<AvatarSet>,
    pub idle: Vec<AvatarSet>,
    pub error: Vec<AvatarSet>,
    /// 用户可选的 avatar 池,独立于状态类别。
    /// 目录约定:`avatars/gallery/<id>/frame-01.png..frame-04.png`。
    /// tab 选定后前端记 avatarId,null/缺失 = 用 backend icon 作 fallback。
    pub gallery: Vec<AvatarSet>,
}

/// Load optional animated tab avatars from the user config directory.
///
/// Convention:
/// - macOS: `~/Library/Application Support/kode/avatars/running/01/frame-01.png`
/// - Linux: `~/.config/kode/avatars/running/01/frame-01.png`
/// - categories: `running`, `awaiting`, `idle`, `error`
/// - each set must contain `frame-01.png` through `frame-04.png`
/// - a category can contain frames directly, or multiple nested variants
///
/// `KODE_AVATAR_DIR` can override the directory for development. Missing dirs or
/// incomplete sets simply produce an empty list, so the frontend hides avatars.
#[tauri::command]
pub fn list_avatar_library() -> AvatarLibrary {
    let Some(root) = avatar_root_dir() else {
        return AvatarLibrary::default();
    };
    let mut running = list_avatar_category(&root, "running").unwrap_or_default();
    let mut awaiting = list_avatar_category(&root, "awaiting").unwrap_or_default();
    let mut idle = list_avatar_category(&root, "idle").unwrap_or_default();
    let mut error = list_avatar_category(&root, "error").unwrap_or_default();
    let gallery = list_gallery_category(&root);

    // `gallery/<id>/<state>/[<variant>/]frame-XX.png` 也扫进对应状态类别,
    // name=<id>。这样前端选了 avatarId=<id> 后,AvatarSprite 能按当前 status
    // 在 library[status] 里命中对应帧,实现四态切换。单套帧的 gallery set
    // (无状态子目录)不会进状态类别,前端用 gallery 帧 + 状态点兜底。
    let gallery_dir = root.join("gallery");
    if gallery_dir.is_dir() {
        let mut entries: Vec<_> = std::fs::read_dir(&gallery_dir)
            .map_err(|e| format!("read gallery dir: {e}"))
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            // gallery set 的 name 形如 "gallery/01";library[state] 的 set 也用
            // 同样的 name,这样前端用同一个 avatarId 能在两边命中。
            let id = format!("gallery/{}", entry.file_name().to_string_lossy());
            let id_dir = entry.path();
            for (state, target) in [
                ("running", &mut running),
                ("idle", &mut idle),
                ("awaiting", &mut awaiting),
                ("error", &mut error),
            ] {
                let state_dir = id_dir.join(state);
                if state_dir.is_dir() {
                    // 收集该状态下所有变体(01/02/...),让前端能随机遍历切换,
                    // 而不是永远只播第一套。
                    target.extend(read_avatar_sets(&state_dir, &id));
                }
            }
        }
    }

    AvatarLibrary {
        running,
        awaiting,
        idle,
        error,
        gallery,
    }
}

fn avatar_root_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("KODE_AVATAR_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(expand_home(trimmed));
        }
    }
    Some(dirs::config_dir()?.join("kode").join("avatars"))
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn list_avatar_category(root: &Path, category: &str) -> Result<Vec<AvatarSet>, String> {
    let dir = root.join(category);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    if let Some(set) = read_avatar_set(&dir, category) {
        return Ok(vec![set]);
    }

    let mut dirs = std::fs::read_dir(&dir)
        .map_err(|e| format!("read avatar dir {}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect::<Vec<_>>();
    dirs.sort_by_key(|e| e.file_name());

    let mut sets = Vec::new();
    for entry in dirs {
        let name = format!("{category}/{}", entry.file_name().to_string_lossy());
        if let Some(set) = read_avatar_set(&entry.path(), &name) {
            sets.push(set);
        }
    }

    Ok(sets)
}

/// 扫 `gallery/<id>/`:有 frame-XX.png 直接读成单套帧 set;否则尝试用 idle
/// 子目录的第一套帧作为 gallery 预览(四态切换时前端会改用 library[status])。
fn list_gallery_category(root: &Path) -> Vec<AvatarSet> {
    let dir = root.join("gallery");
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut dirs: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(e) => e
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .collect(),
        Err(_) => return Vec::new(),
    };
    dirs.sort_by_key(|e| e.file_name());

    let mut sets = Vec::new();
    for entry in dirs {
        let id = format!("gallery/{}", entry.file_name().to_string_lossy());
        let id_dir = entry.path();
        // 单套帧:gallery/<id>/frame-XX.png
        if let Some(set) = read_avatar_set(&id_dir, &id) {
            sets.push(set);
            continue;
        }
        // 四态:gallery/<id>/idle/frame-XX.png(或 idle/<variant>/frame-XX.png)
        // 用 idle 作为 gallery 预览;运行时按 status 切到 library[status]
        let idle_dir = id_dir.join("idle");
        if idle_dir.is_dir() {
            if let Some(set) = read_first_avatar_set(&idle_dir, &id) {
                sets.push(set);
            }
        }
    }
    sets
}

/// 读取 dir 下所有完整的 4 帧 avatar set。dir 直接含 frame-XX.png 时返回单套;
/// 否则遍历子目录(01/02/...)收集每个含 frame-XX.png 的变体。用于
/// gallery/<id>/<state>/ 下可能有多个变体子目录时 —— 全部返回,前端随机遍历切换。
/// 同一状态下的多套变体共用同一个 `name`(=avatarId),前端按 name 归组后随机切。
fn read_avatar_sets(dir: &Path, name: &str) -> Vec<AvatarSet> {
    if let Some(set) = read_avatar_set(dir, name) {
        return vec![set];
    }
    let mut entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(e) => e
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .collect(),
        Err(_) => return Vec::new(),
    };
    entries.sort_by_key(|e| e.file_name());
    entries
        .iter()
        .filter_map(|entry| read_avatar_set(&entry.path(), name))
        .collect()
}

/// 读取 dir 下第一套完整的 4 帧 avatar set。用于 gallery 预览:只需要一套代表帧。
fn read_first_avatar_set(dir: &Path, name: &str) -> Option<AvatarSet> {
    read_avatar_sets(dir, name).into_iter().next()
}

fn read_avatar_set(dir: &Path, name: &str) -> Option<AvatarSet> {
    let mut frames = Vec::with_capacity(4);
    for idx in 1..=4 {
        let path = dir.join(format!("frame-{idx:02}.png"));
        let bytes = std::fs::read(&path).ok()?;
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        frames.push(format!("data:image/png;base64,{encoded}"));
    }
    Some(AvatarSet {
        name: name.to_string(),
        frames,
    })
}

/// 计算某 backend 实时 enabled:优先 config.toml 文件里的显式值(用户开关 / 探测落地
/// 刚写的),否则回落冷快照的 `is_enabled()`。这样写盘后当前进程立刻反映,无需重启。
fn effective_enabled(
    key: &str,
    cfg: &kode_core::config::BackendConfig,
    overrides: &std::collections::HashMap<String, bool>,
) -> bool {
    overrides
        .get(key)
        .copied()
        .unwrap_or_else(|| cfg.is_enabled())
}

#[tauri::command]
pub fn list_backends(state: State<'_, AppState>) -> Vec<BackendInfo> {
    let overrides = crate::backend_admin::read_enabled_overrides(&state);
    state
        .ctx
        .config
        .backends
        .iter()
        .filter(|(k, v)| effective_enabled(k, v, &overrides))
        .map(|(k, v)| BackendInfo {
            key: k.clone(),
            command: v.command.clone(),
            default_model: v.default_model.clone(),
            model_flag: v.model_flag.clone(),
        })
        .collect()
}

/// Query the installed CLI at runtime instead of baking version-sensitive model IDs into the GUI.
#[tauri::command]
pub async fn discover_backend_models(
    backend_key: String,
    state: State<'_, AppState>,
) -> Result<kode_bridge::model_discovery::ModelDiscoveryResult, String> {
    let cfg = state
        .ctx
        .config
        .backends
        .get(&backend_key)
        .ok_or_else(|| format!("backend '{backend_key}' not found"))?;
    kode_bridge::model_discovery::discover_models(&backend_key, &cfg.command).await
}

/// Settings 面板用:返回**全部** backend(含被关掉的),附带 enabled。
/// enabled 取 config.toml 实时值(回落冷快照),所以开关后立刻正确。
#[tauri::command]
pub fn list_all_backends(state: State<'_, AppState>) -> Vec<BackendListItem> {
    let overrides = crate::backend_admin::read_enabled_overrides(&state);
    state
        .ctx
        .config
        .backends
        .iter()
        .map(|(k, v)| BackendListItem {
            key: k.clone(),
            command: v.command.clone(),
            default_model: v.default_model.clone(),
            enabled: effective_enabled(k, v, &overrides),
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct SpawnedSession {
    pub id: SessionId,
    pub backend_key: String,
    pub model: String,
    pub title: String,
    /// 子进程的 session uuid(若 backend 支持注入);恢复 / 持久化要带它
    pub session_id: Option<String>,
    /// 实际生效的 working directory(经 resolve_session_cwd 解析,前端无 cwd 入参时
    /// 仍能拿到落地路径用于状态栏展示)
    pub cwd: String,
    /// Phase 11.2:本 session 走的 transport endpoint。回给前端便于后续 invoke
    /// 直接路由到对应 transport(写入 / resize / kill 都要带)。
    pub endpoint_id: EndpointId,
}

/// 取出指定 endpoint 的 transport 引用。endpoint 没注册 → Err(给客户端可读字符串)。
fn get_transport(
    state: &AppState,
    endpoint_id: &EndpointId,
) -> Result<Arc<dyn SessionTransport>, String> {
    state
        .transports
        .lock()
        .get(endpoint_id)
        .cloned()
        .ok_or_else(|| format!("transport not registered: {endpoint_id}"))
}

/// 启动一个新 session(默认尺寸 80x24,前端 onMount 后会立即 resize)
#[tauri::command]
pub async fn spawn_session(
    backend_key: String,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    resume_session_id: Option<String>,
    // 用户视角 permission mode 简称:`None` / `"default"` 不注入,`"bypass"` 翻译为
    // `bypassPermissions`,其它值原样透传给子进程(给高级用户保留 acceptEdits/plan)。
    permission_mode: Option<String>,
    // 用户在 BackendChooser 选定的 model;restore 时也会回填上次保存的 model。
    // None → 走 backend.default_model(老语义)。Some(_) → 注入 `--model <model>` 到子进程。
    model: Option<String>,
    // Phase 11.2:可选 endpoint;前端不传 = Local(向后兼容,改造前行为)
    endpoint_id: Option<EndpointId>,
    memory_handle: State<'_, Arc<MemoryHandle>>,
    state: State<'_, AppState>,
) -> Result<SpawnedSession, String> {
    let endpoint_id = endpoint_id.unwrap_or(EndpointId::Local);
    let transport = get_transport(&state, &endpoint_id)?;

    // cwd 解析仅对 Local endpoint 有意义。Remote 的 cwd 必须是 server 端绝对路径
    // (由 11.1.3 fs.list 让用户选),不能用本地 resolve_session_cwd 的 fallback 链。
    let cwd_path: Option<std::path::PathBuf> = match endpoint_id {
        EndpointId::Local => Some(resolve_session_cwd(cwd.as_deref(), &state)),
        EndpointId::Remote { .. } => cwd
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from),
    };

    // 仅 Local endpoint + prompt 注入开启时，预查项目 memory 快照，让 agent 一开始就看到。
    // 查询失败 / 空结果静默忽略，不阻断 spawn。
    let memory_context = if matches!(endpoint_id, EndpointId::Local) {
        build_memory_context(&memory_handle, cwd_path.as_deref()).await
    } else {
        None
    };

    let model = sanitize_spawn_model(model);

    let spec = SpawnSpec {
        backend_key: backend_key.clone(),
        cols: cols.unwrap_or(80),
        rows: rows.unwrap_or(24),
        cwd: cwd_path,
        resume_session_uuid: resume_session_id,
        permission_mode,
        model,
        memory_context,
    };

    let spawned = transport.spawn(spec).await.map_err(String::from)?;

    Ok(SpawnedSession {
        id: spawned.id,
        backend_key: spawned.backend_key,
        model: spawned.model,
        title: spawned.title,
        session_id: spawned.session_uuid,
        cwd: spawned.cwd,
        endpoint_id,
    })
}

fn sanitize_spawn_model(model: Option<String>) -> Option<String> {
    model.and_then(|m| {
        let cleaned = kode_core::model_alias::sanitize_model_name(&m);
        let cleaned = cleaned.trim();
        if cleaned.is_empty() || cleaned == "auto" {
            None
        } else {
            Some(cleaned.to_string())
        }
    })
}

// 注意:不再保留 list_backends 之外的旧 BackendConfig 引用,但 Tauri command
// list_backends 仍直接读 ctx.config(那是 Local 端的 backend 列表)。Remote 端
// backend 列表通过 RemoteTransport 的 HTTP `GET /api/v1/backends` 拉,不走这里。
#[allow(dead_code)]
fn _phase_11_marker(_b: &BackendConfig) {}

/// 在 spawn 前查 kode-memory，把项目 facts 快照格式化成 bullet list 字符串。
/// 失败（DB 错误、无 facts）静默返回 None，不阻断 spawn。
///
/// 查询策略：scope = `project:<cwd_basename>`，最近 30 天，最多 20 条。
async fn build_memory_context(handle: &Arc<MemoryHandle>, cwd: Option<&Path>) -> Option<String> {
    let slug = cwd?.file_name()?.to_str()?;
    let scope = format!("project:{slug}");
    let store = handle.store.lock().await;
    let hits = store.list_recent(Some(&scope), 24 * 30).ok()?;
    if hits.is_empty() {
        return None;
    }
    let text = hits
        .iter()
        .take(20)
        .map(|h| format!("- [{}] {}", h.kind, h.snippet))
        .collect::<Vec<_>>()
        .join("\n");
    Some(text)
}

/// 解析 session cwd:显式参数 > GUI 持久化的 session_cwd_override > KODE_CWD env
/// > 进程 current_dir > $HOME > "/"
fn resolve_session_cwd(explicit: Option<&str>, state: &AppState) -> std::path::PathBuf {
    if let Some(p) = explicit {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            return std::path::PathBuf::from(trimmed);
        }
    }
    if let Some(p) = state.ctx.session_cwd_override.lock().clone() {
        return p;
    }
    if let Ok(p) = std::env::var("KODE_CWD") {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd != std::path::Path::new("/") {
            return cwd;
        }
    }
    if let Some(home) = dirs::home_dir() {
        return home;
    }
    std::path::PathBuf::from("/")
}

/// 前端订阅某个 session 的字节流。
///
/// 返回 spawn 至订阅建立前积累的原始 PTY 字节。`pending` 的取出与 channel 安装
/// 在同一把锁内完成,因此其后的字节只会进入新 channel,不存在 snapshot → live
/// 之间的丢包窗口。前端必须先回放返回值,再消费订阅建立期间排队的 channel 消息。
#[tauri::command]
pub async fn subscribe_session_bytes(
    id: SessionId,
    on_bytes: Channel<Vec<u8>>,
    subscription_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let mut g = state.ctx.byte_buffers.lock();
    let buf = g.entry(id).or_insert_with(SessionByteBuffer::new);
    let initial = buf.take_initial_bytes();
    buf.channel = Some(on_bytes);
    buf.subscriber_id = Some(subscription_id);
    Ok(initial)
}

/// 前端 Terminal 组件销毁时取消字节流订阅。
#[tauri::command]
pub async fn unsubscribe_session_bytes(
    id: SessionId,
    subscription_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(buf) = state.ctx.byte_buffers.lock().get_mut(&id) {
        buf.unsubscribe_if_current(&subscription_id);
    }
    Ok(())
}

/// 写入按键到 PTY。
///
/// **必须是同步命令(`fn`,不是 `async fn`)**!
/// xterm.js 的 `onData` 每个字符触发一次,快速连打时前端会连发多次 `invoke`。
/// Tauri 2 的 async 命令通过 `tauri::async_runtime::spawn` 派发到 multi-thread
/// tokio runtime,**多个 task 并发抢 `sessions.lock()`,执行顺序不保证** —
/// 打 "qwer" 可能以 "qewr" / "qrwe" 顺序写到 PTY,echo 回来 vt100 渲染就乱了
/// (典型现象:快打四个字母只显示其中两三个)。
///
/// 同步命令在 IPC 接收线程上**严格按 invoke 顺序串行执行**,且写字节本身是
/// 微秒级,不需要 async。改 sync 后顺序确定、无锁竞争。
///
/// **Phase 11.2 路由**:
/// - Local endpoint:同步 + 直接走 `ctx.sessions` 写 PTY(保留 sync 顺序保证)
/// - Remote endpoint:必须 async(HTTP POST),由 [`write_input_remote`] 处理
///
/// 前端的写法:本地 tab 调 `write_input`,远端 tab 调 `write_input_remote`。
/// 这种"按 endpoint 分两个命令"的拆法看着丑,但是是 Phase 11 不变量 #1
/// (本地 tab 不走协议层)的代价 — 物理上 sync/async 不能同居一个命令。
#[tauri::command]
pub fn write_input(
    id: SessionId,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let g = state.ctx.sessions.lock();
        let s = g.get(&id).ok_or_else(|| format!("no session {id}"))?;
        s.write_input(&bytes);
    }

    // 乐观清除 attention:任何用户输入都算"开始处理 prompt"。
    //
    // 之前只匹配 `\r`/`\n`/`\r\n`,但 Ink SelectInput 支持数字键直接选中(无需回车),
    // 那条路径走不到即时清,只能等 scan_loop(idle 阈值 200ms + scan tick 200ms = 数百毫秒)。
    // 用户感知就是"我答了但提示没消"。改成 has_prompt=true 时只要进了任意输入就清。
    // Codex 的 PermissionRequest hook 还可能先于 PTY detector 点亮 attention,所以也
    // 允许 ask_attention_active 触发清除。
    //
    // 自我修正机制:同步清 last_emitted。万一 prompt 实际没解除(比如箭头键只是移动 ❯
    // 光标),scan_loop 下一拍 detect=Some + should_emit=true → 重新点亮 ?。
    // 视觉上偶尔会看到"清掉 → 0~200ms 后又亮"的小闪烁,但比"答了不消"对用户来说友好。
    //
    // 没有 active ask/prompt 时直接跳过 emit —— 普通 shell 输入字节就走原路径,
    // 不会污染前端事件流。
    if !bytes.is_empty() {
        let was_prompt = {
            let mut g = state.ctx.prompt_states.lock();
            let st = g.entry(id).or_default();
            let prev = st.has_prompt || st.ask_attention_active;
            if prev {
                st.has_prompt = false;
                st.ask_attention_active = false;
                st.last_emitted = None;
                // suppress_until_ms 已移除:HookRelay 通过 Notification hook 提供
                // authoritative 信号,不需要抑制窗口来防闪烁。
            }
            prev
        };
        if was_prompt {
            state.ctx.bus.emit(EventEnvelope::new(
                id,
                "session.attention_cleared",
                serde_json::json!({ "reason": "user_input" }),
            ));
        }
    }
    Ok(())
}

/// Phase 11.2 / 11.3:写入按键到 **远端** session 的 PTY。
///
/// 与 [`write_input`] 的差别:
/// - async 命令(HTTP POST 必须 async)
/// - 不做 attention 清除(那基于本地 prompt_states 状态;远端的 prompt 状态在 server)
/// - 必须显式带 `endpoint_id`(不能 fallback 到 Local —— 那应该用 [`write_input`])
///
/// 顺序保证:Tauri 2 对**同一前端 tab** 的 async 命令仍然按 invoke 顺序派发到
/// 同一个 task pool,但**到达 RemoteTransport 后**多个 POST 并发出去,server 那边
/// 的接收顺序由 TCP / HTTP/2 stream 顺序决定(单 connection HTTP/2 是顺序的)。
/// reqwest 默认复用 connection,实际效果 = "顺序到达"。如果打字密度高出现乱序,
/// 11.3 阶段再加客户端 sequence 号 + server-side reorder buffer。
#[tauri::command]
pub async fn write_input_remote(
    id: SessionId,
    bytes: Vec<u8>,
    endpoint_id: EndpointId,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if matches!(endpoint_id, EndpointId::Local) {
        return Err("write_input_remote with Local endpoint; use write_input instead".into());
    }
    let transport = get_transport(&state, &endpoint_id)?;
    transport
        .write_input(id, &bytes)
        .await
        .map_err(String::from)
}

#[tauri::command]
pub async fn resize_session(
    id: SessionId,
    cols: u16,
    rows: u16,
    // Phase 11.2:可选 endpoint;前端不传 = Local(向后兼容,改造前行为)
    endpoint_id: Option<EndpointId>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let endpoint_id = endpoint_id.unwrap_or(EndpointId::Local);
    let transport = get_transport(&state, &endpoint_id)?;
    // LocalTransport::resize 内部已做 MIN_COLS/MIN_ROWS 校验(与改造前一致)
    transport.resize(id, cols, rows).await.map_err(String::from)
}

#[tauri::command]
pub async fn kill_session(
    id: SessionId,
    // Phase 11.2:可选 endpoint;前端不传 = Local(向后兼容)
    endpoint_id: Option<EndpointId>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let endpoint_id = endpoint_id.unwrap_or(EndpointId::Local);
    let transport = get_transport(&state, &endpoint_id)?;
    transport.kill(id).await.map_err(String::from)
}

#[tauri::command]
pub async fn set_title(
    id: SessionId,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut g = state.ctx.sessions.lock();
    let s = g.get_mut(&id).ok_or_else(|| format!("no session {id}"))?;
    s.state.title = title.clone();
    s.state.title_pinned = true;
    let session_id = s.session_id.clone();
    let backend_key = s.backend_key.clone();
    let cwd = s.cwd.clone();
    drop(g);
    if let Some(sid) = session_id {
        let mut persisted = crate::persistence::load();
        persisted.session_titles.insert(sid.clone(), title.clone());
        state.persist.request_save(persisted);
        persist_renamed_session_title_to_jsonl(&backend_key, &cwd, &sid, &title)?;
    }
    Ok(())
}

fn persist_renamed_session_title_to_jsonl(
    backend_key: &str,
    cwd: &std::path::Path,
    session_id: &str,
    title: &str,
) -> Result<(), String> {
    let Some(backend) = kode_core::session::jsonl_tail::Backend::from_backend_key(backend_key)
    else {
        return Ok(());
    };
    if backend == kode_core::session::jsonl_tail::Backend::Codex {
        return Ok(());
    }
    let Some(path) = kode_core::session::jsonl_tail::resolve_session_path(backend, cwd, session_id)
        .or_else(|| backend.session_path(cwd, session_id))
    else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create session dir {}: {e}", parent.display()))?;
    }
    let line = serde_json::json!({
        "type": "ai-title",
        "aiTitle": title,
        "sessionId": session_id,
        "source": "kode"
    });
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open session jsonl {}: {e}", path.display()))?;
    use std::io::Write;
    writeln!(file, "{line}").map_err(|e| format!("write session title {}: {e}", path.display()))
}

#[tauri::command]
pub async fn get_screen_snapshot(
    id: SessionId,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let g = state.ctx.sessions.lock();
    let s = g.get(&id).ok_or_else(|| format!("no session {id}"))?;
    // contents_formatted() 只重放可见内容 + SGR + 光标,**不重放 DEC private modes**。
    // screen_snapshot_bytes() 在其后补上鼠标上报 / bracketed-paste / application-cursor
    // 等模式的 enable 序列,否则 tab 切换重建 xterm 后这些模式会丢(鼠标移动变文本选择)。
    let bytes = s.screen_snapshot_bytes();
    drop(g);
    // 这里只做只读快照,绝不能清 pending。清理动作与实时订阅不在同一个临界区时,
    // 会把快照生成后刚到达的 ANSI/文本字节一起删掉。Terminal 首次挂载改由
    // subscribe_session_bytes 原子取走原始 pending,本命令仅保留给诊断/兼容调用。
    // UTF-8 加固:screen_snapshot_bytes 应始终返回合法 UTF-8(vt100 cell contents
    // 是纯文本),但若因 bug 产生非法字节,from_utf8_lossy 会静默替换为 U+FFFD。
    // 这里先做严格校验,失败时记录 warning 再 fallback 到 lossy 转换。
    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(e) => {
            tracing::warn!(
                id,
                offset = e.valid_up_to(),
                ?e,
                "screen_snapshot_bytes returned invalid UTF-8, falling back to lossy"
            );
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

#[allow(dead_code)]
fn _ensure_traits() {
    fn assert<T: Serialize + for<'de> Deserialize<'de>>() {}
    assert::<SessionId>();
}

// ============ 持久化 / 多窗口 ============

#[derive(Debug, Serialize, Deserialize)]
pub struct PersistedTabDto {
    pub backend_key: String,
    pub title: String,
    #[serde(default)]
    pub title_pinned: bool,
    pub cwd: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// **Phase 11.2** Local 不写字段(向后兼容);Remote 写入。
    #[serde(default)]
    pub endpoint_id: Option<EndpointId>,
    /// 用户选定的 gallery avatar id。前端 schedulePersist 写入,restore 时读回。
    #[serde(default)]
    pub avatar_id: Option<String>,
}

fn dedupe_persisted_tabs(tabs: Vec<PersistedTabDto>) -> Vec<PersistedTabDto> {
    let mut seen: HashSet<(String, Option<String>, String)> = HashSet::new();
    tabs.into_iter()
        .filter(|t| {
            let Some(session_id) = t.session_id.as_deref().filter(|s| !s.is_empty()) else {
                return true;
            };
            let endpoint_key = match &t.endpoint_id {
                Some(endpoint_id) => format!("{endpoint_id:?}"),
                None => "local".to_string(),
            };
            seen.insert((
                t.backend_key.clone(),
                Some(session_id.to_string()),
                endpoint_key,
            ))
        })
        .collect()
}

#[tauri::command]
pub fn get_persisted_tabs() -> Vec<PersistedTabDto> {
    let s = crate::persistence::load();
    dedupe_persisted_tabs(
        s.tabs
            .into_iter()
            .map(|t| PersistedTabDto {
                backend_key: t.backend_key,
                title: t.title,
                title_pinned: t.title_pinned,
                cwd: t.cwd,
                session_id: t.session_id,
                model: t.model,
                permission_mode: t.permission_mode,
                endpoint_id: t.endpoint_id,
                avatar_id: t.avatar_id,
            })
            .collect(),
    )
}

#[tauri::command]
pub fn save_tabs(tabs: Vec<PersistedTabDto>, state: State<'_, AppState>) -> Result<(), String> {
    let mut persisted = crate::persistence::load();
    persisted.version = 1;
    persisted.tabs = dedupe_persisted_tabs(tabs)
        .into_iter()
        .map(|t| crate::persistence::PersistedTab {
            backend_key: t.backend_key,
            title: t.title,
            title_pinned: t.title_pinned,
            cwd: t.cwd,
            session_id: t.session_id,
            model: t.model,
            permission_mode: t.permission_mode,
            endpoint_id: t.endpoint_id,
            avatar_id: t.avatar_id,
        })
        .collect();
    state.persist.request_save(persisted);
    Ok(())
}

// ============ Theme(全局 UI 主题持久化)============

/// 读 state.json 的 theme;空/None 时返回 "system"(走 prefers-color-scheme)。
#[tauri::command]
pub fn get_theme() -> String {
    crate::persistence::load()
        .theme
        .unwrap_or_else(|| "system".into())
}

// ============ Locale(全局 UI 语言持久化)============

fn validate_locale_mode(locale: &str) -> Result<(), String> {
    if !matches!(locale, "system" | "en" | "zh-CN") {
        return Err(format!(
            "invalid locale: {locale} (expected system/en/zh-CN)"
        ));
    }
    Ok(())
}

/// 读 state.json 的 locale;空/None 时返回 "system"(走 navigator.language)。
#[tauri::command]
pub fn get_locale() -> String {
    crate::persistence::load()
        .locale
        .unwrap_or_else(|| "system".into())
}

/// 写 state.json 的 locale。仅接受 "system" / "en" / "zh-CN"。
#[tauri::command]
pub fn set_locale(
    app: tauri::AppHandle,
    locale: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_locale_mode(&locale)?;
    let mut s = crate::persistence::load();
    s.version = 1;
    s.locale = Some(locale.clone());
    state.persist.request_save(s);

    // SpecOps 独立窗口无 Tauri IPC,用 postMessage 通知其前端 runtime 切换。
    use tauri::Manager;
    let js = format!(
        "window.postMessage({{type:'specops.locale',locale:{}}}, '*');",
        serde_json::to_string(&locale).map_err(|e| e.to_string())?
    );
    for (_, win) in app.webview_windows() {
        if win.label().starts_with("specops-") {
            let _ = win.eval(&js);
        }
    }
    Ok(())
}

/// 写 state.json 的 theme。仅接受 "light" / "dark" / "system",其它值拒绝。
/// 走 PersistWriter 的 debounce(500ms),避免每次点击都同步 IO。
#[tauri::command]
pub fn set_theme(
    app: tauri::AppHandle,
    theme: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !matches!(theme.as_str(), "light" | "dark" | "system") {
        return Err(format!(
            "invalid theme: {theme} (expected light/dark/system)"
        ));
    }
    let mut s = crate::persistence::load();
    s.version = 1;
    s.theme = Some(theme.clone());
    state.persist.request_save(s);

    // 让系统级 model monitor 等同源 Tauri 伴随窗口即时跟随主窗口切换。
    // 主窗口本身已经乐观更新本地状态，收到这个广播也无需额外处理。
    use tauri::Emitter;
    let _ = app.emit("theme-changed", theme.clone());

    // 广播主题切换到所有 SpecOps 独立窗口。SpecOps 窗口加载的是外部 URL
    // (http://127.0.0.1:port),没有 Tauri IPC,用 webview.eval() 直接操作
    // DOM attribute,CSS 的 [data-theme] 选择器自然响应。首屏主题已由
    // open_specops_window 的 URL fragment 覆盖,这里只处理切换跟随。
    use tauri::Manager;
    let js = match theme.as_str() {
        "light" | "dark" => {
            format!("document.documentElement.setAttribute('data-theme','{theme}');")
        }
        _ => "document.documentElement.removeAttribute('data-theme');".to_string(),
    };
    for (_, win) in app.webview_windows() {
        if win.label().starts_with("specops-") {
            let _ = win.eval(&js);
        }
    }
    Ok(())
}

// ============ Memory browse filter 持久化(M4.3)============

/// 读 state.json 的 memory_browse_state。前端 BrowseFilterState 的镜像 —
/// 用户上次离开 Browse 面板时的 scope / kinds / include_deprecated。
#[tauri::command]
pub fn memory_browse_state_get(
    state: State<'_, AppState>,
) -> Result<Option<crate::persistence::MemoryBrowseState>, String> {
    let _ = state; // 不需要 AppState 字段,但保留参数以符合 Tauri 命令签名习惯
    Ok(crate::persistence::load().memory_browse_state)
}

/// 写 state.json 的 memory_browse_state。debounce 500ms。
#[tauri::command]
pub fn memory_browse_state_set(
    next: crate::persistence::MemoryBrowseState,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = crate::persistence::load();
    s.version = 1;
    s.memory_browse_state = Some(next);
    state.persist.request_save(s);
    Ok(())
}

#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    let label = format!(
        "kode-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let url = tauri::WebviewUrl::App("index.html?skip_persist=1".into());
    WebviewWindowBuilder::new(&app, &label, url)
        .title("kode")
        .inner_size(1100.0, 720.0)
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(|e| format!("create window failed: {e}"))?;
    Ok(())
}

/// 把 kode 主窗口拉到最前并聚焦。
///
/// SpecOps 窗口里点 "Open in kode" 时,主窗口可能被 SpecOps 窗口遮挡或最小化。
/// 在 macOS 上,webview 层的 `setFocus()` 对被遮挡的同 app 窗口经常不生效,
/// 因此从 Rust 侧用窗口级 `unminimize + show + set_focus` 可靠置前。
#[tauri::command]
pub async fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let _ = win.unminimize();
    let _ = win.show();
    win.set_focus()
        .map_err(|e| format!("set_focus failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_specops_window(
    app: tauri::AppHandle,
    session: super::specops::SpecOpsSession,
    theme: String,
    locale: String,
) -> Result<(), String> {
    validate_locale_mode(&locale)?;
    let label = format!(
        "specops-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    if session.token.len() < 32 {
        return Err("invalid SpecOps session token".into());
    }
    let mut url = session
        .origin
        .parse::<url::Url>()
        .map_err(|e| format!("invalid SpecOps URL: {e}"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
    {
        return Err("SpecOps window only accepts a loopback HTTP origin".into());
    }
    let allowed_origin = url.origin().ascii_serialization();
    url.set_fragment(Some(&format!(
        "token={}&theme={}&locale={}",
        session.token, theme, locale
    )));
    // The SpecOps console renders its own drag strip (Rail `.rail-top` with
    // `data-tauri-drag-region`). Tauri injects drag.js into this frame even for
    // an external URL, so mousedown on that strip calls
    // `plugin:window|start_dragging` over IPC. But the console is loaded from a
    // REMOTE (loopback HTTP) origin, so those window commands are ACL-denied
    // unless the origin is whitelisted — see capabilities/specops.json, which
    // grants start-dragging/toggle-maximize to `http://127.0.0.1:*` for
    // `specops-*` windows. Without that capability the drag strip does nothing.
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title("")
        .inner_size(1200.0, 800.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .on_navigation(move |candidate| candidate.origin().ascii_serialization() == allowed_origin)
        .build()
        .map_err(|e| format!("create specops window failed: {e}"))?;
    Ok(())
}

// ============ Pairing(Phase 9.1.2-final)============

/// 给 Flutter 配对屏的载荷:host + port + token + 完整 URI。
///
/// 行为:
/// - host 默认是 "127.0.0.1"。如果用户跨设备配对(同 LAN / Tailscale),
///   桌面 GUI 这边没法知道"对方眼里的 host";前端弹层提示用户改成
///   实际可达地址(LAN IP / Tailscale 主机名),即时重算 QR 内容。
/// - port:bridge 实际监听端口,从 listen_addr 读;桥未起来 → bridge_disabled = true
/// - token:state.json 持久化的 32-hex bearer
/// - uri:`kode://pair?host=…&port=…&token=…`,Flutter 端扫描后直接解析
#[derive(Debug, Serialize)]
pub struct PairingPayload {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub uri: String,
    pub bridge_disabled: bool,
}

#[tauri::command]
pub fn get_pairing_payload(state: State<'_, AppState>) -> PairingPayload {
    let token = state.ctx.token.as_ref().clone();
    let addr_opt = *state.ctx.listen_addr.lock();

    match addr_opt {
        Some(addr) => {
            // 默认 host 用本机 LAN IP,前端可再改
            let host = detect_lan_ip();
            let port = addr.port();
            let uri = format!("kode://pair?host={host}&port={port}&token={token}");
            PairingPayload {
                host,
                port,
                token,
                uri,
                bridge_disabled: false,
            }
        }
        None => PairingPayload {
            host: String::new(),
            port: 0,
            token,
            uri: String::new(),
            bridge_disabled: true,
        },
    }
}

// ============ Paths(GUI 启动 banner)============
//
// 行为约定(用户已确认):
//   - 切换 session_cwd → 立即生效,只影响后续新 tab,不重启已有 tab
//   - 切换 config_path → 持久化 + 立刻把新 toml 里的 backends 反映到 ctx.config 里(尽量),
//     但若用户已开 tab 不会回放;backends 列表对前端的影响在下次 listBackends 调用时显现
//
// 注意:`config` 字段在 BridgeCtx 是不可变的(`Config`,非 `Mutex`),
// 真正切换 config 文件**需要重启** GUI 才能让 backends 列表干净更新。
// 这里的 set_config_path 只做持久化 + 返回新 path 的解析结果(让前端可以提示重启)。

#[derive(Debug, Serialize)]
pub struct PathsConfig {
    /// 当前生效的 session 工作目录(给新 tab 用)
    pub session_cwd: String,
    /// 是否是用户显式设置的(true)还是默认回退的(false)
    pub session_cwd_overridden: bool,
    /// 当前 config.toml 路径
    pub config_path: String,
    /// 是否是用户显式设置的(true)还是 dirs::config_dir 默认(false)
    pub config_path_overridden: bool,
    /// config.toml 是否实际存在
    pub config_exists: bool,
}

#[tauri::command]
pub fn get_paths_config(state: State<'_, AppState>) -> PathsConfig {
    let cwd_override = state.ctx.session_cwd_override.lock().clone();
    let cfg_override = state.ctx.config_path.lock().clone();

    let session_cwd_overridden = cwd_override.is_some();
    let session_cwd = cwd_override
        .unwrap_or_else(|| resolve_session_cwd(None, &state))
        .to_string_lossy()
        .into_owned();

    let config_path_overridden = cfg_override.is_some();
    let config_path = cfg_override
        .or_else(kode_core::config::Config::path)
        .unwrap_or_else(|| std::path::PathBuf::from("~/.config/kode/config.toml"))
        .to_string_lossy()
        .into_owned();

    let config_exists = std::path::Path::new(&config_path).is_file();

    PathsConfig {
        session_cwd,
        session_cwd_overridden,
        config_path,
        config_path_overridden,
        config_exists,
    }
}

/// 设置 session cwd override。空字符串 = 清除 override 走默认。
/// 路径不存在 → 返回错误,前端弹错。
#[tauri::command]
pub fn set_session_cwd(path: String, state: State<'_, AppState>) -> Result<PathsConfig, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        *state.ctx.session_cwd_override.lock() = None;
    } else {
        let p = std::path::PathBuf::from(trimmed);
        if !p.is_dir() {
            return Err(format!("not a directory: {trimmed}"));
        }
        *state.ctx.session_cwd_override.lock() = Some(p);
    }
    persist_paths(&state);
    Ok(get_paths_config(state))
}

/// 设置 config.toml 路径 override。空字符串 = 清除 override 走默认路径。
/// 文件不存在不报错 — 用户可能是要切到一个还没建的路径,GUI 重启后会用 default 兜底。
/// 切换需要**重启 GUI** 才能让 backends 列表生效;前端应提示用户。
#[tauri::command]
pub fn set_config_path(path: String, state: State<'_, AppState>) -> Result<PathsConfig, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        *state.ctx.config_path.lock() = None;
    } else {
        let p = std::path::PathBuf::from(trimmed);
        // 允许文件不存在,但若是目录则拒绝(避免用户误选目录)
        if p.is_dir() {
            return Err(format!("expected a file, got a directory: {trimmed}"));
        }
        *state.ctx.config_path.lock() = Some(p);
    }
    persist_paths(&state);
    Ok(get_paths_config(state))
}

/// 返回 $HOME 路径(给前端做 ~ 缩写显示)。失败返回空串,前端按 fallback 处理。
#[tauri::command]
pub fn get_home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 读取某 bucket 的 cwd 历史(top 5)。
///
/// `bucket`:`"local"` = 本地;其它字符串 = 远端 endpoint_id。
#[tauri::command]
pub fn cwd_history_get(bucket: String) -> Vec<String> {
    let state = crate::persistence::load();
    crate::persistence::get_cwd_history(&state, &bucket)
}

/// 把一个 cwd 推进某 bucket 的历史(top 5,去重),立即落盘。
///
/// `bucket`:`"local"` = 本地;其它字符串 = 远端 endpoint_id。
/// 空 cwd 会被忽略(不记录、不报错)。
#[tauri::command]
pub fn cwd_history_push(bucket: String, cwd: String) -> Result<(), String> {
    let mut state = crate::persistence::load();
    crate::persistence::push_cwd_history(&mut state, &bucket, &cwd);
    crate::persistence::save_sync(&state).map_err(|e| format!("persist failed: {e}"))
}

/// 读系统剪贴板文本(在 Rust 侧调用,绕过 WKWebView 的剪贴板权限弹窗)。
/// 返回空字符串表示剪贴板为空或不含文本内容。
#[tauri::command]
pub fn read_clipboard() -> String {
    arboard::Clipboard::new()
        .ok()
        .and_then(|mut cb| cb.get_text().ok())
        .unwrap_or_default()
}

/// 列出某个工作目录下指定 backend 的所有历史 session。
///
/// 扫描 `~/.codebuddy/projects/<slug>/`、`~/.claude/projects/<slug>/`
/// 或 `~/.codex/sessions/**` 目录,
/// 读取每个 `.jsonl` 文件,提取 session_id / title / model / 当前 tokens / mtime。
///
/// 返回按 mtime 降序排列的 session 列表,供前端"恢复历史 session"面板使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    /// session uuid(文件名去 .jsonl 后缀)
    pub session_id: String,
    /// 从 jsonl aiTitle 行提取的标题(可能为空)
    pub title: Option<String>,
    /// 最后使用的 model(从 providerData.requestModelId/model 提取)
    pub model: Option<String>,
    /// 当前 total tokens(取最新 usage,不跨轮次累加)
    pub total_tokens: Option<u64>,
    /// 文件最后修改时间(UNIX epoch 秒)
    pub last_modified_secs: u64,
}

#[tauri::command]
pub fn list_sessions_for_cwd(
    backend_key: String,
    cwd: String,
) -> Result<Vec<SessionSummary>, String> {
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.is_absolute() {
        return Err("cwd must be an absolute path".into());
    }

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let pinned_titles = crate::persistence::load().session_titles;
    let mut sessions: Vec<SessionSummary> = Vec::new();

    if backend_key == "codex" {
        let root = home.join(".codex").join("sessions");
        collect_codex_session_summaries(&root, cwd_path, &pinned_titles, &mut sessions);
    } else {
        let slug = cwd.trim_start_matches('/').replace('/', "-");
        let projects_dir = match backend_key.as_str() {
            "codebuddy" => home.join(".codebuddy").join("projects").join(&slug),
            "claude" | "claude-internal" => {
                let claude_slug = format!("-{}", slug);
                home.join(".claude").join("projects").join(&claude_slug)
            }
            _ => return Ok(Vec::new()),
        };

        if !projects_dir.is_dir() {
            return Ok(Vec::new());
        }

        let entries =
            std::fs::read_dir(&projects_dir).map_err(|e| format!("read_dir failed: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("entry error: {e}"))?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|s| s.to_str()).map(String::from)
            else {
                continue;
            };
            if session_id.is_empty() {
                continue;
            }
            let last_modified_secs = modified_secs(&path);
            let (title, model, total_tokens) = extract_session_meta(&path);
            let title = session_title_with_override(&session_id, title, &pinned_titles);

            sessions.push(SessionSummary {
                session_id,
                title,
                model,
                total_tokens,
                last_modified_secs,
            });
        }
    }

    dedupe_session_summaries(&mut sessions);

    Ok(sessions)
}

/// 按最新修改时间保留每个逻辑 session 的一个 rollout。
///
/// Codex 的 `resume` 会创建新的 rollout 文件，但其 session_meta 仍可能指向
/// 同一个逻辑 session_id。这里必须去重，确保前端的
/// `{#each sessions as s (s.session_id)}` 不会收到重复 key。
fn dedupe_session_summaries(sessions: &mut Vec<SessionSummary>) {
    sessions.sort_by(|a, b| b.last_modified_secs.cmp(&a.last_modified_secs));
    let mut seen = HashSet::new();
    sessions.retain(|session| seen.insert(session.session_id.clone()));
}

fn collect_codex_session_summaries(
    dir: &Path,
    cwd: &Path,
    pinned_titles: &HashMap<String, String>,
    sessions: &mut Vec<SessionSummary>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_codex_session_summaries(&path, cwd, pinned_titles, sessions);
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some((session_id, session_cwd)) = codex_session_meta(&path) else {
            continue;
        };
        if session_cwd != cwd {
            continue;
        }
        let (title, model, total_tokens) = extract_session_meta(&path);
        let title = session_title_with_override(&session_id, title, pinned_titles);
        sessions.push(SessionSummary {
            session_id,
            title,
            model,
            total_tokens,
            last_modified_secs: modified_secs(&path),
        });
    }
}

fn modified_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn session_title_with_override(
    session_id: &str,
    jsonl_title: Option<String>,
    pinned_titles: &HashMap<String, String>,
) -> Option<String> {
    pinned_titles.get(session_id).cloned().or(jsonl_title)
}

fn codex_session_meta(path: &Path) -> Option<(String, PathBuf)> {
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines().take(8) {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = v.get("payload")?;
        let sid = payload
            .get("session_id")
            .or_else(|| payload.get("id"))
            .and_then(|v| v.as_str())?;
        let cwd = payload.get("cwd").and_then(|v| v.as_str())?;
        return Some((sid.to_string(), PathBuf::from(cwd)));
    }
    None
}

/// 从 jsonl 文件读取 title / 最新 model,并提取当前 tokens。
pub(crate) fn extract_session_meta(
    path: &std::path::Path,
) -> (Option<String>, Option<String>, Option<u64>) {
    use std::io::{BufRead, BufReader};

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None, None),
    };

    let reader = BufReader::new(file);
    let lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).collect();

    if lines.is_empty() {
        return (None, None, None);
    }

    let mut title: Option<String> = None;
    let mut model: Option<String> = None;
    let mut total_tokens = 0_u64;
    let mut saw_tokens = false;

    // 扫完整文件找最新 aiTitle 或第一条用户消息；title 往往在会话开始后若干行才生成。
    for line in &lines {
        if let Some(t) = extract_title_from_line(line) {
            title = Some(t);
        } else if title.is_none() {
            title = extract_user_title_from_line(line).or_else(|| extract_codex_user_title(line));
        }
    }

    // model 取最新 providerData 或 Codex turn_context。
    for line in lines.iter().rev() {
        if model.is_none() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(pd) = v.get("providerData") {
                    if model.is_none() {
                        model = pd
                            .get("requestModelId")
                            .or_else(|| pd.get("model"))
                            .and_then(|v| v.as_str())
                            .map(|m| kode_core::model_alias::sanitize_model_name(&m));
                    }
                } else if v.get("type").and_then(|t| t.as_str()) == Some("turn_context") {
                    model = v
                        .get("payload")
                        .and_then(|p| p.get("model"))
                        .and_then(|v| v.as_str())
                        .map(kode_core::model_alias::sanitize_model_name);
                }
            }
        }
        if model.is_some() {
            break;
        }
    }

    for line in &lines {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(t) = v
                .get("providerData")
                .and_then(|pd| pd.get("usage"))
                .and_then(|u| u.get("totalTokens"))
                .and_then(|v| v.as_u64())
            {
                total_tokens = t;
                saw_tokens = true;
            } else if let Some(t) = v
                .get("payload")
                .filter(|_| v.get("type").and_then(|t| t.as_str()) == Some("event_msg"))
                .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("token_count"))
                .and_then(|p| p.get("info"))
                .and_then(|i| {
                    i.get("last_token_usage")
                        .or_else(|| i.get("total_token_usage"))
                })
                .and_then(|u| u.get("total_tokens"))
                .and_then(|v| v.as_u64())
            {
                total_tokens = t;
                saw_tokens = true;
            }
        }
    }

    (title, model, saw_tokens.then_some(total_tokens))
}

fn extract_codex_user_title(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let payload = v.get("payload")?;
    if v.get("type").and_then(|t| t.as_str()) != Some("response_item")
        || payload.get("type").and_then(|t| t.as_str()) != Some("message")
        || payload.get("role").and_then(|r| r.as_str()) != Some("user")
    {
        return None;
    }
    let text = json_content_to_text(payload.get("content")?)?;
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with("C-b")
        || is_codex_title_noise(trimmed)
    {
        return None;
    }
    Some(trimmed.chars().take(60).collect())
}

fn is_codex_title_noise(s: &str) -> bool {
    s.starts_with("# AGENTS.md instructions")
        || s.starts_with("<environment_context>")
        || s.starts_with("<kode-memory>")
        || s.starts_with("<permissions instructions>")
        || s.starts_with("<collaboration_mode>")
        || s.starts_with("<skills_instructions>")
}

fn extract_title_from_line(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
        v.get("aiTitle").and_then(|t| t.as_str()).map(String::from)
    } else {
        None
    }
}

fn extract_user_title_from_line(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let role_is_user = v.get("role").and_then(|r| r.as_str()) == Some("user")
        || v.get("type").and_then(|t| t.as_str()) == Some("user");
    if !role_is_user {
        return None;
    }
    let text = json_content_to_text(
        v.get("content")
            .or_else(|| v.get("message").and_then(|m| m.get("content")))?,
    )?;
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.starts_with("C-b") {
        return None;
    }
    Some(trimmed.chars().take(60).collect())
}

fn json_content_to_text(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = v.as_array() {
        let text = arr
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("input_text"))
                    .or_else(|| item.get("output_text"))
                    .or_else(|| item.get("content"))
                    .and_then(|x| x.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
}

/// 把当前 paths override 同步到磁盘上的 state.json(merge 进现有 PersistedState)。
fn persist_paths(state: &AppState) {
    let mut s = crate::persistence::load();
    s.version = 1;
    s.session_cwd = state
        .ctx
        .session_cwd_override
        .lock()
        .clone()
        .map(|p| p.to_string_lossy().into_owned());
    s.config_path = state
        .ctx
        .config_path
        .lock()
        .clone()
        .map(|p| p.to_string_lossy().into_owned());
    state.persist.request_save(s);
}

#[cfg(test)]
mod specops_bridge_tests {
    use std::net::{Ipv4Addr, SocketAddr};
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;

    use super::{
        dedupe_session_summaries, extract_session_meta, wait_for_bridge_addr, SessionSummary,
    };

    #[test]
    fn extract_session_meta_uses_latest_codebuddy_usage_tokens() {
        let path = std::env::temp_dir().join(format!(
            "kode-gui-session-meta-{}.jsonl",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"ai-title","aiTitle":"Token test"}"#,
                "\n",
                r#"{"type":"message","role":"assistant","providerData":{"requestModelId":"Claude-Opus-4.8","usage":{"totalTokens":100,"inputTokens":80,"outputTokens":20}}}"#,
                "\n",
                r#"{"type":"message","role":"assistant","providerData":{"requestModelId":"Claude-Opus-4.8","usage":{"totalTokens":250,"inputTokens":200,"outputTokens":50}}}"#,
                "\n",
            ),
        )
        .unwrap();

        let (title, model, total_tokens) = extract_session_meta(&path);

        let _ = std::fs::remove_file(&path);

        assert_eq!(title.as_deref(), Some("Token test"));
        assert_eq!(model.as_deref(), Some("Claude-Opus-4.8"));
        assert_eq!(total_tokens, Some(250));
    }

    #[test]
    fn extract_session_meta_skips_codex_startup_context_title() {
        let path = std::env::temp_dir().join(format!(
            "kode-gui-codex-session-meta-{}.jsonl",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(
            &path,
            concat!(
                r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/p\n\n<INSTRUCTIONS>...</INSTRUCTIONS>"}]}}"##,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"真实 Codex 用户问题"}]}}"#,
                "\n",
                r#"{"type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/tmp/p"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":9999999},"last_token_usage":{"total_tokens":123}}}}"#,
                "\n",
            ),
        )
        .unwrap();

        let (title, model, total_tokens) = extract_session_meta(&path);

        let _ = std::fs::remove_file(&path);

        assert_eq!(title.as_deref(), Some("真实 Codex 用户问题"));
        assert_eq!(model.as_deref(), Some("gpt-5.5"));
        assert_eq!(total_tokens, Some(123));
    }

    #[test]
    fn session_history_keeps_only_the_latest_rollout_for_each_session_id() {
        let mut sessions = vec![
            SessionSummary {
                session_id: "same-session".into(),
                title: Some("older rollout".into()),
                model: None,
                total_tokens: None,
                last_modified_secs: 10,
            },
            SessionSummary {
                session_id: "other-session".into(),
                title: None,
                model: None,
                total_tokens: None,
                last_modified_secs: 15,
            },
            SessionSummary {
                session_id: "same-session".into(),
                title: Some("newer rollout".into()),
                model: None,
                total_tokens: None,
                last_modified_secs: 20,
            },
        ];

        dedupe_session_summaries(&mut sessions);

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_id, "same-session");
        assert_eq!(sessions[0].title.as_deref(), Some("newer rollout"));
        assert_eq!(sessions[1].session_id, "other-session");
    }

    #[tokio::test]
    async fn waits_for_bridge_to_publish_its_address() {
        let listen_addr = Arc::new(Mutex::new(None));
        let published = Arc::clone(&listen_addr);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            *published.lock() = Some(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 12345));
        });

        let address = wait_for_bridge_addr(listen_addr).await.unwrap();

        assert_eq!(address.port(), 12345);
    }
}
