//! Multi-device mirror and command isolation on one shared server.
use super::*;

#[tokio::test]
async fn worker_display_name_survives_registration_and_hostname_updates() {
    let dir = tempfile::tempdir().unwrap();
    let database_path = dir.path().join("sync.db");
    {
        let db = Connection::open(&database_path).unwrap();
        db.execute_batch(
            "CREATE TABLE devices(
               id TEXT PRIMARY KEY,
               installation_id TEXT NOT NULL UNIQUE,
               name TEXT NOT NULL,
               token_hash TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               last_seen_at INTEGER NOT NULL,
               revoked_at INTEGER
             );",
        )
        .unwrap();
    }
    let state = ServerState::open(ServerConfig {
        database_path,
        public_url: "https://sync.example.com".into(),
    })
    .unwrap();
    let Json(first) = register_device(
        axum::extract::State(state.clone()),
        Json(RegisterDeviceReq {
            installation_id: "install".into(),
            name: "Kode Desktop".into(),
            hostname: Some("OFFICE-PC".into()),
            device_token: None,
        }),
    )
    .await
    .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        "Authorization",
        format!("Bearer {}", first.device_token.clone())
            .parse()
            .unwrap(),
    );
    let Json(renamed) = update_worker_profile(
        axum::extract::State(state.clone()),
        Path(first.device_id.clone()),
        headers.clone(),
        Json(UpdateWorkerProfileReq {
            display_name: "Office Windows".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(renamed["display_name"], "Office Windows");

    let _ = register_device(
        axum::extract::State(state.clone()),
        Json(RegisterDeviceReq {
            installation_id: "install".into(),
            name: "Kode Desktop".into(),
            hostname: Some("OFFICE-PC-NEW".into()),
            device_token: Some(first.device_token),
        }),
    )
    .await
    .unwrap();
    let Json(directory) = list_workers(axum::extract::State(state), headers)
        .await
        .unwrap();
    let worker = &directory["workers"][0];
    assert_eq!(worker["worker_id"], first.device_id);
    assert_eq!(worker["name"], "Office Windows");
    assert_eq!(worker["display_name"], "Office Windows");
    assert_eq!(worker["hostname"], "OFFICE-PC-NEW");
}

#[tokio::test]
async fn worker_directory_lists_same_server_workers_and_marks_the_viewer() {
    let dir = tempfile::tempdir().unwrap();
    let state = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: "https://sync.example.com".into(),
    })
    .unwrap();
    {
        let db = state.inner.db.lock();
        for worker in ["office", "home"] {
            db.execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES(?1,?1,?1,?2,1,1)",
                params![worker, token_hash(worker)],
            )
            .unwrap();
        }
    }
    for worker in ["office", "home"] {
        let (tx, _rx) = mpsc::unbounded_channel();
        state.inner.agents.lock().insert(
            worker.into(),
            AgentConnection {
                connection_id: worker.into(),
                tx,
                kode_version: Some("0.2.2-test".into()),
                os: Some(if worker == "office" { "macos" } else { "linux" }.into()),
                arch: Some("arm64".into()),
                capabilities: vec!["inventory.v1".into()],
            },
        );
    }
    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer office".parse().unwrap());
    let Json(directory) = list_workers(axum::extract::State(state), headers)
        .await
        .unwrap();
    let workers = directory["workers"].as_array().unwrap();
    assert_eq!(workers.len(), 2);
    assert_eq!(workers[0]["worker_id"], "home");
    assert_eq!(workers[0]["bound"], false);
    assert_eq!(workers[1]["worker_id"], "office");
    assert_eq!(workers[1]["bound"], true);
    assert_eq!(workers[1]["inventory_capable"], true);
}

#[tokio::test]
async fn desktop_monitor_binding_does_not_count_as_a_mobile_binding() {
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
             VALUES('office','office','office',?1,1,1)",
            [token_hash("office-token")],
        )
        .unwrap();
    }
    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer office-token".parse().unwrap());
    let Json(binding) = create_monitor_binding(
        axum::extract::State(state.clone()),
        axum::extract::Path("office".into()),
        headers,
    )
    .await
    .unwrap();
    assert_eq!(state.binding_count("office").unwrap(), 0);
    assert!(!state.sync_enabled("office").unwrap());
    let auth = state
        .mobile_auth(&binding.access_token, "workers.monitor")
        .unwrap();
    assert_eq!(auth.device_id, "office");
}

