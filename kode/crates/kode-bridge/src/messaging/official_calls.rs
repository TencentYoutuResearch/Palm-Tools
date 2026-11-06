//! Home-owned per-call evidence. Replay receipts never grant permission to repeat inference.
use super::{
    model::valid_id,
    operations::{Operation, State},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Begin {
    pub call_id: String,
    pub operation_id: String,
    pub attempt: u64,
    pub epoch: u64,
    pub worker_session: String,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_provenance: Option<super::prompt_provenance::Provenance>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Counters {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub cache_write_input_tokens: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Usage,
    Finished,
    Interrupted,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub sequence: u64,
    pub kind: Kind,
    pub usage: Option<Counters>,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Call {
    pub request: Begin,
    pub sequence: u64,
    pub state: String,
    pub started_at: u64,
    pub last: Option<Evidence>,
    #[serde(default)]
    pub accounting: Option<super::official_accounting::Binding>,
    #[serde(default)]
    pub metered: Option<Counters>,
    #[serde(default)]
    pub accounting_status: String,
}
#[derive(Debug, Serialize)]
pub struct Receipt {
    pub call: Call,
    pub duplicate: bool,
}
impl Store {
    pub fn official_call_events(&self, id: &str, after: u64) -> Result<Vec<Evidence>> {
        let db = self.db.lock();
        let mut query=db.prepare("SELECT body FROM official_call_events WHERE call_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 100")?;
        let rows = query.query_map(params![id, after], |r| r.get::<_, String>(0))?;
        rows.map(|body| Ok(serde_json::from_str(&body?)?)).collect()
    }

    pub fn official_call(&self, id: &str) -> Result<Option<Call>> {
        let db = self.db.lock();
        let body: Option<String> = db
            .query_row("SELECT body FROM official_calls WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        body.map(|body| Ok(serde_json::from_str(&body)?))
            .transpose()
    }
    pub fn begin_official_call(&self, request: Begin, at: u64) -> Result<Receipt> {
        for value in [
            &request.call_id,
            &request.operation_id,
            &request.worker_session,
            &request.provider,
            &request.model,
        ] {
            if !valid_id(value) {
                bail!("invalid call identity")
            }
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT body FROM official_calls WHERE id=?1",
                [&request.call_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(body) = old {
            let call: Call = serde_json::from_str(&body)?;
            if call.request != request {
                bail!("call identity conflict")
            }
            return Ok(Receipt {
                call,
                duplicate: true,
            });
        }
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [&request.operation_id],
            |r| r.get(0),
        )?;
        let op: Operation = serde_json::from_str(&body)?;
        if op.attempt != request.attempt
            || op.epoch != request.epoch
            || op.worker.session_id != request.worker_session
            || op.state != State::Active
            || !op.lease_until.is_some_and(|until| until > at)
        {
            bail!("call operation authority unavailable")
        }
        super::selection_evidence::admit(&tx, &op)?;
        let dependencies = super::workflow_dependencies::operation_manifest(&tx, &op.id)?;
        if !dependencies.is_empty() && request.prompt_provenance.as_ref().and_then(|proof| proof.instruction.as_ref())
            .is_none_or(|instruction| instruction.role != "worker" || instruction.dependencies != dependencies) {
            bail!("workflow dependency prompt provenance required")
        }
        super::assignment_answer_progress::validate_call(&tx, &op.id, request.prompt_provenance.as_ref())?;
        if let Some(proof) = &request.prompt_provenance {
            super::prompt_provenance::validate(&tx, &op.id, proof)?;
        }
        super::operation_grant::admit(&tx, &op, at)?;
        if op.budget_required {
            super::operation_budget::admit(&tx, &op, at)?;
        }
        if op.resource_required {
            super::resource_admission::admit(&tx, &op, at)?;
        }
        let accounting = super::official_accounting::prepare(&tx, &op, &request)?;
        let call = Call {
            accounting,
            metered: None,
            accounting_status: "awaiting_usage".into(),
            request,
            sequence: 0,
            state: "started".into(),
            started_at: at,
            last: None,
        };
        tx.execute("INSERT INTO official_calls(id,operation_id,attempt,state,body) VALUES (?1,?2,?3,?4,?5)",params![call.request.call_id,op.id,op.attempt,call.state,serde_json::to_string(&call)?])?;
        tx.commit()?;
        Ok(Receipt {
            call,
            duplicate: false,
        })
    }
    pub fn record_official_call(&self, id: &str, event: Evidence) -> Result<Receipt> {
        if !valid_id(&event.reason) || event.sequence == 0 {
            bail!("invalid call evidence")
        }
        if let Some(u) = &event.usage {
            if [
                u.input_tokens,
                u.cached_input_tokens,
                u.output_tokens,
                u.cache_write_input_tokens,
            ]
            .iter()
            .any(|n| *n > 1_000_000_000_000)
                || u.cached_input_tokens
                    .saturating_add(u.cache_write_input_tokens)
                    > u.input_tokens
            {
                bail!("invalid usage counters")
            }
        }
        let body = serde_json::to_string(&event)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let stored: String =
            tx.query_row("SELECT body FROM official_calls WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut call: Call = serde_json::from_str(&stored)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT body FROM official_call_events WHERE call_id=?1 AND sequence=?2",
                params![id, event.sequence],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            if prior != body {
                bail!("call event conflict")
            }
            return Ok(Receipt {
                call,
                duplicate: true,
            });
        }
        if call.state != "started" || event.sequence != call.sequence + 1 {
            bail!("call evidence out of order or terminal")
        }
        call.sequence = event.sequence;
        call.state = match event.kind {
            Kind::Usage => "started",
            Kind::Finished => "finished",
            Kind::Interrupted => "uncertain",
        }
        .into();
        super::official_accounting::apply(&tx, &mut call, &event, super::model::now())?;
        call.last = Some(event);
        tx.execute(
            "INSERT INTO official_call_events(call_id,sequence,body) VALUES (?1,?2,?3)",
            params![id, call.sequence, body],
        )?;
        tx.execute(
            "UPDATE official_calls SET state=?2,body=?3 WHERE id=?1",
            params![id, call.state, serde_json::to_string(&call)?],
        )?;
        tx.commit()?;
        Ok(Receipt {
            call,
            duplicate: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{
        model::Address,
        operations::{Action, Command},
    };
    fn active(store: &Store) -> Operation {
        let op = store
            .prepare_operation(
                "owner",
                "work",
                Address {
                    node_id: "home".into(),
                    session_id: "worker".into(),
                },
            )
            .unwrap();
        store
            .command_operation(
                &op.id,
                Command {
                    selection_ack: None,
                    attempt: 1,
                    epoch: 1,
                    expected_revision: 1,
                    action: Action::Claim { lease_ms: 2000 },
                },
                1000,
            )
            .unwrap()
            .operation
    }
    fn begin(op: &Operation) -> Begin {
        Begin {
            call_id: "call".into(),
            operation_id: op.id.clone(),
            attempt: op.attempt,
            epoch: op.epoch,
            worker_session: "worker".into(),
            provider: "provider".into(),
            model: "model".into(),
            prompt_provenance: None,
        }
    }
    fn event(sequence: u64, kind: Kind) -> Evidence {
        Evidence {
            sequence,
            kind,
            usage: Some(Counters {
                input_tokens: 10,
                cached_input_tokens: 3,
                output_tokens: 2,
                cache_write_input_tokens: 0,
            }),
            reason: "model_not_verified".into(),
        }
    }
    #[test]
    fn prepared_prompt_provenance_survives_restart_and_is_part_of_call_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prompt.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let op = active(&store);
        let mut request = begin(&op);
        let proof = serde_json::from_value(serde_json::json!({
            "schema_version":1,"source":"official_prepared_input","system_sha256":"a".repeat(64),"system_messages":1,
            "instruction":{"role":"coordinator","version":"kode.coordinator.v1","sha256":"a".repeat(64)}
        })).unwrap();
        request.prompt_provenance = Some(proof);
        let mut invalid = request.clone();
        invalid.prompt_provenance.as_mut().unwrap().system_sha256 = "not-a-hash".into();
        assert!(store.begin_official_call(invalid, 1001).is_err());
        let mut foreign = request.clone();
        foreign
            .prompt_provenance
            .as_mut()
            .unwrap()
            .instruction
            .as_mut()
            .unwrap()
            .role = "worker".into();
        assert!(store.begin_official_call(foreign, 1001).is_err());
        store.begin_official_call(request.clone(), 1001).unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(
            store.official_call("call").unwrap().unwrap().request,
            request
        );
        assert!(
            store
                .begin_official_call(request.clone(), 1002)
                .unwrap()
                .duplicate
        );
        request
            .prompt_provenance
            .as_mut()
            .unwrap()
            .instruction
            .as_mut()
            .unwrap()
            .version = "changed".into();
        assert!(store.begin_official_call(request, 1002).is_err());
    }
    #[test]
    fn call_receipts_survive_restart_and_late_usage_does_not_restore_authority() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calls.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let op = active(&store);
        let request = begin(&op);
        assert!(
            !store
                .begin_official_call(request.clone(), 1001)
                .unwrap()
                .duplicate
        );
        assert!(
            store
                .begin_official_call(request.clone(), 1002)
                .unwrap()
                .duplicate
        );
        let mut conflict = request.clone();
        conflict.model = "other".into();
        assert!(store.begin_official_call(conflict, 1002).is_err());
        assert!(store
            .record_official_call("call", event(2, Kind::Usage))
            .is_err());
        store
            .record_official_call("call", event(1, Kind::Usage))
            .unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        store.expire_operations(4000).unwrap();
        assert!(
            store
                .begin_official_call(request.clone(), 4000)
                .unwrap()
                .duplicate,
            "replay returns evidence, never a fresh dispatch grant"
        );
        let mut next = request;
        next.call_id = "new-call".into();
        assert!(store.begin_official_call(next, 4000).is_err());
        assert!(
            store
                .record_official_call("call", event(1, Kind::Usage))
                .unwrap()
                .duplicate
        );
        let mut conflict = event(1, Kind::Usage);
        conflict.reason = "different".into();
        assert!(store.record_official_call("call", conflict).is_err());
        store
            .record_official_call("call", event(2, Kind::Interrupted))
            .unwrap();
        assert!(store
            .record_official_call("call", event(3, Kind::Finished))
            .is_err());
        assert_eq!(
            store.official_call("call").unwrap().unwrap().state,
            "uncertain"
        );
        assert_eq!(
            store.operation(&op.id).unwrap().unwrap().state,
            State::Uncertain
        );
    }
    #[test]
    fn call_start_checks_worker_epoch_and_v12_upgrade_preserves_operations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("upgrade.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let op = active(&store);
        store
            .db
            .lock()
            .execute_batch(
                "DROP TABLE official_call_events;DROP TABLE official_calls;DROP INDEX event_source_cursor; DROP INDEX event_target_cursor; PRAGMA user_version=12;",
            )
            .unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        let mut foreign = begin(&op);
        foreign.worker_session = "foreign".into();
        assert!(store.begin_official_call(foreign, 1001).is_err());
        let mut stale = begin(&op);
        stale.epoch += 1;
        assert!(store.begin_official_call(stale, 1001).is_err());
        store.begin_official_call(begin(&op), 1001).unwrap();
        let mut invalid = event(1, Kind::Usage);
        invalid.usage.as_mut().unwrap().cached_input_tokens = 11;
        assert!(store.record_official_call("call", invalid).is_err());
        assert_eq!(store.official_call("call").unwrap().unwrap().sequence, 0);
    }
}
