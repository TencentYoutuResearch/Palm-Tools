//! Resource checks run inside the same transaction as lease claims/renewals.
use super::{
    model::*,
    operations::{Operation, State},
    quota::Sample,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownQuota {
    RequireFresh,
    TeamBudget,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Acknowledgement {
    pub profile: String,
    pub account_epoch: u64,
    pub binding_revision: u64,
}
impl Acknowledgement {
    pub(super) fn validate(&self) -> Result<()> {
        if !valid_id(&self.profile) || self.account_epoch == 0 || self.binding_revision == 0 {
            bail!("invalid resource acknowledgement")
        }
        Ok(())
    }
}
pub(super) fn acknowledge(op: &Operation, ack: &Acknowledgement) -> Result<()> {
    ack.validate()?;
    let p = op
        .resource
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("resource assignment missing"))?;
    if !op.resource_required
        || ack.profile != p.profile
        || ack.account_epoch != p.account_epoch
        || ack.binding_revision != p.binding_revision
    {
        bail!("resource acknowledgement mismatch")
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub host: String,
    pub profile: String,
    pub account_id: String,
    pub account_epoch: u64,
    pub binding_revision: u64,
    pub limit_ids: Vec<String>,
    pub unknown_quota: UnknownQuota,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub monetary: Vec<super::monetary_admission::Requirement>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Decision {
    pub allowed: bool,
    pub reason: String,
    pub requires_team_budget: bool,
    pub valid_until_ms: Option<u64>,
}
impl Policy {
    pub(super) fn validate(&self) -> Result<()> {
        let unique: std::collections::HashSet<_> = self.limit_ids.iter().collect();
        if [&self.host, &self.profile, &self.account_id]
            .iter()
            .any(|s| !valid_id(s))
            || self.account_epoch == 0
            || self.binding_revision == 0
            || (self.limit_ids.is_empty() && self.monetary.is_empty() && self.unknown_quota != UnknownQuota::TeamBudget)
            || self.monetary.len() > 3
            || self.limit_ids.len() > 128
            || unique.len() != self.limit_ids.len()
            || self.limit_ids.iter().any(|s| !valid_id(s))
        {
            bail!("invalid resource admission policy")
        }
        let mut sources = std::collections::HashSet::new();
        for requirement in &self.monetary {
            requirement.validate()?;
            if !sources.insert(&requirement.source) {
                bail!("duplicate monetary source")
            }
        }
        Ok(())
    }
}
fn decision(allowed: bool, reason: &str, budget: bool, until: Option<u64>) -> Decision {
    Decision {
        allowed,
        reason: reason.into(),
        requires_team_budget: budget,
        valid_until_ms: until,
    }
}
pub(super) fn evaluate(db: &Connection, p: &Policy, at: u64) -> Result<Decision> {
    p.validate()?;
    let binding:Option<(String,u64,u64,u64,bool)>=db.query_row("SELECT b.account_id,b.account_epoch,b.revision,a.epoch,(b.enabled AND a.enabled) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile=?2",params![p.host,p.profile],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    if binding
        != Some((
            p.account_id.clone(),
            p.account_epoch,
            p.binding_revision,
            p.account_epoch,
            true,
        ))
    {
        return Ok(decision(false, "binding_unavailable", false, None));
    }
    if p.limit_ids.is_empty() && p.monetary.is_empty() {
        // Explicit budget-only admission must not invent a quota window or ignore known exhaustion.
        let known = super::quota_evidence::view(db, &p.host, &p.profile, p.binding_revision, at)?;
        if known["windows"].as_array().is_some_and(|rows| !rows.is_empty()) {
            return Ok(decision(false, "provider_exhausted", false, None));
        }
        return Ok(decision(true, "unknown_requires_team_budget", true, None));
    }
    let money = super::monetary_admission::evaluate(db, p, at)?;
    if let Some(reason) = money.denial {
        return Ok(decision(false, &reason, false, None));
    }
    for limit in &p.limit_ids {
        if super::quota_evidence::exhausted(db, &p.host, &p.profile, p.binding_revision, limit, at)?
        {
            return Ok(decision(false, "provider_exhausted", false, None));
        }
    }
    let body: Option<String> = db
        .query_row(
            "SELECT body FROM quota_snapshots WHERE host=?1 AND profile=?2 AND binding_revision=?3",
            params![p.host, p.profile, p.binding_revision],
            |r| r.get(0),
        )
        .optional()?;
    let sample = body
        .map(|s| serde_json::from_str::<Sample>(&s))
        .transpose()?;
    let mut complete = money.complete
        && (p.limit_ids.is_empty()
            || sample
                .as_ref()
                .is_some_and(|s| !s.truncated && s.observed_at_ms <= at));
    let mut until = money.until;
    for id in &p.limit_ids {
        let bucket = sample
            .as_ref()
            .and_then(|s| s.buckets.iter().find(|b| &b.limit_id == id));
        let Some(bucket) = bucket else {
            complete = false;
            continue;
        };
        if bucket.windows.is_empty() {
            complete = false
        }
        for w in &bucket.windows {
            if bucket.observed_at_ms > at
                || bucket.valid_until_ms <= at
                || w.used_percent.is_none()
                || w.window_minutes.is_none()
                || w.resets_at_ms.is_none_or(|reset| reset <= at)
            {
                complete = false
            }
            until = until
                .min(bucket.valid_until_ms)
                .min(w.resets_at_ms.unwrap_or(0));
        }
    }
    if complete {
        return Ok(decision(true, "fresh_quota", false, Some(until)));
    }
    let budget = p.unknown_quota == UnknownQuota::TeamBudget;
    Ok(decision(
        budget,
        if budget {
            "unknown_requires_team_budget"
        } else {
            "fresh_quota_required"
        },
        budget,
        None,
    ))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attach {
    pub attempt: u64,
    pub expected_revision: u64,
    pub policy: Policy,
}
pub(super) fn admit(db: &Connection, op: &Operation, at: u64) -> Result<Decision> {
    let body: String = db.query_row(
        "SELECT body FROM operation_resource_bindings WHERE operation_id=?1 AND attempt=?2",
        params![op.id, op.attempt],
        |r| r.get(0),
    )?;
    let policy: Policy = serde_json::from_str(&body)?;
    let d = evaluate(db, &policy, at)?;
    if !d.allowed || d.requires_team_budget && !op.budget_required {
        bail!("resource admission denied: {}", d.reason)
    }
    Ok(d)
}
impl Store {
    pub(super) fn operation_resource(&self, id: &str, attempt: u64) -> Result<Option<Policy>> {
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT body FROM operation_resource_bindings WHERE operation_id=?1 AND attempt=?2",
                params![id, attempt],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub fn resource_admission(&self, policy: &Policy, at: u64) -> Result<Decision> {
        evaluate(&self.db.lock(), policy, at)
    }
    pub fn attach_operation_resource(&self, id: &str, input: Attach) -> Result<Operation> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = attach_in(&tx, id, input)?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{
        operations::{Action, Command},
        quota::{Bucket, Window},
        resources::{AccountCommand, BindingCommand},
    };
    fn policy() -> Policy {
        Policy {
            host: "home".into(),
            profile: "worker".into(),
            account_id: "account".into(),
            account_epoch: 1,
            binding_revision: 1,
            limit_ids: vec!["tokens".into()],
            monetary: vec![],
            unknown_quota: UnknownQuota::RequireFresh,
        }
    }
    fn sample() -> Sample {
        Sample {
            host: "home".into(),
            profile: "worker".into(),
            account_id: "account".into(),
            account_epoch: 1,
            binding_revision: 1,
            observed_at_ms: 1000,
            truncated: false,
            buckets: vec![Bucket {
                limit_id: "tokens".into(),
                observed_at_ms: 1000,
                valid_until_ms: 6000,
                windows: vec![Window {
                    window_id: "primary".into(),
                    used_percent: Some(20.0),
                    resets_at_ms: Some(10000),
                    window_minutes: Some(60),
                }],
            }],
        }
    }
    fn setup(store: &Store) {
        store
            .change_resource_account(AccountCommand {
                id: "account".into(),
                expected_epoch: 0,
                enabled: true,
            })
            .unwrap();
        store
            .bind_resource_account(BindingCommand {
                host: "home".into(),
                profile: "worker".into(),
                account_id: "account".into(),
                account_epoch: 1,
                expected_revision: 0,
            })
            .unwrap();
    }
    #[test]
    fn explicit_budget_only_policy_does_not_invent_capacity_or_ignore_exhaustion() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("resources.sqlite"), "home").unwrap();
        setup(&store);
        let mut p = policy();
        p.limit_ids.clear();
        assert!(store.resource_admission(&p, 1000).is_err());
        p.unknown_quota = UnknownQuota::TeamBudget;
        let result = store.resource_admission(&p, 1000).unwrap();
        assert!(result.allowed && result.requires_team_budget);
        assert_eq!(result.reason, "unknown_requires_team_budget");
        assert_eq!(result.valid_until_ms, None);
        let mut exhausted = sample();
        exhausted.buckets[0].windows[0].used_percent = Some(100.0);
        store.record_quota(exhausted, 1000).unwrap();
        assert_eq!(store.resource_admission(&p, 1000).unwrap().reason, "provider_exhausted");
        assert!(!store.resource_admission(&p, 1000).unwrap().allowed);
    }
    #[test]
    fn unknown_stale_reset_and_exhausted_are_distinct_from_fresh_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("resources.sqlite"), "home").unwrap();
        assert_eq!(
            store.resource_admission(&policy(), 1000).unwrap().reason,
            "binding_unavailable"
        );
        setup(&store);
        assert!(!store.resource_admission(&policy(), 1000).unwrap().allowed);
        let budget = Policy {
            unknown_quota: UnknownQuota::TeamBudget,
            ..policy()
        };
        assert!(
            store
                .resource_admission(&budget, 1000)
                .unwrap()
                .requires_team_budget
        );
        store.record_quota(sample(), 1000).unwrap();
        let fresh = store.resource_admission(&policy(), 1000).unwrap();
        assert!(fresh.allowed);
        assert_eq!(fresh.valid_until_ms, Some(6000));
        assert!(!store.resource_admission(&policy(), 6000).unwrap().allowed);
        let mut full = sample();
        full.observed_at_ms = 2000;
        full.buckets[0].observed_at_ms = 2000;
        full.buckets[0].windows[0].used_percent = Some(100.0);
        store.record_quota(full, 2000).unwrap();
        assert_eq!(
            store.resource_admission(&budget, 7000).unwrap().reason,
            "provider_exhausted",
            "TTL expiry cannot imply refill"
        );
        assert_eq!(
            store.resource_admission(&budget, 10000).unwrap().reason,
            "unknown_requires_team_budget",
            "reset is not a fresh balance"
        );
        let missing = Policy {
            limit_ids: vec!["unobserved".into()],
            ..policy()
        };
        assert!(!store.resource_admission(&missing, 3000).unwrap().allowed);
        store
            .change_resource_account(AccountCommand {
                id: "account".into(),
                expected_epoch: 1,
                enabled: false,
            })
            .unwrap();
        assert_eq!(
            store.resource_admission(&budget, 3000).unwrap().reason,
            "binding_unavailable"
        );
    }
    #[test]
    fn exhaustion_survives_missing_samples_restart_and_v11_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("evidence.sqlite");
        let store = Store::open(&path, "home").unwrap();
        setup(&store);
        let budget = Policy {
            unknown_quota: UnknownQuota::TeamBudget,
            ..policy()
        };
        let mut full = sample();
        full.buckets[0].windows[0].used_percent = Some(100.0);
        store.record_quota(full, 1000).unwrap();
        let mut missing = sample();
        missing.observed_at_ms = 2000;
        missing.buckets.clear();
        store.record_quota(missing, 2000).unwrap();
        assert_eq!(
            store.resource_admission(&budget, 7000).unwrap().reason,
            "provider_exhausted"
        );
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(
            store.resource_admission(&budget, 7000).unwrap().reason,
            "provider_exhausted"
        );
        // Reconstruct from v11 audit: its latest snapshot has already lost the window.
        store
            .db
            .lock()
            .execute_batch("DROP TABLE official_call_events;DROP TABLE official_calls;DROP TABLE quota_window_evidence; DROP INDEX event_source_cursor; DROP INDEX event_target_cursor; PRAGMA user_version=11;")
            .unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(
            store.resource_admission(&budget, 7000).unwrap().reason,
            "provider_exhausted"
        );
        assert_eq!(
            store.resource_admission(&budget, 10000).unwrap().reason,
            "unknown_requires_team_budget"
        );
        assert!(!store.resource_admission(&policy(), 10000).unwrap().allowed);
    }

    #[test]
    fn only_newer_affirmative_window_evidence_clears_exhaustion() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("ordering.sqlite"), "home").unwrap();
        setup(&store);
        let budget = Policy {
            unknown_quota: UnknownQuota::TeamBudget,
            ..policy()
        };
        let mut full = sample();
        full.observed_at_ms = 2000;
        full.buckets[0].observed_at_ms = 2000;
        full.buckets[0].windows[0].used_percent = Some(100.0);
        store.record_quota(full.clone(), 2000).unwrap();
        let mut older = sample();
        older.observed_at_ms = 3000;
        store.record_quota(older, 3000).unwrap();
        assert_eq!(
            store.resource_admission(&budget, 3000).unwrap().reason,
            "provider_exhausted"
        );
        let mut unknown = full.clone();
        unknown.observed_at_ms = 4000;
        unknown.buckets[0].observed_at_ms = 4000;
        unknown.buckets[0].windows[0].used_percent = None;
        store.record_quota(unknown, 4000).unwrap();
        assert_eq!(
            store.resource_admission(&budget, 4000).unwrap().reason,
            "provider_exhausted"
        );
        let mut conflict = full.clone();
        conflict.observed_at_ms = 4500;
        conflict.buckets[0].windows[0].used_percent = Some(20.0);
        assert!(store.record_quota(conflict, 4500).is_err());
        let mut recovered = sample();
        recovered.observed_at_ms = 5000;
        recovered.buckets[0].observed_at_ms = 5000;
        store.record_quota(recovered, 5000).unwrap();
        assert!(store.resource_admission(&budget, 5000).unwrap().allowed);
        full.observed_at_ms = 5500;
        store.record_quota(full, 5500).unwrap();
        assert!(
            store.resource_admission(&budget, 7000).unwrap().allowed,
            "an older exhausted window cannot replace newer recovery evidence"
        );
    }

    #[test]
    fn frozen_resource_policy_caps_lease_and_new_exhaustion_revokes_renewal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lease.sqlite");
        let store = Store::open(&path, "home").unwrap();
        setup(&store);
        store.record_quota(sample(), 1000).unwrap();
        let op = store
            .prepare_managed_operation(
                "owner",
                "key",
                Address {
                    node_id: "home".into(),
                    session_id: "worker".into(),
                },
                false,
                true,
            )
            .unwrap();
        assert!(store
            .prepare_operation("owner", "key", op.worker.clone())
            .is_err());
        let command = |op: &Operation, action| Command {
            selection_ack: None,
            attempt: op.attempt,
            epoch: op.epoch,
            expected_revision: op.revision,
            action,
        };
        assert!(store
            .command_operation(
                &op.id,
                command(&op, Action::Claim { lease_ms: 60000 }),
                1000
            )
            .is_err());
        assert!(store
            .attach_operation_resource(
                &op.id,
                Attach {
                    attempt: 1,
                    expected_revision: 1,
                    policy: Policy {
                        unknown_quota: UnknownQuota::TeamBudget,
                        ..policy()
                    }
                }
            )
            .is_err());
        let op = store
            .attach_operation_resource(
                &op.id,
                Attach {
                    attempt: 1,
                    expected_revision: 1,
                    policy: policy(),
                },
            )
            .unwrap();
        assert!(store
            .command_operation(
                &op.id,
                command(&op, Action::Claim { lease_ms: 60000 }),
                1000
            )
            .unwrap_err()
            .to_string()
            .contains("acknowledgement required"));
        assert!(store
            .command_operation(
                &op.id,
                command(
                    &op,
                    Action::ClaimResource {
                        lease_ms: 60000,
                        resource: Acknowledgement {
                            profile: "worker".into(),
                            account_epoch: 1,
                            binding_revision: 2
                        }
                    }
                ),
                1000
            )
            .unwrap_err()
            .to_string()
            .contains("acknowledgement mismatch"));
        assert_eq!(
            store.operation(&op.id).unwrap().unwrap().revision,
            op.revision
        );
        let active = store
            .command_operation(
                &op.id,
                command(
                    &op,
                    Action::ClaimResource {
                        lease_ms: 60000,
                        resource: Acknowledgement {
                            profile: "worker".into(),
                            account_epoch: 1,
                            binding_revision: 1,
                        },
                    },
                ),
                1000,
            )
            .unwrap()
            .operation;
        assert_eq!(active.lease_until, Some(6000));
        assert_eq!(active.resource.as_ref().unwrap().profile, "worker");
        assert!(store
            .command_operation(
                &op.id,
                command(&active, Action::Renew { lease_ms: 60000 }),
                1500
            )
            .is_err());
        let active = store
            .command_operation(
                &op.id,
                command(
                    &active,
                    Action::RenewResource {
                        lease_ms: 60000,
                        resource: Acknowledgement {
                            profile: "worker".into(),
                            account_epoch: 1,
                            binding_revision: 1,
                        },
                    },
                ),
                1500,
            )
            .unwrap()
            .operation;
        assert_eq!(active.lease_until, Some(6000));
        let mut full = sample();
        full.observed_at_ms = 2000;
        full.buckets[0].observed_at_ms = 2000;
        full.buckets[0].windows[0].used_percent = Some(100.0);
        store.record_quota(full, 2000).unwrap();
        assert!(store
            .command_operation(
                &op.id,
                command(
                    &active,
                    Action::RenewResource {
                        lease_ms: 60000,
                        resource: Acknowledgement {
                            profile: "worker".into(),
                            account_epoch: 1,
                            binding_revision: 1
                        }
                    }
                ),
                2000
            )
            .is_err());
        assert!(store
            .operation_events(&op.id, 0)
            .unwrap()
            .iter()
            .any(|e| e["data"]["resource_decision"]["reason"] == "fresh_quota"));
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(
            store.operation(&op.id).unwrap().unwrap().resource_available,
            Some(false)
        );
    }
    #[test]
    fn v10_operations_migrate_without_retroactive_resource_requirement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let op = store
            .prepare_operation(
                "owner",
                "legacy",
                Address {
                    node_id: "home".into(),
                    session_id: "worker".into(),
                },
            )
            .unwrap();
        store.db.lock().execute_batch("UPDATE operations SET body=json_remove(body,'$.resource_required','$.resource_available','$.resource');DROP TABLE operation_resource_bindings;DROP TABLE official_call_events;DROP TABLE official_calls;DROP TABLE quota_window_evidence;DROP INDEX event_source_cursor; DROP INDEX event_target_cursor; PRAGMA user_version=10;").unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        let restored = store.operation(&op.id).unwrap().unwrap();
        assert!(!restored.resource_required);
        assert!(restored.resource.is_none());
        let count: u64 = store
            .db
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM operation_resource_bindings",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}

