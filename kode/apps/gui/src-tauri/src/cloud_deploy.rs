//! Self-service cloud sync deployment over SSH.
//!
//! The app ships a static Linux `kode-sync-server` archive and reuses the
//! existing system ssh/scp path, so aliases, keys, and ssh-agent continue to
//! work exactly like Remote Bridge deployment. Docker mode is self-contained:
//! on an empty host it creates the Compose/Caddy package and starts the public
//! HTTP(S) ingress; on a managed or legacy package it updates in place without
//! removing the persistent data volume.

use std::{path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    cloud_sync::{normalize_server_url, CloudBackendSummary, CloudSyncManager},
    deploy::{run_scp, run_ssh},
};

const TARBALL_RESOURCE: &str = "resources/kode-sync-server-linux-musl.tar.gz";
const REMOTE_TARBALL: &str = "/tmp/kode-sync-server-deploy.tar.gz";
const REMOTE_INSTALL_DIR: &str = ".local/kode-sync-server";
const DEFAULT_REMOTE_DOCKER_DIR: &str = "~/.local/kode-sync-docker";
const PUBLIC_HEALTH_PATH: &str = "/api/v1/healthz";
const LOCAL_HEALTH_RETRIES: u32 = 8;
const PUBLIC_HEALTH_RETRIES: u32 = 20;

#[derive(Debug, Deserialize)]
pub struct CloudDeployReq {
    pub name: String,
    pub ssh_host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default = "default_remote_port")]
    pub remote_port: u16,
    pub server_url: String,
    #[serde(default = "default_deployment_kind")]
    pub deployment_kind: String,
    #[serde(default)]
    pub remote_deploy_dir: Option<String>,
    #[serde(default)]
    pub update_existing: bool,
    #[serde(default)]
    pub reset_existing: bool,
}

fn default_deployment_kind() -> String {
    "docker".into()
}

fn default_ssh_port() -> u16 {
    22
}

fn default_remote_port() -> u16 {
    8787
}

