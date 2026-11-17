use crate::messaging::store::Store;
use serde_json::{json, Value};

fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("hub.sqlite"), "local").unwrap();
    for id in ["a", "b", "c", "d"] {
        store.save_builder_draft(serde_json::from_value(json!({"id":id,"request_id":"create","expected_revision":0,"revoked":false,
            "interview":{"purpose":"Same title","workspace_refs":[],"answers":{},"questions":[],"proposed_team":null}})).unwrap()).unwrap();
    }
    (dir, store)
}
fn event(store: &Store, team: &str, draft: &str, revision: u64) {
    let value = json!({"kind":"builder_proposal_accepted","draft_id":draft,"draft_revision":1,
        "team_revision":revision,"request_id":format!("accept-{revision}"),"actor":{"kind":"human","id":"local_owner"}});
    store
        .db
        .lock()
        .execute(
            "INSERT INTO team_events(team_id,body) VALUES (?1,?2)",
            rusqlite::params![team, value.to_string()],
        )
        .unwrap();
}
fn page(store: &Store, team: Option<&str>, after: &str, limit: usize) -> Value {
    store
        .builder_drafts(
            serde_json::from_value(json!({"team_id":team,"after":after,"limit":limit})).unwrap(),
        )
        .unwrap()
}
#[test]
fn links_are_read_only_revision_specific_and_unknown_without_acceptance() {
    let (_dir, store) = fixture();
    // Even a legacy/model-supplied proposal naming a team is not provenance.
    store.db.lock().execute("UPDATE builder_draft_revisions SET body=json_set(body,'$.interview.proposed_team',json(?1)) WHERE id='a'",
        [r#"{"id":"team-1","title":"Same title"}"#]).unwrap();
    event(&store, "team-1", "b", 1);
    event(&store, "team-1", "b", 2);
    event(&store, "team-2", "b", 1);
    let draft = store.builder_draft("b").unwrap().unwrap();
    assert_eq!(draft["team_links"].as_array().unwrap().len(), 3);
    assert_eq!(draft["team_links"][0]["team_id"], "team-2");
    assert_eq!(draft["team_links"][1]["team_revision"], 2);
    assert_eq!(draft["eligible_for_execution"], false);
    assert_eq!(
        store.builder_draft("a").unwrap().unwrap()["team_link_status"],
        "unknown"
    );
    assert_eq!(
        page(&store, None, "", 10)["items"][1]["team_links"],
        draft["team_links"]
    );
    let saved = store.builder_draft_command("b", "create").unwrap().unwrap();
    assert!(saved.get("team_links").is_none()); // Projection never mutates saved receipts.
}
#[test]
fn team_filter_precedes_pagination_and_malformed_events_fail_closed() {
    let (_dir, store) = fixture();
    event(&store, "team-1", "b", 1);
    event(&store, "team-1", "d", 2);
    event(&store, "other", "a", 1);
    for body in [
        "not json",
        r#"{"kind":"builder_proposal_accepted","draft_id":"c"}"#,
        r#"{"kind":"builder_proposal_accepted","draft_id":"c","draft_revision":1,"team_revision":2,"request_id":"x","actor":{"kind":"agent","id":"local_owner"}}"#,
    ] {
        store
            .db
            .lock()
            .execute(
                "INSERT INTO team_events(team_id,body) VALUES ('team-1',?1)",
                [body],
            )
            .unwrap();
    }
    let first = page(&store, Some("team-1"), "", 1);
    assert_eq!(first["items"][0]["id"], "b");
    assert_eq!(first["next_cursor"], "b");
    let second = page(&store, Some("team-1"), "b", 1);
    assert_eq!(second["items"][0]["id"], "d");
    assert!(second["next_cursor"].is_null());
    assert_eq!(
        store.builder_draft("c").unwrap().unwrap()["team_link_status"],
        "unknown"
    );
    assert!(page(&store, Some("missing"), "", 2)["items"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn provenance_is_bounded_with_explicit_truncation() {
    let (_dir, store) = fixture();
    for revision in 1..=101 {
        event(&store, "team-1", "a", revision);
    }
    let draft = store.builder_draft("a").unwrap().unwrap();
    assert_eq!(draft["team_links"].as_array().unwrap().len(), 100);
    assert_eq!(draft["team_links_truncated"], true);
    assert_eq!(draft["team_links"][0]["team_revision"], 101);
}
