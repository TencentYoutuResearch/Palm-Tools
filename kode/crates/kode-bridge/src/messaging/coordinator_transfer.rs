//! Audited successor handover of existing work; original intake and creation receipts stay immutable.
use super::{
    builder_authority, coordinator_control, coordinator_input,
    model::{now, valid_id},
    operations::State,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transfer {
    pub request_id: String,
    pub expected_revision: u64,
    pub control_revision: u64,
}
fn read(db: &Connection, key: &str) -> Result<Option<Value>> {
    let row: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    row.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn authority_key(conversation: &str, message: &str, revision: u64) -> String {
    format!(
        "coordinator-reply-authority:{}",
        json!([conversation, message, revision])
    )
}
pub(super) fn reply_authority(
    db: &Connection,
    conversation: &str,
    message: &str,
    revision: u64,
) -> Result<Option<Value>> {
    let Some(source) = coordinator_input::read(db, conversation, message)? else {
        return Ok(None);
    };
    if source["request"]["control_revision"] == revision {
        return Ok(Some(
            json!({"request":source["request"],"source":source,"transfer":null}),
        ));
    }
    let Some(transfer) = read(db, &authority_key(conversation, message, revision))? else {
        return Ok(None);
    };
    Ok(Some(
        json!({"request":transfer["request"],"source":source,"transfer":transfer}),
    ))
}
impl Store {
    pub fn pending_coordinator_transfers(
        &self,
        team: &str,
        input: super::work_runs::ActiveQuery,
    ) -> Result<Value> {
        if !valid_id(team) || input.after.as_ref().is_some_and(|v| !valid_id(v)) {
            bail!("invalid Coordinator transfer cursor")
        }
        let db = self.db.lock();
        let control = coordinator_control::current_in(&db, team)?;
        let revision = control
            .as_ref()
            .map(|c| c["revision"].clone())
            .unwrap_or(Value::Null);
        let empty = || json!({"team_id":team,"home_hub":self.node_id,"control_revision":revision,"items":[],"next_cursor":null});
        let Some(control) = control.as_ref() else {
            return Ok(empty());
        };
        if control["predecessor"].is_null() {
            return Ok(empty());
        }
        // Completed notices already consumed by the predecessor are not replayed
        // automatically. Explicit owner transfer remains available for investigation.
        let mut q=db.prepare("SELECT r.id,r.revision FROM work_runs r WHERE r.team_id=?1 AND r.id>?2 AND json_extract(r.body,'$.coordinator.operation_id')=?3 AND json_extract(r.body,'$.coordinator.control_revision')=?4 AND json_extract(r.body,'$.team_revision')=?5 AND json_extract(r.body,'$.authorization.revision')=?6 AND (r.state NOT IN ('completed','failed','cancelled') OR NOT EXISTS(SELECT 1 FROM workbench_documents d JOIN runtime_deliveries delivery ON delivery.message_id=json_extract(d.value,'$.receipt.message_id') AND delivery.phase=2 WHERE d.key='coordinator-update:'||json_array(r.id,r.revision))) ORDER BY r.id LIMIT 32")?;
        let rows = q
            .query_map(
                params![
                    team,
                    input.after.unwrap_or_default(),
                    control["predecessor"]["operation_id"].as_str(),
                    control["predecessor"]["control_revision"].as_u64(),
                    control["request"]["team_revision"].as_u64(),
                    control["request"]["activation_revision"].as_u64()
                ],
                |r| Ok(json!({"run_id":r.get::<_,String>(0)?,"revision":r.get::<_,u64>(1)?})),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(
            json!({"team_id":team,"home_hub":self.node_id,"control_revision":revision,"next_cursor":if rows.len()==32{rows.last().unwrap()["run_id"].clone()}else{Value::Null},"items":rows}),
        )
    }

    pub fn coordinator_reply_authority(
        &self,
        conversation: &str,
        message: &str,
        revision: u64,
    ) -> Result<Option<Value>> {
        if !valid_id(conversation)
            || !valid_id(message)
            || revision == 0
            || revision > i64::MAX as u64
        {
            bail!("invalid reply authority identity")
        }
        reply_authority(&self.db.lock(), conversation, message, revision)
    }
    pub fn transfer_coordinator_run(&self, id: &str, input: Transfer) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
            || input.control_revision == 0
        {
            bail!("invalid Coordinator transfer")
        }
        let request = serde_json::to_value(&input)?;
        let key = format!("coordinator-transfer:{}", json!([id, input.request_id]));
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(saved) = read(&tx, &key)? {
            if saved["request"] != request {
                bail!("Coordinator transfer identity conflict")
            };
            return Ok(saved["result"].clone());
        }
        let body: String =
            tx.query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))?;
        let mut run: Value = serde_json::from_str(&body)?;
        if run["revision"] != input.expected_revision {
            bail!("work run revision conflict")
        }
        let team = run["team_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid run team"))?
            .to_owned();
        let previous = run["coordinator"].clone();
        let conversation = previous["conversation_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Coordinator origin missing"))?
            .to_owned();
        let source_id = previous["source_message_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Coordinator source missing"))?
            .to_owned();
        let control = coordinator_control::current_in(&tx, &team)?
            .ok_or_else(|| anyhow::anyhow!("Coordinator control missing"))?;
        let predecessor = &control["predecessor"];
        if control["revision"] != input.control_revision
            || control["conversation_id"] != conversation
            || predecessor["control_revision"] != previous["control_revision"]
            || predecessor["operation_id"] != previous["operation_id"]
            || predecessor["attempt"] != previous["attempt"]
            || predecessor["epoch"] != previous["epoch"]
            || run["team_revision"] != control["request"]["team_revision"]
            || run["authorization"]["revision"] != control["request"]["activation_revision"]
        {
            bail!("Coordinator transfer requires exact direct successor and activation")
        }
        let op = builder_authority::operation(
            &tx,
            control["request"]["operation_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid Coordinator operation"))?,
        )?;
        let at = now();
        if op.state != State::Active
            || op.worker.node_id != self.node_id
            || op.lease_until.is_none_or(|t| t <= at)
        {
            bail!("Coordinator transfer requires active local lease")
        }
        super::operation_grant::admit(&tx, &op, at)?;
        super::operation_budget::admit(&tx, &op, at)?;
        if !super::resource_admission::admit(&tx, &op, at)?.allowed {
            bail!("Coordinator resource unavailable")
        }
        let prior = reply_authority(
            &tx,
            &conversation,
            &source_id,
            previous["control_revision"].as_u64().unwrap_or(0),
        )?
        .ok_or_else(|| anyhow::anyhow!("prior source authority missing"))?;
        if prior["request"]
            != json!({"operation_id":previous["operation_id"],"control_revision":previous["control_revision"],"attempt":previous["attempt"],"epoch":previous["epoch"]})
        {
            bail!("prior source authority mismatch")
        }
        let delivery = prior["source"]["receipt"]["message_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("source delivery missing"))?;
        // The original input must have been consumed by its immutable recipient.
        // A fresh successor receives custody of the existing run, not a replay
        // of that input. The current control already fences the old operation.
        let intake_session = prior["source"]["receipt"]["worker"]["session_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid Coordinator intake worker"))?;
        let consumed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM runtime_deliveries WHERE message_id=?1 AND session=?2 AND phase=2)",params![delivery,intake_session],|r|r.get(0))?;
        if !consumed {
            bail!("Coordinator transfer source consumption unconfirmed")
        }
        let mut next = previous.clone();
        next["operation_id"] = json!(op.id);
        next["control_revision"] = json!(input.control_revision);
        next["attempt"] = json!(op.attempt);
        next["epoch"] = json!(op.epoch);
        let authority = json!({"operation_id":op.id,"control_revision":input.control_revision,"attempt":op.attempt,"epoch":op.epoch});
        let authority_key = authority_key(&conversation, &source_id, input.control_revision);
        if let Some(prior) = read(&tx, &authority_key)? {
            if prior["request"] != authority {
                bail!("reply authority conflict")
            }
        } else {
            tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",params![authority_key,serde_json::to_string(&json!({"request":authority,"run_id":id,"request_id":input.request_id,"from_control_revision":previous["control_revision"],"created_at":at}))?])?;
        }
        run["coordinator"] = next.clone();
        run["revision"] = json!(input.expected_revision + 1);
        run["updated_at"] = json!(at);
        tx.execute(
            "UPDATE work_runs SET revision=?1,body=?2 WHERE id=?3",
            params![
                input.expected_revision + 1,
                serde_json::to_string(&run)?,
                id
            ],
        )?;
        let result = json!({"run_id":id,"revision":run["revision"],"previous":previous,"coordinator":next,"request_id":input.request_id,"created_at":at,"state":"transferred","workflow_state":run["state"],"replayed_input":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key,
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        let event = json!({"kind":"coordinator_run_transferred","transfer":result,"actor":{"kind":"human","id":"local_owner"}});
        tx.execute(
            "INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
            params![id, serde_json::to_string(&event)?],
        )?;
        tx.execute(
            "INSERT INTO team_events(team_id,body) VALUES (?1,?2)",
            params![team, serde_json::to_string(&event)?],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
