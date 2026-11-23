//! Shared workbench service discovery and SSH pairing for GUI and DSH installers.
//! The published connection owns the backend lifetime independently of either frontend.
use anyhow::{bail, Context, Result};
use fs2::FileExt;
use kode_core::process::HideConsole;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[derive(Clone, Deserialize, Serialize)]
pub struct Connection {
    pub url: String,
    pub token_file: PathBuf,
    pub server_command: Option<PathBuf>,
    pub server_config: Option<PathBuf>,
    #[serde(default)]
    pub server_args: Vec<String>,
}
impl Connection {
    fn address(&self) -> Result<String> {
        let url = reqwest::Url::parse(&self.url)?;
        if url.scheme() != "http"
            || !matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            )
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("shared workbench must use a loopback HTTP origin")
        }
        Ok(format!(
            "{}:{}",
            url.host_str().unwrap(),
            url.port().unwrap_or(80)
        ))
    }
    async fn request(
        &self,
        client: &reqwest::Client,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        self.address()?;
        let token = tokio::fs::read_to_string(&self.token_file).await?;
        if token.trim().len() < 32 {
            bail!("invalid shared workbench administrator token")
        }
        let url = format!("{}/api/v1/messaging/{path}", self.url.trim_end_matches('/'));
        let request = match body {
            Some(body) => client.post(url).json(&body),
            None => client.get(url),
        };
        Ok(request
            .bearer_auth(token.trim())
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
}
fn read_optional<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
            format!("invalid workbench metadata: {}", path.display())
        })?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn save(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
fn stable_binary(root: &Path, source: &Path, replace: bool) -> Result<PathBuf> {
    let binary = root.join("bin/kode-session-server");
    std::fs::create_dir_all(binary.parent().unwrap())?;
    if binary.exists() && (!replace || source == binary) {
        return Ok(binary);
    }
    let temporary = binary.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::copy(source, &temporary)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))?;
    }
    std::fs::rename(temporary, &binary)?;
    Ok(binary)
}

