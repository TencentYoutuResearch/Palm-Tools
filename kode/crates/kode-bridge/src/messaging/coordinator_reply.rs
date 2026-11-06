//! Publish a durable Superagent reply from current control after recorded input consumption.
use super::{
    builder_authority, coordinator_control, coordinator_transfer,
    model::{now, valid_id},
    operations::State,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publish {
    pub request_id: String,
    pub source_message_id: String,
    pub operation_id: String,
    pub control_revision: u64,
    pub attempt: u64,
    pub epoch: u64,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_update: Option<SourceUpdate>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceUpdate {
    pub run_id: String,
    pub revision: u64,
}
fn update_delivery(
    db: &Connection,
    conversation: &str,
    team: &str,
    input: &Publish,
    worker: &super::model::Address,
) -> Result<Option<String>> {
    let Some(reference) = &input.source_update else {
        return Ok(None);
    };
    if !valid_id(&reference.run_id) || reference.revision == 0 {
        bail!("invalid Coordinator reply update")
    }
    let update = super::coordinator_update::read(db, &reference.run_id, reference.revision)?
        .ok_or_else(|| anyhow::anyhow!("Coordinator reply update unavailable"))?;
    let receipt = &update["receipt"];
    let summary = &update["summary"];
    if receipt["run_id"] != reference.run_id
        || receipt["revision"] != reference.revision
        || receipt["team_id"] != team
        || receipt["conversation_id"] != conversation
        || receipt["operation_id"] != input.operation_id
        || receipt["attempt"] != input.attempt
        || receipt["epoch"] != input.epoch
        || receipt["control_revision"] != input.control_revision
        || receipt["worker"] != serde_json::to_value(worker)?
        || receipt["home_hub"] != worker.node_id
        || summary["source_message_id"] != input.source_message_id
        || summary["run_id"] != reference.run_id
        || summary["revision"] != reference.revision
        || summary["team_id"] != team
        || summary["conversation_id"] != conversation
    {
        bail!("Coordinator reply update binding mismatch")
    }
    let message = receipt["message_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid Coordinator reply update delivery"))?;
    let consumed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM runtime_deliveries WHERE message_id=?1 AND session=?2 AND phase=2)",params![message,worker.session_id],|r|r.get(0))?;
    if !consumed {
        bail!("Coordinator reply update consumption not confirmed")
    }
    Ok(Some(message.to_owned()))
}

