//! Home-owned account/workspace holds. They do not attest physical Host locks or executor readiness.
use super::{
    model::{now, valid_id},
    operations::Operation,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
/// A definite admission refusal, not an uncertain execution or transport failure.
#[derive(Debug)]
pub enum ResourceWait {
    AccountCapacity,
    WorkspaceBusy,
    ExclusiveResourceBusy,
}
impl ResourceWait {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AccountCapacity => "assignment_account_capacity_exhausted",
            Self::WorkspaceBusy => "assignment_workspace_busy",
            Self::ExclusiveResourceBusy => "assignment_exclusive_resource_busy",
        }
    }
}
impl std::fmt::Display for ResourceWait {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::AccountCapacity => "assignment account capacity exhausted",
            Self::WorkspaceBusy => "assignment workspace already reserved",
            Self::ExclusiveResourceBusy => "assignment exclusive resource already reserved",
        })
    }
}
impl std::error::Error for ResourceWait {}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capacity {
    pub account_id: String,
    pub expected_revision: u64,
    pub max_active_assignments: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reserve {
    pub request_id: String,
    pub expected_revision: u64,
}
impl Store {
    pub fn assignment_capacity(&self, account: &str) -> Result<Option<Value>> {
        if !valid_id(account) {
            bail!("invalid resource account")
        }
        let db = self.db.lock();
        let row: Option<(u64, u32)> = db
            .query_row(
                "SELECT revision,capacity FROM assignment_account_capacities WHERE account_id=?1",
                [account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(revision,capacity)| {
            let held:u64=db.query_row("SELECT COUNT(*) FROM assignment_resource_holds WHERE account_id=?1 AND state='held'",[account],|r|r.get(0))?;
            Ok(json!({"account_id":account,"revision":revision,"max_active_assignments":capacity,"held":held}))
        }).transpose()
    }
    pub fn configure_assignment_capacity(&self, input: Capacity) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = configure_capacity_in(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn reserve_assignment_resources(&self, id: &str, input: Reserve) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid assignment resource command")
        }
        let request = serde_json::to_value(&input)?;
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let old: Option<(String, String)> = tx
            .query_row(
                "SELECT request,receipt FROM assignment_resource_holds WHERE assignment_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior, receipt)) = old {
            if serde_json::from_str::<Value>(&prior)? != request {
                bail!("assignment resource identity conflict")
            }
            return Ok(serde_json::from_str(&receipt)?);
        }
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["revision"] != input.expected_revision
            || assignment["state"] != "prepared"
            || assignment["dispatch"]["state"] != "blocked"
        {
            bail!("assignment resource state conflict")
        }
        let (run, rank, operation) = live(&tx, id, &assignment, at)?;
        if operation.state != super::operations::State::Prepared
            || assignment["bundle"]["operation"]["revision"] != operation.revision
        {
            bail!("assignment operation changed")
        }
        super::assignment_task_workspace::assert_bound(&assignment)?;
        let candidate = &assignment["candidate"];
        let account = candidate["resource"]["account_id"].as_str().unwrap();
        let (capacity_revision, capacity): (u64, u32) = tx
            .query_row(
                "SELECT revision,capacity FROM assignment_account_capacities WHERE account_id=?1",
                [account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("assignment account capacity not configured"))?;
        let held: u64 = tx.query_row(
            "SELECT COUNT(*) FROM assignment_resource_holds WHERE account_id=?1 AND state='held'",
            [account],
            |r| r.get(0),
        )?;
        if held >= u64::from(capacity) {
            return Err(ResourceWait::AccountCapacity.into());
        }
        let scope = if assignment["execution_workspace"].is_null() {
            &candidate["grant_scope"]
        } else {
            &assignment["execution_workspace"]["receipt"]["scope"]
        };
        let host = scope["target"]["host"].as_str().unwrap();
        let root = scope["target"]["root"].as_str().unwrap();
        let exclusive = super::assignment_exclusive_resources::names(&run, &assignment)?;
        if !super::assignment_exclusive_resources::available(&tx, id, host, &exclusive)? {
            return Err(ResourceWait::ExclusiveResourceBusy.into());
        }
        let path = std::path::Path::new(root);
        if !path.is_absolute()
            || path.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            bail!("assignment workspace root must be normalized")
        }
        let roots = tx
            .prepare("SELECT root FROM assignment_resource_holds WHERE host=?1 AND state='held'")?
            .query_map([host], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if roots
            .iter()
            .any(|r| path.starts_with(r) || std::path::Path::new(r).starts_with(path))
        {
            return Err(ResourceWait::WorkspaceBusy.into());
        }
        let mut resources = json!({"state":"held","account_id":account,"capacity_revision":capacity_revision,"host":host,"root":root,"workspace_basis":if assignment["execution_workspace"].is_null() { "declared_root" } else if assignment["execution_workspace"]["receipt"]["kind"] == "derived_task_worktree" { "task_worktree" } else { "derived_snapshot" },"reserved_at":at,"recommendation":rank["candidates"][0]});
        if !exclusive.is_empty() {
            resources["exclusive_resources"] = json!(exclusive);
            resources["exclusive_resource_scope"] = json!("home");
        }
        let receipt = json!({"assignment_id":id,"assignment_revision":input.expected_revision+1,"resources":resources});
        tx.execute("INSERT INTO assignment_resource_holds(assignment_id,account_id,host,root,state,request,receipt) VALUES (?1,?2,?3,?4,'held',?5,?6)",params![id,account,host,root,serde_json::to_string(&request)?,serde_json::to_string(&receipt)?])?;
        super::assignment_exclusive_resources::reserve(&tx, id, host, &exclusive, at)?;
        assignment["resources"] = resources;
        assignment["revision"] = json!(input.expected_revision + 1);
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![assignment["run_id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_resources_reserved","at":at,"request_id":input.request_id,"run_revision":run["revision"],"receipt":receipt}))?])?;
        tx.commit()?;
        Ok(receipt)
    }
}

