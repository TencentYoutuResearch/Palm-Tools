//! Self-service cloud sync deployment over SSH.
//!
//! The app ships a static Linux `kode-sync-server` archive and reuses the
//! existing system ssh/scp path, so aliases, keys, and ssh-agent continue to
//! work exactly like Remote Bridge deployment. Public TLS remains owned by the
//! user's ingress; this installer deploys and verifies the Rust service behind
//! that HTTPS origin.

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
const PUBLIC_HEALTH_PATH: &str = "/api/v1/healthz";
const LOCAL_HEALTH_RETRIES: u32 = 8;
const PUBLIC_HEALTH_RETRIES: u32 = 6;

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
}

fn default_deployment_kind() -> String {
    "standalone".into()
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
    let remote_deploy_dir = if deployment_kind == "docker" {
        Some(validate_remote_deploy_dir(
            req.remote_deploy_dir.as_deref().unwrap_or_default(),
        )?)
    } else {
        None
    };

    emit(&app, "CheckingHost", "running", "checking the remote host");
    let preflight = if let Some(remote_dir) = &remote_deploy_dir {
        format!(
            "set -e; arch=$(uname -m); case \"$arch\" in x86_64|amd64) ;; *) echo \"unsupported architecture: $arch (expected x86_64)\" >&2; exit 2 ;; esac; command -v tar >/dev/null; command -v sha256sum >/dev/null; command -v docker >/dev/null; deploy_dir={}; test -x \"$deploy_dir/deploy.sh\"; test -f \"$deploy_dir/docker-compose.yml\"; test -f \"$deploy_dir/Dockerfile\"; test -d \"$deploy_dir/bin\"; docker compose version >/dev/null",
            remote_dir.shell_expr
        )
    } else {
        "set -e; arch=$(uname -m); case \"$arch\" in x86_64|amd64) ;; *) echo \"unsupported architecture: $arch (expected x86_64)\" >&2; exit 2 ;; esac; command -v tar >/dev/null; command -v curl >/dev/null; command -v nohup >/dev/null; command -v readlink >/dev/null; command -v sleep >/dev/null".into()
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
        emit(&app, "StoppingOld", "done", "Docker deployment found");
        emit(
            &app,
            "Extracting",
            "running",
            "replacing sync-server binary",
        );
        let update = format!(
            "set -e; deploy_dir={}; stage=$(mktemp -d /tmp/kode-sync-update.XXXXXX); trap 'rm -rf \"$stage\"' EXIT; tar -xzf {} -C \"$stage\"; test -x \"$stage/bin/kode-sync-server\"; install -m 0755 \"$stage/bin/kode-sync-server\" \"$deploy_dir/bin/kode-sync-server.new\"; mv -f \"$deploy_dir/bin/kode-sync-server.new\" \"$deploy_dir/bin/kode-sync-server\"; cd \"$deploy_dir\"; sha256sum bin/kode-sync-server > SHA256SUMS; ./deploy.sh verify",
            remote_dir.shell_expr,
            shell_quote(REMOTE_TARBALL)
        );
        run_ssh(&ssh_host, req.ssh_port, &update)
            .map_err(|error| fail(&app, "Extracting", "Docker package update failed", error))?;
        emit(&app, "Extracting", "done", "binary and checksum updated");

        emit(&app, "StartingNew", "running", "rebuilding Docker service");
        let start = format!(
            "set -e; deploy_dir={}; cd \"$deploy_dir\"; ./deploy.sh up",
            remote_dir.shell_expr
        );
        run_ssh(&ssh_host, req.ssh_port, &start)
            .map_err(|error| fail(&app, "StartingNew", "Docker deployment failed", error))?;
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
            "set -e; deploy_dir={}; cd \"$deploy_dir\"; container=$(docker compose --env-file .env -f docker-compose.yml ps -q sync-server); test -n \"$container\"; state=$(docker inspect --format '{{{{if .State.Health}}}}{{{{.State.Health.Status}}}}{{{{else}}}}{{{{.State.Status}}}}{{{{end}}}}' \"$container\"); case \"$state\" in healthy|running) ;; *) echo \"container state: $state\" >&2; exit 1 ;; esac",
            remote_dir.shell_expr
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
            Ok(response) => public_error = format!("HTTP {}", response.status()),
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
    )?;
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
}
