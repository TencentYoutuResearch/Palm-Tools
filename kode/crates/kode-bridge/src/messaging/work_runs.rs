//! Home-owned request intake and immutable run context. Activation/dispatch are separate gates.
use super::{
    model::{now, valid_id},
    store::Store,
    teams::Spec,
    workflows::Pack,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub id: String,
    pub request_id: String,
    pub team_id: String,
    pub team_revision: u64,
    pub binding_id: String,
    pub inputs: BTreeMap<String, String>,
    pub prior_run_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Takeover {
        request_id: String,
        expected_revision: u64,
        reason: String,
    },
    FinalizeTakeover {
        request_id: String,
        expected_revision: u64,
    },
    Resume {
        request_id: String,
        expected_revision: u64,
        reason: String,
    },
    Cancel {
        request_id: String,
        expected_revision: u64,
    },
    FinalizeCancel {
        request_id: String,
        expected_revision: u64,
    },
    RequestCancel {
        request_id: String,
        expected_revision: u64,
        reason: String,
    },
    CancelSettled {
        request_id: String,
        expected_revision: u64,
        reason: String,
    },
    RecheckExecution {
        request_id: String,
        expected_revision: u64,
        reason: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveQuery {
    pub after: Option<String>,
}

impl Store {
    /// Owner process history includes terminal runs; scheduler discovery deliberately does not.
    pub fn team_work_runs(&self, team: &str, page: super::teams::Page) -> Result<Option<Value>> {
        let limit = page.limit.unwrap_or(25);
        if !valid_id(team)
            || (!page.after.is_empty() && !valid_id(&page.after))
            || limit == 0
            || limit > 50
        {
            bail!("invalid team run page")
        }
        let db = self.db.lock();
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM teams WHERE id=?1)",
            [team],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        let mut query = db.prepare(
            "SELECT body FROM work_runs WHERE team_id=?1 AND id>?2 ORDER BY id LIMIT ?3",
        )?;
        let mut items = query.query_map(params![team, page.after, limit + 1], |row| row.get::<_, String>(0))?
            .map(|row| {
                let row: Value = serde_json::from_str(&row?)?;
                let preview = row["inputs"]["request"].as_str().map(|text| text.chars().take(240).collect::<String>());
                Ok(json!({"id":row["id"],"team_id":row["team_id"],"home_hub":self.node_id,
                    "revision":row["revision"],"state":row["state"],"waiting_reason":row["waiting_reason"],
                    "completion_authorized":row["completion_authorized"],"created_at":row["created_at"],"updated_at":row["updated_at"],
                    "request_preview":preview,"coordinator":row["coordinator"],"prior_run_id":row["prior_run_id"]}))
            }).collect::<Result<Vec<Value>>>()?;
        let more = items.len() > limit;
        items.truncate(limit);
        let next = if more {
            items.last().map(|row| row["id"].clone())
        } else {
            None
        };
        Ok(Some(
            json!({"team_id":team,"home_hub":self.node_id,"items":items,"next_cursor":next}),
        ))
    }

    pub fn active_work_runs(&self, input: ActiveQuery) -> Result<Value> {
        if input.after.as_ref().is_some_and(|id| !valid_id(id)) {
            bail!("invalid active run cursor")
        }
        let db = self.db.lock();
        let mut query = db.prepare("SELECT id,team_id,revision,state FROM work_runs WHERE id>?1 AND state IN ('waiting_resource','queued','running','cancelling','cancel_unconfirmed','taking_over') ORDER BY id LIMIT 64")?;
        let rows = query.query_map([input.after.unwrap_or_default()], |row| Ok(json!({
            "id":row.get::<_,String>(0)?,"team_id":row.get::<_,String>(1)?,"revision":row.get::<_,u64>(2)?,
            "state":row.get::<_,String>(3)?,"home_hub":self.node_id,
        })))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let next = if rows.len() == 64 {
            rows.last().map(|row| row["id"].clone())
        } else {
            None
        };
        Ok(json!({"items":rows,"next_cursor":next}))
    }

    pub fn create_work_run(&self, input: Create) -> Result<Value> {
        self.create_work_run_scoped(input, None)
    }
    pub(super) fn create_work_run_scoped(
        &self,
        input: Create,
        coordinator: Option<(&str, &super::coordinator_run::Start)>,
    ) -> Result<Value> {
        if [
            &input.id,
            &input.request_id,
            &input.team_id,
            &input.binding_id,
        ]
        .iter()
        .any(|id| !valid_id(id))
            || input.team_revision == 0
            || input.team_revision > i64::MAX as u64
            || input.prior_run_id.as_ref().is_some_and(|id| !valid_id(id))
            || input.inputs.len() > 64
            || input
                .inputs
                .values()
                .any(|v| v.trim().is_empty() || v.contains('\0'))
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid work run request");
        }
        let request = if let Some((conversation, scope)) = coordinator {
            serde_json::to_string(
                &json!({"run":input,"conversation_id":conversation,"coordinator":scope}),
            )?
        } else {
            serde_json::to_string(&input)?
        };
        // Return the original receipt even if the run was cancelled since creation.
        if let Some((prior, body)) = self
            .db
            .lock()
            .query_row(
                "SELECT request,initial_body FROM work_runs WHERE team_id=?1 AND request_id=?2",
                params![input.team_id, input.request_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if prior != request {
                bail!("work run request identity conflict");
            }
            return Ok(serde_json::from_str(&body)?);
        }
        let team = self
            .team(&input.team_id, Some(input.team_revision))?
            .ok_or_else(|| anyhow::anyhow!("unknown team revision"))?;
        let spec: Spec = serde_json::from_value(team["spec"].clone())?;
        if spec.kind != super::teams::Kind::Coordinator {
            bail!("work runs require a coordinator team");
        }
        let preflight = self
            .team_workflow_preflight(&input.team_id, input.team_revision)?
            .unwrap();
        if preflight["workflow_bindings_valid"] != true
            || preflight["project_delivery_bindings_valid"] != true
        {
            bail!("team workflow/project bindings are invalid");
        }
        let binding = preflight["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == input.binding_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown team delivery binding"))?;
        let pack: Pack = serde_json::from_value(binding["workflow"]["pack"].clone())?;
        if pack.inputs.len() != input.inputs.len()
            || pack.inputs.iter().any(|id| !input.inputs.contains_key(id))
        {
            bail!("work run inputs do not match workflow");
        }
        let context = json!({"team":team,"binding":binding});
        let context_hash = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "kode.work.run.context.v1\n{}",
                    serde_json::to_string(&context)?
                )
                .as_bytes()
            )
        );
        let stages: Vec<Value> = pack.stages.iter().map(|stage| json!({"stage_id":stage.id,"state":"pending","attempt":0,"assignment_id":null})).collect();
        let at = now();
        let mut row = json!({"schema_version":1,"id":input.id,"team_id":input.team_id,"team_revision":input.team_revision,
            "home_hub":self.node_id,"owner":{"kind":"human","id":"local_owner"},"revision":1,
            "created_at":at,"updated_at":at,"state":"waiting_user","waiting_reason":"team_activation_required",
            "dispatch_state":"not_dispatched","completion_authorized":false,"inputs":input.inputs,"prior_run_id":input.prior_run_id,
            "context":context,"context_hash":context_hash,"context_hash_format":"kode.work.run.context.v1","stages":stages});
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        // Immutable references above remain valid; idempotency and capacity are serialized here.
        let retry: Option<(String, String)> = tx
            .query_row(
                "SELECT request,initial_body FROM work_runs WHERE team_id=?1 AND request_id=?2",
                params![input.team_id, input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior, body)) = retry {
            if prior != request {
                bail!("work run request identity conflict");
            }
            return Ok(serde_json::from_str(&body)?);
        }
        if let Some(prior_id) = &input.prior_run_id {
            let prior: Option<(String, String)> = tx
                .query_row(
                    "SELECT team_id,state FROM work_runs WHERE id=?1",
                    [prior_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if !prior.is_some_and(|(team, state)| {
                team == input.team_id
                    && ["completed", "failed", "cancelled"].contains(&state.as_str())
            }) {
                bail!("prior run must be terminal and belong to this team");
            }
        }
        if let Some((conversation, scope)) = coordinator {
            let origin =
                super::coordinator_run::authorize(&tx, &self.node_id, conversation, scope)?;
            row["owner"] = json!({"kind":"superagent","id":origin["superagent_id"]});
            row["coordinator"] = origin;
        }
        let count: u64 = tx.query_row("SELECT COUNT(*) FROM work_runs WHERE team_id=?1 AND state NOT IN ('completed','failed','cancelled')",[&input.team_id],|r|r.get(0))?;
        if count >= u64::from(spec.limits.max_active_runs) {
            bail!("team work run capacity exhausted");
        }
        if let Some(activation) =
            super::team_activation::authorized(&tx, &input.team_id, input.team_revision, now())?
        {
            super::team_activation::bind_run(&mut row, activation);
        }
        let body = serde_json::to_string(&row)?;
        tx.execute("INSERT INTO work_runs(id,team_id,request_id,request,revision,state,body,initial_body) VALUES (?1,?2,?3,?4,1,?6,?5,?5)",params![input.id,input.team_id,input.request_id,request,body,row["state"].as_str()])?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![input.id,serde_json::to_string(&json!({"kind":"work_run_received","revision":1,"at":at,"actor":row["owner"],"run":row}))?])?;
        tx.commit()?;
        Ok(row)
    }
    pub fn work_run(&self, id: &str) -> Result<Option<Value>> {
        if !valid_id(id) {
            bail!("invalid work run id");
        }
        let body: Option<String> = self
            .db
            .lock()
            .query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    /// Receipt and current run version come from one SQLite snapshot. A missing
    /// receipt at a newer version proves the old CAS command can no longer commit.
    pub fn work_run_command_receipt(&self, id: &str, request_id: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(request_id) {
            bail!("invalid work run receipt identity")
        }
        let db = self.db.lock();
        let found: Option<(String, Option<String>, Option<String>)> = db.query_row(
            "SELECT r.body,c.request,c.result FROM work_runs r LEFT JOIN work_run_commands c ON c.run_id=r.id AND c.request_id=?2 WHERE r.id=?1",
            params![id,request_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        found.map(|(body,request,result)| {
            let run: Value=serde_json::from_str(&body)?;
            if run["id"]!=id || run["home_hub"]!=self.node_id { bail!("work run receipt scope invalid") }
            let receipt=match (request,result) {
                (Some(request),Some(result))=>Some(json!({"request":serde_json::from_str::<Value>(&request)?,"result":serde_json::from_str::<Value>(&result)?})),
                (None,None)=>None,
                _=>bail!("work run receipt incomplete"),
            };
            Ok(json!({"snapshot":"work_run_command_receipt.v1","home_hub":self.node_id,"run_id":id,"team_id":run["team_id"],"request_id":request_id,
                "run_revision":run["revision"],"run_state":run["state"],"receipt":receipt}))
        }).transpose()
    }
    pub fn command_work_run(&self, id: &str, input: Command) -> Result<Value> {
        let (request_id, expected_revision, reason) = match &input {
            Command::Cancel {
                request_id,
                expected_revision,
            }
            | Command::FinalizeCancel {
                request_id,
                expected_revision,
            }
            | Command::FinalizeTakeover {
                request_id,
                expected_revision,
            } => (request_id, expected_revision, None),
            Command::RequestCancel {
                request_id,
                expected_revision,
                reason,
            }
            | Command::CancelSettled {
                request_id,
                expected_revision,
                reason,
            }
            | Command::RecheckExecution {
                request_id,
                expected_revision,
                reason,
            }
            | Command::Takeover {
                request_id,
                expected_revision,
                reason,
            }
            | Command::Resume {
                request_id,
                expected_revision,
                reason,
            } => (request_id, expected_revision, Some(reason)),
        };
        if !valid_id(id)
            || !valid_id(request_id)
            || *expected_revision == 0
            || *expected_revision >= i64::MAX as u64
            || reason.is_some_and(|reason| {
                reason.trim().is_empty() || reason.len() > 2048 || reason.contains('\0')
            })
        {
            bail!("invalid work run command");
        }
        let request = serde_json::to_string(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT request,result FROM work_run_commands WHERE run_id=?1 AND request_id=?2",
                params![id, request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior, result)) = prior {
            if prior != request {
                bail!("work run command identity conflict");
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let body: String = tx
            .query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("unknown work run"))?;
        let mut row: Value = serde_json::from_str(&body)?;
        if row["revision"] != *expected_revision {
            bail!("work run revision conflict");
        }
        if matches!(input, Command::Takeover { .. } | Command::FinalizeTakeover { .. } | Command::Resume { .. }) {
            super::work_run_intervention::command(&tx, id, &mut row, &input, &request, &self.node_id)?;
            tx.commit()?;
            return Ok(row);
        }
        if matches!(input, Command::RecheckExecution { .. }) {
            super::work_run_recheck::request(
                &tx,
                id,
                &mut row,
                request_id,
                reason.unwrap(),
                &request,
            )?;
            tx.commit()?;
            return Ok(row);
        }
        if matches!(input, Command::FinalizeCancel { .. }) {
            super::work_run_cancel_final::finalize(&tx, id, &mut row, request_id, &request)?;
            tx.commit()?;
            return Ok(row);
        }
        if matches!(input, Command::RequestCancel { .. }) {
            super::work_run_cancellation::request(
                &tx,
                id,
                &mut row,
                request_id,
                reason.unwrap(),
                &request,
            )?;
            tx.commit()?;
            return Ok(row);
        }
        let settled = if reason.is_some() {
            if row["state"] != "waiting_user" || row["completion_authorized"] == true {
                bail!("settled cancellation requires waiting_user work")
            }
            Some(super::work_run_resolution::settled_assignments(&tx, id)?)
        } else {
            // Only intake cancellation can be confirmed without executor stop receipts.
            if (row["state"] != "waiting_user" && row["state"] != "waiting_resource")
                || row["dispatch_state"] != "not_dispatched"
                || row["stages"]
                    .as_array()
                    .is_none_or(|stages| stages.iter().any(|s| !s["assignment_id"].is_null()))
            {
                bail!("work run cannot use undispatched cancellation");
            }
            let active_assignments: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE run_id=?1 AND state!='abandoned')",
            [id],
            |r| r.get(0),
        )?;
            if active_assignments {
                bail!("work run has active assignments")
            }
            None
        };
        let revision = expected_revision + 1;
        row["revision"] = json!(revision);
        row["updated_at"] = json!(now());
        if let Some(ids) = &settled {
            row["resolution"] = json!({"action":"cancel_settled","request_id":request_id,"reason":reason,
                "previous_state":row["state"],"previous_waiting_reason":row["waiting_reason"],"at":row["updated_at"],
                "actor":{"kind":"human","id":"local_owner"},"stop_basis":"settled_assignments","assignment_ids":ids});
        }
        row["state"] = json!("cancelled");
        row["waiting_reason"] = Value::Null;
        if settled.is_none() {
            for stage in row["stages"].as_array_mut().unwrap() {
                stage["state"] = json!("cancelled");
            }
        }
        let result = serde_json::to_string(&row)?;
        tx.execute(
            "UPDATE work_runs SET revision=?2,state='cancelled',body=?3 WHERE id=?1",
            params![id, revision, result],
        )?;
        tx.execute(
            "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
            params![id, request_id, request, result],
        )?;
        let mut event = json!({"kind":"work_run_cancelled","request_id":request_id,"revision":revision,"at":row["updated_at"],"actor":{"kind":"human","id":"local_owner"},"stop_basis":if settled.is_some() { "settled_assignments" } else { "never_dispatched" }});
        if settled.is_some() {
            event["resolution"] = row["resolution"].clone();
        }
        tx.execute(
            "INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
            params![id, serde_json::to_string(&event)?],
        )?;
        tx.commit()?;
        Ok(row)
    }
    pub fn work_run_events(&self, id: &str, after: u64) -> Result<Value> {
        if !valid_id(id) || after > i64::MAX as u64 {
            bail!("invalid work run cursor");
        }
        let db = self.db.lock();
        let mut q = db.prepare("SELECT seq,body FROM work_run_events WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT 200")?;
        let rows = q.query_map(params![id, after], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut events = Vec::new();
        let mut cursor = after;
        for row in rows {
            let (seq, body) = row?;
            cursor = seq;
            events.push(json!({"seq":seq,"data":serde_json::from_str::<Value>(&body)?}));
        }
        Ok(json!({"events":events,"next_cursor":cursor}))
    }
}
