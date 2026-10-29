//! Multi-device mirror and command isolation on one shared server.
use super::*;

#[tokio::test]
async fn independent_devices_share_server_without_sharing_sessions_or_commands() {
    let dir = tempfile::tempdir().unwrap();
    let state = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: "https://sync.example.com".into(),
    })
    .unwrap();
    let mut headers = Vec::new();
    let mut agents = Vec::new();
    let mut buses = Vec::new();
    for device in ["office", "home"] {
        {
            let db = state.inner.db.lock();
            db.execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES(?1,?1,?1,'device-token-hash',1,1)",
                [device],
            )
            .unwrap();
            db.execute(
                "INSERT INTO bindings(id,device_id,mobile_name,token_hash,scopes_json,created_at)
                 VALUES(?1,?1,'phone',?2,?3,1)",
                params![
                    device,
                    token_hash(device),
                    serde_json::to_string(&DEFAULT_SCOPES).unwrap()
                ],
            )
            .unwrap();
        }
        let mut auth = HeaderMap::new();
        auth.insert("Authorization", format!("Bearer {device}").parse().unwrap());
        headers.push(auth);
        let (tx, rx) = mpsc::unbounded_channel();
        state.inner.agents.lock().insert(
            device.into(),
            AgentConnection {
                connection_id: device.into(),
                tx,
            },
        );
        agents.push(rx);
        buses.push(state.mobile_bus(device).subscribe());
        // Same boot and local IDs must still produce separate cloud sessions.
        sync_session_snapshot(&state, device, "boot", vec![AgentSession {
            local_id: 7,
            dto: json!({"id":7,"backend_key":"codex","title":device,"status":"idle","tokens":{}}),
        }]).unwrap();
    }
    let mut ids = Vec::new();
    for (index, title) in ["office", "home"].iter().enumerate() {
        let Json(list) = list_sessions(axum::extract::State(state.clone()), headers[index].clone())
            .await
            .unwrap();
        assert_eq!(list["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(list["sessions"][0]["title"], *title);
        ids.push(list["sessions"][0]["id"].as_i64().unwrap());
        assert_eq!(buses[index].try_recv().unwrap().payload["title"], *title);
        assert!(buses[index].try_recv().is_err());
    }
    assert_ne!(ids[0], ids[1]);
    for index in 0..2 {
        let other = 1 - index;
        assert!(matches!(
            get_session(
                axum::extract::State(state.clone()),
                Path(ids[other]),
                headers[index].clone()
            )
            .await,
            Err(ApiError::NotFound(_))
        ));
        assert!(matches!(
            get_history(
                axum::extract::State(state.clone()),
                Path(ids[other]),
                Query(HistoryQuery {
                    from: None,
                    limit: None
                }),
                headers[index].clone()
            )
            .await,
            Err(ApiError::NotFound(_))
        ));
        assert!(matches!(
            dispatch_mobile_command(
                &state,
                ids[other],
                &headers[index],
                "input",
                json!({"text":"wrong device"})
            ),
            Err(ApiError::NotFound(_))
        ));
        assert!(agents[other].try_recv().is_err());
        let (status, _) = dispatch_mobile_command(
            &state,
            ids[index],
            &headers[index],
            "input",
            json!({"text":"selected device"}),
        )
        .unwrap();
        assert_eq!(status, StatusCode::ACCEPTED);
        assert!(matches!(
            agents[index].try_recv().unwrap(),
            ServerFrame::Command {
                local_session_id: 7,
                ..
            }
        ));
        assert!(agents[other].try_recv().is_err());
        // Drain this device's command receipt before verifying event fanout.
        assert_eq!(buses[index].try_recv().unwrap().kind, "command.status");
    }
    persist_agent_event(
        &state,
        "office",
        "boot",
        7,
        AgentEnvelope {
            protocol_version: "v1".into(),
            schema_version: 1,
            session_id: 7,
            ts: 42,
            kind: "message".into(),
            payload: json!({"role":"assistant","text":"office only"}),
        },
    )
    .unwrap();
    assert_eq!(buses[0].try_recv().unwrap().payload["text"], "office only");
    assert!(buses[1].try_recv().is_err());
    state.inner.agents.lock().remove("office");
    assert!(matches!(
        dispatch_mobile_command(
            &state,
            ids[0],
            &headers[0],
            "input",
            json!({"text":"offline"})
        ),
        Err(ApiError::Conflict(_))
    ));
    assert_eq!(
        dispatch_mobile_command(
            &state,
            ids[1],
            &headers[1],
            "input",
            json!({"text":"still online"})
        )
        .unwrap()
        .0,
        StatusCode::ACCEPTED
    );
    assert!(matches!(
        agents[1].try_recv().unwrap(),
        ServerFrame::Command { .. }
    ));
}

#[tokio::test]
async fn delete_session_dispatches_a_close_command_to_the_owning_desktop() {
    let dir = tempfile::tempdir().unwrap();
    let state = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: "https://sync.example.com".into(),
    })
    .unwrap();
    {
        let db = state.inner.db.lock();
        db.execute(
            "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
             VALUES('office','office','office','device-token-hash',1,1)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO bindings(id,device_id,mobile_name,token_hash,scopes_json,created_at)
             VALUES('office','office','phone',?1,?2,1)",
            params![
                token_hash("office"),
                serde_json::to_string(&DEFAULT_SCOPES).unwrap()
            ],
        )
        .unwrap();
    }
    let (tx, mut agent) = mpsc::unbounded_channel();
    state.inner.agents.lock().insert(
        "office".into(),
        AgentConnection {
            connection_id: "office".into(),
            tx,
        },
    );
    sync_session_snapshot(
        &state,
        "office",
        "boot",
        vec![AgentSession {
            local_id: 7,
            dto: json!({"id":7,"backend_key":"codex","title":"open","status":"idle","tokens":{}}),
        }],
    )
    .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer office".parse().unwrap());
    let Json(list) = list_sessions(axum::extract::State(state.clone()), headers.clone())
        .await
        .unwrap();
    let session_id = list["sessions"][0]["id"].as_i64().unwrap();
    let (status, _) = delete_session(
        axum::extract::State(state),
        Path(session_id),
        headers,
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(matches!(
        agent.try_recv().unwrap(),
        ServerFrame::Command {
            local_session_id: 7,
            ref kind,
            ..
        } if kind == "delete"
    ));
}