pub(super) fn attach_in(tx: &rusqlite::Transaction, id: &str, input: Attach) -> Result<Operation> {
    input.policy.validate()?;
    let body: String = tx.query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    let mut op: Operation = serde_json::from_str(&body)?;
    let wire = serde_json::to_string(&input.policy)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT body FROM operation_resource_bindings WHERE operation_id=?1 AND attempt=?2",
            params![id, input.attempt],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if old == wire && op.attempt == input.attempt {
            return Ok(op);
        }
        bail!("resource assignment is immutable")
    }
    if !op.resource_required
        || op.state != State::Prepared
        || op.attempt != input.attempt
        || op.revision != input.expected_revision
        || op.worker.node_id != input.policy.host
    {
        bail!("resource assignment requires current prepared operation and execution host")
    }
    if input.policy.unknown_quota == UnknownQuota::TeamBudget && !op.budget_required {
        bail!("unknown quota requires enforced team budget")
    }
    tx.execute(
        "INSERT INTO operation_resource_bindings(operation_id,attempt,body) VALUES (?1,?2,?3)",
        params![id, input.attempt, wire],
    )?;
    op.resource = Some(input.policy.clone());
    op.revision += 1;
    super::operations::save(
        tx,
        &op,
        serde_json::json!({"kind":"resource_attached","policy":input.policy,"operation":op}),
    )?;
    Ok(op)
}
