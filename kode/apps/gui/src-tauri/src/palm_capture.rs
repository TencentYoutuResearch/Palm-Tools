//! Kode's own 1:N palm scan on this Mac: a window shows the account relay's
//! `/palm/capture` page, which runs Palm's H5 SDK against the camera.
//!
//! The page is fetched here and served from a one-shot loopback origin
//! (`http://127.0.0.1:<port>`, a secure context for the camera) instead of
//! being opened from the relay: CloudBase test domains interpose a notice
//! page on browser navigations. The page gets no IPC. It reports by
//! navigating to `kodepalm://result#<json>`, which `on_navigation` intercepts
//! and never loads; only the loopback origin, the SDK origin and `about:` may
//! load. WebKit asks the user for camera access per origin.
//! The SDK records with MediaRecorder and picks its format from the user
//! agent, so the window presents a Safari UA.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;
use url::Url;

const LABEL: &str = "palm-capture";
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(180);
/// Result code the page uses for "cancelled"; also used when the window closes.
const CANCELLED: i64 = 10002;

/// The capture page URL for a relay, rejecting anything but HTTPS (or
/// loopback HTTP in development).
fn capture_url(server_url: &str, app_id: &str, locale: &str) -> Result<Url, String> {
    let mut url = Url::parse(server_url.trim()).map_err(|_| "invalid account relay URL".to_string())?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) || url.host_str().is_none() {
        return Err("the account relay must use HTTPS".into());
    }
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("the relay published an invalid palm app id".into());
    }
    url.set_path("/palm/capture");
    url.set_fragment(None);
    url.query_pairs_mut()
        .clear()
        .append_pair("mode", "recognition")
        .append_pair("app_id", app_id)
        .append_pair("lang", locale);
    Ok(url)
}

/// Decodes `kodepalm://result#<percent-encoded json>`.
fn parse_result(url: &Url) -> Option<Value> {
    if url.scheme() != "kodepalm" {
        return None;
    }
    let encoded = url.fragment()?;
    let decoded = percent_decode(encoded)?;
    serde_json::from_str::<Value>(&decoded).ok().filter(Value::is_object)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Opens the capture window and waits for its result:
/// `{code, message, data:{sessionId,…}}`. Closing the window is code 10002.
#[tauri::command]
pub async fn palm_capture(
    app: AppHandle,
    server_url: String,
    app_id: String,
    sdk_origin: Option<String>,
    locale: Option<String>,
) -> Result<Value, String> {
    let url = capture_url(&server_url, &app_id, locale.as_deref().unwrap_or("zh-CN"))?;
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.set_focus();
        return Err("a palm scan is already open".into());
    }
    let html = fetch_page(&url).await?;
    let sdk_origin = sdk_origin.or_else(|| loader_url(&html));
    let (local, server) = serve_once(html, &url).await?;
    let relay_origin = local.origin().ascii_serialization();
    // The SDK runs in its own frame from the loader's origin; without it
    // allowed the frame never loads and the camera never starts.
    let sdk_origin = sdk_origin
        .and_then(|raw| Url::parse(&raw).ok())
        .filter(|sdk| sdk.scheme() == "https")
        .map(|sdk| sdk.origin().ascii_serialization())
        .ok_or("the palm page names no SDK origin")?;

    let (tx, rx) = oneshot::channel::<Value>();
    let slot = Arc::new(Mutex::new(Some(tx)));
    let on_result = slot.clone();
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(local))
        .title("Kode · Palm")
        .inner_size(480.0, 720.0)
        .resizable(false)
        .user_agent(SAFARI_UA)
        .on_navigation(move |candidate| {
            if let Some(result) = parse_result(candidate) {
                if let Some(tx) = on_result.lock().take() {
                    let _ = tx.send(result);
                }
                return false;
            }
            let origin = candidate.origin().ascii_serialization();
            matches!(candidate.scheme(), "about" | "blob" | "data")
                || origin == relay_origin
                || origin == sdk_origin
        })
        .build()
        .map_err(|error| {
            server.abort();
            format!("could not open the palm scan window: {error}")
        })?;
    let on_close = slot.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(tx) = on_close.lock().take() {
                let _ = tx.send(json!({"code": CANCELLED, "message": "closed"}));
            }
        }
    });

    let result = tokio::time::timeout(CAPTURE_TIMEOUT, rx).await;
    let _ = window.close();
    server.abort();
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Ok(json!({"code": CANCELLED, "message": "closed"})),
        Err(_) => Ok(json!({"code": 10008, "message": "palm capture did not finish in time"})),
    }
}

