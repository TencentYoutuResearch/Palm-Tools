//! Controlled store fixtures only. Reads must leave every ledger unchanged.
use super::*;
use super::super::conversation_notices::Page;
use rusqlite::params;

fn conversation(s: &Store) -> String { s.team("team",None).unwrap().unwrap()["conversation_id"].as_str().unwrap().into() }
fn notice_task(s: &Store, n: usize, state: &str) -> Value {
    let message=s.send_collaboration_message("channel",send("Unpublished original body")).unwrap();
    let mut input=create(message["id"].as_str().unwrap());
    input.request_id=format!("notice-{n}"); input.origin_surface_id="channel".into(); input.summary=format!("Task {n}"); input.publication=None;
    let mut task=s.create_collaboration_task(input).unwrap();
    let run_id=format!("notice-run-{n}");task["work_run_id"]=json!(run_id);
    let run=json!({"id":run_id,"team_id":"team","team_revision":1,"home_hub":"home","revision":1,"state":state,"completion_authorized":state=="completed",
      "collaboration":{"format":"kode.collaboration.work-source.v2","task_id":task["id"],"scope":task["scope"],"context_id":task["context_id"],
        "archive_surface_id":task["archive_surface_id"],"thread_id":task["thread_id"],"origin_audience_revision":1,"archive_audience_revision":1},
      "clarifications":[{"request":{"questions":[{"question":"Private question body"}]} }],"inputs":{"request":"Private execution body"}});
    let db=s.db.lock();
    db.execute("UPDATE collaboration_tasks SET body=?1 WHERE id=?2",params![task.to_string(),task["id"].as_str()]).unwrap();
    db.execute("INSERT INTO work_runs(id,team_id,request_id,request,revision,state,body,initial_body) VALUES (?1,'team',?1,'{}',1,?2,?3,?3)",params![run_id,state,run.to_string()]).unwrap();
    task
}
fn changes(s: &Store) -> u64 {s.db.lock().query_row("SELECT total_changes()",[],|r|r.get(0)).unwrap()}
#[test]
fn task_notices_are_guarded_dynamic_read_only_references_after_restart() {
    let (root,s)=fixture();
    let a=notice_task(&s,1,"running");let b=notice_task(&s,2,"completed");let conversation=conversation(&s);
    let before=changes(&s);let page=s.conversation_task_notices(&conversation,Page::default()).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(),2);assert_eq!(page["next_cursor"],Value::Null);
    assert!(page["items"].as_array().unwrap().iter().any(|r|r["task_id"]==a["id"]&&r["question_count"]==1));
    assert!(page["items"].as_array().unwrap().iter().any(|r|r["task_id"]==b["id"]&&r["question_count"]==0));
    assert!(!page.to_string().contains("Private"));assert!(!page.to_string().contains("Unpublished"));
    assert_eq!(s.conversation_task_notices(&conversation,Page::default()).unwrap(),page);assert_eq!(changes(&s),before);
    drop(s);let s=Store::open(&root.path().join("store.sqlite"),"home").unwrap();
    assert_eq!(s.conversation_task_notices(&conversation,Page::default()).unwrap(),page);
    let mut revoked=change(Kind::Channel);revoked.expected_revision=1;revoked.request_id="disable".into();revoked.enabled=false;
    s.change_collaboration_surface("channel",revoked).unwrap();
    let page=s.conversation_task_notices(&conversation,Page::default()).unwrap();
    assert_eq!(page["items"],json!([]));assert_eq!(page["unavailable"],true);assert!(!page.to_string().contains("Task 1"));
    assert!(s.collaboration_task(a["id"].as_str().unwrap()).is_err());
}
#[test]
fn task_notice_pages_are_bounded_deduplicated_and_explicitly_incomplete() {
    let (_root,s)=fixture();for n in 0..35 {notice_task(&s,n,"completed");}
    let conversation=conversation(&s);let before=changes(&s);
    let first=s.conversation_task_notices(&conversation,Page::default()).unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(),32);let cursor=first["next_cursor"].as_str().unwrap();
    let second=s.conversation_task_notices(&conversation,Page{after:cursor.into()}).unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(),3);assert_eq!(second["next_cursor"],Value::Null);
    for row in second["items"].as_array().unwrap(){assert!(!first["items"].as_array().unwrap().iter().any(|r|r["task_id"]==row["task_id"]));}
    assert_eq!(changes(&s),before);
    assert!(s.conversation_task_notices(&conversation,Page{after:"bad/cursor".into()}).is_err());
    assert!(s.conversation_task_notices("other-conversation",Page::default()).is_err());
}
#[test]
fn wrong_task_run_tuple_and_private_origin_never_expose_notices() {
    let (_root,s)=fixture();let task=notice_task(&s,1,"completed");let conversation=conversation(&s);
    for field in ["task_id","context_id","archive_surface_id","thread_id","scope","origin_audience_revision","archive_audience_revision"] {
        let db=s.db.lock();let body:String=db.query_row("SELECT body FROM work_runs WHERE id='notice-run-1'",[],|r|r.get(0)).unwrap();
        let mut run:Value=serde_json::from_str(&body).unwrap();run["collaboration"][field]=json!("wrong");
        db.execute("UPDATE work_runs SET body=?1 WHERE id='notice-run-1'",[run.to_string()]).unwrap();drop(db);
        let page=s.conversation_task_notices(&conversation,Page::default()).unwrap();assert_eq!(page["items"],json!([]),"{field}");
        s.db.lock().execute("UPDATE work_runs SET body=?1 WHERE id='notice-run-1'",[body]).unwrap();
    }
    let mut private=task.clone();private["origin_surface_id"]=json!("dm");
    s.db.lock().execute("UPDATE collaboration_tasks SET body=?1 WHERE id=?2",params![private.to_string(),task["id"].as_str()]).unwrap();
    assert_eq!(s.conversation_task_notices(&conversation,Page::default()).unwrap()["items"],json!([]));
}
#[test]
fn stopping_or_answered_requests_are_not_presented_as_awaiting_owner() {
    let (_root,s)=fixture();notice_task(&s,1,"cancelling");notice_task(&s,2,"running");
    let page=s.conversation_task_notices(&conversation(&s),Page::default()).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(),1);assert_eq!(page["items"][0]["run_id"],"notice-run-2");
    let db=s.db.lock();let body:String=db.query_row("SELECT body FROM work_runs WHERE id='notice-run-2'",[],|r|r.get(0)).unwrap();
    let mut run:Value=serde_json::from_str(&body).unwrap();run["clarifications"]=json!([]);run["clarification_answers"]=json!([{"state":"queued"}]);
    db.execute("UPDATE work_runs SET body=?1 WHERE id='notice-run-2'",[run.to_string()]).unwrap();drop(db);
    assert_eq!(s.conversation_task_notices(&conversation(&s),Page::default()).unwrap()["items"],json!([]));
}
#[test]
fn every_read_rechecks_origin_archive_membership_team_revision_and_workspace_root() {
    for boundary in ["origin", "archive", "membership", "team", "workspace"] {
        let (_root,s)=fixture();let mut task=notice_task(&s,1,"completed");let conversation=conversation(&s);
        s.change_collaboration_surface("origin",change(Kind::Channel)).unwrap();
        task["origin_surface_id"]=json!("origin");
        s.db.lock().execute("UPDATE collaboration_tasks SET body=?1 WHERE id=?2",params![task.to_string(),task["id"].as_str()]).unwrap();
        assert_eq!(s.conversation_task_notices(&conversation,Page::default()).unwrap()["items"].as_array().unwrap().len(),1);
        match boundary {
            "origin" | "archive" => { let mut value=change(Kind::Channel);value.request_id="revoke".into();value.expected_revision=1;value.enabled=false;
                s.change_collaboration_surface(if boundary=="origin" {"origin"} else {"channel"},value).unwrap(); },
            "membership" => { let spec=s.team("team",None).unwrap().unwrap()["spec"].clone();
                s.save_team(teams::Save{id:"other-team".into(),request_id:"other-team".into(),expected_revision:0,spec:serde_json::from_value(spec).unwrap()}).unwrap();
                let mut value=change(Kind::Channel);value.expected_revision=1;value.request_id="wider".into();value.team_ids.push("other-team".into());s.change_collaboration_surface("channel",value).unwrap(); },
            "team" => { let spec=s.team("team",None).unwrap().unwrap()["spec"].clone();s.save_team(teams::Save{id:"team".into(),request_id:"revise".into(),expected_revision:1,spec:serde_json::from_value(spec).unwrap()}).unwrap(); },
            _ => { s.db.lock().execute("UPDATE workbench_documents SET value=json_set(value,'$.tables.workspaces.workspace.path','/fixture/moved') WHERE key='workspaces'",[]).unwrap(); }
        }
        let before=changes(&s);let page=s.conversation_task_notices(&conversation,Page::default()).unwrap();
        assert_eq!(page["items"],json!([]),"{boundary}");assert_eq!(page["unavailable"],true,"{boundary}");assert_eq!(changes(&s),before);
    }
}
#[test]
fn filtered_empty_pages_still_expose_next_cursor_and_v1_remains_compatible() {
    let (_root,s)=fixture();for n in 0..35 {notice_task(&s,n,"cancelling");}
    let conversation=conversation(&s);let page=s.conversation_task_notices(&conversation,Page::default()).unwrap();
    assert_eq!(page["items"],json!([]));assert!(page["next_cursor"].is_string());
    s.db.lock().execute("UPDATE work_runs SET body=json_set(body,'$.state','completed','$.collaboration.format','kode.collaboration.work-source.v1') WHERE id='notice-run-1'",[]).unwrap();
    let mut count=0;let mut page=s.conversation_task_notices(&conversation,Page::default()).unwrap();
    loop {count+=page["items"].as_array().unwrap().len();let Some(cursor)=page["next_cursor"].as_str() else {break};page=s.conversation_task_notices(&conversation,Page{after:cursor.into()}).unwrap();}
    assert_eq!(count,1);
    s.db.lock().execute("UPDATE work_runs SET body=json_set(body,'$.team_revision',999) WHERE id='notice-run-1'",[]).unwrap();
    let page=s.conversation_task_notices(&conversation,Page::default()).unwrap();assert_eq!(page["items"],json!([]));
}
#[tokio::test]
async fn task_notices_http_rejects_session_credentials_and_all_writes() {
    let root=tempfile::tempdir().unwrap();let ctx=crate::build_test_ctx(kode_core::config::Config::default(),"owner-fixture".into());
    let hub=Hub::open_with_agent_home(Config{node_id:"home".into(),database:root.path().join("http.sqlite"),peers:vec![]},&ctx,root.path().join("agent-home")).unwrap();
    setup(&hub.store);notice_task(&hub.store,1,"completed");let conversation=conversation(&hub.store);
    let registration=hub.store.register(crate::messaging::model::RegisterRequest{session_id:"fixture-session".into(),title:"Fixture".into(),runtime:"fixture".into(),owner_token:None}).unwrap();
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/api/v1/messaging/conversations/{conversation}/task-notices",listener.local_addr().unwrap());
    let server=tokio::spawn(async move {axum::serve(listener,hub.router()).await.unwrap()});let client=reqwest::Client::new();
    assert_eq!(client.get(&endpoint).send().await.unwrap().status(),401);
    assert_eq!(client.get(&endpoint).bearer_auth(&registration.owner_token).send().await.unwrap().status(),403);
    assert_eq!(client.post(&endpoint).bearer_auth("owner-fixture").json(&json!({})).send().await.unwrap().status(),405);
    assert_eq!(client.get(format!("{endpoint}?after=bad/id")).bearer_auth("owner-fixture").send().await.unwrap().status(),400);
    let page:Value=client.get(&endpoint).bearer_auth("owner-fixture").send().await.unwrap().error_for_status().unwrap().json().await.unwrap();assert_eq!(page["items"].as_array().unwrap().len(),1);server.abort();
}
