//! GUI-independent native session discovery. Peers exchange only resumable metadata,
//! never Agent configuration, credentials, or another peer's registrations.
use super::{workspaces::Command, Hub, Peer};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};

fn key(row: &Value) -> String {
    let endpoint=if is_local(row){Value::Null}else{row["endpoint_id"]["id"].clone()};
    json!([endpoint,row["backend_key"],row["session_id"]]).to_string()
}
fn is_local(row: &Value) -> bool {
    row["endpoint_id"].is_null() || row["endpoint_id"]["kind"] == "local"
}
fn sanitized(row: &Value) -> Option<Value> {
    let id = row["session_id"].as_str()?;
    let backend = row["backend_key"].as_str()?;
    let cwd = row["cwd"].as_str()?;
    if !super::model::valid_id(id) || backend.is_empty() || backend.len() > 128
        || cwd.len() > 4096 || !std::path::Path::new(cwd).is_absolute() { return None }
    let mut result = json!({"session_id":id,"backend_key":backend,"cwd":cwd,"transport_kind":"pty","endpoint_id":null,"title":"未命名会话","title_pinned":false});
    if matches!(row["transport_kind"].as_str(), Some("acp" | "runtime")) {
        result["transport_kind"] = row["transport_kind"].clone();
    }
    for field in ["title", "model", "permission_mode", "avatar_id", "dsh_session_id", "workspace_title", "agent_id"] {
        if let Some(value) = row[field].as_str().filter(|value| value.len() <= 512) {
            result[field] = json!(value);
        }
    }
    result["title_pinned"] = json!(row["title_pinned"].as_bool().unwrap_or(false));
    Some(result)
}

pub(super) fn local(hub: &Hub, offset: usize) -> Result<Value> {
    let _gate = hub.gate.lock();
    let mut stored = hub.store.document("session-index")?;
    let agents = hub.store.document("agents")?;
    let bindings = agents.pointer("/value/bindings").and_then(Value::as_object);
    // Adopt saved native identities before GUI's next opened-tabs save. A CLI
    // exit or a frontend closing a tab does not delete the saved conversation.
    let mut value = stored["value"].as_object().cloned().unwrap_or_default();
    let mut native = value.get("native_sessions").and_then(Value::as_array).cloned().unwrap_or_default();
    for tab in value.get("gui").and_then(|gui| gui["tabs"].as_array()).into_iter().flatten().filter(|row| is_local(row)) {
        let binding = bindings.and_then(|rows| rows.iter().find(|(_,b)| b["runtime"] != "pty" && b["threadId"] == tab["session_id"] && !b["threadId"].is_null()));
        if !native.iter().any(|row| key(row) == key(tab)) {
            if let Some(mut row) = sanitized(tab) {
                if let Some((id,_))=binding { row["dsh_session_id"] = json!(id); }
                native.push(row);
            }
        }
    }
    if value.get("native_sessions") != Some(&json!(native)) {
        value.insert("native_sessions".into(),json!(native));
        stored = hub.store.save_document("session-index",stored["revision"].as_u64().unwrap(),Value::Object(value))?;
    }
    let workspaces = super::workspaces::ensure(hub)?;
    let projects = workspaces.pointer("/value/tables/workspaces").and_then(Value::as_object);
    let directory = hub.store.sessions()?;
    let archived = workspaces.pointer("/value/global/archivedSessionIds").and_then(Value::as_array);
    let mut tabs = Vec::new();
    let mut seen = HashSet::new();
    // Native records take precedence; gui.tabs is an opened-tabs snapshot only.
    for tab in native.iter().chain(stored.pointer("/value/gui/tabs").and_then(Value::as_array).into_iter().flatten()).filter(|row| is_local(row)) {
        let Some(mut row) = sanitized(tab) else { continue };
        if !seen.insert(key(&row)) { continue }
        let dsh_id = row["dsh_session_id"].as_str();
        if dsh_id.is_some_and(|id| archived.is_some_and(|rows| rows.iter().any(|row|row.as_str()==Some(id)))) { continue }
        if let Some(info) = directory.iter().find(|info| Some(info.address.session_id.as_str()) == dsh_id) {
            if !info.title.is_empty() { row["title"] = json!(info.title); }
        }
        row["workspace_title"] = projects.and_then(|projects| projects.values().find(|project| project["path"] == row["cwd"]))
            .map(|project| project["title"].clone()).unwrap_or(json!("未分组"));
        tabs.push(row);
    }
    if tabs.len() > 4096 || offset > tabs.len() { bail!("invalid session catalog page") }
    let mut page = Vec::new();
    let mut bytes = 0;
    for row in tabs.iter().skip(offset) {
        let size = serde_json::to_vec(row)?.len();
        if bytes + size > 48 * 1024 { break }
        bytes += size; page.push(row.clone());
    }
    let end = offset + page.len();
    Ok(json!({"node_id":hub.node_id(),"tabs":page,"next_offset":if end<tabs.len(){Some(end)}else{None}}))
}