/// The SDK loader the relay wrote into the page (`var LOADER = '…'`).
fn loader_url(html: &str) -> Option<String> {
    let start = html.find("var LOADER = '")? + "var LOADER = '".len();
    let end = html[start..].find('\'')?;
    Some(html[start..start + end].to_string())
}

async fn fetch_page(url: &Url) -> Result<String, String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?
        .get(url.as_str())
        .send()
        .await
        .map_err(|error| format!("cannot reach the account relay: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("the account relay returned {}", response.status()));
    }
    let html = response.text().await.map_err(|error| error.to_string())?;
    if !html.contains("PalmMobileManager") {
        return Err("the account relay did not return the palm page".into());
    }
    Ok(html)
}

/// Serves `html` for every GET on a fresh loopback port until aborted, and
/// returns the page URL with the original query.
async fn serve_once(html: String, original: &Url) -> Result<(Url, tokio::task::JoinHandle<()>), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("could not start the palm page: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let mut local = Url::parse(&format!("http://127.0.0.1:{port}/palm/capture")).expect("loopback url");
    local.set_query(original.query());
    let body = Arc::new(html);
    let server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let body = body.clone();
            tokio::spawn(async move {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    Ok((local, server))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_urls_require_tls_and_a_clean_app_id() {
        let url = capture_url("https://relay.example.com/x?y=1#z", "app_1", "en").unwrap();
        assert_eq!(url.as_str(), "https://relay.example.com/palm/capture?mode=recognition&app_id=app_1&lang=en");
        assert!(capture_url("http://relay.example.com", "app_1", "en").is_err());
        assert!(capture_url("http://127.0.0.1:8080", "app_1", "en").is_ok());
        assert!(capture_url("https://relay.example.com", "app&x=1", "en").is_err());
    }

    #[test]
    fn results_come_only_from_the_kodepalm_scheme() {
        let json = r#"{"code":0,"data":{"sessionId":"s 1"}}"#;
        let encoded: String = json
            .bytes()
            .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect();
        let url = Url::parse(&format!("kodepalm://result#{encoded}")).unwrap();
        assert_eq!(parse_result(&url).unwrap()["data"]["sessionId"], "s 1");
        let https = Url::parse(&format!("https://relay.example.com/#{encoded}")).unwrap();
        assert!(parse_result(&https).is_none());
        assert!(parse_result(&Url::parse("kodepalm://result#garbage").unwrap()).is_none());
    }

    #[tokio::test]
    async fn the_page_is_served_from_loopback_with_its_query() {
        let original = Url::parse("https://relay.example.com/palm/capture?mode=recognition&app_id=a").unwrap();
        let (local, server) = serve_once("<html>PalmMobileManager</html>".into(), &original).await.unwrap();
        assert_eq!(local.host_str(), Some("127.0.0.1"));
        assert_eq!(local.query(), Some("mode=recognition&app_id=a"));
        let body = reqwest::get(local.as_str()).await.unwrap().text().await.unwrap();
        assert_eq!(body, "<html>PalmMobileManager</html>");
        server.abort();
    }

    #[test]
    fn the_sdk_origin_is_read_from_the_page() {
        let html = "<script>var LOADER = 'https://palm.example.com/x/loader.js';</script>";
        assert_eq!(loader_url(html).as_deref(), Some("https://palm.example.com/x/loader.js"));
        assert_eq!(loader_url("<html></html>"), None);
    }
}
