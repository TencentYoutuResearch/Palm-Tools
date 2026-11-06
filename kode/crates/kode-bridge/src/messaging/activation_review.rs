//! Owner review prepares a version-bound command without granting authority or starting execution.
use super::{
    model::{now, valid_id},
    store::Store,
    teams::Spec,
};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub team_revision: u64,
    pub request_id: String,
}
impl Store {
    pub fn review_team_activation(&self, id: &str, input: Review) -> Result<Value> {
        if !valid_id(id) || !valid_id(&input.request_id) || input.team_revision == 0 {
            bail!("invalid activation review")
        }
        let team = self
            .team(id, None)?
            .ok_or_else(|| anyhow::anyhow!("team missing"))?;
        if team["revision"].as_u64() != Some(input.team_revision) {
            bail!("team changed before review")
        }
        let spec: Spec = serde_json::from_value(team["spec"].clone())?;
        let configuration = self
            .team_workflow_preflight(id, input.team_revision)?
            .unwrap();
        let resources = self.builder_resource_preflight(id, &spec)?;
        let grant = spec
            .grant_id
            .as_ref()
            .map(|g| self.team_grant(g, None))
            .transpose()?
            .flatten();
        let activation = self.team_activation(id)?;
        let activation_revision = activation
            .as_ref()
            .and_then(|a| a["revision"].as_u64())
            .unwrap_or(0);
        let at = now();
        let mut issues = Vec::new();
        if spec.kind != super::teams::Kind::Coordinator {
            issues.push(json!({"code":"coordinator_team_required"}))
        }
        if [
            "workflow_bindings_valid",
            "project_delivery_bindings_valid",
            "execution_policy_bindings_valid",
        ]
        .iter()
        .any(|k| configuration[k] != true)
        {
            issues.push(json!({"code":"configuration_incomplete"}));
        }
        if !grant
            .as_ref()
            .is_some_and(|g| g.policy.team_id == id && g.policy.enabled && g.policy.expires_at > at)
        {
            issues.push(json!({"code":"grant_missing_revoked_or_expired"}))
        }
        if let Some(capacity_issues) = resources["assignment_capacity_issues"].as_array() {
            issues.extend(capacity_issues.iter().cloned());
        }
        let reference = |kind: &str| {
            let p = &configuration["policies"][kind];
            json!({"id":p["id"],"revision":p["revision"],"hash":p["hash"]})
        };
        let command = if issues.is_empty() {
            json!({"action":"activate","request_id":input.request_id,"expected_revision":activation_revision,"team_revision":input.team_revision,
            "grant_revision":grant.as_ref().unwrap().revision,"budget_policy":reference("budget"),"scheduling_policy":reference("scheduling")})
        } else {
            Value::Null
        };
        if self
            .team(id, None)?
            .as_ref()
            .and_then(|t| t["revision"].as_u64())
            != Some(input.team_revision)
            || self
                .team_activation(id)?
                .as_ref()
                .and_then(|a| a["revision"].as_u64())
                .unwrap_or(0)
                != activation_revision
        {
            bail!("team or activation changed during review")
        }
        if let Some(g) = &grant {
            if self
                .team_grant(&g.policy.id, None)?
                .as_ref()
                .map(|v| v.revision)
                != Some(g.revision)
            {
                bail!("grant changed during review")
            }
        }
        for kind in ["budget", "scheduling"] {
            let p = &configuration["policies"][kind];
            if let Some(id) = p["id"].as_str() {
                if self
                    .team_policy(id, None)?
                    .as_ref()
                    .is_none_or(|v| v["revision"] != p["revision"] || v["hash"] != p["hash"])
                {
                    bail!("policy changed during review")
                }
            }
        }
        Ok(
            json!({"team":team,"configuration":configuration,"resources":resources,"grant":grant,"activation":activation,"issues":issues,"prepared_command":command,
            "checked_at":at,"activation_performed":false,"eligible_for_execution":false,"pending_checks":["normal_and_failure_examples","owner_confirmation","activation_scope_validation","live_execution_admission"]}),
        )
    }
}