#[derive(Debug, Serialize)]
pub struct CloudDeployResult {
    pub backend: CloudBackendSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct CloudDeployProgress {
    pub step: String,
    pub status: String,
    pub message: String,
}

#[tauri::command]
pub async fn deploy_cloud_sync(
    req: CloudDeployReq,
    manager: State<'_, CloudSyncManager>,
    app: AppHandle,
) -> Result<CloudDeployResult, String> {
    let ssh_host = req.ssh_host.trim().to_string();
    if ssh_host.is_empty() || ssh_host.starts_with('-') {
        return Err("enter an SSH host or ~/.ssh/config alias".into());
    }
    if req.ssh_port == 0 || req.remote_port == 0 {
        return Err("SSH and service ports must be between 1 and 65535".into());
    }
    let server_url = normalize_server_url(&req.server_url)?;
    if !server_url.starts_with("https://") {
        return Err("the public sync URL must use HTTPS".into());
    }
    let name = if req.name.trim().is_empty() {
        url::Url::parse(&server_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| ssh_host.clone())
    } else {
        req.name.trim().to_string()
    };
    let local_tarball = resolve_local_tarball()?;
    let deployment_id = Uuid::new_v4().to_string();
    let deployment_kind = req.deployment_kind.trim();
    if !matches!(deployment_kind, "standalone" | "docker") {
        return Err("deployment kind must be standalone or docker".into());
    }
    if req.update_existing && req.reset_existing {
        return Err("upgrade and clean install cannot be requested together".into());
    }
    let remote_deploy_dir = if deployment_kind == "docker" {
        Some(validate_remote_deploy_dir(
            req.remote_deploy_dir
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(DEFAULT_REMOTE_DOCKER_DIR),
        )?)
    } else {
        None
    };

    emit(&app, "CheckingHost", "running", "checking the remote host");
    let preflight = if let Some(remote_dir) = &remote_deploy_dir {
        docker_preflight_command(remote_dir, req.update_existing, req.reset_existing)
    } else {
        format!(
            "set -e; arch=$(uname -m); case \"$arch\" in x86_64|amd64) ;; *) echo \"unsupported architecture: $arch (expected x86_64)\" >&2; exit 2 ;; esac; command -v tar >/dev/null; command -v curl >/dev/null; command -v nohup >/dev/null; command -v readlink >/dev/null; command -v sleep >/dev/null; install_dir=$HOME/{REMOTE_INSTALL_DIR}; if [ \"{}\" != 1 ] && [ \"{}\" != 1 ] && [ -e \"$install_dir/bin/kode-sync-server\" ]; then echo \"a standalone Kode sync installation already exists; choose Upgrade or enable clean install\" >&2; exit 2; fi",
            u8::from(req.update_existing),
            u8::from(req.reset_existing),
        )
    };
    run_ssh(&ssh_host, req.ssh_port, &preflight)
        .map_err(|error| fail(&app, "CheckingHost", "remote host check failed", error))?;
    emit(&app, "CheckingHost", "done", "remote host is compatible");

    emit(&app, "Uploading", "running", &format!("scp → {ssh_host}"));
    run_scp(&ssh_host, req.ssh_port, &local_tarball, REMOTE_TARBALL)
        .map_err(|error| fail(&app, "Uploading", "upload failed", error))?;
    emit(&app, "Uploading", "done", "uploaded");

    if let Some(remote_dir) = &remote_deploy_dir {
        emit(
            &app,
            "StoppingOld",
            "running",
            "preparing Docker package update",
        );
        emit(
            &app,
            "StoppingOld",
            "done",
            "Docker deployment ready (existing or new)",
        );
        emit(
            &app,
            "Extracting",
            "running",
            "replacing sync-server binary",
        );
        let update = docker_install_command(
            remote_dir,
            REMOTE_TARBALL,
            &server_url,
            req.update_existing,
            req.reset_existing,
        )?;
        run_ssh(&ssh_host, req.ssh_port, &update)
            .map_err(|error| fail(&app, "Extracting", "Docker package update failed", error))?;
        emit(
            &app,
            "Extracting",
            "done",
            "Docker package installed or updated",
        );

        emit(&app, "StartingNew", "running", "rebuilding Docker service");
        let start = format!(
            "set -e; deploy_dir={}; cd \"$deploy_dir\"; ./deploy.sh up",
            remote_dir.shell_expr
        );
        run_ssh(&ssh_host, req.ssh_port, &start).map_err(|error| {
            fail(
                &app,
                "StartingNew",
                "Docker deployment failed",
                explain_docker_start_error(error),
            )
        })?;
        emit(&app, "StartingNew", "done", "Docker service rebuilt");
    } else {
        emit(&app, "StoppingOld", "running", "stopping previous service");
        run_ssh(
        &ssh_host,
        req.ssh_port,
        "install_dir=$HOME/.local/kode-sync-server; pid_file=$install_dir/sync-server.pid; if [ -f \"$pid_file\" ]; then pid=$(cat \"$pid_file\" 2>/dev/null || true); case \"$pid\" in ''|*[!0-9]*) ;; *) running=$(readlink -f \"/proc/$pid/exe\" 2>/dev/null || true); expected=$(readlink -f \"$install_dir/bin/kode-sync-server\" 2>/dev/null || true); if [ -n \"$expected\" ] && [ \"$running\" = \"$expected\" ]; then kill \"$pid\" 2>/dev/null || true; attempts=0; while kill -0 \"$pid\" 2>/dev/null && [ \"$attempts\" -lt 20 ]; do sleep 0.1; attempts=$((attempts + 1)); done; kill -9 \"$pid\" 2>/dev/null || true; fi ;; esac; rm -f \"$pid_file\"; fi; exit 0",
    )
    .map_err(|error| fail(&app, "StoppingOld", "stop failed", error))?;
        emit(&app, "StoppingOld", "done", "stopped (or none was running)");

        if req.reset_existing && !req.update_existing {
            run_ssh(
                &ssh_host,
                req.ssh_port,
                &format!("rm -rf \"$HOME/{REMOTE_INSTALL_DIR}\""),
            )
            .map_err(|error| fail(&app, "StoppingOld", "clean install failed", error))?;
        }

        emit(&app, "Extracting", "running", "installing service bundle");
        let extract = format!(
            "mkdir -p ~/{REMOTE_INSTALL_DIR}/data && \
         tar -xzf {REMOTE_TARBALL} -C ~/{REMOTE_INSTALL_DIR} && \
         chmod +x ~/{REMOTE_INSTALL_DIR}/bin/kode-sync-server"
        );
        run_ssh(&ssh_host, req.ssh_port, &extract)
            .map_err(|error| fail(&app, "Extracting", "extract failed", error))?;
        emit(&app, "Extracting", "done", "installed");

        emit(&app, "StartingNew", "running", "starting sync service");
        let public_url = shell_quote(&server_url);
        let deployment_id_env = shell_quote(&deployment_id);
        let start = format!(
            "nohup env KODE_SYNC_BIND=0.0.0.0:{port} \
         KODE_SYNC_DATABASE=$HOME/{dir}/data/kode-sync.db \
         KODE_SYNC_PUBLIC_URL={public_url} \
         KODE_SYNC_DEPLOYMENT_ID={deployment_id_env} \
         RUST_LOG=info,kode_sync_server=info \
         $HOME/{dir}/bin/kode-sync-server \
         > $HOME/{dir}/sync-server.log 2>&1 < /dev/null & \
         echo $! > $HOME/{dir}/sync-server.pid",
            port = req.remote_port,
            dir = REMOTE_INSTALL_DIR,
        );
        run_ssh(&ssh_host, req.ssh_port, &start)
            .map_err(|error| fail(&app, "StartingNew", "start failed", error))?;
        emit(&app, "StartingNew", "done", "started");
    }

    emit(
        &app,
        "LocalHealth",
        "running",
        "checking service on the remote host",
    );
    let local_health = if let Some(remote_dir) = &remote_deploy_dir {
        format!(
            "set -e; {}; deploy_dir={}; cd \"$deploy_dir\"; container=$(compose --env-file .env -f docker-compose.yml ps -q sync-server); test -n \"$container\"; state=$(docker inspect --format '{{{{if .State.Health}}}}{{{{.State.Health.Status}}}}{{{{else}}}}{{{{.State.Status}}}}{{{{end}}}}' \"$container\"); case \"$state\" in healthy|running) ;; *) echo \"container state: $state\" >&2; exit 1 ;; esac",
            compose_shell_function(),
            remote_dir.shell_expr,
        )
    } else {
        format!(
            "curl -fsS --max-time 3 http://127.0.0.1:{}/healthz | grep -F {}",
            req.remote_port,
            shell_quote(&deployment_id),
        )
    };
    let mut last_error = String::new();
    for attempt in 1..=LOCAL_HEALTH_RETRIES {
        match run_ssh(&ssh_host, req.ssh_port, &local_health) {
            Ok(_) => {
                last_error.clear();
                break;
            }
            Err(error) => {
                last_error = error;
                if attempt < LOCAL_HEALTH_RETRIES {
                    tokio::time::sleep(Duration::from_millis(750)).await;
                }
            }
        }
    }
    if !last_error.is_empty() {
        return Err(fail(
            &app,
            "LocalHealth",
            "service did not become healthy",
            last_error,
        ));
    }
    emit(&app, "LocalHealth", "done", "remote service is healthy");

    emit(
        &app,
        "PublicHealth",
        "running",
        "checking the public HTTPS route",
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;
    let mut public_error = String::new();
    for attempt in 1..=PUBLIC_HEALTH_RETRIES {
        match client
            .get(format!("{server_url}{PUBLIC_HEALTH_PATH}"))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let content_type = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("unknown content type")
                    .to_string();
                match response.bytes().await {
                    Ok(body) => match serde_json::from_slice::<serde_json::Value>(&body) {
                        Ok(body)
                            if if deployment_kind == "docker" {
                                body.get("status").and_then(serde_json::Value::as_str) == Some("ok")
                            } else {
                                body.get("deployment_id")
                                    .and_then(serde_json::Value::as_str)
                                    == Some(deployment_id.as_str())
                            } =>
                        {
                            public_error.clear();
                            break;
                        }
                        Ok(_) => {
                            public_error =
                                "the public URL reached a different sync-server deployment".into()
                        }
                        Err(error) => {
                            let preview = String::from_utf8_lossy(&body);
                            public_error = format!(
                            "{PUBLIC_HEALTH_PATH} returned invalid JSON ({content_type}): {error}; body={:?}",
                            preview.chars().take(120).collect::<String>()
                        );
                        }
                    },
                    Err(error) => public_error = format!("could not read health response: {error}"),
                }
            }
            Ok(response) => {
                let status = response.status();
                let aio_forward = response
                    .headers()
                    .get("x-proxy-by")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.eq_ignore_ascii_case("AIO-Forward"));
                public_error = if status == reqwest::StatusCode::BAD_GATEWAY && aio_forward {
                    if deployment_kind == "docker" {
                        "HTTP 502 from DevCloud/AIO: the gateway could not connect to this host. Kode installed Caddy on HTTP port 80; configure the AIO upstream to use HTTP port 80 and allow that port".into()
                    } else {
                        format!(
                            "HTTP 502 from DevCloud/AIO: the gateway could not connect to this host. Configure its HTTP upstream to port {} or use Docker + Caddy deployment",
                            req.remote_port
                        )
                    }
                } else {
                    format!("HTTP {status}")
                };
            }
            Err(error) => public_error = error.to_string(),
        }
        if attempt < PUBLIC_HEALTH_RETRIES {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    if !public_error.is_empty() {
        return Err(fail(
            &app,
            "PublicHealth",
            "service is running, but the public HTTPS route cannot reach it",
            public_error,
        ));
    }
    emit(&app, "PublicHealth", "done", "public route is healthy");

    emit(
        &app,
        "SavingBackend",
        "running",
        "saving deployment backend",
    );
    let backend = manager.upsert_managed_backend(
        name,
        server_url,
        ssh_host,
        req.ssh_port,
        req.remote_port,
        deployment_kind.to_string(),
        remote_deploy_dir.map(|dir| dir.original),
    ).await?;
    emit(&app, "SavingBackend", "done", "backend saved");
    emit(&app, "Done", "done", "deployment complete");
    Ok(CloudDeployResult { backend })
}

fn resolve_local_tarball() -> Result<String, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let bundle_resource = exe_dir
                .parent()
                .map(|path| path.join("Resources").join(TARBALL_RESOURCE))
                .unwrap_or_default();
            for candidate in [exe_dir.join(TARBALL_RESOURCE), bundle_resource] {
                if non_empty_file(&candidate) {
                    return Ok(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    for candidate in [
        "target/sync-server/kode-sync-server-x86_64-unknown-linux-musl.tar.gz",
        "../target/sync-server/kode-sync-server-x86_64-unknown-linux-musl.tar.gz",
    ] {
        if non_empty_file(Path::new(candidate)) {
            return Ok(candidate.into());
        }
    }
    Err("sync server bundle is missing; build it with `bash deploy/build-sync-server.sh` before packaging the app".into())
}

fn non_empty_file(path: &Path) -> bool {
    path.is_file()
        && path
            .metadata()
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn docker_install_command(
    remote_dir: &RemoteDeployDir,
    remote_tarball: &str,
    server_url: &str,
    update_existing: bool,
    reset_existing: bool,
) -> Result<String, String> {
    let domain = url::Url::parse(server_url)
        .map_err(|error| format!("invalid public sync URL: {error}"))?
        .host_str()
        .ok_or_else(|| "the public sync URL has no hostname".to_string())?
        .to_string();
    let devcloud = domain.ends_with(".devcloud.woa.com");
    let caddyfile = if devcloud {
        format!(
            "http://{domain} {{\n  encode zstd gzip\n  reverse_proxy sync-server:8787\n  header {{\n    Strict-Transport-Security \"max-age=31536000; includeSubDomains\"\n    X-Content-Type-Options \"nosniff\"\n    Referrer-Policy \"no-referrer\"\n    -Server\n  }}\n}}\n"
        )
    } else {
        format!(
            "{domain} {{\n  encode zstd gzip\n  reverse_proxy sync-server:8787\n  header {{\n    Strict-Transport-Security \"max-age=31536000; includeSubDomains\"\n    X-Content-Type-Options \"nosniff\"\n    Referrer-Policy \"no-referrer\"\n    -Server\n  }}\n}}\n"
        )
    };
    let dockerfile = r#"FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl && install -d /data
COPY bin/kode-sync-server /usr/local/bin/kode-sync-server
RUN chmod 0755 /usr/local/bin/kode-sync-server
EXPOSE 8787
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=6 CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/kode-sync-server"]
"#;
    let compose = r#"services:
  sync-server:
    build: { context: ., dockerfile: Dockerfile }
    image: kode-sync-server:local
    restart: unless-stopped
    user: "${KODE_SYNC_UID}:${KODE_SYNC_GID}"
    environment:
      KODE_SYNC_BIND: 0.0.0.0:8787
      KODE_SYNC_DATABASE: /data/kode-sync.db
      KODE_SYNC_PUBLIC_URL: https://${KODE_SYNC_DOMAIN}
      RUST_LOG: ${KODE_SYNC_LOG:-info,kode_sync_server=info}
    volumes: ["./data/sync:/data"]
    networks: [kode-sync]
    expose: ["8787"]
  caddy:
    image: caddy:2.10-alpine
    restart: unless-stopped
    depends_on:
      sync-server: { condition: service_healthy }
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data/caddy-data:/data
      - ./data/caddy-config:/config
    networks: [kode-sync]
networks:
  kode-sync:
"#;
    let deploy_script = format!(
        r#"#!/bin/sh
set -eu
{}
action=${{1:-up}}
case "$action" in
  verify) test -x bin/kode-sync-server; compose config -q ;;
  up) compose up -d --build ;;
  status) compose ps ;;
  logs) compose logs --tail=200 -f ;;
  down) compose down ;;
  *) echo "usage: $0 verify|up|status|logs|down" >&2; exit 2 ;;
