//! Owner-published instruction artifacts. Frozen references never confer additional authority.
use super::{
    model::valid_id,
    project_configs::{Config, Spec},
    store::Store,
    team_grants::Capability,
    teams::WorkflowRef,
    workflows::{ExecutionScope, Pack, Stage},
};
use anyhow::{bail, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub hash: String,
    pub kind: String,
    pub source: String,
    pub source_version: String,
    pub content_hash: String,
}
pub(super) fn operation_manifest(db: &Connection, operation: &str) -> Result<Vec<Manifest>> {
    let pair: Option<(String, String)> = db.query_row(
        "SELECT a.body,r.body FROM work_assignments a JOIN work_runs r ON r.id=a.run_id WHERE a.operation_id=?1",
        [operation], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let Some((assignment, run)) = pair else {
        return Ok(Vec::new());
    };
    let assignment: Value = serde_json::from_str(&assignment)?;
    let run: Value = serde_json::from_str(&run)?;
    let binding = &run["context"]["binding"];
    if !binding["workflow"]["pack"]["stages"]
        .as_array()
        .is_some_and(|stages| {
            stages.iter().any(|stage| {
                stage["execution"]["dependencies"]
                    .as_array()
                    .is_some_and(|dependencies| !dependencies.is_empty())
            })
        })
    {
        return Ok(Vec::new());
    }
    let pack: Pack = serde_json::from_value(binding["workflow"]["pack"].clone())?;
    let stage = pack
        .stages
        .iter()
        .find(|stage| stage.id == assignment["stage_id"])
        .ok_or_else(|| anyhow::anyhow!("assignment workflow stage unavailable"))?;
    let rows = for_stage(
        binding,
        stage,
        assignment["worker"]["node_id"].as_str().unwrap_or(""),
    )?;
    rows.iter().map(|row| {
        let artifact = &row["config"]["spec"]["artifact"];
        Ok(serde_json::from_value(json!({"id":row["id"],"version":row["version"],"hash":row["hash"],
            "kind":artifact["kind"],"source":artifact["source"],"source_version":artifact["source_version"],"content_hash":artifact["content_hash"]}))?)
    }).collect()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Skill,
    Plugin,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub kind: Kind,
    pub source: String,
    pub source_version: String,
    pub content_hash: String,
    pub instructions: String,
    pub hosts: Vec<String>,
    pub tools: Vec<String>,
    pub capabilities: Vec<Capability>,
    pub network: bool,
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn names(values: &[String], maximum: usize) -> bool {
    values.len() <= maximum
        && values.iter().all(|id| valid_id(id))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}
pub(super) fn validate_references(references: &[WorkflowRef]) -> Result<()> {
    if references.len() > 8
        || references
            .iter()
            .any(|r| !valid_id(&r.id) || !valid_id(&r.version) || !hash(&r.hash))
        || references
            .iter()
            .map(|r| &r.id)
            .collect::<BTreeSet<_>>()
            .len()
            != references.len()
    {
        bail!("invalid workflow dependency references")
    }
    Ok(())
}
pub(super) fn normalize(artifact: &mut Artifact) -> Result<()> {
    if artifact.source.trim().is_empty()
        || artifact.source.len() > 1024
        || artifact.source.chars().any(char::is_control)
        || !valid_id(&artifact.source_version)
        || artifact.instructions.trim().is_empty()
        || artifact.instructions.len() > 16384
        || artifact.instructions.contains('\0')
        || artifact.content_hash
            != format!("{:x}", Sha256::digest(artifact.instructions.as_bytes()))
        || artifact.hosts.is_empty()
        || !names(&artifact.hosts, 64)
        || !names(&artifact.tools, 256)
        || artifact.capabilities.len() > 8
        || artifact
            .capabilities
            .iter()
            .enumerate()
            .any(|(i, c)| artifact.capabilities[..i].contains(c))
    {
        bail!("invalid workflow instruction artifact or content hash")
    }
    artifact.hosts.sort();
    artifact.tools.sort();
    artifact
        .capabilities
        .sort_by_cached_key(|c| serde_json::to_string(c).unwrap());
    Ok(())
}
fn scoped(artifact: &Artifact, scope: &ExecutionScope, host: Option<&str>) -> Result<()> {
    if artifact
        .tools
        .iter()
        .any(|tool| !scope.tools.contains(tool))
        || artifact
            .capabilities
            .iter()
            .any(|capability| !scope.capabilities.contains(capability))
        || (artifact.network && !scope.network)
        || host.is_some_and(|host| !artifact.hosts.iter().any(|allowed| allowed == host))
    {
        bail!("workflow dependency exceeds the stage scope or execution Host")
    }
    Ok(())
}

impl Store {
    pub(super) fn resolve_workflow_dependencies(
        &self,
        pack: &Pack,
    ) -> Result<(BTreeMap<String, Vec<Value>>, Vec<Value>)> {
        let mut resolved = BTreeMap::new();
        let mut issues = Vec::new();
        for stage in &pack.stages {
            let Some(scope) = &stage.execution else {
                continue;
            };
            let mut rows = Vec::new();
            for reference in &scope.dependencies {
                let Some(row) = self.project_config(&reference.id, &reference.version)? else {
                    issues.push(json!({"code":"workflow_dependency_missing","stage_id":stage.id,"reference":reference}));
                    continue;
                };
                let config: Config = serde_json::from_value(row["config"].clone())?;
                let compatible = match &config.spec {
                    Spec::WorkflowDependency { artifact } => scoped(artifact, scope, None).is_ok(),
                    _ => false,
                };
                if row["hash"] != reference.hash || !compatible {
                    issues.push(json!({"code":"workflow_dependency_mismatch","stage_id":stage.id,"reference":reference}));
                    continue;
                }
                rows.push(row);
            }
            if !scope.dependencies.is_empty() {
                resolved.insert(stage.id.clone(), rows);
            }
        }
        Ok((resolved, issues))
    }
}

/// Validate the exact frozen artifact bytes and requirements again at dispatch/admission.
pub(super) fn for_stage(binding: &Value, stage: &Stage, host: &str) -> Result<Vec<Value>> {
    let Some(scope) = &stage.execution else {
        return Ok(Vec::new());
    };
    let rows = &binding["workflow_dependencies"][&stage.id];
    if scope.dependencies.is_empty() {
        if !rows.is_null() && rows.as_array().is_none_or(|rows| !rows.is_empty()) {
            bail!("unbound workflow dependency")
        }
        return Ok(Vec::new());
    }
    let rows = rows
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("frozen workflow dependencies unavailable"))?;
    if rows.len() != scope.dependencies.len() {
        bail!("frozen workflow dependency count mismatch")
    }
    let mut selected = Vec::new();
    for reference in &scope.dependencies {
        let row = rows
            .iter()
            .find(|row| row["id"] == reference.id && row["version"] == reference.version)
            .ok_or_else(|| anyhow::anyhow!("frozen workflow dependency identity mismatch"))?;
        let config: Config = serde_json::from_value(row["config"].clone())?;
        if config.id != reference.id
            || config.version != reference.version
            || row["hash"] != reference.hash
            || format!(
                "{:x}",
                Sha256::digest(super::project_configs::canonical(&config)?.as_bytes())
            ) != reference.hash
        {
            bail!("frozen workflow dependency hash mismatch")
        }
        let Spec::WorkflowDependency { mut artifact } = config.spec else {
            bail!("workflow dependency kind mismatch")
        };
        normalize(&mut artifact)?;
        scoped(&artifact, scope, Some(host))?;
        selected.push(row.clone());
    }
    if serde_json::to_vec(&selected)?.len() > 32768 {
        bail!("workflow dependency stage input exceeds bound")
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        let instructions = "Use the reviewed project procedure. 保留独立评审。";
        serde_json::from_value(json!({"id":"method","version":"1","spec":{"kind":"workflow_dependency","artifact":{
            "kind":"plugin","source":"fixture://workflow/method","source_version":"0.3.0",
            "content_hash":format!("{:x}",Sha256::digest(instructions.as_bytes())),"instructions":instructions,
            "hosts":["remote","home"],"tools":["read_source"],"capabilities":["read"],"network":false}}})).unwrap()
    }
    fn pack() -> Pack {
        serde_json::from_value(json!({"id":"flow","version":"1","inputs":["request"],"stages":[{
            "id":"inspect","role":"inspector","requires":["request"],"produces":["report"],"independent_from":[],
            "execution":{"repository_binding":"code","capabilities":["read"],"tools":["read_source"],"network":false}}],
            "completion_stages":["inspect"],"evidence_rules":{"report":{"kind":"report","schema_id":"report","schema_hash":"a".repeat(64)}}})).unwrap()
    }
    #[test]
    fn immutable_registration_validates_exact_bytes_and_survives_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let original = config();
        let row = store.save_project_config(original.clone()).unwrap();
        let mut reordered = original.clone();
        if let Spec::WorkflowDependency { artifact } = &mut reordered.spec {
            artifact.hosts.reverse();
        }
        assert_eq!(store.save_project_config(reordered).unwrap(), row);
        let mut changed = original.clone();
        if let Spec::WorkflowDependency { artifact } = &mut changed.spec {
            artifact.instructions.push_str(" changed");
            assert!(normalize(artifact).is_err());
            artifact.content_hash =
                format!("{:x}", Sha256::digest(artifact.instructions.as_bytes()));
        }
        assert!(store.save_project_config(changed.clone()).is_err());
        changed.version = "2".into();
        assert!(store.save_project_config(changed).is_ok());
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(store.project_config("method", "1").unwrap().unwrap(), row);
    }
    #[test]
    fn frozen_stage_dependencies_reject_missing_hash_scope_host_and_tampering() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        let artifact = store.save_project_config(config()).unwrap();
        let mut pack = pack();
        let reference: WorkflowRef =
            serde_json::from_value(json!({"id":"method","version":"1","hash":artifact["hash"]}))
                .unwrap();
        pack.stages[0]
            .execution
            .as_mut()
            .unwrap()
            .dependencies
            .push(reference);
        let (resolved, issues) = store.resolve_workflow_dependencies(&pack).unwrap();
        assert!(issues.is_empty());
        let binding = json!({"workflow_dependencies":resolved});
        assert_eq!(
            for_stage(&binding, &pack.stages[0], "home").unwrap(),
            vec![artifact]
        );
        assert!(for_stage(&binding, &pack.stages[0], "foreign").is_err());
        assert!(for_stage(&json!({}), &pack.stages[0], "home").is_err());
        let mut tampered = binding.clone();
        tampered["workflow_dependencies"]["inspect"][0]["config"]["spec"]["artifact"]
            ["instructions"] = json!("replacement");
        assert!(for_stage(&tampered, &pack.stages[0], "home").is_err());
        let scope = pack.stages[0].execution.as_mut().unwrap();
        scope.tools.clear();
        assert!(!store
            .resolve_workflow_dependencies(&pack)
            .unwrap()
            .1
            .is_empty());
        pack.stages[0].execution.as_mut().unwrap().dependencies[0].version = "missing".into();
        assert_eq!(
            store.resolve_workflow_dependencies(&pack).unwrap().1[0]["code"],
            "workflow_dependency_missing"
        );
    }
    #[test]
    fn omitted_and_empty_dependencies_preserve_existing_workflow_hashes() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        let pack = pack();
        let row = store.save_workflow(pack.clone()).unwrap();
        assert_eq!(row["hash_format"], "kode.workflow.execution.v3");
        assert!(row["pack"]["stages"][0]["execution"]
            .get("dependencies")
            .is_none());
        let mut explicit = serde_json::to_value(pack).unwrap();
        explicit["stages"][0]["execution"]["dependencies"] = json!([]);
        assert_eq!(
            store
                .save_workflow(serde_json::from_value(explicit).unwrap())
                .unwrap(),
            row
        );
    }
}
