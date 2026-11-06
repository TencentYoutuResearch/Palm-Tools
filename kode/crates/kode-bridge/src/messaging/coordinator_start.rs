//! Atomic Coordinator funding, pricing and control binding. Runtime creation remains Host-owned.
use super::{
    coordinator_control,
    model::{now, valid_id},
    operation_bundle, pricing,
    store::Store,
    team_grants::Capability,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub expected_control_revision: u64,
    pub team_revision: u64,
    pub activation_revision: u64,
    pub target_id: String,
    pub price_id: String,
    pub operation: operation_bundle::Request,
}
impl Store {
    pub fn prepare_coordinator_start(&self, team: &str, input: Request) -> Result<Value> {
        if ![team, &input.request_id, &input.target_id, &input.price_id]
            .iter()
            .all(|s| valid_id(s))
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid Coordinator start")
        }
        let request = serde_json::to_value(&input)?;
        let key = format!("coordinator-start:{}", json!([team, input.request_id]));
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let old: Value = serde_json::from_str(&old)?;
            if old["request"] != request {
                bail!("Coordinator start identity conflict")
            };
            return Ok(old["result"].clone());
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE owner=?1 AND request_key=?2)",
            params![input.operation.owner_session, input.operation.request_key],
            |r| r.get(0),
        )?;
        if exists {
            bail!("Coordinator start cannot adopt existing operation")
        }
        if input.operation.worker.node_id != self.node_id {
            bail!("Coordinator must start on its home Hub")
        }
        if ![Capability::Read, Capability::Delegate]
            .iter()
            .all(|c| input.operation.grant_scope.capabilities.contains(c))
            || ![
                "kode_coordinator_configuration",
                "kode_coordinator_workflow_start",
                "kode_coordinator_workflow_status",
                "kode_coordinator_publish_reply",
            ]
            .iter()
            .all(|name| input.operation.grant_scope.tools.iter().any(|t| t == name))
        {
            bail!("complete Coordinator tool and capability grant required")
        }
        let bundle = operation_bundle::prepare_in(&tx, input.operation, now())?;
        let priced = pricing::bind_price_in(
            &tx,
            bundle["reservation"]["request"]["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("reservation missing"))?,
            &input.price_id,
        )?;
        let op = &bundle["operation"];
        let control = coordinator_control::bind_in(
            &tx,
            &self.node_id,
            team,
            coordinator_control::Bind {
                request_id: input.request_id,
                expected_revision: input.expected_control_revision,
                team_revision: input.team_revision,
                activation_revision: input.activation_revision,
                operation_id: op["id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("operation missing"))?
                    .into(),
                operation_revision: op["revision"].as_u64().unwrap(),
                attempt: op["attempt"].as_u64().unwrap(),
                epoch: op["epoch"].as_u64().unwrap(),
                target_id: input.target_id,
            },
        )?;
        let result = json!({"bundle":bundle,"pricing":priced,"control":control,"dispatch_state":"not_dispatched"});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key,
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
