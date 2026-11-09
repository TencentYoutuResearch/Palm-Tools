//! Explicit cwd selection does not discard any other frozen ancestor evidence.
use super::workflows::{EvidenceRule, Pack, Stage};
use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::BTreeSet;

pub(super) fn validate(pack: &Pack, stage: &Stage, ancestors: &BTreeSet<String>) -> Result<()> {
    let Some(scope) = &stage.execution else { return Ok(()); };
    let Some(input) = &scope.input_artifact else { return Ok(()); };
    if !super::model::valid_id(&input.stage) || !super::model::valid_id(&input.output)
        || !ancestors.contains(&input.stage) {
        bail!("input artifact must select an ancestor stage output")
    }
    let producer = pack.stages.iter().find(|s| s.id == input.stage)
        .ok_or_else(|| anyhow::anyhow!("input artifact producer unavailable"))?;
    if !producer.produces.contains(&input.output)
        || !matches!(pack.evidence_rules.get(&input.output), Some(EvidenceRule::Artifact { repository_binding }) if repository_binding == &scope.repository_binding) {
        bail!("input artifact must select a same-repository artifact")
    }
    // A review/verification proof must judge precisely the materialized cwd.
    for output in &stage.produces {
        if let Some(EvidenceRule::Review { artifact_output } | EvidenceRule::Verification { artifact_output, .. }) = pack.evidence_rules.get(output) {
            if artifact_output != &input.output { bail!("input artifact differs from judged artifact") }
        }
    }
    Ok(())
}

pub(super) fn selected<'a>(stage: &Stage, sources: &'a Value) -> Result<Option<&'a Value>> {
    let Some(scope) = &stage.execution else { return Ok(None); };
    let Some(input) = &scope.input_artifact else { return Ok(None); };
    let output = &sources[&input.stage]["outputs"][&input.output];
    if !output["sequence"].as_u64().is_some_and(|n| n > 0 && n <= i64::MAX as u64)
        || output["artifact"]["repository_binding"] != scope.repository_binding
        || !output["artifact"]["snapshot_hash"].as_str().is_some_and(super::artifact_archive_format::valid_hash)
        || !output["artifact"]["archive_hash"].as_str().is_some_and(super::artifact_archive_format::valid_hash)
        || !output["artifact"]["bytes"].as_u64().is_some_and(|n| n > 0) {
        bail!("frozen mapped artifact unavailable")
    }
    // Complete archive metadata comes only from assignment_inputs::freeze, which
    // validates the producer/current attempt and reads Home's completed archive.
    Ok(Some(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn pack() -> Pack {
        serde_json::from_value(json!({"id":"mapped","version":"1","inputs":["request"],"completion_stages":["review"],
            "stages":[
                {"id":"baseline","role":"author","requires":["request"],"produces":["base"],"independent_from":[]},
                {"id":"implement","role":"author","requires":["baseline"],"produces":["fixed"],"independent_from":[],"execution":{
                    "repository_binding":"code","capabilities":["read","workspace_write"],"tools":[],"network":false,
                    "input_artifact":{"stage":"baseline","output":"base"}}},
                {"id":"review","role":"reviewer","requires":["implement"],"produces":["reviewed"],"independent_from":["implement"],"execution":{
                    "repository_binding":"code","capabilities":["read"],"tools":[],"network":false,
                    "input_artifact":{"stage":"implement","output":"fixed"}}}
            ],"evidence_rules":{"base":{"kind":"artifact","repository_binding":"code"},"fixed":{"kind":"artifact","repository_binding":"code"},"reviewed":{"kind":"review","artifact_output":"fixed"}}})).unwrap()
    }
    #[test]
    fn explicit_mapping_is_ancestor_same_repository_and_matches_judgment() {
        let original = pack(); super::super::workflows::validate(&original).unwrap();
        assert_eq!(original.hash_format(), "kode.workflow.input-artifact.v8");
        for input in [json!({"stage":"review","output":"reviewed"}), json!({"stage":"baseline","output":"fixed"}), json!({"stage":"baseline","output":"base"})] {
            let mut changed = serde_json::to_value(&original).unwrap(); changed["stages"][2]["execution"]["input_artifact"] = input;
            let changed: Pack = serde_json::from_value(changed).unwrap(); assert!(super::super::workflows::validate(&changed).is_err());
        }
        let mut changed = serde_json::to_value(&original).unwrap(); changed["evidence_rules"]["fixed"]["repository_binding"] = json!("foreign");
        assert!(super::super::workflows::validate(&serde_json::from_value(changed).unwrap()).is_err());
        let mut legacy = serde_json::to_value(&original).unwrap();
        for stage in legacy["stages"].as_array_mut().unwrap() { if let Some(scope) = stage.get_mut("execution").and_then(Value::as_object_mut) { scope.remove("input_artifact"); } }
        let legacy: Pack = serde_json::from_value(legacy).unwrap(); assert_eq!(legacy.hash_format(), "kode.workflow.execution.v3");
    }
    #[test]
    fn runtime_mapping_never_borrows_a_foreign_or_missing_snapshot() {
        let pack = pack(); let stage = &pack.stages[2];
        let sources = json!({"baseline":{"outputs":{"base":{"sequence":1,"artifact":{"repository_binding":"code","snapshot_hash":"a".repeat(64),"archive_hash":"b".repeat(64),"bytes":1}}}},
            "implement":{"outputs":{"fixed":{"sequence":2,"artifact":{"repository_binding":"code","snapshot_hash":"c".repeat(64),"archive_hash":"d".repeat(64),"bytes":2}}}}});
        assert_eq!(selected(stage,&sources).unwrap().unwrap()["sequence"],2);
        for key in ["sequence","artifact"] { let mut changed=sources.clone();changed["implement"]["outputs"]["fixed"].as_object_mut().unwrap().remove(key);assert!(selected(stage,&changed).is_err()); }
        let mut changed=sources.clone();changed["implement"]["outputs"]["fixed"]["artifact"]["repository_binding"]=json!("foreign");assert!(selected(stage,&changed).is_err());
    }
}