#[tokio::test]
async fn mobile_monitor_scope_routes_sessions_to_the_selected_worker() {
    let dir = tempfile::tempdir().unwrap();
    let state = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: "https://sync.example.com".into(),
    })
    .unwrap();
    {
        let db = state.inner.db.lock();
        for worker in ["office", "home"] {
            db.execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES(?1,?1,?1,?2,1,1)",
                params![worker, token_hash(worker)],
            )
            .unwrap();
        }
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
    for (worker, title) in [("office", "office session"), ("home", "home session")] {
        sync_session_snapshot(
            &state,
            worker,
            "boot",
            vec![AgentSession {
                local_id: 7,
                dto: json!({
                    "id": 7,
                    "backend_key": "codex",
                    "title": title,
                    "status": "idle",
                    "tokens": {}
                }),
            }],
        )
        .unwrap();
    }
    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer office".parse().unwrap());
    headers.insert("X-Kode-Worker-Id", "home".parse().unwrap());
    let Json(list) = list_sessions(axum::extract::State(state.clone()), headers)
        .await
        .unwrap();
    assert_eq!(list["sessions"][0]["title"], "home session");

    state
        .inner
        .db
        .lock()
        .execute(
            "UPDATE bindings SET scopes_json=?1 WHERE id='office'",
            [serde_json::to_string(&[
                "sessions.read",
                "sessions.content.read",
                "sessions.send",
            ])
            .unwrap()],
        )
        .unwrap();
    let mut legacy_headers = HeaderMap::new();
    legacy_headers.insert("Authorization", "Bearer office".parse().unwrap());
    legacy_headers.insert("X-Kode-Worker-Id", "home".parse().unwrap());
    let denied = list_sessions(axum::extract::State(state), legacy_headers).await;
    assert!(matches!(
        denied,
        Err(ApiError::Forbidden(message)) if message.contains("workers.monitor")
    ));
}

#[tokio::test]
async fn worker_inventory_rejects_legacy_and_cross_worker_access_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let state = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: "https://sync.example.com".into(),
    })
    .unwrap();
    {
        let db = state.inner.db.lock();
        for worker in ["office", "home"] {
            db.execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES(?1,?1,?1,?2,1,1)",
                params![worker, token_hash(worker)],
            )
            .unwrap();
        }
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    state.inner.agents.lock().insert(
        "home".into(),
        AgentConnection {
            connection_id: "home".into(),
            tx,
            kode_version: Some("0.1.0".into()),
            os: Some("linux".into()),
            arch: Some("x86_64".into()),
            capabilities: Vec::new(),
        },
    );
    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer home".parse().unwrap());
    let legacy = get_worker_inventory(
        axum::extract::State(state.clone()),
        Path("home".into()),
        headers.clone(),
    )
    .await;
    assert!(matches!(
        legacy,
        Err(ApiError::Conflict(message)) if message.contains("inventory.v1")
    ));
    let foreign = get_worker_inventory(
        axum::extract::State(state),
        Path("office".into()),
        headers,
    )
    .await;
    assert!(matches!(foreign, Err(ApiError::NotFound(_))));
}

