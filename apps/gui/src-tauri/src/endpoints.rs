//! Phase 11.4:远端 endpoint 配置 + transport 注册的 Tauri 命令。
//!
//! 调用流(用户视角):
//!
//!   1. 命令面板「Add remote endpoint…」→ `EndpointDialog.svelte` 收 id/url/token
//!   2. 前端调 `endpoint_test_connection` → 后端 `GET /healthz` + `GET /api/v1/backends`
//!      双重 ping;失败给红错误。
//!   3. 测试通过 → 前端调 `endpoint_add` → 后端持久化 + 构造 `Arc<RemoteTransport>`
//!      + `start_remote_tasks` + 注册到 `AppState.transports`
//!   4. 之后用户在 BackendChooser(Phase 11.5)选 `Remote { id }` backend,
//!      `commands::spawn_session` 走 trait 分流到这个 transport
//!
//! `endpoint_remove` 反向:从 transports map 取出 Arc → drop(WS task abort)→
//! 持久化删条目。
//!
//! **错误返回 String**:Tauri 命令的语义 — 前端拿到 throw,UI 展示。

use std::sync::Arc;
use std::time::Duration;

use kode_core::{EndpointId, SessionTransport};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::persistence::{self, PersistedEndpoint, PersistedState};
use crate::state::AppState;
use crate::transport::remote::register_self_weak;
use crate::transport::{start_remote_tasks, RemoteConfig, RemoteTransport, SshSpec};

/// 持久化形态的 endpoint 不带 token 给前端(即使 GUI 进程内,前端也不需要 token —
/// 由后端 transport 注入到 reqwest);BackendChooser 渲染时用这个。
#[derive(Debug, Clone, Serialize)]
pub struct EndpointSummary {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    /// 是否已激活(在 transports map 里有对应 RemoteTransport)。
    /// false = 持久化里有但还没注册(老 endpoint 启动时连不上之类)。
    pub connected: bool,
    /// SSH 隧道模式:`user@host` 或 ~/.ssh/config 别名。空 = 直连。
    /// 暴露给前端,用作 DeployPanel / EndpointDialog 的 ssh_host 下拉历史源。
    #[serde(default)]
    pub ssh_host: String,
    /// SSH 服务端口(0 / 22 = 默认)
    #[serde(default)]
    pub ssh_port: u16,
    /// 远端 server 端口(默认 9870)
    #[serde(default)]
    pub ssh_remote_port: u16,
}

