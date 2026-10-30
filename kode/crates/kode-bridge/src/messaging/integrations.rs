//! Shared feature policy. Agent credentials may use enabled tools, while only
//! the owner can change policy or review proposals.
use super::Hub;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub messaging_enabled: bool,
    pub memory_enabled: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            messaging_enabled: true,
            memory_enabled: true,
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub messaging_enabled: Option<bool>,
    pub memory_enabled: Option<bool>,
}
pub fn change(hub: &Hub, patch: Change) -> Result<Settings> {
    let _gate = hub.gate.lock();
    let mut value = settings(hub)?;
    if let Some(enabled) = patch.messaging_enabled {
        value.messaging_enabled = enabled;
    }
    if let Some(enabled) = patch.memory_enabled {
        value.memory_enabled = enabled;
    }
    let row = hub.store.document("integrations")?;
    hub.store.save_document(
        "integrations",
        row["revision"].as_u64().unwrap_or(0),
        serde_json::to_value(&value)?,
    )?;
    Ok(value)
}
pub fn settings(hub: &Hub) -> Result<Settings> {
    let row = hub.store.document("integrations")?;
    if row["value"].is_null() {
        Ok(Settings::default())
    } else {
        Ok(serde_json::from_value(row["value"].clone())?)
    }
}
pub fn configure(hub: &Hub, value: Settings) -> Result<Settings> {
    let _gate = hub.gate.lock();
    let row = hub.store.document("integrations")?;
    hub.store.save_document(
        "integrations",
        row["revision"].as_u64().unwrap_or(0),
        serde_json::to_value(&value)?,
    )?;
    Ok(value)
}
fn memory(hub: &Hub) -> Result<Arc<crate::MemoryHandle>> {
    if !settings(hub)?.memory_enabled {
        bail!("Shared memory is disabled in Kode settings")
    }
    let mut memory = hub.memory.lock();
    if memory.is_none() {
        *memory = crate::MemoryHandle::open();
    }
    memory
        .clone()
        .context("Kode memory vault could not open; check the backend log")
}

