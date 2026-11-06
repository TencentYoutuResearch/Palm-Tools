//! Frozen workflow escalation changes ranking requirements, never candidate authority.
use super::{model::valid_id, workflows::ExecutionScope};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Escalation {
    pub after_reworks: u16,
    pub task_tag: String,
    pub minimum_quality: u8,
}

pub(super) fn validate(scope: &ExecutionScope) -> Result<()> {
    if scope.escalation.len() > 16
        || (!scope.escalation.is_empty() && scope.task_tag.is_none())
        || scope.escalation.iter().any(|rule| {
            !(1..=100).contains(&rule.after_reworks)
                || !valid_id(&rule.task_tag)
                || rule.minimum_quality > 100
        })
        || scope.escalation.windows(2).any(|pair| {
            pair[0].after_reworks >= pair[1].after_reworks
                || pair[0].minimum_quality > pair[1].minimum_quality
        })
    {
        bail!("escalation requires ordered bounded rework thresholds and nondecreasing quality")
    }
    Ok(())
}

/// Only completed Hub-recorded rework decisions count, not Agent claims or dispatch attempts.
pub(super) fn selected<'a>(scope: &'a ExecutionScope, run: &Value, stage: &str) -> (usize, Option<&'a Escalation>) {
    let count = run["reworks"].as_array().map_or(0, |rows| rows.iter().filter(|row| {
        row["scheduled"] == true && row["affected"].as_array().is_some_and(|ids| ids.iter().any(|id| id == stage))
    }).count());
    (count, scope.escalation.iter().rev().find(|rule| count >= usize::from(rule.after_reworks)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn scope() -> ExecutionScope {
        serde_json::from_value(json!({"task_tag":"normal","repository_binding":"code","capabilities":["read"],"tools":[],"network":false,
            "escalation":[{"after_reworks":1,"task_tag":"specialist","minimum_quality":70},{"after_reworks":3,"task_tag":"expert","minimum_quality":90}]})).unwrap()
    }
    #[test]
    fn only_authoritative_affected_reworks_select_frozen_thresholds() {
        let scope=scope(); validate(&scope).unwrap();
        let mut run=json!({"attempt":99,"reworks":[{"scheduled":false,"affected":["build"]},{"scheduled":true,"affected":["other"]}]});
        assert_eq!(selected(&scope,&run,"build").0,0); assert!(selected(&scope,&run,"build").1.is_none());
        for expected in ["specialist","specialist","expert"] {
            run["reworks"].as_array_mut().unwrap().push(json!({"scheduled":true,"affected":["build","review"]}));
            assert_eq!(selected(&scope,&run,"build").1.unwrap().task_tag,expected);
        }
        assert!(selected(&scope,&run,"unrelated").1.is_none());
    }
    #[test]
    fn invalid_escalation_cannot_reduce_quality_or_duplicate_thresholds() {
        let mut s=scope(); s.escalation[1].minimum_quality=60; assert!(validate(&s).is_err());
        let mut s=scope(); s.escalation[1].after_reworks=1; assert!(validate(&s).is_err());
        let mut s=scope(); s.escalation[0].after_reworks=0; assert!(validate(&s).is_err());
        let mut s=scope(); s.task_tag=None; assert!(validate(&s).is_err());
    }
}
