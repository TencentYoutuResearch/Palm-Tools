//! Read-only candidate diagnostics. Never materialize a team merely to validate a draft.
use super::{
    builder_drafts::Interview,
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub expected_revision: u64,
    pub team_id: String,
}
impl Store {
    pub fn builder_preflight(&self, id: &str, input: Check) -> Result<Option<Value>> {
        if !valid_id(&input.team_id) || input.expected_revision == 0 {
            bail!("invalid Builder preflight identity")
        }
        let Some(draft) = self.builder_draft(id)? else {
            return Ok(None);
        };
        if draft["revision"].as_u64() != Some(input.expected_revision) {
            bail!("Builder draft revision conflict")
        }
        if draft["status"] != "draft" {
            bail!("Builder draft revoked")
        }
        let interview: Interview = serde_json::from_value(draft["interview"].clone())?;
        let mut issues = Vec::new();
        let unanswered: Vec<&str> = interview
            .questionnaire
            .as_ref()
            .map(|plan| {
                plan.questions
                    .iter()
                    .filter(|q| {
                        q.when_answer.as_ref().is_none_or(|c| {
                            interview.answers.get(&c.question_id) == Some(&c.equals)
                        }) && !interview.answers.contains_key(&q.id)
                    })
                    .map(|q| q.id.as_str())
                    .collect()
            })
            .unwrap_or_default();
        if !interview.questions.is_empty() || !unanswered.is_empty() {
            issues.push(json!({"code":"interview_questions_pending"}));
        }
        for workspace in &interview.workspace_refs {
            if !interview.inspections.iter().any(|i| {
                i.workspace.host_id == workspace.host_id
                    && i.workspace.workspace_id == workspace.workspace_id
                    && i.workspace.root_ref == workspace.root_ref
                    && i.facts
                        .iter()
                        .any(|f| f.status == super::builder_facts::Status::Observed)
            }) {
                issues.push(json!({"code":"project_observations_missing","workspace":workspace}));
            }
        }
        let mut configuration = Value::Null;
        let mut resources = Value::Null;
        match interview.proposed_team {
            None => issues.push(json!({"code":"proposed_team_required"})),
            Some(spec) => {
                if spec.validate().is_err() {
                    issues.push(json!({"code":"proposed_team_invalid"}));
                } else {
                    for workspace in &spec.workspace_refs {
                        if !interview.workspace_refs.iter().any(|w| {
                            w.host_id == workspace.host_id
                                && w.workspace_id == workspace.workspace_id
                                && w.root_ref == workspace.root_ref
                        }) {
                            issues.push(json!({"code":"proposed_workspace_not_selected","workspace":workspace}));
                        }
                    }
                    configuration =
                        self.team_spec_preflight(&input.team_id, None, Value::Null, &spec)?;
                    resources = self.builder_resource_preflight(&input.team_id, &spec)?;
                }
            }
        }
        // Diagnostics read live policy/resource documents and are not an admission snapshot.
        // A concurrent draft edit invalidates this result rather than attaching it to latest.
        if self
            .builder_draft(id)?
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            != Some(input.expected_revision)
        {
            bail!("Builder draft revision conflict")
        }
        Ok(Some(
            json!({"schema_version":1,"draft_id":id,"draft_revision":input.expected_revision,
            "candidate_team_id":input.team_id,"home_hub":self.node_id,"checked_at":now(),"issues":issues,
            "configuration":configuration,"resources":resources,"eligible_for_execution":false,
            "pending_checks":["interview_semantic_review","observations_freshness","trusted_resource_coverage","normal_and_failure_examples","human_activation"]}),
        ))
    }
}
