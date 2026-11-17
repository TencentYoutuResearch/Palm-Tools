use super::*;
const P: &str = "/api/v1/messaging/interactive-teams";
#[tokio::test]
async fn interactive_full_router_owner_only_and_same_scope_reply() {
    let (dir, store, input) = crate::messaging::collaboration::interactive_team_tests::fixture();
    drop(store);
    let f = fixture_from_store(dir, String::new());
    let body = serde_json::to_value(input).unwrap();
    for (token, status) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some(f.session_token.as_str()), StatusCode::FORBIDDEN),
    ] {
        assert_eq!(
            call(
                f.hub.router(),
                "POST",
                &format!("{P}/bindings"),
                token,
                Some(body.clone())
            )
            .await
            .0,
            status
        );
    }
    let (s, bound) = call(
        f.hub.router(),
        "POST",
        &format!("{P}/bindings"),
        Some(OWNER),
        Some(body),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{bound}");
    let b = &bound["binding"];
    let id = b["binding_id"].as_str().unwrap();
    for path in [
        format!("{P}/bindings/{id}"),
        format!(
            "{P}/by-native-session/{}",
            b["native_session_id"].as_str().unwrap()
        ),
    ] {
        assert_eq!(
            call(f.hub.router(), "GET", &path, Some(&f.session_token), None)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(f.hub.router(), "GET", &path, Some(OWNER), None)
                .await
                .1["binding"],
            bound["binding"]
        );
    }
    let claim = json!({"request_id":"claim","source_message_id":b["thread_id"]});
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &format!("{P}/bindings/{id}/sources/claim"),
            Some(&f.session_token),
            Some(claim.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (s, c) = call(
        f.hub.router(),
        "POST",
        &format!("{P}/bindings/{id}/sources/claim"),
        Some(OWNER),
        Some(claim),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{c}");
    let completion = json!({"request_id":"finish","receipt_id":c["receipt"]["receipt_id"],"native_session_id":b["native_session_id"],"journal_id":"journal","turn_id":"turn","header_sha256":"b".repeat(64),"source_marker_sha256":"c".repeat(64),"text":"Reply","text_sha256":hash("Reply")});
    let path = format!("{P}/bindings/{id}/sources/finish");
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &path,
            Some(&f.session_token),
            Some(completion.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (s, done) = call(f.hub.router(), "POST", &path, Some(OWNER), Some(completion)).await;
    assert_eq!(s, StatusCode::OK, "{done}");
    let path = format!(
        "{P}/bindings/{id}/outbox/{}/publish",
        done["outbox"]["outbox_id"].as_str().unwrap()
    );
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &path,
            Some(&f.session_token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            f.hub.router(),
            "POST",
            &path,
            Some(OWNER),
            Some(json!({"target":"foreign"}))
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (s, reply) = call(f.hub.router(), "POST", &path, Some(OWNER), Some(json!({}))).await;
    assert_eq!(s, StatusCode::OK, "{reply}");
    assert_eq!(reply["message"]["thread_id"], b["thread_id"]);
    assert_eq!(reply["message"]["actor"]["kind"], "interactive_participant");
    assert_eq!(
        call(f.hub.router(), "POST", &path, Some(OWNER), Some(json!({})))
            .await
            .1["new_publication"],
        false
    );
    assert_eq!(
        call(
            f.hub.router(),
            "GET",
            &format!("{P}/arbitrary-history"),
            Some(OWNER),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn interactive_send_http_freshness_is_response_only_and_selection_is_immutable() {
    let (dir, store, _) = crate::messaging::collaboration::interactive_team_tests::fixture();
    drop(store);
    let f = fixture_from_store(dir, String::new());
    let path = "/api/v1/messaging/collaboration/surfaces/channel/messages";
    let mut body = json!({"request_id":"composer","expected_revision":1,"thread_id":null,"content":"Exact Composer source","mentions":[],
        "interactive_selection":{"team_id":"team","team_revision":1,"participant_id":"coordinator","target_id":"target","workspace_id":"workspace","audience_revision":1}});
    let (s, first) = call(
        f.hub.router(),
        "POST",
        path,
        Some(OWNER),
        Some(body.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{first}");
    assert_eq!(first["newly_stored"], true);
    let (s, second) = call(
        f.hub.router(),
        "POST",
        path,
        Some(OWNER),
        Some(body.clone()),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(second["newly_stored"], false);
    let mut first_persisted = first.clone();
    first_persisted
        .as_object_mut()
        .unwrap()
        .remove("newly_stored");
    let mut second_persisted = second;
    second_persisted
        .as_object_mut()
        .unwrap()
        .remove("newly_stored");
    assert_eq!(first_persisted, second_persisted);
    let db = f.hub.store.db.lock();
    let stored: String = db
        .query_row(
            "SELECT body FROM collaboration_messages WHERE id=?1",
            [first["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    drop(db);
    assert_eq!(
        serde_json::from_str::<Value>(&stored).unwrap(),
        first_persisted
    );
    body["interactive_selection"]["target_id"] = json!("other-target");
    assert_ne!(
        call(
            f.hub.router(),
            "POST",
            path,
            Some(OWNER),
            Some(body.clone())
        )
        .await
        .0,
        StatusCode::OK
    );
    body["request_id"] = json!("stale-audience");
    body["interactive_selection"]["audience_revision"] = json!(2);
    assert_ne!(
        call(f.hub.router(), "POST", path, Some(OWNER), Some(body))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn team_configuration_acceptance_routes_are_owner_only() {
    let (dir, store, _) = crate::messaging::collaboration::interactive_team_tests::fixture();
    let mut spec = store.team("team", None).unwrap().unwrap()["spec"].clone();
    spec["purpose"] = json!("General development");
    let team = store
        .save_team(
            serde_json::from_value(
                json!({"id":"team","request_id":"save-v2","expected_revision":1,"spec":spec}),
            )
            .unwrap(),
        )
        .unwrap();
    drop(store);
    let f = fixture_from_store(dir, String::new());
    let path = "/api/v1/messaging/teams/team/configuration-acceptance";
    let body = json!({"request_id":"owner-confirm","expected_revision":2,"parent_accepted_revision":1,"spec":team["spec"]});
    for (token, status) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some(f.session_token.as_str()), StatusCode::FORBIDDEN),
    ] {
        for (method, path, payload) in [
            ("GET", path, None),
            ("POST", path, Some(body.clone())),
            (
                "GET",
                "/api/v1/messaging/teams/team/configuration-acceptance-requests/owner-confirm",
                None,
            ),
        ] {
            assert_eq!(
                call(f.hub.router(), method, path, token, payload).await.0,
                status
            );
        }
    }
    assert_eq!(
        call(f.hub.router(), "GET", path, Some(OWNER), None).await.1["accepted"],
        false
    );
    let (status, r) = call(f.hub.router(), "POST", path, Some(OWNER), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(r["team"], team);
    assert_eq!(
        call(f.hub.router(), "GET", path, Some(OWNER), None).await.1["accepted"],
        true
    );
}
