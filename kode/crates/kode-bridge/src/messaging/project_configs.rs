//! Immutable project bindings and delivery intent. References confer no connection or execution authority.
use super::{
    model::{now, valid_id},
    store::Store,
    teams::{WorkflowRef, WorkspaceRef},
    workflows::{EvidenceRule, Pack},
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Repository {
    pub repository_id: String,
    pub workspace: WorkspaceRef,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Environment {
    pub host_id: String,
    pub adapter_id: String,
    pub configuration_hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub revision: String,
    pub definition_hash: String,
    pub repository_binding: String,
    pub environment_binding: String,
    pub runner_id: String,
    pub scenario_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclusive_resources: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub adapter_id: String,
    pub connection_id: String,
    pub capabilities: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Local {
        repository_binding: String,
    },
    ChangeRequest {
        repository_binding: String,
        connection_binding: String,
        target_branch: String,
    },
    Merged {
        repository_binding: String,
        connection_binding: String,
        target_branch: String,
    },
    Deployed {
        repository_binding: String,
        connection_binding: String,
        environment_binding: String,
    },
    Custom {
        capability: String,
        connection_binding: String,
        target_ref: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Spec {
    WorkflowDependency {
        artifact: super::workflow_dependencies::Artifact,
    },
    ProjectBindings {
        repositories: BTreeMap<String, Repository>,
        environments: BTreeMap<String, Environment>,
        commands: BTreeMap<String, Command>,
        connections: BTreeMap<String, Connection>,
    },
    DeliveryPolicy {
        project: WorkflowRef,
        workflow: WorkflowRef,
        targets: Vec<Target>,
        required_outputs: Vec<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        human_acceptance: bool,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub id: String,
    pub version: String,
    pub spec: Spec,
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn names(values: &[String]) -> bool {
    values.len() <= 128
        && values.iter().all(|v| valid_id(v))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}
fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
}
fn map_keys<T>(map: &BTreeMap<String, T>) -> bool {
    map.len() <= 64 && map.keys().all(|k| valid_id(k))
}
pub(super) fn canonical(input: &Config) -> Result<String> {
    Ok(format!("kode.project.config.v1\n{}", serde_json::to_string(input)?))
}

impl Store {
    pub fn project_config(&self, id: &str, version: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(version) {
            bail!("invalid project configuration identity");
        }
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT body FROM project_configs WHERE id=?1 AND version=?2",
                params![id, version],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|body| Ok(serde_json::from_str(&body)?))
            .transpose()
    }
    pub fn save_project_config(&self, mut input: Config) -> Result<Value> {
        if !valid_id(&input.id)
            || !valid_id(&input.version)
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid project configuration bounds");
        }
        match &mut input.spec {
            Spec::WorkflowDependency { artifact } => {
                super::workflow_dependencies::normalize(artifact)?;
            }
            Spec::ProjectBindings {
                repositories,
                environments,
                commands,
                connections,
            } => {
                if !map_keys(repositories)
                    || !map_keys(environments)
                    || !map_keys(commands)
                    || !map_keys(connections)
                {
                    bail!("invalid project binding names");
                }
                for r in repositories.values() {
                    if !valid_id(&r.repository_id)
                        || !valid_id(&r.workspace.host_id)
                        || !valid_id(&r.workspace.workspace_id)
                        || !text(&r.workspace.root_ref)
                    {
                        bail!("invalid repository workspace reference");
                    }
                }
                for e in environments.values() {
                    if !valid_id(&e.host_id)
                        || !valid_id(&e.adapter_id)
                        || !hash(&e.configuration_hash)
                    {
                        bail!("invalid environment binding");
                    }
                }
                for c in commands.values_mut() {
                    if !valid_id(&c.id)
                        || !valid_id(&c.revision)
                        || !hash(&c.definition_hash)
                        || !valid_id(&c.runner_id)
                        || !repositories.contains_key(&c.repository_binding)
                        || !environments.contains_key(&c.environment_binding)
                        || c.scenario_ids.is_empty()
                        || !names(&c.scenario_ids)
                        || c.exclusive_resources.len() > 16
                        || !names(&c.exclusive_resources)
                    {
                        bail!("invalid command binding");
                    }
                    if repositories[&c.repository_binding].workspace.host_id
                        != environments[&c.environment_binding].host_id
                    {
                        bail!("command environment host differs from repository host");
                    }
                    c.scenario_ids.sort();
                    c.exclusive_resources.sort();
                }
                for c in connections.values_mut() {
                    if !valid_id(&c.adapter_id)
                        || !valid_id(&c.connection_id)
                        || !names(&c.capabilities)
                    {
                        bail!("invalid connection binding");
                    }
                    c.capabilities.sort();
                }
            }
            Spec::DeliveryPolicy {
                project,
                workflow,
                targets,
                required_outputs,
                ..
            } => {
                let stored = self
                    .project_config(&project.id, &project.version)?
                    .ok_or_else(|| anyhow::anyhow!("unknown project bindings"))?;
                if stored["hash"] != project.hash {
                    bail!("project bindings hash mismatch");
                }
                let config: Config = serde_json::from_value(stored["config"].clone())?;
                let Spec::ProjectBindings {
                    repositories,
                    environments,
                    connections,
                    commands,
                } = config.spec
                else {
                    bail!("delivery project must reference project bindings");
                };
                let stored = self
                    .workflow(&workflow.id, &workflow.version)?
                    .ok_or_else(|| anyhow::anyhow!("unknown workflow version"))?;
                if stored["hash"] != workflow.hash {
                    bail!("workflow hash mismatch");
                }
                let pack: Pack = serde_json::from_value(stored["pack"].clone())?;
                if pack.evidence_rules.is_empty()
                    || required_outputs.is_empty()
                    || !names(required_outputs)
                    || required_outputs
                        .iter()
                        .any(|id| !pack.evidence_rules.contains_key(id))
                    || targets.is_empty()
                    || targets.len() > 32
                {
                    bail!("delivery requires declared workflow evidence and bounded targets");
                }
                for stage in &pack.stages {
                    if stage
                        .execution
                        .as_ref()
                        .is_some_and(|scope| !repositories.contains_key(&scope.repository_binding))
                    {
                        bail!("unknown stage execution repository binding");
                    }
                }
                for rule in pack.evidence_rules.values() {
                    match rule {
                        EvidenceRule::Artifact { repository_binding } => {
                            if !repositories.contains_key(repository_binding) {
                                bail!("unknown workflow repository binding");
                            }
                        }
                        EvidenceRule::Verification {
                            artifact_output,
                            command_binding,
                            environment_binding,
                            required_scenarios,
                        } => {
                            let command = commands.get(command_binding).ok_or_else(|| {
                                anyhow::anyhow!("unknown workflow command binding")
                            })?;
                            if !environments.contains_key(environment_binding)
                                || command.environment_binding != *environment_binding
                            {
                                bail!("workflow verification environment mismatch");
                            }
                            if required_scenarios
                                .iter()
                                .any(|s| !command.scenario_ids.contains(s))
                            {
                                bail!("workflow verification scenario missing from command");
                            }
                            match pack.evidence_rules.get(artifact_output) {
                                Some(EvidenceRule::Artifact { repository_binding })
                                    if *repository_binding == command.repository_binding => {}
                                _ => bail!("workflow verification command repository mismatch"),
                            }
                        }
                        EvidenceRule::Review { .. } | EvidenceRule::Report { .. } => {}
                    }
                }
                for target in targets {
                    match target {
                        Target::Local { repository_binding } => {
                            if !repositories.contains_key(repository_binding) {
                                bail!("unknown delivery repository");
                            }
                        }
                        Target::ChangeRequest {
                            repository_binding,
                            connection_binding,
                            target_branch,
                        }
                        | Target::Merged {
                            repository_binding,
                            connection_binding,
                            target_branch,
                        } => {
                            if !repositories.contains_key(repository_binding)
                                || !connections.contains_key(connection_binding)
                                || !text(target_branch)
                            {
                                bail!("invalid change delivery target");
                            }
                        }
                        Target::Deployed {
                            repository_binding,
                            connection_binding,
                            environment_binding,
                        } => {
                            if !repositories.contains_key(repository_binding)
                                || !connections.contains_key(connection_binding)
                                || !environments.contains_key(environment_binding)
                            {
                                bail!("invalid deployment target");
                            }
                        }
                        Target::Custom {
                            capability,
                            connection_binding,
                            target_ref,
                        } => {
                            if !valid_id(capability)
                                || !text(target_ref)
                                || !connections
                                    .get(connection_binding)
                                    .is_some_and(|c| c.capabilities.contains(capability))
                            {
                                bail!("invalid custom delivery target");
                            }
                        }
                    }
                }
                required_outputs.sort();
            }
        }
        let canonical = canonical(&input)?;
        let hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT canonical,body FROM project_configs WHERE id=?1 AND version=?2",
                params![input.id, input.version],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior, body)) = previous {
            if prior != canonical {
                bail!("project configuration version is immutable");
            }
            return Ok(serde_json::from_str(&body)?);
        }
        let row = json!({"schema_version":1,"id":input.id,"version":input.version,"hash":hash,"hash_format":"kode.project.config.v1","config":input,
            "home_hub":self.node_id,"created_at":now(),"actor":{"kind":"human","id":"local_owner"},"eligible_for_execution":false,
            "pending_checks":["workspace_registration","trusted_command_definitions","adapter_and_connection_capabilities","grants","team_activation"]});
        let body = serde_json::to_string(&row)?;
        tx.execute(
            "INSERT INTO project_configs(id,version,canonical,body) VALUES (?1,?2,?3,?4)",
            params![input.id, input.version, canonical, body],
        )?;
        tx.execute(
            "INSERT INTO project_config_events(config_id,body) VALUES (?1,?2)",
            params![input.id, body],
        )?;
        tx.commit()?;
        Ok(row)
    }
    pub fn project_config_events(&self, id: &str, after: u64) -> Result<Value> {
        if !valid_id(id) || after > i64::MAX as u64 {
            bail!("invalid configuration cursor");
        }
        let db = self.db.lock();
        let mut q=db.prepare("SELECT seq,body FROM project_config_events WHERE config_id=?1 AND seq>?2 ORDER BY seq LIMIT 200")?;
        let rows = q.query_map(params![id, after], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut events = Vec::new();
        let mut cursor = after;
        for row in rows {
            let (seq, body) = row?;
            cursor = seq;
            events.push(json!({"seq":seq,"data":serde_json::from_str::<Value>(&body)?}));
        }
        Ok(json!({"events":events,"next_cursor":cursor}))
    }
}

#[cfg(test)]
mod acceptance_compatibility_tests {
    use super::*;
    #[test]
    fn optional_acceptance_preserves_legacy_policy_serialization() {
        let legacy = json!({"kind":"delivery_policy","project":{"id":"project","version":"1","hash":"a".repeat(64)},
            "workflow":{"id":"flow","version":"1","hash":"b".repeat(64)},"targets":[{"kind":"local","repository_binding":"code"}],"required_outputs":["artifact"]});
        let roundtrip = |value: Value| {
            serde_json::to_value(serde_json::from_value::<Spec>(value).unwrap()).unwrap()
        };
        assert_eq!(roundtrip(legacy.clone()), legacy);
        let mut explicit = legacy.clone();
        explicit["human_acceptance"] = json!(false);
        assert_eq!(roundtrip(explicit.clone()), legacy);
        explicit["human_acceptance"] = json!(true);
        assert_eq!(roundtrip(explicit.clone()), explicit);
        explicit["human_acceptance"] = json!("true");
        assert!(serde_json::from_value::<Spec>(explicit).is_err());
    }
}
