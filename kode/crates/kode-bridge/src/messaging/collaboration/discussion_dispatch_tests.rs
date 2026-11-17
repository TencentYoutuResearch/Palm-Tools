//! Deterministic real Store tests, no Host or provider model is started.
use super::*;
use crate::messaging::collaboration::storage::surface;
use crate::messaging::collaboration::discussion_dispatch as dispatch;

#[test]
fn task_discussion_is_durable_thread_bound_and_not_private_conversation() {
    let (root, s) = fixture(); configure(&s);
    let a = task(&s); let aid = a["id"].as_str().unwrap();
    let run = dispatched(&s, aid);
    let mut input = send("REQ-A only: progress?"); input.thread_id = a["thread_id"].as_str().map(str::to_owned);
    let first = s.send_collaboration_message("channel", input.clone()).unwrap();
    assert_eq!(first["delivery_state"], "stored_only");
    assert_eq!(first["delivery_reason"], "isolated_context_required");
    assert_eq!(first["context_readiness"]["state"], "not_ready");
    assert_eq!(first["context_readiness"]["legacy_shared_session_reused"], false);
    assert_eq!(first["execution_authorized"], false);
    assert!(first["discussion_route"].is_null());
    assert_eq!(s.work_run(run["id"].as_str().unwrap()).unwrap().unwrap(), run);
    assert_eq!(s.send_collaboration_message("channel",input.clone()).unwrap(), first);
    input.content = "changed".into(); assert!(s.send_collaboration_message("channel",input).is_err());
    let id = first["id"].as_str().unwrap();
    let conversation = s.team("team",None).unwrap().unwrap()["conversation_id"].as_str().unwrap().to_owned();
    {
        let db = s.db.lock();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM conversation_messages",[],|r|r.get::<_,u32>(0)).unwrap(),0);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM collaboration_coordinator_inputs",[],|r|r.get::<_,u32>(0)).unwrap(),0);
        assert!(dispatch::source(&db,&conversation,id).unwrap().is_none());
        assert_eq!(db.query_row("SELECT COUNT(*) FROM collaboration_messages WHERE id=?1",[id],|r|r.get::<_,u32>(0)).unwrap(),1);
        assert!(dispatch::source(&db,"other",id).unwrap().is_none());
    }
    let pending = s.pending_conversation_inputs(&conversation,serde_json::from_value(json!({"after":0,"limit":20})).unwrap()).unwrap();
    assert_eq!(pending["items"].as_array().unwrap().len(),0);
    drop(s);
    let s = Store::open(&root.path().join("store.sqlite"),"home").unwrap();
    assert_eq!(s.pending_conversation_inputs(&conversation,serde_json::from_value(json!({"after":0,"limit":20})).unwrap()).unwrap(),pending);
    assert!(dispatch::source(&s.db.lock(),&conversation,id).unwrap().is_none());
    let page=s.collaboration_messages("channel",Page{thread_id:a["thread_id"].as_str().map(str::to_owned),limit:Some(50),after:0}).unwrap();
    assert!(page["items"].as_array().unwrap().iter().any(|row| row["id"]==first["id"] && row["delivery_reason"]=="isolated_context_required"));
    let mut cancel=command();cancel.request_id="cancel".into();cancel.action=Action::Cancel;cancel.content=None;cancel.worker_id=None;
    s.command_collaboration_task(aid,cancel).unwrap();
    assert!(dispatch::source(&s.db.lock(),&conversation,id).unwrap().is_none());
}

#[test]
fn unaddressed_and_wider_audience_discussions_never_queue() {
    let (_root,s)=fixture();configure(&s);
    let row=s.send_collaboration_message("channel",send("Do not infer a recipient")).unwrap();
    assert_eq!(row["delivery_reason"],"recipient_required");
    let mut input=send("Discuss only");input.mentions=vec![Mention{team_id:"team".into(),team_revision:2,worker_id:None}];
    {
        let db=s.db.lock();let mut broad=surface(&db,"home","channel",true).unwrap();broad.team_ids.push("other-team".into());
        let mut row=json!({"id":"broad","thread_id":"broad","content":"private context must not leak"});
        dispatch::accept(&db,"home",&broad,&mut row,&input.mentions).unwrap();
        assert_eq!(row["delivery_reason"],"audience_publication_approval_required");
    }
    let first=s.send_collaboration_message("dm",input).unwrap();
    assert_eq!(first["delivery_state"],"stored_only");
    assert_eq!(first["delivery_reason"],"isolated_context_required");
    let conversation=s.team("team",None).unwrap().unwrap()["conversation_id"].as_str().unwrap().to_owned();
    let mut changed=change(Kind::Dm);changed.expected_revision=1;changed.request_id="disable".into();changed.enabled=false;
    s.change_collaboration_surface("dm",changed).unwrap();
    assert!(dispatch::source(&s.db.lock(),&conversation,first["id"].as_str().unwrap()).unwrap().is_none());
}