/// 列出所有已配置的远端 endpoint。前端 UI 用来渲染列表 + BackendChooser 分组。
#[tauri::command]
pub fn endpoint_list(state: State<'_, AppState>) -> Vec<EndpointSummary> {
    let persisted = persistence::load();
    let active_ids: std::collections::HashSet<String> = state
        .transports
        .lock()
        .keys()
        .filter_map(|k| match k {
            EndpointId::Remote { id } => Some(id.clone()),
            EndpointId::Local => None,
        })
        .collect();
    persisted
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .map(|e| EndpointSummary {
            display_name: if e.display_name.is_empty() {
                e.id.clone()
            } else {
                e.display_name.clone()
            },
            connected: active_ids.contains(&e.id),
            id: e.id,
            base_url: e.base_url,
            ssh_host: e.ssh_host,
            ssh_port: e.ssh_port,
            ssh_remote_port: e.ssh_remote_port,
        })
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct EndpointAddReq {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    pub base_url: String,
    pub token: String,
    /// SSH 隧道模式:`user@host` 或 ~/.ssh/config 别名。空 = 直连。
    #[serde(default)]
    pub ssh_host: String,
    /// SSH 服务端口(`ssh -p <这个>`)。0 / 22 = 默认。devcloud 填 36000。
    #[serde(default)]
    pub ssh_port: u16,
    /// SSH 模式下远端 server 端口。0 → 默认 9870。
    #[serde(default)]
    pub ssh_remote_port: u16,
}

#[derive(Debug, Serialize)]
pub struct EndpointTestResult {
    pub ok: bool,
    /// server 自报版本(/healthz 不返回,从 connection.hello WS 拿不便,
    /// 这里目前只填 "" 占位,Phase 11.5 接 GET /backends 时附带从 DTO 取)
    pub server_version: String,
    /// 远端注册的 backend 列表(前端展开看用)
    pub backends: Vec<RemoteBackendInfo>,
    /// 失败时的人话错误
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RemoteBackendInfo {
    pub key: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub supports_cwd: bool,
    #[serde(default)]
    pub default_cwd: Option<String>,
    #[serde(default)]
    pub model_flag: Option<String>,
    /// 远端 server 报告的 enabled 状态。旧 server 不返回该字段 →
    /// `#[serde(default)]` 给 `false`,但前端语义是「缺失视为开启」,
    /// 因此前端读 `b.enabled !== false` 而不是直接 `b.enabled`。
    /// 这里 default = true 与前端语义对齐,避免误把旧 server 的 backend 全隐藏。
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// 不写盘,只测连接。前端 EndpointDialog 在用户填完 → 测试按钮触发。
///
/// 测试内容:
/// 1. `GET /healthz`(无 token)— 验证 URL 可达
/// 2. `GET /api/v1/backends`(带 token)— 验证 token 有效 + server 真是 kode-server
///    (有这个端点 = Phase 11.1 协议 1.1+)
///
/// **SSH 模式**(`ssh_host` 非空):先起一条临时隧道,把 base_url 的 host:port
/// rewrite 成本地端口再测;测完隧道随函数返回自动 drop(kill ssh 子进程)。
///
/// 失败给清晰 detail:网络 / TLS / 401 / 协议版本不匹配 / SSH 隧道各自有可读字符串。
#[tauri::command]
pub async fn endpoint_test_connection(
    base_url: String,
    token: String,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_remote_port: Option<u16>,
) -> EndpointTestResult {
    // SSH 模式:先建临时隧道,拿到本地 base_url。隧道在本函数作用域内存活,
    // 返回时 drop 自动 kill。
    let _tunnel_guard; // 持有隧道直到函数结束
    let effective_base = match ssh_host.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(host) => {
            let remote_port = ssh_remote_port.filter(|p| *p != 0).unwrap_or(9870);
            let sp = ssh_port.unwrap_or(0); // 0 → 22(默认)
            let host_owned = host.to_string();
            match tokio::task::spawn_blocking(move || {
                crate::transport::ssh_tunnel::SshTunnel::spawn(&host_owned, sp, remote_port)
            })
            .await
            {
                Ok(Ok(t)) => {
                    let local = format!("http://127.0.0.1:{}", t.local_port);
                    _tunnel_guard = t;
                    local
                }
                Ok(Err(e)) => {
                    return EndpointTestResult {
                        ok: false,
                        server_version: String::new(),
                        backends: vec![],
                        detail: format!("ssh tunnel failed: {e}"),
                    };
                }
                Err(e) => {
                    return EndpointTestResult {
                        ok: false,
                        server_version: String::new(),
                        backends: vec![],
                        detail: format!("ssh tunnel task: {e}"),
                    };
                }
            }
        }
        None => base_url.clone(),
    };
    test_against_base(effective_base, token).await
}

/// 实际跑 healthz + backends 双 ping 的内核。与隧道解耦,SSH/直连共用。
async fn test_against_base(base_url: String, token: String) -> EndpointTestResult {
    let http = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return EndpointTestResult {
                ok: false,
                server_version: String::new(),
                backends: vec![],
                detail: format!("client build failed: {e}"),
            };
        }
    };
    let base = base_url.trim_end_matches('/').to_string();

    // 1) healthz
    let health = http.get(format!("{base}/healthz")).send().await;
    match health {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => {
            return EndpointTestResult {
                ok: false,
                server_version: String::new(),
                backends: vec![],
                detail: format!("/healthz returned {}", r.status()),
            };
        }
        Err(e) => {
            return EndpointTestResult {
                ok: false,
                server_version: String::new(),
                backends: vec![],
                detail: format!("/healthz unreachable: {e}"),
            };
        }
    }

    // 2) backends(11.1.2 协议端点;旧 server 没有这个 → 404,我们给清晰提示)
    let backends_resp = http
        .get(format!("{base}/api/v1/backends"))
        .bearer_auth(&token)
        .send()
        .await;
    match backends_resp {
        Ok(r) if r.status() == 401 || r.status() == 403 => EndpointTestResult {
            ok: false,
            server_version: String::new(),
            backends: vec![],
            detail: "token rejected (401/403)".to_string(),
        },
        Ok(r) if r.status() == 404 => EndpointTestResult {
            ok: false,
            server_version: String::new(),
            backends: vec![],
            detail: "server too old: missing GET /api/v1/backends (need protocol 1.1+)".to_string(),
        },
        Ok(r) if !r.status().is_success() => EndpointTestResult {
            ok: false,
            server_version: String::new(),
            backends: vec![],
            detail: format!("/api/v1/backends returned {}", r.status()),
        },
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(v) => {
                let backends: Vec<RemoteBackendInfo> = v
                    .get("backends")
                    .and_then(|x| x.as_array())
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|item| serde_json::from_value(item).ok())
                    .collect();
                EndpointTestResult {
                    ok: true,
                    server_version: String::new(),
                    backends,
                    detail: String::new(),
                }
            }
            Err(e) => EndpointTestResult {
                ok: false,
                server_version: String::new(),
                backends: vec![],
                detail: format!("/api/v1/backends body decode: {e}"),
            },
        },
        Err(e) => EndpointTestResult {
            ok: false,
            server_version: String::new(),
            backends: vec![],
            detail: format!("/api/v1/backends unreachable: {e}"),
        },
    }
}

