//! Diagnostic startup coverage for Builder and owner review; never activation or reservation.
use super::{model::now, pricing::ModelPolicy, store::Store, team_grants::Capability, teams::Spec};
use anyhow::Result;
use serde_json::{json, Value};
impl Store {
    pub(super) fn coordinator_startup_preflight(
        &self,
        team: &str,
        spec: &Spec,
        policies: &Value,
    ) -> Result<Value> {
        let mut issues = Vec::new();
        let mut target_issues = Vec::new();
        let mut candidates = Vec::new();
        let mut ranking = Value::Null;
        let startup = spec.coordinator_startup.as_ref();
        if startup.is_none() {
            issues.push(json!({"code":"coordinator_startup_required"}));
        }
        let workspace = startup.and_then(|c| {
            let rows: Vec<_> = spec
                .workspace_refs
                .iter()
                .filter(|w| w.host_id == self.node_id && w.workspace_id == c.workspace_id)
                .collect();
            if rows.len() == 1 {
                Some(rows[0])
            } else {
                None
            }
        });
        if startup.is_some() && workspace.is_none() {
            issues.push(json!({"code":"coordinator_local_workspace_required"}));
        }
        let grant = spec
            .grant_id
            .as_ref()
            .map(|id| self.team_grant(id, None))
            .transpose()?
            .flatten();
        let required_tools = [
            "kode_coordinator_publish_reply",
            "kode_coordinator_workflow_start",
            "kode_coordinator_configuration",
            "kode_coordinator_workflow_status",
        ];
        let grant_ok = grant.as_ref().is_some_and(|g| {
            g.policy.team_id == team
                && g.policy.enabled
                && g.policy.expires_at > now()
                && [Capability::Read, Capability::Delegate]
                    .iter()
                    .all(|c| g.policy.capabilities.contains(c))
                && required_tools
                    .iter()
                    .all(|t| g.policy.tools.iter().any(|name| name == t))
                && workspace.is_some_and(|w| {
                    g.policy.targets.iter().any(|t| {
                        t.host == w.host_id && t.workspace == w.workspace_id && t.root == w.root_ref
                    })
                })
        });
        if !grant_ok {
            issues.push(json!({"code":"coordinator_startup_grant_incomplete"}));
        }
        let budget = &policies["budget"]["policy"];
        if budget["kind"] != "budget"
            || !budget["budget_ids"].as_array().is_some_and(|ids| {
                !ids.is_empty()
                    && grant.as_ref().is_some_and(|g| {
                        ids.iter().all(|id| {
                            id.as_str()
                                .is_some_and(|id| g.policy.budget_ids.iter().any(|b| b == id))
                        })
                    })
            })
        {
            issues.push(json!({"code":"coordinator_startup_budget_incomplete"}));
        }
        let schedule = &policies["scheduling"]["policy"];
        for target in spec
            .execution_targets
            .iter()
            .filter(|t| spec.coordinator_targets.contains(&t.id) && t.host_id == self.node_id)
        {
            let candidate = &schedule["targets"][&target.id];
            let resource = &candidate["resource"];
            let mut missing = Vec::new();
            if target.executor_profile_revision.is_none() {
                missing.push("executor_profile_revision_missing");
            }
            if resource["host"] != target.host_id
                || resource["profile"] != target.executor_profile_id
                || resource["account_id"] != target.account_binding_id
                || candidate["capability_revision"]
                    .as_u64()
                    .map(|n| n.to_string())
                    .as_deref()
                    != Some(&target.capability_profile_revision)
            {
                missing.push("target_policy_identity_mismatch");
            }
            let price = candidate["internal_price_id"]
                .as_str()
                .map(|id| self.price(id))
                .transpose()?
                .flatten();
            if !price.as_ref().is_some_and(|p| {
                p.model == target.model_id
                    && p.model_policy == ModelPolicy::RequestedModel
                    && budget["unit"] == p.unit
            }) {
                missing.push("requested_model_price_missing_or_mismatched");
            }
            if missing.is_empty() {
                candidates.push(json!({"capability_id":candidate["capability_id"],"capability_revision":candidate["capability_revision"],"resource":resource,"model":target.model_id,"preferred":candidate["preferred"]}));
            } else {
                target_issues.push(json!({"target_id":target.id,"issues":missing}));
            }
        }
        if candidates.is_empty() {
            issues.push(json!({"code":"coordinator_priced_local_target_required"}));
        }
        if let Some(startup) = startup {
            if !candidates.is_empty() {
                let request = serde_json::from_value(
                    json!({"task_tag":startup.task_tag,"minimum_quality":schedule["minimum_quality"],"minimum_confidence":schedule["minimum_confidence"],"weights":schedule["weights"],"candidates":candidates}),
                );
                match request.and_then(|r| self.rank_resources(r).map_err(serde::de::Error::custom))
                {
                    Ok(value) => {
                        if value["candidates"].as_array().is_none_or(|c| c.is_empty()) {
                            issues.push(
                                json!({"code":"coordinator_role_or_resource_evidence_unavailable"}),
                            );
                        }
                        ranking = value;
                    }
                    Err(_) => {
                        issues.push(json!({"code":"coordinator_ranking_configuration_invalid"}))
                    }
                }
            }
        }
        Ok(
            json!({"configuration_checks_complete":issues.is_empty(),"issues":issues,"target_issues":target_issues,"ranking":ranking,
   "startup":startup,"checked_at":now(),"eligible_for_execution":false,"reserved_by_preflight":false,
   "pending_checks":["local_runtime_profile_and_model_support","current_budget_availability","atomic_start_admission","owner_activation"]}),
        )
    }
}
