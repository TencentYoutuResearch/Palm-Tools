//! Trusted local Host admission after concrete official tool/configuration/lock validation.
use super::{
    assignment_resources,
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admit {
    pub request_id: String,
    pub expected_revision: u64,
    pub worker_session: String,
    pub profile_revision: String,
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub tools: Vec<String>,
    pub root: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclusive_resources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclusive_resource_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<FreshContext>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FreshContext {
    pub kind: String,
    pub session_id: String,
    pub event_count: u64,
    pub input_hash: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub snapshot_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_workspace_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_start_snapshot_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_metadata: Option<FreshPolicyMetadata>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FreshPolicyMetadata {
    pub event_types: Vec<String>,
    pub event_hash: String,
}
impl FreshContext {
    pub(super) fn empty_transcript(&self) -> bool {
        if self.kind == "official_fresh_empty" {
            return self.event_count == 0 && self.policy_metadata.is_none();
        }
        let Some(metadata) = &self.policy_metadata else {
            return false;
        };
        self.kind == "official_fresh_policy_metadata"
            && self.event_count > 0
            && self.event_count <= 3
            && self.event_count == metadata.event_types.len() as u64
            && metadata.event_hash.len() == 64
            && metadata
                .event_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && metadata.event_types.iter().all(|kind| {
                matches!(
                    kind.as_str(),
                    "permission/preset" | "sandbox/mode" | "approval/policy"
                )
            })
            && metadata
                .event_types
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                == metadata.event_types.len()
    }
}

#[cfg(test)]
mod context_tests {
    use super::*;
    #[test]
    fn fresh_transcript_metadata_is_explicit_bounded_and_not_message_history() {
        let base = json!({"kind":"official_fresh_empty","session_id":"worker","event_count":0,"input_hash":"a".repeat(64),"snapshot_hash":"b".repeat(64)});
        let parse = |value| serde_json::from_value::<FreshContext>(value).unwrap();
        assert!(parse(base.clone()).empty_transcript());
        let mut policy = base.clone();
        policy["kind"] = json!("official_fresh_policy_metadata");
        policy["event_count"] = json!(3);
        policy["policy_metadata"] = json!({"event_types":["permission/preset","sandbox/mode","approval/policy"],"event_hash":"c".repeat(64)});
        assert!(parse(policy.clone()).empty_transcript());
        for types in [
            json!(["user/message"]),
            json!(["approval/policy", "approval/policy"]),
            json!(["plugin:unknown"]),
        ] {
            let mut invalid = policy.clone();
            invalid["event_count"] = json!(types.as_array().unwrap().len());
            invalid["policy_metadata"]["event_types"] = types;
            assert!(!parse(invalid).empty_transcript());
        }
        for (key, value) in [
            ("event_count", json!(0)),
            ("event_count", json!(4)),
            ("kind", json!("official_fresh_empty")),
        ] {
            let mut invalid = policy.clone();
            invalid[key] = value;
            assert!(!parse(invalid).empty_transcript());
        }
        policy["policy_metadata"]["event_hash"] = json!("invalid");
        assert!(!parse(policy).empty_transcript());
    }
}
pub(super) fn lease_gate(db: &Connection, operation: &str, at: u64) -> Result<()> {
    gate(db, operation, at, true)
}
/// Reporting preserves authority and ownership checks without admitting new execution.
pub(super) fn report_gate(db: &Connection, operation: &str, at: u64) -> Result<()> {
    gate(db, operation, at, false)
}
fn gate(db: &Connection, operation: &str, at: u64, execution: bool) -> Result<()> {
    let body: Option<String> = db
        .query_row(
            "SELECT body FROM work_assignments WHERE operation_id=?1",
            [operation],
            |r| r.get(0),
        )
        .optional()?;
    let Some(body) = body else { return Ok(()) };
    let assignment: Value = serde_json::from_str(&body)?;
    if assignment["state"] != "prepared"
        || assignment["dispatch"]["state"] != "ready"
        || assignment["admission"].is_null()
    {
        bail!("work assignment is not admitted for dispatch")
    }
    if execution {
        assignment_resources::live(db, assignment["id"].as_str().unwrap(), &assignment, at)?;
    } else {
        let home: String = db.query_row("SELECT json_extract(body,'$.home_hub') FROM work_runs WHERE id=?1",[assignment["run_id"].as_str()],|r|r.get(0))?;
        super::assignment_answer_progress::require_resolved(db, &assignment, &home)?;
        assignment_resources::authorized_context(
            db,
            assignment["id"].as_str().unwrap(),
            &assignment,
            at,
        )?;
    }
    assignment_resources::assert_held(db, &assignment)
}
impl Store {
    pub fn admit_work_assignment(&self, id: &str, input: Admit) -> Result<Value> {
        self.admit_work_assignment_from(&self.node_id, id, input)
    }
    pub(super) fn admit_work_assignment_from(
        &self,
        executor: &str,
        id: &str,
        mut input: Admit,
    ) -> Result<Value> {
        if !valid_id(executor)
            || !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.worker_session)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
            || input.tools.len() > 256
            || input.exclusive_resources.len() > 16
            || input.exclusive_resources.iter().any(|id| !valid_id(id))
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid assignment admission")
        }
        input.tools.sort();
        input.exclusive_resources.sort();
        if input
            .exclusive_resources
            .windows(2)
            .any(|pair| pair[0] == pair[1])
        {
            bail!("duplicate admission exclusive resource")
        }
        if input.tools.windows(2).any(|w| w[0] == w[1]) {
            bail!("duplicate admission tool")
        }
        let request = serde_json::to_value(&input)?;
        let key = format!("assignment-admission:{id}:{}", input.request_id);
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["worker"]["node_id"] != executor
            || assignment["worker"]["session_id"] != input.worker_session
        {
            bail!("assignment Host identity required")
        }
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            let receipt: Value = serde_json::from_str(&previous)?;
            if receipt["request"] != request {
                bail!("assignment admission identity conflict")
            }
            return Ok(receipt["result"].clone());
        }
        if assignment["revision"] != input.expected_revision
            || assignment["state"] != "prepared"
            || assignment["dispatch"]["state"] != "blocked"
        {
            bail!("assignment admission state conflict")
        }
        let command = &assignment["dispatch"]["command"];
        let mut tools: Vec<String> = serde_json::from_value(command["tools"].clone())?;
        tools.sort();
        if command["profile_revision"] != input.profile_revision
            || command["provider"] != input.provider
            || command["model"] != input.model
            || (!command["effort"].is_null() && command["effort"] != json!(input.effort))
            || command["cwd"] != input.root
            || tools != input.tools
        {
            bail!("assignment executor evidence mismatch")
        }
        // Later stages require exact upstream artifact/context admission, not just a distinct session ID.
        let (run, _, operation) = assignment_resources::live(&tx, id, &assignment, at)?;
        if (if input.exclusive_resources.is_empty() {
            input.exclusive_resource_scope.is_some()
        } else {
            input.exclusive_resource_scope.as_deref() != Some("home")
        }) || input.exclusive_resources
            != super::assignment_exclusive_resources::names(&run, &assignment)?
            || input.exclusive_resources
                != super::assignment_exclusive_resources::held_names(&assignment)?
        {
            bail!("assignment exclusive resource evidence mismatch")
        }
        let pack: super::workflows::Pack =
            serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let stage = pack
            .stages
            .iter()
            .find(|s| s.id == assignment["stage_id"])
            .unwrap();
        super::workflow_dependencies::for_stage(&run["context"]["binding"], stage, executor)?;
        if super::assignment_task_workspace::requires(&assignment) || !stage.independent_from.is_empty()
            || stage.requires.iter().any(|r| !pack.inputs.contains(r))
        {
            let derived = &assignment["execution_workspace"]["receipt"];
            let context = input
                .context
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("stage fresh context evidence required"))?;
            if derived["scope_authorized"] != true
                || derived["scope"]["target"]["root"] != input.root
                || !context.empty_transcript()
                || context.session_id != input.worker_session
                || assignment["inputs"]["hash"] != context.input_hash
                || (if derived["kind"] == "derived_task_worktree" {
                    derived["key"] != json!(context.task_workspace_key) || !context.snapshot_hash.is_empty()
                        || derived["starting_snapshot"]["snapshot_hash"] != json!(context.task_start_snapshot_hash)
                } else {
                    derived["snapshot_hash"] != context.snapshot_hash || context.task_workspace_key.is_some() || context.task_start_snapshot_hash.is_some()
                })
            {
                bail!("stage input context binding mismatch")
            }
            for prior in &stage.independent_from {
                let waiver = &assignment["inputs"]["binding"]["waivers"][prior];
                if !waiver.is_null() {
                    let current =
                        super::stage_waiver::require_current(&tx, &run, &pack, prior, at)?;
                    if waiver["decision"] != current {
                        bail!("independent waiver input changed");
                    }
                    if waiver["producer"].is_null() {
                        continue;
                    }
                    if waiver["producer"]["worker"]["session_id"] == input.worker_session
                        || waiver["producer"]["operation"]["id"] == operation.id
                    {
                        bail!("stage independent waived producer identity mismatch");
                    }
                    continue;
                }
                let source = &assignment["inputs"]["binding"]["sources"][prior];
                if source.is_null()
                    || source["worker"]["session_id"] == input.worker_session
                    || source["operation"]["id"] == operation.id
                {
                    bail!("stage independent producer identity mismatch")
                }
            }
        }
        if operation.state != super::operations::State::Prepared
            || assignment["bundle"]["operation"]["revision"] != operation.revision
        {
            bail!("assignment operation changed")
        }
        assignment_resources::assert_held(&tx, &assignment)?;
        assignment["revision"] = json!(input.expected_revision + 1);
        assignment["dispatch"]["state"] = json!("ready");
        assignment["admission"] = json!({"kind":if executor == self.node_id { "official_local_host" } else { "official_remote_host" },"request":request,"at":at,"inference_verified":false});
        let result = json!({"assignment_id":id,"assignment_revision":assignment["revision"],"state":"ready","operation_id":operation.id,"worker":assignment["worker"],"admission":assignment["admission"]});
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute(
            "UPDATE work_dispatch_outbox SET state='ready' WHERE assignment_id=?1",
            [id],
        )?;
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key,
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![assignment["run_id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_host_admitted","at":at,"actor":{"kind":"host","id":executor},"result":result}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
