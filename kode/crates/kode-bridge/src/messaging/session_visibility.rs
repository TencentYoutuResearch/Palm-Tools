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

/// Mobile groups by cwd, while desktop groups by the durable workspace account.
/// Keep execution cwd separately in the cloud DTO so older monitors also follow
/// workspace moves and worktree parent groups without rewriting session logs.
pub(crate) fn project_mobile_workspaces(
    snapshots: &mut [Value],
    workspaces: &Value,
    index: &Value,
) {
    let Some(table) = workspaces.pointer("/value/tables/workspaces").and_then(Value::as_object) else {
        return;
    };
    let parents = index.pointer("/value/worktreeParents");
    let mut projects = std::collections::HashMap::new();
    for (id, workspace) in table {
        let mut root = id.as_str();
        let mut seen = HashSet::from([root]);
        while let Some(parent) = parents.and_then(|rows| rows[root].as_str()) {
            if !table.contains_key(parent) || !seen.insert(parent) {
                break;
            }
            root = parent;
        }
        let Some(path) = table[root]["path"].as_str().filter(|path| !path.is_empty()) else {
            continue;
        };
        for session in workspace["sessionIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            projects.insert(session, (root, path));
        }
    }
    for snapshot in snapshots {
        let dto = &mut snapshot["dto"];
        if dto["runtime"] != "dsh" {
            continue;
        }
        let project = dto["runtime_session_id"].as_str()
            .or_else(|| dto["session_uuid"].as_str())
            .and_then(|id| projects.get(id));
        if let Some((id, path)) = project {
            if dto.get("execution_cwd").is_none() {
                dto["execution_cwd"] = dto["cwd"].clone();
            }
            dto["cwd"] = Value::from(*path);
            dto["workspace_id"] = Value::from(*id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mobile_uses_current_workspace_and_worktree_parent_without_changing_execution_paths() {
        let workspaces = json!({"value":{"tables":{"workspaces":{
            "project":{"path":"/projects/kode","sessionIds":["restored"]},
            "tree":{"path":"/worktrees/feature","sessionIds":["worktree"]},
            "broken":{"path":"/projects/other","sessionIds":["orphan"]}
        }}}});
        let index = json!({"value":{"worktreeParents":{"tree":"project","broken":"missing"}}});
        let original = vec![
            json!({"local_id":1,"dto":{"runtime":"dsh","runtime_session_id":"restored","cwd":"/deleted/kode"}}),
            json!({"local_id":2,"dto":{"runtime":"dsh","runtime_session_id":"worktree","cwd":"/worktrees/feature"}}),
            json!({"local_id":3,"dto":{"runtime":"dsh","session_uuid":"orphan","cwd":"/projects/other"}}),
            json!({"local_id":4,"dto":{"runtime":"dsh","runtime_session_id":"unassigned","cwd":"/unassigned"}}),
            json!({"local_id":5,"dto":{"runtime":"gui","runtime_session_id":"restored","cwd":"/native"}}),
        ];
        let mut mobile = original.clone();
        project_mobile_workspaces(&mut mobile, &workspaces, &index);
        for session in &mobile[..2] {
            assert_eq!(session["dto"]["cwd"], "/projects/kode");
            assert_eq!(session["dto"]["workspace_id"], "project");
        }
        assert_eq!(mobile[0]["dto"]["execution_cwd"], "/deleted/kode");
        assert_eq!(mobile[1]["dto"]["execution_cwd"], "/worktrees/feature");
        assert_eq!(mobile[2]["dto"]["cwd"], "/projects/other");
        assert_eq!(mobile[3], original[3]);
        assert_eq!(mobile[4], original[4]);
        assert_eq!(original[0]["dto"]["cwd"], "/deleted/kode");
        project_mobile_workspaces(&mut mobile, &workspaces, &index);
        assert_eq!(mobile[0]["dto"]["execution_cwd"], "/deleted/kode");
        project_mobile_workspaces(&mut mobile, &json!({"value":null}), &index);
        assert_eq!(mobile[0]["dto"]["cwd"], "/projects/kode");
    }

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
