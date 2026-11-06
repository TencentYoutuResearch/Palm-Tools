//! Owner-reviewed capability revision and matching team/scheduling draft, committed atomically.
use super::{
    capability_profiles::{self, Assessment, Command, Source},
    model::{now, valid_id},
    store::Store,
    team_policies, teams,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub request_id: String,
    pub team_revision: u64,
    pub target_id: String,
    pub scheduling_revision: u64,
    pub capability_revision: u64,
    pub assessments: BTreeMap<String, Assessment>,
    pub replace_pins: bool,
}
fn key(team: &str, request: &str) -> String {
    format!("team-capability-update:{}", json!([team, request]))
}
fn read(db: &rusqlite::Connection, team: &str, request: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(team, request)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
impl Store {
    pub fn team_capability_update_receipt(&self, team: &str, request: &str) -> Result<Value> {
        if !valid_id(team) || !valid_id(request) {
            bail!("invalid capability update receipt identity")
        }
        Ok(json!({"result":read(&self.db.lock(),team,request)?.map(|row| row["result"].clone())}))
    }
    pub fn update_team_capability(&self, id: &str, input: Update) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.target_id)
            || [
                input.team_revision,
                input.scheduling_revision,
                input.capability_revision,
            ]
            .iter()
            .any(|v| *v == 0 || *v >= i64::MAX as u64)
        {
            bail!("invalid capability update identity")
        }
        let request = serde_json::to_value(&input)?;
        if serde_json::to_vec(&request)?.len() > 65536 {
            bail!("capability update too large")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(saved) = read(&tx, id, &input.request_id)? {
            if saved["request"] != request {
                bail!("capability update request identity conflict")
            }
            return Ok(saved["result"].clone());
        }
        let body:String=tx.query_row("SELECT r.body FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision WHERE t.id=?1",[id],|r|r.get(0))?;
        let current: Value = serde_json::from_str(&body)?;
        if current["revision"].as_u64() != Some(input.team_revision) {
            bail!("team revision conflict")
        }
        let mut spec: teams::Spec = serde_json::from_value(current["spec"].clone())?;
        let policy_id = spec
            .scheduling_policy_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("team scheduling policy required"))?;
        let saved = team_policies::read(&tx, &policy_id, None)?
            .ok_or_else(|| anyhow::anyhow!("scheduling policy missing"))?;
        if saved["team_id"] != id || saved["revision"].as_u64() != Some(input.scheduling_revision) {
            bail!("scheduling policy revision conflict")
        }
        let mut policy: team_policies::Policy = serde_json::from_value(saved["policy"].clone())?;
        let team_policies::Policy::Scheduling { targets, .. } = &mut policy else {
            bail!("scheduling policy required")
        };
        let target = spec
            .execution_targets
            .iter_mut()
            .find(|t| t.id == input.target_id)
            .ok_or_else(|| anyhow::anyhow!("unknown team target"))?;
        let candidate = targets
            .get_mut(&input.target_id)
            .ok_or_else(|| anyhow::anyhow!("scheduling target missing"))?;
        if candidate.capability_revision != input.capability_revision
            || target.capability_profile_revision != input.capability_revision.to_string()
            || candidate.resource.host != target.host_id
            || candidate.resource.profile != target.executor_profile_id
            || candidate.resource.account_id != target.account_binding_id
        {
            bail!("team capability reference changed")
        }
        let body: String = tx.query_row(
            "SELECT body FROM capability_profiles WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [&candidate.capability_id],
            |r| r.get(0),
        )?;
        let previous: Value = serde_json::from_str(&body)?;
        if previous["revision"].as_u64() != Some(input.capability_revision)
            || previous["host"] != target.host_id
            || previous["profile"] != target.executor_profile_id
            || previous["model"] != target.model_id
        {
            bail!("capability resource or revision changed")
        }
        let prior: BTreeMap<String, Assessment> =
            serde_json::from_value(previous["assessments"].clone())?;
        for (name, assessment) in &input.assessments {
            if prior.get(name) != Some(assessment) && assessment.source != Source::User {
                bail!("owner edits must use user assessment provenance")
            }
        }
        let capability = capability_profiles::save_in(
            &tx,
            Command {
                id: candidate.capability_id.clone(),
                expected_revision: input.capability_revision,
                host: target.host_id.clone(),
                profile: target.executor_profile_id.clone(),
                model: target.model_id.clone(),
                assessments: input.assessments,
                replace_pins: input.replace_pins,
            },
        )?;
        candidate.capability_revision = input.capability_revision + 1;
        target.capability_profile_revision = candidate.capability_revision.to_string();
        let team = self.save_team_in(
            &tx,
            teams::Save {
                id: id.to_owned(),
                request_id: input.request_id.clone(),
                expected_revision: input.team_revision,
                spec,
            },
        )?;
        let scheduling = team_policies::write_in(
            &tx,
            team_policies::Write {
                id: policy_id,
                team_id: id.to_owned(),
                expected_revision: input.scheduling_revision,
                policy,
            },
            &self.node_id,
        )?;
        let result = json!({"home_hub":self.node_id,"team_id":id,"request_id":input.request_id,"target_id":input.target_id,
            "team":team,"capability_profile":capability,"scheduling_policy":scheduling,"activation_performed":false,"eligible_for_execution":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key(id, &input.request_id),
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![id,serde_json::to_string(&json!({"kind":"team_capability_updated","request_id":input.request_id,"target_id":input.target_id,"team_revision":team["revision"],"capability_revision":capability["revision"],"scheduling_revision":scheduling["revision"],"replace_pins":input.replace_pins,"actor":{"kind":"human","id":"local_owner"},"at":now()}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
