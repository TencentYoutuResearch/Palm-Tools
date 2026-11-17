//! Explicit owner task dispatch into the existing WorkRun engine. No synthetic Coordinator input.
//! Only the approved task snapshot is passed to Workers; the team's private conversation is never read.
use super::{
    model::Task,
    storage::{digest, receipt, save_receipt},
    tasks,
};
use crate::messaging::{model::valid_id, store::Store, work_runs};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::messaging) struct Dispatch {
    pub request_id: String,
    pub expected_task_revision: u64,
    pub binding_id: String,
    pub activation_revision: u64,
    pub context_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Cancel {
    pub request_id: String,
    pub expected_run_revision: u64,
    pub reason: String,
}
fn validate(input: &Dispatch) -> Result<()> {
    if !valid_id(&input.request_id)
        || !valid_id(&input.binding_id)
        || input.expected_task_revision == 0
        || input.activation_revision == 0
        || input.context_sha256.len() != 64
        || !input
            .context_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("invalid collaboration dispatch")
    }
    Ok(())
}
fn run_id(task: &str) -> String {
    format!("task-run-{}", digest(task))
}
fn namespace(task: &str) -> String {
    format!("task-dispatch:{task}")
}

/// Canonical bounded task data, not an execution grant. No channel scrollback or private transcript.
fn snapshot(db: &Connection, row: &Task) -> Result<Value> {
    let mut q = db.prepare("SELECT body FROM collaboration_task_events WHERE task_id=?1 AND kind='owner_command' AND json_extract(body,'$.payload.action')='supplement' ORDER BY seq LIMIT 51")?;
    let events = q
        .query_map([&row.id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if events.len() > 50 {
        bail!("task context requires explicit compaction")
    }
    let mut commands = Vec::new();
    for raw in events {
        let event: Value = serde_json::from_str(&raw)?;
        let payload = &event["payload"];
        // Only already-published text enters this snapshot. No source message, actor secret or DM history.
        if matches!(payload["action"].as_str(), Some("supplement")) {
            commands.push(json!({"sequence":event["sequence"],"action":payload["action"],"content":payload["content"],"worker_id":payload["worker_id"]}));
        }
    }
    let context = json!({"format":"kode.collaboration.task-context.v2","task_id":row.id,
        "execution_revision":row.execution_revision.unwrap_or(row.revision),"context_id":row.context_id,"scope":row.scope,
        "team_id":row.team_id,"summary":row.summary,"published_commands":commands});
    if serde_json::to_vec(&context)?.len() > 48000 {
        bail!("task context exceeds execution bound; explicit compaction required")
    }
    Ok(context)
}
fn fingerprint(context: &Value) -> Result<String> {
    Ok(digest(&serde_json::to_string(context)?))
}

pub(super) fn frozen_authority(
    db: &Connection,
    home: &str,
    row: &Task,
    input: &Dispatch,
    run: &Value,
) -> Result<Value> {
    tasks::guard(db, home, row)?;
    if row.state != "recorded"
        || row.revision != input.expected_task_revision
        || run["team_id"] != row.team_id
        || run["team_revision"] != row.team_revision
    {
        bail!("task revision, team or state changed")
    }
    let context = snapshot(db, row)?;
    if fingerprint(&context)? != input.context_sha256 {
        bail!("approved task context changed")
    }
    let expected_input = serde_json::to_string(&context)?;
    if run["inputs"] != json!({"request":expected_input}) || !run["prior_run_id"].is_null() {
        bail!("task execution must use only the approved isolated input")
    }
    let binding = &run["context"]["binding"];
    if binding["id"] != input.binding_id
        || binding["workflow"]["pack"]["inputs"] != json!(["request"])
    {
        bail!("task dispatch supports a single request workflow input")
    }
    let repositories = binding["project"]["config"]["spec"]["repositories"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("missing execution repository binding"))?;
    if repositories.is_empty()
        || repositories.values().any(|r| {
            let w = &r["workspace"];
            w["host_id"] != row.scope.host_id
                || w["workspace_id"] != row.scope.workspace_id
                || w["root_ref"] != row.scope.root_ref
        })
    {
        bail!("execution binding expands beyond the task workspace")
    }
    let targets = binding["delivery_policy"]["config"]["spec"]["targets"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing delivery target"))?;
    if targets.is_empty() || targets.iter().any(|t| t["kind"] != "local") {
        bail!("task dispatch currently requires authorized local delivery; external adapter unavailable")
    }
    let stages = binding["workflow"]["pack"]["stages"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing execution stages"))?;
    if stages.is_empty()
        || stages.iter().any(|stage| {
            let scope = &stage["execution"];
            !scope.is_object()
                || scope["network"] != false
                || !scope["capabilities"].as_array().is_some_and(|caps| {
                    !caps.is_empty()
                        && caps
                            .iter()
                            .all(|cap| matches!(cap.as_str(), Some("read" | "workspace_write")))
                })
        })
    {
        bail!("task dispatch requires supported local read/workspace_write execution stages")
    }
    let pack: crate::messaging::workflows::Pack =
        serde_json::from_value(binding["workflow"]["pack"].clone())?;
    if pack
        .stages
        .iter()
        .any(|stage| crate::messaging::stage_completion::static_proof(&pack, stage).is_none())
    {
        bail!("task dispatch requires supported artifact/review/verification evidence shapes")
    }
    let activation = crate::messaging::team_activation::authorized(
        db,
        &row.team_id,
        row.team_revision,
        crate::messaging::model::now(),
    )?
    .ok_or_else(|| anyhow::anyhow!("task requires current team activation"))?;
    if activation["revision"] != input.activation_revision {
        bail!("team activation changed")
    }
    Ok(
        json!({"format":"kode.collaboration.work-source.v2","task_id":row.id,"task_revision":row.revision,"execution_revision":row.execution_revision.unwrap_or(row.revision),
        "context_id":row.context_id,"context_sha256":input.context_sha256,"scope":row.scope,
        "archive_surface_id":row.archive_surface_id,"thread_id":row.thread_id,
        "origin_audience_revision":row.origin_audience_revision,"archive_audience_revision":row.archive_audience_revision,
        "request_id":input.request_id,"binding_id":input.binding_id,"activation_revision":input.activation_revision}),
    )
}
/// Called inside WorkRun's authoritative creation transaction, before any insert/reservation.
pub(in crate::messaging) fn authorize(
    db: &Connection,
    home: &str,
    id: &str,
    input: &Dispatch,
    run: &Value,
) -> Result<Value> {
    validate(input)?;
    let row = tasks::task(db, id)?;
    if row.work_run_id.is_some() || run["id"] != run_id(id) {
        bail!("task already has an execution identity")
    }
    frozen_authority(db, home, &row, input, run)
}
/// WorkRun and task identity commit atomically. Does not claim a Worker was started.
pub(in crate::messaging) fn record(
    db: &Connection,
    home: &str,
    id: &str,
    input: &Dispatch,
    run: &Value,
) -> Result<()> {
    let mut row = tasks::task(db, id)?;
    tasks::guard(db, home, &row)?;
    row.work_run_id = Some(run_id(id));
    row.dispatch_state = "work_run_recorded".into();
    db.execute(
        "UPDATE collaboration_tasks SET body=?1 WHERE id=?2",
        params![serde_json::to_string(&row)?, id],
    )?;
    let result = json!({"task_id":id,"work_run_id":run["id"],"context_sha256":input.context_sha256,
        "state":run["state"],"dispatch_state":run["dispatch_state"],"completion_authorized":false});
    tasks::event(db, &row, "work_run_recorded", result.clone())?;
    save_receipt(
        db,
        &namespace(id),
        &input.request_id,
        &serde_json::to_value(input)?,
        &result,
    )?;
    Ok(())
}
pub(in crate::messaging) fn validate_retry(
    db: &Connection,
    home: &str,
    id: &str,
    input: &Dispatch,
    run: &Value,
) -> Result<()> {
    let row = tasks::task(db, id)?;
    tasks::guard(db, home, &row)?;
    if row.work_run_id.as_deref() != run["id"].as_str()
        || run["collaboration"]["request_id"] != input.request_id
        || receipt(
            db,
            &namespace(id),
            &input.request_id,
            &serde_json::to_value(input)?,
        )?
        .is_none()
    {
        bail!("task execution receipt conflict")
    }
    Ok(())
}
/// Recheck task/audience/workspace at every new stage, admission and delivery. Cancelling remains possible.
pub(in crate::messaging) fn admit_run(db: &Connection, run: &Value) -> Result<()> {
    let source = &run["collaboration"];
    if source.is_null() {
        return Ok(());
    }
    let id = source["task_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing task source"))?;
    let home = run["home_hub"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing task home"))?;
    let row = tasks::task(db, id)?;
    tasks::guard(db, home, &row)?;
    if source["scope"] != serde_json::to_value(&row.scope)?
        || row.state != "recorded"
        || row.work_run_id.as_deref() != run["id"].as_str()
        || source["archive_surface_id"] != row.archive_surface_id
        || source["thread_id"] != row.thread_id
        || run["team_id"] != row.team_id
        || run["team_revision"] != row.team_revision
    {
        bail!("collaboration task scope or approved context no longer current")
    }
    match source["format"].as_str() {
        Some("kode.collaboration.work-source.v2") => {
            if source["execution_revision"] != row.execution_revision.unwrap_or(row.revision)
                || source["context_sha256"] != fingerprint(&snapshot(db, &row)?)?
            {
                bail!("collaboration execution context changed")
            }
        }
        Some("kode.collaboration.work-source.v1") => legacy_context(db, &row, run)?,
        _ => bail!("unsupported collaboration work source"),
    }
    Ok(())
}
/// Preserve frozen v1 executions across upgrade. Never turn a later amendment into prior approval.
fn legacy_context(db: &Connection, row: &Task, run: &Value) -> Result<()> {
    let source = &run["collaboration"];
    let raw = run["inputs"]["request"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("legacy task input missing"))?;
    let frozen: Value = serde_json::from_str(raw)?;
    if frozen["format"] != "kode.collaboration.task-context.v1"
        || source["context_sha256"] != fingerprint(&frozen)?
        || frozen["task_revision"] != source["task_revision"]
        || frozen["task_id"] != row.id
        || frozen["scope"] != serde_json::to_value(&row.scope)?
        || frozen["context_id"] != row.context_id
        || frozen["team_id"] != row.team_id
        || frozen["summary"] != row.summary
    {
        bail!("legacy task snapshot changed")
    }
    let boundary:u64=db.query_row("SELECT seq FROM collaboration_task_events WHERE task_id=?1 AND kind='work_run_recorded' AND json_extract(body,'$.payload.work_run_id')=?2 ORDER BY seq LIMIT 1",params![row.id,run["id"].as_str()],|r|r.get(0))?;
    let changed:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_task_events WHERE task_id=?1 AND seq>?2 AND kind='owner_command' AND json_extract(body,'$.payload.action')!='question')",params![row.id,boundary],|r|r.get(0))?;
    if changed {
        bail!("legacy task amendment requires explicit reauthorization")
    }
    Ok(())
}
/// Reuse the canonical cancellation transaction when an existing task receives owner cancel.
/// The task receipt and the operation fencing either both commit or neither commits.
pub(super) fn cancel_in(
    tx: &Transaction,
    home: &str,
    row: &Task,
    request_id: &str,
) -> Result<Value> {
    let Some(id) = row.work_run_id.as_deref() else {
        return Ok(Value::Null);
    };
    let body: String =
        tx.query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))?;
    let mut run: Value = serde_json::from_str(&body)?;
    if run["collaboration"]["task_id"] != row.id
        || run["team_id"] != row.team_id
        || run["home_hub"] != home
    {
        bail!("task execution scope invalid")
    }
    // A separate owner stop may already be in flight; do not restart or fake its receipt.
    if matches!(
        run["state"].as_str(),
        Some("cancelling" | "cancel_unconfirmed" | "cancelled")
    ) {
        return Ok(
            json!({"work_run_id":id,"state":run["state"],"stop_confirmed":run["state"]=="cancelled"}),
        );
    }
    let request_id = format!("task-cancel-{}", digest(request_id));
    let reason = "Owner requested cancellation through the collaboration task";
    let command = work_runs::Command::RequestCancel {
        request_id: request_id.clone(),
        expected_revision: run["revision"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("missing run revision"))?,
        reason: reason.into(),
    };
    crate::messaging::work_run_cancellation::request(
        tx,
        id,
        &mut run,
        &request_id,
        reason,
        &serde_json::to_string(&command)?,
    )?;
    Ok(json!({"work_run_id":id,"state":run["state"],"stop_confirmed":false}))
}

impl Store {
    pub(super) fn collaboration_execution(&self, id: &str) -> Result<Value> {
        let db = self.db.lock();
        let row = tasks::task(&db, id)?;
        tasks::guard(&db, &self.node_id, &row)?;
        let mut context = snapshot(&db, &row)?;
        let run = match row.work_run_id.as_deref() {
            None => Value::Null,
            Some(run_id) => {
                let body: String =
                    db.query_row("SELECT body FROM work_runs WHERE id=?1", [run_id], |r| {
                        r.get(0)
                    })?;
                let run: Value = serde_json::from_str(&body)?;
                context = serde_json::from_str(
                    run["inputs"]["request"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("task execution input missing"))?,
                )?;
                json!({"id":run["id"],"revision":run["revision"],"state":run["state"],"waiting_reason":run["waiting_reason"],
                    "dispatch_state":run["dispatch_state"],"completion_authorized":run["completion_authorized"],
                    "task_context_current":admit_run(&db,&run).is_ok(),"clarifications":crate::messaging::assignment_clarification::pending(&run)})
            }
        };
        Ok(
            json!({"task_id":id,"task_revision":row.revision,"context_sha256":fingerprint(&context)?,
            "context":context,"context_basis":if row.work_run_id.is_some(){"frozen_execution"}else{"current_task"},"work_run":run,"execution_authorized":false,
            "dispatch_mode":"explicit_owner_workflow","automatic_coordinator_dispatch":false}),
        )
    }
    pub(super) fn dispatch_collaboration_task(&self, id: &str, input: Dispatch) -> Result<Value> {
        validate(&input)?;
        let (row, context) = {
            let db = self.db.lock();
            let row = tasks::task(&db, id)?;
            tasks::guard(&db, &self.node_id, &row)?;
            if let Some(prior) = receipt(
                &db,
                &namespace(id),
                &input.request_id,
                &serde_json::to_value(&input)?,
            )? {
                return Ok(prior);
            }
            let context = snapshot(&db, &row)?;
            (row, context)
        };
        let create = work_runs::Create {
            id: run_id(id),
            request_id: run_id(id),
            team_id: row.team_id,
            team_revision: row.team_revision,
            binding_id: input.binding_id.clone(),
            inputs: BTreeMap::from([("request".into(), serde_json::to_string(&context)?)]),
            prior_run_id: None,
        };
        self.create_work_run_bound(create, None, Some((id, &input)))?;
        let db = self.db.lock();
        receipt(
            &db,
            &namespace(id),
            &input.request_id,
            &serde_json::to_value(&input)?,
        )?
        .ok_or_else(|| anyhow::anyhow!("task dispatch receipt unavailable"))
    }
    /// Cancellation is owner-controlled and remains available after audience revocation.
    /// Existing WorkRun cancellation handles stop/drain/accounting; this endpoint cannot assert completion.
    pub(super) fn cancel_collaboration_execution(&self, id: &str, input: Cancel) -> Result<Value> {
        let run_id = {
            let db = self.db.lock();
            let row = tasks::task(&db, id)?;
            if row.scope.home_hub != self.node_id {
                bail!("task belongs to another home")
            }
            let run_id = row
                .work_run_id
                .ok_or_else(|| anyhow::anyhow!("task has no execution"))?;
            let body: String =
                db.query_row("SELECT body FROM work_runs WHERE id=?1", [&run_id], |r| {
                    r.get(0)
                })?;
            let run: Value = serde_json::from_str(&body)?;
            if run["collaboration"]["task_id"] != id
                || run["team_id"] != row.team_id
                || run["home_hub"] != self.node_id
            {
                bail!("task execution scope invalid")
            }
            run_id
        };
        let result = self.command_work_run(
            &run_id,
            work_runs::Command::RequestCancel {
                request_id: input.request_id,
                expected_revision: input.expected_run_revision,
                reason: input.reason,
            },
        )?;
        Ok(
            json!({"task_id":id,"work_run_id":run_id,"revision":result["revision"],"state":result["state"],
            "waiting_reason":result["waiting_reason"],"stop_confirmed":result["state"]=="cancelled"}),
        )
    }
}
