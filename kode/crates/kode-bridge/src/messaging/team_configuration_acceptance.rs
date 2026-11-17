//! Exact owner acceptance of saved configuration revisions; never activates execution.
use super::{
    model::{now, valid_id},
    store::Store,
    teams::Spec,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accept {
    pub request_id: String,
    pub expected_revision: u64,
    pub parent_accepted_revision: u64,
    pub spec: Value,
}
fn key(id: &str, request: &str) -> String {
    format!("team-configuration-acceptance:{}", json!([id, request]))
}
fn read(db: &Connection, key: &str) -> Result<Option<Value>> {
    let s: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    s.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn team(db: &Connection, id: &str, rev: u64) -> Result<Value> {
    let s: String = db.query_row(
        "SELECT body FROM team_revisions WHERE team_id=?1 AND revision=?2",
        params![id, rev],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&s)?)
}
// Only descriptive instructions and explicitly reviewed profile/model selection may change.
fn fixed(mut t: Value) -> Value {
    for k in ["revision", "updated_at"] {
        t.as_object_mut().unwrap().remove(k);
    }
    let s = t["spec"].as_object_mut().unwrap();
    for k in [
        "name",
        "purpose",
        "coordinator_prompt",
        "coordinator_targets",
        "execution_targets",
    ] {
        s.remove(k);
    }
    if let Some(Value::Array(workers)) = s.get_mut("workers") {
        for w in workers {
            for k in [
                "role",
                "responsibilities",
                "role_prompt",
                "allowed_target_ids",
            ] {
                w.as_object_mut().unwrap().remove(k);
            }
        }
    }
    t
}
fn compatible(parent: &Value, current: &Value) -> Result<()> {
    if fixed(parent.clone()) != fixed(current.clone()) {
        bail!("configuration authority changed")
    }
    let old: Spec = serde_json::from_value(parent["spec"].clone())?;
    let new: Spec = serde_json::from_value(current["spec"].clone())?;
    old.validate()?;
    new.validate()?;
    for prior in &old.execution_targets {
        let Some(target) = new.execution_targets.iter().find(|t| t.id == prior.id) else {
            bail!("existing target removed")
        };
        if target.host_id != prior.host_id
            || target.account_binding_id != prior.account_binding_id
            || target.capability_profile_revision != prior.capability_profile_revision
        {
            bail!("target authority changed")
        }
    }
    for target in &new.execution_targets {
        if !old.execution_targets.iter().any(|t| t.id == target.id)
            && (target.host_id != current["home_hub"].as_str().unwrap_or("")
                || !target.account_binding_id.is_empty()
                || !target.capability_profile_revision.is_empty())
        {
            bail!("new native target expands authority")
        }
    }
    Ok(())
}
fn event(r: &Value) -> Value {
    json!({"kind":"team_configuration_accepted","team_id":r["team"]["id"],"team_revision":r["team"]["revision"],"request_id":r["request"]["request_id"],"parent_accepted_revision":r["request"]["parent_accepted_revision"],"actor":r["actor"],"home_hub":r["home_hub"],"at":r["accepted_at"]})
}
/// Revalidate every immutable link, including its event, down to the original Builder receipt.
pub(super) fn proof(db: &Connection, home: &str, snapshot: &Value) -> Result<Value> {
    let mut current = snapshot.clone();
    let mut chain = Vec::new();
    loop {
        if chain.len() >= 64 {
            bail!("configuration lineage exceeds review limit")
        }
        let id = current["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing team id"))?;
        let revision = current["revision"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("missing revision"))?;
        if current["home_hub"] != home
            || current["owner"] != json!({"kind":"human","id":"local_owner"})
        {
            bail!("acceptance owner mismatch")
        }
        let mut q = db.prepare("SELECT body FROM team_events WHERE team_id=?1")?;
        let events = q
            .query_map([id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut next = None;
        for body in events {
            let e: Value = serde_json::from_str(&body)?;
            if e["team_revision"] != revision {
                continue;
            }
            if e["kind"] == "builder_proposal_accepted" {
                let k = format!("builder-accept:{}", json!([e["draft_id"], e["request_id"]]));
                if let Some(r) = read(db, &k)? {
                    if r["team"] == current
                        && r["home_hub"] == home
                        && r["actor"] == current["owner"]
                        && r["draft_id"] == e["draft_id"]
                        && r["draft_revision"] == e["draft_revision"]
                        && r["request"]["request_id"] == e["request_id"]
                        && e["actor"] == r["actor"]
                    {
                        for link in &chain {
                            if link != &r {
                                bail!("Builder lineage mismatch")
                            }
                        }
                        return Ok(r);
                    }
                }
            } else if e["kind"] == "team_configuration_accepted" {
                let Some(request) = e["request_id"].as_str() else {
                    continue;
                };
                if let Some(r) = read(db, &key(id, request))? {
                    let parent = r["request"]["parent_accepted_revision"]
                        .as_u64()
                        .unwrap_or(0);
                    if r["team"] != current
                        || r["home_hub"] != home
                        || r["actor"] != current["owner"]
                        || r["request"]["request_id"] != request
                        || r["request"]["expected_revision"] != revision
                        || r["request"]["spec"] != current["spec"]
                        || parent == 0
                        || parent >= revision
                        || r["activation_performed"] != false
                        || r["eligible_for_execution"] != false
                        || e != event(&r)
                    {
                        continue;
                    }
                    let p = team(db, id, parent)?;
                    compatible(&p, &current)?;
                    chain.push(r["builder_lineage"].clone());
                    next = Some(p);
                    break;
                }
            }
        }
        match next {
            Some(p) => current = p,
            None => bail!("interactive team requires owner accepted Builder revision"),
        }
    }
}
fn verify_receipt(db: &Connection, home: &str, id: &str, request: &str, r: &Value) -> Result<()> {
    if r["team"]["id"] != id
        || r["request"]["request_id"] != request
        || r["home_hub"] != home
        || r["actor"] != json!({"kind":"human","id":"local_owner"})
        || r["request"]["expected_revision"] != r["team"]["revision"]
        || r["request"]["spec"] != r["team"]["spec"]
        || r["activation_performed"] != false
        || r["eligible_for_execution"] != false
    {
        bail!("invalid configuration receipt")
    }
    let expected = event(r);
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM team_events WHERE team_id=?1 AND body=?2)",
        params![id, serde_json::to_string(&expected)?],
        |row| row.get(0),
    )?;
    if !exists || proof(db, home, &r["team"])? != r["builder_lineage"] {
        bail!("configuration receipt lineage mismatch")
    }
    Ok(())
}
impl Store {
    pub fn team_configuration_acceptance_request(
        &self,
        id: &str,
        request: &str,
    ) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(request) {
            bail!("invalid acceptance identity")
        }
        let db = self.db.lock();
        let r = read(&db, &key(id, request))?;
        if let Some(r) = &r {
            verify_receipt(&db, &self.node_id, id, request, r)?;
        }
        Ok(r)
    }
    pub fn team_configuration_acceptance_status(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            bail!("invalid team identity")
        }
        let db = self.db.lock();
        let rev: u64 =
            db.query_row("SELECT revision FROM teams WHERE id=?1", [id], |r| r.get(0))?;
        if rev > 256 {
            bail!("configuration history exceeds review limit")
        }
        let t = team(&db, id, rev)?;
        let accepted = proof(&db, &self.node_id, &t).is_ok();
        let mut builder_lineage = proof(&db, &self.node_id, &t).unwrap_or(Value::Null);
        let mut parent = None;
        for n in (1..rev).rev() {
            if proof(&db, &self.node_id, &team(&db, id, n)?).is_ok() {
                if !accepted {
                    builder_lineage = proof(&db, &self.node_id, &team(&db, id, n)?)?;
                }
                parent = Some(n);
                break;
            }
        }
        let mut receipt = Value::Null;
        if accepted {
            let mut q = db.prepare("SELECT body FROM team_events WHERE team_id=?1")?;
            for s in q.query_map([id], |r| r.get::<_, String>(0))? {
                let e: Value = serde_json::from_str(&s?)?;
                if e["team_revision"] == rev && e["kind"] == "team_configuration_accepted" {
                    if let Some(request) = e["request_id"].as_str() {
                        if let Some(r) = read(&db, &key(id, request))? {
                            if r["team"] == t && e == event(&r) {
                                receipt = r;
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(
            json!({"team_id":id,"team_revision":rev,"accepted":accepted,"parent_accepted_revision":parent,"receipt":receipt,"builder_lineage":builder_lineage}),
        )
    }
    pub fn accept_team_configuration(&self, id: &str, input: Accept) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.parent_accepted_revision == 0
            || input.parent_accepted_revision >= input.expected_revision
        {
            bail!("invalid configuration acceptance")
        }
        let spec: Spec = serde_json::from_value(input.spec.clone())?;
        spec.validate()?;
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(r) = read(&tx, &key(id, &input.request_id))? {
            if r["request"] != request {
                bail!("acceptance request conflict")
            }
            verify_receipt(&tx, &self.node_id, id, &input.request_id, &r)?;
            return Ok(r);
        }
        let rev: u64 =
            tx.query_row("SELECT revision FROM teams WHERE id=?1", [id], |r| r.get(0))?;
        if rev > 256 {
            bail!("configuration history exceeds review limit")
        }
        if rev != input.expected_revision {
            bail!("team revision conflict")
        }
        let t = team(&tx, id, rev)?;
        if t["spec"] != input.spec || t["spec"]["execution_mode"] != "interactive_native" {
            bail!("exact interactive configuration required")
        }
        let p = team(&tx, id, input.parent_accepted_revision)?;
        compatible(&p, &t)?;
        let lineage = proof(&tx, &self.node_id, &p)?;
        for n in input.parent_accepted_revision + 1..=rev {
            if proof(&tx, &self.node_id, &team(&tx, id, n)?).is_ok() {
                bail!("accepted parent is stale")
            }
        }
        let r = json!({"request":request,"team":t,"builder_lineage":lineage,"home_hub":self.node_id,"actor":{"kind":"human","id":"local_owner"},"accepted_at":now(),"activation_performed":false,"eligible_for_execution":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(id, &input.request_id), serde_json::to_string(&r)?],
        )?;
        tx.execute(
            "INSERT INTO team_events(team_id,body) VALUES (?1,?2)",
            params![id, serde_json::to_string(&event(&r))?],
        )?;
        proof(&tx, &self.node_id, &r["team"])?;
        tx.commit()?;
        Ok(r)
    }
}
