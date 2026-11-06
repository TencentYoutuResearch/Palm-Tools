//! Atomic managed-operation preparation. No session creation or model call occurs in this transaction.
use super::{
    budgets,
    model::{now, valid_id, Address},
    operation_budget, operation_grant, operations, resource_admission, selection_evidence,
    store::Store,
    team_grants,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Funding {
    pub budget_ids: Vec<String>,
    pub amount: u64,
    pub unit: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub owner_session: String,
    pub request_key: String,
    pub worker: Address,
    pub selection_policy: selection_evidence::Policy,
    pub funding: Funding,
    pub resource: resource_admission::Policy,
    pub grant_id: String,
    pub grant_scope: team_grants::Check,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Abandon {
    pub request_id: String,
    pub expected_revision: u64,
}

pub(super) fn abandon_in(tx: &Transaction, id: &str, input: Abandon, at: u64) -> Result<Value> {
    if !valid_id(id)
        || !valid_id(&input.request_id)
        || input.expected_revision == 0
        || input.expected_revision >= i64::MAX as u64
    {
        bail!("invalid bundle abandonment");
    }
    let command = serde_json::to_value(&input)?;
    let key = format!(
        "operation-bundle-abandon:{}",
        serde_json::to_string(&(id, &input.request_id))?
    );
    let receipt: Option<String> = tx
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(body) = receipt {
        let saved: Value = serde_json::from_str(&body)?;
        if saved["request"] != command {
            bail!("bundle abandonment identity conflict");
        }
        return Ok(saved["result"].clone());
    }
    let body: String = tx.query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    let mut op: operations::Operation = serde_json::from_str(&body)?;
    let bundle_key = format!(
        "operation-bundle:{}",
        serde_json::to_string(&(&op.owner, &op.request_key))?
    );
    let original: Option<String> = tx
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [bundle_key],
            |r| r.get(0),
        )
        .optional()?;
    let original: Value = serde_json::from_str(
        &original.ok_or_else(|| anyhow::anyhow!("operation was not prepared as a bundle"))?,
    )?;
    let initial = &original["result"]["operation"];
    if op.revision != input.expected_revision
        || initial["id"] != id
        || initial["revision"] != op.revision
        || initial["attempt"] != op.attempt
        || initial["epoch"] != op.epoch
        || op.state != operations::State::Prepared
        || op.lease_until.is_some()
    {
        bail!("only an unchanged never-claimed bundle can be abandoned");
    }
    let reservation_id: String = tx.query_row(
        "SELECT reservation_id FROM operation_budget_bindings WHERE operation_id=?1 AND attempt=?2",
        params![id, op.attempt],
        |r| r.get(0),
    )?;
    let body: String = tx.query_row(
        "SELECT body FROM budget_reservations WHERE id=?1",
        [&reservation_id],
        |r| r.get(0),
    )?;
    let reservation: budgets::Reservation = serde_json::from_str(&body)?;
    if original["result"]["reservation"]["request"]["id"] != reservation_id
        || reservation.request.operation_id != id
        || reservation.revision != 1
        || reservation.charged != 0
        || reservation.finalized
        || reservation.charge_basis.is_some()
    {
        bail!("bundle has accounting activity and requires reconciliation");
    }
    let settled = budgets::settle_in(
        tx,
        &reservation_id,
        budgets::Settle {
            event_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: 1,
            total_charge: 0,
            finalized: true,
            basis: "manual".into(),
        },
        at,
    )?;
    op.state = operations::State::Stopped;
    op.revision += 1;
    op.epoch += 1;
    op.budget_available = Some(false);
    operations::save(
        tx,
        &op,
        json!({"kind":"bundle_abandoned","request_id":input.request_id,"at":at,
        "actor":{"kind":"human","id":"local_owner"},"stop_basis":"never_claimed","operation":op,"reservation":settled}),
    )?;
    let result = json!({"operation":op,"reservation":settled,"stop_basis":"never_claimed"});
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![
            key,
            serde_json::to_string(&json!({"request":command,"result":result}))?
        ],
    )?;
    Ok(result)
}
pub(super) fn prepare_in(tx: &Transaction, mut input: Request, at: u64) -> Result<Value> {
    if !valid_id(&input.owner_session)
        || !valid_id(&input.request_key)
        || serde_json::to_vec(&input)?.len() > 65536
    {
        bail!("invalid operation bundle")
    }
    input.funding.budget_ids.sort();
    let request = serde_json::to_value(&input)?;
    let receipt_key = format!(
        "operation-bundle:{}",
        serde_json::to_string(&(&input.owner_session, &input.request_key))?
    );
    let receipt: Option<String> = tx
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [&receipt_key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(body) = receipt {
        let saved: Value = serde_json::from_str(&body)?;
        if saved["request"] != request {
            bail!("operation bundle identity conflict")
        }
        return Ok(saved["result"].clone());
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM operations WHERE owner=?1 AND request_key=?2)",
        params![input.owner_session, input.request_key],
        |r| r.get(0),
    )?;
    if exists {
        bail!("operation request already exists outside atomic bundle")
    }
    let mut op = operations::prepare_in(
        tx,
        &input.owner_session,
        &input.request_key,
        input.worker,
        true,
        true,
        true,
        Some(input.selection_policy),
    )?;
    let held = budgets::reserve_in(
        tx,
        budgets::Reserve {
            id: uuid::Uuid::new_v4().to_string(),
            budget_ids: input.funding.budget_ids,
            amount: input.funding.amount,
            unit: input.funding.unit,
            operation_id: op.id.clone(),
        },
        at,
    )?;
    op = operation_budget::attach_in(
        tx,
        &op.id,
        operation_budget::Attach {
            attempt: op.attempt,
            expected_revision: op.revision,
            reservation_id: held.request.id.clone(),
        },
    )?;
    op = operation_grant::attach_in(
        tx,
        &op.id,
        operation_grant::Attach {
            expected_revision: op.revision,
            binding: operation_grant::Binding {
                grant_id: input.grant_id,
                attempt: op.attempt,
                epoch: op.epoch,
                scope: input.grant_scope,
            },
        },
        at,
    )?;
    op = resource_admission::attach_in(
        tx,
        &op.id,
        resource_admission::Attach {
            attempt: op.attempt,
            expected_revision: op.revision,
            policy: input.resource,
        },
    )?;
    operation_grant::admit(tx, &op, at)?;
    operation_budget::admit(tx, &op, at)?;
    let resource = resource_admission::admit(tx, &op, at)?;
    if !resource.allowed {
        bail!("operation bundle resource denied: {}", resource.reason)
    }
    let result = json!({"operation":op,"reservation":held,"resource_decision":resource,"dispatch_state":"not_dispatched"});
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![
            receipt_key,
            serde_json::to_string(&json!({"request":request,"result":result}))?
        ],
    )?;
    Ok(result)
}
impl Store {
    pub fn abandon_operation_bundle(&self, id: &str, input: Abandon) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if super::work_assignments::attached(&tx, id)? {
            bail!("use assignment abandonment for a linked operation")
        }
        let result = abandon_in(&tx, id, input, now())?;
        tx.commit()?;
        Ok(result)
    }
    pub fn prepare_operation_bundle(&self, input: Request) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = prepare_in(&tx, input, now())?;
        tx.commit()?;
        Ok(result)
    }
}
