//! Owner-declared account grouping for the selected Builder profile. Never a provider balance.
use super::{
    model::{now, valid_id},
    resources,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub request_id: String,
    pub draft_revision: u64,
    pub selection_revision: u64,
    pub account_id: String,
    pub account_epoch: u64,
    pub create_account: bool,
    pub expected_binding_revision: u64,
}
fn key(id: &str, request: &str) -> String {
    format!("builder-account:{}", json!([id, request]))
}
fn read(db: &rusqlite::Connection, id: &str, request: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id, request)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
impl Store {
    pub fn builder_account_receipt(&self, id: &str, request: &str) -> Result<Value> {
        if !valid_id(id) || !valid_id(request) {
            bail!("invalid Builder account receipt")
        }
        Ok(
            json!({"home_hub":self.node_id,"draft_id":id,"receipt":read(&self.db.lock(),id,request)?}),
        )
    }
    pub fn confirm_builder_account(&self, id: &str, input: Confirm) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.account_id)
            || input.draft_revision == 0
            || input.selection_revision == 0
            || input.account_epoch == 0
            || (input.create_account && input.account_epoch != 1)
        {
            bail!("invalid Builder account confirmation")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(previous) = read(&tx, id, &input.request_id)? {
            if previous["request"] != request {
                bail!("Builder account request identity conflict")
            }
            return Ok(previous);
        }
        let body: String = tx.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&body)?;
        if draft["status"] != "draft" || draft["revision"].as_u64() != Some(input.draft_revision) {
            bail!("Builder draft revision conflict")
        }
        let body: String = tx.query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [format!("builder-selection:{id}")],
            |r| r.get(0),
        )?;
        let selection: Value = serde_json::from_str(&body)?;
        if selection["revision"].as_u64() != Some(input.selection_revision)
            || selection["draft_revision"].as_u64() != Some(input.draft_revision)
        {
            bail!("Builder selection revision conflict")
        }
        let selected = &selection["selection"];
        if selected["workspace"]["host_id"] != self.node_id
            || !draft["interview"]["workspace_refs"]
                .as_array()
                .is_some_and(|refs| refs.contains(&selected["workspace"]))
        {
            bail!("Builder workspace is not selected on home Hub")
        }
        if input.create_account {
            resources::account_in(
                &tx,
                resources::AccountCommand {
                    id: input.account_id.clone(),
                    expected_epoch: 0,
                    enabled: true,
                },
            )?;
        }
        let binding = resources::binding_in(
            &tx,
            resources::BindingCommand {
                host: self.node_id.clone(),
                profile: selected["profile_id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Builder profile missing"))?
                    .into(),
                account_id: input.account_id.clone(),
                account_epoch: input.account_epoch,
                expected_revision: input.expected_binding_revision,
            },
        )?;
        let result = json!({"home_hub":self.node_id,"draft_id":id,"request":request,"selection":selected,"binding":binding,"account_created":input.create_account,"quota_status":"not_checked","execution_started":false,"activation_performed":false,"recorded_at":now()});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(id, &input.request_id), serde_json::to_string(&result)?],
        )?;
        tx.execute("INSERT INTO resource_events(body) VALUES (?1)", [serde_json::to_string(&json!({"kind":"builder_account_confirmed","draft_id":id,"request_id":input.request_id,"actor":{"kind":"human","id":"local_owner"},"home_hub":self.node_id,"at":now()}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