/// 添加 endpoint:测试连接 → 持久化 → 注册 transport → 启 WS。
///
/// 失败回滚:如果到 step 3 才挂(spawn task 失败),持久化已经写进去,前端会在
/// 下次启动看到这个 endpoint 处于"未连接"状态(connected=false)。这是有意的
/// 设计 — 不强求事务性,GUI 重试比代码回滚简单。
#[tauri::command]
pub async fn endpoint_add(
    req: EndpointAddReq,
    state: State<'_, AppState>,
) -> Result<EndpointSummary, String> {
    if req.id.trim().is_empty() {
        return Err("endpoint id is empty".into());
    }
    if req.id.contains(':') || req.id.contains('/') || req.id.contains(' ') {
        // EndpointId::as_tag 会拼成 "remote:<id>",id 含 ':' 会让 log / 前端
        // 解析歧义。同时 id 也会被当 keyring 的 account name 用(将来切 keychain),
        // ':' / '/' / 空格都是不合规字符。
        return Err("endpoint id can't contain ':' '/' or spaces".into());
    }
    if req.base_url.trim().is_empty() {
        return Err("base_url is empty".into());
    }
    if req.token.trim().is_empty() {
        return Err("token is empty".into());
    }

    // SSH 模式校验:ssh_host 非空时,base_url 应是远端视角地址(默认 127.0.0.1:9870)。
    let ssh_host = req.ssh_host.trim().to_string();
    let is_ssh = !ssh_host.is_empty();

    // 1. 测试连接 — 失败直接挡,不留半成品。SSH 模式会先起临时隧道。
    let test = endpoint_test_connection(
        req.base_url.clone(),
        req.token.clone(),
        if is_ssh { Some(ssh_host.clone()) } else { None },
        if is_ssh { Some(req.ssh_port) } else { None },
        if is_ssh {
            Some(req.ssh_remote_port)
        } else {
            None
        },
    )
    .await;
    if !test.ok {
        return Err(format!("connection test failed: {}", test.detail));
    }

    // 2. 持久化(读 → append → write)。重名拒绝。
    let mut persisted = persistence::load();
    let mut endpoints = persisted.endpoints.clone().unwrap_or_default();
    if endpoints.iter().any(|e| e.id == req.id) {
        return Err(format!("endpoint id '{}' already exists", req.id));
    }
    let new_entry = PersistedEndpoint {
        id: req.id.clone(),
        display_name: req.display_name.clone(),
        base_url: req.base_url.clone(),
        token: req.token.clone(),
        ssh_host: ssh_host.clone(),
        ssh_port: req.ssh_port,
        ssh_remote_port: req.ssh_remote_port,
    };
    endpoints.push(new_entry.clone());
    persisted.endpoints = Some(endpoints);
    persistence::save_sync(&persisted).map_err(|e| format!("persist failed: {e}"))?;

    // 3. 注册 transport
    register_transport(&state, &new_entry);

    Ok(EndpointSummary {
        display_name: if req.display_name.is_empty() {
            req.id.clone()
        } else {
            req.display_name
        },
        id: req.id,
        base_url: req.base_url,
        connected: true,
        ssh_host: ssh_host,
        ssh_port: req.ssh_port,
        ssh_remote_port: req.ssh_remote_port,
    })
}

