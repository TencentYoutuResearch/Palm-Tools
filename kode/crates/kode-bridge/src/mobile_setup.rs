//! Allowlisted desktop operations for mobile session setup. Reuse the bridge
//! handlers; never expose an arbitrary HTTP proxy or CLI arguments to the relay.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MobileCreate {
    backend_key: String,
    cwd: Option<String>,
    model: Option<String>,
}

pub async fn execute(ctx: Arc<Ctx>, kind: &str, payload: Value) -> (u16, Value) {
    match execute_inner(ctx, kind, payload).await {
        Ok(value) => (200, value),
        Err(error) => {
            let response = error.into_response();
            let status = response.status().as_u16();
            let bytes = axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap_or_default();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(json!({"error":"internal"})),
            )
        }
    }
}

async fn execute_inner(ctx: Arc<Ctx>, kind: &str, payload: Value) -> Result<Value, ApiError> {
    match kind {
        "backends" => {
            let Json(mut value) = list_backends(Extension(ctx)).await;
            value["home"] = json!(dirs::home_dir().map(|path| path.to_string_lossy().into_owned()));
            Ok(value)
        }
        "models" => {
            let key = payload["backend_key"]
                .as_str()
                .ok_or_else(|| ApiError::BadRequest("backend_key is required".into()))?;
            let Json(result) = list_backend_models(Extension(ctx), Path(key.to_owned())).await?;
            serde_json::to_value(result).map_err(|e| ApiError::Internal(e.to_string()))
        }
        "directories" => {
            let path = payload["path"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().into_owned()))
                .ok_or_else(|| ApiError::BadRequest("path is required".into()))?;
            let show_hidden = payload["show_hidden"].as_bool().unwrap_or(false);
            // Directory enumeration must not block the socket/runtime worker.
            tokio::task::spawn_blocking(move || {
                let rt = tokio::runtime::Handle::current();
                rt.block_on(fs_list(Query(FsListQuery {
                    path,
                    show_hidden,
                    files: false,
                })))
                .map(|Json(value)| value)
            })
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?
        }
        "create_session" => {
            let req: MobileCreate =
                serde_json::from_value(payload).map_err(|e| ApiError::BadRequest(e.to_string()))?;
            let cfg = ctx
                .config
                .backend(&req.backend_key)
                .filter(|cfg| cfg.is_enabled() && backend_probe::which(&cfg.command).is_some())
                .ok_or_else(|| {
                    ApiError::BadRequest("Backend is unavailable on this desktop".into())
                })?;
            if req.model.as_ref().is_some_and(|m| !m.trim().is_empty()) && cfg.model_flag.is_none()
            {
                return Err(ApiError::BadRequest(
                    "Backend does not support model selection".into(),
                ));
            }
            let cwd = req
                .cwd
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .or_else(dirs::home_dir)
                .ok_or_else(|| ApiError::BadRequest("cwd is required".into()))?;
            if !cwd.is_absolute() || !cwd.is_dir() {
                return Err(ApiError::BadRequest(
                    "Working directory must be an existing absolute directory on the desktop"
                        .into(),
                ));
            }
            let Json(dto) = create_session(
                Extension(ctx),
                Json(CreateSessionReq {
                    transport: None,
                    backend_key: req.backend_key,
                    cols: None,
                    rows: None,
                    cwd: Some(cwd.to_string_lossy().into_owned()),
                    resume_session_uuid: None,
                    permission_mode: None,
                    model: req.model,
                    memory_context: None,
                    extra_args: None,
                    prompt: None,
                    headless: false,
                    term_theme: None,
                }),
            )
            .await?;
            serde_json::to_value(dto).map_err(|e| ApiError::Internal(e.to_string()))
        }
        _ => Err(ApiError::BadRequest(
            "Unsupported mobile setup operation".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn setup_validates_paths_and_preserves_model_and_session_visibility() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("project")).unwrap();
        std::fs::create_dir(dir.path().join(".hidden")).unwrap();
        std::fs::write(dir.path().join("file.txt"), "test").unwrap();
        let mut config = Config::default();
        let mut backend = config.backends["codex"].clone();
        backend.command = "/bin/sh".into();
        backend.args = vec!["-c".into(), "sleep 10".into()];
        config.backends.clear();
        config.backends.insert("demo".into(), backend);
        let ctx = build_test_ctx(config, "test-setup".into());
        let (status, catalogue) = execute(ctx.clone(), "backends", json!({})).await;
        assert_eq!(status, 200);
        assert_eq!(catalogue["backends"][0]["key"], "demo");
        let (status, listing) =
            execute(ctx.clone(), "directories", json!({"path":dir.path()})).await;
        assert_eq!(status, 200);
        assert_eq!(listing["entries"].as_array().unwrap().len(), 1);
        assert_eq!(listing["entries"][0]["name"], "project");
        let (status, listing) = execute(
            ctx.clone(),
            "directories",
            json!({"path":dir.path(),"show_hidden":true}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(listing["entries"].as_array().unwrap().len(), 2);
        for payload in [
            json!({"backend_key":"demo","cwd":"relative"}),
            json!({"backend_key":"demo","cwd":dir.path().join("file.txt")}),
            json!({"backend_key":"demo","cwd":dir.path().join("missing")}),
            json!({"backend_key":"missing","cwd":dir.path()}),
            json!({"backend_key":"demo","cwd":dir.path(),"permission_mode":"bypassPermissions"}),
            json!({"backend_key":"demo","cwd":dir.path(),"extra_args":["--unsafe"]}),
        ] {
            assert_eq!(execute(ctx.clone(), "create_session", payload).await.0, 400);
        }
        assert!(ctx.sessions.lock().is_empty());
        let mut events = ctx.bus.subscribe();
        let (status, dto) = execute(
            ctx.clone(),
            "create_session",
            json!({"backend_key":"demo","cwd":dir.path(),"model":"test-model"}),
        )
        .await;
        assert_eq!(status, 200, "{dto}");
        assert_eq!(dto["model"], "test-model");
        assert_eq!(dto["cwd"], dir.path().to_string_lossy().as_ref());
        let id = dto["id"].as_u64().unwrap();
        assert!(ctx.sessions.lock().contains_key(&id));
        assert!(events.try_recv().is_ok());
        kill_session(Extension(ctx), Path(id)).await.unwrap();
    }
}
