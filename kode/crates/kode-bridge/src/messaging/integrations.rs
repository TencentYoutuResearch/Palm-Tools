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
    #[serde(default = "enabled_by_default")]
    pub auto_resume_interrupted: bool,
    #[serde(default)]
    pub session_naming_prompt: String,
}
fn enabled_by_default() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            messaging_enabled: true,
            memory_enabled: true,
            auto_resume_interrupted: true,
            session_naming_prompt: String::new(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub messaging_enabled: Option<bool>,
    pub memory_enabled: Option<bool>,
    pub auto_resume_interrupted: Option<bool>,
    pub session_naming_prompt: Option<String>,
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
    if let Some(enabled) = patch.auto_resume_interrupted {
        value.auto_resume_interrupted = enabled;
    }
    if let Some(prompt) = patch.session_naming_prompt {
        let prompt = prompt.trim();
        if prompt.contains('\0') || prompt.chars().count() > 2000 {
            bail!("会话命名提示词须在 2000 字以内");
        }
        value.session_naming_prompt = prompt.to_owned();
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
fn memory_vault(hub: &Hub) -> Result<Arc<crate::MemoryHandle>> {
    let mut memory = hub.memory.lock();
    if memory.is_none() {
        *memory = crate::MemoryHandle::open();
    }
    memory
        .clone()
        .context("Kode memory vault could not open; check the backend log")
}

fn memory(hub: &Hub) -> Result<Arc<crate::MemoryHandle>> {
    if !settings(hub)?.memory_enabled {
        bail!("Shared memory is disabled in Kode settings")
    }
    memory_vault(hub)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewVerdict {
    Approve,
    EditThenApprove {
        body: Option<String>,
        tags: Option<Vec<String>>,
        scope: Option<String>,
        confidence: Option<f32>,
        #[serde(default)]
        related: Option<Vec<String>>,
        #[serde(default)]
        contradicts: Option<Vec<String>>,
        #[serde(default)]
        title: Option<String>,
    },
    Reject {
        reason: String,
    },
    Blacklist {
        reason: String,
    },
}

impl ReviewVerdict {
    fn into_verdict(self) -> Result<kode_memory::store::Verdict> {
        Ok(match self {
            Self::Approve => kode_memory::store::Verdict::Approve,
            Self::EditThenApprove {
                body,
                tags,
                scope,
                confidence,
                related,
                contradicts,
                title,
            } => kode_memory::store::Verdict::EditThenApprove {
                body,
                tags,
                scope: scope
                    .as_deref()
                    .map(kode_memory::Scope::parse)
                    .transpose()?,
                confidence,
                related,
                contradicts,
                title: title
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            },
            Self::Reject { reason } => kode_memory::store::Verdict::Reject { reason },
            Self::Blacklist { reason } => kode_memory::store::Verdict::Blacklist { reason },
        })
    }
}

/// Owner-only pending queue + stats + author energy snapshot (shared by dsh and remote frontends).
pub async fn memory_pending(hub: &Hub) -> Result<Value> {
    let mem = memory_vault(hub)?;
    let (mut pending, facts_count) = {
        let store = mem.store.lock().await;
        (store.list_pending()?, store.count()?)
    };
    pending.sort_by(|a, b| b.meta.created.cmp(&a.meta.created));
    let max_energy = kode_memory::budget::MAX_ENERGY;
    let (items, energy_by_author) = {
        let mut budget = mem.budget.lock().await;
        let items: Vec<Value> = pending
            .into_iter()
            .map(|p| {
                let energy = budget.current_energy(&p.meta.author);
                json!({
                    "id": p.meta.id,
                    "title": p.meta.title,
                    "author": p.meta.author,
                    "session": p.meta.session,
                    "scope": p.meta.scope,
                    "created": p.meta.created,
                    "confidence": p.meta.confidence,
                    "tags": p.meta.tags,
                    "kind": p.meta.kind.as_str(),
                    "subsystem": p.meta.subsystem,
                    "supersedes": p.meta.supersedes,
                    "related": p.meta.related,
                    "contradicts": p.meta.contradicts,
                    "body": p.body,
                    "rationale": p.rationale,
                    "author_energy": energy,
                    "max_energy": max_energy,
                })
            })
            .collect();
        let energy_by_author: Vec<Value> = budget
            .iter_authors()
            .into_iter()
            .map(|(author, energy)| json!({"author": author, "energy": energy, "max": max_energy}))
            .collect();
        (items, energy_by_author)
    };
    Ok(json!({
        "pending": items,
        "stats": {
            "pending": items.len(),
            "facts": facts_count,
            "root": mem.root.display().to_string(),
        },
        "max_energy": max_energy,
        "energy_by_author": energy_by_author,
    }))
}

/// Owner-only review action; updates author budget and triggers best-effort git sync on approve.
pub async fn memory_review(hub: &Hub, id: &str, verdict: ReviewVerdict) -> Result<Value> {
    let mem = memory_vault(hub)?;
    let verdict = verdict.into_verdict()?;
    let (outcome, author) = {
        let mut store = mem.store.lock().await;
        let pending = store.read_pending(id)?;
        let author = pending.meta.author.clone();
        let outcome = store.review(id, verdict)?;
        (outcome, author)
    };
    let max_energy = kode_memory::budget::MAX_ENERGY;
    let energy = {
        let mut budget = mem.budget.lock().await;
        match outcome {
            kode_memory::store::ReviewOutcome::Approved => {
                let _ = budget.add(&author, kode_memory::budget::REWARD_APPROVE);
            }
            kode_memory::store::ReviewOutcome::Rejected => {
                let _ = budget.penalize(&author, kode_memory::budget::PENALTY_REJECT);
            }
            kode_memory::store::ReviewOutcome::Blacklisted => {
                let _ = budget.penalize(&author, kode_memory::budget::PENALTY_BLACKLIST);
            }
        }
        budget.current_energy(&author)
    };
    let remaining_pending = mem.store.lock().await.count_pending()?;
    if matches!(outcome, kode_memory::store::ReviewOutcome::Approved) {
        let root = mem.root.clone();
        let id2 = id.to_owned();
        tokio::spawn(async move {
            if kode_memory::git_sync::is_enabled(&root) {
                let _ = kode_memory::git_sync::commit_and_push(
                    &root,
                    &format!("kode-memory: approve {id2}"),
                );
            }
        });
    }
    Ok(json!({
        "outcome": match outcome {
            kode_memory::store::ReviewOutcome::Approved => "approved",
            kode_memory::store::ReviewOutcome::Rejected => "rejected",
            kode_memory::store::ReviewOutcome::Blacklisted => "blacklisted",
        },
        "author": author,
        "author_energy": energy,
        "max_energy": max_energy,
        "remaining_pending": remaining_pending,
    }))
}

/// Owner-only approved facts browse/search endpoint.
pub async fn memory_facts(
    hub: &Hub,
    query: Option<&str>,
    scope: Option<&str>,
    limit: usize,
) -> Result<Value> {
    let mem = memory_vault(hub)?;
    let store = mem.store.lock().await;
    let limit = limit.clamp(1, 100);
    let q = query.map(str::trim).filter(|s| !s.is_empty());
    let scope = scope.map(str::trim).filter(|s| !s.is_empty());
    let hits = if let Some(q) = q {
        store.search_with_opts(&kode_memory::store::SearchOpts {
            query: q,
            top_k: limit,
            scope,
            kinds: vec![],
            subsystem: None,
            include_deprecated: false,
            current_path: None,
        })?
    } else {
        let mut rows = store.list_recent(scope, 24 * 365)?;
        rows.truncate(limit);
        rows
    };
    let scopes = store.distinct_scopes()?;
    let total = store.count()?;
    Ok(json!({
        "facts": hits,
        "scopes": scopes,
        "total": total,
    }))
}

/// Owner-only soft deprecation of an approved fact.
pub async fn memory_deprecate(hub: &Hub, id: &str, reason: &str) -> Result<Value> {
    let mem = memory_vault(hub)?;
    let reason = if reason.trim().is_empty() {
        "(deprecated by owner)"
    } else {
        reason.trim()
    };
    let mut store = mem.store.lock().await;
    store.deprecate(id, reason)?;
    Ok(json!({ "ok": true }))
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
            Ok(json!({
                "author": source,
                "energy": budget.current_energy(source),
                "max": kode_memory::budget::MAX_ENERGY,
            }))
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
            let outcome = match store.propose(
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
            ) {
                Ok(outcome) => outcome,
                Err(err) => {
                    let _ = budget.add(source, kode_memory::budget::COST_PROPOSE);
                    return Err(err);
                }
            };
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
                memory_enabled: false,
                ..Settings::default()
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
                auto_resume_interrupted: Some(false),
                ..Change::default()
            },
        )
        .unwrap();
        assert!(!patched.messaging_enabled);
        assert!(!patched.memory_enabled);
        assert!(!patched.auto_resume_interrupted);
        let patched = change(
            &reopened,
            Change {
                memory_enabled: Some(true),
                ..Change::default()
            },
        )
        .unwrap();
        assert!(!patched.messaging_enabled);
        assert!(patched.memory_enabled);
    }

    #[tokio::test]
    async fn owner_memory_review_and_facts_workflow() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = crate::build_test_ctx(Default::default(), "admin-secret".into());
        let hub = Hub::open(
            super::super::Config {
                node_id: "memory-review-test".into(),
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

        // Propose two items as an agent session
        let p1 = tool(
            &hub,
            "session-a",
            "memory_propose",
            json!({
                "scope": "shared",
                "title": "Use serial reset",
                "body": "Always cycle power after changing UART baud rate.",
                "tags": ["uart", "hardware"],
                "rationale": "Verified on device M4"
            }),
        )
        .await
        .unwrap();
        let id1 = p1["id"].as_str().unwrap().to_string();

        let p2 = tool(
            &hub,
            "session-a",
            "memory_propose",
            json!({
                "scope": "shared",
                "body": "Temporary debug note that should be rejected.",
                "tags": ["tmp"]
            }),
        )
        .await
        .unwrap();
        let id2 = p2["id"].as_str().unwrap().to_string();

        // Pending list includes both items and energy snapshot
        let pending = memory_pending(&hub).await.unwrap();
        assert_eq!(pending["stats"]["pending"], 2);
        assert_eq!(pending["max_energy"], kode_memory::budget::MAX_ENERGY);
        assert_eq!(pending["pending"].as_array().unwrap().len(), 2);

        // Edit & Approve p1: refunds full COST_PROPOSE (REWARD_APPROVE == 1.0)
        let approved = memory_review(
            &hub,
            &id1,
            ReviewVerdict::EditThenApprove {
                title: Some("Cycle UART power".into()),
                body: Some("Always cycle power after changing UART baud rate on M4.".into()),
                tags: Some(vec!["uart".into(), "m4".into()]),
                scope: None,
                confidence: Some(0.9),
                related: None,
                contradicts: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(approved["outcome"], "approved");
        assert_eq!(approved["remaining_pending"], 1);
        let expected_after_approve =
            kode_memory::budget::MAX_ENERGY - 2.0 * kode_memory::budget::COST_PROPOSE
                + kode_memory::budget::REWARD_APPROVE;
        assert!(
            (approved["author_energy"].as_f64().unwrap() as f32 - expected_after_approve).abs()
                < 0.05
        );

        // Reject p2: penalizes PENALTY_REJECT
        let rejected = memory_review(
            &hub,
            &id2,
            ReviewVerdict::Reject {
                reason: "Too ephemeral".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(rejected["outcome"], "rejected");
        assert_eq!(rejected["remaining_pending"], 0);
        let expected_after_reject = expected_after_approve - kode_memory::budget::PENALTY_REJECT;
        assert!(
            (rejected["author_energy"].as_f64().unwrap() as f32 - expected_after_reject).abs()
                < 0.05
        );

        // Approved fact is searchable & listed via memory_facts, then deprecable
        let facts = memory_facts(&hub, Some("UART"), None, 20).await.unwrap();
        assert_eq!(facts["facts"].as_array().unwrap().len(), 1);
        assert_eq!(facts["facts"][0]["id"], id1);

        memory_deprecate(&hub, &id1, "Superseded by auto-baud")
            .await
            .unwrap();
        let after_dep = memory_facts(&hub, Some("UART"), None, 20).await.unwrap();
        assert!(after_dep["facts"].as_array().unwrap().is_empty());

        // HTTP routes reject unauthenticated and session-only tokens, allow admin token
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = hub.router();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let http = reqwest::Client::new();
        let base = format!("http://{addr}");

        let unauth = http
            .get(format!("{base}/api/v1/messaging/memory/pending"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);

        let reg = http
            .post(format!("{base}/api/v1/messaging/sessions"))
            .bearer_auth("admin-secret")
            .json(&json!({"session_id": "agent-1", "title": "Agent", "runtime": "dsh"}))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let session_token = reg["owner_token"].as_str().unwrap();

        let forbidden = http
            .get(format!("{base}/api/v1/messaging/memory/pending"))
            .bearer_auth(session_token)
            .send()
            .await
            .unwrap();
        assert_eq!(forbidden.status(), reqwest::StatusCode::FORBIDDEN);

        let admin_ok = http
            .get(format!("{base}/api/v1/messaging/memory/pending"))
            .bearer_auth("admin-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(admin_ok.status(), reqwest::StatusCode::OK);
        server.abort();
    }
}
