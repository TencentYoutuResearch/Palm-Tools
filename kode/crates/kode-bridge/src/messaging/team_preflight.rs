//! Read-only diagnostics for an exact team revision. Never admission or activation.
use super::{
    model::{now, valid_id},
    store::Store,
    teams::Spec,
    workflows::Pack,
};
use anyhow::{bail, Result};
use serde_json::{json, Value};

impl Store {
    pub fn team_workflow_preflight(&self, id: &str, revision: u64) -> Result<Option<Value>> {
        if !valid_id(id) || revision == 0 || revision > i64::MAX as u64 {
            bail!("invalid team revision");
        }
        let Some(team) = self.team(id, Some(revision))? else {
            return Ok(None);
        };
        let spec: Spec = serde_json::from_value(team["spec"].clone())?;
        Ok(Some(self.team_spec_preflight(
            id,
            Some(revision),
            team["superagent_id"].clone(),
            &spec,
        )?))
    }
    pub(super) fn team_spec_preflight(
        &self,
        id: &str,
        revision: Option<u64>,
        superagent_id: Value,
        spec: &Spec,
    ) -> Result<Value> {
        spec.validate()?;
        let mut issues = Vec::new();
        let mut workflows = Vec::new();
        if spec.workflow_pack_refs.is_empty() {
            issues.push(json!({"code":"workflow_required"}));
        }
        for reference in &spec.workflow_pack_refs {
            let Some(stored) = self.workflow(&reference.id, &reference.version)? else {
                issues.push(json!({"code":"workflow_version_missing","workflow":reference}));
                continue;
            };
            if stored["hash"].as_str() != Some(reference.hash.as_str()) {
                issues.push(json!({"code":"workflow_hash_mismatch","workflow":reference,"stored_hash":stored["hash"]}));
                continue;
            }
            let pack: Pack = serde_json::from_value(stored["pack"].clone())?;
            let mut stages = Vec::new();
            for stage in &pack.stages {
                let mut candidates = Vec::new();
                // Coordinator is a system role, not a special completion-stage name.
                if stage.role == "coordinator" && !spec.coordinator_targets.is_empty() {
                    candidates.push(json!({"kind":"coordinator","superagent_id":superagent_id,
                        "target_ids":spec.coordinator_targets}));
                }
                for worker in spec
                    .workers
                    .iter()
                    .filter(|w| w.role == stage.role && !w.allowed_target_ids.is_empty())
                {
                    candidates.push(json!({"kind":"worker","worker_id":worker.id,"target_ids":worker.allowed_target_ids}));
                }
                if candidates.is_empty() {
                    issues.push(json!({"code":"stage_role_unassigned","workflow":reference,"stage_id":stage.id,"role":stage.role}));
                }
                stages.push(json!({"stage_id":stage.id,"role":stage.role,"configured_candidates":candidates,
                    "execution":stage.execution,"independent_from":stage.independent_from,"requires_distinct_assignment_context":!stage.independent_from.is_empty()}));
            }
            workflows.push(json!({"reference":reference,"stages":stages,"completion_stages":pack.completion_stages,
                "evidence_rules_declared":!pack.evidence_rules.is_empty(),"evidence_rules":pack.evidence_rules}));
        }
        let (bindings, binding_issues) = self.resolve_team_bindings(spec)?;
        let (policies, policy_issues) = self.resolve_team_policies(id, spec)?;
        Ok(
            json!({"schema_version":1,"team_id":id,"team_revision":revision,"home_hub":self.node_id,
            "checked_at":now(),"workflow_bindings_valid":issues.is_empty(),"issues":issues,"workflows":workflows,
            "execution_policy_bindings_valid":policy_issues.is_empty(),"policy_issues":policy_issues,"policies":policies,
            "project_delivery_bindings_valid":binding_issues.is_empty(),"binding_issues":binding_issues,"bindings":bindings,
            "eligible_for_execution":false,"pending_checks":["evidence_schemas","trusted_project_adapters","delivery_capabilities",
            "executor_capabilities","resource_coverage","workspace_and_grant","budget_and_scheduling",
            "runtime_assignment_independence","human_activation"]}),
        )
    }
}
