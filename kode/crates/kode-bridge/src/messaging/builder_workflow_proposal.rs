//! Reviewable configuration only. Registry validation and owner registration remain separate.
use super::{model::valid_id, project_configs, teams::WorkspaceRef, workflows};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::Value;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Package {
    workflow: workflows::Pack,
    project: project_configs::Config,
    delivery: Delivery,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Delivery {
    id: String,
    version: String,
    targets: Vec<project_configs::Target>,
    required_outputs: Vec<String>,
}
pub(super) fn validate(value: &Value, selected: &[WorkspaceRef]) -> Result<()> {
    if serde_json::to_vec(value)?.len() > 131072 {
        bail!("Builder workflow proposal too large")
    }
    let package: Package = serde_json::from_value(value.clone())?;
    workflows::validate(&package.workflow)?;
    if !valid_id(&package.project.id)
        || !valid_id(&package.project.version)
        || !valid_id(&package.delivery.id)
        || !valid_id(&package.delivery.version)
        || package.delivery.targets.is_empty()
        || package.delivery.targets.len() > 64
        || package.delivery.required_outputs.is_empty()
        || package.delivery.required_outputs.len() > 128
        || package
            .delivery
            .required_outputs
            .iter()
            .any(|s| !valid_id(s))
    {
        bail!("invalid Builder workflow proposal")
    }
    let project_configs::Spec::ProjectBindings {
        repositories,
        environments,
        ..
    } = package.project.spec
    else {
        bail!("Builder proposal requires project bindings")
    };
    if repositories.is_empty()
        || repositories.values().any(|r| {
            !selected.iter().any(|w| {
                w.host_id == r.workspace.host_id
                    && w.workspace_id == r.workspace.workspace_id
                    && w.root_ref == r.workspace.root_ref
            })
        })
        || environments
            .values()
            .any(|e| !selected.iter().any(|w| w.host_id == e.host_id))
    {
        bail!("Builder workflow proposal outside selected workspaces")
    }
    Ok(())
}