pub(super) fn authorized_context(
    db: &Connection,
    id: &str,
    assignment: &Value,
    at: u64,
) -> Result<(Value, Operation)> {
    let run_body: String = db.query_row(
        "SELECT body FROM work_runs WHERE id=?1",
        [assignment["run_id"].as_str()],
        |r| r.get(0),
    )?;
    let run: Value = serde_json::from_str(&run_body)?;
    if !matches!(
        run["state"].as_str(),
        Some("waiting_resource" | "queued" | "running")
    ) || run["context_hash"] != assignment["context_hash"]
        || run["authorization"]["snapshot_hash"] != assignment["authorization_hash"]
        || !run["stages"].as_array().unwrap().iter().any(|s| {
            s["stage_id"] == assignment["stage_id"]
                && s["assignment_id"] == id
                && s["attempt"] == assignment["stage_attempt"]
        })
    {
        bail!("assignment run binding unavailable")
    }
    let live = super::team_activation::authorized(
        db,
        assignment["team_id"].as_str().unwrap(),
        run["team_revision"].as_u64().unwrap(),
        at,
    )?;
    if live.is_none_or(|a| a["snapshot_hash"] != assignment["authorization_hash"]) {
        bail!("assignment authority unavailable")
    }
    let op_body: String = db.query_row(
        "SELECT body FROM operations WHERE id=?1",
        [assignment["bundle"]["operation"]["id"].as_str()],
        |r| r.get(0),
    )?;
    let operation: Operation = serde_json::from_str(&op_body)?;
    if assignment["bundle"]["operation"]["attempt"] != operation.attempt
        || assignment["bundle"]["operation"]["epoch"] != operation.epoch
    {
        bail!("assignment operation changed")
    }
    super::operation_grant::admit(db, &operation, at)?;
    Ok((run, operation))
}

