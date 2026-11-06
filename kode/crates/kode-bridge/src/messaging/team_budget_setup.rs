//! Owner-entered team budget with atomic exact-command receipts; never provider credit.
use super::{
    budgets,
    model::{now, valid_id},
    store::Store,
    team_policies,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configure {
    pub request_id: String,
    pub team_revision: u64,
    pub budget: budgets::Configure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_policy: Option<InitialPolicy>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitialPolicy {
    pub max_assignment_charge: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settlement: Option<String>,
}
fn key(team: &str, request: &str) -> String {
    format!(
        "team-budget-setup:{}",
        serde_json::to_string(&(team, request)).unwrap()
    )
}
fn receipt(db: &rusqlite::Connection, team: &str, request: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(team, request)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
impl Store {
    pub fn team_budget_receipt(&self, team: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(team) || !valid_id(request) {
            bail!("invalid team budget receipt identity")
        }
        receipt(&self.db.lock(), team, request)
    }
    pub fn configure_team_budget(&self, team: &str, input: Configure) -> Result<Value> {
        if !valid_id(team)
            || !valid_id(&input.request_id)
            || input.team_revision == 0
            || input.budget.scope != budgets::Scope::Team
            || input.budget.scope_id != team
        {
            bail!("invalid team budget configuration")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(saved) = receipt(&tx, team, &input.request_id)? {
            if saved["request"] != request {
                bail!("team budget request identity conflict")
            }
            return Ok(saved["result"].clone());
        }
        let revision: Option<u64> = tx
            .query_row("SELECT revision FROM teams WHERE id=?1", [team], |r| {
                r.get(0)
            })
            .optional()?;
        if revision != Some(input.team_revision) {
            bail!("team changed before budget confirmation")
        }
        let initial_policy = if let Some(initial) = input.initial_policy {
            if input.budget.expected_revision != 0
                || initial.max_assignment_charge == 0
                || initial.max_assignment_charge > input.budget.limit
            {
                bail!("initial budget policy requires a new sufficient budget")
            }
            let body: String = tx.query_row(
                "SELECT body FROM team_revisions WHERE team_id=?1 AND revision=?2",
                params![team, input.team_revision],
                |r| r.get(0),
            )?;
            let team_row: Value = serde_json::from_str(&body)?;
            let id = team_row["spec"]["budget_policy_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("team budget policy reference required"))?;
            if team_policies::read(&tx, id, None)?.is_some() {
                bail!("team budget policy already configured")
            }
            Some(team_policies::Write {
                id: id.into(),
                team_id: team.into(),
                expected_revision: 0,
                policy: team_policies::Policy::Budget {
                    budget_ids: vec![input.budget.id.clone()],
                    unit: input.budget.unit.clone(),
                    max_assignment_charge: initial.max_assignment_charge,
                    settlement: initial.settlement,
                },
            })
        } else {
            None
        };
        let row = budgets::configure_in(&tx, input.budget, now())?;
        let policy = initial_policy
            .map(|policy| team_policies::write_in(&tx, policy, &self.node_id))
            .transpose()?;
        let mut result = json!({"label":"团队预算","team_id":team,"team_revision":input.team_revision,"request_id":input.request_id,
            "budget":row,"activation_performed":false});
        if let Some(policy) = policy {
            result["budget_policy"] = policy;
        }
        let saved = json!({"request":request,"result":result});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(team, &input.request_id), serde_json::to_string(&saved)?],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
