//! Declarative graph preflight. Structural validity never grants execution authority.
use super::{model::valid_id, team_grants::Capability};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pack {
    pub id: String,
    pub version: String,
    pub inputs: Vec<String>,
    pub stages: Vec<Stage>,
    /// Every required stage must lie on a path to one of these configured endpoints.
    pub completion_stages: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub evidence_rules: BTreeMap<String, EvidenceRule>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EvidenceRule {
    Artifact {
        repository_binding: String,
    },
    Review {
        artifact_output: String,
    },
    Verification {
        artifact_output: String,
        command_binding: String,
        environment_binding: String,
        required_scenarios: Vec<String>,
    },
    Report {
        schema_id: String,
        schema_hash: String,
    },
}
impl Pack {
    pub fn hash_format(&self) -> &'static str {
        if self.stages.iter().any(|stage| stage.execution.as_ref().is_some_and(|scope| scope.input_artifact.is_some())) {
            "kode.workflow.input-artifact.v8"
        } else if self.stages.iter().any(|stage| stage.execution.as_ref().is_some_and(|scope| !scope.dependencies.is_empty())) {
            "kode.workflow.dependencies.v7"
        } else if self.stages.iter().any(|stage| stage.waiver.is_some()) {
            "kode.workflow.execution.v6"
        } else if self.stages.iter().any(|stage| stage.execution.as_ref().is_some_and(|scope| !scope.escalation.is_empty())) {
            "kode.workflow.execution.v5"
        } else if self.stages.iter().any(|stage| {
            stage
                .execution
                .as_ref()
                .is_some_and(|scope| scope.task_tag.is_some())
        }) {
            "kode.workflow.execution.v4"
        } else if self.stages.iter().any(|stage| stage.execution.is_some()) {
            "kode.workflow.execution.v3"
        } else if self.evidence_rules.is_empty() {
            "kode.workflow.graph.v1"
        } else {
            "kode.workflow.evidence.v2"
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Stage {
    pub id: String,
    pub role: String,
    pub requires: Vec<String>,
    pub produces: Vec<String>,
    /// Ancestors whose assignment identity/context must differ at runtime.
    pub independent_from: Vec<String>,
    pub on_reject: Option<Rework>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiver: Option<super::stage_waiver::Policy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionScope>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_artifact: Option<InputArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<super::teams::WorkflowRef>,
    /// Explicit capability assessment category; no role-name inference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub escalation: Vec<super::stage_escalation::Escalation>,
    pub repository_binding: String,
    pub capabilities: Vec<Capability>,
    pub tools: Vec<String>,
    pub network: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InputArtifact {
    pub stage: String,
    pub output: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rework {
    pub target: String,
    /// Zero records a rejected stage and waits for owner action without scheduling a retry.
    pub max_reworks: u16,
}

fn identifiers(values: &[String], max: usize) -> Result<BTreeSet<String>> {
    let set: BTreeSet<_> = values.iter().cloned().collect();
    if values.len() > max || set.len() != values.len() || values.iter().any(|v| !valid_id(v)) {
        bail!("invalid or duplicate workflow identifiers");
    }
    Ok(set)
}

pub fn validate(pack: &Pack) -> Result<Value> {
    if !valid_id(&pack.id)
        || !valid_id(&pack.version)
        || pack.stages.is_empty()
        || pack.stages.len() > 64
        || serde_json::to_vec(pack)?.len() > 65536
    {
        bail!("invalid workflow bounds");
    }
    let inputs = identifiers(&pack.inputs, 64)?;
    if inputs.is_empty() {
        bail!("workflow requires declared inputs");
    }
    let ids = identifiers(
        &pack.stages.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        64,
    )?;
    if !inputs.is_disjoint(&ids) {
        bail!("ambiguous workflow input and stage identity");
    }
    let endpoints = identifiers(&pack.completion_stages, 64)?;
    if endpoints.is_empty() || !endpoints.is_subset(&ids) {
        bail!("unknown or empty completion stages");
    }
    for stage in &pack.stages {
        if !valid_id(&stage.role) || stage.requires.is_empty() || stage.produces.is_empty() {
            bail!("stage requires a role, dependencies and evidence outputs");
        }
        if let Some(scope) = &stage.execution {
            if scope.task_tag.as_ref().is_some_and(|tag| !valid_id(tag))
                || !valid_id(&scope.repository_binding)
                || scope.capabilities.len() > 8
                || !scope.capabilities.contains(&Capability::Read)
                || scope
                    .capabilities
                    .iter()
                    .enumerate()
                    .any(|(i, c)| scope.capabilities[..i].contains(c))
                || pack.evidence_rules.is_empty()
            {
                bail!("execution scope requires unique capabilities, read access, repository and evidence rules");
            }
            identifiers(&scope.tools, 256)?;
            super::workflow_dependencies::validate_references(&scope.dependencies)?;
            super::stage_escalation::validate(scope)?;
        }
        super::stage_waiver::validate(pack, stage)?;
        let dependencies = identifiers(&stage.requires, 64)?;
        identifiers(&stage.produces, 64)?;
        identifiers(&stage.independent_from, 64)?;
        if dependencies
            .iter()
            .any(|v| !inputs.contains(v) && !ids.contains(v))
        {
            bail!("unknown workflow dependency");
        }
    }
    // Stable topological order, independent of input array order; no recursive traversal.
    let mut ancestors: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut order = Vec::new();
    while order.len() < pack.stages.len() {
        let next = pack
            .stages
            .iter()
            .filter(|s| !ancestors.contains_key(&s.id))
            .filter(|s| {
                s.requires
                    .iter()
                    .all(|r| inputs.contains(r) || ancestors.contains_key(r))
            })
            .min_by_key(|s| &s.id);
        let Some(stage) = next else {
            bail!("workflow dependency cycle");
        };
        let mut prior = BTreeSet::new();
        for dependency in &stage.requires {
            if let Some(inherited) = ancestors.get(dependency) {
                prior.insert(dependency.clone());
                prior.extend(inherited.iter().cloned());
            }
        }
        if stage.independent_from.iter().any(|id| !prior.contains(id)) {
            bail!("independent assignment reference must be an ancestor stage");
        }
        super::workflow_input_artifact::validate(pack, stage, &prior)?;
        if let Some(rework) = &stage.on_reject {
            if !prior.contains(&rework.target) || rework.max_reworks > 100 {
                bail!("rework requires an ancestor target and bounded attempts");
            }
        }
        order.push(stage.id.clone());
        ancestors.insert(stage.id.clone(), prior);
    }
    let mut covered = endpoints.clone();
    for endpoint in &endpoints {
        covered.extend(ancestors[endpoint].iter().cloned());
    }
    if covered != ids {
        bail!("completion leaves required workflow stages unaccounted for");
    }
    validate_evidence_rules(pack, &ancestors)?;
    Ok(
        json!({"schema_version":1,"structurally_valid":true,"topological_order":order,
        "evidence_rules_declared":!pack.evidence_rules.is_empty(),
        "execution_scopes_declared":pack.stages.iter().all(|s|s.execution.is_some()),
        "eligible_for_execution":false,"pending_checks":["immutable_version_storage","evidence_schemas",
        "project_bindings","delivery_policy","resource_coverage","grant","budget","human_activation"]}),
    )
}

fn validate_evidence_rules(
    pack: &Pack,
    ancestors: &BTreeMap<String, BTreeSet<String>>,
) -> Result<()> {
    // Legacy graph drafts retain their exact canonical identity, but cannot satisfy
    // the later evidence gate without a new version declaring these rules.
    if pack.evidence_rules.is_empty() {
        return Ok(());
    }
    if pack.evidence_rules.len() > 128 {
        bail!("too many workflow evidence rules");
    }
    let mut producers = BTreeMap::new();
    for stage in &pack.stages {
        for output in &stage.produces {
            if producers.insert(output, stage).is_some() {
                bail!("ambiguous workflow evidence producer");
            }
        }
    }
    if producers.len() != pack.evidence_rules.len()
        || producers
            .keys()
            .any(|name| !pack.evidence_rules.contains_key(*name))
    {
        bail!("every workflow output requires exactly one evidence rule");
    }
    for (output, rule) in &pack.evidence_rules {
        let stage = producers[output];
        if let Some(scope) = &stage.execution {
            let repository = match rule {
                EvidenceRule::Artifact { repository_binding } => Some(repository_binding),
                EvidenceRule::Review { artifact_output }
                | EvidenceRule::Verification {
                    artifact_output, ..
                } => {
                    if scope.capabilities != vec![Capability::Read] {
                        bail!("review and verification require read-only source workspace scope");
                    }
                    match pack.evidence_rules.get(artifact_output) {
                        Some(EvidenceRule::Artifact { repository_binding }) => {
                            Some(repository_binding)
                        }
                        _ => None,
                    }
                }
                EvidenceRule::Report { .. } => None,
            };
            if repository.is_some_and(|r| r != &scope.repository_binding) {
                bail!("stage execution repository differs from evidence source");
            }
        }
        match rule {
            EvidenceRule::Artifact { repository_binding } => {
                if !valid_id(repository_binding) {
                    bail!("invalid repository binding");
                }
            }
            EvidenceRule::Report {
                schema_id,
                schema_hash,
            } => {
                if !valid_id(schema_id)
                    || schema_hash.len() != 64
                    || !schema_hash
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                {
                    bail!("invalid report schema reference");
                }
            }
            EvidenceRule::Review { artifact_output }
            | EvidenceRule::Verification {
                artifact_output, ..
            } => {
                let source = producers
                    .get(artifact_output)
                    .ok_or_else(|| anyhow::anyhow!("unknown artifact output"))?;
                if !matches!(
                    pack.evidence_rules.get(artifact_output),
                    Some(EvidenceRule::Artifact { .. })
                ) || !ancestors[&stage.id].contains(&source.id)
                {
                    bail!("evidence must reference an ancestor artifact output");
                }
                if matches!(rule, EvidenceRule::Review { .. })
                    && !stage.independent_from.contains(&source.id)
                {
                    bail!("review rule requires independent artifact producer assignment");
                }
                if let EvidenceRule::Verification {
                    command_binding,
                    environment_binding,
                    required_scenarios,
                    ..
                } = rule
                {
                    if !valid_id(command_binding)
                        || !valid_id(environment_binding)
                        || required_scenarios.is_empty()
                    {
                        bail!("verification requires command, environment and scenarios");
                    }
                    identifiers(required_scenarios, 128)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pack() -> Pack {
        serde_json::from_value(json!({"id":"local","version":"1","inputs":["request"],
            "stages":[
                {"id":"make","role":"author","requires":["request"],"produces":["snapshot"],"independent_from":[]},
                {"id":"check","role":"reviewer","requires":["make"],"produces":["verdict"],"independent_from":["make"],"on_reject":{"target":"make","max_reworks":3}}
            ],"completion_stages":["check"]})).unwrap()
    }
    #[test]
    fn configurable_order_and_endpoint() {
        let mut p = pack();
        p.stages.reverse();
        assert_eq!(
            validate(&p).unwrap()["topological_order"],
            json!(["make", "check"])
        );
        p.stages.retain(|s| s.id == "make");
        p.completion_stages = vec!["make".into()];
        assert!(validate(&p).is_ok()); // No fixed requirement for a stage named review or deliver.
    }
    #[test]
    fn rejection_may_wait_for_owner_without_any_automatic_rework() {
        let mut p = pack();
        p.stages[1].on_reject.as_mut().unwrap().max_reworks = 0;
        assert!(validate(&p).is_ok());
        // A disabled retry policy still cannot point at a nonancestor or itself.
        p.stages[1].on_reject.as_mut().unwrap().target = "check".into();
        assert!(validate(&p).is_err());
        p.stages[1].on_reject.as_mut().unwrap().target = "missing".into();
        assert!(validate(&p).is_err());
    }
    #[test]
    fn malformed_graphs_cannot_pass_preflight() {
        for case in 0..9 {
            let mut p = pack();
            match case {
                0 => p.stages[0].requires = vec!["check".into()],
                1 => p.stages[0].requires = vec!["missing".into()],
                2 => p.stages[1].independent_from = vec!["check".into()],
                3 => p.stages[1].on_reject.as_mut().unwrap().target = "check".into(),
                4 => p.stages[1].on_reject.as_mut().unwrap().max_reworks = 101,
                5 => p.completion_stages = vec!["make".into()],
                6 => p.inputs.push("make".into()),
                7 => p.stages[1].id = "make".into(),
                _ => p.stages[1].requires.push("make".into()),
            }
            assert!(validate(&p).is_err(), "case {case}");
        }
    }
}