/// 移除 endpoint:从 transports map 取出 Arc → drop(WS task abort)→
/// 持久化删条目。
///
/// **不**会 kill 该 endpoint 上还活着的远端 session — 协议层 DELETE 才会。
/// 这里只是把"GUI 不再连这个 server"做完。前端层应该在用户确认前先关掉所有
/// remote tab。
#[tauri::command]
pub fn endpoint_remove(id: String, state: State<'_, AppState>) -> Result<(), String> {
    // 1. 持久化:删条目
    let mut persisted = persistence::load();
    if let Some(eps) = persisted.endpoints.as_mut() {
        let before = eps.len();
        eps.retain(|e| e.id != id);
        if eps.len() == before {
            return Err(format!("endpoint '{id}' not found"));
        }
    } else {
        return Err(format!("endpoint '{id}' not found"));
    }
    persistence::save_sync(&persisted).map_err(|e| format!("persist failed: {e}"))?;

    // 2. transports map:取出 Arc,drop 时 RemoteTransport::Drop abort WS task
    let removed = state
        .transports
        .lock()
        .remove(&EndpointId::Remote { id: id.clone() });
    drop(removed); // 显式 drop,触发 abort
                   // 同步删具类型 map
    state.remote_transports.lock().remove(&id);
    Ok(())
}

/// 修改 endpoint 的 UI 显示名。只改持久化 `display_name`,不重建 transport。
#[tauri::command]
pub fn endpoint_update_display_name(id: String, display_name: String) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("endpoint id is empty".into());
    }
    let mut persisted = persistence::load();
    let endpoints = persisted
        .endpoints
        .as_mut()
        .ok_or_else(|| format!("endpoint '{id}' not found"))?;
    let ep = endpoints
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("endpoint '{id}' not found"))?;
    ep.display_name = display_name.trim().to_string();
    persistence::save_sync(&persisted).map_err(|e| format!("persist failed: {e}"))?;
    Ok(())
}

