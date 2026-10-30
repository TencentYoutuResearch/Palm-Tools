//! The GUI publishes its existing bridge into the shared service. No CLI is
//! resumed or spawned while projecting a running session.
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};

pub async fn call(path: &str, body: Option<Value>) -> Result<Value, String> {
    let (client, document, token) = crate::workbench_state::connection()
        .await
        .map_err(|e| e.to_string())?;
    let url = format!(
        "{}{path}",
        document.trim_end_matches("/workbench/documents/session-index")
    );
    let request = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    let response = request
        .bearer_auth(token.trim())
        .timeout(Duration::from_secs(50))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Kode backend request failed")
            .into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn integration_action(action: String, payload: Option<Value>) -> Result<Value, String> {
    match action.as_str() {
        "status" => Ok(
            json!({"settings":call("/integrations",None).await?,"cloud":call("/cloud/status",None).await?}),
        ),
        "configure" => call("/integrations", Some(payload.ok_or("Missing settings")?)).await,
        _ => Err("Unsupported integration action".into()),
    }
}

fn event_key(event: &kode_bridge::EventEnvelope) -> String {
    let bytes = serde_json::to_vec(event).unwrap_or_default();
    let hash = bytes.iter().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ (*byte as u64)).wrapping_mul(0x100000001b3)
    });
    format!("native:{hash:x}")
}