fn endpoint_for<'a>(peer: &Peer, endpoints: &'a [Value]) -> Option<&'a Value> {
    let ssh = peer.ssh.as_ref()?;
    let mut matches = endpoints.iter().filter(|endpoint| {
        let Some(host) = endpoint["ssh_host"].as_str() else { return false };
        let same_host = host.rsplit('@').next() == ssh.host.rsplit('@').next();
        let same_user = match (host.rsplit_once('@'),ssh.host.rsplit_once('@')) { (Some((left,_)),Some((right,_))) => left==right, _ => true };
        same_host && same_user && endpoint["ssh_port"].as_u64().unwrap_or(22) == u64::from(ssh.port)
    });
    let first = matches.next()?;
    if matches.next().is_some() { None } else { Some(first) }
}
fn merge_remote(tabs: &mut Vec<Value>, remote: Vec<Value>, endpoint: &Value) {
    for row in remote {
        // A peer may only advertise its own local sessions. Scope comes from the
        // owner's configured SSH endpoint, never a value supplied by the peer.
        if !is_local(&row) { continue }
        let Some(mut row) = sanitized(&row) else { continue };
        row["endpoint_id"] = json!({"kind":"remote","id":endpoint["id"]});
        if let Some(index) = tabs.iter().position(|tab| key(tab) == key(&row)) { tabs[index] = row; }
        else { tabs.push(row); }
    }
}
async fn read_node(hub: &Arc<Hub>, node: &str) -> Result<Vec<Value>> {
    let mut offset = 0;
    let mut tabs = Vec::new();
    loop {
        let page = hub.workspace(node,Command::SessionCatalog { offset }).await?;
        if page["node_id"].as_str() != Some(if node.is_empty(){hub.node_id()}else{node}) { bail!("session catalog belongs to another node") }
        tabs.extend(page["tabs"].as_array().ok_or_else(||anyhow::anyhow!("invalid session catalog"))?.clone());
        match page["next_offset"].as_u64() {
            Some(next) if next as usize > offset && next <= 4096 => offset = next as usize,
            None => break,
            _ => bail!("invalid session catalog pagination"),
        }
    }
    Ok(tabs)
}
pub(super) async fn federated(hub: Arc<Hub>) -> Result<Value> {
    let mut tabs = read_node(&hub,"").await?;
    let index = hub.store.document("session-index")?;
    let endpoints = index.pointer("/value/gui/endpoints").and_then(Value::as_array).cloned().unwrap_or_default();
    // Previously opened remote tabs remain available if a peer is offline.
    for row in index.pointer("/value/gui/tabs").and_then(Value::as_array).into_iter().flatten().filter(|row| !is_local(row)) {
        if endpoints.iter().any(|endpoint| endpoint["id"] == row["endpoint_id"]["id"]) {
            if let Some(mut tab) = sanitized(row) { tab["endpoint_id"] = row["endpoint_id"].clone(); tabs.push(tab); }
        }
    }
    let peers = hub.peers();
    let results = futures_util::future::join_all(peers.iter().filter_map(|peer| endpoint_for(peer,&endpoints).map(|endpoint| (peer,endpoint))).map(|(peer,endpoint)| {
        let hub = &hub;
        async move { (endpoint,tokio::time::timeout(std::time::Duration::from_secs(3),read_node(hub,&peer.node_id)).await) }
    })).await;
    let mut unavailable = Vec::new();
    for (endpoint,result) in results {
        match result { Ok(Ok(remote)) => merge_remote(&mut tabs,remote,endpoint), _ => unavailable.push(endpoint["id"].clone()) }
    }
    Ok(json!({"tabs":tabs,"unavailable_endpoints":unavailable}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_endpoint_mapping_accepts_config_user_but_rejects_ambiguous_hosts() {
        let peer=Peer{node_id:"remote".into(),link_token:"private".into(),url:None,ssh:Some(super::super::SshConfig{host:"server.example".into(),port:2200,remote_port:47981,config_file:None})};
        let endpoint=json!({"id":"remote","ssh_host":"developer@server.example","ssh_port":2200});
        assert_eq!(endpoint_for(&peer,&[endpoint.clone()]).unwrap()["id"],"remote");
        assert!(endpoint_for(&peer,&[endpoint.clone(),endpoint]).is_none());
        assert!(endpoint_for(&peer,&[json!({"ssh_host":"server.example","ssh_port":22})]).is_none());
    }
    #[test]
    fn remote_rows_are_scoped_deduplicated_and_do_not_export_secrets() {
        let row = json!({"backend_key":"codex","session_id":"native-1","cwd":"/srv/project","title":"Helper","workspace_title":"Project","token":"private","env":{"KEY":"private"}});
        let mut tabs = vec![row.clone()];
        let endpoint = json!({"id":"server.example"});
        merge_remote(&mut tabs,vec![row.clone(),row.clone()],&endpoint);
        assert_eq!(tabs.len(),2);
        assert_eq!(tabs[1]["endpoint_id"],json!({"kind":"remote","id":"server.example"}));
        assert_eq!(tabs[1]["workspace_title"],"Project");
        assert!(tabs[1].get("token").is_none());assert!(tabs[1].get("env").is_none());
        let mut foreign = row; foreign["endpoint_id"] = json!({"kind":"remote","id":"another.example"});
        merge_remote(&mut tabs,vec![foreign],&endpoint);assert_eq!(tabs.len(),2);
    }
}
