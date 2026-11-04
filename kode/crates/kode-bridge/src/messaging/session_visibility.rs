//! Archive visibility is independent of runtime liveness and retained history.
use serde_json::Value;
use std::collections::HashSet;

/// Apply the shared workspace archive index without deleting runtime records.
/// GUI adapters also use this against older running backends during upgrades.
pub fn filter_visible_runtime_sessions(result: &mut Value, workspaces: &Value) {
    let archived: HashSet<_> = workspaces
        .pointer("/value/global/archivedSessionIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if let Some(rows) = result["sessions"].as_array_mut() {
        rows.retain(|row| {
            row["runtime"] != "dsh"
                || !row["runtime_session_id"]
                    .as_str()
                    .is_some_and(|id| archived.contains(id))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn archive_hides_live_and_cold_dsh_rows_and_unarchive_restores_identity() {
        let original = json!({"sessions":[
            {"id":1,"runtime":"dsh","runtime_session_id":"session-a","status":"busy"},
            {"id":2,"runtime":"dsh","runtime_session_id":"session-b","runtime_online":false},
            {"id":3,"runtime":"dsh","runtime_session_id":"session-c"},
            {"id":4,"runtime":"gui","runtime_session_id":"session-a"}
        ],"runtimes":{"dsh":true}});
        let mut visible = original.clone();
        filter_visible_runtime_sessions(
            &mut visible,
            &json!({"value":{"global":{"archivedSessionIds":["session-a","session-b"]}}}),
        );
        assert_eq!(
            visible["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert_eq!(visible["runtimes"], original["runtimes"]);
        let mut restored = original.clone();
        filter_visible_runtime_sessions(
            &mut restored,
            &json!({"value":{"global":{"archivedSessionIds":[]}}}),
        );
        assert_eq!(restored, original);
    }
}
