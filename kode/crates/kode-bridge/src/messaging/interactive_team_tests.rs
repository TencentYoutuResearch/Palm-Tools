use crate::messaging::interactive_team::*;
use crate::messaging::store::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
fn digest(v: &str) -> String {
    format!("{:x}", Sha256::digest(v.as_bytes()))
}
pub(super) fn fixture() -> (tempfile::TempDir, Store, Bind) {
    let temp = tempfile::tempdir().unwrap();
    let store = Store::open(&temp.path().join("store.sqlite"), "home").unwrap();
    store.save_document("workspaces",0,json!({"version":2,"tables":{"workspaces":{"workspace":{"path":"/fixture/project"}}},"global":{"workspaceIds":["workspace"]}})).unwrap();
    let refs = json!([{"host_id":"home","workspace_id":"workspace","root_ref":"/fixture/project"}]);
    let mut spec = json!({"name":"Interactive","purpose":"Offline fixture","kind":"coordinator","execution_mode":"interactive_native",
        "workspace_refs":refs,"execution_targets":[{"id":"target","host_id":"home","executor_profile_id":"original","executor_profile_revision":"a".repeat(64),"provider_id":"native","model_id":"original","effort":null}],
        "workers":[],"coordinator_targets":["target"],"workflow_pack_refs":[],"grant_id":null,"budget_policy_id":null,"scheduling_policy_id":null,"limits":{"max_active_assignments":1,"max_active_runs":1},"proactive_mode":"off"});
    let mut second = spec["execution_targets"][0].clone();
    second["id"] = json!("other-target");
    second["model_id"] = json!("other-model");
    spec["execution_targets"]
        .as_array_mut()
        .unwrap()
        .push(second);
    spec["coordinator_targets"]
        .as_array_mut()
        .unwrap()
        .push(json!("other-target"));
    store.save_builder_draft(serde_json::from_value(json!({"id":"draft","request_id":"save","expected_revision":0,"revoked":false,"interview":{"purpose":"Offline fixture","workspace_refs":refs,"answers":{},"questions":[],"proposed_team":spec}})).unwrap()).unwrap();
    store.accept_builder_proposal("draft",serde_json::from_value(json!({"request_id":"accept","expected_revision":1,"team_id":"team","team_revision":0})).unwrap()).unwrap();
    store.change_collaboration_surface("channel",serde_json::from_value(json!({"request_id":"surface","expected_revision":0,"scope":{"home_hub":"home","host_id":"home","workspace_id":"workspace","root_ref":"/fixture/project"},"kind":"channel","title":"Fixture","team_ids":["team"],"enabled":true})).unwrap()).unwrap();
    let source=store.send_collaboration_message("channel",serde_json::from_value(json!({"request_id":"source","expected_revision":1,"thread_id":null,"content":"Human canary","mentions":[]})).unwrap()).unwrap();
    let bind=serde_json::from_value(json!({"request_id":"bind","team_id":"team","team_revision":1,"surface_id":"channel","thread_id":source["id"],"audience_revision":1,"participant_id":"coordinator","target_id":"target","workspace_id":"workspace","context_epoch":1,"first_source_message_id":source["id"]})).unwrap();
    (temp, store, bind)
}
fn claim(store: &Store, b: &Value) -> Value {
    store
        .claim_interactive_team_source(
            b["binding_id"].as_str().unwrap(),
            Claim {
                request_id: "claim".into(),
                source_message_id: b["thread_id"].as_str().unwrap().into(),
            },
        )
        .unwrap()
}
fn finish_input(b: &Value, r: &Value) -> Finish {
    Finish {
        request_id: "finish".into(),
        receipt_id: r["receipt_id"].as_str().unwrap().into(),
        native_session_id: b["native_session_id"].as_str().unwrap().into(),
        journal_id: "journal".into(),
        turn_id: "turn".into(),
        header_sha256: "b".repeat(64),
        source_marker_sha256: "c".repeat(64),
        text: "Scoped reply".into(),
        text_sha256: digest("Scoped reply"),
    }
}
#[test]
fn interactive_owner_accepted_source_reply_is_atomic_and_idempotent() {
    let (temp, store, input) = fixture();
    let request = serde_json::to_value(&input).unwrap();
    let bound = store.bind_interactive_team(input).unwrap();
    let b = &bound["binding"];
    let id = b["binding_id"].as_str().unwrap();
    let replay = store
        .bind_interactive_team(serde_json::from_value(request).unwrap())
        .unwrap();
    assert_eq!(bound["new_binding"], true);
    assert_eq!(replay["new_binding"], false);
    assert_eq!(bound["binding"], replay["binding"]);
    assert_eq!(
        bound["binding"],
        store
            .interactive_team_session(b["native_session_id"].as_str().unwrap())
            .unwrap()["binding"]
    );
    let first = claim(&store, b);
    assert_eq!(first["new_claim"], true);
    assert_eq!(claim(&store, b)["new_claim"], false);
    let input = finish_input(b, &first["receipt"]);
    let raw = serde_json::to_value(&input).unwrap();
    let completed = store.finish_interactive_team_source(id, input).unwrap();
    assert_eq!(completed["new_completion"], true);
    assert_eq!(
        store
            .finish_interactive_team_source(id, serde_json::from_value(raw).unwrap())
            .unwrap()["new_completion"],
        false
    );
    let oid = completed["outbox"]["outbox_id"].as_str().unwrap();
    let reply = store.publish_interactive_team_reply(id, oid).unwrap();
    assert_eq!(reply["new_publication"], true);
    assert_eq!(reply["message"]["actor"]["kind"], "interactive_participant");
    assert_eq!(reply["message"]["thread_id"], b["thread_id"]);
    drop(store);
    let store = Store::open(&temp.path().join("store.sqlite"), "home").unwrap();
    let replay = store.publish_interactive_team_reply(id, oid).unwrap();
    assert_eq!(replay["new_publication"], false);
    assert_eq!(replay["message"], reply["message"]);
    let db = store.db.lock();
    let count: u64 = db
        .query_row(
            "SELECT COUNT(*) FROM collaboration_messages WHERE kind='superagent_reply'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn interactive_wrong_role_session_hash_duplicate_source_and_mutation_fail_closed() {
    let (_temp, store, mut input) = fixture();
    input.participant_id = "worker:missing".into();
    assert!(store.bind_interactive_team(input).is_err());
    let (_temp, store, input) = fixture();
    let bound = store.bind_interactive_team(input).unwrap();
    let b = &bound["binding"];
    let id = b["binding_id"].as_str().unwrap();
    let c = claim(&store, b);
    let mut bad = finish_input(b, &c["receipt"]);
    bad.native_session_id = "session-foreign".into();
    assert!(store.finish_interactive_team_source(id, bad).is_err());
    let mut bad = finish_input(b, &c["receipt"]);
    bad.text = "changed".into();
    assert!(store.finish_interactive_team_source(id, bad).is_err());
    assert!(store
        .claim_interactive_team_source(
            id,
            Claim {
                request_id: "other".into(),
                source_message_id: b["thread_id"].as_str().unwrap().into()
            }
        )
        .is_err());
    store.db.lock().execute("UPDATE collaboration_messages SET body=json_set(body,'$.content','tampered') WHERE id=?1",[b["thread_id"].as_str().unwrap()]).unwrap();
    assert!(store
        .finish_interactive_team_source(id, finish_input(b, &c["receipt"]))
        .is_err());
}
#[test]
fn interactive_unaccepted_revision_cannot_register() {
    let (_temp, store, mut input) = fixture();
    let team = store.team("team", Some(1)).unwrap().unwrap();
    store
        .save_team(
            serde_json::from_value(
                json!({"id":"team","request_id":"edit","expected_revision":1,"spec":team["spec"]}),
            )
            .unwrap(),
        )
        .unwrap();
    input.team_revision = 2;
    assert!(store
        .bind_interactive_team(input)
        .unwrap_err()
        .to_string()
        .contains("owner accepted Builder"));
}
#[test]
fn interactive_publication_rollback_and_audience_revocation_preserve_outbox() {
    let (_temp, store, input) = fixture();
    let bound = store.bind_interactive_team(input).unwrap();
    let b = &bound["binding"];
    let id = b["binding_id"].as_str().unwrap();
    let c = claim(&store, b);
    let done = store
        .finish_interactive_team_source(id, finish_input(b, &c["receipt"]))
        .unwrap();
    let oid = done["outbox"]["outbox_id"].as_str().unwrap();
    store.db.lock().execute_batch("CREATE TEMP TRIGGER fail_interactive_reply BEFORE INSERT ON collaboration_messages WHEN NEW.kind='superagent_reply' BEGIN SELECT RAISE(ABORT,'fixture atomicity'); END;").unwrap();
    assert!(store.publish_interactive_team_reply(id, oid).is_err());
    store
        .db
        .lock()
        .execute_batch("DROP TRIGGER fail_interactive_reply;")
        .unwrap();
    // Disable the same surface through the original owner control plane. A completed
    // input must not hide a pending publication or bypass revoked access.
    store.change_collaboration_surface("channel",serde_json::from_value(json!({"request_id":"disable","expected_revision":1,"scope":{"home_hub":"home","host_id":"home","workspace_id":"workspace","root_ref":"/fixture/project"},"kind":"channel","title":"Fixture","team_ids":["team"],"enabled":false})).unwrap()).unwrap();
    assert!(store.publish_interactive_team_reply(id, oid).is_err());
    assert!(store.interactive_team_binding(id).is_err());
    let db = store.db.lock();
    let count: u64 = db
        .query_row(
            "SELECT COUNT(*) FROM collaboration_messages WHERE kind='superagent_reply'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    let body: String = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [format!("interactive-team-v1:outbox:{oid}")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["state"],
        "pending"
    );
}

#[test]
fn interactive_targets_and_dm_get_distinct_native_sessions() {
    let (_temp, store, input) = fixture();
    let raw = serde_json::to_value(&input).unwrap();
    let first = store.bind_interactive_team(input).unwrap();
    let mut other = raw.clone();
    other["request_id"] = json!("other-binding");
    other["target_id"] = json!("other-target");
    let second = store
        .bind_interactive_team(serde_json::from_value(other).unwrap())
        .unwrap();
    assert_ne!(
        first["binding"]["native_session_id"],
        second["binding"]["native_session_id"]
    );
    assert_eq!(second["binding"]["selection"]["model"], "other-model");
    store.change_collaboration_surface("dm",serde_json::from_value(json!({"request_id":"dm","expected_revision":0,"scope":{"home_hub":"home","host_id":"home","workspace_id":"workspace","root_ref":"/fixture/project"},"kind":"dm","title":"DM","team_ids":["team"],"enabled":true})).unwrap()).unwrap();
    let source=store.send_collaboration_message("dm",serde_json::from_value(json!({"request_id":"dm-source","expected_revision":1,"thread_id":null,"content":"Private canary","mentions":[]})).unwrap()).unwrap();
    let mut dm = raw;
    dm["request_id"] = json!("dm-binding");
    dm["surface_id"] = json!("dm");
    dm["thread_id"] = source["id"].clone();
    dm["first_source_message_id"] = source["id"].clone();
    let third = store
        .bind_interactive_team(serde_json::from_value(dm).unwrap())
        .unwrap();
    assert_eq!(third["binding"]["surface_kind"], "dm");
    assert_ne!(
        third["binding"]["native_session_id"],
        first["binding"]["native_session_id"]
    );
    assert!(store
        .claim_interactive_team_source(
            first["binding"]["binding_id"].as_str().unwrap(),
            Claim {
                request_id: "foreign".into(),
                source_message_id: source["id"].as_str().unwrap().into()
            }
        )
        .is_err());
}
#[test]
fn interactive_old_sources_need_exact_first_source_and_mentions_cannot_cross_participant() {
    let (_temp, store, mut input) = fixture();
    input.first_source_message_id = None;
    let bound = store.bind_interactive_team(input).unwrap();
    let b = &bound["binding"];
    assert!(store
        .claim_interactive_team_source(
            b["binding_id"].as_str().unwrap(),
            Claim {
                request_id: "old".into(),
                source_message_id: b["thread_id"].as_str().unwrap().into()
            }
        )
        .unwrap_err()
        .to_string()
        .contains("predates"));
    let (_temp, store, input) = fixture();
    let bound = store.bind_interactive_team(input).unwrap();
    let b = &bound["binding"];
    store.db.lock().execute("UPDATE collaboration_messages SET body=json_set(body,'$.mentions',json(?1)) WHERE id=?2",rusqlite::params![json!([{"team_id":"team","team_revision":1,"worker_id":"foreign"}]).to_string(),b["thread_id"].as_str().unwrap()]).unwrap();
    assert!(store
        .claim_interactive_team_source(
            b["binding_id"].as_str().unwrap(),
            Claim {
                request_id: "wrong-participant".into(),
                source_message_id: b["thread_id"].as_str().unwrap().into()
            }
        )
        .unwrap_err()
        .to_string()
        .contains("mentions"));
}
#[test]
fn interactive_exact_tuple_reuses_session_without_expanding_history_exception() {
    let (_temp, store, input) = fixture();
    let mut raw = serde_json::to_value(&input).unwrap();
    let first = store.bind_interactive_team(input).unwrap();
    let fresh=store.send_collaboration_message("channel",serde_json::from_value(json!({"request_id":"next-source","expected_revision":1,"thread_id":first["binding"]["thread_id"],"content":"Next source","mentions":[]})).unwrap()).unwrap();
    raw["request_id"] = json!("open-again");
    raw["first_source_message_id"] = fresh["id"].clone();
    let again = store
        .bind_interactive_team(serde_json::from_value(raw).unwrap())
        .unwrap();
    assert_eq!(again["new_binding"], false);
    assert_eq!(again["binding"], first["binding"]);
    let claim = store
        .claim_interactive_team_source(
            again["binding"]["binding_id"].as_str().unwrap(),
            Claim {
                request_id: "new-claim".into(),
                source_message_id: fresh["id"].as_str().unwrap().into(),
            },
        )
        .unwrap();
    assert_eq!(claim["new_claim"], true);
    assert_eq!(claim["message"]["content"], "Next source");
}
#[test]
fn interactive_send_selection_is_persisted_idempotent_and_binding_exact() {
    let (_temp, store, mut input) = fixture();
    let selection = json!({"team_id":"team","team_revision":1,"participant_id":"coordinator","target_id":"target","workspace_id":"workspace","audience_revision":1});
    let mut raw = json!({"request_id":"selected-source","expected_revision":1,"thread_id":null,"content":"Selected source","mentions":[],"interactive_selection":selection});
    let (message, fresh) = store
        .send_collaboration_message_with_status(
            "channel",
            serde_json::from_value(raw.clone()).unwrap(),
        )
        .unwrap();
    assert!(fresh);
    assert!(message.get("newly_stored").is_none());
    assert_eq!(message["interactive_selection"], selection);
    let (replay, fresh) = store
        .send_collaboration_message_with_status(
            "channel",
            serde_json::from_value(raw.clone()).unwrap(),
        )
        .unwrap();
    assert!(!fresh);
    assert_eq!(message, replay);
    raw["interactive_selection"]["target_id"] = json!("other-target");
    assert!(store
        .send_collaboration_message_with_status(
            "channel",
            serde_json::from_value(raw.clone()).unwrap()
        )
        .unwrap_err()
        .to_string()
        .contains("conflict"));
    input.thread_id = message["id"].as_str().unwrap().into();
    input.first_source_message_id = Some(input.thread_id.clone());
    input.target_id = "other-target".into();
    let retry = serde_json::to_value(&input).unwrap();
    assert!(store
        .bind_interactive_team(input)
        .unwrap_err()
        .to_string()
        .contains("selection"));
    let mut exact = retry;
    exact["target_id"] = json!("target");
    let bound = store
        .bind_interactive_team(serde_json::from_value(exact).unwrap())
        .unwrap();
    assert_eq!(claim(&store, &bound["binding"])["new_claim"], true);
    raw["request_id"] = json!("bad-mentions");
    raw["mentions"] = json!([{"team_id":"team","team_revision":1,"worker_id":"foreign"}]);
    assert!(store
        .send_collaboration_message("channel", serde_json::from_value(raw).unwrap())
        .is_err());
}

#[test]
fn interactive_recovery_only_proves_original_never_claimed_binding() {
    let (_temp, store, mut input) = fixture();
    let original = input.first_source_message_id.clone().unwrap();
    input.request_id = format!("composer:{original}");
    let bound = store.bind_interactive_team(input).unwrap();
    let b = &bound["binding"]; let id = b["binding_id"].as_str().unwrap();
    assert_eq!(store.interactive_team_original_source_binding(&original).unwrap(), id);
    assert!(store.interactive_team_original_source_binding("foreign").is_err());
    let proof = store.inspect_interactive_team_recovery(id).unwrap();
    assert_eq!(proof["never_claimed"], true);
    assert_eq!(proof["message"]["id"], b["first_source_message_id"]);
    assert_eq!(proof["binding"], *b);
    let claimed = claim(&store,b);
    assert_eq!(store.inspect_interactive_team_recovery(id).unwrap()["never_claimed"], false);
    let completed=store.finish_interactive_team_source(id,finish_input(b,&claimed["receipt"])).unwrap();
    store.publish_interactive_team_reply(id,completed["outbox"]["outbox_id"].as_str().unwrap()).unwrap();
    assert_eq!(store.inspect_interactive_team_recovery(id).unwrap()["never_claimed"], false);
    let status=store.inspect_interactive_team_recovery(id).unwrap();
    assert_eq!(status["reply_message"]["source_message_id"], original);
    assert_eq!(status["reply_message"]["delivery_state"], "published");
    assert!(store.inspect_interactive_team_recovery("foreign").is_err());
}

fn interrupted_input(b:&Value,r:&Value)->Interrupted {
 Interrupted {request_id:format!("interrupted:{}",r["receipt_id"].as_str().unwrap()),receipt_id:r["receipt_id"].as_str().unwrap().into(),source_message_id:r["source_message_id"].as_str().unwrap().into(),native_session_id:b["native_session_id"].as_str().unwrap().into(),journal_id:b["native_session_id"].as_str().unwrap().into(),turn_id:"1".into(),header_sha256:"a".repeat(64),source_marker_sha256:"b".repeat(64),terminal_sha256:"c".repeat(64),approval_sha256:"d".repeat(64),process_stop_sha256:"e".repeat(64),cause:"approval_rejected".into()}
}
#[test]
fn interrupted_source_is_idempotent_non_success_and_never_replayable(){
 let (_temp,store,input)=fixture();let b=store.bind_interactive_team(input).unwrap()["binding"].clone();let id=b["binding_id"].as_str().unwrap();let r=claim(&store,&b)["receipt"].clone();
 let mut wrong=interrupted_input(&b,&r);wrong.source_message_id="foreign".into();assert!(store.interrupt_interactive_team_source(id,wrong).is_err());
 let first=store.interrupt_interactive_team_source(id,interrupted_input(&b,&r)).unwrap();assert_eq!(first["receipt"]["state"],"interrupted");assert_eq!(first["new_interruption"],true);
 let again=store.interrupt_interactive_team_source(id,interrupted_input(&b,&r)).unwrap();assert_eq!(again["receipt"],first["receipt"]);assert_eq!(again["new_interruption"],false);
 let mut conflict=interrupted_input(&b,&r);conflict.turn_id="2".into();assert!(store.interrupt_interactive_team_source(id,conflict).is_err());
 assert_eq!(claim(&store,&b)["new_claim"],false);assert_eq!(claim(&store,&b)["receipt"]["state"],"interrupted");
 assert!(store.claim_interactive_team_source(id,Claim{request_id:"new".into(),source_message_id:r["source_message_id"].as_str().unwrap().into()}).is_err());
 assert!(store.finish_interactive_team_source(id,finish_input(&b,&r)).is_err());
 let status=store.inspect_interactive_team_recovery(id).unwrap();assert_eq!(status["never_claimed"],false);assert!(status["reply_message"].is_null());assert_eq!(status["receipt"]["state"],"interrupted");
}
#[test]
fn completed_source_cannot_be_overwritten_by_interrupted_report(){
 let (_temp,store,input)=fixture();let b=store.bind_interactive_team(input).unwrap()["binding"].clone();let id=b["binding_id"].as_str().unwrap();let r=claim(&store,&b)["receipt"].clone();store.finish_interactive_team_source(id,finish_input(&b,&r)).unwrap();assert!(store.interrupt_interactive_team_source(id,interrupted_input(&b,&r)).is_err());
}