/// Reuse the canonical service, or adopt the legacy DSH service with its exact
/// database and node identity. Only an absent installation gets a new database.
async fn ensure(
    connection_file: &Path,
    legacy_deployment: &Path,
    executable: &Path,
    upgrade: bool,
) -> Result<(Connection, Value, std::fs::File)> {
    let root = connection_file
        .parent()
        .context("workbench connection needs a directory")?;
    std::fs::create_dir_all(root)?;
    let lock_path = root.join("workbench-bootstrap.lock");
    let lock = tokio::task::spawn_blocking(move || -> Result<std::fs::File> {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(lock_path)?;
        file.lock_exclusive()?;
        Ok(file)
    })
    .await??;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    if let Some(mut connection) = read_optional::<Connection>(connection_file)? {
        let mut node = start_or_connect(&client, &connection).await?;
        if let Some(legacy) = read_optional::<Value>(legacy_deployment)? {
            if legacy["nodeId"].is_string() && legacy["nodeId"] != node["node_id"] {
                bail!("existing DSH and shared Kode backends have different identities; consolidate their saved data before switching")
            }
        }
        if upgrade {
            node = upgrade_service(
                &client,
                &mut connection,
                &node,
                connection_file,
                legacy_deployment,
                executable,
            )
            .await?;
        }
        return Ok((connection, node, lock));
    }
    if let Some(legacy) = read_optional::<Value>(legacy_deployment)? {
        let data = legacy_deployment.parent().unwrap().join("state");
        let release = legacy["release"]
            .as_str()
            .context("legacy DSH backend release is missing")?;
        let port = legacy["backendPort"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= 65535)
            .context("legacy DSH backend port is invalid")?;
        let mut connection = Connection {
            url: format!("http://127.0.0.1:{port}"),
            token_file: data.join("admin.token"),
            server_config: Some(data.join("backend.json")),
            server_command: Some(Path::new(release).join("bin/kode-session-server")),
            server_args: vec![],
        };
        // Verify the existing identity before publishing its connection. Keep its
        // binary outside release cleanup so either frontend can restart it later.
        let mut node = start_or_connect(&client, &connection).await?;
        if node["node_id"] != legacy["nodeId"] {
            bail!("legacy DSH backend identity changed")
        }
        connection.server_command = Some(stable_binary(root, executable, false)?);
        save(connection_file, &serde_json::to_vec(&connection)?)?;
        if upgrade {
            node = upgrade_service(
                &client,
                &mut connection,
                &node,
                connection_file,
                legacy_deployment,
                executable,
            )
            .await?;
        }
        return Ok((connection, node, lock));
    }
    let server_config = root.join("workbench-server.json");
    let token_file = root.join("workbench-admin.token");
    if !server_config.exists() {
        save(
            &server_config,
            &serde_json::to_vec(
                &json!({"node_id":format!("ssh-{}",uuid::Uuid::new_v4().simple()),"database":root.join("workbench.sqlite"),"peers":[]}),
            )?,
        )?;
    }
    if !token_file.exists() {
        save(
            &token_file,
            format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )
            .as_bytes(),
        )?;
    }
    let socket = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = socket.local_addr()?.port();
    drop(socket);
    let connection = Connection {
        url: format!("http://127.0.0.1:{port}"),
        token_file,
        server_config: Some(server_config),
        server_command: Some(stable_binary(root, executable, false)?),
        server_args: vec![],
    };
    save(connection_file, &serde_json::to_vec(&connection)?)?;
    let node = start_or_connect(&client, &connection).await?;
    Ok((connection, node, lock))
}
async fn upgrade_service(
    client: &reqwest::Client,
    connection: &mut Connection,
    node: &Value,
    connection_file: &Path,
    legacy_deployment: &Path,
    executable: &Path,
) -> Result<Value> {
    let (_, built_at) = super::server_binary();
    if node["built_at"]
        .as_u64()
        .zip(built_at)
        .is_some_and(|(running, supplied)| running >= supplied)
    {
        return Ok(node.clone());
    }
    let legacy = read_optional::<Value>(legacy_deployment)?;
    let pid = node["pid"]
        .as_u64()
        .or_else(|| {
            legacy
                .as_ref()
                .and_then(|legacy| legacy["backendPid"].as_u64())
        })
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
        .context("existing Kode service has no verifiable process identity")?;
    let config = connection
        .server_config
        .as_ref()
        .context("shared Kode configuration missing")?;
    let process_id = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[process_id]),
        true,
        sysinfo::ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );
    let process = system
        .process(process_id)
        .context("existing Kode process is unavailable")?;
    let args = process.cmd();
    let has_argument = |flag: &str, path: &Path| {
        args.windows(2)
            .any(|pair| pair[0] == flag && pair[1] == path.as_os_str())
    };
    if !has_argument("--config", config) || !has_argument("--token-file", &connection.token_file) {
        bail!("existing Kode process does not match its service configuration")
    }
    connection.server_command = Some(stable_binary(
        connection_file.parent().unwrap(),
        executable,
        true,
    )?);
    connection.server_args.clear();
    save(connection_file, &serde_json::to_vec(connection)?)?;
    if !process
        .kill_with(sysinfo::Signal::Interrupt)
        .unwrap_or(false)
    {
        bail!("cannot stop the previous Kode service for upgrade")
    }
    for _ in 0..100 {
        if connection.request(client, "node", None).await.is_err() {
            let restarted = start_or_connect(client, connection).await?;
            if restarted["node_id"] != node["node_id"] {
                bail!("upgraded Kode service changed node identity")
            }
            return Ok(restarted);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("previous Kode service did not finish shutdown")
}

async fn start_or_connect(client: &reqwest::Client, connection: &Connection) -> Result<Value> {
    let address = connection.address()?;
    match connection.request(client, "node", None).await {
        Ok(node) => {
            if node["managed_peers"] != true {
                bail!("update the existing Kode backend to support SSH pairing")
            };
            return Ok(node);
        }
        Err(error) => {
            if !error
                .downcast_ref::<reqwest::Error>()
                .is_some_and(|error| error.is_connect())
            {
                return Err(error);
            }
        }
    }
    // An occupied origin must never cause another backend/database to be created.
    drop(std::net::TcpListener::bind(&address).context("shared workbench origin is occupied")?);
    let executable = connection
        .server_command
        .as_ref()
        .context("shared Kode service has no restart command")?;
    let config = connection
        .server_config
        .as_ref()
        .context("shared Kode service has no configuration file")?;
    let mut command = Command::new(executable).hide_console();
    command
        .args(&connection.server_args)
        .args(["--config"])
        .arg(config)
        .arg("--token-file")
        .arg(&connection.token_file)
        .args(["--bind", &address])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                };
                Ok(())
            });
        }
    }
    let mut child = command
        .spawn()
        .context("cannot start the shared Kode workbench")?;
    for _ in 0..100 {
        if child.try_wait()?.is_some() {
            bail!("shared Kode workbench exited during startup")
        }
        if let Ok(node) = connection.request(client, "node", None).await {
            if node["managed_peers"] == true {
                return Ok(node);
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    bail!("shared Kode workbench startup timed out")
}

pub async fn run(mut args: impl Iterator<Item = String>) -> Result<()> {
    let mut connection_file = std::env::var_os("KODE_WORKBENCH_CONNECTION")
        .map(PathBuf::from)
        .or_else(|| dirs::config_dir().map(|root| root.join("kode/workbench-connection.json")))
        .context("configuration directory unavailable")?;
    let mut legacy = dirs::home_dir()
        .context("home directory unavailable")?
        .join(".local/share/kode/dsh-host/deployment.json");
    let mut upgrade = false;
    let mut local_node = None;
    let mut link_token = None;
    while let Some(argument) = args.next() {
        if argument == "--upgrade" {
            upgrade = true;
            continue;
        }
        let value = args.next().context("bootstrap argument requires a value")?;
        match argument.as_str() {
            "--connection-file" => connection_file = PathBuf::from(value),
            "--legacy-deployment" => legacy = PathBuf::from(value),
            "--local-node" => local_node = Some(value),
            "--link-token" => link_token = Some(value),
            _ => bail!("unknown bootstrap argument"),
        }
    }
    let local_node = local_node.context("--local-node is required")?;
    let supplied = link_token.context("--link-token is required")?;
    if !super::model::valid_id(&local_node) || supplied.len() < 32 {
        bail!("invalid workbench peer identity or token")
    }
    let (connection, node, _lock) = ensure(
        &connection_file,
        &legacy,
        &std::env::current_exe()?,
        upgrade,
    )
    .await?;
    if node["node_id"] == local_node {
        bail!("cannot pair a workbench with itself")
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let peers = match connection.request(&client, "workbench/peers", None).await {
        Ok(document) => serde_json::from_value::<Vec<super::Peer>>(document["peers"].clone())?,
        Err(error)
            if error
                .downcast_ref::<reqwest::Error>()
                .and_then(|error| error.status())
                .is_some_and(|status| {
                    status == reqwest::StatusCode::NOT_FOUND
                        || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
                }) =>
        {
            // Older daemons expose only POST /peers. Read their persisted peer
            // settings without opening a second writable store or restarting them.
            use rusqlite::OptionalExtension;
            let config_path = connection
                .server_config
                .as_ref()
                .context("existing peer configuration unavailable")?;
            let config: super::Config = serde_json::from_slice(&std::fs::read(config_path)?)?;
            let database = rusqlite::Connection::open_with_flags(
                &config.database,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let document: Option<String> = database
                .query_row(
                    "SELECT value FROM workbench_documents WHERE key='managed-peers'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let mut peers = config.peers;
            if let Some(document) = document {
                peers.extend(serde_json::from_str::<Vec<super::Peer>>(&document)?);
            }
            peers
        }
        Err(error) => return Err(error),
    };
    let existing = peers.iter().find(|peer| peer.node_id == local_node);
    let token = existing
        .map(|peer| peer.link_token.as_str())
        .unwrap_or(&supplied)
        .to_owned();
    if existing.is_none() {
        connection
            .request(
                &client,
                "workbench/peers",
                Some(json!({
                    "node_id":local_node,"link_token":token,"url":null,"ssh":null
                })),
            )
            .await?;
    }
    let port = reqwest::Url::parse(&connection.url)?
        .port_or_known_default()
        .context("shared backend port missing")?;
    println!(
        "{}",
        json!({"connection_file":connection_file,"node_id":node["node_id"],"remote_port":port,"link_token":token})
    );
    Ok(())
}
