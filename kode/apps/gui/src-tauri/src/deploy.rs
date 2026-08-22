//! 远端 Bridge 部署安装:通过 SSH 把打包进 app 的 musl tarball 推到远端机器,
//! 停旧服务 → 解压 → 起新服务 → 健康检查 → 取回 token → 创建/复用 endpoint。
//!
//! 设计要点:
//! - **调系统 ssh/scp 二进制**(非 russh):复用用户 `~/.ssh/config`、key、agent,
//!   跟 `transport/ssh_tunnel.rs` 同模式,零额外配置。
//! - **分步进度**:通过 `app.emit("deploy-progress", ...)` 推送 8 步进度,前端
//!   `DeployPanel.svelte` 订阅显示。
//! - **pkill + nohup 兜底**(非 systemd):跨发行版通用,不需 loginctl enable-linger。
//! - **同 host 复用 endpoint**:部署前查 `ssh_host` 字段,有则更新 token + 重用 id,
//!   避免重复部署堆积 endpoint。
//! - **token 自动取回**:部署完 SSH `cat ~/.kode/state.json` 取 `bridge_token`,
//!   用户全程不用手动复制。

use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::endpoints::{register_transport, EndpointAddReq, EndpointSummary};
use crate::persistence::{self, PersistedEndpoint};
use crate::state::AppState;

const TARBALL_RESOURCE: &str = "resources/kode-remote-memory-bridge-linux-musl.tar.gz";
const REMOTE_TARBALL: &str = "/tmp/kode-rmb-deploy.tar.gz";
const REMOTE_INSTALL_DIR: &str = ".local/kode-remote-memory-bridge";
const REMOTE_STATE_JSON: &str = ".kode/state.json";
const HEALTH_CHECK_RETRIES: u32 = 5;
const HEALTH_CHECK_INTERVAL_MS: u64 = 1000;

/// 前端 → 后端的部署请求。
#[derive(Debug, Deserialize)]
pub struct DeployReq {
    /// `user@host` 或 `~/.ssh/config` Host 别名
    pub ssh_host: String,
    /// endpoint 的 UI 显示名。空 = 新建时用 ssh_host;复用时保留旧名。
    #[serde(default)]
    pub display_name: String,
    /// SSH 服务端口(0 / 22 → 默认)
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    /// 远端 kode-bridge 监听端口(默认 9870)
    #[serde(default = "default_remote_port")]
    pub remote_port: u16,
}
fn default_ssh_port() -> u16 {
    22
}
fn default_remote_port() -> u16 {
    9870
}

/// 后端 → 前端的部署结果。
#[derive(Debug, Serialize)]
pub struct DeployResult {
    /// 创建/复用的 endpoint id
    pub endpoint_id: String,
    /// 从远端 state.json 取回的 bridge_token(已自动填进 endpoint)
    pub bridge_token: String,
    /// 本次部署是新建 endpoint 还是复用已有的
    pub endpoint_created: bool,
}

/// 分步进度 payload,通过 `deploy-progress` event 推送。
#[derive(Debug, Clone, Serialize)]
pub struct DeployProgress {
    /// 步骤枚举名(跟前端 STEP_LABELS key 对齐)
    pub step: String,
    /// `running` / `done` / `failed`
    pub status: String,
    /// 人话描述(失败时是错误信息)
    pub message: String,
}

