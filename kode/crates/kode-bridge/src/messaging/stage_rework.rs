//! Invalidate the configured target and descendants, retaining every superseded attempt.
use super::workflows::Pack;
use anyhow::{bail, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeSet;
pub(super) fn apply(
    db: &Connection,
    run: &mut Value,
    pack: &Pack,
    stage_id: &str,
    assignment_id: &str,
    at: u64,
) -> Result<Value> {
    let stage = pack
        .stages
        .iter()
        .find(|stage| stage.id == stage_id)
        .unwrap();
    let rule = stage
        .on_reject
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("frozen rework rule required"))?;
    let previous = run["reworks"].as_array().map_or(0, |rows| {
        rows.iter()
            .filter(|row| row["stage_id"] == stage_id && row["scheduled"] == true)
            .count()
    });
    if previous >= usize::from(rule.max_reworks) {
        run["state"] = json!("waiting_user");
        run["waiting_reason"] = json!("rework_limit_exhausted");
        return Ok(
            json!({"scheduled":false,"stage_id":stage_id,"target":rule.target,"count":previous,"reason":"rework_limit_exhausted"}),
        );
    }
    let mut affected = BTreeSet::from([rule.target.clone()]);
    loop {
        let before = affected.len();
        for stage in &pack.stages {
            if stage
                .requires
                .iter()
                .any(|dependency| affected.contains(dependency))
            {
                affected.insert(stage.id.clone());
            }
        }
        if affected.len() == before {
            break;
        }
    }
    let mut snapshots = Vec::new();
    for state in run["stages"].as_array().unwrap() {
        if !affected.contains(state["stage_id"].as_str().unwrap()) {
            continue;
        }
        if let Some(id) = state["assignment_id"].as_str() {
            if id != assignment_id {
                let status: String = db.query_row(
                    "SELECT state FROM work_assignments WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )?;
                if status != "completed" && status != "abandoned" {
                    bail!("rework requires affected Assignments to be drained");
                }
            }
        }
        snapshots.push(state.clone());
    }
    let evidence = run["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|state| state["stage_id"] == stage_id)
        .unwrap()["evidence"]
        .clone();
    let mut outputs = serde_json::Map::new();
    for (output, sequence) in evidence["outputs"].as_object().unwrap() {
        let body: String = db.query_row(
            "SELECT body FROM operation_events WHERE seq=?1",
            [sequence.as_u64()],
            |row| row.get(0),
        )?;
        let event: Value = serde_json::from_str(&body)?;
        outputs.insert(
            output.clone(),
            json!({"sequence":sequence,"payload":event["evidence"]["payload"]}),
        );
    }
    let receipt = json!({"scheduled":true,"stage_id":stage_id,"assignment_id":assignment_id,"target":rule.target,
        "count":previous+1,"at":at,"evidence":evidence,"outputs":outputs,"superseded":snapshots,"affected":affected});
    if run["reworks"].is_null() {
        run["reworks"] = json!([]);
    }
    run["reworks"].as_array_mut().unwrap().push(receipt.clone());
    for state in run["stages"].as_array_mut().unwrap() {
        if affected.contains(state["stage_id"].as_str().unwrap()) {
            *state = json!({"stage_id":state["stage_id"],"state":"pending","attempt":state["attempt"],"assignment_id":null});
        }
    }
    run["waiting_reason"] = json!("rework_dispatch_pending");
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejection_preserves_history_and_blocks_active_descendants_or_exhausted_policy() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE operation_events(seq INTEGER, body TEXT); INSERT INTO operation_events VALUES (2,'{\"evidence\":{\"payload\":{\"kind\":\"review\",\"verdict\":\"failed\",\"findings\":[]}}}'); CREATE TABLE work_assignments(id TEXT,state TEXT); INSERT INTO work_assignments VALUES ('build-a','completed'),('verify-a','prepared');").unwrap();
        let pack: Pack = serde_json::from_value(json!({"id":"flow","version":"1","inputs":["request"],"completion_stages":["verify"],"stages":[
            {"id":"build","role":"builder","requires":["request"],"produces":["code"],"independent_from":[]},
            {"id":"review","role":"reviewer","requires":["build"],"produces":["reviewed"],"independent_from":["build"],"on_reject":{"target":"build","max_reworks":1}},
            {"id":"verify","role":"verifier","requires":["review"],"produces":["verified"],"independent_from":[]}
        ]})).unwrap();
        let mut run = json!({"state":"running","stages":[
            {"stage_id":"build","state":"passed","attempt":1,"assignment_id":"build-a","evidence":{"outputs":{"code":1}}},
            {"stage_id":"review","state":"rejected","attempt":1,"assignment_id":"review-a","evidence":{"outcome":"rejected","outputs":{"reviewed":2}}},
            {"stage_id":"verify","state":"ready","attempt":1,"assignment_id":"verify-a"}
        ]});
        let original = run.clone();
        assert!(apply(&db, &mut run, &pack, "review", "review-a", 1)
            .unwrap_err()
            .to_string()
            .contains("drained"));
        assert_eq!(run, original);
        db.execute(
            "UPDATE work_assignments SET state='completed' WHERE id='verify-a'",
            [],
        )
        .unwrap();
        let result = apply(&db, &mut run, &pack, "review", "review-a", 2).unwrap();
        assert_eq!(result["superseded"], original["stages"]);
        assert!(run["stages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["state"] == "pending" && s["attempt"] == 1 && s["assignment_id"].is_null()));
        let saved = run["reworks"].clone();
        let exhausted = apply(&db, &mut run, &pack, "review", "review-b", 3).unwrap();
        assert_eq!(exhausted["scheduled"], false);
        assert_eq!(run["state"], "waiting_user");
        assert_eq!(run["waiting_reason"], "rework_limit_exhausted");
        assert_eq!(run["reworks"], saved);
    }
    #[test]
    fn zero_reworks_waits_without_sql_baseline_invalidation_or_another_attempt() {
        // Empty DB deliberately has no assignment/event/outbox/budget tables:
        // zero retry must not read/write them or acquire further execution.
        let db = Connection::open_in_memory().unwrap();
        let pack: Pack = serde_json::from_value(json!({"id":"bugfix","version":"1","inputs":["request"],"completion_stages":["diagnose"],"stages":[
            {"id":"baseline","role":"author","requires":["request"],"produces":["base"],"independent_from":[]},
            {"id":"diagnose","role":"verifier","requires":["baseline"],"produces":["reproduction"],"independent_from":["baseline"],"on_reject":{"target":"baseline","max_reworks":0}}
        ]})).unwrap();
        super::super::workflows::validate(&pack).unwrap();
        let mut run = json!({"state":"running","stages":[
            {"stage_id":"baseline","state":"passed","attempt":1,"assignment_id":"baseline-a","evidence":{"outputs":{"base":1}}},
            {"stage_id":"diagnose","state":"rejected","attempt":1,"assignment_id":"diagnose-a","evidence":{"outcome":"rejected","outputs":{"reproduction":2}}}
        ],"reworks":[],"budget":{"spent":12,"reserved":0},"task_workspaces":{"code":{"key":"fixed-baseline"}}});
        let before = run.clone();
        let receipt = apply(&db,&mut run,&pack,"diagnose","diagnose-a",3).unwrap();
        assert_eq!(receipt,json!({"scheduled":false,"stage_id":"diagnose","target":"baseline","count":0,"reason":"rework_limit_exhausted"}));
        assert_eq!(run["state"],"waiting_user");
        assert_eq!(run["waiting_reason"],"rework_limit_exhausted");
        assert_eq!(run["stages"],before["stages"],"baseline/evidence/attempt identities remain exact");
        assert_eq!(run["reworks"],before["reworks"]);
        assert_eq!(run["task_workspaces"],before["task_workspaces"]);
        assert_eq!(run["budget"],before["budget"]);
        let changes: i64 = db.query_row("SELECT total_changes()", [], |row| row.get(0)).unwrap();
        assert_eq!(changes,0,"no assignment/event/resource/budget SQL writes");
    }

}
