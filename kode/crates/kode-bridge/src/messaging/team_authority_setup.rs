//! Atomic owner confirmation of a team's policy and grant bundle; no implicit activation.
use super::{
    model::{now, valid_id},
    store::Store,
    team_grants, team_policies,
    teams::Spec,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configure {
    pub request_id: String,
    pub team_revision: u64,
    pub budget_policy: team_policies::Write,
    pub scheduling_policy: team_policies::Write,
    pub grant: team_grants::Write,
}
fn key(team: &str, request: &str) -> String {
    format!(
        "team-authority-setup:{}",
        serde_json::to_string(&(team, request)).unwrap()
    )
}
fn receipt(db: &rusqlite::Connection, team: &str, request: &str) -> Result<Option<Value>> {
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
    pub fn team_authority_receipt(&self, team: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(team) || !valid_id(request) {
            bail!("invalid authority receipt identity")
        }
        receipt(&self.db.lock(), team, request)
    }
    pub fn configure_team_authority(&self, team: &str, input: Configure) -> Result<Value> {
        if !valid_id(team)
            || !valid_id(&input.request_id)
            || input.team_revision == 0
            || serde_json::to_vec(&input)?.len() > 131072
            || input.budget_policy.team_id != team
            || input.scheduling_policy.team_id != team
            || input.grant.policy.team_id != team
        {
            bail!("invalid team authority configuration")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(saved) = receipt(&tx, team, &input.request_id)? {
            if saved["request"] != request {
                bail!("team authority request identity conflict")
            }
            return Ok(saved["result"].clone());
        }
        let body:Option<String>=tx.query_row("SELECT r.body FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision WHERE t.id=?1",[team],|r|r.get(0)).optional()?;
        let row: Value =
            serde_json::from_str(&body.ok_or_else(|| anyhow::anyhow!("team missing"))?)?;
        if row["revision"].as_u64() != Some(input.team_revision) {
            bail!("team changed before authority confirmation")
        }
        let spec: Spec = serde_json::from_value(row["spec"].clone())?;
        if spec.budget_policy_id.as_deref() != Some(&input.budget_policy.id)
            || spec.scheduling_policy_id.as_deref() != Some(&input.scheduling_policy.id)
            || spec.grant_id.as_deref() != Some(&input.grant.policy.id)
        {
            bail!("authority references differ from team draft")
        }
        let team_policies::Policy::Budget { budget_ids, .. } = &input.budget_policy.policy else {
            bail!("budget policy required")
        };
        let team_policies::Policy::Scheduling { targets, .. } = &input.scheduling_policy.policy
        else {
            bail!("scheduling policy required")
        };
        if targets.len() != spec.execution_targets.len()
            || spec.execution_targets.iter().any(|t| {
                targets.get(&t.id).is_none_or(|c| {
                    c.resource.host != t.host_id
                        || c.resource.profile != t.executor_profile_id
                        || c.resource.account_id != t.account_binding_id
                        || c.capability_revision.to_string() != t.capability_profile_revision
                })
            })
        {
            bail!("scheduling targets differ from team draft")
        }
        if input.grant.policy.targets.iter().any(|t| {
            !spec.workspace_refs.iter().any(|w| {
                w.host_id == t.host && w.workspace_id == t.workspace && w.root_ref == t.root
            })
        }) {
            bail!("grant workspace outside team draft")
        }
        if budget_ids
            .iter()
            .any(|id| !input.grant.policy.budget_ids.contains(id))
        {
            bail!("team policy budget outside confirmed grant")
        }
        // A new confirmation must match current pointers, not merely an old immutable
        // policy revision. Only the exact bundle receipt above can replay historical consent.
        for policy in [&input.budget_policy, &input.scheduling_policy] {
            let current = team_policies::read(&tx, &policy.id, None)?;
            if current
                .as_ref()
                .and_then(|v| v["revision"].as_u64())
                .unwrap_or(0)
                != policy.expected_revision
            {
                bail!("team authority policy revision conflict")
            }
        }
        if team_grants::read(&tx, &input.grant.policy.id, None)?
            .map(|g| g.revision)
            .unwrap_or(0)
            != input.grant.expected_revision
        {
            bail!("team authority grant revision conflict")
        }
        let at = now();
        let budget = team_policies::write_in(&tx, input.budget_policy, &self.node_id)?;
        let scheduling = team_policies::write_in(&tx, input.scheduling_policy, &self.node_id)?;
        let grant = team_grants::write_in(&tx, input.grant, at)?;
        let result = json!({"team_id":team,"team_revision":input.team_revision,"request_id":input.request_id,"budget_policy":budget,"scheduling_policy":scheduling,"grant":grant["grant"],"activation_performed":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key(team, &input.request_id),
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![team,serde_json::to_string(&json!({"kind":"team_authority_configured","team_id":team,"revision":input.team_revision,"request_id":input.request_id,"actor":{"kind":"human","id":"local_owner"},"home_hub":self.node_id,"at":at}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