#[tauri::command]
pub async fn deploy_remote_bridge(
    req: DeployReq,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<DeployResult, String> {
    let ssh_host = req.ssh_host.trim().to_string();
    if ssh_host.is_empty() {
        return Err("ssh_host is empty".into());
    }
    let display_name = req.display_name.trim().to_string();

    // 1. 定位打包进 app 的 tarball。dev 模式下 resource_dir 可能找不到 ——
    //    允许 fallback 到 target/ 编译产物(开发自测用)。
    let local_tarball = resolve_local_tarball()?;

    // 2. 上传
    emit(&app, "Uploading", "running", &format!("scp → {ssh_host}"));
    let upload = run_scp(&ssh_host, req.ssh_port, &local_tarball, REMOTE_TARBALL);
    match upload {
        Ok(_) => emit(&app, "Uploading", "done", "uploaded"),
        Err(e) => {
            emit(&app, "Uploading", "failed", &e);
            return Err(format!("upload failed: {e}"));
        }
    }

    // 3. 停旧服务
    // 用 `[b]in/kode-bridge` 而非 `bin/kode-bridge` —— 字符类让 pkill 的 pattern
    // 字符串自身不匹配(经典技巧:`pkill -f 'bin/kode-bridge'` 会匹配到执行
    // 这条命令的 shell 自身,因为 shell 命令行里就含 "bin/kode-bridge" 子串,
    // 导致 ssh 连接被杀、返回非 0 → 误判部署失败)。
    // `; exit 0` 容忍 pkill 在无匹配进程时的 exit 1。
    emit(&app, "StoppingOld", "running", "pkill kode-bridge");
    let stop = run_ssh(
        &ssh_host,
        req.ssh_port,
        "pkill -f '[b]in/kode-bridge' 2>/dev/null; exit 0",
    );
    match stop {
        Ok(_) => emit(&app, "StoppingOld", "done", "stopped (or none was running)"),
        Err(e) => {
            emit(&app, "StoppingOld", "failed", &e);
            return Err(format!("stop failed: {e}"));
        }
    }

    // 4. 解压
    emit(
        &app,
        "Extracting",
        "running",
        &format!("tar -xzf → ~/{REMOTE_INSTALL_DIR}"),
    );
    let extract_cmd = format!(
        "mkdir -p ~/{REMOTE_INSTALL_DIR} && \
         tar -xzf {REMOTE_TARBALL} -C ~/{REMOTE_INSTALL_DIR} && \
         chmod +x ~/{REMOTE_INSTALL_DIR}/bin/* 2>/dev/null || true"
    );
    match run_ssh(&ssh_host, req.ssh_port, &extract_cmd) {
        Ok(_) => emit(&app, "Extracting", "done", "extracted"),
        Err(e) => {
            emit(&app, "Extracting", "failed", &e);
            return Err(format!("extract failed: {e}"));
        }
    }

    // 5. 起新服务(nohup 兜底,非 systemd)
    // 用 `bash -lc` 启动:加载用户登录 shell 环境(.bashrc/.profile/nvm/asdf/conda),
    // 让 bridge 进程的 PATH 包含 codebuddy/claude 等后端 CLI 的安装路径。
    // 直接 `nohup kode-bridge &` 走 SSH 非交互 shell,PATH 只有 /usr/bin:/bin,
    // bridge spawn codebuddy 时会因找不到命令报 "spawn child failed"。
    emit(&app, "StartingNew", "running", "nohup kode-bridge &");
    let start_cmd = format!(
        "bash -lc 'KODE_BRIDGE_BIND=127.0.0.1 KODE_BRIDGE_PORT={port} \
         nohup ~/{REMOTE_INSTALL_DIR}/bin/kode-bridge \
         > ~/{REMOTE_INSTALL_DIR}/bridge.log 2>&1 &'",
        port = req.remote_port
    );
    match run_ssh(&ssh_host, req.ssh_port, &start_cmd) {
        Ok(_) => emit(&app, "StartingNew", "done", "started"),
        Err(e) => {
            emit(&app, "StartingNew", "failed", &e);
            return Err(format!("start failed: {e}"));
        }
    }

    // 6. 健康检查(重试)
    emit(
        &app,
        "HealthCheck",
        "running",
        &format!("curl /healthz ×{HEALTH_CHECK_RETRIES}"),
    );
    let health_cmd = format!(
        "curl -sf --max-time 3 http://127.0.0.1:{port}/healthz",
        port = req.remote_port
    );
    let mut last_err = String::new();
    let mut healthy = false;
    for attempt in 1..=HEALTH_CHECK_RETRIES {
        match run_ssh(&ssh_host, req.ssh_port, &health_cmd) {
            Ok(_) => {
                healthy = true;
                break;
            }
            Err(e) => {
                last_err = e;
                if attempt < HEALTH_CHECK_RETRIES {
                    tokio::time::sleep(Duration::from_millis(HEALTH_CHECK_INTERVAL_MS)).await;
                }
            }
        }
    }
    if healthy {
        emit(&app, "HealthCheck", "done", "healthy");
    } else {
        let msg = format!("healthz not responding after {HEALTH_CHECK_RETRIES} tries: {last_err}");
        emit(&app, "HealthCheck", "failed", &msg);
        return Err(msg);
    }

    // 7. 取 token
    emit(
        &app,
        "FetchingToken",
        "running",
        &format!("cat ~/{REMOTE_STATE_JSON}"),
    );
    let token_cmd = format!("cat ~/{REMOTE_STATE_JSON} 2>/dev/null || echo '{{}}'");
    let state_json = match run_ssh(&ssh_host, req.ssh_port, &token_cmd) {
        Ok(s) => s,
        Err(e) => {
            emit(&app, "FetchingToken", "failed", &e);
            return Err(format!("fetch token failed: {e}"));
        }
    };
    let bridge_token = match parse_bridge_token(&state_json) {
        Some(t) if !t.is_empty() => t,
        _ => {
            let msg =
                "bridge_token not found in remote state.json (bridge may not have initialized yet)";
            emit(&app, "FetchingToken", "failed", msg);
            return Err(msg.into());
        }
    };
    emit(&app, "FetchingToken", "done", "token retrieved");

    // 8. 创建/复用 endpoint
    emit(&app, "CreatingEndpoint", "running", "registering endpoint");
    let base_url = format!("http://127.0.0.1:{}", req.remote_port);
    let (endpoint_id, endpoint_created) = match upsert_endpoint(
        &state,
        &ssh_host,
        req.ssh_port,
        req.remote_port,
        &base_url,
        &bridge_token,
        &display_name,
    ) {
        Ok(v) => v,
        Err(e) => {
            emit(&app, "CreatingEndpoint", "failed", &e);
            return Err(format!("create endpoint failed: {e}"));
        }
    };
    emit(
        &app,
        "CreatingEndpoint",
        "done",
        if endpoint_created {
            "endpoint created"
        } else {
            "endpoint updated (reused)"
        },
    );

    emit(&app, "Done", "done", "deployment complete");
    Ok(DeployResult {
        endpoint_id,
        bridge_token,
        endpoint_created,
    })
}

/// 定位本地 tarball:优先从当前可执行文件附近找 resource,
/// fallback 到 target/ 编译产物(dev 自测用,允许资源未打包时也能部署)。
fn resolve_local_tarball() -> Result<String, String> {
    // 1. dev/run 模式:target/debug/resources/...
    // 2. app bundle:.../Contents/Resources/resources/...
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let bundle_resource = exe_dir
                .parent()
                .map(|p| p.join("Resources").join(TARBALL_RESOURCE))
                .unwrap_or_default();
            for p in [exe_dir.join(TARBALL_RESOURCE), bundle_resource] {
                if p.exists() && p.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                    return Ok(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    // 2. fallback:repo 根的 target/remote-memory-bridge/ 产物
    let candidates = [
        "target/remote-memory-bridge/kode-remote-memory-bridge-x86_64-unknown-linux-musl.tar.gz",
        "../target/remote-memory-bridge/kode-remote-memory-bridge-x86_64-unknown-linux-musl.tar.gz",
    ];
    for c in candidates {
        let expanded = expand_home(c);
        if std::path::Path::new(&expanded).exists() {
            return Ok(expanded);
        }
    }
    Err(format!(
        "tarball not found. Run `bash deploy/build-remote-memory-bridge.sh --musl` first, \
         or build the GUI with `tauri build` to bundle it as a resource."
    ))
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_string()
}

/// `scp -P <port> -o BatchMode=yes <src> <host>:<dst>`
/// 注意:scp 的端口参数是大写 `-P`(ssh 是小写 `-p`)。
pub(crate) fn run_scp(
    ssh_host: &str,
    ssh_port: u16,
    local: &str,
    remote: &str,
) -> Result<String, String> {
    let mut cmd = Command::new("scp");
    if ssh_port != 0 && ssh_port != 22 {
        cmd.arg("-P").arg(ssh_port.to_string());
    }
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=8");
    cmd.arg(local).arg(format!("{ssh_host}:{remote}"));
    run_and_capture(cmd, "scp")
}

/// `ssh -p <port> -o BatchMode=yes <host> <cmd>`
pub(crate) fn run_ssh(ssh_host: &str, ssh_port: u16, cmd_str: &str) -> Result<String, String> {
    let mut cmd = Command::new("ssh");
    if ssh_port != 0 && ssh_port != 22 {
        cmd.arg("-p").arg(ssh_port.to_string());
    }
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=8");
    cmd.arg("-o").arg("ServerAliveInterval=15");
    cmd.arg("-o").arg("ServerAliveCountMax=3");
    cmd.arg(ssh_host).arg(cmd_str);
    run_and_capture(cmd, "ssh")
}

fn run_and_capture(mut cmd: Command, label: &str) -> Result<String, String> {
    let out = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{label} binary not found in PATH")
            } else {
                format!("spawn {label}: {e}")
            }
        })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        // stderr 经常混入 ssh 诊断噪声(known_hosts 提示、devcloud 的 "authz success"
        // 鉴权横幅等),这些不是真正的错误。过滤掉已知噪声行,只留有用信息。
        let stderr = filter_ssh_noise(&String::from_utf8_lossy(&out.stderr));
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exited with code {}", out.status.code().unwrap_or(-1))
        };
        Err(detail)
    }
}