esac
"#,
        compose_shell_function()
    );
    let env_file = format!("KODE_SYNC_DOMAIN={domain}\nKODE_SYNC_LOG=info,kode_sync_server=info\n");

    let clean_install = reset_existing && !update_existing;
    Ok(format!(
        "set -e; {}; deploy_dir={}; if [ \"{}\" = 1 ] && [ -d \"$deploy_dir\" ]; then if [ -f \"$deploy_dir/docker-compose.yml\" ]; then cd \"$deploy_dir\"; compose --env-file .env -f docker-compose.yml down -v --remove-orphans || true; fi; rm -rf \"$deploy_dir\"; fi; mkdir -p \"$deploy_dir/bin\"; stage=$(mktemp -d /tmp/kode-sync-update.XXXXXX); trap 'rm -rf \"$stage\"' EXIT; tar -xzf {} -C \"$stage\"; test -x \"$stage/bin/kode-sync-server\"; install -m 0755 \"$stage/bin/kode-sync-server\" \"$deploy_dir/bin/kode-sync-server.new\"; mv -f \"$deploy_dir/bin/kode-sync-server.new\" \"$deploy_dir/bin/kode-sync-server\"; if [ ! -f \"$deploy_dir/.kode-managed-deployment\" ] && [ -x \"$deploy_dir/deploy.sh\" ]; then cd \"$deploy_dir\"; sha256sum bin/kode-sync-server > SHA256SUMS; compose --env-file .env -f docker-compose.yml config -q; else mkdir -p \"$deploy_dir/data/sync\" \"$deploy_dir/data/caddy-data\" \"$deploy_dir/data/caddy-config\"; printf %s {} > \"$deploy_dir/Dockerfile\"; printf %s {} > \"$deploy_dir/docker-compose.yml\"; printf %s {} > \"$deploy_dir/Caddyfile\"; printf %s {} > \"$deploy_dir/.env\"; printf 'KODE_SYNC_UID=%s\\nKODE_SYNC_GID=%s\\n' \"$(id -u)\" \"$(id -g)\" >> \"$deploy_dir/.env\"; chmod 600 \"$deploy_dir/.env\"; printf %s {} > \"$deploy_dir/deploy.sh\"; chmod 0755 \"$deploy_dir/deploy.sh\"; : > \"$deploy_dir/.kode-managed-deployment\"; cd \"$deploy_dir\"; sha256sum bin/kode-sync-server > SHA256SUMS; ./deploy.sh verify; fi",
        compose_shell_function(),
        remote_dir.shell_expr,
        u8::from(clean_install),
        shell_quote(remote_tarball),
        shell_quote(dockerfile),
        shell_quote(compose),
        shell_quote(&caddyfile),
        shell_quote(&env_file),
        shell_quote(&deploy_script),
    ))
}

