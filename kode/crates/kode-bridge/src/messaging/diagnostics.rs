//! Session-scoped cold diagnostics. No content, tokens, network probe or runtime resume.
use super::store::Store;
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
fn messages(db: &Connection, node: &str, session: &str, incoming: bool) -> Result<Value> {
    let predicate = if incoming {
        "target_node=?1 AND target_session=?2"
    } else {
        "source_node=?1 AND source_session=?2"
    };
    let sql=format!("SELECT json_extract(body,'$.status'),COUNT(*) FROM messages WHERE {predicate} GROUP BY json_extract(body,'$.status')");
    let mut query = db.prepare(&sql)?;
    let counts = query
        .query_map(params![node, session], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })?
        .collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>()?;
    let sql=format!("SELECT id,json_extract(body,'$.status'),json_extract(body,'$.created_at'),json_extract(body,'$.expires_at') FROM messages WHERE {predicate} AND json_extract(body,'$.status')!='accepted' ORDER BY rowid LIMIT 10");
    let mut query = db.prepare(&sql)?;
    let samples=query.query_map(params![node,session],|r|Ok(json!({"message_id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"created_at":r.get::<_,u64>(2)?,"expires_at":r.get::<_,u64>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let nonaccepted: u64 = counts
        .iter()
        .filter(|(key, _)| key.as_str() != "accepted")
        .map(|(_, n)| *n)
        .sum();
    Ok(
        json!({"counts":counts,"samples":samples,"samples_truncated":nonaccepted>samples.len() as u64}),
    )
}
impl Store {
    pub fn session_diagnostics(&self, session: &str, at: u64) -> Result<Value> {
        let db = self.db.lock();
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
            [session],
            |r| r.get(0),
        )?;
        if !exists {
            bail!("unknown diagnostic session")
        }
        let incoming = messages(&db, &self.node_id, session, true)?;
        let outgoing = messages(&db, &self.node_id, session, false)?;
        let mut query = db.prepare(
            "SELECT phase,COUNT(*) FROM runtime_deliveries WHERE session=?1 GROUP BY phase",
        )?;
        let phases = query
            .query_map([session], |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, u64>(1)?))
            })?
            .collect::<rusqlite::Result<std::collections::BTreeMap<_, _>>>()?;
        let cancellations: u64 = db.query_row(
            "SELECT COUNT(*) FROM input_cancellations WHERE session=?1 AND pending=1",
            [session],
            |r| r.get(0),
        )?;
        Ok(
            json!({"node_id":self.node_id,"session_id":session,"observed_at":at,"scope":"local_durable_session_state","incoming":incoming,"outgoing":outgoing,"delivery_evidence":{"prepared":phases.get(&0).copied().unwrap_or(0),"queued":phases.get(&1).copied().unwrap_or(0),"consumed":phases.get(&2).copied().unwrap_or(0)},"pending_cancellations":cancellations,"runtime_liveness":"not_probed","peer_connectivity":"not_probed","limitations":["accepted_is_not_consumed","missing_evidence_is_not_nonexecution","queue_empty_is_not_health","remote_authority_not_probed"]}),
        )
    }
}
