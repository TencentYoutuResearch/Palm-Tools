//! Desktop view of the account's other devices.
//!
//! A signed-in desktop is also a viewer: it calls the relay's phone API
//! (`account-relay-protocol.md` § Phone API) with the account token, exactly
//! like the mobile app. Only the read/converse subset is exposed — no session
//! creation, deletion, mode or model changes on a foreign desktop.
//!
//! Every session call extends that desktop's viewing lease, so a remote
//! desktop streams only while this one is looking at it.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::cloud_sync::CloudSyncManager;

const DEVICE_HEADER: &str = "X-Kode-Device";

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// The account's devices; `self_device_id` names this desktop.
    Devices,
    Sessions { device_id: String },
    History { device_id: String, session_id: i64, from: Option<u64>, limit: Option<u32> },
    /// `op` is one of `input`, `interrupt`, `answer`, `plan_response`.
    Command { device_id: String, session_id: i64, op: String, body: Value },
}

const COMMAND_OPS: [&str; 4] = ["input", "interrupt", "answer", "plan_response"];

/// Relay method, path, target device and body for `request`.
fn route(request: Request) -> Result<(reqwest::Method, String, Option<String>, Option<Value>), String> {
    use reqwest::Method;
    Ok(match request {
        Request::Devices => (Method::GET, "/api/v1/account/devices".into(), None, None),
        Request::Sessions { device_id } => (Method::GET, "/api/v1/sessions".into(), Some(device_id), None),
        Request::History { device_id, session_id, from, limit } => (
            Method::GET,
            format!(
                "/api/v1/sessions/{session_id}/history?from={}&limit={}",
                from.unwrap_or(0),
                limit.unwrap_or(1000).clamp(1, 2000)
            ),
            Some(device_id),
            None,
        ),
        Request::Command { device_id, session_id, op, body } => {
            if !COMMAND_OPS.contains(&op.as_str()) {
                return Err(format!("unsupported device command: {op}"));
            }
            (Method::POST, format!("/api/v1/sessions/{session_id}/{op}"), Some(device_id), Some(body))
        }
    })
}

pub async fn call(manager: &CloudSyncManager, request: Request) -> Result<Value, String> {
    let devices = matches!(request, Request::Devices);
    let (method, path, device, body) = route(request)?;
    let (server_url, token, self_device_id) = manager.account_viewer().await?;
    let mut builder = http()
        .request(method.clone(), format!("{server_url}{path}"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30));
    if let Some(device) = device {
        builder = builder.header(DEVICE_HEADER, device);
    }
    if method == reqwest::Method::POST {
        builder = builder
            .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
            .json(&body.unwrap_or_else(|| json!({})));
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("cannot reach the account relay: {error}"))?;
    let status = response.status();
    let mut value: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(value["detail"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("account relay returned {status}")));
    }
    if devices && value.is_object() {
        value["self_device_id"] = json!(self_device_id);
    }
    Ok(value)
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: Value) -> Result<Request, serde_json::Error> {
        serde_json::from_value(value)
    }

    #[test]
    fn only_the_converse_subset_reaches_the_relay() {
        let (_, path, device, _) = route(parse(json!({"action":"history","device_id":"d","session_id":7})).unwrap()).unwrap();
        assert_eq!(path, "/api/v1/sessions/7/history?from=0&limit=1000");
        assert_eq!(device.as_deref(), Some("d"));
        let (method, path, _, _) = route(parse(json!({"action":"command","device_id":"d","session_id":7,"op":"input","body":{"text":"hi"}})).unwrap()).unwrap();
        assert_eq!((method, path.as_str()), (reqwest::Method::POST, "/api/v1/sessions/7/input"));
        for op in ["mode", "model", "../../bindings/current", ""] {
            let request = parse(json!({"action":"command","device_id":"d","session_id":7,"op":op,"body":{}})).unwrap();
            assert!(route(request).is_err(), "{op}");
        }
        assert!(parse(json!({"action":"delete","device_id":"d","session_id":7})).is_err());
        assert!(parse(json!({"action":"sessions","device_id":"d","path":"/api/v1/x"})).is_err());
    }
}