pub async fn tool(hub: &Hub, source: &str, name: &str, args: Value) -> Result<Value> {
    let memory = memory(hub)?;
    let required = |key: &str| {
        args[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("{key} is required"))
    };
    match name {
        "memory_search" => {
            let store = memory.store.lock().await;
            Ok(
                json!({"hits":store.search(required("query")?,args["scope"].as_str(),args["top_k"].as_u64().unwrap_or(10).clamp(1,100) as usize,false)?}),
            )
        }
        "memory_read" => {
            let store = memory.store.lock().await;
            Ok(serde_json::to_value(
                store.read_with_backlinks(required("id")?)?,
            )?)
        }
        "memory_list_recent" => {
            let store = memory.store.lock().await;
            let mut hits = store.list_recent(
                args["scope"].as_str(),
                args["since_hours"]
                    .as_u64()
                    .unwrap_or(24 * 30)
                    .min(24 * 365),
            )?;
            hits.truncate(args["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize);
            Ok(json!({"hits":hits}))
        }
        "memory_budget_status" => {
            let mut budget = memory.budget.lock().await;
            Ok(json!({"author":source,"energy":budget.current_energy(source),"max":5.0}))
        }
        "memory_propose" => {
            let scope = kode_memory::Scope::parse(required("scope")?)?;
            let body = required("body")?;
            if body.len() > 6000 {
                bail!("Memory proposal is too long (maximum 6000 bytes)")
            }
            let tags: Vec<String> =
                serde_json::from_value(args.get("tags").cloned().unwrap_or(json!([])))?;
            if tags.len() > 50 {
                bail!("Too many memory tags")
            }
            let kind = args["kind"]
                .as_str()
                .map(kode_memory::Kind::parse)
                .transpose()?;
            let mut budget = memory.budget.lock().await;
            let remaining = budget
                .try_charge(source, kode_memory::budget::COST_PROPOSE)
                .map_err(|e| anyhow::anyhow!("Memory proposal budget exhausted: {e}"))?;
            let mut store = memory.store.lock().await;
            let outcome = store.propose(
                source,
                Some(source),
                scope,
                body,
                tags,
                args["supersedes"].as_str().map(Into::into),
                args["confidence"].as_f64().map(|v| v as f32),
                args["rationale"].as_str().map(Into::into),
                args["force"].as_bool().unwrap_or(false),
                kind,
                args["title"].as_str().map(Into::into),
            )?;
            Ok(match outcome {
                kode_memory::store::ProposeResult::Accepted { id } => {
                    json!({"ok":true,"id":id,"energy_remaining":remaining,"status":"pending_review"})
                }
                kode_memory::store::ProposeResult::Duplicate(info) => {
                    let _ = budget.add(source, kode_memory::budget::COST_PROPOSE);
                    json!({"error":"duplicate","existing_id":info.existing_id,"candidates":info.candidates})
                }
                kode_memory::store::ProposeResult::BodyTooLong { len, max } => {
                    let _ = budget.add(source, kode_memory::budget::COST_PROPOSE);
                    json!({"error":"body_too_long","len":len,"max":max})
                }
            })
        }
        _ => bail!("Unknown Agent memory tool; review operations are owner-only"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn memory_uses_backend_vault_binds_author_and_requires_review() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = crate::build_test_ctx(Default::default(), "test".into());
        let hub = Hub::open(
            super::super::Config {
                node_id: "memory-test".into(),
                database: dir.path().join("backend.sqlite"),
                peers: vec![],
            },
            &ctx,
        )
        .unwrap();
        let root = dir.path().join("memory");
        *hub.memory.lock() = Some(Arc::new(crate::MemoryHandle {
            root: root.clone(),
            store: tokio::sync::Mutex::new(kode_memory::MemoryStore::open(&root).unwrap()),
            budget: tokio::sync::Mutex::new(kode_memory::budget::BudgetStore::open(&root).unwrap()),
        }));
        let proposed=tool(&hub,"session-author","memory_propose",json!({"scope":"shared","body":"Restart the device after changing the serial baud rate.","author":"forged-author"})).await.unwrap();
        assert_eq!(proposed["status"], "pending_review");
        let found = tool(&hub, "reader", "memory_search", json!({"query":"baud"}))
            .await
            .unwrap();
        assert!(found["hits"].as_array().unwrap().is_empty());
        let memory = hub.memory.lock().clone().unwrap();
        let pending = memory
            .store
            .lock()
            .await
            .read_pending(proposed["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(pending.meta.author, "session-author");
        assert!(tool(
            &hub,
            "session-author",
            "memory_review",
            json!({"id":proposed["id"]})
        )
        .await
        .is_err());
        configure(
            &hub,
            Settings {
                messaging_enabled: true,
                memory_enabled: false,
            },
        )
        .unwrap();
        assert!(
            tool(&hub, "reader", "memory_search", json!({"query":"baud"}))
                .await
                .unwrap_err()
                .to_string()
                .contains("disabled")
        );
        drop(hub);
        let reopened = Hub::open(
            super::super::Config {
                node_id: "memory-test".into(),
                database: dir.path().join("backend.sqlite"),
                peers: vec![],
            },
            &ctx,
        )
        .unwrap();
        assert!(!settings(&reopened).unwrap().memory_enabled);
        let patched = change(
            &reopened,
            Change {
                messaging_enabled: Some(false),
                memory_enabled: None,
            },
        )
        .unwrap();
        assert!(!patched.messaging_enabled);
        assert!(!patched.memory_enabled);
        let patched = change(
            &reopened,
            Change {
                messaging_enabled: None,
                memory_enabled: Some(true),
            },
        )
        .unwrap();
        assert!(!patched.messaging_enabled);
        assert!(patched.memory_enabled);
    }
}