fn docker_preflight_command(
    remote_dir: &RemoteDeployDir,
    update_existing: bool,
    reset_existing: bool,
) -> String {
    let existing_policy = if update_existing {
        "test -x \"$deploy_dir/deploy.sh\" && test -f \"$deploy_dir/docker-compose.yml\" && test -f \"$deploy_dir/Dockerfile\" && test -d \"$deploy_dir/bin\" || { echo \"the saved Docker deployment is incomplete; use a new clean install to replace it\" >&2; exit 2; }"
    } else if reset_existing {
        ":"
    } else {
        "if [ -d \"$deploy_dir\" ] && [ -n \"$(find \"$deploy_dir\" -mindepth 1 -maxdepth 1 -print -quit)\" ]; then echo \"the target directory is not empty; enable clean install to replace it or choose Upgrade\" >&2; exit 2; fi"
    };
    format!(
        "set -e; arch=$(uname -m); case \"$arch\" in x86_64|amd64) ;; *) echo \"unsupported architecture: $arch (expected x86_64)\" >&2; exit 2 ;; esac; command -v tar >/dev/null; command -v sha256sum >/dev/null; command -v docker >/dev/null; if ! docker info >/dev/null 2>&1; then echo \"Docker daemon is unavailable; start it with: systemctl enable --now docker\" >&2; exit 2; fi; {}; compose version >/dev/null; deploy_dir={}; {}",
        compose_shell_function(),
        remote_dir.shell_expr,
        existing_policy
    )
}

