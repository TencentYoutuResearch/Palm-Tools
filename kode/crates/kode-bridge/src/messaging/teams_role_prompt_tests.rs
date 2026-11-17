use super::*;
fn spec() -> Value {
    json!({"name":"Fixture team","purpose":"Role prompt tests","kind":"coordinator","workspace_refs":[],"execution_targets":[],
        "workers":[{"id":"review","role":"review","responsibilities":["Review"],"allowed_target_ids":[],"required_capabilities":[],"workspace_refs":[],"max_parallel":1}],
        "coordinator_targets":[],"workflow_pack_refs":[],"grant_id":null,"budget_policy_id":null,"scheduling_policy_id":null,
        "limits":{"max_active_assignments":1,"max_active_runs":1},"proactive_mode":"off"})
}
#[test]
fn role_prompt_legacy_omission_and_null_canonicalize_without_changing_profiles() {
    let original = spec();
    let typed: Spec = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), original);
    assert!(typed.role_prompt_snapshot("home", "team", 1, None).unwrap().is_none());
    let mut empty = original.clone(); empty["coordinator_prompt"] = Value::Null; empty["workers"][0]["role_prompt"] = Value::Null;
    assert_eq!(serde_json::to_value(serde_json::from_value::<Spec>(empty).unwrap()).unwrap(), original);
}
#[test]
fn role_prompt_bytes_bounds_unknown_worker_and_snapshot_identity() {
    let mut raw = spec(); raw["coordinator_prompt"] = json!("Coordinate"); raw["workers"][0]["role_prompt"] = json!("Review only");
    let typed: Spec = serde_json::from_value(raw.clone()).unwrap(); typed.validate().unwrap();
    let snapshot = typed.role_prompt_snapshot("home", "team", 3, Some("review")).unwrap().unwrap();
    assert_eq!(snapshot["team_revision"], 3); assert_eq!(snapshot["role"], json!({"kind":"worker","worker_id":"review"}));
    assert_eq!(snapshot["sha256"], format!("{:x}", Sha256::digest(b"Review only")));
    assert!(typed.role_prompt_snapshot("home", "team", 3, Some("other")).is_err());
    assert!(typed.role_prompt_snapshot("home", "team", 0, None).is_err());
    for invalid in [" ".to_owned(), "x\0y".to_owned(), "汉".repeat(5334)] {
        raw["coordinator_prompt"] = json!(invalid);
        assert!(serde_json::from_value::<Spec>(raw.clone()).unwrap().validate_role_prompts().is_err());
    }
    raw["coordinator_prompt"] = json!("汉".repeat(5333));
    serde_json::from_value::<Spec>(raw).unwrap().validate_role_prompts().unwrap();
}
#[test]
fn role_prompt_owner_candidate_accept_and_revision_history_remain_explicit() {
    let root = tempfile::tempdir().unwrap(); let store = Store::open(&root.path().join("fixture.sqlite"), "home").unwrap();
    let mut proposed = spec(); proposed["coordinator_prompt"] = json!("Coordinate v1"); proposed["workers"][0]["role_prompt"] = json!("Review v1");
    let draft = store.save_builder_draft(serde_json::from_value(json!({"id":"draft","request_id":"candidate","expected_revision":0,"revoked":false,
        "interview":{"purpose":"Role prompt tests","workspace_refs":[],"answers":{},"questions":[],"proposed_team":proposed}})).unwrap()).unwrap();
    assert_eq!(draft["revision"], 1); assert!(store.team("team", None).unwrap().is_none());
    let request = json!({"request_id":"accept","expected_revision":1,"team_id":"team","team_revision":0});
    let accepted = store.accept_builder_proposal("draft", serde_json::from_value(request.clone()).unwrap()).unwrap();
    assert_eq!(accepted["activation_performed"], false); assert_eq!(accepted["eligible_for_execution"], false);
    assert_eq!(accepted, store.accept_builder_proposal("draft", serde_json::from_value(request).unwrap()).unwrap());
    let first = store.team("team", Some(1)).unwrap().unwrap();
    assert_eq!(first["spec"]["coordinator_prompt"], "Coordinate v1");
    proposed["coordinator_prompt"] = json!("Coordinate v2"); proposed["workers"][0]["role_prompt"] = json!("Review v2");
    let second = store.save_team(serde_json::from_value(json!({"id":"team","request_id":"edit","expected_revision":1,"spec":proposed})).unwrap()).unwrap();
    assert_eq!(second["revision"], 2); assert_eq!(second["status"], "draft"); assert_eq!(second["eligible_for_execution"], false);
    assert_eq!(store.team("team", Some(1)).unwrap().unwrap(), first);
    let old: Spec = serde_json::from_value(first["spec"].clone()).unwrap();
    assert_eq!(old.role_prompt_snapshot("home", "team", 1, Some("review")).unwrap().unwrap()["text"], "Review v1");
    assert!(store.save_team(serde_json::from_value(json!({"id":"team","request_id":"stale","expected_revision":1,"spec":spec()})).unwrap()).is_err());
}