#[test]
fn oversized_thread_is_archived_without_truncated_model_input() {
    let (_root,s)=fixture();configure(&s);
    let first=s.send_collaboration_message("channel",send("Thread root")).unwrap();
    let thread=first["id"].as_str().unwrap();
    for index in 0..50 {
        let mut input=send(&format!("Historical reply {index}"));input.thread_id=Some(thread.into());
        s.send_collaboration_message("channel",input).unwrap();
    }
    let mut input=send("Address the team explicitly");input.thread_id=Some(thread.into());
    input.mentions=vec![Mention{team_id:"team".into(),team_revision:2,worker_id:None}];
    let message=s.send_collaboration_message("channel",input).unwrap();
    assert_eq!(message["delivery_state"],"stored_only");
    assert_eq!(message["delivery_reason"],"isolated_context_required");
    assert_eq!(s.db.lock().query_row("SELECT COUNT(*) FROM collaboration_coordinator_inputs",[],|r|r.get::<_,u32>(0)).unwrap(),0);
    let page=s.collaboration_messages("channel",Page{thread_id:Some(thread.into()),limit:Some(50),after:0}).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(),50);assert_eq!(page["has_more"],true);
    let next=s.collaboration_messages("channel",Page{thread_id:Some(thread.into()),limit:Some(50),after:page["next_cursor"].as_u64().unwrap()}).unwrap();
    assert_eq!(next["items"].as_array().unwrap().len(),2);
}

#[test]
fn legacy_delivery_can_still_publish_without_reopening_new_dispatch() {
    let (_root,s)=fixture();configure(&s);
    let a=task(&s);let run=dispatched(&s,a["id"].as_str().unwrap());
    let mut input=send("Legacy accepted request");input.thread_id=a["thread_id"].as_str().map(str::to_owned);
    let saved=s.send_collaboration_message("channel",input).unwrap();
    let conversation=s.team("team",None).unwrap().unwrap()["conversation_id"].as_str().unwrap().to_owned();
    let db=s.db.lock();let surface=surface(&db,"home","channel",true).unwrap();
    // Simulate an immutable input admitted by the previous release, not migration.
    let legacy=json!({"id":saved["id"],"conversation_id":conversation,"team_id":"team","team_revision":2,
        "actor":{"kind":"human","id":"local_owner"},"content":saved["content"],"execution_authorized":false,
        "discussion":{"surface_id":"channel","thread_id":a["thread_id"],"scope":surface.scope,
        "audience_revision":surface.audience_revision,"team_id":"team","task_id":a["id"],"run_id":run["id"]}});
    db.execute("INSERT INTO collaboration_coordinator_inputs(id,conversation_id,team_id,surface_id,thread_id,body) VALUES (?1,?2,'team','channel',?3,?4)",
        rusqlite::params![saved["id"].as_str(),conversation,a["thread_id"].as_str(),legacy.to_string()]).unwrap();
    let loaded=dispatch::source(&db,&conversation,saved["id"].as_str().unwrap()).unwrap().unwrap();
    dispatch::admit_delivery(&db,&loaded).unwrap();
    let reply=json!({"id":"legacy-reply","conversation_id":conversation,"team_id":"team","request_id":"legacy-reply",
        "content":"Original result","actor":{"kind":"superagent","id":"agent"},"created_at":now()});
    let result=dispatch::publish(&db,&loaded,"{}",reply).unwrap();
    assert_eq!(result["thread_id"],a["thread_id"]);assert_eq!(result["surface_id"],"channel");
    assert!(dispatch::reply_receipt(&db,&conversation,"legacy-reply").unwrap().is_some());
    drop(db);
    assert_eq!(s.work_run(run["id"].as_str().unwrap()).unwrap().unwrap(),run);
}
