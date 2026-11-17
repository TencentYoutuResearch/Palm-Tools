//! Read-only provenance, never a target binding or an execution grant.
use anyhow::Result;
use rusqlite::Connection;
use serde_json::{json, Value};

// Use the same fail-closed predicate for filtering and projection. Invalid historical
// events cannot invent a relationship or cause a filtered page to contain unknowns.
pub(super) const ACCEPTED: &str = "CASE WHEN json_valid(e.body) THEN
    json_extract(e.body,'$.kind')='builder_proposal_accepted'
    AND json_extract(e.body,'$.actor.kind')='human'
    AND json_extract(e.body,'$.actor.id')='local_owner'
    AND length(e.team_id) BETWEEN 1 AND 160 AND e.team_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND json_type(e.body,'$.draft_id')='text'
    AND length(json_extract(e.body,'$.draft_id')) BETWEEN 1 AND 160
    AND json_extract(e.body,'$.draft_id') NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND json_type(e.body,'$.request_id')='text'
    AND length(json_extract(e.body,'$.request_id')) BETWEEN 1 AND 160
    AND json_extract(e.body,'$.request_id') NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND json_type(e.body,'$.team_revision')='integer' AND json_extract(e.body,'$.team_revision')>0
    AND json_type(e.body,'$.draft_revision')='integer' AND json_extract(e.body,'$.draft_revision')>0
    ELSE 0 END";

pub(super) fn enrich(db: &Connection, draft: &mut Value) -> Result<()> {
    let id = draft["id"].as_str().unwrap_or("");
    let mut query = db.prepare(&format!(
        "SELECT e.team_id,e.body FROM team_events e
        WHERE ({ACCEPTED}) AND json_extract(CASE WHEN json_valid(e.body) THEN e.body ELSE '{{}}' END,'$.draft_id')=?1 ORDER BY e.seq DESC LIMIT 101"
    ))?;
    let mut links = query
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .map(|row| {
            let (team_id, body) = row?;
            let event: Value = serde_json::from_str(&body)?;
            Ok(
                json!({"team_id":team_id,"team_revision":event["team_revision"],
                "draft_revision":event["draft_revision"],"request_id":event["request_id"],
                "source":"owner_acceptance"}),
            )
        })
        .collect::<Result<Vec<Value>>>()?;
    let truncated = links.len() > 100;
    links.truncate(100);
    draft["team_link_status"] = json!(if links.is_empty() {
        "unknown"
    } else {
        "accepted"
    });
    draft["team_links"] = json!(links);
    draft["team_links_truncated"] = json!(truncated);
    Ok(())
}

#[cfg(test)]
#[path = "builder_team_links_tests.rs"]
mod tests;
