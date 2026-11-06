//! Read-only home facts for every configured target. Unknown quota is never a balance.
use super::{model::now, store::Store, team_policies::Policy, teams::Spec};
use anyhow::Result;
use serde_json::{json, Value};
impl Store {
    pub(super) fn builder_resource_preflight(&self, team: &str, spec: &Spec) -> Result<Value> {
        let (policies, policy_issues) = self.resolve_team_policies(team, spec)?;
        let scheduling = policies
            .get("scheduling")
            .map(|v| serde_json::from_value::<Policy>(v["policy"].clone()))
            .transpose()?;
        let at = now();
        let mut targets = Vec::new();
        for target in &spec.execution_targets {
            let mut row = json!({"target_id":target.id,"host":target.host_id,"profile":target.executor_profile_id,
                "model":target.model_id,"quota":null,"capability_identity":"unavailable","eligible_for_execution":false});
            let capacity = self.assignment_capacity(&target.account_binding_id)?;
            row["assignment_capacity"] = json!({
                "scope": "account_shared_across_teams",
                "configured": capacity.is_some(),
                "snapshot": capacity,
                "eligible_for_execution": false
            });
            let candidate = match &scheduling {
                Some(Policy::Scheduling { targets, .. }) => targets.get(&target.id),
                _ => None,
            };
            if let Some(candidate) = candidate {
                let resource = &candidate.resource;
                if resource.host != target.host_id
                    || resource.profile != target.executor_profile_id
                    || resource.account_id != target.account_binding_id
                    || candidate.capability_revision.to_string()
                        != target.capability_profile_revision
                {
                    row["status"] = json!("target_policy_identity_mismatch");
                } else {
                    let quota = self.resource_admission(resource, at)?;
                    row["status"] = json!(quota.reason);
                    row["quota"] = serde_json::to_value(quota)?;
                    let capability = self.capability_profile(
                        &candidate.capability_id,
                        candidate.capability_revision,
                    )?;
                    row["capability_identity"] = json!(match capability {
                        Some(v)
                            if v["host"] == target.host_id
                                && v["profile"] == target.executor_profile_id
                                && v["model"] == target.model_id =>
                            "matched",
                        Some(_) => "mismatch",
                        None => "missing",
                    });
                }
            } else {
                row["status"] = json!("target_policy_missing");
            }
            targets.push(row);
        }
        let mut budgets = Vec::new();
        if let Some(policy) = policies.get("budget") {
            if let Policy::Budget {
                budget_ids,
                max_assignment_charge,
                unit,
                ..
            } = serde_json::from_value::<Policy>(policy["policy"].clone())?
            {
                for id in budget_ids {
                    let snapshot = self.budget(&id)?;
                    let b = &snapshot["budget"];
                    let valid = b["unit"] == unit
                        && (b["scope"] == "shared"
                            || b["scope"] == "team" && b["scope_id"] == team)
                        && b["starts_at"].as_u64().is_some_and(|start| start <= at)
                        && b["ends_at"].as_u64().is_some_and(|end| end > at);
                    let sufficient = valid
                        && snapshot["available"]
                            .as_u64()
                            .is_some_and(|available| available >= max_assignment_charge);
                    budgets.push(json!({"id":id,"snapshot":snapshot,"period_and_scope_valid":valid,"covers_max_assignment_charge":sufficient,"reserved_by_preflight":false}));
                }
            }
        }
        let coordinator_startup = self.coordinator_startup_preflight(team, spec, &policies)?;
        let capacity_issues: Vec<Value> = targets.iter()
            .filter(|target| target["assignment_capacity"]["configured"] != true)
            .map(|target| json!({"code":"assignment_account_capacity_missing","target_id":target["target_id"]}))
            .collect();
        let fresh = !targets.is_empty()
            && targets
                .iter()
                .all(|t| t["status"] == "fresh_quota" && t["capability_identity"] == "matched");
        Ok(
            json!({"checked_at":at,"configured_target_count":spec.execution_targets.len(),"targets":targets,
            "coordinator_startup":coordinator_startup,"assignment_capacity_checks_complete":!targets.is_empty() && capacity_issues.is_empty(),"assignment_capacity_issues":capacity_issues,"quota_and_identity_checks_complete":fresh,"team_budgets":budgets,"policy_issues":policy_issues,
            "eligible_for_execution":false,"pending_checks":["executor_runtime_capabilities","role_fit_evidence","workspace_and_grant","atomic_budget_reservation","human_activation"]}),
        )
    }
}
