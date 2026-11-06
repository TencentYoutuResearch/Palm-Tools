//! Home-Hub operation ledger. Reports are not workflow completion or retry permission.
use super::{model::*, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Prepared,
    Active,
    Reported,
    Cancelling,
    Stopped,
    Uncertain,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Operation {
    pub id: String,
    pub owner: String,
    pub worker: Address,
    pub request_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_policy: Option<super::selection_evidence::Policy>,
    #[serde(default)]
    pub budget_required: bool,
    #[serde(default)]
    pub grant_required: bool,
    #[serde(default)]
    pub grant_available: Option<bool>,
    #[serde(default)]
    pub resource_required: bool,
    #[serde(default)]
    pub resource_available: Option<bool>,
    #[serde(default)]
    pub resource: Option<super::resource_admission::Policy>,
    #[serde(default)]
    pub budget_available: Option<bool>,
    #[serde(default)]
    pub lease_duration_ms: Option<u64>,
    pub attempt: u64,
    pub epoch: u64,
    pub revision: u64,
    pub state: State,
    pub lease_until: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Claim {
        lease_ms: u64,
    },
    Renew {
        lease_ms: u64,
    },
    Cancel,
    ClaimResource {
        lease_ms: u64,
        resource: super::resource_admission::Acknowledgement,
    },
    RenewResource {
        lease_ms: u64,
        resource: super::resource_admission::Acknowledgement,
    },
    AttestStopped {
        reason: String,
    },
    NextAttempt,
    Report {
        report_id: String,
        content: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_ack: Option<super::selection_evidence::Policy>,
    pub attempt: u64,
    pub epoch: u64,
    pub expected_revision: u64,
    pub action: Action,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub operation: Operation,
    pub applied: bool,
    pub reason: Option<String>,
}
pub(super) fn save(tx: &Transaction, row: &Operation, event: serde_json::Value) -> Result<()> {
    tx.execute("INSERT INTO operations(id,owner,request_key,state,lease_until,body) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET state=excluded.state,lease_until=excluded.lease_until,body=excluded.body",params![row.id,row.owner,row.request_key,serde_json::to_string(&row.state)?,row.lease_until,serde_json::to_string(row)?])?;
    tx.execute(
        "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
        params![row.id, serde_json::to_string(&event)?],
    )?;
    Ok(())
}
impl Store {
    pub fn operation_events(&self, id: &str, after: u64) -> Result<Vec<serde_json::Value>> {
        let db = self.db.lock();
        let mut q=db.prepare("SELECT seq,body FROM operation_events WHERE operation_id=?1 AND seq>?2 ORDER BY seq LIMIT 100")?;
        let rows = q.query_map(params![id, after], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut result = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let (seq, body) = row?;
            if !result.is_empty() && bytes + body.len() > 32768 {
                break;
            }
            bytes += body.len();
            result.push(serde_json::json!({"seq":seq,"data":serde_json::from_str::<serde_json::Value>(&body)?}));
        }
        Ok(result)
    }
    pub fn operation(&self, id: &str) -> Result<Option<Operation>> {
        let db = self.db.lock();
        let body: Option<String> = db
            .query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        body.map(|s| {
            let mut row: Operation = serde_json::from_str(&s)?;
            if row.grant_required {
                row.grant_available = Some(
                    super::operation_grant::admit(&db, &row, now()).is_ok()
                        && super::assignment_admission::lease_gate(&db, &row.id, now()).is_ok(),
                );
            }
            if row.resource_required {
                row.resource_available =
                    Some(super::resource_admission::admit(&db, &row, now()).is_ok());
            }
            if row.budget_required {
                row.budget_available =
                    Some(super::operation_budget::admit(&db, &row, now()).is_ok());
            }
            Ok(row)
        })
        .transpose()
    }
    pub fn prepare_operation(&self, owner: &str, key: &str, worker: Address) -> Result<Operation> {
        self.prepare_budgeted_operation(owner, key, worker, false)
    }
    pub fn prepare_budgeted_operation(
        &self,
        owner: &str,
        key: &str,
        worker: Address,
        budget_required: bool,
    ) -> Result<Operation> {
        self.prepare_managed_operation(owner, key, worker, budget_required, false)
    }
    pub fn prepare_managed_operation(
        &self,
        owner: &str,
        key: &str,
        worker: Address,
        budget_required: bool,
        resource_required: bool,
    ) -> Result<Operation> {
        self.prepare_granted_operation(
            owner,
            key,
            worker,
            budget_required,
            resource_required,
            false,
        )
    }
    pub fn prepare_granted_operation(
        &self,
        owner: &str,
        key: &str,
        worker: Address,
        budget_required: bool,
        resource_required: bool,
        grant_required: bool,
    ) -> Result<Operation> {
        self.prepare_selected_operation(
            owner,
            key,
            worker,
            budget_required,
            resource_required,
            grant_required,
            None,
        )
    }
    pub fn prepare_selected_operation(
        &self,
        owner: &str,
        key: &str,
        worker: Address,
        budget_required: bool,
        resource_required: bool,
        grant_required: bool,
        selection_policy: Option<super::selection_evidence::Policy>,
    ) -> Result<Operation> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let row = prepare_in(
            &tx,
            owner,
            key,
            worker,
            budget_required,
            resource_required,
            grant_required,
            selection_policy,
        )?;
        tx.commit()?;
        Ok(row)
    }
    /// Authorization is checked by the API; compare-and-swap and report dedup are
    /// checked here in the same transaction as the audit and state update.
    pub fn command_operation(&self, id: &str, command: Command, at: u64) -> Result<Outcome> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String = tx.query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
        let mut row: Operation = serde_json::from_str(&body)?;
        let wire = serde_json::to_string(&command)?;
        if let Action::Report { report_id, content } = &command.action {
            if !valid_id(report_id) || content.len() > 16384 {
                bail!("invalid operation report")
            }
            let old:Option<(String,String)>=tx.query_row("SELECT command,result FROM operation_reports WHERE operation_id=?1 AND report_id=?2",params![id,report_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((prior, result)) = old {
                if prior != wire {
                    bail!("report ID conflict")
                }
                return Ok(serde_json::from_str(&result)?);
            }
        }
        if row.state == State::Active && row.lease_until.is_some_and(|until| until <= at) {
            row.state = State::Uncertain;
            row.lease_until = None;
            row.epoch += 1;
            row.revision += 1;
            save(
                &tx,
                &row,
                serde_json::json!({"kind":"lease_expired","operation":row}),
            )?;
        }
        let current = command.attempt == row.attempt
            && command.epoch == row.epoch
            && command.expected_revision == row.revision;
        if let Action::Report { report_id, .. } = &command.action {
            let selection_ok = super::selection_evidence::admit(&tx, &row).is_ok();
            let selection_complete = super::selection_evidence::complete(&tx, &row).is_ok();
            let applied = current
                && row.state == State::Active
                && super::operation_grant::admit(&tx, &row, at).is_ok()
                && super::assignment_admission::report_gate(&tx, &row.id, at).is_ok()
                && selection_ok
                && selection_complete;
            if applied {
                row.state = State::Reported;
                row.lease_until = None;
                row.revision += 1;
            }
            let result = Outcome {
                operation: row.clone(),
                applied,
                reason: if applied {
                    None
                } else if current && !selection_ok {
                    Some("selection_rejected".into())
                } else if current && !selection_complete {
                    Some("selection_unverified".into())
                } else {
                    Some("stale_or_inactive_attempt".into())
                },
            };
            save(
                &tx,
                &row,
                serde_json::json!({"kind":"report","command":command,"applied":applied,"operation":row}),
            )?;
            tx.execute("INSERT INTO operation_reports(operation_id,report_id,command,result) VALUES (?1,?2,?3,?4)",params![id,report_id,wire,serde_json::to_string(&result)?])?;
            tx.commit()?;
            return Ok(result);
        }
        if !current {
            // Preserve expiry even when rejecting a late control.
            tx.commit()?;
            bail!("operation revision/attempt/epoch conflict")
        }
        let mut resource_decision = None;
        match &command.action {
            Action::Claim { lease_ms }
            | Action::Renew { lease_ms }
            | Action::ClaimResource { lease_ms, .. }
            | Action::RenewResource { lease_ms, .. } => {
                if row.selection_policy != command.selection_ack {
                    bail!("operation selection policy acknowledgement required")
                }
                match &command.action {
                    Action::ClaimResource { resource, .. }
                    | Action::RenewResource { resource, .. } => {
                        super::resource_admission::acknowledge(&row, resource)?
                    }
                    _ if row.resource_required => {
                        bail!("explicit resource acknowledgement required")
                    }
                    _ => {}
                }
                let valid = matches!(
                    command.action,
                    Action::Claim { .. } | Action::ClaimResource { .. }
                ) && row.state == State::Prepared
                    || matches!(
                        command.action,
                        Action::Renew { .. } | Action::RenewResource { .. }
                    ) && row.state == State::Active;
                if !valid || !(1000..=60000).contains(lease_ms) {
                    bail!("invalid lease admission")
                }
                super::assignment_admission::lease_gate(&tx, &row.id, at)?;
                super::selection_evidence::admit(&tx, &row)?;
                let grant_until = super::operation_grant::admit(&tx, &row, at)?;
                let budget_until = if row.budget_required {
                    super::operation_budget::admit(&tx, &row, at)?
                } else {
                    u64::MAX
                };
                let resource_until = if row.resource_required {
                    let d = super::resource_admission::admit(&tx, &row, at)?;
                    let until = d.valid_until_ms.unwrap_or(u64::MAX);
                    resource_decision = Some(d);
                    row.resource_available = Some(true);
                    until
                } else {
                    u64::MAX
                };
                let until = at
                    .checked_add(*lease_ms)
                    .ok_or_else(|| anyhow::anyhow!("lease overflow"))?
                    .min(budget_until)
                    .min(resource_until)
                    .min(grant_until);
                if until.saturating_sub(at) < 1000 {
                    bail!("admission evidence expires before minimum lease")
                }
                if row.grant_required {
                    row.grant_available = Some(true);
                }
                row.state = State::Active;
                row.lease_until = Some(until);
                row.lease_duration_ms = Some(until - at);
                if row.budget_required {
                    row.budget_available = Some(true);
                }
            }
            Action::Cancel => {
                match row.state {
                    State::Prepared => row.state = State::Stopped,
                    State::Active | State::Uncertain => row.state = State::Cancelling,
                    _ => bail!("operation cannot be cancelled in this state"),
                }
                row.epoch += 1;
                row.lease_until = None;
            }
            Action::AttestStopped { reason } => {
                if !matches!(row.state, State::Uncertain | State::Cancelling)
                    || reason.trim().is_empty()
                    || reason.len() > 2000
                {
                    bail!("owner stop attestation required")
                }
                row.state = State::Stopped;
                row.lease_until = None;
                row.epoch += 1;
            }
            Action::NextAttempt => {
                if row.state != State::Stopped {
                    bail!("prior attempt is not stopped")
                }
                row.state = State::Prepared;
                row.resource = None;
                row.resource_available = None;
                row.attempt += 1;
                row.epoch += 1;
                row.lease_until = None;
            }
            Action::Report { .. } => unreachable!(),
        }
        row.revision += 1;
        save(
            &tx,
            &row,
            serde_json::json!({"kind":"command","command":command,"resource_decision":resource_decision,"operation":row}),
        )?;
        tx.commit()?;
        Ok(Outcome {
            operation: row,
            applied: true,
            reason: None,
        })
    }
    pub fn expire_operations(&self, at: u64) -> Result<()> {
        let ids: Vec<String> = {
            let db = self.db.lock();
            let mut q = db.prepare(
                "SELECT id FROM operations WHERE state='\"active\"' AND lease_until<=?1 LIMIT 100",
            )?;
            let rows = q.query_map([at], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for id in ids {
            let mut db = self.db.lock();
            let tx = db.transaction()?;
            let body: Option<String> = tx
                .query_row("SELECT body FROM operations WHERE id=?1", [&id], |r| {
                    r.get(0)
                })
                .optional()?;
            if let Some(body) = body {
                let mut row: Operation = serde_json::from_str(&body)?;
                if row.state == State::Active && row.lease_until.is_some_and(|until| until <= at) {
                    row.state = State::Uncertain;
                    row.lease_until = None;
                    row.epoch += 1;
                    row.revision += 1;
                    save(
                        &tx,
                        &row,
                        serde_json::json!({"kind":"lease_expired","operation":row}),
                    )?;
                }
            }
            tx.commit()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cmd(row: &Operation, action: Action) -> Command {
        Command {
            selection_ack: row.selection_policy.clone(),
            attempt: row.attempt,
            epoch: row.epoch,
            expected_revision: row.revision,
            action,
        }
    }
    #[test]
    fn expired_attempt_cannot_report_or_retry_and_late_reports_are_deduplicated() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ops.sqlite");
        let store = Store::open(&path, "local").unwrap();
        let worker = Address {
            node_id: "local".into(),
            session_id: "worker".into(),
        };
        let first = store
            .prepare_operation("owner", "key", worker.clone())
            .unwrap();
        assert_eq!(
            store.prepare_operation("owner", "key", worker).unwrap().id,
            first.id
        );
        assert!(store
            .prepare_operation(
                "owner",
                "key",
                Address {
                    node_id: "local".into(),
                    session_id: "other".into()
                }
            )
            .is_err());
        let active = store
            .command_operation(
                &first.id,
                cmd(&first, Action::Claim { lease_ms: 1000 }),
                1000,
            )
            .unwrap()
            .operation;
        let report = cmd(
            &active,
            Action::Report {
                report_id: "report".into(),
                content: "late artifact".into(),
            },
        );
        let late = store
            .command_operation(&first.id, report.clone(), 2000)
            .unwrap();
        assert!(!late.applied);
        assert_eq!(late.operation.state, State::Uncertain);
        assert!(store
            .command_operation(&first.id, cmd(&late.operation, Action::NextAttempt), 2000)
            .is_err());
        let stopped = store
            .command_operation(
                &first.id,
                cmd(
                    &late.operation,
                    Action::AttestStopped {
                        reason: "owner verified processes stopped".into(),
                    },
                ),
                2001,
            )
            .unwrap()
            .operation;
        let second = store
            .command_operation(&first.id, cmd(&stopped, Action::NextAttempt), 2002)
            .unwrap()
            .operation;
        assert_eq!(second.attempt, 2);
        assert!(second.epoch > active.epoch);
        let active2 = store
            .command_operation(
                &first.id,
                cmd(&second, Action::Claim { lease_ms: 1000 }),
                2003,
            )
            .unwrap()
            .operation;
        assert!(
            !store
                .command_operation(&first.id, report, 2004)
                .unwrap()
                .applied
        );
        assert_eq!(
            store.operation(&first.id).unwrap().unwrap().revision,
            active2.revision
        );
        let conflict = cmd(
            &active,
            Action::Report {
                report_id: "report".into(),
                content: "changed result".into(),
            },
        );
        assert!(store.command_operation(&first.id, conflict, 2005).is_err());
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        store.expire_operations(3003).unwrap();
        let expired = store.operation(&first.id).unwrap().unwrap();
        assert_eq!(expired.state, State::Uncertain);
        assert_eq!(expired.attempt, 2);
        let count: u64 = store
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM operation_reports", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn current_report_is_idempotent_and_is_not_completion_or_retry_permission() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ops.sqlite"), "local").unwrap();
        let row = store
            .prepare_operation(
                "owner",
                "reporting",
                Address {
                    node_id: "local".into(),
                    session_id: "worker".into(),
                },
            )
            .unwrap();
        let active = store
            .command_operation(&row.id, cmd(&row, Action::Claim { lease_ms: 1000 }), 1000)
            .unwrap()
            .operation;
        let renewed = store
            .command_operation(
                &row.id,
                cmd(&active, Action::Renew { lease_ms: 1000 }),
                1500,
            )
            .unwrap()
            .operation;
        store.expire_operations(2000).unwrap();
        assert_eq!(
            store.operation(&row.id).unwrap().unwrap().state,
            State::Active
        );
        let report = cmd(
            &renewed,
            Action::Report {
                report_id: "ready".into(),
                content: "artifact available".into(),
            },
        );
        let first = store
            .command_operation(&row.id, report.clone(), 2001)
            .unwrap();
        let duplicate = store.command_operation(&row.id, report, 3000).unwrap();
        assert!(first.applied && duplicate.applied);
        assert_eq!(first.operation.revision, duplicate.operation.revision);
        assert_eq!(first.operation.state, State::Reported);
        assert!(store
            .command_operation(&row.id, cmd(&first.operation, Action::NextAttempt), 3001)
            .is_err());
        let audit = store.operation_events(&row.id, 0).unwrap();
        assert_eq!(audit.len(), 4);
        assert!(store
            .operation_events(&row.id, audit.last().unwrap()["seq"].as_u64().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn concurrent_claims_have_one_winner_and_cancel_fences_reports() {
        let root = tempfile::tempdir().unwrap();
        let store =
            std::sync::Arc::new(Store::open(&root.path().join("ops.sqlite"), "local").unwrap());
        let row = store
            .prepare_operation(
                "owner",
                "key",
                Address {
                    node_id: "local".into(),
                    session_id: "worker".into(),
                },
            )
            .unwrap();
        let jobs = (0..2)
            .map(|_| {
                let store = store.clone();
                let row = row.clone();
                std::thread::spawn(move || {
                    store.command_operation(
                        &row.id,
                        cmd(&row, Action::Claim { lease_ms: 1000 }),
                        1000,
                    )
                })
            })
            .collect::<Vec<_>>();
        let wins = jobs
            .into_iter()
            .filter_map(|job| job.join().unwrap().ok())
            .collect::<Vec<_>>();
        assert_eq!(wins.len(), 1);
        let active = &wins[0].operation;
        let cancelled = store
            .command_operation(&row.id, cmd(active, Action::Cancel), 1001)
            .unwrap()
            .operation;
        assert_eq!(cancelled.state, State::Cancelling);
        assert!(cancelled.epoch > active.epoch);
        assert!(
            !store
                .command_operation(
                    &row.id,
                    cmd(
                        active,
                        Action::Report {
                            report_id: "late".into(),
                            content: "done".into()
                        }
                    ),
                    1002
                )
                .unwrap()
                .applied
        );
        assert_eq!(
            store.operation(&row.id).unwrap().unwrap().state,
            State::Cancelling
        );
    }
}

pub(super) fn prepare_in(
    tx: &Transaction,
    owner: &str,
    key: &str,
    worker: Address,
    budget_required: bool,
    resource_required: bool,
    grant_required: bool,
    selection_policy: Option<super::selection_evidence::Policy>,
) -> Result<Operation> {
    if let Some(policy) = &selection_policy {
        policy.validate()?;
    }
    if !valid_id(owner)
        || !valid_id(key)
        || !valid_id(&worker.node_id)
        || !valid_id(&worker.session_id)
    {
        bail!("invalid operation identity")
    }
    let old: Option<String> = tx
        .query_row(
            "SELECT body FROM operations WHERE owner=?1 AND request_key=?2",
            params![owner, key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        let row: Operation = serde_json::from_str(&old)?;
        if row.worker != worker
            || row.budget_required != budget_required
            || row.resource_required != resource_required
            || row.grant_required != grant_required
            || row.selection_policy != selection_policy
        {
            bail!("operation request key conflict")
        }
        return Ok(row);
    }
    let row = Operation {
        id: uuid::Uuid::new_v4().to_string(),
        owner: owner.into(),
        worker,
        request_key: key.into(),
        selection_policy,
        budget_required,
        grant_required,
        grant_available: None,
        resource_required,
        resource_available: None,
        resource: None,
        budget_available: None,
        lease_duration_ms: None,
        attempt: 1,
        epoch: 1,
        revision: 1,
        state: State::Prepared,
        lease_until: None,
    };
    save(
        tx,
        &row,
        serde_json::json!({"kind":"prepared","operation":row}),
    )?;
    Ok(row)
}
