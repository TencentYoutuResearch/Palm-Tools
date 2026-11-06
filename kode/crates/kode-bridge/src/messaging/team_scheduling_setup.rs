//! Owner scheduling configuration binds actual account and capability identities, not inferred capacity.
use super::{
    assignment_resources,
    model::{now, valid_id},
    pricing,
    store::Store,
    team_policies,
    teams::Spec,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configure {
    pub request_id: String,
    pub team_revision: u64,
    pub policy: team_policies::Write,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub internal_prices: BTreeMap<String, pricing::Price>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub account_capacities: BTreeMap<String, assignment_resources::Capacity>,
}
fn key(team: &str, request: &str) -> String {
    format!("team-scheduling-setup:{}", json!([team, request]))
}
fn read(db: &rusqlite::Connection, team: &str, request: &str) -> Result<Option<Value>> {
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
    pub fn team_scheduling_receipt(&self, team: &str, request: &str) -> Result<Value> {
        if !valid_id(team) || !valid_id(request) {
            bail!("invalid scheduling receipt")
        }
        Ok(json!({"receipt":read(&self.db.lock(),team,request)?}))
    }
    pub fn team_scheduling_options(&self, id: &str, revision: u64) -> Result<Value> {
        let team = self
            .team(id, None)?
            .ok_or_else(|| anyhow::anyhow!("team missing"))?;
        if team["revision"].as_u64() != Some(revision) {
            bail!("team revision conflict")
        }
        let spec: Spec = serde_json::from_value(team["spec"].clone())?;
        let mut options = Vec::new();
        for target in &spec.execution_targets {
            let binding = self.resource_binding(&target.host_id, &target.executor_profile_id)?;
            let quota = self.quota_snapshot(&target.host_id, &target.executor_profile_id, now())?;
            let capacity = self.assignment_capacity(&target.account_binding_id)?;
            let db = self.db.lock();
            let mut q=db.prepare("SELECT body FROM capability_profiles WHERE json_extract(body,'$.host')=?1 AND json_extract(body,'$.profile')=?2 AND json_extract(body,'$.model')=?3 AND CAST(revision AS TEXT)=?4 ORDER BY id LIMIT 21")?;
            let rows = q
                .query_map(
                    params![
                        target.host_id,
                        target.executor_profile_id,
                        target.model_id,
                        target.capability_profile_revision
                    ],
                    |r| r.get::<_, String>(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let truncated = rows.len() > 20;
            let capabilities = rows
                .into_iter()
                .take(20)
                .map(|s| serde_json::from_str::<Value>(&s))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            options.push(json!({"target_id":target.id,"assignment_capacity":capacity,"binding":binding,"quota":quota,"capabilities":capabilities,"capabilities_truncated":truncated}));
        }
        let policy = spec
            .scheduling_policy_id
            .as_deref()
            .map(|id| self.team_policy(id, None))
            .transpose()?
            .flatten();
        let result =
            json!({"team":team,"options":options,"policy":policy,"eligible_for_execution":false});
        if serde_json::to_vec(&result)?.len() > 1048576 {
            bail!("scheduling options exceed bounded view")
        }
        if self
            .team(id, None)?
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            != Some(revision)
        {
            bail!("team changed during scheduling review")
        }
        Ok(result)
    }
    pub fn configure_team_scheduling(&self, id: &str, input: Configure) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.team_revision == 0
            || input.policy.team_id != id
        {
            bail!("invalid scheduling confirmation")
        }
        let request = serde_json::to_value(&input)?;
        if serde_json::to_vec(&request)?.len() > 131072 {
            bail!("scheduling command too large")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(saved) = read(&tx, id, &input.request_id)? {
            if saved["request"] != request {
                bail!("scheduling request identity conflict")
            }
            return Ok(saved["result"].clone());
        }
        let body:String=tx.query_row("SELECT r.body FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision WHERE t.id=?1",[id],|r|r.get(0))?;
        let team: Value = serde_json::from_str(&body)?;
        let spec: Spec = serde_json::from_value(team["spec"].clone())?;
        if team["revision"].as_u64() != Some(input.team_revision)
            || spec.scheduling_policy_id.as_deref() != Some(&input.policy.id)
        {
            bail!("team scheduling reference changed")
        }
        let team_policies::Policy::Scheduling { targets, .. } = &input.policy.policy else {
            bail!("scheduling policy required")
        };
        if targets.len() != spec.execution_targets.len() {
            bail!("scheduling target coverage mismatch")
        }
        for target in &spec.execution_targets {
            let candidate = targets
                .get(&target.id)
                .ok_or_else(|| anyhow::anyhow!("scheduling target missing"))?;
            let r = &candidate.resource;
            if r.host != target.host_id
                || r.profile != target.executor_profile_id
                || r.account_id != target.account_binding_id
                || candidate.capability_revision.to_string() != target.capability_profile_revision
            {
                bail!("scheduling target identity mismatch")
            }
            let binding:Option<(String,u64,u64,u64,bool)>=tx.query_row("SELECT b.account_id,b.account_epoch,b.revision,a.epoch,(b.enabled AND a.enabled) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile=?2",params![r.host,r.profile],|v|Ok((v.get(0)?,v.get(1)?,v.get(2)?,v.get(3)?,v.get(4)?))).optional()?;
            if binding
                != Some((
                    r.account_id.clone(),
                    r.account_epoch,
                    r.binding_revision,
                    r.account_epoch,
                    true,
                ))
            {
                bail!("scheduling account binding changed")
            }
            let body: String = tx.query_row(
                "SELECT body FROM capability_profiles WHERE id=?1 AND revision=?2",
                params![candidate.capability_id, candidate.capability_revision],
                |v| v.get(0),
            )?;
            let capability: Value = serde_json::from_str(&body)?;
            if capability["host"] != target.host_id
                || capability["profile"] != target.executor_profile_id
                || capability["model"] != target.model_id
            {
                bail!("scheduling capability identity mismatch")
            }
        }
        let current = team_policies::read(&tx, &input.policy.id, None)?;
        if current
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            .unwrap_or(0)
            != input.policy.expected_revision
        {
            bail!("scheduling policy revision conflict")
        }
        // New immutable prices and their reviewed scheduling references commit together.
        // This does not change existing activation snapshots or create usage/holds.
        let mut prices = BTreeMap::new();
        if !input.internal_prices.is_empty() {
            if input.internal_prices.len() > spec.execution_targets.len() {
                bail!("price target coverage mismatch")
            }
            let budget_id = spec
                .budget_policy_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("team budget policy required for pricing"))?;
            let budget = team_policies::read(&tx, budget_id, None)?
                .ok_or_else(|| anyhow::anyhow!("team budget policy missing"))?;
            if budget["team_id"] != id
                || budget["policy"]["kind"] != "budget"
                || budget["policy"]["settlement"] != "internal_price"
            {
                bail!("team internal-price settlement required")
            }
            for (target_id, price) in input.internal_prices {
                let target = spec
                    .execution_targets
                    .iter()
                    .find(|target| target.id == target_id)
                    .ok_or_else(|| anyhow::anyhow!("unknown price target"))?;
                if targets
                    .get(&target_id)
                    .and_then(|candidate| candidate.internal_price_id.as_deref())
                    != Some(price.id.as_str())
                    || price.model != target.model_id
                    || price.model_policy != pricing::ModelPolicy::RequestedModel
                    || budget["policy"]["unit"].as_str() != Some(price.unit.as_str())
                {
                    bail!("price differs from reviewed target or team budget")
                }
                prices.insert(target_id, pricing::create_in(&tx, price)?);
            }
        }
        let mut capacities = BTreeMap::new();
        for (account, capacity) in input.account_capacities {
            if account != capacity.account_id
                || !spec
                    .execution_targets
                    .iter()
                    .any(|target| target.account_binding_id == account)
            {
                bail!("capacity account is not a configured team resource")
            }
            capacities.insert(
                account,
                assignment_resources::configure_capacity_in(&tx, capacity)?,
            );
        }
        let policy = team_policies::write_in(&tx, input.policy, &self.node_id)?;
        let mut result = json!({"home_hub":self.node_id,"team_id":id,"team_revision":input.team_revision,"request_id":input.request_id,"policy":policy,"activation_performed":false,"eligible_for_execution":false});
        if !capacities.is_empty() {
            result["account_capacities"] =
                json!({"scope":"account_shared_across_teams","capacities":capacities});
        }
        if !prices.is_empty() {
            result["internal_prices"] =
                json!({"label":"内部计价","provider_invoice":false,"prices":prices});
        }
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key(id, &input.request_id),
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![id,serde_json::to_string(&json!({"kind":"team_scheduling_configured","request_id":input.request_id,"actor":{"kind":"human","id":"local_owner"},"at":now()}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
