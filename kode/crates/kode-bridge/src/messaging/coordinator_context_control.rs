//! Scoped control storage foundation. Not exposed by HTTP and not runtime-ready.
//! Reuses the legacy binding admission checks instead of a second grant evaluator.
use super::{
    coordinator_context_registry as registry, coordinator_control, model::valid_id, store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn key(context: &str) -> String {
    format!("coordinator-context-control-v2:{}", json!(context))
}
fn read(db: &Connection, storage_key: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [storage_key],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}

impl Store {
    /// Owner-only integration point for a future context API. Registration is not readiness.
    pub fn context_coordinator_control(&self, context: &str) -> Result<Option<Value>> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        registry::read_in(&tx, &self.node_id, context)?;
        read(&tx, &key(context))
    }

    /// Initial binding only; recovery is deliberately unavailable until journal ownership
    /// and every read/write tool are scope-aware. No legacy operation can be adopted.
    pub fn bind_context_coordinator_control(
        &self,
        context: &str,
        input: coordinator_control::Bind,
    ) -> Result<Value> {
        if !valid_id(&input.request_id)
            || input.expected_revision != 0
            || input.team_revision == 0
            || input.activation_revision == 0
            || input.operation_revision == 0
            || input.attempt == 0
            || input.epoch == 0
            || !valid_id(&input.operation_id)
            || !valid_id(&input.target_id)
        {
            bail!("invalid initial scoped Coordinator binding")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let record = registry::read_in(&tx, &self.node_id, context)?;
        if record.team_revision != input.team_revision {
            bail!("context team revision changed")
        }
        let request = serde_json::to_value(&input)?;
        let receipt_key = format!(
            "coordinator-context-command-v2:{}",
            json!([context, input.request_id])
        );
        if let Some(old) = read(&tx, &receipt_key)? {
            if old["request"] != request {
                bail!("scoped Coordinator request identity conflict")
            }
            return Ok(old);
        }
        if read(&tx, &key(context))?.is_some() {
            bail!("scoped Coordinator recovery not ready")
        }
        if coordinator_control::bound(&tx, &input.operation_id)? {
            bail!("Coordinator operation already bound")
        }
        let (op, active, at) = coordinator_control::admit_binding(
            &tx,
            &self.node_id,
            &record.context_scope.team_id,
            &input,
        )?;
        let grant = super::operation_grant::read(&tx, &op.id)?
            .ok_or_else(|| anyhow::anyhow!("scoped Coordinator grant missing"))?;
        if grant.scope.target.host != record.origin.host_id
            || grant.scope.target.workspace != record.origin.workspace_id
            || grant.scope.target.root != record.origin.root_ref
        {
            bail!("scoped Coordinator grant differs from exact context workspace")
        }
        if op.worker.session_id != format!("context-{context}") {
            bail!("scoped Coordinator requires its fresh context session")
        }
        let reused:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1) OR EXISTS(SELECT 1 FROM operations WHERE id!=?2 AND json_extract(body,'$.worker.session_id')=?1 AND json_extract(body,'$.worker.node_id')=?3)",params![op.worker.session_id,op.id,self.node_id],|r|r.get(0))?;
        if reused {
            bail!("scoped Coordinator cannot adopt session history")
        }
        let result = json!({"context_key":context,"context_scope":record.context_scope,"team_id":record.context_scope.team_id,
            "journal_id":uuid::Uuid::new_v4().to_string(),
            "home_hub":self.node_id,"superagent_id":active["snapshot"]["team"]["superagent_id"],
            "revision":1,"request":request,"worker":op.worker,"created_at":at,
            "dispatch_state":"not_ready","runtime_ready":false,"readiness_reason":"scoped_runtime_incomplete"});
        // Preserve the global operation role fence, without replacing any legacy Team control.
        let operation_key = format!("coordinator-operation:{}", json!(op.id));
        for storage_key in [key(context), receipt_key, operation_key] {
            tx.execute(
                "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
                params![storage_key, result.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_binding_never_enables_legacy_lease_admission() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("db"), "home").unwrap();
        let db = store.db.lock();
        let op: super::super::operations::Operation =
            serde_json::from_value(json!({"id":"op","owner":"owner",
            "worker":{"node_id":"home","session_id":"context-session"},"request_key":"request",
            "attempt":1,"epoch":1,"revision":1,"state":"prepared","lease_until":null}))
            .unwrap();
        // Even a malformed/unready v2 claim must never fall through to legacy lookup.
        for scope in [Value::Null, json!({"version":2})] {
            db.execute("INSERT INTO workbench_documents(key,revision,value) VALUES ('coordinator-operation:\"op\"',1,?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[json!({"context_scope":scope}).to_string()]).unwrap();
            assert_eq!(
                coordinator_control::lease_gate(&db, &op, 0)
                    .unwrap_err()
                    .to_string(),
                "scoped Coordinator runtime not ready"
            );
        }
    }
    #[test]
    fn invalid_or_unregistered_scope_binding_has_no_writes() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("db"), "home").unwrap();
        let request = || coordinator_control::Bind {
            request_id: "bind".into(),
            expected_revision: 0,
            team_revision: 1,
            activation_revision: 1,
            operation_id: "op".into(),
            operation_revision: 1,
            attempt: 1,
            epoch: 1,
            target_id: "target".into(),
        };
        assert!(store
            .bind_context_coordinator_control(&"a".repeat(64), request())
            .is_err());
        let mut invalid = request();
        invalid.expected_revision = 1;
        assert!(store
            .bind_context_coordinator_control(&"a".repeat(64), invalid)
            .unwrap_err()
            .to_string()
            .contains("invalid initial"));
        assert_eq!(
            store
                .db
                .lock()
                .query_row(
                    "SELECT COUNT(*) FROM workbench_documents WHERE key LIKE 'coordinator-%'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
    }
}
