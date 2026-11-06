//! Trusted Host task checkout receipts; Home alone derives execution scope from an existing grant.
use super::{assignment_resources, model::{now, valid_id}, operations::State, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub key: String,
    pub repository: String,
    pub common_dir: String,
    pub root: String,
    pub branch: String,
    pub base_commit: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: String,
    pub expected_revision: u64,
    pub input_hash: String,
    pub context_hash: String,
    pub authorization_hash: String,
    pub stage_attempt: u64,
    pub operation: Value,
    pub repository_binding: String,
    pub workspace: Workspace,
    #[serde(default)]
    pub starting_snapshot: Value,
}
pub(super) fn requires(assignment: &Value) -> bool {
    assignment["candidate"]["grant_scope"]["capabilities"].as_array()
        .is_some_and(|caps| caps.iter().any(|c| c == "workspace_write"))
}
pub(super) fn assert_bound(assignment: &Value) -> Result<()> {
    if !requires(assignment) { return Ok(()) }
    let derived = &assignment["execution_workspace"]["receipt"];
    let authority = &assignment["candidate"]["grant_scope"];
    let mut scope = authority.clone();
    scope["target"]["root"] = derived["root"].clone();
    scope["target"]["workspace"] = json!(format!("task-{}", derived["key"].as_str().unwrap_or_default()));
    if derived["kind"] != "derived_task_worktree" || derived["scope_authorized"] != true
        || derived["execution_authorized"] != false || derived["authority_scope"] != *authority
        || derived["scope"] != scope || derived["assignment_id"] != assignment["id"]
        || derived["operation_id"] != assignment["bundle"]["operation"]["id"]
        || derived["attempt"] != assignment["bundle"]["operation"]["attempt"]
        || derived["epoch"] != assignment["bundle"]["operation"]["epoch"]
        || derived["input_hash"] != assignment["inputs"]["hash"]
        || derived["root"] != assignment["dispatch"]["command"]["cwd"]
        || assignment["task_workspace"]["receipt"] != *derived {
        bail!("automatic writable Assignment requires its authorized task worktree")
    }
    Ok(())
}
fn normalized(path: &str) -> bool {
    path.len() <= 4096 && path.starts_with('/') && !path.contains('\0')
        && path.split('/').skip(1).all(|part| !part.is_empty() && part != "." && part != "..")
}
pub(super) fn identity(run: &Value, assignment: &Value, repository_binding: &str, workspace: &Workspace) -> Result<Value> {
    let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&json!([
        run["home_hub"], run["id"], repository_binding, assignment["worker"]["node_id"]
    ]))?));
    let hash = &workspace.base_commit;
    if workspace.key != key || workspace.branch != format!("kode/task-{key}")
        || ![40,64].contains(&hash.len()) || !hash.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || ![&workspace.repository, &workspace.common_dir, &workspace.root].iter().all(|p| normalized(p))
        || std::path::Path::new(&workspace.root).starts_with(&workspace.repository)
        || std::path::Path::new(&workspace.repository).starts_with(&workspace.root)
        || assignment["candidate"]["grant_scope"]["target"]["root"] != workspace.repository {
        bail!("invalid task worktree Git identity")
    }
    let mut value = serde_json::to_value(workspace)?;
    value["home"] = run["home_hub"].clone();
    value["run_id"] = run["id"].clone();
    value["host"] = assignment["worker"]["node_id"].clone();
    value["repository_binding"] = json!(repository_binding);
    Ok(value)
}
impl Store {
    pub fn assignment_task_workspace(&self, id: &str, input: Receipt) -> Result<Value> {
        self.assignment_task_workspace_from(&self.node_id, id, input)
    }
    pub(super) fn assignment_task_workspace_from(&self, executor: &str, id: &str, input: Receipt) -> Result<Value> {
        if !valid_id(id) || !valid_id(executor) || !valid_id(&input.request_id) || !valid_id(&input.repository_binding)
            || input.expected_revision == 0 || input.expected_revision >= i64::MAX as u64
            || input.stage_attempt == 0 || serde_json::to_vec(&input)?.len() > 32768 {
            bail!("invalid task worktree receipt")
        }
        let request = serde_json::to_value(&input)?;
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String = tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| r.get(0))?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["worker"]["node_id"] != executor || !requires(&assignment) {
            bail!("task worktree requires the assigned writable execution Host")
        }
        // Validate current authority even on replay: an immutable old receipt cannot authorize a new attempt.
        let (mut run, operation) = assignment_resources::authorized_context(&tx, id, &assignment, at)?;
        if input.operation != assignment["dispatch"]["command"]["operation"]
            || input.operation["id"] != operation.id || input.operation["attempt"] != operation.attempt
            || input.operation["epoch"] != operation.epoch || input.stage_attempt != assignment["stage_attempt"]
            || assignment["context_hash"] != input.context_hash || assignment["authorization_hash"] != input.authorization_hash
            || assignment["inputs"]["hash"] != input.input_hash {
            bail!("task worktree current context or operation changed")
        }
        if !assignment["task_workspace"].is_null() {
            if assignment["task_workspace"]["request"] != request { bail!("task worktree receipt identity conflict") }
            assert_bound(&assignment)?;
            return Ok(assignment["task_workspace"]["receipt"].clone())
        }
        if assignment["revision"] != input.expected_revision || assignment["state"] != "prepared"
            || assignment["dispatch"]["state"] != "blocked" || !assignment["resources"].is_null()
            || !assignment["creation"].is_null() || !assignment["admission"].is_null()
            || !assignment["execution_workspace"].is_null() || operation.state != State::Prepared {
            bail!("task worktree receipt state conflict")
        }
        let pack: super::workflows::Pack = serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let execution = pack.stages.iter().find(|s| s.id == assignment["stage_id"])
            .and_then(|s| s.execution.as_ref()).ok_or_else(|| anyhow::anyhow!("task execution scope unavailable"))?;
        if execution.repository_binding != input.repository_binding { bail!("task worktree repository binding mismatch") }
        let fixed = identity(&run, &assignment, &input.repository_binding, &input.workspace)?;
        let preparation = &assignment["task_workspace_prepare"];
        let mut prepared_request = request.clone();
        prepared_request.as_object_mut().unwrap().remove("starting_snapshot");
        prepared_request["request_id"] = preparation["request"]["request_id"].clone();
        prepared_request["expected_revision"] = preparation["request"]["expected_revision"].clone();
        if preparation["request"] != prepared_request
            || preparation["receipt"]["assignment_revision"] != input.expected_revision
            || preparation["receipt"]["provision_authorized"] != true {
            bail!("task worktree requires its exact Home preparation authorization")
        }
        let expected_input = super::assignment_task_input::freeze(&tx, &run, &assignment)?;
        if assignment["task_workspace_input"] != expected_input { bail!("task frozen input content basis changed") }
        super::assignment_task_input::validate(&expected_input, &input.starting_snapshot)?;
        if !run["task_workspaces"][&input.repository_binding].is_null()
            && run["task_workspaces"][&input.repository_binding] != fixed { bail!("Run task worktree identity changed") }
        // Distinct Runs must never acquire another task's root, even if a trusted Host submits an inconsistent receipt.
        reject_shared_root(&tx, id, executor, &input.workspace.root)?;
        if run["task_workspaces"].is_null() { run["task_workspaces"] = json!({}) }
        run["task_workspaces"][&input.repository_binding] = fixed.clone();
        let mut scope = assignment["candidate"]["grant_scope"].clone();
        scope["target"]["root"] = json!(input.workspace.root);
        scope["target"]["workspace"] = json!(format!("task-{}", input.workspace.key));
        let mut result = fixed;
        for (key, value) in json!({"kind":"derived_task_worktree","assignment_id":id,"assignment_revision":input.expected_revision+1,
            "operation_id":operation.id,"attempt":operation.attempt,"epoch":operation.epoch,"input_hash":input.input_hash,
            "scope":scope,"authority_scope":assignment["candidate"]["grant_scope"],"starting_snapshot":input.starting_snapshot,"scope_authorized":true,"execution_authorized":false,"at":at}).as_object().unwrap() {
            result[key] = value.clone();
        }
        assignment["revision"] = json!(input.expected_revision + 1);
        assignment["task_workspace"] = json!({"request":request,"receipt":result});
        assignment["execution_workspace"] = assignment["task_workspace"].clone();
        assignment["dispatch"]["command"]["cwd"] = scope["target"]["root"].clone();
        run["revision"] = json!(run["revision"].as_u64().unwrap().checked_add(1).ok_or_else(|| anyhow::anyhow!("work run revision exhausted"))?);
        run["updated_at"] = json!(at);
        tx.execute("UPDATE work_assignments SET body=?2 WHERE id=?1", params![id,serde_json::to_string(&assignment)?])?;
        tx.execute("UPDATE work_dispatch_outbox SET body=?2 WHERE assignment_id=?1",params![id,serde_json::to_string(&assignment["dispatch"]["command"])?])?;
        tx.execute("UPDATE work_runs SET revision=?2,body=?3 WHERE id=?1",params![run["id"].as_str(),run["revision"].as_u64(),serde_json::to_string(&run)?])?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![run["id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_task_worktree_authorized","at":at,"actor":{"kind":"host","id":executor},"receipt":result}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
pub(super) fn reject_shared_root(db: &Connection, id: &str, host: &str, root: &str) -> Result<()> {
    let run: String = db.query_row("SELECT run_id FROM work_assignments WHERE id=?1", [id], |r| r.get(0))?;
    let bodies = db.prepare("SELECT body FROM work_assignments WHERE run_id<>?1 AND json_extract(body,'$.worker.node_id')=?2 AND json_extract(body,'$.execution_workspace.receipt.kind')='derived_task_worktree'")?
        .query_map(params![run,host], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for body in bodies {
        let other: Value = serde_json::from_str(&body)?;
        let other_root = other["execution_workspace"]["receipt"]["root"].as_str().unwrap();
        if std::path::Path::new(root).starts_with(other_root) || std::path::Path::new(other_root).starts_with(root) {
            bail!("task worktree root belongs to another Run")
        }
    }
    Ok(())
}