fn compose_shell_function() -> &'static str {
    r#"compose() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"; else echo "Docker Compose is missing; install the Compose v2 plugin or docker-compose v1" >&2; return 127; fi; }"#
}

fn explain_docker_start_error(error: String) -> String {
    if error.contains("authorization denied by plugin hbm") {
        format!(
            "the managed Docker policy rejected access to the deployment storage directory. Allow bind mounts for the selected remote installation directory, or deploy as a standalone service. Details: {error}"
        )
    } else {
        error
    }
}

struct RemoteDeployDir {
    original: String,
    shell_expr: String,
}

fn validate_remote_deploy_dir(value: &str) -> Result<RemoteDeployDir, String> {
    let value = value.trim();
    let rest = if let Some(rest) = value.strip_prefix("~/") {
        rest
    } else if let Some(rest) = value.strip_prefix('/') {
        rest
    } else {
        return Err("remote Docker directory must start with ~/ or /".into());
    };
    if rest.is_empty()
        || rest
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !rest
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/'))
    {
        return Err("remote Docker directory contains unsupported path components".into());
    }
    let shell_expr = if value.starts_with("~/") {
        format!("\"$HOME/{}\"", &value[2..])
    } else {
        shell_quote(value)
    };
    Ok(RemoteDeployDir {
        original: value.into(),
        shell_expr,
    })
}

