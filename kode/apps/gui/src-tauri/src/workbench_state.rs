//! Kode backend catalog adapter. Network work stays off the UI thread;
//! native registrations are independent of GUI's opened-tabs snapshot.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::persistence::PersistedState;
#[derive(Deserialize,Serialize)]
struct Connection { url: String, token_file: std::path::PathBuf, server_command: Option<std::path::PathBuf>, server_config: Option<std::path::PathBuf>, #[serde(default)] server_args: Vec<String> }
static START: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub(crate) async fn connection() -> anyhow::Result<(reqwest::Client, String, String)> {
    let path = dirs::config_dir().ok_or_else(|| anyhow::anyhow!("config directory unavailable"))?.join("kode/workbench-connection.json");
    let _start=START.lock().await;
    if !tokio::fs::try_exists(&path).await? {
        let root=path.parent().unwrap();tokio::fs::create_dir_all(root).await?;
        let token_file=root.join("workbench-admin.token");let server_config=root.join("workbench-server.json");
        let token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
        tokio::fs::write(&token_file,token).await?;
        tokio::fs::write(&server_config,serde_json::to_vec(&json!({"node_id":format!("local-{}",uuid::Uuid::new_v4().simple()),"database":root.join("workbench.sqlite"),"peers":[]}))?).await?;
        let port=std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let initial=Connection {url:format!("http://127.0.0.1:{port}"),token_file:token_file.clone(),server_command:Some(std::env::current_exe()?),server_config:Some(server_config.clone()),server_args:vec!["--kode-workbench-server".into()]};
        tokio::fs::write(&path,serde_json::to_vec(&initial)?).await?;
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;for file in [&path,&token_file,&server_config] {tokio::fs::set_permissions(file,std::fs::Permissions::from_mode(0o600)).await?;}}
    }
    let config: Connection = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
    let url = reqwest::Url::parse(&config.url)?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) || !url.username().is_empty() { anyhow::bail!("workbench backend must use an authenticated loopback origin") }
    let token = tokio::fs::read_to_string(&config.token_file).await?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(4)).redirect(reqwest::redirect::Policy::none()).build()?;
    if client.get(format!("{}/api/v1/messaging/node",config.url.trim_end_matches('/'))).bearer_auth(token.trim()).send().await.is_err() {
        let command=config.server_command.as_ref().ok_or_else(||anyhow::anyhow!("Kode backend is not running; start its configured service"))?;
        let args=config.server_config.as_ref().ok_or_else(||anyhow::anyhow!("Kode backend service config is missing"))?;
        std::process::Command::new(command).args(&config.server_args).args(["--config",&args.to_string_lossy(),"--token-file",&config.token_file.to_string_lossy(),"--bind",&format!("{}:{}",url.host_str().unwrap(),url.port().unwrap_or(80))]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
        let mut ready=false;
        for _ in 0..30 {if client.get(format!("{}/api/v1/messaging/node",config.url.trim_end_matches('/'))).bearer_auth(token.trim()).send().await.is_ok_and(|response|response.status().is_success()){ready=true;break};tokio::time::sleep(std::time::Duration::from_millis(100)).await;}
        if !ready {anyhow::bail!("Kode backend could not start")}
    }
    Ok((client, format!("{}/api/v1/messaging/workbench/documents/session-index", config.url.trim_end_matches('/')), token.trim().into()))
}
pub async fn load_tabs(fallback: &mut PersistedState) {
    let Ok((client,url,token)) = connection().await else { return };
    let sessions_url=url.replace("/documents/session-index","/sessions");
    let Ok(response) = client.get(&sessions_url).bearer_auth(&token).send().await else { return };
    if !response.status().is_success() { return }
    let Ok(row) = response.json::<Value>().await else { return };
    let Some(rows) = row["tabs"].as_array() else { return };
    // A malformed entry must not prevent every other session from loading.
    fallback.tabs = rows.iter().filter_map(|row|serde_json::from_value(row.clone()).ok()).collect();
}
pub async fn save(state: &PersistedState) -> anyhow::Result<()> {
    let Ok((client,url,token)) = connection().await else { return Ok(()) };
    for _ in 0..4 {
        let row: Value = client.get(&url).bearer_auth(&token).send().await?.error_for_status()?.json().await?;
        let mut value = row["value"].as_object().cloned().unwrap_or_default();
        let mut native=value.get("native_sessions").and_then(Value::as_array).cloned().unwrap_or_default();
        for tab in state.tabs.iter().filter(|tab|!matches!(tab.endpoint_id,Some(kode_core::EndpointId::Remote{..})) && tab.session_id.as_deref().is_some_and(|id|!id.is_empty())) {
            let item=serde_json::to_value(tab)?;
            if let Some(existing)=native.iter_mut().find(|row|row["backend_key"]==item["backend_key"] && row["session_id"]==item["session_id"]) {
                for (key,value) in item.as_object().unwrap() {existing[key]=value.clone();}
            } else {native.push(item);}
        }
        value.insert("native_sessions".into(),json!(native));
        value.insert("gui".into(), json!({"tabs":state.tabs,"endpoints":state.endpoints,"session_titles":state.session_titles}));
        let response = client.post(&url).bearer_auth(&token).json(&json!({"expected_revision":row["revision"],"value":value})).send().await?;
        if response.status().is_success() { return Ok(()) }
        let text = response.text().await?;
        if !text.contains("configuration changed") { anyhow::bail!("cannot save shared session index: {text}") }
    }
    anyhow::bail!("shared session index changed repeatedly")
}

