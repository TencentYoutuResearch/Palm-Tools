//! Exercise the installer entry point with real HTTP services and isolated stores.
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

struct Service(u32);
impl Drop for Service {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill")
            .args(["-INT", &self.0.to_string()])
            .status();
    }
}
fn command(root: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_kode-session-server"));
    command
        .args(["--bootstrap-workbench", "--connection-file"])
        .arg(root.join("workbench-connection.json"))
        .arg("--legacy-deployment")
        .arg(root.join("legacy/deployment.json"))
        .args([
            "--local-node",
            "desktop-test",
            "--link-token",
            "first-pairing-token-with-at-least-32-bytes",
        ])
        .env("KODE_GUI_STATE_PATH", root.join("gui-state.json"))
        .kill_on_drop(true);
    command
}
async fn bootstrap(root: &Path) -> Value {
    let output = command(root).output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
async fn node(root: &Path) -> Value {
    let connection: Value =
        serde_json::from_slice(&std::fs::read(root.join("workbench-connection.json")).unwrap())
            .unwrap();
    let token = std::fs::read_to_string(connection["token_file"].as_str().unwrap()).unwrap();
    reqwest::Client::new()
        .get(format!(
            "{}/api/v1/messaging/node",
            connection["url"].as_str().unwrap()
        ))
        .bearer_auth(token.trim())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}
#[tokio::test]
async fn concurrent_frontends_share_identity_process_and_pairing_token() {
    let root = tempfile::tempdir().unwrap();
    let (first, second) = tokio::join!(bootstrap(root.path()), bootstrap(root.path()));
    assert_eq!(first, second);
    let running = node(root.path()).await;
    let _service = Service(running["pid"].as_u64().unwrap() as u32);
    assert_eq!(bootstrap(root.path()).await, first);
    assert_eq!(node(root.path()).await["pid"], running["pid"]);
    assert!(root.path().join("workbench.sqlite").exists());
}
#[tokio::test]
async fn adopts_legacy_dsh_database_and_restarts_from_stable_binary() {
    let root = tempfile::tempdir().unwrap();
    let legacy = root.path().join("legacy");
    let data = legacy.join("state");
    std::fs::create_dir_all(&data).unwrap();
    let config = data.join("backend.json");
    let database = data.join("messages.sqlite");
    std::fs::write(
        &config,
        json!({"node_id":"existing-ssh-test","database":database,"peers":[]}).to_string(),
    )
    .unwrap();
    std::fs::write(
        data.join("admin.token"),
        "existing-administrator-token-at-least-32-bytes",
    )
    .unwrap();
    let release = legacy.join("release");
    std::fs::create_dir_all(release.join("bin")).unwrap();
    std::fs::copy(
        env!("CARGO_BIN_EXE_kode-session-server"),
        release.join("bin/kode-session-server"),
    )
    .unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        legacy.join("deployment.json"),
        json!({"nodeId":"existing-ssh-test","backendPort":port,"release":release}).to_string(),
    )
    .unwrap();
    let first = bootstrap(root.path()).await;
    assert_eq!(first["node_id"], "existing-ssh-test");
    let running = node(root.path()).await;
    let service = Service(running["pid"].as_u64().unwrap() as u32);
    let connection: Value = serde_json::from_slice(
        &std::fs::read(root.path().join("workbench-connection.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        PathBuf::from(connection["server_config"].as_str().unwrap()),
        config
    );
    assert!(!root.path().join("workbench.sqlite").exists());
    drop(service);
    tokio::time::sleep(Duration::from_millis(500)).await;
    std::fs::remove_dir_all(release).unwrap();
    assert_eq!(bootstrap(root.path()).await, first);
    let restarted = node(root.path()).await;
    let _service = Service(restarted["pid"].as_u64().unwrap() as u32);
    assert_ne!(restarted["pid"], running["pid"]);
}
#[tokio::test]
async fn invalid_existing_connection_does_not_create_another_store() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("workbench-connection.json"),
        json!({"url":"https://backend.example","token_file":root.path().join("missing.token")})
            .to_string(),
    )
    .unwrap();
    let output = command(root.path()).output().await.unwrap();
    assert!(!output.status.success());
    assert!(!root.path().join("workbench.sqlite").exists());
    assert!(!root.path().join("workbench-server.json").exists());
}

#[tokio::test]
#[ignore = "requires an older Kode daemon through KODE_TEST_PREVIOUS_SERVER"]
async fn upgrade_preserves_the_existing_database_and_node_identity() {
    let previous = PathBuf::from(
        std::env::var_os("KODE_TEST_PREVIOUS_SERVER").expect("set previous server executable"),
    );
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("backend.json");
    let token = "upgrade-administrator-token-with-at-least-32-bytes";
    let token_file = root.path().join("admin.token");
    std::fs::write(&token_file, token).unwrap();
    std::fs::write(
        &config,
        json!({"node_id":"upgrade-test","database":root.path().join("existing.sqlite"),"peers":[]})
            .to_string(),
    )
    .unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let url = format!("http://127.0.0.1:{port}");
    std::fs::write(root.path().join("workbench-connection.json"),json!({"url":url,"token_file":token_file,"server_command":previous,"server_config":config,"server_args":[]}).to_string()).unwrap();
    let mut old = tokio::process::Command::new(previous);
    old.arg("--config")
        .arg(&config)
        .arg("--token-file")
        .arg(&token_file)
        .args(["--bind", &format!("127.0.0.1:{port}")])
        .env("KODE_GUI_STATE_PATH", root.path().join("gui-state.json"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = old.spawn().unwrap();
    let client = reqwest::Client::new();
    for _ in 0..100 {
        if client
            .get(format!("{url}/api/v1/messaging/node"))
            .bearer_auth(token)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let old_pid = child.id().unwrap();
    let document_url = format!("{url}/api/v1/messaging/workbench/documents/session-index");
    client
        .post(&document_url)
        .bearer_auth(token)
        .json(&json!({"expected_revision":0,"value":{"native_sessions":[],"sentinel":"retained"}}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let output = command(root.path())
        .arg("--upgrade")
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let current = node(root.path()).await;
    let _service = Service(current["pid"].as_u64().unwrap() as u32);
    assert_eq!(current["node_id"], "upgrade-test");
    assert_ne!(current["pid"], old_pid);
    assert!(child.wait().await.unwrap().success());
    let document: Value = client
        .get(&document_url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(document["value"]["sentinel"], "retained");
    let again = command(root.path())
        .arg("--upgrade")
        .output()
        .await
        .unwrap();
    assert!(again.status.success());
    assert_eq!(node(root.path()).await["pid"], current["pid"]);
}

#[tokio::test]
async fn separate_existing_databases_are_never_silently_switched() {
    let root = tempfile::tempdir().unwrap();
    bootstrap(root.path()).await;
    let before = node(root.path()).await;
    let _service = Service(before["pid"].as_u64().unwrap() as u32);
    std::fs::create_dir(root.path().join("legacy")).unwrap();
    std::fs::write(
        root.path().join("legacy/deployment.json"),
        json!({"nodeId":"another-existing-store"}).to_string(),
    )
    .unwrap();
    let output = command(root.path()).output().await.unwrap();
    assert!(!output.status.success());
    assert_eq!(node(root.path()).await["pid"], before["pid"]);
    assert!(String::from_utf8_lossy(&output.stderr).contains("different identities"));
}