async fn publish(
    ctx: &Arc<kode_bridge::Ctx>,
    boot: &str,
    native: &mut HashMap<String, u64>,
    seen: &mut std::collections::HashSet<String>,
) -> Result<HashMap<u64, Value>, String> {
    let mut mapped = HashMap::new();
    let snapshots: Vec<_> = kode_bridge::cloud_sync::session_snapshots(ctx)
        .into_iter()
        .filter(|row| row["local_id"].as_u64().unwrap_or(0) < (1 << 40))
        .collect();
    let live: std::collections::HashSet<_> = snapshots
        .iter()
        .filter_map(|row| row["local_id"].as_u64())
        .collect();
    let saved = call("/runtime/sessions", None).await?;
    for row in saved["sessions"].as_array().into_iter().flatten() {
        if row["runtime"] != "gui" || row["status"] == "exited" {
            continue;
        }
        if row["native_process_id"].as_u64() != Some(std::process::id() as u64)
            && row["owner_alive"] != false
        {
            continue;
        }
        let id = row["native_runtime_id"].as_u64().unwrap_or(0);
        if live.contains(&id)
            || row["reserved_at"]
                .as_u64()
                .is_some_and(|at| kode_bridge::now_ms().saturating_sub(at) < 30000)
        {
            continue;
        }
        let mut dto = row.clone();
        dto["status"] = json!("exited");
        call("/runtime/publish", Some(json!({"runtime":"gui","boot_id":boot,"sessions":[{"session_id":row["runtime_session_id"],"dto":dto,"events":[]}]}))).await?;
        if let Some(key) = row["runtime_session_id"].as_str() {
            native.remove(key);
        }
    }
    if snapshots.is_empty() {
        call(
            "/runtime/publish",
            Some(json!({"runtime":"gui","boot_id":boot,"sessions":[]})),
        )
        .await?;
    }
    for snapshot in snapshots {
        let id = snapshot["local_id"]
            .as_u64()
            .ok_or("Missing GUI session identity")?;
        let mut dto = snapshot["dto"].clone();
        dto["runtime_backend_key"] = json!(format!(
            "gui:{}",
            dto["backend_key"].as_str().unwrap_or_default()
        ));
        dto["native_runtime_id"] = json!(id);
        dto["native_process_id"] = json!(std::process::id());
        let key = format!("gui:{}:{id}", std::process::id());
        native.insert(key.clone(), id);
        let events: Vec<_> = ctx
            .bus
            .history_for(id, 0, 1000)
            .into_iter()
            .filter(|event| kode_bridge::runtime::EVENT_KINDS.contains(&event.r#type.as_str()))
            .filter_map(|event| {
                let key = event_key(&event);
                (!seen.contains(&key))
                    .then(|| json!({"key":key,"kind":event.r#type,"payload":event.payload}))
            })
            .collect();
        for offset in (0..events.len().max(1)).step_by(128) {
            let chunk = &events[offset..events.len().min(offset + 128)];
            let value=call("/runtime/publish",Some(json!({"runtime":"gui","boot_id":boot,"sessions":[{"session_id":key,"dto":dto,"events":chunk}]}))).await?;
            for event in chunk {
                seen.insert(event["key"].as_str().unwrap_or_default().into());
            }
            let public_id = value["sessions"][0]["id"]
                .as_u64()
                .ok_or("Missing shared session identity")?;
            let mut public = dto.clone();
            public["id"] = json!(public_id);
            mapped.insert(id, public);
        }
    }
    Ok(mapped)
}

async fn execute(
    ctx: &Arc<kode_bridge::Ctx>,
    boot: &str,
    native: &mut HashMap<String, u64>,
    seen: &mut std::collections::HashSet<String>,
    command: &Value,
) -> Result<Value, String> {
    let kind = command["kind"].as_str().ok_or("Missing operation")?;
    let mut payload = command["payload"].clone();
    if matches!(
        kind,
        "backends" | "models" | "directories" | "create_session"
    ) {
        let catalog: kode_bridge::messaging::agents::Catalog =
            serde_json::from_value(call("/workbench/agents", None).await?)
                .map_err(|e| e.to_string())?;
        *ctx.agent_backends.write() = Some(catalog);
        if let Some(key) = payload["backend_key"]
            .as_str()
            .and_then(|key| key.strip_prefix("gui:"))
        {
            payload["backend_key"] = json!(key);
        }
        let (status, mut body) =
            kode_bridge::mobile_setup::execute(ctx.clone(), kind, payload).await;
        if status >= 400 {
            return Err(body["detail"]
                .as_str()
                .or_else(|| body["error"].as_str())
                .unwrap_or("GUI setup failed")
                .into());
        }
        if kind == "backends" {
            if let Some(rows) = body["backends"].as_array_mut() {
                for row in rows {
                    row["key"] = json!(format!("gui:{}", row["key"].as_str().unwrap_or_default()));
                    row["display_name"] = json!(format!(
                        "{} · Kode",
                        row["display_name"].as_str().unwrap_or("Agent")
                    ));
                }
            }
        }
        if kind == "create_session" {
            let id = body["id"]
                .as_u64()
                .ok_or("GUI creation did not return a session")?;
            body = publish(ctx, boot, native, seen)
                .await?
                .remove(&id)
                .ok_or("Created GUI session was not published")?;
        }
        return Ok(body);
    }
    let key = command["session_id"].as_str().ok_or("Missing session")?;
    let id = *native.get(key).ok_or("GUI session is no longer running")?;
    kode_bridge::cloud_sync::execute_local_command(ctx, id, kind, payload).await?;
    Ok(json!({"accepted":true}))
}

pub fn start(ctx: Arc<kode_bridge::Ctx>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error)=call("/runtime/publish",Some(json!({"runtime":"gui","boot_id":format!("gui-{}",std::process::id()),"sessions":[]}))).await {tracing::debug!(%error,"GUI runtime heartbeat unavailable");}
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        let boot = format!("gui-{}", std::process::id());
        let mut native = HashMap::new();
        let mut seen = std::collections::HashSet::new();
        let mut receipts = HashMap::<String, Value>::new();
        loop {
            let tick = async {
                publish(&ctx, &boot, &mut native, &mut seen).await?;
                let completed: Vec<_> = receipts
                    .iter()
                    .map(|(id, result)| (id.clone(), result.clone()))
                    .collect();
                for (id, result) in completed {
                    call(
                        "/runtime/settle",
                        Some(json!({"runtime":"gui","boot_id":boot,"id":id,"result":result})),
                    )
                    .await?;
                    receipts.remove(&id);
                }
                let batch = call(
                    "/runtime/claim",
                    Some(json!({"runtime":"gui","boot_id":boot})),
                )
                .await?;
                for command in batch["commands"].as_array().into_iter().flatten() {
                    let result = match execute(&ctx, &boot, &mut native, &mut seen, command).await {
                        Ok(value) => json!({"value":value}),
                        Err(error) => json!({"error":error}),
                    };
                    receipts.insert(
                        command["id"]
                            .as_str()
                            .ok_or("Missing command identity")?
                            .into(),
                        result,
                    );
                }
                Ok::<_, String>(())
            };
            if let Err(error) = tick.await {
                tracing::warn!(%error,"GUI runtime synchronization unavailable");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
}

#[tauri::command]
pub async fn shared_runtime_sessions() -> Result<Value, String> {
    call("/runtime/sessions", None).await
}
pub async fn shared_command(id: u64, kind: &str, mut payload: Value) -> Result<Value, String> {
    let request_id = payload
        .as_object_mut()
        .and_then(|value| value.remove("_client_request_id"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    call(
        "/runtime/command",
        Some(json!({"session_id":id,"kind":kind,"payload":payload,"request_id":request_id})),
    )
    .await
}
