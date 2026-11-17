//! Stable team conversations outlive runtime sessions. Intake is not model consumption or dispatch.
use super::{
    model::{now, valid_id},
    store::Store,
    team_activation,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClarificationTarget {
    pub run_id: String,
    pub assignment_id: String,
    pub question_request_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Send {
    pub request_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clarification_target: Option<ClarificationTarget>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    #[serde(default)]
    pub after: u64,
    pub limit: Option<u32>,
}
fn team(db: &Connection, conversation: &str) -> Result<String> {
    if !valid_id(conversation) {
        bail!("invalid conversation identity")
    }
    Ok(db.query_row(
        "SELECT id FROM teams WHERE conversation_id=?1",
        [conversation],
        |r| r.get(0),
    )?)
}
fn request(db: &Connection, conversation: &str, id: &str) -> Result<Option<(String, String)>> {
    Ok(db.query_row("SELECT request,body FROM conversation_messages WHERE conversation_id=?1 AND actor='human:local_owner' AND request_id=?2",params![conversation,id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?)
}
impl Store {
    pub fn conversation_clarifications(&self, conversation: &str) -> Result<Value> {
        let db = self.db.lock();
        let team_id = team(&db,conversation)?;
        let mut q = db.prepare("SELECT body FROM work_runs WHERE team_id=?1 AND state IN ('running','queued','waiting_resource') ORDER BY id")?;
        let rows = q.query_map([&team_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut items = Vec::new();
        for body in rows {
            let run: Value = serde_json::from_str(&body)?;
            if run["coordinator"]["conversation_id"] != conversation { continue }
            for question in super::assignment_clarification::pending(&run) {
                items.push(json!({"run_id":run["id"],"assignment_id":question["assignment_id"],
                    "question_request_id":question["request"]["request_id"],"questions":question["request"]["questions"],
                    "stage_id":question["stage_id"],"stage_attempt":question["stage_attempt"],"recorded_at":question["recorded_at"],
                    "run_title":run["inputs"]["request"]}));
            }
        }
        Ok(json!({"conversation_id":conversation,"team_id":team_id,"home_hub":self.node_id,"items":items}))
    }

    pub fn pending_conversation_inputs(&self, conversation: &str, input: Page) -> Result<Value> {
        let limit = input.limit.unwrap_or(20);
        if limit == 0 || limit > 32 || input.after > i64::MAX as u64 {
            bail!("invalid pending conversation page")
        }
        let db = self.db.lock();
        let team = team(&db, conversation)?;
        let mut q=db.prepare("SELECT id,sequence FROM (SELECT id,sequence FROM conversation_messages WHERE conversation_id=?1 AND actor='human:local_owner' UNION ALL SELECT id,seq AS sequence FROM collaboration_coordinator_inputs WHERE conversation_id=?1) m WHERE sequence>?2 AND NOT EXISTS(SELECT 1 FROM workbench_documents d WHERE d.key='coordinator-input:'||json_quote(m.id)) ORDER BY sequence LIMIT ?3")?;
        let mut items = q
            .query_map(params![conversation, input.after, limit + 1], |r| {
                Ok(json!({"message_id":r.get::<_,String>(0)?,"sequence":r.get::<_,u64>(1)?}))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = items.len() > limit as usize;
        if more {
            items.pop();
        }
        Ok(
            json!({"conversation_id":conversation,"team_id":team,"home_hub":self.node_id,"next_cursor":if more{items.last().unwrap()["sequence"].clone()}else{Value::Null},"items":items}),
        )
    }
    pub fn send_conversation_message(&self, conversation: &str, input: Send) -> Result<Value> {
        if !valid_id(&input.request_id)
            || input.content.trim().is_empty()
            || input.content.contains('\0')
            || input.content.len() > 65536
            || input.prior_run_id.as_ref().is_some_and(|id| !valid_id(id))
        {
            bail!("invalid conversation message")
        }
        let encoded = serde_json::to_string(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let team_id = team(&tx, conversation)?;
        if let Some((prior, body)) = request(&tx, conversation, &input.request_id)? {
            if prior != encoded {
                bail!("conversation request identity conflict")
            }
            return Ok(serde_json::from_str(&body)?);
        }
        if let Some(prior_id) = &input.prior_run_id {
            let prior: Option<(String, String)> = tx.query_row(
                "SELECT team_id,state FROM work_runs WHERE id=?1", [prior_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            if !prior.is_some_and(|(team,state)| team == team_id && ["completed","failed","cancelled"].contains(&state.as_str())) {
                bail!("follow-up requires terminal work from this team")
            }
        }
        let active = team_activation::current(&tx, &team_id)?
            .ok_or_else(|| anyhow::anyhow!("conversation team requires activation"))?;
        let revision = active["team_revision"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("invalid team activation"))?;
        let authority = team_activation::authorized(&tx, &team_id, revision, now())?
            .ok_or_else(|| anyhow::anyhow!("conversation team authority unavailable"))?;
        if let Some(target) = &input.clarification_target {
            if input.prior_run_id.is_some() || ![&target.run_id,&target.assignment_id,&target.question_request_id].iter().all(|id|valid_id(id)) {
                bail!("invalid clarification target")
            }
            let body: String = tx.query_row("SELECT body FROM work_assignments WHERE id=?1",[&target.assignment_id],|r|r.get(0))?;
            let assignment: Value = serde_json::from_str(&body)?;
            let (mut run, op) = super::assignment_resources::authorized_context(&tx,&target.assignment_id,&assignment,now())?;
            if run["id"] != target.run_id || run["team_id"] != team_id
                || run["coordinator"]["conversation_id"] != conversation
                || assignment["state"] != "prepared" || assignment["creation"]["state"] != "created"
                || op.state != super::operations::State::Active
                || op.lease_until.is_none_or(|t|t<=now()) {
                bail!("clarification target must be active work from this conversation")
            }
            super::assignment_resources::assert_held(&tx,&assignment)?;
            if !super::assignment_mandate::consumed(&tx,&assignment,&self.node_id)? { bail!("clarification target mandate not consumed") }
            super::assignment_clarification::take_pending(&mut run,&target.assignment_id,&target.question_request_id)?;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let at = now();
        let mut row = json!({"id":id,"conversation_id":conversation,"team_id":team_id,"superagent_id":authority["snapshot"]["team"]["superagent_id"],"home_hub":self.node_id,
            "team_revision":revision,"activation_revision":authority["revision"],"request_id":input.request_id,"actor":{"kind":"human","id":"local_owner"},"content":input.content,"created_at":at,"state":"accepted","coordinator_delivery":"pending"});
        if let Some(prior_id) = &input.prior_run_id { row["prior_run_id"] = json!(prior_id); }
        if let Some(target) = &input.clarification_target { row["clarification_target"] = serde_json::to_value(target)?; }
        tx.execute("INSERT INTO conversation_messages(sequence,id,conversation_id,team_id,actor,request_id,request,body) VALUES ((SELECT MAX(COALESCE((SELECT MAX(sequence) FROM conversation_messages),0),COALESCE((SELECT MAX(seq) FROM collaboration_coordinator_inputs),0))+1),?1,?2,?3,'human:local_owner',?4,?5,?6)",params![id,conversation,team_id,input.request_id,encoded,serde_json::to_string(&row)?])?;
        let sequence = tx.last_insert_rowid();
        row["sequence"] = json!(sequence);
        tx.execute(
            "UPDATE conversation_messages SET body=?1 WHERE sequence=?2",
            params![serde_json::to_string(&row)?, sequence],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![team_id,serde_json::to_string(&json!({"kind":"conversation_message_accepted","conversation_id":conversation,"message_id":id,"sequence":sequence,"actor":row["actor"],"at":at}))?])?;
        tx.commit()?;
        Ok(row)
    }
    pub fn conversation_request(&self, conversation: &str, id: &str) -> Result<Option<Value>> {
        if !valid_id(id) {
            bail!("invalid conversation request")
        }
        let db = self.db.lock();
        team(&db, conversation)?;
        request(&db, conversation, id)?
            .map(|(_, body)| Ok(serde_json::from_str(&body)?))
            .transpose()
    }
    pub fn conversation_messages(&self, conversation: &str, input: Page) -> Result<Value> {
        let limit = input.limit.unwrap_or(20);
        if limit == 0 || limit > 50 || input.after > i64::MAX as u64 {
            bail!("invalid conversation page")
        }
        let db = self.db.lock();
        let team = team(&db, conversation)?;
        let mut q=db.prepare("SELECT sequence,body FROM conversation_messages WHERE conversation_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let rows = q
            .query_map(params![conversation, input.after, limit + 1], |r| {
                Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut after = input.after;
        let mut has_more = false;
        for (sequence, body) in rows {
            if items.len() == limit as usize || !items.is_empty() && bytes + body.len() > 262144 {
                has_more = true;
                break;
            }
            bytes += body.len();
            after = sequence;
            items.push(serde_json::from_str::<Value>(&body)?);
        }
        Ok(
            json!({"conversation_id":conversation,"team_id":team,"home_hub":self.node_id,"items":items,"has_more":has_more,"next_cursor":if has_more{json!(after)}else{Value::Null}}),
        )
    }
}