fn emit(app: &AppHandle, step: &str, status: &str, message: &str) {
    let _ = app.emit(
        "cloud-deploy-progress",
        CloudDeployProgress {
            step: step.into(),
            status: status.into(),
            message: message.into(),
        },
    );
}

fn fail(app: &AppHandle, step: &str, context: &str, error: String) -> String {
    let message = format!("{context}: {error}");
    emit(app, step, "failed", &message);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_remote_environment_values() {
        assert_eq!(
            shell_quote("https://sync.example.com"),
            "'https://sync.example.com'"
        );
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
    }

    #[test]
    fn public_health_uses_namespaced_route() {
        assert_eq!(PUBLIC_HEALTH_PATH, "/api/v1/healthz");
    }

    #[test]
    fn validates_remote_docker_directory() {
        let home = validate_remote_deploy_dir("~/kode-sync-server-0.2.2-dev-linux-amd64").unwrap();
        assert_eq!(
            home.shell_expr,
            "\"$HOME/kode-sync-server-0.2.2-dev-linux-amd64\""
        );
        assert!(validate_remote_deploy_dir("relative/path").is_err());
        assert!(validate_remote_deploy_dir("~/../escape").is_err());
        assert!(validate_remote_deploy_dir("~/bad;command").is_err());
    }

    #[test]
    fn docker_bootstrap_uses_http_caddy_for_devcloud() {
        let dir = validate_remote_deploy_dir(DEFAULT_REMOTE_DOCKER_DIR).unwrap();
        let command = docker_install_command(
            &dir,
            REMOTE_TARBALL,
            "https://developer-any5.devcloud.woa.com",
            false,
            false,
        )
        .unwrap();
        assert!(command.contains("http://developer-any5.devcloud.woa.com"));
        assert!(command.contains("reverse_proxy sync-server:8787"));
        assert!(command.contains("80:80"));
        assert!(command.contains(".kode-managed-deployment"));
        assert!(command.contains("./data/sync:/data"));
        assert!(command.contains("./data/caddy-data:/data"));
        assert!(!command.contains("kode-sync-data:/data"));
    }

    #[test]
    fn docker_bootstrap_uses_caddy_https_for_public_vps() {
        let dir = validate_remote_deploy_dir("/srv/kode-sync").unwrap();
        let command = docker_install_command(
            &dir,
            REMOTE_TARBALL,
            "https://sync.example.com",
            false,
            false,
        )
        .unwrap();
        assert!(command.contains("sync.example.com {"));
        assert!(!command.contains("http://sync.example.com"));
    }

    #[test]
    fn clean_docker_install_removes_old_stack_and_volumes() {
        let dir = validate_remote_deploy_dir(DEFAULT_REMOTE_DOCKER_DIR).unwrap();
        let command = docker_install_command(
            &dir,
            REMOTE_TARBALL,
            "https://sync.example.com",
            false,
            true,
        )
        .unwrap();
        assert!(command
            .contains("compose --env-file .env -f docker-compose.yml down -v --remove-orphans"));
        assert!(command.contains("rm -rf \"$deploy_dir\""));
    }

    #[test]
    fn upgrade_requires_a_complete_docker_package() {
        let dir = validate_remote_deploy_dir(DEFAULT_REMOTE_DOCKER_DIR).unwrap();
        let command = docker_preflight_command(&dir, true, false);
        assert!(command.contains("the saved Docker deployment is incomplete"));
        assert!(command.contains("test -x \"$deploy_dir/deploy.sh\""));
    }

    #[test]
    fn docker_commands_support_compose_v2_and_v1() {
        let function = compose_shell_function();
        assert!(function.contains("docker compose version"));
        assert!(function.contains("command -v docker-compose"));
        assert!(function.contains("docker-compose \"$@\""));
        let dir = validate_remote_deploy_dir(DEFAULT_REMOTE_DOCKER_DIR).unwrap();
        let preflight = docker_preflight_command(&dir, false, false);
        assert!(preflight.contains("compose version"));
        assert!(!preflight.contains("docker compose version >/dev/null;"));
        assert!(preflight.contains("Docker daemon is unavailable"));
    }

    #[test]
    fn explains_managed_docker_mount_rejection() {
        let message = explain_docker_start_error(
            "authorization denied by plugin hbm: Volume example:/data:rw is not allowed".into(),
        );
        assert!(message.contains("managed Docker policy"));
        assert!(message.contains("standalone service"));
    }
}