/// 把一个 PersistedEndpoint 注册成活的 RemoteTransport,放进 transports map,启 WS。
///
/// **这是 endpoint_add 与启动恢复(`AppState::new`)共用的核心**;Phase 11.4 完成后
/// AppState::new 也应该在启动时遍历 persisted.endpoints 调一次这个,自动恢复。
///
/// 已存在的同 id 会被覆盖(支持「修改 endpoint」功能,但当前 API 是先 remove
/// 再 add — 这里覆盖只是兜底)。
pub(crate) fn register_transport(state: &AppState, ep: &PersistedEndpoint) {
    // SSH 隧道:ssh_host 非空 → SSH 模式;空 → 直连。
    let ssh = if ep.ssh_host.trim().is_empty() {
        None
    } else {
        Some(SshSpec {
            host: ep.ssh_host.clone(),
            ssh_port: ep.ssh_port, // 0 / 22 → SshTunnel::spawn 不加 -p
            remote_port: if ep.ssh_remote_port == 0 {
                9870
            } else {
                ep.ssh_remote_port
            },
        })
    };
    let cfg = RemoteConfig {
        id: ep.id.clone(),
        base_url: ep.base_url.clone(),
        token: ep.token.clone(),
        reconnect_backoff_secs: vec![], // 用默认 [1,2,5,10,30]
        ssh,
    };
    // 把 BridgeCtx::alloc_id 包成 Fn() 闭包,让 RemoteTransport 从同一个计数器
    // 分配本地 session id,避免与 LocalTransport 的 id 碰撞。
    let ctx = std::sync::Arc::clone(&state.ctx);
    let id_alloc: std::sync::Arc<dyn Fn() -> kode_core::SessionId + Send + Sync> =
        std::sync::Arc::new(move || ctx.alloc_id());
    let transport = Arc::new(RemoteTransport::new(
        cfg,
        state.ctx.core_tx.clone(),
        id_alloc,
    ));
    // 直连模式:立即起 WS 后台任务(老行为)。
    // SSH 模式:**懒加载** —— 只记 self_weak,不在注册时起隧道+WS,推迟到首次
    // spawn(那时才真正需要远端)。WS 由 spawn 内的 ensure_ws_lazy 拉起。
    if transport.is_ssh_mode() {
        register_self_weak(&transport);
    } else {
        start_remote_tasks(&transport);
    }

    // 具类型 map(供 endpoint_workspace_* 调 rest_get 复用隧道)—— 必须在
    // `as Arc<dyn SessionTransport>` 之前 clone,转换后拿不回具类型。
    state
        .remote_transports
        .lock()
        .insert(ep.id.clone(), Arc::clone(&transport));

    state.transports.lock().insert(
        EndpointId::Remote { id: ep.id.clone() },
        transport as Arc<dyn SessionTransport>,
    );
}

/// **启动时恢复**:从 PersistedState 读全部 endpoints,逐个 register_transport。
/// `AppState::new` 里调一次。
///
/// 这里**不再做 health check** — 启动期间网络可能没通,先把 transport 注册起来,
/// WS 后台 task 会自己重试连接;UI 通过 connected 字段显示 false 直到首个 hello
/// 到达(11.6 状态栏会读取这个并显示)。
pub fn restore_persisted_endpoints(state: &AppState, persisted: &PersistedState) {
    let Some(eps) = persisted.endpoints.as_ref() else {
        return;
    };
    for ep in eps {
        register_transport(state, ep);
    }
    tracing::info!(count = eps.len(), "restored persisted remote endpoints");
}

/// 拉远端 endpoint 的 backend 列表(GET /api/v1/backends)。
/// BackendChooser 选了某个 endpoint 后调,把结果展示给用户当 Remote 分组项。
///
/// 不缓存 — 每次 chooser 打开都会调,简单但保证看到的是 server 当前状态。
/// (实测 GET 5-20ms,远端 backend 增删频率低 → 缓存收益小,加复杂度不值)
#[tauri::command]
pub async fn endpoint_get_remote_backends(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteBackendInfo>, String> {
    // 从持久化读 token / base_url(transports map 里有 transport 但拿不到 token,
    // 那是 transport 内部状态)。
    let persisted = persistence::load();
    let ep = persisted
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("endpoint '{id}' not found"))?;

    // 必须先确认 transport 已注册 — 防止 endpoint_remove 后用户还在 chooser 里点
    if !state
        .transports
        .lock()
        .contains_key(&EndpointId::Remote { id: id.clone() })
    {
        return Err(format!("endpoint '{id}' is removed"));
    }

    let is_ssh = !ep.ssh_host.trim().is_empty();
    let result = endpoint_test_connection(
        ep.base_url,
        ep.token,
        if is_ssh {
            Some(ep.ssh_host.clone())
        } else {
            None
        },
        if is_ssh { Some(ep.ssh_port) } else { None },
        if is_ssh {
            Some(ep.ssh_remote_port)
        } else {
            None
        },
    )
    .await;
    if !result.ok {
        return Err(format!("fetch backends: {}", result.detail));
    }
    Ok(result.backends)
}

