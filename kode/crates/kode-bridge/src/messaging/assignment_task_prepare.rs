//! Home authorization before a trusted Host creates any task checkout metadata.
use super::{assignment_resources, assignment_task_workspace::{self, Workspace}, model::{now, valid_id}, operations::State, store::Store};
use anyhow::{bail, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    pub request_id: String,
    pub expected_revision: u64,
    pub input_hash: String,
    pub context_hash: String,
    pub authorization_hash: String,
    pub stage_attempt: u64,
    pub operation: Value,
    pub repository_binding: String,
    pub workspace: Workspace,
}
impl Store {
    pub fn prepare_assignment_task_workspace(&self, id: &str, input: Prepare) -> Result<Value> {
        self.prepare_assignment_task_workspace_from(&self.node_id, id, input)
    }
    pub(super) fn prepare_assignment_task_workspace_from(&self, executor: &str, id: &str, input: Prepare) -> Result<Value> {
        if !valid_id(id) || !valid_id(executor) || !valid_id(&input.request_id) || !valid_id(&input.repository_binding)
            || input.expected_revision == 0 || input.expected_revision >= i64::MAX as u64 || input.stage_attempt == 0
            || serde_json::to_vec(&input)?.len() > 32768 { bail!("invalid task worktree preparation") }
        let request = serde_json::to_value(&input)?;
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String = tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |row| row.get(0))?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["worker"]["node_id"] != executor || !assignment_task_workspace::requires(&assignment) {
            bail!("task worktree preparation requires the assigned writable execution Host")
        }
        // Replays recheck current authority, attempt, epoch and stage before returning any prior authorization.
        let (mut run, operation) = assignment_resources::authorized_context(&tx, id, &assignment, at)?;
        if input.operation != assignment["dispatch"]["command"]["operation"]
            || input.operation["id"] != operation.id || input.operation["attempt"] != operation.attempt
            || input.operation["epoch"] != operation.epoch || input.stage_attempt != assignment["stage_attempt"]
            || assignment["context_hash"] != input.context_hash || assignment["authorization_hash"] != input.authorization_hash
            || assignment["inputs"]["hash"] != input.input_hash { bail!("task worktree preparation context changed") }
        if !assignment["task_workspace_prepare"].is_null() {
            if assignment["task_workspace_prepare"]["request"] != request { bail!("task worktree preparation identity conflict") }
            return Ok(assignment["task_workspace_prepare"]["receipt"].clone())
        }
        if assignment["revision"] != input.expected_revision || assignment["state"] != "prepared"
            || assignment["dispatch"]["state"] != "blocked" || !assignment["resources"].is_null()
            || !assignment["creation"].is_null() || !assignment["admission"].is_null()
            || !assignment["execution_workspace"].is_null() || !assignment["task_workspace"].is_null()
            || operation.state != State::Prepared { bail!("task worktree preparation state conflict") }
        let pack: super::workflows::Pack = serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let execution = pack.stages.iter().find(|stage| assignment["stage_id"].as_str() == Some(stage.id.as_str()))
            .and_then(|stage| stage.execution.as_ref()).ok_or_else(|| anyhow::anyhow!("task preparation scope unavailable"))?;
        if execution.repository_binding != input.repository_binding { bail!("task worktree preparation repository mismatch") }
        let fixed = assignment_task_workspace::identity(&run, &assignment, &input.repository_binding, &input.workspace)?;
        if !run["task_workspaces"][&input.repository_binding].is_null()
            && run["task_workspaces"][&input.repository_binding] != fixed { bail!("Run task worktree preparation identity changed") }
        assignment_task_workspace::reject_shared_root(&tx, id, executor, &input.workspace.root)?;
        // Include previously authorized plans, not only final execution scopes, in cross-Run isolation.
        let others = tx.prepare("SELECT body FROM work_runs WHERE id<>?1 AND json_type(body,'$.task_workspaces')='object'")?
            .query_map([run["id"].as_str()], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for body in others {
            let other: Value = serde_json::from_str(&body)?;
            if let Some(workspaces) = other["task_workspaces"].as_object() {
                for workspace in workspaces.values().filter(|value| value["host"] == executor) {
                    let root = workspace["root"].as_str().ok_or_else(|| anyhow::anyhow!("invalid prior task workspace plan"))?;
                    if std::path::Path::new(&input.workspace.root).starts_with(root)
                        || std::path::Path::new(root).starts_with(&input.workspace.root) { bail!("task worktree preparation root belongs to another Run") }
                }
            }
        }
        if run["task_workspaces"].is_null() { run["task_workspaces"] = json!({}) }
        run["task_workspaces"][&input.repository_binding] = fixed.clone();
        let mut result = fixed;
        for (key, value) in json!({"kind":"task_worktree_preparation","assignment_id":id,"assignment_revision":input.expected_revision+1,
            "operation_id":operation.id,"attempt":operation.attempt,"epoch":operation.epoch,"input_hash":input.input_hash,
            "context_hash":input.context_hash,"authorization_hash":input.authorization_hash,"stage_attempt":input.stage_attempt,
            "provision_authorized":true,"scope_authorized":false,"execution_authorized":false,"at":at}).as_object().unwrap() {
            result[key] = value.clone();
        }
        assignment["revision"] = json!(input.expected_revision + 1);
        assignment["task_workspace_prepare"] = json!({"request":request,"receipt":result});
        run["revision"] = json!(run["revision"].as_u64().unwrap().checked_add(1).ok_or_else(|| anyhow::anyhow!("work run revision exhausted"))?);
        run["updated_at"] = json!(at);
        tx.execute("UPDATE work_assignments SET body=?2 WHERE id=?1", params![id, serde_json::to_string(&assignment)?])?;
        tx.execute("UPDATE work_runs SET revision=?2,body=?3 WHERE id=?1", params![run["id"].as_str(), run["revision"].as_u64(), serde_json::to_string(&run)?])?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)", params![run["id"].as_str(), serde_json::to_string(&json!({"kind":"assignment_task_worktree_prepared","at":at,"actor":{"kind":"host","id":executor},"receipt":result}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