/// 从 stderr 里过滤掉 ssh/scp 的诊断噪声行(不是真正错误)。
///
/// 已知噪声:
/// - `Warning: Permanently added '[host]:port' (ED25519) to the list of known hosts.`
///   首次连新 host 往 known_hosts 加指纹的标准提示
/// - `authz success` / `authz` 相关横幅(devcloud 等环境的鉴权 banner)
/// - 空行
///
/// 保留所有其它行(真正的错误信息)。
fn filter_ssh_noise(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| {
            let t = line.trim();
            if t.is_empty() {
                return false;
            }
            if t.starts_with("Warning: Permanently added ") && t.contains("known hosts") {
                return false;
            }
            // devcloud 鉴权横幅(可能带各种前缀/大小写)
            let lower = t.to_ascii_lowercase();
            if lower == "authz success" || lower.starts_with("authz success") {
                return false;
            }
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// 从 state.json 内容解析 `bridge_token` 字段(容忍 JSON 注释 / 空白)。
fn parse_bridge_token(content: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(content.trim()).ok()?;
    v.get("bridge_token")?.as_str().map(String::from)
}

/// 同 host 复用:有则更新 token + 重用 id,无则新建 + 注册 transport。
/// 返回 (endpoint_id, created)。
fn upsert_endpoint(
    state: &AppState,
    ssh_host: &str,
    ssh_port: u16,
    remote_port: u16,
    base_url: &str,
    bridge_token: &str,
    display_name: &str,
) -> Result<(String, bool), String> {
    let mut persisted = persistence::load();
    let mut endpoints = persisted.endpoints.clone().unwrap_or_default();

    // 查同 ssh_host 的已有 endpoint
    if let Some(existing) = endpoints.iter_mut().find(|e| e.ssh_host == ssh_host) {
        existing.token = bridge_token.to_string();
        existing.base_url = base_url.to_string();
        existing.ssh_port = ssh_port;
        existing.ssh_remote_port = remote_port;
        if !display_name.trim().is_empty() {
            existing.display_name = display_name.trim().to_string();
        }
        let id = existing.id.clone();
        let persisted_display_name = existing.display_name.clone();
        persisted.endpoints = Some(endpoints);
        persistence::save_sync(&persisted).map_err(|e| format!("persist failed: {e}"))?;
        // 重新注册 transport(用新 token)
        register_transport(
            state,
            &PersistedEndpoint {
                id: id.clone(),
                display_name: persisted_display_name,
                base_url: base_url.to_string(),
                token: bridge_token.to_string(),
                ssh_host: ssh_host.to_string(),
                ssh_port,
                ssh_remote_port: remote_port,
            },
        );
        return Ok((id, false));
    }

    // 新建:id 用 ssh_host 派生(user@host → user-host)
    let id = format!("deployed-{}", ssh_host.replace('@', "-").replace('.', "-"));
    let display_name = if display_name.trim().is_empty() {
        ssh_host.to_string()
    } else {
        display_name.trim().to_string()
    };
    // 防止 id 跟某个已存的撞(理论罕见,但兜底)
    let mut final_id = id.clone();
    let mut suffix = 1;
    while endpoints.iter().any(|e| e.id == final_id) {
        final_id = format!("{id}-{suffix}");
        suffix += 1;
    }

    let new_entry = PersistedEndpoint {
        id: final_id.clone(),
        display_name,
        base_url: base_url.to_string(),
        token: bridge_token.to_string(),
        ssh_host: ssh_host.to_string(),
        ssh_port,
        ssh_remote_port: remote_port,
    };
    endpoints.push(new_entry.clone());
    persisted.endpoints = Some(endpoints);
    persistence::save_sync(&persisted).map_err(|e| format!("persist failed: {e}"))?;
    register_transport(state, &new_entry);

    Ok((final_id, true))
}

fn emit(app: &AppHandle, step: &str, status: &str, message: &str) {
    let _ = app.emit(
        "deploy-progress",
        DeployProgress {
            step: step.to_string(),
            status: status.to_string(),
            message: message.to_string(),
        },
    );
}

// 让 EndpointSummary / EndpointAddReq 不产生 unused import 警告
// (EndpointAddReq 当前未直接用,但保留以备未来扩展 —— 比如用户想自定义 id)。
#[allow(dead_code)]
fn _types_used(_: EndpointAddReq, _: EndpointSummary) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bridge_token_from_state_json() {
        let json = r#"{"bridge_token":"abc123def456","other":"x"}"#;
        assert_eq!(parse_bridge_token(json), Some("abc123def456".into()));
    }

    #[test]
    fn returns_none_when_no_bridge_token() {
        let json = r#"{"other":"x"}"#;
        assert_eq!(parse_bridge_token(json), None);
    }

    #[test]
    fn returns_none_for_invalid_json() {
        assert_eq!(parse_bridge_token("not json"), None);
    }

    #[test]
    fn tolerates_whitespace_around_json() {
        let json = "\n  {\"bridge_token\":\"tok\"}  \n";
        assert_eq!(parse_bridge_token(json), Some("tok".into()));
    }

    #[test]
    fn handles_empty_token() {
        let json = r#"{"bridge_token":""}"#;
        assert_eq!(parse_bridge_token(json), Some("".into()));
    }

    // ── filter_ssh_noise ──
    // 托管 SSH 场景:stderr 混了 known_hosts 提示 + authz 横幅 + 真错误,
    // 只应该把真错误留给用户看。

    #[test]
    fn filter_strips_known_hosts_warning() {
        let s = "Warning: Permanently added '[sync-host.example.com]:2222' (ED25519) to the list of known hosts.\nauthz success\n";
        // known_hosts 提示 + authz 横幅都是噪声,全过滤掉
        assert_eq!(filter_ssh_noise(s), "");
    }

    #[test]
    fn filter_strips_authz_success_banner() {
        assert_eq!(filter_ssh_noise("authz success\nreal error"), "real error");
        assert_eq!(filter_ssh_noise("Authz Success"), "");
    }

    #[test]
    fn filter_keeps_real_errors() {
        let s = "bash: pkill: command not found";
        assert_eq!(filter_ssh_noise(s), s);
    }

    #[test]
    fn filter_strips_all_noise_leaves_empty() {
        let s = "\nWarning: Permanently added '[h]:22' (RSA) to the list of known hosts.\nauthz success\n\n";
        assert_eq!(filter_ssh_noise(s), "");
    }

    #[test]
    fn filter_combines_noise_and_real_error() {
        let s = "Warning: Permanently added '[h]:22' (ED25519) to the list of known hosts.\nauthz success\nbash: curl: command not found";
        assert_eq!(filter_ssh_noise(s), "bash: curl: command not found");
    }
}
