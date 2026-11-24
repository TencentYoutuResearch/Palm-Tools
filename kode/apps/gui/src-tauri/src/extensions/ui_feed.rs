//! Follows the backend's extension UI feed (badges and notifications raised
//! by extension backends while no page of theirs is open) and forwards it to
//! the frontend as `extension-ui`. The admin token stays in this process.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

pub const UI_EVENT: &str = "extension-ui";

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_secs(2);
        loop {
            match follow(&app).await {
                // A clean end means the backend restarted; reconnect promptly.
                Ok(()) => delay = Duration::from_secs(2),
                Err(error) => {
                    tracing::debug!(%error, "extension UI feed unavailable");
                    delay = (delay * 2).min(Duration::from_secs(60));
                }
            }
            tokio::time::sleep(delay).await;
        }
    });
}

async fn follow(app: &AppHandle) -> Result<(), String> {
    let (_, document, token) = crate::workbench_state::connection().await.map_err(|e| e.to_string())?;
    let base = document
        .strip_suffix("/workbench/documents/session-index")
        .ok_or("unexpected Kode backend address")?;
    // The shared client times out after seconds; this request lives for hours.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(format!("{base}/extensions/ui/stream"))
        .bearer_auth(token.trim())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("feed rejected: {}", response.status()));
    }
    let mut buffer = String::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..end + 2).collect();
            for message in parse_frame(&frame) {
                let _ = app.emit_to("main", UI_EVENT, message);
            }
        }
    }
    Ok(())
}

/// The JSON payloads of one SSE frame; keep-alive comments carry none.
fn parse_frame(frame: &str) -> Option<serde_json::Value> {
    let data: Vec<&str> = frame.lines().filter_map(|line| line.strip_prefix("data:")).map(str::trim_start).collect();
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data.join("\n")).ok()
}

#[cfg(test)]
mod tests {
    use super::parse_frame;

    #[test]
    fn frames_yield_their_json_and_comments_yield_nothing() {
        assert_eq!(parse_frame(": keep-alive\n\n"), None);
        assert_eq!(parse_frame("data: {\"type\":\"badge\",\"count\":2}\n\n").unwrap()["count"], 2);
        assert_eq!(parse_frame("data: not json\n\n"), None);
    }
}
