//! Immutable first-stage mandate, atomically linked to the existing durable message inbox.
use super::{
    assignment_admission, assignment_resources, model::*, operations::State, store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Enqueue {
    pub request_id: String,
    pub expected_revision: u64,
}
impl Store {
    pub fn enqueue_assignment_mandate(
        &self,
        id: &str,
        input: Enqueue,
        remote_workers: &[Address],
    ) -> Result<Value> {
        if !valid_id(id) || !valid_id(&input.request_id) || input.expected_revision == 0 {
            bail!("invalid mandate request")
        }
        let request = serde_json::to_value(input)?;
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if !assignment["mandate"].is_null() {
            if assignment["mandate"]["request"] != request {
                bail!("mandate request identity conflict")
            }
            return Ok(assignment["mandate"]["receipt"].clone());
        }
        if assignment["revision"] != request["expected_revision"]
            || assignment["creation"]["state"] != "created"
        {
            bail!("mandate creation binding unavailable")
        }
        let operation_id = assignment["bundle"]["operation"]["id"].as_str().unwrap();
        assignment_admission::lease_gate(&tx, operation_id, at)?;
        let (run, _, operation) = assignment_resources::live(&tx, id, &assignment, at)?;
        if operation.state != State::Active || operation.lease_until.is_none_or(|until| until <= at)
        {
            bail!("mandate requires active execution lease")
        }
        let worker: Address = serde_json::from_value(assignment["worker"].clone())?;
        let local = worker.node_id == self.node_id;
        let registered: bool = if local {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
                [&worker.session_id],
                |r| r.get(0),
            )?
        } else {
            remote_workers.contains(&worker)
        };
        if !registered {
            bail!("mandate Worker is not registered")
        }
        let pack = &run["context"]["binding"]["workflow"]["pack"];
        let stage = pack["stages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == assignment["stage_id"])
            .unwrap();
        let mut inputs = serde_json::Map::new();
        for requirement in stage["requires"].as_array().unwrap() {
            let name = requirement.as_str().unwrap();
            if let Some(value) = run["inputs"].get(name) {
                inputs.insert(name.to_owned(), value.clone());
            } else {
                let waiver = &assignment["inputs"]["binding"]["waivers"][name];
                if !waiver.is_null() {
                    let typed_pack: super::workflows::Pack = serde_json::from_value(pack.clone())?;
                    let current = super::stage_waiver::require_current(&tx, &run, &typed_pack, name, at)?;
                    if waiver["decision"] != current { bail!("mandate waiver input changed"); }
                    inputs.insert(name.to_owned(), json!({"state":"waived","waiver":waiver}));
                    continue;
                }
                let source = &assignment["inputs"]["binding"]["sources"][name];
                if source.is_null() || assignment["admission"]["request"]["context"].is_null() {
                    bail!("mandate upstream evidence not available")
                }
                inputs.insert(name.to_owned(), source.clone());
            }
        }
        if !stage["independent_from"].as_array().unwrap().is_empty()
            && assignment["admission"]["request"]["context"].is_null()
        {
            bail!("mandate independent context not available")
        }
        let repository_key = stage["execution"]["repository_binding"].as_str().unwrap();
        let source_repository =
            &run["context"]["binding"]["project"]["config"]["spec"]["repositories"][repository_key];
        let mut repository = source_repository.clone();
        let authority_scope = &assignment["candidate"]["grant_scope"];
        let grant_scope = if assignment["execution_workspace"].is_null() {
            authority_scope
        } else {
            &assignment["execution_workspace"]["receipt"]["scope"]
        };
        if !assignment["execution_workspace"].is_null() {
            repository["workspace"] = json!({"host_id":grant_scope["target"]["host"],
                "workspace_id":grant_scope["target"]["workspace"],"root_ref":grant_scope["target"]["root"]});
        }
        let mut mandate = json!({"format":"kode.assignment.mandate.v1","assignment_id":id,"run_id":run["id"],"team_id":assignment["team_id"],"home_hub":self.node_id,"worker":worker,
            "operation":{"id":operation.id,"attempt":operation.attempt,"epoch":operation.epoch},"stage_attempt":assignment["stage_attempt"],"context_hash":assignment["context_hash"],"authorization_hash":assignment["authorization_hash"],
            "stage":stage,"inputs":inputs,"input_manifest":assignment["inputs"],"execution_workspace":assignment["execution_workspace"]["receipt"],"repository":repository,"source_repository":source_repository,
            "evidence_rules":pack["evidence_rules"],"grant_scope":grant_scope,"authority_scope":authority_scope,"funding":assignment["candidate"]["funding"],
            "completion_authority":"home_hub","worker_user_contact":false,"valid_until":at+86400000u64});
        let typed_stage = serde_json::from_value(stage.clone())?;
        let dependencies = super::workflow_dependencies::for_stage(&run["context"]["binding"], &typed_stage, &worker.node_id)?;
        if !dependencies.is_empty() { mandate["dependencies"] = json!(dependencies); }
        let content = serde_json::to_string(&mandate)?;
        if content.len() > MAX_CONTENT_BYTES {
            bail!("mandate exceeds durable inbox size; full input paging required")
        }
        let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
        let message = Self::insert_in(
            &tx,
            Message {
                id: uuid::Uuid::new_v4().to_string(),
                source: Address {
                    node_id: self.node_id.clone(),
                    session_id: run["context"]["team"]["superagent_id"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                },
                target: worker,
                content,
                idempotency_key: format!("mandate-{id}"),
                in_reply_to: None,
                hop_count: 0,
                created_at: at,
                expires_at: at + 86400000,
                status: if local {
                    Status::Received
                } else {
                    Status::Queued
                },
                detail: None,
            },
        )?;
        let receipt = json!({"assignment_id":id,"message_id":message.id,"mandate_hash":hash,"state":"queued","completion_authorized":false});
        assignment["mandate"] = json!({"request":request,"receipt":receipt});
        assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![assignment["run_id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_mandate_queued","at":at,"actor":{"kind":"host","id":self.node_id},"result":receipt}))?])?;
        tx.commit()?;
        Ok(receipt)
    }
}

// Remote consumption is authenticated and persisted by delivery::accept_delivery_batch.
// Choose by execution Host; never let a local record stand in for a remote receipt.
pub(super) fn consumed(db: &Connection, assignment: &Value, home: &str) -> Result<bool> {
    let Some(id) = assignment["mandate"]["receipt"]["message_id"].as_str() else {
        return Ok(false);
    };
    consumed_delivery(db, assignment, home, id)
}
pub(super) fn consumed_delivery(db: &Connection, assignment: &Value, home: &str, id: &str) -> Result<bool> {
    let local = assignment["worker"]["node_id"] == home;
    let query = if local {
        "SELECT body FROM runtime_deliveries WHERE message_id=?1"
    } else {
        "SELECT body FROM delivery_mirrors WHERE message_id=?1"
    };
    let body: Option<String> = db.query_row(query, [id], |r| r.get(0)).optional()?;
    let Some(body) = body else { return Ok(false) };
    let record: super::delivery::Record = serde_json::from_str(&body)?;
    let message: Option<String> = db
        .query_row("SELECT body FROM messages WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    let Some(message) = message else {
        return Ok(false);
    };
    let message: Message = serde_json::from_str(&message)?;
    Ok(record.message_id == id
        && record.session_id == assignment["worker"]["session_id"]
        && record.phase == super::delivery::Phase::Consumed
        && record.event_seq.is_some()
        && message.source.node_id == home
        && serde_json::to_value(message.target)? == assignment["worker"])
}
