//! Kode backend catalog adapter. Network work stays off the UI thread;
//! native registrations are independent of GUI's opened-tabs snapshot.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use kode_core::process::HideConsole;
use crate::persistence::PersistedState;
#[derive(Deserialize,Serialize)]
struct Connection { url: String, token_file: std::path::PathBuf, server_command: Option<std::path::PathBuf>, server_config: Option<std::path::PathBuf>, #[serde(default)] server_args: Vec<String> }
static START: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Connection document shared by every frontend of the workbench service.
pub(crate) fn connection_path() -> anyhow::Result<std::path::PathBuf> {
    std::env::var_os("KODE_WORKBENCH_CONNECTION").map(std::path::PathBuf::from).or_else(||dirs::config_dir().map(|root|root.join("kode/workbench-connection.json"))).ok_or_else(||anyhow::anyhow!("config directory unavailable"))
}
pub(crate) async fn connection() -> anyhow::Result<(reqwest::Client, String, String)> {
    let path = connection_path()?;
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
    let mut config: Connection = serde_json::from_slice(&tokio::fs::read(&path).await?)?;
    // A self-managed service runs from this app's own binary. The connection
    // file keeps the path of whichever build created it (often a dev build).
    let managed = config.server_args == ["--kode-workbench-server"];
    let own = std::env::current_exe()?;
    if managed && config.server_command.as_deref() != Some(own.as_path()) {
        config.server_command = Some(own.clone());
        tokio::fs::write(&path, serde_json::to_vec(&config)?).await?;
    }
    let url = reqwest::Url::parse(&config.url)?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) || !url.username().is_empty() { anyhow::bail!("workbench backend must use an authenticated loopback origin") }
    let token = tokio::fs::read_to_string(&config.token_file).await?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(4)).redirect(reqwest::redirect::Policy::none()).build()?;
    let node = format!("{}/api/v1/messaging/node",config.url.trim_end_matches('/'));
    if managed {
        if let Ok(response) = client.get(&node).bearer_auth(token.trim()).send().await {
            let running: Value = response.json().await.unwrap_or_default();
            if replace_running_service(&running, &own) {
                stop_service(&client, &node, token.trim(), &running).await;
            }
        }
    }
    if client.get(&node).bearer_auth(token.trim()).send().await.is_err() {
        let command=config.server_command.as_ref().ok_or_else(||anyhow::anyhow!("Kode backend is not running; start its configured service"))?;
        let args=config.server_config.as_ref().ok_or_else(||anyhow::anyhow!("Kode backend service config is missing"))?;
        std::process::Command::new(command).hide_console().args(&config.server_args).args(["--config",&args.to_string_lossy(),"--token-file",&config.token_file.to_string_lossy(),"--bind",&format!("{}:{}",url.host_str().unwrap(),url.port().unwrap_or(80))]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
        let mut ready=false;
        for _ in 0..30 {if client.get(format!("{}/api/v1/messaging/node",config.url.trim_end_matches('/'))).bearer_auth(token.trim()).send().await.is_ok_and(|response|response.status().is_success()){ready=true;break};tokio::time::sleep(std::time::Duration::from_millis(100)).await;}
        if !ready {anyhow::bail!("Kode backend could not start")}
    }
    Ok((client, format!("{}/api/v1/messaging/workbench/documents/session-index", config.url.trim_end_matches('/')), token.trim().into()))
}
/// Replace a running self-managed service only when its binary is older
/// than ours, so a newer build wins and two installs never ping-pong. The
/// path alone proves nothing: reinstalling the app over the same path leaves
/// the old build's service running with routes the new app needs.
fn replace_running_service(running: &Value, _own: &std::path::Path) -> bool {
    let (_, own_built) = kode_bridge::messaging::server_binary();
    match (running["executable"].as_str(), running["built_at"].as_u64(), own_built) {
        (Some(_), Some(theirs), Some(ours)) => theirs < ours,
        // Services predating these fields report no pid and cannot be stopped.
        _ => false,
    }
}
async fn stop_service(client: &reqwest::Client, node: &str, token: &str, running: &Value) {
    let Some(pid) = running["pid"].as_u64() else { return };
    tracing::info!(pid, executable = ?running["executable"], "replacing workbench service from an older build");
    // SIGINT runs the service's graceful shutdown and releases its store lock.
    #[cfg(unix)]
    let _ = std::process::Command::new("kill").args(["-INT", &pid.to_string()]).status();
    for _ in 0..50 {
        if client.get(node).bearer_auth(token).send().await.is_err() { break }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
pub async fn load_tabs(fallback: &mut PersistedState) {
    let Ok((client,url,token)) = connection().await else { return };
    let sessions_url=url.replace("/documents/session-index","/sessions");
    let Ok(response) = client.get(&sessions_url).bearer_auth(&token).send().await else { return };
    if !response.status().is_success() { return }
    let Ok(row) = response.json::<Value>().await else { return };
    let Some(rows) = row["tabs"].as_array() else { return };
    let opened = match client.get(&url).bearer_auth(&token).send().await {
        Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
        _ => None,
    };
    let opened = opened.as_ref().and_then(|document| document.pointer("/value/gui/tabs")).and_then(Value::as_array);
    // The startup read is the baseline; a later read (a mode switch checking
    // the list) must not stand in for what this side last wrote.
    if let Some(opened) = opened { OPEN_BASE.lock().get_or_insert_with(|| opened.clone()); }
    // A malformed entry must not prevent every other session from loading.
    fallback.tabs = opened_tabs(rows, opened).into_iter().filter_map(|row|serde_json::from_value(row.clone()).ok()).collect();
}

/// `/sessions` also lists every saved native conversation, which a CLI exit or
/// tab close intentionally keeps. Restore only what was open at last save, in
/// its order; without a saved snapshot (first run after migration) keep
/// everything. A catalog row only enriches its open tab: the catalog hides
/// conversations dsh archived (it retires its copy of a thread a terminal
/// took over), and that must not drop a tab the user still had open.
fn opened_tabs<'a>(rows: &'a [Value], opened: Option<&'a Vec<Value>>) -> Vec<&'a Value> {
    let Some(opened) = opened else { return rows.iter().collect() };
    opened.iter().map(|tab| rows.iter().find(|row| open_key(row) == open_key(tab)).unwrap_or(tab)).collect()
}

/// Identity of an open tab across endpoints. A tab whose CLI has not reported
/// its session yet is only ever equal to itself.
fn open_key(row: &Value) -> String {
    if row["session_id"].as_str().is_none_or(str::is_empty) { return format!("unsaved:{row}") }
    let endpoint = if row["endpoint_id"].is_null() || row["endpoint_id"]["kind"] == "local" { Value::Null } else { row["endpoint_id"]["id"].clone() };
    json!([endpoint, row["backend_key"], row["session_id"]]).to_string()
}

/// The open list as this frontend last read or wrote it.
static OPEN_BASE: parking_lot::Mutex<Option<Vec<Value>>> = parking_lot::Mutex::new(None);

/// The open list is shared: the dsh view opens and closes conversations in it
/// too. Merge against what this frontend last saw instead of overwriting, so a
/// conversation opened or closed there since is not undone here. A tab this
/// side changed wins; one it left untouched follows the other side.
fn merge_open_tabs(base: Option<&[Value]>, mine: &[Value], theirs: &[Value]) -> Vec<Value> {
    let find = |rows: &[Value], key: &str| rows.iter().find(|row| open_key(row) == key).cloned();
    let mut merged = Vec::new();
    for tab in mine {
        let key = open_key(tab);
        let untouched = base.is_some_and(|base| find(base, &key).as_ref() == Some(tab));
        match find(theirs, &key) {
            Some(other) if untouched => merged.push(other),
            // Untouched here and gone there: closed on the other side.
            None if untouched => {}
            _ => merged.push(tab.clone()),
        }
    }
    for tab in theirs {
        let key = open_key(tab);
        // Opened on the other side; without a baseline, keep it too.
        let new = base.is_none_or(|base| find(base, &key).is_none());
        if new && find(&merged, &key).is_none() { merged.push(tab.clone()) }
    }
    merged
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
        let theirs = value.get("gui").and_then(|gui| gui["tabs"].as_array()).cloned().unwrap_or_default();
        let mine = state.tabs.iter().map(serde_json::to_value).collect::<Result<Vec<_>, _>>()?;
        let tabs = merge_open_tabs(OPEN_BASE.lock().as_deref(), &mine, &theirs);
        value.insert("gui".into(), json!({"tabs":tabs,"endpoints":state.endpoints,"session_titles":state.session_titles}));
        let response = client.post(&url).bearer_auth(&token).json(&json!({"expected_revision":row["revision"],"value":value})).send().await?;
        if response.status().is_success() { *OPEN_BASE.lock() = Some(tabs); return Ok(()) }
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
    let host=endpoint["ssh_host"].as_str().ok_or_else(||anyhow::anyhow!("SSH endpoint has no execution host"))?;
    let port=endpoint["ssh_port"].as_u64().filter(|port|*port>0 && *port<=65535).unwrap_or(22) as u16;
    if let Some(node)=mapped_workspace_node(&hosts,host,port) {
        return Ok((base,node.to_owned()))
    }
    let node=crate::remote_workbench::pair(client,&base,token,host,port,false).await?;
    Ok((base,node))
}
fn mapped_workspace_node<'a>(hosts: &'a Value, host: &str, port: u16) -> Option<&'a str> {
    hosts["hosts"].as_array()?.iter().find(|row|
        row["ssh_host"].as_str()==Some(host) && row["ssh_port"].as_u64().unwrap_or(22)==u64::from(port)
    )?["node_id"].as_str()
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
    #[test]
    fn workspace_mapping_keeps_accounts_and_ssh_ports_separate() {
        let hosts=json!({"hosts":[
            {"node_id":"alice-default","ssh_host":"alice@server.example","ssh_port":22},
            {"node_id":"alice-other","ssh_host":"alice@server.example","ssh_port":2200},
            {"node_id":"bob","ssh_host":"bob@server.example","ssh_port":22}
        ]});
        assert_eq!(mapped_workspace_node(&hosts,"alice@server.example",2200),Some("alice-other"));
        assert_eq!(mapped_workspace_node(&hosts,"bob@server.example",22),Some("bob"));
        assert_eq!(mapped_workspace_node(&hosts,"server.example",22),None);
        assert_eq!(mapped_workspace_node(&hosts,"alice@server.example",2222),None);
    }
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

#[cfg(test)]
mod opened_tabs_tests {
    use super::*;

    #[test]
    fn restore_skips_saved_sessions_that_are_no_longer_open() {
        let tab = |backend: &str, id: &str| json!({"backend_key":backend,"session_id":id,"endpoint_id":null});
        let remote = json!({"backend_key":"codex","session_id":"r1","endpoint_id":{"kind":"remote","id":"host.example"}});
        let rows = vec![tab("tclaude","open"), tab("tclaude","exited"), tab("codex","open"), remote.clone()];
        let opened = vec![tab("tclaude","open"), json!({"backend_key":"codex","session_id":"open","endpoint_id":{"kind":"local"}}), remote];
        let ids: Vec<_> = opened_tabs(&rows, Some(&opened)).iter().map(|row| row["session_id"].as_str().unwrap().to_string() + "@" + row["backend_key"].as_str().unwrap()).collect();
        assert_eq!(ids, ["open@tclaude", "open@codex", "r1@codex"]);
        assert_eq!(opened_tabs(&rows, None).len(), 4);
    }

    #[test]
    fn saving_keeps_what_the_view_opened_and_closed_since() {
        let tab = |id: &str, title: &str| json!({"backend_key":"codex","session_id":id,"endpoint_id":null,"title":title});
        let base = vec![tab("kept", "a"), tab("closed-there", "b"), tab("closed-here", "c")];
        // The view opened one and closed one; this side closed one and renamed one.
        let theirs = vec![tab("kept", "a"), tab("closed-here", "c"), tab("opened-there", "d")];
        let mine = vec![tab("kept", "renamed"), tab("closed-there", "b"), tab("opened-here", "e")];
        let merged = merge_open_tabs(Some(&base), &mine, &theirs);
        let ids: Vec<_> = merged.iter().map(|row| row["session_id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["kept", "opened-here", "opened-there"]);
        assert_eq!(merged[0]["title"], "renamed");
        // A tab this side changed survives a close on the other side.
        let merged = merge_open_tabs(Some(&base), &[tab("closed-there", "moved to a terminal")], &theirs);
        assert!(merged.iter().any(|row| row["session_id"] == "closed-there"));
        // Unsaved tabs never collapse into each other.
        let blank = json!({"backend_key":"codex","session_id":null,"title":"x"});
        assert_eq!(merge_open_tabs(Some(&[]), &[blank.clone(), blank], &[]).len(), 2);
    }

    #[test]
    fn restore_keeps_open_tabs_the_catalog_hides() {
        // dsh archived its copy of this thread, so the catalog leaves it out.
        let rows = vec![json!({"backend_key":"kimi","session_id":"k1","endpoint_id":null,"title":"catalog title"})];
        let opened = vec![
            json!({"backend_key":"tcodex","session_id":"t1","endpoint_id":null,"title":"open"}),
            json!({"backend_key":"kimi","session_id":"k1","endpoint_id":null,"title":"stale"}),
        ];
        let restored = opened_tabs(&rows, Some(&opened));
        assert_eq!(restored.iter().map(|row| row["session_id"].as_str().unwrap()).collect::<Vec<_>>(), ["t1", "k1"]);
        assert_eq!(restored[1]["title"], "catalog title");
    }
}

#[cfg(test)]
mod replacement_tests {
    use super::*;

    #[test]
    fn only_services_from_older_builds_are_replaced() {
        let own = std::env::current_exe().unwrap();
        let (_, built) = kode_bridge::messaging::server_binary();
        let built = built.unwrap();
        let other = |at: u64| json!({"pid":1,"executable":"/other/kode-gui","built_at":at});
        assert!(replace_running_service(&other(built - 1), &own));
        assert!(!replace_running_service(&other(built + 1), &own));
        // Reinstalled over the same path: the older build's service yields,
        // the same build (equal timestamps) keeps running.
        assert!(replace_running_service(&json!({"pid":1,"executable":own,"built_at":built - 1}), &own));
        assert!(!replace_running_service(&json!({"pid":1,"executable":own,"built_at":built}), &own));
        assert!(!replace_running_service(&json!({"node_id":"n"}), &own));
    }
}