/// The only source of workspace choices, for local and SSH execution nodes.
async fn workspace_node(client: &reqwest::Client, document_url: &str, token: &str, bucket: &str) -> anyhow::Result<(String,String)> {
    let base=document_url.trim_end_matches("/documents/session-index").to_owned();
    let hosts: Value=client.get(format!("{base}/workspaces/hosts")).bearer_auth(token).send().await?.error_for_status()?.json().await?;
    if bucket=="local" { return Ok((base,hosts["local_node_id"].as_str().ok_or_else(||anyhow::anyhow!("Kode backend identity missing"))?.into())) }
    let catalog: Value=client.get(format!("{base}/catalog")).bearer_auth(token).send().await?.error_for_status()?.json().await?;
    let endpoint=catalog["endpoints"].as_array().and_then(|rows|rows.iter().find(|row|row["id"].as_str()==Some(bucket))).ok_or_else(||anyhow::anyhow!("SSH endpoint has no Kode backend mapping"))?;
    let host=endpoint["ssh_host"].as_str().ok_or_else(||anyhow::anyhow!("SSH endpoint has no execution host"))?.rsplit('@').next().unwrap_or("");
    let node=hosts["hosts"].as_array().and_then(|rows|rows.iter().find(|row|row["ssh_host"].as_str().and_then(|value|value.rsplit('@').next())==Some(host))).and_then(|row|row["node_id"].as_str()).ok_or_else(||anyhow::anyhow!("SSH Host must connect its Kode backend before workspace access"))?;
    Ok((base,node.into()))
}
pub async fn workspace_paths(bucket: &str) -> anyhow::Result<Vec<String>> {
    let (client,url,token)=connection().await?;
    workspace_paths_from(&client,&url,&token,bucket).await
}
async fn workspace_paths_from(client:&reqwest::Client,url:&str,token:&str,bucket:&str)->anyhow::Result<Vec<String>> {
    let (base,node)=workspace_node(client,url,token,bucket).await?;
    let result: Value=client.get(format!("{base}/workspaces")).query(&[("node_id",node)]).bearer_auth(token).send().await?.error_for_status()?.json().await?;
    Ok(result["workspaces"].as_array().ok_or_else(||anyhow::anyhow!("Invalid Kode workspace catalog"))?.iter().filter_map(|row|row["path"].as_str().map(Into::into)).collect())
}
pub async fn ensure_workspace(bucket: &str, path: &str) -> anyhow::Result<String> {
    let (client,url,token)=connection().await?;
    ensure_workspace_from(&client,&url,&token,bucket,path).await
}
async fn ensure_workspace_from(client:&reqwest::Client,url:&str,token:&str,bucket:&str,path:&str)->anyhow::Result<String> {
    let (base,node)=workspace_node(client,url,token,bucket).await?;
    let result: Value=client.post(format!("{base}/workspaces")).bearer_auth(token).json(&json!({"action":"create","node_id":node,"path":path})).send().await?.error_for_status()?.json().await?;
    let id=result["workspace_id"].as_str().ok_or_else(||anyhow::anyhow!("Kode returned no workspace identity"))?;
    result["workspaces"].as_array().and_then(|rows|rows.iter().find(|row|row["id"].as_str()==Some(id))).and_then(|row|row["path"].as_str()).map(Into::into).ok_or_else(||anyhow::anyhow!("Kode returned no workspace directory"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn gui_workspace_choices_and_registration_use_the_same_kode_catalog() {
        let root=tempfile::tempdir().unwrap();let token="gui-workspace-test-secret-at-least-32-bytes";
        let ctx=kode_bridge::build_runtime_ctx(kode_core::config::Config::default(),token.into());
        let hub=kode_bridge::messaging::Hub::open(kode_bridge::messaging::Config{node_id:"gui-workspace-test".into(),database:root.path().join("data.sqlite"),peers:vec![]},&ctx).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/api/v1/messaging/workbench",listener.local_addr().unwrap());
        let router=hub.router();let task=tokio::spawn(async move{axum::serve(listener,router).await.unwrap()});
        let client=reqwest::Client::new();let url=format!("{base}/documents/session-index");
        client.post(format!("{base}/documents/workspaces")).bearer_auth(token).json(&json!({"expected_revision":0,"value":{"version":2,"tables":{"workspaces":{}},"global":{"initialized":true,"workspaceIds":[],"archivedSessionIds":[],"pinnedSessionIds":[]}}})).send().await.unwrap().error_for_status().unwrap();
        assert!(workspace_paths_from(&client,&url,token,"local").await.unwrap().is_empty());
        let project=root.path().join("project");tokio::fs::create_dir(&project).await.unwrap();
        let path=ensure_workspace_from(&client,&url,token,"local",project.to_str().unwrap()).await.unwrap();
        assert_eq!(workspace_paths_from(&client,&url,token,"local").await.unwrap(),vec![path.clone()]);
        let rows:Value=client.get(format!("{base}/workspaces")).bearer_auth(token).send().await.unwrap().json().await.unwrap();
        assert_eq!(rows["workspaces"][0]["path"],path);
        assert!(workspace_paths_from(&client,&url,token,"unknown-ssh-host").await.is_err());
        hub.shutdown();task.abort();
    }
}