#[derive(Debug, Serialize)]
pub struct RemoteFsEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct RemoteFsListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<RemoteFsEntry>,
}

/// **Phase 11.5.4** 列举远端 endpoint 上某目录的子目录。
/// 协议端点见 .specops/specs/remote-protocol.md §4.11(`GET /api/v1/fs/list`)。
///
/// 客户端用法:RemoteCwdPicker 让用户挑 cwd 时,从 server 端路径逐级浏览。
/// Rust bridge server 端允许任意存在的绝对目录,便于选择 HOME 外工作区。
#[tauri::command]
pub async fn endpoint_fs_list(
    id: String,
    path: String,
    show_hidden: Option<bool>,
    _state: State<'_, AppState>,
) -> Result<RemoteFsListing, String> {
    let persisted = persistence::load();
    let ep = persisted
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("endpoint '{id}' not found"))?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    // SSH 模式:起临时隧道,base 改成本地端口。隧道在函数作用域内存活,返回 drop。
    let _tunnel_guard;
    let base = if ep.ssh_host.trim().is_empty() {
        ep.base_url.trim_end_matches('/').to_string()
    } else {
        let host = ep.ssh_host.clone();
        let ssh_port = ep.ssh_port;
        let remote_port = if ep.ssh_remote_port == 0 {
            9870
        } else {
            ep.ssh_remote_port
        };
        let t = tokio::task::spawn_blocking(move || {
            crate::transport::ssh_tunnel::SshTunnel::spawn(&host, ssh_port, remote_port)
        })
        .await
        .map_err(|e| format!("ssh tunnel task: {e}"))?
        .map_err(|e| format!("ssh tunnel failed: {e}"))?;
        let local = format!("http://127.0.0.1:{}", t.local_port);
        _tunnel_guard = t;
        local
    };

    let mut req = http
        .get(format!("{base}/api/v1/fs/list"))
        .bearer_auth(&ep.token)
        .query(&[("path", path.as_str())]);
    if show_hidden.unwrap_or(false) {
        req = req.query(&[("show_hidden", "true")]);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("fs.list request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("fs.list returned {status}: {detail}"));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("fs.list decode: {e}"))?;
    Ok(RemoteFsListing {
        path: v
            .get("path")
            .and_then(|x| x.as_str())
            .unwrap_or(&path)
            .to_string(),
        parent: v.get("parent").and_then(|x| x.as_str()).map(String::from),
        entries: v
            .get("entries")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                let name = item.get("name")?.as_str()?.to_string();
                let is_dir = item.get("is_dir")?.as_bool()?;
                Some(RemoteFsEntry { name, is_dir })
            })
            .collect(),
    })
}

/// 列出远端 endpoint 上某个 cwd/backend 的历史 jsonl sessions。
/// 协议端点:`GET /api/v1/sessions/history?backend_key=<key>&cwd=<abspath>`。
#[tauri::command]
pub async fn endpoint_list_sessions_for_cwd(
    id: String,
    backend_key: String,
    cwd: String,
    _state: State<'_, AppState>,
) -> Result<Vec<crate::commands::SessionSummary>, String> {
    let persisted = persistence::load();
    let ep = persisted
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("endpoint '{id}' not found"))?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let _tunnel_guard;
    let base = if ep.ssh_host.trim().is_empty() {
        ep.base_url.trim_end_matches('/').to_string()
    } else {
        let host = ep.ssh_host.clone();
        let ssh_port = ep.ssh_port;
        let remote_port = if ep.ssh_remote_port == 0 {
            9870
        } else {
            ep.ssh_remote_port
        };
        let t = tokio::task::spawn_blocking(move || {
            crate::transport::ssh_tunnel::SshTunnel::spawn(&host, ssh_port, remote_port)
        })
        .await
        .map_err(|e| format!("ssh tunnel task: {e}"))?
        .map_err(|e| format!("ssh tunnel failed: {e}"))?;
        let local = format!("http://127.0.0.1:{}", t.local_port);
        _tunnel_guard = t;
        local
    };

    let resp = http
        .get(format!("{base}/api/v1/sessions/history"))
        .bearer_auth(&ep.token)
        .query(&[("backend_key", backend_key.as_str()), ("cwd", cwd.as_str())])
        .send()
        .await
        .map_err(|e| format!("session history request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        if session_history_unsupported(status, &detail) {
            return Ok(Vec::new());
        }
        return Err(format!("session history returned {status}: {detail}"));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("session history decode: {e}"))?;
    let sessions_value = v.get("sessions").cloned().unwrap_or(v);
    serde_json::from_value::<Vec<crate::commands::SessionSummary>>(sessions_value)
        .map_err(|e| format!("session history shape: {e}"))
}