#[tokio::test]
async fn worker_inventory_relays_a_typed_setup_result_to_an_online_worker() {
    let dir = tempfile::tempdir().unwrap();
    let state = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: "https://sync.example.com".into(),
    })
    .unwrap();
    *state.inner.allow_shared_inventory.lock() = true;
    {
        let db = state.inner.db.lock();
        for worker in ["office", "home"] {
            db.execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES(?1,?1,?1,?2,1,1)",
                params![worker, token_hash(worker)],
            )
            .unwrap();
        }
    }
    let (tx, mut agent) = mpsc::unbounded_channel();
    state.inner.agents.lock().insert(
        "home".into(),
        AgentConnection {
            connection_id: "home".into(),
            tx,
            kode_version: Some("0.2.2-test".into()),
            os: Some("linux".into()),
            arch: Some("x86_64".into()),
            capabilities: vec!["inventory.v1".into()],
        },
    );
    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer office".parse().unwrap());
    let request = tokio::spawn(get_worker_inventory(
        axum::extract::State(state.clone()),
        Path("home".into()),
        headers,
    ));
    let frame = agent.recv().await.unwrap();
    let ServerFrame::SetupRequest { request_id, kind, .. } = frame else {
        panic!("expected setup request");
    };
    assert_eq!(kind, "worker_inventory");
    mobile_setup::complete(
        &state,
        "home",
        &request_id,
        "boot",
        200,
        serde_json::json!({
            "worker": {"kode_version": "0.2.2-test"},
            "resources": {},
            "agents": [],
            "adb": {"available": false, "devices": []},
            "capabilities": ["inventory.v1"]
        }),
    )
    .unwrap();
    let response = request.await.unwrap().unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

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
                kode_version: Some("0.2.2-test".into()),
                os: Some("test".into()),
                arch: Some("arm64".into()),
                capabilities: vec!["inventory.v1".into()],
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
async fn session_management_dispatches_rename_and_delete_to_the_owning_desktop() {
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
            kode_version: Some("0.2.2-test".into()),
            os: Some("test".into()),
            arch: Some("arm64".into()),
            capabilities: vec!["inventory.v1".into()],
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
    let (status, _) = rename_session(
        axum::extract::State(state.clone()),
        Path(session_id),
        headers.clone(),
        Json(json!({"title":"renamed"})),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(matches!(
        agent.try_recv().unwrap(),
        ServerFrame::Command {
            local_session_id: 7,
            ref kind,
            ref payload,
            ..
        } if kind == "rename" && payload["title"] == "renamed"
    ));

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

#[tokio::test]
async fn offline_worker_sessions_are_removed_and_can_still_be_deleted() {
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
             VALUES('offline','offline','offline','device-token-hash',1,1)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO bindings(id,device_id,mobile_name,token_hash,scopes_json,created_at)
             VALUES('offline','offline','phone',?1,?2,1)",
            params![
                token_hash("offline"),
                serde_json::to_string(&DEFAULT_SCOPES).unwrap()
            ],
        )
        .unwrap();
    }
    sync_session_snapshot(
        &state,
        "offline",
        "boot",
        vec![AgentSession {
            local_id: 11,
            dto: json!({
                "id":11,
                "backend_key":"tcodex",
                "title":"stale",
                "status":"idle",
                "tokens":{}
            }),
        }],
    )
    .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer offline".parse().unwrap());
    let Json(list) = list_sessions(axum::extract::State(state.clone()), headers.clone())
        .await
        .unwrap();
    let session_id = list["sessions"][0]["id"].as_i64().unwrap();

    let (status, Json(receipt)) = delete_session(
        axum::extract::State(state.clone()),
        Path(session_id),
        headers.clone(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(receipt["status"], "executed");
    assert_eq!(receipt["offline_cleanup"], true);

    let Json(list) = list_sessions(axum::extract::State(state), headers)
        .await
        .unwrap();
    assert!(list["sessions"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn disconnect_expires_every_live_session_for_that_worker() {
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
             VALUES('worker','worker','worker','hash',1,1)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO bindings(id,device_id,mobile_name,token_hash,scopes_json,created_at)
             VALUES('worker','worker','phone',?1,?2,1)",
            params![
                token_hash("worker"),
                serde_json::to_string(&DEFAULT_SCOPES).unwrap()
            ],
        )
        .unwrap();
    }
    let sessions = [21, 22]
        .into_iter()
        .map(|local_id| AgentSession {
            local_id,
            dto: json!({
                "id":local_id,
                "backend_key":"tcodex",
                "title":format!("session-{local_id}"),
                "status":"idle",
                "tokens":{}
            }),
        })
        .collect();
    sync_session_snapshot(&state, "worker", "boot", sessions).unwrap();
    expire_worker_sessions(&state, "worker", None).unwrap();

    let mut headers = HeaderMap::new();
    headers.insert("Authorization", "Bearer worker".parse().unwrap());
    let Json(list) = list_sessions(axum::extract::State(state), headers)
        .await
        .unwrap();
    assert!(list["sessions"].as_array().unwrap().is_empty());
}
