//! Owner-controlled native conversations, deliberately separate from controlled operations.
//! Host journal reports are owner assertions; this Store never claims to inspect Host files.
use super::{
    collaboration,
    model::{now, valid_id},
    store::Store,
    teams::{ExecutionMode, Spec},
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InteractiveSelection {
    pub team_id: String,
    pub team_revision: u64,
    pub participant_id: String,
    pub target_id: String,
    pub workspace_id: String,
    pub audience_revision: u64,
}
/// Selection is an owner-reviewed routing choice, never a controlled grant.
pub(super) fn validate_selection_in(
    db: &Connection,
    home: &str,
    selection: &InteractiveSelection,
    workspace: &Value,
) -> Result<()> {
    if !valid_id(&selection.team_id)
        || !valid_id(&selection.target_id)
        || !valid_id(&selection.workspace_id)
        || selection.team_revision == 0
        || selection.audience_revision == 0
        || workspace["host_id"] != home
        || workspace["workspace_id"] != selection.workspace_id
    {
        bail!("invalid interactive selection origin")
    }
    let t = team(db, &selection.team_id, selection.team_revision)?;
    let spec: Spec = serde_json::from_value(t["spec"].clone())?;
    spec.validate()?;
    if t["home_hub"] != home || spec.execution_mode != Some(ExecutionMode::InteractiveNative) {
        bail!("selection requires interactive team")
    }
    accepted(db, home, &t)?;
    let allowed = if selection.participant_id == "coordinator" {
        &spec.coordinator_targets
    } else {
        let id = selection
            .participant_id
            .strip_prefix("worker:")
            .ok_or_else(|| anyhow::anyhow!("invalid participant role"))?;
        let worker = spec
            .workers
            .iter()
            .find(|w| w.id == id)
            .ok_or_else(|| anyhow::anyhow!("unknown participant"))?;
        if !worker
            .workspace_refs
            .iter()
            .any(|w| serde_json::to_value(w).ok().as_ref() == Some(workspace))
        {
            bail!("participant workspace not allowed")
        }
        &worker.allowed_target_ids
    };
    if !allowed.contains(&selection.target_id)
        || !spec
            .execution_targets
            .iter()
            .any(|t| t.id == selection.target_id && t.host_id == home)
    {
        bail!("participant target not allowed")
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bind {
    pub request_id: String,
    pub team_id: String,
    pub team_revision: u64,
    pub surface_id: String,
    pub thread_id: String,
    pub audience_revision: u64,
    pub participant_id: String,
    pub target_id: String,
    pub workspace_id: String,
    pub context_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_source_message_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub request_id: String,
    pub source_message_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    pub request_id: String,
    pub receipt_id: String,
    pub native_session_id: String,
    pub journal_id: String,
    pub turn_id: String,
    pub header_sha256: String,
    pub source_marker_sha256: String,
    pub text: String,
    pub text_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Interrupted {
    pub request_id: String, pub receipt_id: String, pub source_message_id: String,
    pub native_session_id: String, pub journal_id: String, pub turn_id: String,
    pub header_sha256: String, pub source_marker_sha256: String,
    pub terminal_sha256: String, pub approval_sha256: String, pub process_stop_sha256: String,
    pub cause: String,
}
fn digest(v: &str) -> String {
    format!("{:x}", Sha256::digest(v.as_bytes()))
}
fn hash(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str()
        .ok_or_else(|| anyhow::anyhow!("missing interactive field {k}"))
}
fn number(v: &Value, k: &str) -> Result<u64> {
    v[k].as_u64()
        .ok_or_else(|| anyhow::anyhow!("missing interactive revision {k}"))
}
fn key(kind: &str, id: &str) -> String {
    format!("interactive-team-v1:{kind}:{id}")
}
fn get(db: &Connection, k: &str) -> Result<Option<Value>> {
    let s: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [k],
            |r| r.get(0),
        )
        .optional()?;
    s.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn put(db: &Connection, k: &str, v: &Value) -> Result<()> {
    db.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2) ON CONFLICT(key) DO UPDATE SET revision=revision+1,value=excluded.value",params![k,serde_json::to_string(v)?])?;
    Ok(())
}
fn required(db: &Connection, k: &str) -> Result<Value> {
    get(db, k)?.ok_or_else(|| anyhow::anyhow!("interactive record not found"))
}
fn team(db: &Connection, id: &str, rev: u64) -> Result<Value> {
    let s: String = db.query_row(
        "SELECT body FROM team_revisions WHERE team_id=?1 AND revision=?2",
        params![id, rev],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&s)?)
}
fn accepted(db: &Connection, home: &str, t: &Value) -> Result<()> {
    let mut q = db.prepare("SELECT body FROM team_events WHERE team_id=?1")?;
    let rows = q.query_map([field(t, "id")?], |r| r.get::<_, String>(0))?;
    for row in rows {
        let event: Value = serde_json::from_str(&row?)?;
        if event["kind"] != "builder_proposal_accepted" || event["team_revision"] != t["revision"] {
            continue;
        }
        let k = format!(
            "builder-accept:{}",
            json!([event["draft_id"], event["request_id"]])
        );
        if let Some(receipt) = get(db, &k)? {
            if receipt["team"] == *t
                && receipt["home_hub"] == home
                && receipt["actor"] == json!({"kind":"human","id":"local_owner"})
            {
                return Ok(());
            }
        }
    }
    super::team_configuration_acceptance::proof(db, home, t).map(|_| ())
}
fn validate(db: &Connection, home: &str, b: &Value) -> Result<Value> {
    if b["home_hub"] != home || b["execution_mode"] != "interactive_native" || b["state"] != "bound"
    {
        bail!("interactive binding unavailable")
    }
    let (_, origin) = collaboration::context_access::resolve(
        db,
        home,
        field(b, "surface_id")?,
        field(b, "thread_id")?,
        field(b, "team_id")?,
        number(b, "team_revision")?,
        number(b, "audience_revision")?,
    )?;
    let workspace = json!({"host_id":origin.host_id,"workspace_id":origin.workspace_id,"root_ref":origin.root_ref});
    if b["workspace"] != workspace || workspace["host_id"] != home {
        bail!("interactive workspace changed")
    }
    let t = team(db, field(b, "team_id")?, number(b, "team_revision")?)?;
    let spec: Spec = serde_json::from_value(t["spec"].clone())?;
    spec.validate()?;
    if t["home_hub"] != home || spec.execution_mode != Some(ExecutionMode::InteractiveNative) {
        bail!("interactive mode not owner accepted")
    }
    accepted(db, home, &t)?;
    Ok(t)
}
fn source(db: &Connection, b: &Value, id: &str) -> Result<Value> {
    let s:String=db.query_row("SELECT body FROM collaboration_messages WHERE id=?1 AND surface_id=?2 AND thread_id=?3 AND kind='discussion'",params![id,field(b,"surface_id")?,field(b,"thread_id")?],|r|r.get(0))?;
    let m: Value = serde_json::from_str(&s)?;
    let scope = json!({"home_hub":b["home_hub"],"host_id":b["workspace"]["host_id"],"workspace_id":b["workspace"]["workspace_id"],"root_ref":b["workspace"]["root_ref"]});
    if m["id"] != id
        || m["surface_id"] != b["surface_id"]
        || m["thread_id"] != b["thread_id"]
        || m["scope"] != scope
        || m["actor"] != json!({"kind":"human","id":"local_owner"})
        || m["kind"] != "discussion"
        || m.get("attachments").is_some()
    {
        bail!("interactive source identity mismatch")
    }
    if m.get("audience_revision").is_some() && m["audience_revision"] != b["audience_revision"] {
        bail!("source audience changed")
    }
    if let Some(start) = b["start_sequence"].as_u64() {
        let seq = number(&m, "sequence")?;
        if seq <= start
            && (b["first_source_message_id"] != id
                || b["first_source_content_sha256"] != digest(field(&m, "content")?))
        {
            bail!("source predates interactive binding")
        }
    }
    let mentions = m["mentions"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid source mentions"))?;
    if !mentions.is_empty() {
        let participant = field(b, "participant_id")?;
        let allowed = mentions.iter().any(|mention| {
            mention["team_id"] == b["team_id"]
                && mention["team_revision"] == b["team_revision"]
                && if participant == "coordinator" {
                    mention["worker_id"].is_null()
                } else {
                    mention["worker_id"].as_str() == participant.strip_prefix("worker:")
                }
        });
        if !allowed {
            bail!("source mentions do not authorize this participant")
        }
    }
    if let Some(selection) = m.get("interactive_selection") {
        let expected = json!({"team_id":b["team_id"],"team_revision":b["team_revision"],"participant_id":b["participant_id"],"target_id":b["target_id"],"workspace_id":b["workspace"]["workspace_id"],"audience_revision":b["audience_revision"]});
        if selection != &expected {
            bail!("interactive source selection differs from binding")
        }
    }
    field(&m, "content")?;
    Ok(m)
}
fn receipt_source(db: &Connection, b: &Value, r: &Value) -> Result<Value> {
    if r["binding_id"] != b["binding_id"] || r["native_session_id"] != b["native_session_id"] {
        bail!("interactive receipt binding mismatch")
    }
    let m = source(db, b, field(r, "source_message_id")?)?;
    if r["source_content_sha256"] != digest(field(&m, "content")?) {
        bail!("interactive source changed")
    }
    Ok(m)
}
impl Store {
    pub fn bind_interactive_team(&self, input: Bind) -> Result<Value> {
        if [
            &input.request_id,
            &input.team_id,
            &input.surface_id,
            &input.thread_id,
            &input.target_id,
            &input.workspace_id,
        ]
        .iter()
        .any(|s| !valid_id(s))
            || input.context_epoch != 1
        {
            bail!("invalid interactive binding request")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let rk = key("bind-request", &input.request_id);
        if let Some(prior) = get(&tx, &rk)? {
            if prior["request"] != request {
                bail!("interactive binding request conflict")
            }
            let b = required(&tx, &key("binding", field(&prior, "binding_id")?))?;
            let t = validate(&tx, &self.node_id, &b)?;
            return Ok(json!({"binding":b,"team_snapshot":t,"new_binding":false}));
        }
        let (scope, origin) = collaboration::context_access::resolve(
            &tx,
            &self.node_id,
            &input.surface_id,
            &input.thread_id,
            &input.team_id,
            input.team_revision,
            input.audience_revision,
        )?;
        if origin.host_id != self.node_id || origin.workspace_id != input.workspace_id {
            bail!("interactive native workspace must be local and exact")
        }
        let t = team(&tx, &input.team_id, input.team_revision)?;
        let spec: Spec = serde_json::from_value(t["spec"].clone())?;
        spec.validate()?;
        if spec.execution_mode != Some(ExecutionMode::InteractiveNative) {
            bail!("interactive mode not selected")
        }
        accepted(&tx, &self.node_id, &t)?;
        let allowed = if input.participant_id == "coordinator" {
            &spec.coordinator_targets
        } else {
            let id = input
                .participant_id
                .strip_prefix("worker:")
                .ok_or_else(|| anyhow::anyhow!("invalid participant role"))?;
            let w = spec
                .workers
                .iter()
                .find(|w| w.id == id)
                .ok_or_else(|| anyhow::anyhow!("unknown participant"))?;
            if !w.workspace_refs.iter().any(|w| {
                w.host_id == origin.host_id
                    && w.workspace_id == origin.workspace_id
                    && w.root_ref == origin.root_ref
            }) {
                bail!("participant workspace not allowed")
            }
            &w.allowed_target_ids
        };
        if !allowed.contains(&input.target_id) {
            bail!("participant target not allowed")
        }
        let target = spec
            .execution_targets
            .iter()
            .find(|t| t.id == input.target_id && t.host_id == origin.host_id)
            .ok_or_else(|| anyhow::anyhow!("unknown local target"))?;
        let tuple = json!([
            self.node_id,
            input.team_id,
            input.team_revision,
            input.surface_id,
            input.thread_id,
            input.audience_revision,
            input.participant_id,
            input.target_id,
            input.context_epoch
        ]);
        let tk = key("tuple", &digest(&tuple.to_string()));
        if let Some(existing) = get(&tx, &tk)? {
            let b = required(&tx, &key("binding", field(&existing, "binding_id")?))?;
            let snapshot = validate(&tx, &self.node_id, &b)?;
            // Reuse only the exact immutable tuple. A new request cannot expand
            // the first-source exception or replace an existing native Session.
            if let Some(first) = &input.first_source_message_id {
                source(&tx, &b, first)?;
            }
            put(
                &tx,
                &rk,
                &json!({"request":request,"binding_id":b["binding_id"]}),
            )?;
            tx.commit()?;
            return Ok(json!({"binding":b,"team_snapshot":snapshot,"new_binding":false}));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let session = format!("session-{}", uuid::Uuid::new_v4());
        let mut b = json!({"version":1,"execution_mode":"interactive_native","binding_id":id,"revision":1,"home_hub":self.node_id,
            "team_id":input.team_id,"team_revision":input.team_revision,"surface_kind":if scope.kind==super::coordinator_context_scope::Kind::TeamPrivate {"dm"}else{"channel"},
            "surface_id":input.surface_id,"thread_id":input.thread_id,"audience_revision":input.audience_revision,"context_epoch":input.context_epoch,
            "participant_id":input.participant_id,"target_id":input.target_id,"native_session_id":session,
            "workspace":{"host_id":origin.host_id,"workspace_id":origin.workspace_id,"root_ref":origin.root_ref},
            "selection":{"profile_id":target.executor_profile_id,"profile_revision":target.executor_profile_revision,"model":target.model_id,"reasoningEffort":target.effort},"state":"bound"});
        if let Some(first) = &input.first_source_message_id {
            if !valid_id(first) {
                bail!("invalid first source")
            }
            let message = source(&tx, &b, first)?;
            b["first_source_message_id"] = json!(first);
            b["first_source_content_sha256"] = json!(digest(field(&message, "content")?));
        }
        let start: u64 = tx.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM collaboration_messages",
            [],
            |r| r.get(0),
        )?;
        b["start_sequence"] = json!(start);
        put(&tx, &key("binding", &id), &b)?;
        put(&tx, &key("session", &session), &json!({"binding_id":id}))?;
        put(&tx, &tk, &json!({"binding_id":id}))?;
        put(&tx, &rk, &json!({"request":request,"binding_id":id}))?;
        tx.commit()?;
        Ok(json!({"binding":b,"team_snapshot":t,"new_binding":true}))
    }
    pub fn interactive_team_binding(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            bail!("invalid binding id")
        }
        let db = self.db.lock();
        let b = required(&db, &key("binding", id))?;
        let t = validate(&db, &self.node_id, &b)?;
        Ok(json!({"binding":b,"team_snapshot":t}))
    }
    pub fn interactive_team_original_source_binding(&self, source_id: &str) -> Result<String> {
        if !valid_id(source_id) { bail!("invalid original source") }
        let db = self.db.lock();
        let request = required(&db, &key("bind-request", &format!("composer:{source_id}")))?;
        if request["request"]["first_source_message_id"] != source_id { bail!("original request source mismatch") }
        Ok(field(&request,"binding_id")?.to_owned())
    }
    /// Read-only owner recovery proof. It never clears receipts or grants replay.
    pub fn inspect_interactive_team_recovery(&self, id: &str) -> Result<Value> {
        if !valid_id(id) { bail!("invalid binding id") }
        let db = self.db.lock();
        let b = required(&db, &key("binding", id))?;
        let t = validate(&db, &self.node_id, &b)?;
        let first = field(&b, "first_source_message_id")?;
        let m = source(&db, &b, first)?;
        if b["first_source_content_sha256"] != digest(field(&m, "content")?) {
            bail!("original source changed")
        }
        let claims: u64 = db.query_row(
            "SELECT COUNT(*) FROM workbench_documents WHERE key LIKE 'interactive-team-v1:receipt:%' AND json_extract(value,'$.binding_id')=?1",
            [id], |r| r.get(0))?;
        let allowed = claims == 0 && get(&db, &key("inflight", id))?.is_none();
        let mut reply = Value::Null;
        let mut receipt = Value::Null;
        if let Some(index) = get(&db, &key("source", &json!([id, first]).to_string()))? {
            let r = required(&db, &key("receipt", field(&index,"receipt_id")?))?;
            receipt_source(&db, &b, &r)?;
            receipt=r.clone();
            if r["state"] == "completed" {
                let out = required(&db, &key("outbox", field(&r,"outbox_id")?))?;
                if out["binding_id"] != id || out["receipt_id"] != r["receipt_id"] { bail!("recovery outbox differs") }
                if out["state"] == "published" { reply=out["message"].clone(); }
            }
        }
        Ok(json!({"binding":b,"team_snapshot":t,"message":m,"never_claimed":allowed,
            "receipt":receipt,"reply_message":reply,"recovery_state":if allowed {"unclaimed"} else {"requires_inspection"}}))
    }
    pub fn interactive_team_session(&self, session: &str) -> Result<Value> {
        if !valid_id(session) {
            bail!("invalid native session")
        }
        let db = self.db.lock();
        let s = required(&db, &key("session", session))?;
        let b = required(&db, &key("binding", field(&s, "binding_id")?))?;
        if b["native_session_id"] != session {
            bail!("native session binding mismatch")
        }
        let t = validate(&db, &self.node_id, &b)?;
        Ok(json!({"binding":b,"team_snapshot":t}))
    }
    pub fn claim_interactive_team_source(&self, id: &str, input: Claim) -> Result<Value> {
        if !valid_id(id) || !valid_id(&input.request_id) || !valid_id(&input.source_message_id) {
            bail!("invalid source request")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let b = required(&tx, &key("binding", id))?;
        validate(&tx, &self.node_id, &b)?;
        let request = serde_json::to_value(&input)?;
        let rk = key("claim-request", &json!([id, input.request_id]).to_string());
        if let Some(prior) = get(&tx, &rk)? {
            if prior["request"] != request {
                bail!("source request conflict")
            }
            let r = required(&tx, &key("receipt", field(&prior, "receipt_id")?))?;
            let m = receipt_source(&tx, &b, &r)?;
            return Ok(json!({"binding":b,"receipt":r,"message":m,"new_claim":false}));
        }
        let sk = key("source", &json!([id, input.source_message_id]).to_string());
        if get(&tx, &sk)?.is_some() || get(&tx, &key("inflight", id))?.is_some() {
            bail!("source already claimed or binding requires reconciliation")
        }
        let m = source(&tx, &b, &input.source_message_id)?;
        let rid = uuid::Uuid::new_v4().to_string();
        let r = json!({"receipt_id":rid,"binding_id":id,"source_message_id":input.source_message_id,"source_content_sha256":digest(field(&m,"content")?),"native_session_id":b["native_session_id"],"state":"claimed"});
        put(&tx, &key("receipt", &rid), &r)?;
        put(&tx, &sk, &json!({"receipt_id":rid}))?;
        put(&tx, &key("inflight", id), &json!({"receipt_id":rid}))?;
        put(&tx, &rk, &json!({"request":request,"receipt_id":rid}))?;
        tx.commit()?;
        Ok(json!({"binding":b,"receipt":r,"message":m,"new_claim":true}))
    }
    /// Non-success terminal evidence. Retains the in-flight fence and source deduplication.
    pub fn interrupt_interactive_team_source(&self, id: &str, input: Interrupted) -> Result<Value> {
        if !valid_id(id) || [&input.receipt_id,&input.source_message_id,&input.native_session_id,&input.journal_id].iter().any(|s| !valid_id(s))
            || input.request_id != format!("interrupted:{}",input.receipt_id) || input.cause != "approval_rejected"
            || input.turn_id.parse::<u64>().ok().filter(|v| *v>0).is_none()
            || [&input.header_sha256,&input.source_marker_sha256,&input.terminal_sha256,&input.approval_sha256,&input.process_stop_sha256].iter().any(|s| !hash(s)) {
            bail!("invalid interrupted journal proof")
        }
        let mut db=self.db.lock(); let tx=db.transaction()?;
        let b=required(&tx,&key("binding",id))?; validate(&tx,&self.node_id,&b)?;
        let mut r=required(&tx,&key("receipt",&input.receipt_id))?; receipt_source(&tx,&b,&r)?;
        if r["source_message_id"]!=input.source_message_id || b["native_session_id"]!=input.native_session_id || input.journal_id!=input.native_session_id { bail!("interrupted source identity mismatch") }
        let report=serde_json::to_value(&input)?;
        if r["state"]=="interrupted" {
            if r["interruption"]!=report { bail!("interrupted proof conflict") }
            return Ok(json!({"binding":b,"receipt":r,"new_interruption":false}));
        }
        let inflight=required(&tx,&key("inflight",id))?;
        if r["state"]!="claimed" || inflight["receipt_id"]!=input.receipt_id { bail!("source cannot be interrupted") }
        let jk=key("journal",id);
        let journal=json!({"native_session_id":input.native_session_id,"journal_id":input.journal_id,"header_sha256":input.header_sha256});
        if let Some(prior)=get(&tx,&jk)? { if prior!=journal { bail!("native journal identity changed") } }
        let tk=key("turn",&json!([id,input.journal_id,input.turn_id]).to_string());
        if get(&tx,&tk)?.is_some() { bail!("native terminal turn already consumed") }
        r["state"]=json!("interrupted"); r["interruption"]=report;
        put(&tx,&key("receipt",&input.receipt_id),&r)?;
        put(&tx,&jk,&journal)?; put(&tx,&tk,&json!({"receipt_id":input.receipt_id,"state":"interrupted"}))?;
        tx.commit()?; Ok(json!({"binding":b,"receipt":r,"new_interruption":true}))
    }
    pub fn finish_interactive_team_source(&self, id: &str, input: Finish) -> Result<Value> {
        if !valid_id(id)
            || [
                &input.request_id,
                &input.receipt_id,
                &input.native_session_id,
                &input.journal_id,
                &input.turn_id,
            ]
            .iter()
            .any(|s| !valid_id(s))
            || !hash(&input.header_sha256)
            || !hash(&input.source_marker_sha256)
            || input.text.trim().is_empty()
            || input.text.len() > 65536
            || input.text.contains('\0')
            || digest(&input.text) != input.text_sha256
        {
            bail!("invalid interactive completion proof")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let b = required(&tx, &key("binding", id))?;
        validate(&tx, &self.node_id, &b)?;
        let mut r = required(&tx, &key("receipt", &input.receipt_id))?;
        receipt_source(&tx, &b, &r)?;
        if input.native_session_id != field(&b, "native_session_id")? {
            bail!("completion session mismatch")
        }
        let rk = key("finish-request", &json!([id, input.request_id]).to_string());
        let request_hash = digest(&serde_json::to_string(&input)?);
        if let Some(prior) = get(&tx, &rk)? {
            if prior["request_hash"] != request_hash {
                bail!("completion request conflict")
            }
            let out = required(&tx, &key("outbox", field(&prior, "outbox_id")?))?;
            return Ok(json!({"binding":b,"receipt":r,"outbox":out,"new_completion":false}));
        }
        let inflight = required(&tx, &key("inflight", id))?;
        if r["state"] != "claimed" || inflight["receipt_id"] != input.receipt_id {
            bail!("source not in flight")
        }
        let jk = key("journal", id);
        let journal = json!({"native_session_id":input.native_session_id,"journal_id":input.journal_id,"header_sha256":input.header_sha256});
        if let Some(prior) = get(&tx, &jk)? {
            if prior != journal {
                bail!("native journal identity changed")
            }
        }
        let tk = key(
            "turn",
            &json!([id, input.journal_id, input.turn_id]).to_string(),
        );
        if get(&tx, &tk)?.is_some() {
            bail!("native terminal turn already consumed")
        }
        let oid = uuid::Uuid::new_v4().to_string();
        let out = json!({"outbox_id":oid,"binding_id":id,"receipt_id":input.receipt_id,"state":"pending","text":input.text,"text_sha256":input.text_sha256,
            "host_report":{"journal_id":input.journal_id,"turn_id":input.turn_id,"header_sha256":input.header_sha256,"source_marker_sha256":input.source_marker_sha256},"proof_kind":"owner_host_report"});
        r["state"] = json!("completed");
        r["outbox_id"] = json!(oid);
        put(&tx, &key("receipt", &input.receipt_id), &r)?;
        put(&tx, &key("outbox", &oid), &out)?;
        put(&tx, &jk, &journal)?;
        put(&tx, &tk, &json!({"receipt_id":input.receipt_id}))?;
        put(
            &tx,
            &rk,
            &json!({"request_hash":request_hash,"outbox_id":oid}),
        )?;
        tx.commit()?;
        Ok(json!({"binding":b,"receipt":r,"outbox":out,"new_completion":true}))
    }
    pub fn publish_interactive_team_reply(&self, id: &str, outbox: &str) -> Result<Value> {
        if !valid_id(id) || !valid_id(outbox) {
            bail!("invalid interactive publication")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let b = required(&tx, &key("binding", id))?;
        validate(&tx, &self.node_id, &b)?;
        let mut out = required(&tx, &key("outbox", outbox))?;
        let r = required(&tx, &key("receipt", field(&out, "receipt_id")?))?;
        let source = receipt_source(&tx, &b, &r)?;
        if out["binding_id"] != id || r["outbox_id"] != outbox || r["state"] != "completed" {
            bail!("publication binding mismatch")
        }
        if out["state"] == "published" {
            return Ok(
                json!({"receipt":r,"outbox":out,"message":out["message"],"new_publication":false}),
            );
        }
        if out["state"] != "pending" || out["text_sha256"] != digest(field(&out, "text")?) {
            bail!("publication unavailable")
        }
        let inflight = required(&tx, &key("inflight", id))?;
        if inflight["receipt_id"] != r["receipt_id"] {
            bail!("publication source fence mismatch")
        }
        let message = collaboration::insert_scoped_message(
            &tx,
            field(&b, "surface_id")?,
            field(&b, "thread_id")?,
            "superagent_reply",
            json!({
            "id":uuid::Uuid::new_v4().to_string(),"surface_id":b["surface_id"],"thread_id":b["thread_id"],"scope":source["scope"],
            "actor":{"kind":"interactive_participant","team_id":b["team_id"],"participant_id":b["participant_id"],"target_id":b["target_id"],"session_id":b["native_session_id"]},
            "kind":"superagent_reply","content":out["text"],"source_message_id":r["source_message_id"],"created_at":now(),"delivery_state":"published","execution_authorized":false}),
        )?;
        out["state"] = json!("published");
        out["message"] = message.clone();
        put(&tx, &key("outbox", outbox), &out)?;
        tx.execute(
            "DELETE FROM workbench_documents WHERE key=?1",
            [key("inflight", id)],
        )?;
        tx.commit()?;
        Ok(json!({"receipt":r,"outbox":out,"message":message,"new_publication":true}))
    }
}