#[cfg(test)]
mod update_tests {
    use super::*;
    #[test]
    fn update_reply_requires_same_scope_and_exact_consumed_delivery() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE workbench_documents(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE runtime_deliveries(message_id TEXT,session TEXT,phase INTEGER);").unwrap();
        let worker = super::super::model::Address {
            node_id: "home".into(),
            session_id: "worker".into(),
        };
        let mut input = Publish {
            request_id: "reply".into(),
            source_message_id: "human".into(),
            operation_id: "op".into(),
            control_revision: 1,
            attempt: 1,
            epoch: 1,
            content: "observed result".into(),
            source_update: Some(SourceUpdate {
                run_id: "run".into(),
                revision: 7,
            }),
        };
        let row = json!({"summary":{"run_id":"run","revision":7,"team_id":"team","conversation_id":"conversation","source_message_id":"human"},"receipt":{"run_id":"run","revision":7,"team_id":"team","conversation_id":"conversation","operation_id":"op","control_revision":1,"attempt":1,"epoch":1,"worker":worker,"home_hub":"home","message_id":"update-message"}});
        let save = |row: &Value| {
            db.execute(
                "INSERT OR REPLACE INTO workbench_documents(key,value) VALUES (?1,?2)",
                params![
                    "coordinator-update:[\"run\",7]",
                    serde_json::to_string(row).unwrap()
                ],
            )
            .unwrap();
        };
        save(&row);
        assert!(
            update_delivery(&db, "conversation", "team", &input, &worker)
                .unwrap_err()
                .to_string()
                .contains("consumption")
        );
        db.execute(
            "INSERT INTO runtime_deliveries VALUES ('update-message','worker',2)",
            [],
        )
        .unwrap();
        assert_eq!(
            update_delivery(&db, "conversation", "team", &input, &worker).unwrap(),
            Some("update-message".into())
        );
        for (section, key, value) in [
            ("receipt", "operation_id", json!("other")),
            ("receipt", "epoch", json!(2)),
            ("receipt", "team_id", json!("foreign")),
            (
                "receipt",
                "worker",
                json!({"node_id":"home","session_id":"other"}),
            ),
            ("receipt", "home_hub", json!("foreign")),
            ("summary", "source_message_id", json!("other")),
            ("summary", "revision", json!(8)),
        ] {
            let mut invalid = row.clone();
            invalid[section][key] = value;
            save(&invalid);
            assert!(update_delivery(&db, "conversation", "team", &input, &worker).is_err());
        }
        save(&row);
        input.source_update = None;
        assert_eq!(
            update_delivery(&db, "conversation", "team", &input, &worker).unwrap(),
            None
        );
    }
}
fn receipt(db: &Connection, conversation: &str, request: &str) -> Result<Option<(String, String)>> {
    Ok(db.query_row("SELECT request,body FROM conversation_messages WHERE conversation_id=?1 AND actor='superagent' AND request_id=?2",params![conversation,request],|r|Ok((r.get(0)?,r.get(1)?))).optional()?)
}
impl Store {
    pub fn coordinator_reply(&self, conversation: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(conversation) || !valid_id(request) {
            bail!("invalid Coordinator reply identity")
        }
        receipt(&self.db.lock(), conversation, request)?
            .map(|(_, body)| Ok(serde_json::from_str(&body)?))
            .transpose()
    }
    pub fn publish_coordinator_reply(&self, conversation: &str, input: Publish) -> Result<Value> {
        if ![
            conversation,
            &input.request_id,
            &input.source_message_id,
            &input.operation_id,
        ]
        .iter()
        .all(|s| valid_id(s))
            || input.control_revision == 0
            || input.attempt == 0
            || input.epoch == 0
            || input.content.trim().is_empty()
            || input.content.contains('\0')
            || input.content.len() > 65536
        {
            bail!("invalid Coordinator reply")
        }
        let encoded = serde_json::to_string(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some((prior, body)) = receipt(&tx, conversation, &input.request_id)? {
            if prior != encoded {
                bail!("Coordinator reply request identity conflict")
            }
            return Ok(serde_json::from_str(&body)?);
        }
        let authority = coordinator_transfer::reply_authority(
            &tx,
            conversation,
            &input.source_message_id,
            input.control_revision,
        )?
        .ok_or_else(|| anyhow::anyhow!("Coordinator reply input binding mismatch"))?;
        let source = &authority["source"];
        let expected = json!({"operation_id":input.operation_id,"control_revision":input.control_revision,"attempt":input.attempt,"epoch":input.epoch});
        if authority["request"] != expected {
            bail!("Coordinator reply input binding mismatch")
        }
        let team = source["message"]["team_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid conversation team"))?;
        let control = coordinator_control::current_in(&tx, team)?
            .ok_or_else(|| anyhow::anyhow!("Coordinator control missing"))?;
        if control["revision"] != input.control_revision
            || control["conversation_id"] != conversation
            || control["request"]["operation_id"] != input.operation_id
        {
            bail!("Coordinator reply control changed")
        }
        let op = builder_authority::operation(&tx, &input.operation_id)?;
        let at = now();
        if op.state != State::Active
            || op.attempt != input.attempt
            || op.epoch != input.epoch
            || op.worker.node_id != self.node_id
            || op.lease_until.is_none_or(|t| t <= at)
        {
            bail!("Coordinator reply requires active local lease")
        }
        super::operation_grant::admit(&tx, &op, at)?;
        super::operation_budget::admit(&tx, &op, at)?;
        if !super::resource_admission::admit(&tx, &op, at)?.allowed {
            bail!("Coordinator resource unavailable")
        }
        let delivery = source["receipt"]["message_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid Coordinator input receipt"))?;
        let intake_session=source["receipt"]["worker"]["session_id"].as_str()
            .ok_or_else(||anyhow::anyhow!("invalid Coordinator intake worker"))?;
        if intake_session != op.worker.session_id
            && (authority["transfer"].is_null()
                || input.source_update.as_ref().is_none_or(|u|authority["transfer"]["run_id"]!=u.run_id)) {
            bail!("Coordinator reply requires consumed successor update")
        }
        let consumed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM runtime_deliveries WHERE message_id=?1 AND session=?2 AND phase=2)",params![delivery,intake_session],|r|r.get(0))?;
        if !consumed {
            bail!("Coordinator input consumption not confirmed")
        }
        let update_delivery = update_delivery(&tx, conversation, team, &input, &op.worker)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut row = json!({"id":id,"conversation_id":conversation,"team_id":team,"superagent_id":control["superagent_id"],"home_hub":self.node_id,
            "actor":{"kind":"superagent","id":control["superagent_id"]},"request_id":input.request_id,"in_reply_to":input.source_message_id,"content":input.content,
            "operation_id":op.id,"control_revision":input.control_revision,"attempt":input.attempt,"epoch":input.epoch,"source_delivery_id":update_delivery.as_deref().unwrap_or(delivery),
            "team_revision":control["request"]["team_revision"],"activation_revision":control["request"]["activation_revision"],"state":"published","created_at":at});
        if let Some(update) = &input.source_update {
            row["source_update"] = serde_json::to_value(update)?;
            row["source_input_delivery_id"] = json!(delivery);
        }
        if !authority["transfer"].is_null() {
            row["authority_transfer"] = authority["transfer"].clone();
        }
        tx.execute("INSERT INTO conversation_messages(id,conversation_id,team_id,actor,request_id,request,body) VALUES (?1,?2,?3,'superagent',?4,?5,?6)",params![id,conversation,team,input.request_id,encoded,serde_json::to_string(&row)?])?;
        let sequence = tx.last_insert_rowid();
        row["sequence"] = json!(sequence);
        tx.execute(
            "UPDATE conversation_messages SET body=?1 WHERE sequence=?2",
            params![serde_json::to_string(&row)?, sequence],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![team,serde_json::to_string(&json!({"kind":"coordinator_reply_published","conversation_id":conversation,"message_id":id,"in_reply_to":input.source_message_id,"operation_id":op.id,"sequence":sequence,"actor":row["actor"],"at":at}))?])?;
        tx.commit()?;
        Ok(row)
    }
}
