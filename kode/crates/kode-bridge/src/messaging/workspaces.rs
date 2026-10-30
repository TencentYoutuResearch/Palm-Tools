//! Canonical Kode workspace catalog. Both frontends use this one SQLite document;
//! a workspace belongs to the node that resolves its filesystem path.
use super::Hub;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, sync::Arc};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag="action", rename_all="kebab-case", deny_unknown_fields)]
pub enum Command {
    SessionCatalog { offset: usize },
    List,
    Create { path: String, title: Option<String> },
    Rename { id: String, title: String },
    Delete { id: String },
}
fn stamp() -> String { chrono::DateTime::<chrono::Utc>::from_timestamp_millis(super::model::now() as i64).unwrap().to_rfc3339() }
fn initial() -> Value { json!({"version":2,"tables":{"workspaces":{}},"global":{"initialized":true,"workspaceIds":[],"archivedSessionIds":[],"pinnedSessionIds":[]}}) }
fn state_path() -> Option<std::path::PathBuf> { std::env::var_os("KODE_GUI_STATE_PATH").map(Into::into).or_else(|| dirs::config_dir().map(|path| path.join("kode/state.json"))) }
fn canonical(path: &str) -> Result<String> {
    if path.len()>4096 || !Path::new(path).is_absolute() { bail!("workspace path must be an absolute directory on this node") }
    let path=std::fs::canonicalize(path)?;
    if !path.is_dir() { bail!("workspace path is not a directory") }
    Ok(path.to_string_lossy().into())
}
fn title(value: &str) -> Result<String> { let value=value.trim(); if value.is_empty() || value.len()>512 { bail!("workspace title must contain 1–512 bytes") }; Ok(value.into()) }
fn insert(value: &mut Value, path: String, name: Option<String>) -> Result<String> {
    if let Some((id,_))=value["tables"]["workspaces"].as_object().unwrap().iter().find(|(_,row)| row["path"].as_str()==Some(&path)) { return Ok(id.clone()) }
    let id=uuid::Uuid::new_v4().to_string();
    let name=title(&name.unwrap_or_else(|| Path::new(&path).file_name().unwrap_or_default().to_string_lossy().into()))?;
    let now=stamp();
    value["tables"]["workspaces"][&id]=json!({"path":path,"title":name,"sessionIds":[],"createdAt":now,"updatedAt":now});
    value["global"]["workspaceIds"].as_array_mut().unwrap().insert(0,json!(id));
    Ok(id)
}
pub(super) fn ensure(hub: &Hub) -> Result<Value> {
    let current=hub.store.document("workspaces")?;
    if !current["value"].is_null() { return Ok(current) }
    let mut value=initial();
    // One-time ownership transfer of Kode's existing GUI directory references.
    // There is no runtime state.json fallback once the catalog has been created.
    let index=hub.store.document("session-index")?;
    let legacy=state_path().and_then(|path| std::fs::read(path).ok()).and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).unwrap_or(json!({}));
    let gui=index.pointer("/value/gui").unwrap_or(&legacy);
    let mut paths=Vec::new();
    for tab in gui["tabs"].as_array().into_iter().flatten() {
        if tab["endpoint_id"].is_null() || tab["endpoint_id"]["kind"]=="local" {
            if let Some(path)=tab["cwd"].as_str() { paths.push(path.to_owned()) }
        }
    }
    for path in legacy["cwd_history"]["local"].as_array().into_iter().flatten().filter_map(Value::as_str) { paths.push(path.into()) }
    if let Some(path)=legacy["session_cwd"].as_str() { paths.push(path.into()) }
    let mut unique=HashSet::new();
    for path in paths {
        if path.replace('\\',"/").ends_with("/deepseek-harness/default-workspace") { continue }
        if let Ok(path)=canonical(&path) { if unique.insert(path.clone()) { insert(&mut value,path,None)?; } }
    }
    hub.store.save_document("workspaces",0,value)
}
pub(super) fn validate(value: &Value) -> Result<()> {
    if value["version"]!=2 || value.pointer("/global/initialized")!=Some(&Value::Bool(true)) || !value["tables"]["workspaces"].is_object() || !value["global"]["workspaceIds"].is_array() { bail!("invalid Kode workspace catalog") }
    if value["tables"]["workspaces"].as_object().unwrap().len()>4096 { bail!("workspace catalog is too large") }
    for (id,row) in value["tables"]["workspaces"].as_object().unwrap() {
        if !super::model::valid_id(id) { bail!("invalid workspace identity") }
        let path=row["path"].as_str().ok_or_else(||anyhow::anyhow!("workspace path missing"))?;
        if !Path::new(path).is_absolute() || path.len()>4096 { bail!("workspace path must be absolute") }
        title(row["title"].as_str().unwrap_or(""))?;
        if !row["sessionIds"].is_array() { bail!("workspace membership missing") }
    }
    Ok(())
}
pub(super) fn local(hub: &Hub, command: Command) -> Result<Value> {
    if let Command::SessionCatalog { offset } = command { return super::session_catalog::local(hub,offset) }
    let _gate=hub.gate.lock();
    let stored=ensure(hub)?; let mut value=stored["value"].clone();
    let id=match command {
        Command::SessionCatalog { .. } => unreachable!(),
        Command::List=>None,
        Command::Create{path,title}=>Some(insert(&mut value,canonical(&path)?,title)?),
        Command::Rename{id,title:name}=>{ if value["tables"]["workspaces"].get(&id).is_none(){bail!("workspace not found on this node")};value["tables"]["workspaces"][&id]["title"]=json!(title(&name)?); value["tables"]["workspaces"][&id]["updatedAt"]=json!(stamp());Some(id) },
        Command::Delete{id}=>{value["tables"]["workspaces"].as_object_mut().unwrap().remove(&id);value["global"]["workspaceIds"].as_array_mut().unwrap().retain(|row|row.as_str()!=Some(&id));Some(id)},
    };
    let stored=if value!=stored["value"] { validate(&value)?; hub.store.save_document("workspaces",stored["revision"].as_u64().unwrap(),value.clone())? } else {stored};
    let items=value["global"]["workspaceIds"].as_array().unwrap().iter().filter_map(|id| {let key=id.as_str()?;let row=value["tables"]["workspaces"].get(key)?;let mut row=row.as_object()?.clone();row.insert("id".into(),json!(key));Some(Value::Object(row))}).collect::<Vec<_>>();
    Ok(json!({"node_id":hub.node_id(),"revision":stored["revision"],"workspaces":items,"workspace_id":id}))
}
pub(super) async fn execute(hub: Arc<Hub>, command: Command) -> Result<Value> { tokio::task::spawn_blocking(move || local(&hub,command)).await? }