pub(super) fn live(
    db: &Connection,
    id: &str,
    assignment: &Value,
    at: u64,
) -> Result<(Value, Value, Operation)> {
    let (run, operation) = authorized_context(db, id, assignment, at)?;
    let candidate = &assignment["candidate"];
    let rank = super::resource_rank::rank_in(
        db,
        serde_json::from_value(json!({"task_tag":candidate["recommendation"]["task_tag"],
            "minimum_quality":candidate["scheduling"]["minimum_quality"],"minimum_confidence":candidate["scheduling"]["minimum_confidence"],"weights":candidate["scheduling"]["weights"],
            "candidates":[{"capability_id":candidate["capability_profile"]["id"],"capability_revision":candidate["capability_profile"]["revision"],"model":candidate["selection_policy"]["model"],"resource":candidate["resource"],"preferred":candidate["preferred"]}]}))?,
        at,
    )?;
    if rank["candidates"].as_array().unwrap().is_empty() {
        bail!("assignment resource recommendation no longer valid")
    }
    super::operation_budget::admit(db, &operation, at)?;
    let resource = super::resource_admission::admit(db, &operation, at)?;
    if !resource.allowed {
        bail!("assignment resource unavailable")
    }
    Ok((run, rank, operation))
}
pub(super) fn assert_held(db: &Connection, assignment: &Value) -> Result<()> {
    super::assignment_task_workspace::assert_bound(assignment)?;
    super::assignment_exclusive_resources::assert_held(db, assignment)?;
    let row:Option<(String,String,String,String)>=db.query_row("SELECT account_id,host,root,state FROM assignment_resource_holds WHERE assignment_id=?1",[assignment["id"].as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let resources = &assignment["resources"];
    let Some((account, host, root, state)) = row else {
        bail!("assignment resource holds missing")
    };
    if state != "held"
        || resources["state"] != "held"
        || resources["account_id"] != account
        || resources["host"] != host
        || resources["root"] != root
    {
        bail!("assignment resource holds changed")
    }
    let capacity: u64 = db.query_row(
        "SELECT capacity FROM assignment_account_capacities WHERE account_id=?1",
        [&account],
        |r| r.get(0),
    )?;
    let count: u64 = db.query_row(
        "SELECT COUNT(*) FROM assignment_resource_holds WHERE account_id=?1 AND state='held'",
        [&account],
        |r| r.get(0),
    )?;
    if count > capacity {
        bail!("assignment account capacity exceeded")
    }
    Ok(())
}

/// Reuse owner capacity validation inside an atomic configuration transaction.
pub(super) fn configure_capacity_in(
    tx: &rusqlite::Transaction<'_>,
    input: Capacity,
) -> Result<Value> {
    if !valid_id(&input.account_id)
        || input.expected_revision >= i64::MAX as u64
        || !(1..=1024).contains(&input.max_active_assignments)
    {
        bail!("invalid assignment capacity")
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM resource_accounts WHERE id=?1)",
        [&input.account_id],
        |r| r.get(0),
    )?;
    if !exists {
        bail!("unknown resource account")
    }
    let revision: u64 = tx
        .query_row(
            "SELECT revision FROM assignment_account_capacities WHERE account_id=?1",
            [&input.account_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if revision != input.expected_revision {
        bail!("assignment capacity revision conflict")
    }
    let held: u64 = tx.query_row(
        "SELECT COUNT(*) FROM assignment_resource_holds WHERE account_id=?1 AND state='held'",
        [&input.account_id],
        |r| r.get(0),
    )?;
    if held > u64::from(input.max_active_assignments) {
        bail!("assignment capacity below existing holds")
    }
    let result = json!({"account_id":input.account_id,"revision":revision+1,"max_active_assignments":input.max_active_assignments,"held":held});
    tx.execute("INSERT INTO assignment_account_capacities(account_id,revision,capacity) VALUES (?1,?2,?3) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,capacity=excluded.capacity",params![input.account_id,revision+1,input.max_active_assignments])?;
    tx.execute(
        "INSERT INTO resource_events(body) VALUES (?1)",
        [serde_json::to_string(
            &json!({"kind":"assignment_capacity_configured","at":now(),"capacity":result}),
        )?],
    )?;
    Ok(result)
}
