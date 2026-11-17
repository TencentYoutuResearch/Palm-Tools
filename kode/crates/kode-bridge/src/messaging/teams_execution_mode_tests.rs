use super::*;

fn fixture() -> Value {
    json!({"name":"Interactive fixture","purpose":"Mode compatibility","kind":"coordinator",
        "workspace_refs":[],"execution_targets":[{"id":"native","host_id":"home","executor_profile_id":"original",
        "executor_profile_revision":"a".repeat(64),"provider_id":"native","model_id":"original-model","effort":null,
        "account_binding_id":"account","capability_profile_revision":"capability"}],
        "workers":[],"coordinator_targets":["native"],"workflow_pack_refs":[],
        "grant_id":null,"budget_policy_id":null,"scheduling_policy_id":null,
        "limits":{"max_active_assignments":1,"max_active_runs":1},"proactive_mode":"off"})
}
#[test]
fn execution_mode_legacy_bytes_and_null_are_unchanged() {
    let original = fixture();
    let typed: Spec = serde_json::from_value(original.clone()).unwrap();
    typed.validate().unwrap();
    assert_eq!(
        serde_json::to_vec(&typed).unwrap(),
        serde_json::to_vec(&serde_json::from_value::<Spec>(original.clone()).unwrap()).unwrap()
    );
    assert_eq!(serde_json::to_value(&typed).unwrap(), original);
    let mut null = original.clone();
    null["execution_mode"] = Value::Null;
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<Spec>(null).unwrap()).unwrap(),
        original
    );
    let mut bad = original;
    bad["execution_mode"] = json!("unlimited");
    assert!(serde_json::from_value::<Spec>(bad).is_err());
}
#[test]
fn execution_mode_native_optional_account_does_not_weaken_controlled_validation() {
    let mut raw = fixture();
    raw["execution_targets"][0]
        .as_object_mut()
        .unwrap()
        .remove("account_binding_id");
    raw["execution_targets"][0]
        .as_object_mut()
        .unwrap()
        .remove("capability_profile_revision");
    assert!(serde_json::from_value::<Spec>(raw.clone())
        .unwrap()
        .validate()
        .is_err());
    raw["execution_mode"] = json!("interactive_native");
    let typed: Spec = serde_json::from_value(raw.clone()).unwrap();
    typed.validate().unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), raw);
    raw["budget_policy_id"] = json!("budget");
    assert!(serde_json::from_value::<Spec>(raw.clone())
        .unwrap()
        .validate()
        .is_err());
    raw["budget_policy_id"] = Value::Null;
    for invalid in [Value::Null, json!("fake"), json!("A".repeat(64))] {
        raw["execution_targets"][0]["executor_profile_revision"] = invalid;
        assert!(serde_json::from_value::<Spec>(raw.clone())
            .unwrap()
            .validate()
            .is_err());
    }
}
#[test]
fn execution_mode_builder_accepts_but_controlled_activation_refuses() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(&root.path().join("fixture.sqlite"), "home").unwrap();
    let mut proposed = fixture();
    proposed["execution_mode"] = json!("interactive_native");
    proposed["execution_targets"][0]
        .as_object_mut()
        .unwrap()
        .remove("account_binding_id");
    proposed["execution_targets"][0]
        .as_object_mut()
        .unwrap()
        .remove("capability_profile_revision");
    store.save_builder_draft(serde_json::from_value(json!({"id":"draft","request_id":"candidate","expected_revision":0,"revoked":false,
        "interview":{"purpose":"Mode test","workspace_refs":[],"answers":{},"questions":[],"proposed_team":proposed}})).unwrap()).unwrap();
    let accepted = store.accept_builder_proposal("draft", serde_json::from_value(json!({"request_id":"accept","expected_revision":1,"team_id":"team","team_revision":0})).unwrap()).unwrap();
    assert_eq!(
        accepted["team"]["spec"]["execution_mode"],
        "interactive_native"
    );
    let result = store.change_team_activation("team", serde_json::from_value(json!({"action":"activate","request_id":"activate","expected_revision":0,"team_revision":1,"grant_revision":1,
        "budget_policy":{"id":"budget","revision":1,"hash":"a".repeat(64)},"scheduling_policy":{"id":"schedule","revision":1,"hash":"b".repeat(64)}})).unwrap());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("do not use controlled activation"));
    assert!(store.team_activation("team").unwrap().is_none());
}
