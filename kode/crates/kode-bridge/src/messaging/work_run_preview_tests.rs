use super::*;

fn task_run(version: u8) -> Value {
    let task = "preview-task";
    let revision = if version == 1 { "task_revision" } else { "execution_revision" };
    let frozen = json!({
        "format":format!("kode.collaboration.task-context.v{version}"),
        "task_id":task,"context_id":format!("collaboration-task:{task}"),
        "team_id":"team","scope":{"home_hub":"home","host_id":"host","workspace_id":"workspace","root_ref":"root"},
        revision:1,"summary":"Fix the session avatar","published_commands":[]
    });
    let mut run = json!({
        "id":format!("task-run-{:x}",Sha256::digest(task.as_bytes())),
        "team_id":"team","home_hub":"home",
        "collaboration":{
            "format":format!("kode.collaboration.work-source.v{version}"),
            "task_id":task,"context_id":frozen["context_id"],"scope":frozen["scope"],revision:1
        }
    });
    set_context(&mut run, frozen);
    run
}

fn set_context(run: &mut Value, frozen: Value) {
    let raw = serde_json::to_string(&frozen).unwrap();
    run["collaboration"]["context_sha256"] = json!(format!("{:x}", Sha256::digest(raw.as_bytes())));
    run["inputs"] = json!({"request":raw});
}

#[test]
fn typed_frozen_summaries_are_projected_for_both_source_versions() {
    for version in [1, 2] {
        let run = task_run(version);
        assert_eq!(request_preview(&run).as_deref(), Some("Fix the session avatar"));
    }
}

#[test]
fn mismatched_source_identity_scope_revision_and_hash_never_expose_context() {
    let mutations = [
        ("/collaboration/context_sha256", json!("0".repeat(64))),
        ("/collaboration/task_id", json!("other-task")),
        ("/collaboration/context_id", json!("collaboration-task:other-task")),
        ("/collaboration/scope/host_id", json!("other-host")),
        ("/collaboration/execution_revision", json!(2)),
        ("/collaboration/format", json!("unknown-source")),
        ("/id", json!("other-run")),
        ("/team_id", json!("other-team")),
        ("/home_hub", json!("other-home")),
    ];
    for (path, value) in mutations {
        let mut run = task_run(2);
        *run.pointer_mut(path).unwrap() = value;
        assert_eq!(request_preview(&run), None, "{path}");
    }
    for key in ["task_id", "context_id", "team_id", "scope", "execution_revision", "format"] {
        let mut run = task_run(2);
        let mut frozen: Value = serde_json::from_str(run["inputs"]["request"].as_str().unwrap()).unwrap();
        frozen[key] = json!("other");
        set_context(&mut run, frozen);
        assert_eq!(request_preview(&run), None, "rehashed {key}");
    }
}

#[test]
fn absent_summary_or_malformed_context_uses_generic_title_without_guessing() {
    for summary in [Value::Null, json!(""), json!("  "), json!({"private":"not a summary"})] {
        let mut run = task_run(2);
        let mut frozen: Value = serde_json::from_str(run["inputs"]["request"].as_str().unwrap()).unwrap();
        frozen["summary"] = summary;
        set_context(&mut run, frozen);
        assert_eq!(request_preview(&run), None);
    }
    for raw in ["{\"format\":\"kode.collaboration.task-context.v2\",".to_string(), "x".repeat(48001)] {
        let mut run = task_run(2);
        run["inputs"]["request"] = json!(raw);
        assert_eq!(request_preview(&run), None);
    }
}

#[test]
fn legacy_dm_preview_preserves_natural_language_and_user_json() {
    for raw in ["请检查构建结果", "[Bug] Fix avatar", r#"{"user":"JSON request"}"#] {
        assert_eq!(request_preview(&json!({"inputs":{"request":raw}})).as_deref(), Some(raw));
    }
    let raw = "请".repeat(300);
    assert_eq!(request_preview(&json!({"inputs":{"request":raw}})).unwrap().chars().count(), 240);
}