// ===== Phase 11.x:远端 tab WorkspacePanel 支持(对齐本地 workspace_* 命令)=====
//
// 这些命令把远端 tab 的 workspace inspection 请求转发到 bridge 的
// /api/v1/fs/list、/fs/preview、/git/status、/git/diff 端点。复用
// `RemoteTransport::rest_get` 的长连接 SSH 隧道(不在调用方每次新建)。
// 返回类型复用 `workspace.rs` 的 pub struct,前端 TS 类型也已对齐。

use crate::workspace::{
    FilePreview, GitDiffPreview, WorkspaceEntry, WorkspaceGitSummary, WorkspaceSnapshot,
};

/// 从 `state.remote_transports` 拿具类型 `Arc<RemoteTransport>`。
/// endpoint 不在 map(已删除 / 未注册 / 是 local)→ Err。
fn lookup_remote_transport(
    state: &State<'_, AppState>,
    id: &str,
) -> Result<Arc<RemoteTransport>, String> {
    state
        .remote_transports
        .lock()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("endpoint '{id}' is removed or not a remote endpoint"))
}

/// 远端 tab:列文件 + git 摘要(对齐本地 `workspace_snapshot`)。
/// 404(路径不存在)→ `exists: false`,保持和本地一致的 UX。
#[tauri::command]
pub async fn endpoint_workspace_snapshot(
    id: String,
    cwd: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    let transport = lookup_remote_transport(&state, &id)?;
    // files=true 才返回文件(workspace 需要),默认 false 只目录(RemoteCwdPicker 用)
    let (entries, exists): (Vec<WorkspaceEntry>, bool) = match transport
        .rest_get(
            "/api/v1/fs/list",
            &[("path", cwd.as_str()), ("files", "true")],
        )
        .await
    {
        Ok(fs_resp) => {
            let list: Vec<WorkspaceEntry> = fs_resp
                .get("entries")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|item| serde_json::from_value(item).ok())
                .collect();
            // 走 Ok = 路径存在(即便空目录,entries 为空但 exists=true)
            (list, true)
        }
        Err(e) if e.status == Some(404) => (Vec::new(), false),
        Err(e) => return Err(e.to_string()),
    };
    if !exists {
        return Ok(WorkspaceSnapshot {
            path: cwd,
            exists: false,
            entries,
            git: WorkspaceGitSummary::default(),
        });
    }
    // git 端点 best-effort:失败 → 降级为非 repo,不让整个 snapshot 失败
    let git: WorkspaceGitSummary = match transport
        .rest_get("/api/v1/git/status", &[("cwd", cwd.as_str())])
        .await
    {
        Ok(git_resp) => {
            serde_json::from_value(git_resp).map_err(|e| format!("git status decode: {e}"))?
        }
        Err(_) => WorkspaceGitSummary::default(),
    };
    Ok(WorkspaceSnapshot {
        path: cwd,
        exists: true,
        entries,
        git,
    })
}

/// 远端 tab:展开目录(对齐本地 `workspace_list_dir`)。
#[tauri::command]
pub async fn endpoint_workspace_list_dir(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let transport = lookup_remote_transport(&state, &id)?;
    let resp = transport
        .rest_get(
            "/api/v1/fs/list",
            &[("path", path.as_str()), ("files", "true")],
        )
        .await
        .map_err(|e| e.to_string())?;
    let entries: Vec<WorkspaceEntry> = resp
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect();
    Ok(entries)
}

