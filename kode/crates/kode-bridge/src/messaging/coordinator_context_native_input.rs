//! Exact-source Native admission and transactional same-scope settlement.
//! No HTTP registration, model invocation, credential creation, or tool expansion.
use super::{
    coordinator_context_inbox as inbox,
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Begin {
    pub request_id: String,
    pub host_binding_id: String,
    pub context_key: String,
    pub session_id: String,
    pub journal_id: String,
    pub entry_id: String,
    pub claim_id: String,
    pub source_message_id: String,
    pub source_content_sha256: String,
    pub manifest_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Finish {
    pub request_id: String,
    pub admission_id: String,
    pub outcome: Outcome,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Outcome {
    Completed {
        usage_event_id: String,
        text: String,
    },
    Uncertain {
        reason: String,
    },
}
#[derive(Serialize, Deserialize)]
struct Admission {
    id: String,
    home: String,
    request: Begin,
    frozen: Value,
    operation_id: String,
    attempt: u64,
    epoch: u64,
    reservation_id: String,
    usage_sequence_start: u64,
    state: String,
    finish_hash: Option<String>,
    outbox: Option<Value>,
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn key(id: &str) -> String {
    format!("coordinator-context-native-id-v2:{}", json!(id))
}
fn request_key(context: &str, request: &str) -> String {
    format!(
        "coordinator-context-native-input-v2:{}",
        json!([context, request])
    )
}
fn read(db: &Connection, key: &str) -> Result<Option<Value>> {
    let s: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    s.map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
fn insert(db: &Connection, key: &str, value: &Value) -> Result<()> {
    db.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![key, value.to_string()],
    )?;
    Ok(())
}
fn load(db: &Connection, home: &str, context: &str, id: &str) -> Result<Admission> {
    let a: Admission = serde_json::from_value(
        read(db, &key(id))?.ok_or_else(|| anyhow::anyhow!("native admission missing"))?,
    )?;
    if a.id != id || a.home != home || a.request.context_key != context {
        bail!("native admission identity mismatch")
    }
    let fence = read(
        db,
        &super::coordinator_context_call::source_fence_key(context, &a.request.entry_id),
    )?;
    if fence
        != Some(json!({"transport":"native","admission_id":id,"request_id":a.request.request_id}))
    {
        bail!("native source fence mismatch")
    }
    Ok(a)
}
fn save(db: &Connection, a: &Admission) -> Result<()> {
    db.execute(
        "UPDATE workbench_documents SET revision=revision+1,value=?2 WHERE key=?1",
        params![key(&a.id), serde_json::to_string(a)?],
    )?;
    Ok(())
}
fn view(a: &Admission, new: bool) -> Value {
    json!({"admission_id":a.id,"context_key":a.request.context_key,"request_id":a.request.request_id,
        "entry_id":a.request.entry_id,"claim_id":a.request.claim_id,"operation_id":a.operation_id,
        "attempt":a.attempt,"epoch":a.epoch,"session_id":a.request.session_id,"journal_id":a.request.journal_id,
        "state":a.state,"new_admission":new,"dispatch_allowed":new,"profile_id":"conversation_reply_v1","tools":[]})
}
impl Store {
    pub(super) fn begin_native_context_input(&self, input: Begin) -> Result<Value> {
        let expected = format!(
            "native:{}",
            hash(&json!([
                "native-turn-v1",
                input.session_id,
                input.journal_id,
                input.entry_id,
                input.claim_id
            ]))
        );
        if input.request_id != expected
            || [
                &input.host_binding_id,
                &input.session_id,
                &input.journal_id,
                &input.entry_id,
                &input.claim_id,
                &input.source_message_id,
            ]
            .iter()
            .any(|s| !valid_id(s))
        {
            bail!("invalid native source identity")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(id) = read(&tx, &request_key(&input.context_key, &input.request_id))? {
            let a = load(
                &tx,
                &self.node_id,
                &input.context_key,
                id.as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid native request receipt"))?,
            )?;
            if a.request != input {
                bail!("native request conflict")
            }
            return Ok(view(&a, false));
        }
        let source = inbox::conversation_claim_in(
            &tx,
            &self.node_id,
            &input.context_key,
            &input.host_binding_id,
            &input.entry_id,
            &input.claim_id,
            now(),
        )?;
        let frozen = &source["frozen"];
        let entry = &source["entry"];
        if entry["source_message_id"] != input.source_message_id
            || entry["source_content_sha256"] != input.source_content_sha256
            || entry["journal_id"] != input.journal_id
            || entry["worker"]["session_id"] != input.session_id
            || frozen["manifest_sha256"] != input.manifest_sha256
            || frozen["manifest"]
                != json!({"profile":"conversation_reply_v1","version":1,"tools":[]})
        {
            bail!("native source differs from frozen identity")
        }
        let operation_id = entry["operation_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("native operation missing"))?
            .to_string();
        let attempt = entry["operation_attempt"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("native attempt missing"))?;
        let epoch = entry["operation_epoch"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("native epoch missing"))?;
        let reservation_id:String=tx.query_row("SELECT reservation_id FROM operation_budget_bindings WHERE operation_id=?1 AND attempt=?2",params![operation_id,attempt],|r|r.get(0))?;
        let mixed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1 AND attempt=?2)",
            params![operation_id, attempt],
            |r| r.get(0),
        )?;
        if mixed {
            bail!("native attempt already has provider accounting")
        }
        let a = Admission {
            id: uuid::Uuid::new_v4().to_string(),
            home: self.node_id.clone(),
            request: input,
            frozen: frozen.clone(),
            operation_id,
            attempt,
            epoch,
            reservation_id,
            usage_sequence_start: tx.query_row(
                "SELECT COALESCE(MAX(seq),0) FROM metered_usage",
                [],
                |r| r.get(0),
            )?,
            state: "admitted".into(),
            finish_hash: None,
            outbox: None,
        };
        insert(
            &tx,
            &super::coordinator_context_call::source_fence_key(
                &a.request.context_key,
                &a.request.entry_id,
            ),
            &json!({"transport":"native","admission_id":a.id,"request_id":a.request.request_id}),
        )?;
        // Native usage is cumulative for an operation attempt. Until per-turn
        // counters exist, never attribute that attempt to two concurrent inputs.
        insert(
            &tx,
            &format!(
                "coordinator-context-native-attempt-v2:{}",
                json!([a.operation_id, a.attempt, a.epoch])
            ),
            &json!({"admission_id":a.id,"entry_id":a.request.entry_id}),
        )?;
        insert(
            &tx,
            &request_key(&a.request.context_key, &a.request.request_id),
            &json!(a.id),
        )?;
        insert(&tx, &key(&a.id), &serde_json::to_value(&a)?)?;
        tx.commit()?;
        Ok(view(&a, true))
    }
    pub(super) fn native_context_input_status(&self, context: &str, id: &str) -> Result<Value> {
        Ok(view(
            &load(&self.db.lock(), &self.node_id, context, id)?,
            false,
        ))
    }
    /// Lost Begin responses are reconciled by the original deterministic request,
    /// not by repeating a mutation or inventing a new invocation identity.
    pub(super) fn native_context_request_status(
        &self,
        context: &str,
        request: &str,
    ) -> Result<Value> {
        let db = self.db.lock();
        let Some(id) = read(&db, &request_key(context, request))? else {
            return Ok(json!({"state":"not_found","new_admission":false,"dispatch_allowed":false}));
        };
        let a = load(
            &db,
            &self.node_id,
            context,
            id.as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid native request receipt"))?,
        )?;
        Ok(view(&a, false))
    }
    pub(super) fn finish_native_context_input(
        &self,
        context: &str,
        input: Finish,
    ) -> Result<Value> {
        if !valid_id(&input.request_id) {
            bail!("invalid native finish request")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let mut a = load(&tx, &self.node_id, context, &input.admission_id)?;
        let digest = hash(&serde_json::to_value(&input)?);
        if let Some(old) = &a.finish_hash {
            if old != &digest {
                bail!("native finish conflict")
            }
            return Ok(view(&a, false));
        }
        if a.state != "admitted" {
            bail!("native outcome requires reconciliation")
        }
        match &input.outcome {
            Outcome::Uncertain { reason } => {
                if reason.is_empty() || reason.len() > 4096 {
                    bail!("invalid uncertainty reason")
                }
                a.state = "uncertain".into();
            }
            Outcome::Completed {
                usage_event_id,
                text,
            } => {
                if !valid_id(usage_event_id)
                    || text.is_empty()
                    || text.len() > 65536
                    || text.contains('\0')
                {
                    bail!("invalid native result")
                }
                let source = inbox::conversation_settlement_in(
                    &tx,
                    &self.node_id,
                    context,
                    &a.request.host_binding_id,
                    &a.request.entry_id,
                    &a.request.claim_id,
                    now(),
                )?;
                if source["frozen"] != a.frozen || source["entry"]["state"] != "claimed" {
                    bail!("native settlement changed")
                }
                let (_, op) = super::coordinator_context_host_binding::settlement_in(
                    &tx,
                    &self.node_id,
                    context,
                    &a.request.host_binding_id,
                    now(),
                )?;
                super::selection_evidence::complete(&tx, &op)?;
                let current_reservation:String=tx.query_row("SELECT reservation_id FROM operation_budget_bindings WHERE operation_id=?1 AND attempt=?2",params![a.operation_id,a.attempt],|r|r.get(0))?;
                if current_reservation != a.reservation_id {
                    bail!("native reservation binding changed")
                }
                let (seq, reservation, command, result): (u64, String, String, String) = tx
                    .query_row(
                    "SELECT seq,reservation_id,command,result FROM metered_usage WHERE event_id=?1",
                    [usage_event_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
                let usage: super::pricing::Usage = serde_json::from_str(&command)?;
                let result: Value = serde_json::from_str(&result)?;
                if seq <= a.usage_sequence_start
                    || reservation != a.reservation_id
                    || usage.reservation_id != a.reservation_id
                    || a.frozen["execution_target"]["model_id"] != usage.model
                    || result["estimated"] != true
                    || usage.input_tokens == 0
                    || usage.output_tokens == 0
                    || !matches!(
                        usage.attribution,
                        super::pricing::Attribution::RequestedModel {
                            rerouted: false,
                            cache_write_input_tokens: 0
                        }
                    )
                {
                    bail!("native usage unresolved or mismatched")
                }
                // One original accounting receipt cannot settle two source turns.
                insert(
                    &tx,
                    &format!(
                        "coordinator-context-native-usage-v2:{}",
                        json!(usage_event_id)
                    ),
                    &json!({"admission_id":a.id,"operation_id":a.operation_id,"attempt":a.attempt,"worker_session":a.request.session_id}),
                )?;
                a.outbox =
                    Some(json!({"state":"pending","text":text,"usage_event_id":usage_event_id}));
                a.state = "outbox".into();
            }
        }
        inbox::settle_conversation_in(
            &tx,
            context,
            &a.request.entry_id,
            &a.request.claim_id,
            &a.operation_id,
            &a.request.journal_id,
            a.state == "outbox",
        )?;
        a.finish_hash = Some(digest);
        save(&tx, &a)?;
        tx.commit()?;
        Ok(view(&a, false))
    }
    pub(super) fn publish_native_context_reply(&self, context: &str, id: &str) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let mut a = load(&tx, &self.node_id, context, id)?;
        let source = inbox::conversation_settlement_in(
            &tx,
            &self.node_id,
            context,
            &a.request.host_binding_id,
            &a.request.entry_id,
            &a.request.claim_id,
            now(),
        )?;
        if source["frozen"] != a.frozen || source["entry"]["state"] != "completed" {
            bail!("native publication scope changed")
        }
        let out = a
            .outbox
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("native outbox missing"))?;
        if a.state == "published" && out["state"] == "delivered" {
            return Ok(json!({"message_id":out["message_id"],"new_publication":false}));
        }
        if a.state != "outbox" || out["state"] != "pending" {
            bail!("native outbox requires reconciliation")
        }
        let c = &a.frozen["context"];
        let surface = c["surface_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("surface missing"))?;
        let thread = c["thread_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("thread missing"))?;
        let message = super::collaboration::insert_scoped_message(
            &tx,
            surface,
            thread,
            "superagent_reply",
            json!({
            "id":uuid::Uuid::new_v4().to_string(),"surface_id":surface,"thread_id":thread,"scope":c["origin"],
            "kind":"superagent_reply","actor":{"kind":"superagent","id":a.frozen["control"]["superagent_id"]},
            "content":out["text"],"source_message_id":a.request.source_message_id,"context_key":context,
            "native_admission_id":id,"created_at":now(),"execution_authorized":false}),
        )?;
        a.outbox.as_mut().unwrap()["state"] = json!("delivered");
        a.outbox.as_mut().unwrap()["message_id"] = message["id"].clone();
        a.state = "published".into();
        save(&tx, &a)?;
        tx.commit()?;
        Ok(json!({"message_id":message["id"],"new_publication":true}))
    }
}
