//! Explicit owner consent, separate from live dispatch readiness. All effects commit at home.
use super::{
    model::{now, valid_id},
    store::Store,
    team_grants, team_policies,
    teams::Spec,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyRef {
    pub id: String,
    pub revision: u64,
    pub hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Activate {
        request_id: String,
        expected_revision: u64,
        team_revision: u64,
        grant_revision: u64,
        budget_policy: PolicyRef,
        scheduling_policy: PolicyRef,
    },
    Deactivate {
        request_id: String,
        expected_revision: u64,
    },
}
fn key(team: &str, suffix: &str) -> String {
    format!(
        "team-activation:{}",
        serde_json::to_string(&(team, suffix)).unwrap()
    )
}
fn read_key(db: &Connection, key: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn put(tx: &Transaction, key: &str, revision: u64, row: &Value) -> Result<()> {
    tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value",params![key,revision,serde_json::to_string(row)?])?;
    Ok(())
}
pub(super) fn current(db: &Connection, team: &str) -> Result<Option<Value>> {
    read_key(db, &key(team, "current"))
}
pub(super) fn authorized(
    db: &Connection,
    team: &str,
    revision: u64,
    at: u64,
) -> Result<Option<Value>> {
    let Some(row) = current(db, team)? else {
        return Ok(None);
    };
    if row["active"] != true || row["team_revision"] != revision {
        return Ok(None);
    }
    let grant: &Value = &row["snapshot"]["grant"];
    let Some(id) = grant["policy"]["id"].as_str() else {
        return Ok(None);
    };
    let Some(live) = team_grants::read(db, id, None)? else {
        return Ok(None);
    };
    if live.revision != grant["revision"].as_u64().unwrap_or(0)
        || !live.policy.enabled
        || live.policy.expires_at <= at
    {
        return Ok(None);
    }
    Ok(Some(row))
}
pub(super) fn bind_run(row: &mut Value, activation: Value) {
    row["authorization"] = activation;
    row["state"] = json!("waiting_resource");
    row["waiting_reason"] = json!("execution_adapters_not_ready");
}
impl Store {
    pub fn team_activation_receipt(&self, id: &str, request_id: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(request_id) {
            bail!("invalid activation receipt identity")
        }
        read_key(&self.db.lock(), &key(id, &format!("command:{request_id}")))
    }
    pub fn team_activation(&self, id: &str) -> Result<Option<Value>> {
        if !valid_id(id) {
            bail!("invalid team identity")
        }
        let db = self.db.lock();
        let Some(mut row) = current(&db, id)? else {
            return Ok(None);
        };
        row["authority_valid"] =
            json!(authorized(&db, id, row["team_revision"].as_u64().unwrap(), now())?.is_some());
        Ok(Some(row))
    }
    pub fn change_team_activation(&self, id: &str, input: Command) -> Result<Value> {
        let (request_id, expected) = match &input {
            Command::Activate {
                request_id,
                expected_revision,
                ..
            }
            | Command::Deactivate {
                request_id,
                expected_revision,
            } => (request_id, *expected_revision),
        };
        if !valid_id(id) || !valid_id(request_id) || expected >= i64::MAX as u64 {
            bail!("invalid activation command")
        }
        let request = serde_json::to_value(&input)?;
        let receipt_key = key(id, &format!("command:{request_id}"));
        if let Some(receipt) = read_key(&self.db.lock(), &receipt_key)? {
            if receipt["request"] != request {
                bail!("activation request identity conflict")
            }
            return Ok(receipt["result"].clone());
        }
        let mut snapshot = Value::Null;
        if let Command::Activate {
            team_revision,
            budget_policy,
            scheduling_policy,
            ..
        } = &input
        {
            let team = self
                .team(id, Some(*team_revision))?
                .ok_or_else(|| anyhow::anyhow!("unknown team revision"))?;
            let spec: Spec = serde_json::from_value(team["spec"].clone())?;
            if spec.kind != super::teams::Kind::Coordinator {
                bail!("activation requires coordinator team")
            }
            let check = self.team_workflow_preflight(id, *team_revision)?.unwrap();
            if [
                "workflow_bindings_valid",
                "project_delivery_bindings_valid",
                "execution_policy_bindings_valid",
            ]
            .iter()
            .any(|k| check[k] != true)
            {
                bail!("team activation configuration is incomplete")
            }
            for (kind, reference) in [("budget", budget_policy), ("scheduling", scheduling_policy)]
            {
                let stored = &check["policies"][kind];
                if stored["id"] != reference.id
                    || stored["revision"] != reference.revision
                    || stored["hash"] != reference.hash
                {
                    bail!("reviewed activation policy changed")
                }
            }
            snapshot =
                json!({"team":team,"bindings":check["bindings"],"policies":check["policies"]});
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(receipt) = read_key(&tx, &receipt_key)? {
            if receipt["request"] != request {
                bail!("activation request identity conflict")
            }
            return Ok(receipt["result"].clone());
        }
        let old = current(&tx, id)?;
        if old
            .as_ref()
            .and_then(|r| r["revision"].as_u64())
            .unwrap_or(0)
            != expected
        {
            bail!("activation revision conflict")
        }
        let at = now();
        let revision = expected + 1;
        let (active, team_revision) = match &input {
            Command::Activate {
                team_revision,
                grant_revision,
                budget_policy,
                scheduling_policy,
                ..
            } => {
                let latest: u64 =
                    tx.query_row("SELECT revision FROM teams WHERE id=?1", [id], |r| r.get(0))?;
                if latest != *team_revision {
                    bail!("team draft changed before activation")
                }
                for reference in [budget_policy, scheduling_policy] {
                    let live = team_policies::read(&tx, &reference.id, None)?
                        .ok_or_else(|| anyhow::anyhow!("activation policy missing"))?;
                    if live["revision"] != reference.revision || live["hash"] != reference.hash {
                        bail!("reviewed activation policy changed")
                    }
                }
                let spec: Spec = serde_json::from_value(snapshot["team"]["spec"].clone())?;
                let grant = team_grants::read(
                    &tx,
                    spec.grant_id
                        .as_deref()
                        .ok_or_else(|| anyhow::anyhow!("team grant required"))?,
                    None,
                )?
                .ok_or_else(|| anyhow::anyhow!("team grant missing"))?;
                if grant.revision != *grant_revision
                    || grant.policy.team_id != id
                    || !grant.policy.enabled
                    || grant.policy.expires_at <= at
                {
                    bail!("team grant changed, revoked or expired")
                }
                if !grant
                    .policy
                    .capabilities
                    .contains(&team_grants::Capability::Read)
                    || (!spec.workers.is_empty()
                        && !grant
                            .policy
                            .capabilities
                            .contains(&team_grants::Capability::Delegate))
                {
                    bail!("team grant lacks read/delegation capability")
                }
                for w in &spec.workspace_refs {
                    if !grant.policy.targets.iter().any(|t| {
                        t.host == w.host_id && t.workspace == w.workspace_id && t.root == w.root_ref
                    }) {
                        bail!("team workspace is outside grant")
                    }
                }
                for binding in snapshot["bindings"].as_array().unwrap() {
                    let pack: super::workflows::Pack =
                        serde_json::from_value(binding["workflow"]["pack"].clone())?;
                    for stage in pack.stages {
                        if let Some(scope) = stage.execution {
                            if scope
                                .capabilities
                                .iter()
                                .any(|c| !grant.policy.capabilities.contains(c))
                                || scope
                                    .tools
                                    .iter()
                                    .any(|tool| !grant.policy.tools.contains(tool))
                                || (scope.network && !grant.policy.network)
                            {
                                bail!("stage execution scope exceeds team grant");
                            }
                        }
                    }
                }
                let policy: team_policies::Policy =
                    serde_json::from_value(snapshot["policies"]["budget"]["policy"].clone())?;
                let team_policies::Policy::Budget {
                    budget_ids, unit, ..
                } = policy
                else {
                    bail!("budget policy required")
                };
                for budget_id in budget_ids {
                    if !grant.policy.budget_ids.contains(&budget_id) {
                        bail!("team budget is outside grant")
                    }
                    let body: String =
                        tx.query_row("SELECT body FROM budgets WHERE id=?1", [budget_id], |r| {
                            r.get(0)
                        })?;
                    let budget: super::budgets::Budget = serde_json::from_str(&body)?;
                    if budget.unit != unit
                        || (budget.scope == super::budgets::Scope::Team && budget.scope_id != id)
                    {
                        bail!("team budget identity changed")
                    }
                }
                for target in &spec.execution_targets {
                    let configured: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM assignment_account_capacities WHERE account_id=?1 AND capacity BETWEEN 1 AND 1024)",
                        [&target.account_binding_id], |row| row.get(0))?;
                    if !configured {
                        bail!("assignment account capacity not configured for activation")
                    }
                }
                snapshot["grant"] = serde_json::to_value(grant)?;
                (true, *team_revision)
            }
            Command::Deactivate { .. } => {
                let old = old
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("team has no activation"))?;
                snapshot = old["snapshot"].clone();
                (false, old["team_revision"].as_u64().unwrap())
            }
        };
        let hash = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "kode.team.activation.v1\n{}",
                    serde_json::to_string(&snapshot)?
                )
                .as_bytes()
            )
        );
        let row = json!({"schema_version":1,"team_id":id,"revision":revision,"team_revision":team_revision,"active":active,
            "home_hub":self.node_id,"actor":{"kind":"human","id":"local_owner"},"recorded_at":at,"snapshot":snapshot,
            "snapshot_hash":hash,"eligible_for_execution":false,"pending_checks":["trusted_execution_adapters","live_resource_and_budget_admission","stage_dispatch"]});
        put(&tx, &key(id, "current"), revision, &row)?;
        put(
            &tx,
            &key(id, &format!("revision:{revision}")),
            revision,
            &row,
        )?;
        put(
            &tx,
            &receipt_key,
            revision,
            &json!({"request":request,"result":row}),
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![id,serde_json::to_string(&json!({"kind":if active {"team_activated"} else {"team_deactivated"},"activation":row}))?])?;
        let runs = {
            let mut q=tx.prepare("SELECT id,body FROM work_runs WHERE team_id=?1 AND state IN ('waiting_user','waiting_resource')")?;
            let rows = q
                .query_map([id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (run_id, body) in runs {
            let mut run: Value = serde_json::from_str(&body)?;
            if run["dispatch_state"] != "not_dispatched" {
                continue;
            }
            if active {
                if run["team_revision"] != team_revision || run["state"] != "waiting_user" {
                    continue;
                }
                if run["authorization"].is_null() {
                    bind_run(&mut run, row.clone());
                } else if run["authorization"]["snapshot_hash"] == row["snapshot_hash"] {
                    run["state"] = json!("waiting_resource");
                    run["waiting_reason"] = json!("execution_adapters_not_ready");
                } else {
                    continue;
                }
            } else {
                if run["authorization"].is_null() {
                    continue;
                }
                run["state"] = json!("waiting_user");
                run["waiting_reason"] = json!("team_deactivated");
            }
            let next = run["revision"]
                .as_u64()
                .unwrap()
                .checked_add(1)
                .filter(|v| *v <= i64::MAX as u64)
                .ok_or_else(|| anyhow::anyhow!("work run revision exhausted"))?;
            run["revision"] = json!(next);
            run["updated_at"] = json!(at);
            tx.execute(
                "UPDATE work_runs SET state=?2,revision=?3,body=?4 WHERE id=?1",
                params![
                    run_id,
                    run["state"].as_str(),
                    next,
                    serde_json::to_string(&run)?
                ],
            )?;
            tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![run_id,serde_json::to_string(&json!({"kind":if active {"work_run_authorized"}else{"work_run_authorization_suspended"},"activation_revision":revision,"revision":next,"at":at}))?])?;
        }
        tx.commit()?;
        Ok(row)
    }
}
