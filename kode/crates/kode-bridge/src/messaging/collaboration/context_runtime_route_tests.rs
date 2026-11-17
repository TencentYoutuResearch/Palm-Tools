//! Full Hub.router oneshot tests, no listeners, native processes, or model calls.
use super::*;
use crate::messaging::{
    coordinator_context_inbox::Claim,
    model::now,
    runtime_host_enrollment::{Challenge, Register},
};
async fn prepared() -> (Fixture, Claim, Value, String) {
    let (dir, store, key, _, claim) = super::super::inbox_tests::setup();
    drop(store);
    let f = fixture_from_store(dir, key);
    let session = format!("context-{}", f.key);
    let (status, registered) = call(
        f.hub.router(),
        "POST",
        "/api/v1/messaging/sessions",
        Some(OWNER),
        Some(json!({"session_id":session,"title":"Fictional scope worker","runtime":"dsh"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = registered["owner_token"].as_str().unwrap().to_string();
    let challenge = f
        .hub
        .store
        .challenge_runtime_host(Challenge {
            request_id: "challenge".into(),
            host_id: "home".into(),
            boot_id: "boot".into(),
            protocol_version: 1,
        })
        .unwrap();
    let enrollment = f
        .hub
        .store
        .register_runtime_host(Register {
            request_id: "register".into(),
            challenge_id: challenge["challenge_id"].as_str().unwrap().into(),
            nonce: challenge["nonce"].as_str().unwrap().into(),
            host_id: "home".into(),
            boot_id: "boot".into(),
            protocol_version: 1,
        })
        .unwrap();
    let op = f.hub.store.operation(&claim.operation_id).unwrap().unwrap();
    let body = json!({"request_id":"bind","context_key":f.key,"expected_control_revision":1,"enrollment_id":enrollment["enrollment"]["id"],"expected_enrollment_revision":1,"expected_operation_revision":op.revision,"expected_binding_revision":0});
    let path = format!("{PREFIX}/contexts/{}/host-binding", f.key);
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &path,
            Some(&token),
            Some(body.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, binding) = call(f.hub.router(), "POST", &path, Some(OWNER), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{binding}");
    (f, claim, binding, token)
}
#[tokio::test]
async fn scoped_runtime_full_router_real_principal_and_prepared_source() {
    let (f, claim, _, token) = prepared().await;
    let base = format!("{PREFIX}/contexts/{}", f.key);
    for t in [None, Some(OWNER), Some(f.session_token.as_str())] {
        let expected = if t.is_none() {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(
            call(
                f.hub.router(),
                "GET",
                &format!("{base}/source-authority"),
                t,
                None
            )
            .await
            .0,
            expected
        );
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &format!("{base}/inbox/claim"),
                t,
                Some(serde_json::to_value(&claim).unwrap())
            )
            .await
            .0,
            expected
        );
    }
    let (status, authority) = call(
        f.hub.router(),
        "GET",
        &format!("{base}/source-authority"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(authority["operation"]["state"], "prepared");
    assert_eq!(authority["team_snapshot"],f.hub.store.team("team",Some(2)).unwrap().unwrap());
    assert_eq!(authority["team_snapshot"]["id"],authority["authority"]["context_scope"]["team_id"]);
    assert_eq!(authority["team_snapshot"]["revision"],authority["authority"]["team_revision"]);
    assert_eq!(authority["team_snapshot"]["home_hub"],"home");
    if let Ok(path)=std::env::var("KODE_SCOPE_AUTHORITY_FIXTURE_EXPORT") {
        std::fs::write(path,serde_json::to_vec_pretty(&authority).unwrap()).unwrap();
    }
    assert_eq!(authority["dispatch_allowed"], false);
    let (status, claimed) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/inbox/claim"),
        Some(&token),
        Some(serde_json::to_value(&claim).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["new_claim"], true);
    assert_eq!(claimed["dispatch_allowed"], false);
    let path = format!(
        "{base}/inbox/{}/source?claim_id={}",
        claim.entry_id,
        claimed["receipt"]["entry"]["claim_id"].as_str().unwrap()
    );
    let (status, source) = call(f.hub.router(), "GET", &path, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(source["message"]["content"], "EXACT_NEW_INPUT_CANARY");
    assert_eq!(
        call(
            f.hub.router(),
            "GET",
            &format!("{base}/inbox/wrong/source?claim_id=wrong"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for path in [
        format!("{base}/dispatch"),
        format!("{PREFIX}/summary-approvals"),
        format!("{base}/tools"),
    ] {
        assert_eq!(
            call(f.hub.router(), "POST", &path, Some(OWNER), Some(json!({})))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
}
#[tokio::test]
async fn scoped_runtime_full_router_active_native_replay_foreign_and_revocation() {
    let (f, claim, binding, token) = prepared().await;
    let base = format!("{PREFIX}/contexts/{}", f.key);
    let (_, claimed) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/inbox/claim"),
        Some(&token),
        Some(serde_json::to_value(&claim).unwrap()),
    )
    .await;
    let entry = &claimed["receipt"]["entry"];
    let request = format!(
        "native:{:x}",
        Sha256::digest(
            json!([
                "native-turn-v1",
                entry["worker"]["session_id"],
                claim.journal_id,
                claim.entry_id,
                entry["claim_id"]
            ])
            .to_string()
            .as_bytes()
        )
    );
    let begin = json!({"request_id":request,"host_binding_id":binding["binding_id"],"context_key":f.key,"session_id":entry["worker"]["session_id"],"journal_id":claim.journal_id,"entry_id":claim.entry_id,"claim_id":entry["claim_id"],"source_message_id":entry["source_message_id"],"source_content_sha256":entry["source_content_sha256"],"manifest_sha256":binding["frozen"]["manifest_sha256"]});
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs"),
            Some(&token),
            Some(begin.clone())
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let op = f.hub.store.operation(&claim.operation_id).unwrap().unwrap();
    let command=serde_json::to_value(super::super::host_binding_tests::command(&op,false)).unwrap();
    let operation_path=format!("/api/v1/messaging/operations/{}",op.id);
    for t in [None,Some(OWNER),Some(f.session_token.as_str())] {
        assert_eq!(call(f.hub.router(),"POST",&operation_path,t,Some(command.clone())).await.0,
            if t.is_none(){StatusCode::UNAUTHORIZED}else{StatusCode::FORBIDDEN});
    }
    let (status,result)=call(f.hub.router(),"POST",&operation_path,Some(&token),Some(command)).await;
    assert_eq!(status,StatusCode::OK,"{result}");
    let active=f.hub.store.operation(&op.id).unwrap().unwrap();
    let (_, after) = call(
        f.hub.router(),
        "GET",
        &format!("{base}/source-authority"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(after["authority"]["operation_revision"], op.revision);
    assert_eq!(after["lease_observation"]["revision"], active.revision);
    for t in [Some(OWNER), Some(f.session_token.as_str())] {
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &format!("{base}/native-inputs"),
                t,
                Some(begin.clone())
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let mut wrong = begin.clone();
    wrong["source_message_id"] = json!("wrong");
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs"),
            Some(&token),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, result) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/native-inputs"),
        Some(&token),
        Some(begin.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["dispatch_allowed"], true);
    let id = result["admission_id"].as_str().unwrap();
    let (_, read) = call(
        f.hub.router(),
        "GET",
        &format!("{base}/native-requests/{request}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(read["admission_id"], id);
    assert_eq!(read["dispatch_allowed"], false);
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs"),
            Some(&token),
            Some(begin)
        )
        .await
        .1["dispatch_allowed"],
        false
    );
    let revoke =
        json!({"request_id":"revoke","binding_id":binding["binding_id"],"expected_revision":1});
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/host-binding/revoke"),
            Some(OWNER),
            Some(revoke)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            f.hub.router(),
            "GET",
            &format!("{base}/source-authority"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let outcome = json!({"request_id":"uncertain","admission_id":id,"outcome":{"kind":"uncertain","reason":"fictional interrupted driver"}});
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs/{id}/finish"),
            Some(OWNER),
            Some(outcome.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs/{id}/finish"),
            Some(&token),
            Some(outcome)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs/{id}/publish"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

fn complete_original(f: &Fixture, operation_id: &str, entry_id: &str) {
    let op = f.hub.store.operation(operation_id).unwrap().unwrap();
    let policy = op.selection_policy.as_ref().unwrap();
    let observation = |value: Option<String>| crate::messaging::selection_evidence::Observation {
        requested: value.clone(),
        status: if value.is_some() {
            crate::messaging::selection_evidence::Status::Reported
        } else {
            crate::messaging::selection_evidence::Status::Unverifiable
        },
        observed: value,
        source: Some("fictional-native-observation".into()),
    };
    f.hub
        .store
        .record_selection_evidence(crate::messaging::selection_evidence::Evidence {
            record_id: "selection".into(),
            operation_id: op.id.clone(),
            worker_session: op.worker.session_id.clone(),
            attempt: op.attempt,
            epoch: op.epoch,
            profile_revision: policy.profile_revision.clone(),
            thread_id: "native-thread".into(),
            turn_id: "native-turn".into(),
            input_ids: vec![entry_id.to_string()],
            scope: policy.scope.clone(),
            observed_at: now(),
            model: observation(Some(policy.model.clone())),
            effort: observation(policy.effort.clone()),
            rejected: false,
        })
        .unwrap();
    let reservation:String=f.hub.store.db.lock().query_row("SELECT reservation_id FROM operation_budget_bindings WHERE operation_id=?1 AND attempt=?2",rusqlite::params![op.id,op.attempt],|r|r.get(0)).unwrap();
    let revision: u64 = f
        .hub
        .store
        .db
        .lock()
        .query_row(
            "SELECT json_extract(body,'$.revision') FROM budget_reservations WHERE id=?1",
            [&reservation],
            |r| r.get(0),
        )
        .unwrap();
    f.hub
        .store
        .record_usage(
            crate::messaging::pricing::Usage {
                attribution: crate::messaging::pricing::Attribution::RequestedModel {
                    rerouted: false,
                    cache_write_input_tokens: 0,
                },
                event_id: "native-meter".into(),
                reservation_id: reservation,
                expected_revision: revision,
                model: policy.model.clone(),
                input_tokens: 100,
                output_tokens: 10,
                cached_input_tokens: 0,
            },
            now(),
        )
        .unwrap();
    let mut cmd = super::super::host_binding_tests::command(&op, true);
    cmd.action = crate::messaging::operations::Action::Report {
        report_id: "native-report".into(),
        content: "completed fixture turn".into(),
    };
    assert!(
        f.hub
            .store
            .command_operation(&op.id, cmd, now())
            .unwrap()
            .applied
    );
}
async fn native_body(f: &Fixture, claim: &Claim, binding: &Value, token: &str) -> Value {
    let base = format!("{PREFIX}/contexts/{}", f.key);
    let (status, claimed) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/inbox/claim"),
        Some(token),
        Some(serde_json::to_value(claim).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entry = &claimed["receipt"]["entry"];
    let request = format!(
        "native:{:x}",
        Sha256::digest(
            json!([
                "native-turn-v1",
                entry["worker"]["session_id"],
                claim.journal_id,
                claim.entry_id,
                entry["claim_id"]
            ])
            .to_string()
            .as_bytes()
        )
    );
    json!({"request_id":request,"host_binding_id":binding["binding_id"],"context_key":f.key,"session_id":entry["worker"]["session_id"],"journal_id":claim.journal_id,"entry_id":claim.entry_id,"claim_id":entry["claim_id"],"source_message_id":entry["source_message_id"],"source_content_sha256":entry["source_content_sha256"],"manifest_sha256":binding["frozen"]["manifest_sha256"]})
}
#[tokio::test]
async fn scoped_runtime_full_router_reported_finish_and_same_scope_publication() {
    let (f, claim, binding, token) = prepared().await;
    let base = format!("{PREFIX}/contexts/{}", f.key);
    let body = native_body(&f, &claim, &binding, &token).await;
    let op = f.hub.store.operation(&claim.operation_id).unwrap().unwrap();
    f.hub
        .store
        .command_operation(
            &op.id,
            super::super::host_binding_tests::command(&op, false),
            now(),
        )
        .unwrap();
    let (status, admitted) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/native-inputs"),
        Some(&token),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{admitted}");
    let id = admitted["admission_id"].as_str().unwrap();
    complete_original(&f, &claim.operation_id, &claim.entry_id);
    let finish = json!({"request_id":"finish","admission_id":id,"outcome":{"kind":"completed","usage_event_id":"native-meter","text":"only original thread"}});
    for t in [None, Some(OWNER), Some(f.session_token.as_str())] {
        let expected = if t.is_none() {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &format!("{base}/native-inputs/{id}/finish"),
                t,
                Some(finish.clone())
            )
            .await
            .0,
            expected
        );
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &format!("{base}/native-inputs/{id}/publish"),
                t,
                None
            )
            .await
            .0,
            expected
        );
    }
    let (status, result) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/native-inputs/{id}/finish"),
        Some(&token),
        Some(finish),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["state"], "outbox");
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs/{id}/publish"),
            Some(&token),
            Some(json!({"thread_id":"foreign"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, result) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/native-inputs/{id}/publish"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["new_publication"], true);
    let (_, replay) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/native-inputs/{id}/publish"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(replay["new_publication"], false);
    assert_eq!(replay["message_id"], result["message_id"]);
    let message: String = f
        .hub
        .store
        .db
        .lock()
        .query_row(
            "SELECT body FROM collaboration_messages WHERE id=?1",
            [result["message_id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    let message: Value = serde_json::from_str(&message).unwrap();
    assert_eq!(
        message["surface_id"],
        binding["frozen"]["context"]["surface_id"]
    );
    assert_eq!(
        message["thread_id"],
        binding["frozen"]["context"]["thread_id"]
    );
}
#[tokio::test]
async fn scoped_runtime_full_router_original_expiry_fences_old_epoch() {
    let (f, claim, binding, token) = prepared().await;
    let base = format!("{PREFIX}/contexts/{}", f.key);
    let body = native_body(&f, &claim, &binding, &token).await;
    let op = f.hub.store.operation(&claim.operation_id).unwrap().unwrap();
    let active = f
        .hub
        .store
        .command_operation(
            &op.id,
            super::super::host_binding_tests::command(&op, false),
            now(),
        )
        .unwrap()
        .operation;
    f.hub
        .store
        .expire_operations(active.lease_until.unwrap())
        .unwrap();
    assert!(f.hub.store.operation(&op.id).unwrap().unwrap().epoch > active.epoch);
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/native-inputs"),
            Some(&token),
            Some(body)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            f.hub.router(),
            "GET",
            &format!("{base}/source-authority"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
#[tokio::test]
async fn scoped_runtime_full_router_owner_preparation_has_no_worker_bypass() {
    let f = fixture_http();
    let path = format!("{PREFIX}/threads");
    for t in [None, Some(f.session_token.as_str())] {
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &path,
                t,
                Some(create_body("new-thread"))
            )
            .await
            .0,
            if t.is_none() {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::FORBIDDEN
            }
        );
    }
    let (status, created) = call(
        f.hub.router(),
        "POST",
        &path,
        Some(OWNER),
        Some(create_body("new-thread")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let key = created["context_key"].as_str().unwrap();
    let base = format!("{PREFIX}/contexts/{key}");
    assert_eq!(
        call(f.hub.router(), "GET", &base, Some(OWNER), None)
            .await
            .0,
        StatusCode::OK
    );
    let bundle = prepare(&f.hub.store, &format!("context-{key}"), "route-operation");
    let bind = serde_json::to_value(bind_input(&bundle)).unwrap();
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/control"),
            Some(&f.session_token),
            Some(bind.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/control"),
            Some(OWNER),
            Some(bind)
        )
        .await
        .0,
        StatusCode::OK
    );
    let message = f
        .hub
        .store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "owner-new-message".into(),
                expected_revision: 1,
                thread_id: Some(created["thread_id"].as_str().unwrap().into()),
                content: "Owner extra input".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let input = json!({"request_id":"owner-input","source_message_id":message["id"],"expected_content_sha256":hash("Owner extra input"),"explicitly_continue_stored":false});
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/inputs"),
            Some(&f.session_token),
            Some(input.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, input) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/inputs"),
        Some(OWNER),
        Some(input),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{input}");
    let enqueue = json!({"request_id":"enqueue","input_request_id":created["input_request_id"]});
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/inbox"),
            Some(&f.session_token),
            Some(enqueue.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{base}/inbox"),
            Some(OWNER),
            Some(enqueue)
        )
        .await
        .0,
        StatusCode::OK
    );
}
#[tokio::test]
async fn scoped_runtime_full_router_preserves_legacy_admin_claim() {
    let f=fixture_http();
    let op=f.hub.store.prepare_operation("legacy-owner","legacy-command",crate::messaging::model::Address {node_id:"home".into(),session_id:"legacy-worker".into()}).unwrap();
    let body=json!({"attempt":op.attempt,"epoch":op.epoch,"expected_revision":op.revision,"action":{"kind":"claim","lease_ms":30000}});
    let (status,result)=call(f.hub.router(),"POST",&format!("/api/v1/messaging/operations/{}",op.id),Some(OWNER),Some(body)).await;
    assert_eq!(status,StatusCode::OK,"{result}");assert_eq!(result["operation"]["state"],"active");
}
#[tokio::test]
async fn scoped_runtime_full_router_denies_provider_begin_but_preserves_late_accounting() {
    let (dir,store,begin,host)=super::super::call_tests::setup();
    let key=begin.prompt_provenance.as_ref().unwrap().scoped_call.as_ref().unwrap().context_key.clone();
    drop(store);let f=fixture_from_store(dir,key);
    let (status,denied)=call(f.hub.router(),"POST","/api/v1/messaging/official-calls",Some(OWNER),Some(serde_json::to_value(&begin).unwrap())).await;
    assert_eq!(status,StatusCode::FORBIDDEN,"{denied}");
    assert!(f.hub.store.official_call(&begin.call_id).unwrap().is_none());
    // Existing persisted compatibility calls still settle; no model is invoked.
    f.hub.store.begin_official_call(begin.clone(),now()).unwrap();
    f.hub.store.revoke_runtime_host(crate::messaging::runtime_host_enrollment::Revoke {request_id:"revoke-existing".into(),enrollment_id:host,expected_revision:1}).unwrap();
    let path=format!("/api/v1/messaging/official-calls/{}/events",begin.call_id);
    let usage=json!({"sequence":1,"kind":"usage","usage":{"input_tokens":1000000,"cached_input_tokens":0,"output_tokens":0,"cache_write_input_tokens":0},"reason":"fictional-late-usage"});
    let (status,receipt)=call(f.hub.router(),"POST",&path,Some(OWNER),Some(usage.clone())).await;
    assert_eq!(status,StatusCode::OK,"{receipt}");assert_eq!(receipt["call"]["accounting_status"],"estimated_pending_reconciliation");
    let mut finished=usage;finished["sequence"]=json!(2);finished["kind"]=json!("finished");
    let (status,receipt)=call(f.hub.router(),"POST",&path,Some(OWNER),Some(finished)).await;
    assert_eq!(status,StatusCode::OK,"{receipt}");assert_eq!(receipt["call"]["state"],"finished");
}
#[tokio::test]
async fn scoped_runtime_full_router_preserves_non_scoped_provider_begin() {
    let f=fixture_http();
    let op=f.hub.store.prepare_operation("legacy-owner","legacy-provider",crate::messaging::model::Address {node_id:"home".into(),session_id:"legacy-provider-worker".into()}).unwrap();
    let active=f.hub.store.command_operation(&op.id,crate::messaging::operations::Command {selection_ack:None,attempt:op.attempt,epoch:op.epoch,expected_revision:op.revision,action:crate::messaging::operations::Action::Claim {lease_ms:30000}},now()).unwrap().operation;
    let begin=json!({"call_id":"legacy-provider-call","operation_id":active.id,"attempt":active.attempt,"epoch":active.epoch,"worker_session":active.worker.session_id,"provider":"fixture-provider","model":"fixture-model"});
    let (status,receipt)=call(f.hub.router(),"POST","/api/v1/messaging/official-calls",Some(OWNER),Some(begin)).await;
    assert_eq!(status,StatusCode::OK,"{receipt}");assert_eq!(receipt["duplicate"],false);
}

#[tokio::test]
async fn scoped_runtime_full_router_publication_revoked_after_verified_finish() {
    let (f, claim, binding, token) = prepared().await;
    let base = format!("{PREFIX}/contexts/{}", f.key);
    let body = native_body(&f, &claim, &binding, &token).await;
    let op = f.hub.store.operation(&claim.operation_id).unwrap().unwrap();
    f.hub
        .store
        .command_operation(
            &op.id,
            super::super::host_binding_tests::command(&op, false),
            now(),
        )
        .unwrap();
    let (status, admitted) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/native-inputs"),
        Some(&token),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{admitted}");
    let id = admitted["admission_id"].as_str().unwrap();
    complete_original(&f, &claim.operation_id, &claim.entry_id);
    let finish = json!({"request_id":"finish","admission_id":id,"outcome":{"kind":"completed","usage_event_id":"native-meter","text":"only original thread"}});
    for t in [None, Some(OWNER), Some(f.session_token.as_str())] {
        let expected = if t.is_none() {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &format!("{base}/native-inputs/{id}/finish"),
                t,
                Some(finish.clone())
            )
            .await
            .0,
            expected
        );
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &format!("{base}/native-inputs/{id}/publish"),
                t,
                None
            )
            .await
            .0,
            expected
        );
    }
    let (status, result) = call(
        f.hub.router(),
        "POST",
        &format!("{base}/native-inputs/{id}/finish"),
        Some(&token),
        Some(finish),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["state"], "outbox");
    let revoke = json!({"request_id":"revoke-after-finish","binding_id":binding["binding_id"],"expected_revision":1});
    let (status, result) = call(f.hub.router(), "POST", &format!("{base}/host-binding/revoke"), Some(OWNER), Some(revoke)).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    for _ in 0..2 {
        let (status, _) = call(f.hub.router(), "POST", &format!("{base}/native-inputs/{id}/publish"), Some(&token), None).await;
        assert!(!status.is_success());
    }
    let count:u64 = f.hub.store.db.lock().query_row("SELECT count(*) FROM collaboration_messages WHERE kind='superagent_reply'", [], |r|r.get(0)).unwrap();
    assert_eq!(count, 0);
}
