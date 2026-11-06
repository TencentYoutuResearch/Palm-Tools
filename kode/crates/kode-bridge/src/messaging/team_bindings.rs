//! Resolve exact project/delivery references inside a team draft. No activation or authority.
use super::{
    project_configs::{Config, Spec as ProjectSpec},
    store::Store,
    teams::{Spec, WorkflowRef},
};
use anyhow::Result;
use serde_json::{json, Value};

impl Store {
    fn binding_config(
        &self,
        binding_id: &str,
        kind: &str,
        reference: &WorkflowRef,
        issues: &mut Vec<Value>,
    ) -> Result<Option<(Value, Config)>> {
        let Some(row) = self.project_config(&reference.id, &reference.version)? else {
            issues.push(json!({"code":"binding_version_missing","binding_id":binding_id,"kind":kind,"reference":reference}));
            return Ok(None);
        };
        if row["hash"] != reference.hash {
            issues.push(json!({"code":"binding_hash_mismatch","binding_id":binding_id,"kind":kind,"reference":reference}));
            return Ok(None);
        }
        let config = serde_json::from_value(row["config"].clone())?;
        Ok(Some((row, config)))
    }

    pub(super) fn resolve_team_bindings(&self, spec: &Spec) -> Result<(Vec<Value>, Vec<Value>)> {
        let mut issues = Vec::new();
        let mut resolved = Vec::new();
        if spec.delivery_bindings.is_empty() {
            issues.push(json!({"code":"delivery_binding_required"}));
        }
        for workflow in &spec.workflow_pack_refs {
            if !spec
                .delivery_bindings
                .iter()
                .any(|binding| &binding.workflow == workflow)
            {
                issues
                    .push(json!({"code":"workflow_delivery_binding_missing","workflow":workflow}));
            }
        }
        for binding in &spec.delivery_bindings {
            let before = issues.len();
            let project =
                self.binding_config(&binding.id, "project", &binding.project, &mut issues)?;
            let delivery = self.binding_config(
                &binding.id,
                "delivery_policy",
                &binding.delivery_policy,
                &mut issues,
            )?;
            if let Some((_, project)) = &project {
                match &project.spec {
                    ProjectSpec::ProjectBindings { repositories, .. } => {
                        for (name, repo) in repositories {
                            let w = &repo.workspace;
                            if !spec.workspace_refs.iter().any(|allowed|
                                allowed.host_id == w.host_id && allowed.workspace_id == w.workspace_id && allowed.root_ref == w.root_ref) {
                                issues.push(json!({"code":"project_workspace_outside_team","binding_id":binding.id,"repository_binding":name,"workspace":w}));
                            }
                        }
                    }
                    _ => issues.push(json!({"code":"binding_kind_mismatch","binding_id":binding.id,"kind":"project"})),
                }
            }
            if let Some((_, delivery)) = &delivery {
                match &delivery.spec {
                    ProjectSpec::DeliveryPolicy { project, workflow, .. } => {
                        if project != &binding.project || workflow != &binding.workflow {
                            issues.push(json!({"code":"delivery_binding_reference_mismatch","binding_id":binding.id}));
                        }
                    }
                    _ => issues.push(json!({"code":"binding_kind_mismatch","binding_id":binding.id,"kind":"delivery_policy"})),
                }
            }
            let workflow = self.workflow(&binding.workflow.id, &binding.workflow.version)?;
            if workflow
                .as_ref()
                .is_none_or(|row| row["hash"] != binding.workflow.hash)
            {
                issues.push(json!({"code":"binding_workflow_unresolved","binding_id":binding.id}));
            }
            let mut dependencies = std::collections::BTreeMap::new();
            if let Some(workflow) = &workflow {
                let pack = serde_json::from_value(workflow["pack"].clone())?;
                let (resolved_dependencies, dependency_issues) = self.resolve_workflow_dependencies(&pack)?;
                dependencies = resolved_dependencies;
                issues.extend(dependency_issues);
            }
            if issues.len() == before {
                let mut row = json!({"id":binding.id,"workflow":workflow.unwrap(),
                    "project":project.unwrap().0,"delivery_policy":delivery.unwrap().0});
                if !dependencies.is_empty() { row["workflow_dependencies"] = serde_json::to_value(dependencies)?; }
                let pack: super::workflows::Pack = serde_json::from_value(row["workflow"]["pack"].clone())?;
                for stage in &pack.stages {
                    let Some(scope) = &stage.execution else { continue };
                    let host = row["project"]["config"]["spec"]["repositories"][&scope.repository_binding]["workspace"]["host_id"].as_str().unwrap_or("");
                    if super::workflow_dependencies::for_stage(&row, stage, host).is_err() {
                        issues.push(json!({"code":"workflow_dependency_host_unavailable","binding_id":binding.id,"stage_id":stage.id}));
                    }
                }
                if issues.len() == before { resolved.push(row); }
            }
        }
        Ok((resolved, issues))
    }
}