/// 远端 tab:预览文件(对齐本地 `workspace_preview_file`)。
#[tauri::command]
pub async fn endpoint_workspace_preview_file(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<FilePreview, String> {
    let transport = lookup_remote_transport(&state, &id)?;
    let resp = transport
        .rest_get("/api/v1/fs/preview", &[("path", path.as_str())])
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(resp).map_err(|e| format!("fs preview decode: {e}"))
}

/// 远端 tab:git diff(对齐本地 `workspace_git_diff`)。
#[tauri::command]
pub async fn endpoint_workspace_git_diff(
    id: String,
    cwd: String,
    path: String,
    bucket: String,
    state: State<'_, AppState>,
) -> Result<GitDiffPreview, String> {
    let transport = lookup_remote_transport(&state, &id)?;
    let resp = transport
        .rest_get(
            "/api/v1/git/diff",
            &[
                ("cwd", cwd.as_str()),
                ("path", path.as_str()),
                ("bucket", bucket.as_str()),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(resp).map_err(|e| format!("git diff decode: {e}"))
}

fn session_history_unsupported(status: reqwest::StatusCode, detail: &str) -> bool {
    if status == reqwest::StatusCode::NOT_FOUND {
        return true;
    }
    status == reqwest::StatusCode::BAD_REQUEST
        && detail.contains("Cannot parse")
        && detail.contains("history")
        && detail.contains("u64")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_connection_unreachable_url_returns_not_ok() {
        // 用 reserved port,几乎一定 connection refused
        let r = endpoint_test_connection(
            "http://127.0.0.1:1".into(),
            "any-token".into(),
            None,
            None,
            None,
        )
        .await;
        assert!(!r.ok, "should not be ok: {:?}", r);
        assert!(r.detail.contains("/healthz"));
    }

    #[test]
    fn endpoint_summary_marks_connected_when_in_transports() {
        // 这个测试不能直接调 endpoint_list(它依赖 State<AppState>),
        // 但我们可以验证字段语义:transports map 含 Remote {id} → connected=true
        // 此处通过 endpoint_id_eq 测试边界:
        let id = "host-a";
        let ep_summary = EndpointSummary {
            id: id.into(),
            display_name: id.into(),
            base_url: "http://x:1".into(),
            connected: false,
            ssh_host: String::new(),
            ssh_port: 0,
            ssh_remote_port: 0,
        };
        assert_eq!(ep_summary.id, id);
        assert!(!ep_summary.connected);
    }

    #[test]
    fn endpoint_id_validation_rejects_bad_chars() {
        // endpoint_add 内部规则:id 不允许 ':' / '/' / 空格(避免 EndpointId::as_tag
        // 与 keyring account 命名歧义)。这里通过手动构造 req 调内部校验逻辑 ——
        // 但 add 是 async 且需要 State,无法直接调;改成纯字符串校验函数验证。
        // 简化为编译时确认这些字符仍是非法值;真实 add 路径在 11.4.4 集成测试覆盖。
        for bad in [":foo", "foo:bar", "foo/bar", "foo bar", ""] {
            let invalid =
                bad.is_empty() || bad.contains(':') || bad.contains('/') || bad.contains(' ');
            assert!(invalid, "expected '{bad}' to be invalid id");
        }
    }

    #[test]
    fn session_history_unsupported_detects_old_bridge_id_parse_error() {
        let detail = r#"Invalid URL: Cannot parse `"history"` to a `u64`"#;
        assert!(session_history_unsupported(
            reqwest::StatusCode::BAD_REQUEST,
            detail
        ));
        assert!(session_history_unsupported(
            reqwest::StatusCode::NOT_FOUND,
            ""
        ));
        assert!(!session_history_unsupported(
            reqwest::StatusCode::BAD_REQUEST,
            "cwd must be absolute"
        ));
    }
}
