//! Owner-declared resource grouping and model fit. No credentials, provider facts or dispatch.
use super::{
    capability_profiles,
    model::{now, valid_id},
    pricing, resources,
    store::Store,
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
    pub target_id: String,
    /// Create an enabled account at epoch 1 only; never rotate an existing shared account implicitly.
    pub create_account: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reuse_binding: bool,
    pub binding: resources::BindingCommand,
    pub capability_profile: capability_profiles::Command,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_price: Option<pricing::Price>,
}
fn is_false(value: &bool) -> bool {
    !*value
}
fn key(team: &str, request: &str) -> String {
    format!(
        "team-resource-setup:{}",
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
    pub fn team_resource_receipt(&self, team: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(team) || !valid_id(request) {
            bail!("invalid resource receipt identity")
        }
        receipt(&self.db.lock(), team, request)
    }
    pub fn configure_team_resource(&self, team: &str, input: Configure) -> Result<Value> {
        if !valid_id(team)
            || !valid_id(&input.request_id)
            || !valid_id(&input.target_id)
            || input.team_revision == 0
            || serde_json::to_vec(&input)?.len() > 131072
        {
            bail!("invalid team resource configuration")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(saved) = receipt(&tx, team, &input.request_id)? {
            if saved["request"] != request {
                bail!("team resource request identity conflict")
            }
            return Ok(saved["result"].clone());
        }
        let body:Option<String>=tx.query_row("SELECT r.body FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision WHERE t.id=?1",[team],|r|r.get(0)).optional()?;
        let team_row: Value =
            serde_json::from_str(&body.ok_or_else(|| anyhow::anyhow!("team missing"))?)?;
        if team_row["revision"].as_u64() != Some(input.team_revision) {
            bail!("team changed before resource confirmation")
        }
        let spec: Spec = serde_json::from_value(team_row["spec"].clone())?;
        let target = spec
            .execution_targets
            .iter()
            .find(|t| t.id == input.target_id)
            .ok_or_else(|| anyhow::anyhow!("unknown team resource target"))?;
        let binding = &input.binding;
        let assessment = &input.capability_profile;
        if binding.host != target.host_id
            || binding.profile != target.executor_profile_id
            || binding.account_id != target.account_binding_id
            || assessment.host != target.host_id
            || assessment.profile != target.executor_profile_id
            || assessment.model != target.model_id
            || assessment
                .expected_revision
                .checked_add(1)
                .map(|n| n.to_string())
                .as_deref()
                != Some(target.capability_profile_revision.as_str())
        {
            bail!("resource configuration differs from team target")
        }
        if input.internal_price.as_ref().is_some_and(|price| {
            price.model != target.model_id
                || price.model_policy != pricing::ModelPolicy::RequestedModel
        }) {
            bail!("internal price must use the configured requested model")
        }
        if input.create_account && input.reuse_binding {
            bail!("cannot create and reuse account binding")
        }
        if input.create_account {
            if binding.account_epoch != 1 {
                bail!("new account must start at epoch one")
            }
            resources::account_in(
                &tx,
                resources::AccountCommand {
                    id: binding.account_id.clone(),
                    expected_epoch: 0,
                    enabled: true,
                },
            )?;
        }
        let binding = if input.reuse_binding {
            let b = &input.binding;
            let current:Option<(String,u64,u64,u64,bool)>=tx.query_row("SELECT b.account_id,b.account_epoch,b.revision,a.epoch,(b.enabled AND a.enabled) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile=?2",params![b.host,b.profile],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            if current
                != Some((
                    b.account_id.clone(),
                    b.account_epoch,
                    b.expected_revision,
                    b.account_epoch,
                    true,
                ))
            {
                bail!("reused account binding changed")
            }
            json!({"host":b.host,"profile":b.profile,"account_id":b.account_id,"account_epoch":b.account_epoch,"revision":b.expected_revision})
        } else {
            resources::binding_in(&tx, input.binding)?
        };
        let assessment = capability_profiles::save_in(&tx, input.capability_profile)?;
        let price = input
            .internal_price
            .map(|price| pricing::create_in(&tx, price))
            .transpose()?;
        let mut result = json!({"team_id":team,"team_revision":input.team_revision,"request_id":input.request_id,"target_id":input.target_id,
            "binding":binding,"capability_profile":assessment,"account_created":input.create_account,
            "quota_status":"not_checked","eligible_for_execution":false,"activation_performed":false});
        if input.reuse_binding {
            result["binding_reused"] = json!(true);
        }
        if let Some(price) = price {
            result["internal_price"] = json!({"label":"内部计价","basis":"internal_price","provider_invoice":false,"price":price});
        }
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key(team, &input.request_id),
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![team,serde_json::to_string(&json!({"kind":"team_resource_configured","team_id":team,"revision":input.team_revision,"request_id":input.request_id,"target_id":input.target_id,"actor":{"kind":"human","id":"local_owner"},"home_hub":self.node_id,"at":now()}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
