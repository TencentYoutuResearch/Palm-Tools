use super::*;
fn spec() -> Value {
    json!({"name":"Fixture","purpose":"Test","kind":"coordinator","workspace_refs":[],"execution_targets":[],"workers":[],"coordinator_targets":[],"workflow_pack_refs":[],"grant_id":null,"budget_policy_id":null,"scheduling_policy_id":null,"limits":{"max_active_assignments":1,"max_active_runs":1},"proactive_mode":"off"})
}
fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("hub.sqlite"), "local").unwrap();
    store
        .save_team(
            serde_json::from_value(
                json!({"id":"team","request_id":"create","expected_revision":0,"spec":spec()}),
            )
            .unwrap(),
        )
        .unwrap();
    (dir, store)
}
fn input() -> Create {
    serde_json::from_value(json!({"draft_id":"opt","request_id":"confirm","team_revision":1,"purpose":"Improve design"})).unwrap()
}
#[test]
fn immutable_owner_target_and_stale_cas() {
    let (_dir, store) = setup();
    let receipt = store.create_builder_optimization("team", input()).unwrap();
    assert_eq!(receipt["model_started"], false);
    assert!(receipt["draft"]["interview"]["proposed_team"].is_null());
    assert_eq!(
        store.create_builder_optimization("team", input()).unwrap(),
        receipt
    );
    assert!(store.create_builder_optimization("other", input()).is_err());
    let draft = store.builder_draft("opt").unwrap().unwrap();
    assert_eq!(draft["optimization_target"]["status"], "current");
    assert!(draft["optimization_target"]["baseline_spec"]
        .get("conversation_id")
        .is_none());
    let mut interview = draft["interview"].clone();
    interview["proposed_team"] = spec();
    store.save_builder_draft(serde_json::from_value(json!({"id":"opt","request_id":"edit","expected_revision":1,"revoked":false,"interview":interview})).unwrap()).unwrap();
    let accept = |team: &str, revision: u64, request: &str| {
        serde_json::from_value(json!({"request_id":request,"expected_revision":2,"team_id":team,"team_revision":revision})).unwrap()
    };
    assert!(store
        .accept_builder_proposal("opt", accept("other", 0, "bad"))
        .is_err());
    assert!(store
        .accept_builder_proposal("opt", accept("team", 0, "bad-revision"))
        .is_err());
    let accepted = store
        .accept_builder_proposal("opt", accept("team", 1, "accept"))
        .unwrap();
    assert_eq!(accepted["activation_performed"], false);
    assert_eq!(
        store.builder_draft("opt").unwrap().unwrap()["optimization_target"]["status"],
        "stale"
    );
    assert_eq!(
        store
            .accept_builder_proposal("opt", accept("team", 1, "accept"))
            .unwrap(),
        accepted
    );
    assert!(store
        .accept_builder_proposal("opt", accept("team", 1, "another"))
        .unwrap_err()
        .to_string()
        .contains("stale"));
    assert_eq!(
        store.create_builder_optimization("team", input()).unwrap(),
        receipt
    );
}
#[test]
fn unknown_stale_and_existing_drafts_are_rejected_and_filter_recovers_bound_draft() {
    let (_dir, store) = setup();
    assert!(store
        .create_builder_optimization("missing", input())
        .is_err());
    let mut stale = input();
    stale.team_revision = 2;
    assert!(store.create_builder_optimization("team", stale).is_err());
    store.create_builder_optimization("team", input()).unwrap();
    let page = store
        .builder_drafts(serde_json::from_value(json!({"team_id":"team","limit":1})).unwrap())
        .unwrap();
    assert_eq!(page["items"][0]["id"], "opt");
    assert!(page["items"][0]["optimization_target"]
        .get("baseline_spec")
        .is_none());
    let mut conflict = input();
    conflict.purpose = "Changed confirmation".into();
    assert!(store.create_builder_optimization("team", conflict).is_err());
    let mut forbidden = json!({"id":"opt","request_id":"change","expected_revision":1,"revoked":false,"interview":{},"optimization_target":{"team_id":"other"}});
    assert!(serde_json::from_value::<super::super::Save>(forbidden.take()).is_err());
}

#[test]
fn preexisting_draft_cannot_be_bound_and_ordinary_creation_still_works() {
    let (_dir, store) = setup();
    let save = json!({"id":"opt","request_id":"confirm","expected_revision":0,"revoked":false,
        "interview":{"purpose":"Improve design","workspace_refs":[],"answers":{},"questions":[],"proposed_team":null}});
    store
        .save_builder_draft(serde_json::from_value(save).unwrap())
        .unwrap();
    assert!(store
        .create_builder_optimization("team", input())
        .unwrap_err()
        .to_string()
        .contains("new draft"));
    assert!(store
        .builder_draft("opt")
        .unwrap()
        .unwrap()
        .get("optimization_target")
        .is_none());
    let save = json!({"id":"ordinary","request_id":"create","expected_revision":0,"revoked":false,
        "interview":{"purpose":"Create team","workspace_refs":[],"answers":{},"questions":[],"proposed_team":spec()}});
    store
        .save_builder_draft(serde_json::from_value(save).unwrap())
        .unwrap();
    let accept = serde_json::from_value(
        json!({"request_id":"accept","expected_revision":1,"team_id":"new-team","team_revision":0}),
    )
    .unwrap();
    let accepted = store.accept_builder_proposal("ordinary", accept).unwrap();
    assert_eq!(accepted["team"]["id"], "new-team");
    assert_eq!(accepted["activation_performed"], false);
}
