//! Immutable graph revisions. Publication is storage, not activation or permission.
use super::{
    model::{now, valid_id},
    store::Store,
    workflows::{self, Pack},
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn canonical(mut pack: Pack) -> Result<String> {
    // All these arrays represent sets; their presentation order has no execution meaning.
    pack.inputs.sort();
    pack.completion_stages.sort();
    pack.stages.sort_by(|a, b| a.id.cmp(&b.id));
    for stage in &mut pack.stages {
        stage.requires.sort();
        stage.produces.sort();
        stage.independent_from.sort();
        if let Some(scope) = &mut stage.execution {
            scope.dependencies.sort_by(|a, b| a.id.cmp(&b.id));
            scope.tools.sort();
            scope
                .capabilities
                .sort_by_cached_key(|c| serde_json::to_string(c).unwrap());
        }
    }
    for rule in pack.evidence_rules.values_mut() {
        if let workflows::EvidenceRule::Verification {
            required_scenarios, ..
        } = rule
        {
            required_scenarios.sort();
        }
    }
    // Fixed typed serialization; domain/version prefix prevents schema reinterpretation.
    Ok(format!(
        "{}\n{}",
        pack.hash_format(),
        serde_json::to_string(&pack)?
    ))
}
impl Store {
    pub fn save_workflow(&self, pack: Pack) -> Result<Value> {
        let preflight = workflows::validate(&pack)?;
        let canonical = canonical(pack.clone())?;
        let hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT canonical,body FROM workflow_versions WHERE id=?1 AND version=?2",
                params![pack.id, pack.version],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((previous, body)) = prior {
            if previous != canonical {
                bail!("workflow version is immutable");
            }
            return Ok(serde_json::from_str(&body)?);
        }
        let row = json!({"schema_version":1,"id":pack.id,"version":pack.version,"hash":hash,
            "hash_format":pack.hash_format(),"home_hub":self.node_id,"created_at":now(),
            "actor":{"kind":"human","id":"local_owner"},"pack":pack,
            "topological_order":preflight["topological_order"],"eligible_for_execution":false});
        let body = serde_json::to_string(&row)?;
        tx.execute(
            "INSERT INTO workflow_versions(id,version,hash,canonical,body) VALUES (?1,?2,?3,?4,?5)",
            params![pack.id, pack.version, hash, canonical, body],
        )?;
        tx.execute(
            "INSERT INTO workflow_events(workflow_id,body) VALUES (?1,?2)",
            params![pack.id, body],
        )?;
        tx.commit()?;
        Ok(row)
    }
    pub fn workflow(&self, id: &str, version: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(version) {
            bail!("invalid workflow reference");
        }
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT body FROM workflow_versions WHERE id=?1 AND version=?2",
                params![id, version],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|body| Ok(serde_json::from_str(&body)?))
            .transpose()
    }
    pub fn workflow_events(&self, id: &str, after: u64) -> Result<Value> {
        if !valid_id(id) || after > i64::MAX as u64 {
            bail!("invalid workflow event cursor");
        }
        let db = self.db.lock();
        let mut query = db.prepare("SELECT seq,body FROM workflow_events WHERE workflow_id=?1 AND seq>?2 ORDER BY seq LIMIT 200")?;
        let rows = query.query_map(params![id, after], |r| {
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
