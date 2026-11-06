//! Live read-only resource facts for an owner-configured candidate-team policy.
use super::{
    model::{now, valid_id},
    store::Store,
    team_policies::Policy,
};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub expected_revision: u64,
    pub team_id: String,
    pub policy_id: String,
    pub policy_revision: u64,
    pub target_id: String,
}
impl Store {
    pub fn builder_policy_details(&self, id: &str, query: Query) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&query.team_id)
            || !valid_id(&query.policy_id)
            || query.expected_revision == 0
            || query.policy_revision == 0
        {
            bail!("invalid Builder policy identity")
        }
        let draft = self
            .builder_draft(id)?
            .ok_or_else(|| anyhow::anyhow!("Builder draft missing"))?;
        if draft["status"] != "draft" || draft["revision"].as_u64() != Some(query.expected_revision)
        {
            bail!("Builder draft unavailable or revision conflict")
        }
        let policy = self
            .team_policy(&query.policy_id, None)?
            .ok_or_else(|| anyhow::anyhow!("Builder policy missing"))?;
        if policy["team_id"] != query.team_id
            || policy["revision"].as_u64() != Some(query.policy_revision)
        {
            bail!("Builder policy team or revision conflict")
        }
        let at = now();
        let details = match serde_json::from_value::<Policy>(policy["policy"].clone())? {
            Policy::Budget {
                budget_ids,
                unit,
                max_assignment_charge,
                ..
            } => {
                if !query.target_id.is_empty() {
                    bail!("budget policy has no target")
                }
                let mut budgets = Vec::new();
                for id in budget_ids {
                    let snapshot = self.budget(&id)?;
                    let b = &snapshot["budget"];
                    let valid = b["unit"] == unit
                        && (b["scope"] == "shared"
                            || b["scope"] == "team" && b["scope_id"] == query.team_id)
                        && b["starts_at"].as_u64().is_some_and(|t| t <= at)
                        && b["ends_at"].as_u64().is_some_and(|t| t > at);
                    budgets.push(json!({"snapshot":snapshot,"period_and_scope_valid":valid,"covers_max_assignment_charge":valid&&snapshot["available"].as_u64().is_some_and(|a|a>=max_assignment_charge)}));
                }
                json!({"kind":"budget","team_budgets":budgets,"reserved_by_read":false,"provider_quota":"not_queried"})
            }
            Policy::Scheduling { targets, .. } => {
                if !valid_id(&query.target_id) {
                    bail!("invalid Builder target")
                }
                let candidate = targets
                    .get(&query.target_id)
                    .ok_or_else(|| anyhow::anyhow!("Builder policy target missing"))?;
                let quota = self.resource_admission(&candidate.resource, at)?;
                let capability = self
                    .capability_profile(&candidate.capability_id, candidate.capability_revision)?;
                let identity = capability.as_ref().is_some_and(|c| {
                    c["host"] == candidate.resource.host
                        && c["profile"] == candidate.resource.profile
                });
                let price = candidate
                    .internal_price_id
                    .as_ref()
                    .map(|id| self.price(id))
                    .transpose()?
                    .flatten();
                json!({"kind":"scheduling","target_id":query.target_id,"candidate":candidate,"quota":quota,"capability":capability,"capability_resource_identity_matches":identity,"internal_price":price,"runtime_capabilities":"not_verified","role_fit":"not_evaluated"})
            }
        };
        // These are live diagnostics, not a transactional admission snapshot.
        if self
            .builder_draft(id)?
            .as_ref()
            .and_then(|d| d["revision"].as_u64())
            != Some(query.expected_revision)
            || self
                .team_policy(&query.policy_id, None)?
                .as_ref()
                .and_then(|p| p["revision"].as_u64())
                != Some(query.policy_revision)
        {
            bail!("Builder draft or policy changed during read")
        }
        Ok(
            json!({"draft_id":id,"draft_revision":query.expected_revision,"team_id":query.team_id,"policy":policy,"checked_at":at,"details":details,"eligible_for_execution":false}),
        )
    }
}
