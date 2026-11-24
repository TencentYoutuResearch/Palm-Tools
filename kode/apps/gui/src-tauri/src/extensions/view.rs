//! Extension session views as native child webviews of the main window.
//!
//! An iframe would put the extension's loopback origin in a third-party
//! context inside `tauri://`, where WebKit drops the cookies most local web
//! UIs (dsh included) exchange their startup token for. A child webview is a
//! top-level browsing context instead. The frontend owns layout: it reports
//! the rect of the session area and hides the view while a modal is open,
//! because native views always paint above the DOM.
//!
//! One webview per (extension, view) pair is shared by every tab using it;
//! switching tabs tells the page which session to show instead of loading a
//! new page.
//!
//! `embed.js` is the contract between Kode and the page: layout hints,
//! window dragging, `kodeHost.request` (view → host, delivered here as a
//! `kode-host://` navigation that never loads) and `extension_view_post`
//! (host → view).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

#[cfg(target_os = "windows")]
use kode_core::process::HideConsole;
use parking_lot::Mutex;
use serde::Deserialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use tokio::sync::Notify;

use super::manifest::SessionView;
use super::{app_version, host};

/// `{ extension, view, action, params }` from `kodeHost.request`.
pub const ACTION_EVENT: &str = "extension-view-action";
const ACTION_SCHEME: &str = "kode-host";
const EMBED_SCRIPT: &str = include_str!("embed.js");

#[derive(Default)]
pub struct Views {
    /// webview label → extension id, for cleanup when an extension goes away.
    labels: Mutex<HashMap<String, String>>,
    /// Pages still loading, by webview label. Their view stays off screen
    /// until the page is up, so nobody clicks into a half-built page.
    loading: Mutex<HashMap<String, Arc<Notify>>>,
}

/// Longest wait for a page before showing it anyway.
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
/// Where a loading view waits: off every screen, at its real size.
const OFF_SCREEN: LogicalPosition<f64> = LogicalPosition { x: -100_000.0, y: -100_000.0 };

impl Views {
    fn start_loading(&self, label: &str) -> Arc<Notify> {
        self.loading.lock().entry(label.to_string()).or_insert_with(|| Arc::new(Notify::new())).clone()
    }

    fn finish_loading(&self, label: &str) {
        if let Some(notify) = self.loading.lock().remove(label) {
            notify.notify_waiters();
        }
    }

    /// Resolve once `label`'s page has loaded (or at once if it is not loading).
    async fn wait_loaded(&self, label: &str) {
        let Some(notify) = self.loading.lock().get(label).cloned() else { return };
        let loaded = notify.notified();
        tokio::pin!(loaded);
        loaded.as_mut().enable();
        if !self.loading.lock().contains_key(label) {
            return;
        }
        if tokio::time::timeout(LOAD_TIMEOUT, loaded).await.is_err() {
            tracing::warn!(target: "extension", %label, "view page did not finish loading; showing it anyway");
            self.loading.lock().remove(label);
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn label(extension: &str, view: &str) -> String {
    // Labels allow only alphanumerics and `-/:_`.
    let clean = |s: &str| s.replace('.', "_");
    format!("ext-{}-{}", clean(extension), clean(view))
}

/// Show (creating on first use) an extension view at `rect`. `fragment` is
/// applied as the page's location hash, which is how views receive the
/// session to display.
#[tauri::command]
pub async fn extension_view_show(
    app: AppHandle,
    extension: String,
    view: String,
    rect: Rect,
    fragment: Option<String>,
) -> Result<(), String> {
    let label = label(&extension, &view);
    let position = LogicalPosition::new(rect.x, rect.y);
    let size = LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0));
    let existing = app.get_webview(&label);
    // Fast path for layout updates; a backend that restarted serves on a new
    // origin and the page has to follow it.
    let live = existing.as_ref().is_some_and(|webview| {
        let served = host(&app).ok().and_then(|h| h.backends.status(&extension)).map(|r| origin(&r.url));
        served.is_some() && served == webview.url().ok().map(|url| origin(url.as_str()))
    });
    let views = &app.state::<super::ExtensionHost>().views;
    if let (Some(webview), true) = (&existing, live) {
        // Its page may still be loading from an earlier show.
        views.wait_loaded(&label).await;
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        if let Some(fragment) = fragment {
            set_hash(&webview, &fragment)?;
        }
        webview.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let (contribution, running) = {
        let worker = app.clone();
        let extension = extension.clone();
        let view = view.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let host = host(&worker)?;
            let version = app_version(&worker);
            let (manifest, _) = host.active(&extension, &version).map_err(|e| format!("{e:#}"))?;
            let contribution = manifest
                .contributes
                .session_views
                .iter()
                .find(|v| v.id == view)
                .cloned()
                .ok_or_else(|| format!("{extension} has no view {view}"))?;
            let running = host.ensure_backend(&extension, &version)?;
            Ok((contribution, running))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let mut url = super::backend::validate_url(&running.url)?;
    if contribution.path != "/" {
        url.set_path(&contribution.path);
    }
    if let Some(fragment) = &fragment {
        url.set_fragment(Some(fragment));
    }
    if let Some(webview) = existing {
        views.start_loading(&label);
        webview.set_position(OFF_SCREEN).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        webview.navigate(url).map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        views.wait_loaded(&label).await;
        webview.set_position(position).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = app.get_window("main").ok_or("main window unavailable")?;
    let actions = app.clone();
    let (action_extension, action_view) = (extension.clone(), view.clone());
    let loads = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        // Let the page take file drops as plain HTML5 events, like in a browser.
        .disable_drag_drop_handler()
        .initialization_script(embed_script(&contribution))
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                loads.state::<super::ExtensionHost>().views.finish_loading(webview.label());
            }
        })
        // Loopback pages only; anything else opens in the system browser.
        .on_navigation(move |target| {
            if target.scheme() == ACTION_SCHEME {
                let params = target
                    .query_pairs()
                    .find(|(key, _)| key == "params")
                    .and_then(|(_, value)| serde_json::from_str::<serde_json::Value>(&value).ok())
                    .unwrap_or_default();
                let action = target.host_str().unwrap_or_default().to_string();
                tracing::info!(target: "extension", extension = %action_extension, %action, %params, "view action");
                let _ = actions.emit_to(
                    "main",
                    ACTION_EVENT,
                    serde_json::json!({"extension": action_extension, "view": action_view, "action": action, "params": params}),
                );
                return false;
            }
            let local = matches!(target.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
            if !local && matches!(target.scheme(), "http" | "https") {
                let _ = open_external(target.as_str());
            }
            local || target.scheme() == "about"
        });
    views.start_loading(&label);
    let webview = match window.add_child(builder, OFF_SCREEN, size) {
        Ok(webview) => webview,
        Err(error) => {
            views.finish_loading(&label);
            return Err(error.to_string());
        }
    };
    views.labels.lock().insert(label.clone(), extension);
    views.wait_loaded(&label).await;
    webview.set_position(position).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn extension_view_hide(app: AppHandle, extension: Option<String>) -> Result<(), String> {
    let host = host(&app)?;
    let labels: Vec<_> = host
        .views
        .labels
        .lock()
        .iter()
        .filter(|(_, owner)| extension.as_deref().is_none_or(|id| id == owner.as_str()))
        .map(|(label, _)| label.clone())
        .collect();
    for label in labels {
        if let Some(webview) = app.get_webview(&label) {
            // A hidden WKWebView still takes file drags over its frame, so
            // Finder drops never reach Kode's terminals. Move it out of the way;
            // show() puts it back in place before revealing it.
            webview.set_position(OFF_SCREEN).map_err(|e| e.to_string())?;
            webview.hide().map_err(|e| e.to_string())?;
        }
    }
    // A hidden view can still be the window's first responder (e.g. after its
    // TUI button), which would swallow typing meant for Kode's terminal.
    if let Some(main) = app.get_webview("main") {
        let _ = main.set_focus();
    }
    Ok(())
}

/// Run a host-authored script in a view. The frontend uses this to drive
/// views; it is never fed extension-provided strings.
#[tauri::command]
pub fn extension_view_eval(
    app: AppHandle,
    extension: String,
    view: String,
    script: String,
) -> Result<bool, String> {
    let Some(webview) = app.get_webview(&label(&extension, &view)) else {
        return Ok(false);
    };
    webview.eval(&script).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Deliver a message to a view (`kode-host` event; `toast` is drawn by the
/// bridge itself).
#[tauri::command]
pub fn extension_view_post(
    app: AppHandle,
    extension: String,
    view: String,
    message: serde_json::Value,
) -> Result<bool, String> {
    let Some(webview) = app.get_webview(&label(&extension, &view)) else {
        return Ok(false);
    };
    let message = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    webview
        .eval(format!("window.__kodeHostReceive && window.__kodeHostReceive({message})"))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

fn origin(url: &str) -> Option<String> {
    url::Url::parse(url).ok().map(|url| url.origin().ascii_serialization())
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn embed_script(view: &SessionView) -> String {
    let platform = platform();
    let mut attributes = serde_json::Map::new();
    for key in ["*", platform] {
        for (name, value) in view.html_attributes.get(key).into_iter().flatten() {
            attributes.insert(name.clone(), value.clone().into());
        }
    }
    let config = serde_json::json!({
        "platform": platform,
        "attributes": attributes,
        "drag": view.drag_region,
    });
    EMBED_SCRIPT.replace("__KODE_EMBED_CONFIG__", &config.to_string())
}

/// Close every view of an extension (disable, uninstall, restart).
pub fn close_extension(app: &AppHandle, extension: &str) {
    let Some(host) = app.try_state::<super::ExtensionHost>() else {
        return;
    };
    let labels: Vec<_> = {
        let mut labels = host.views.labels.lock();
        let owned: Vec<_> = labels
            .iter()
            .filter(|(_, owner)| owner.as_str() == extension)
            .map(|(label, _)| label.clone())
            .collect();
        for label in &owned {
            labels.remove(label);
        }
        owned
    };
    for label in labels {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
}

fn set_hash(webview: &tauri::Webview, fragment: &str) -> Result<(), String> {
    let literal = serde_json::to_string(fragment).map_err(|e| e.to_string())?;
    webview
        .eval(format!(
            "if (location.hash.slice(1) !== {literal}) location.hash = {literal};"
        ))
        .map_err(|e| e.to_string())
}

fn open_external(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("cmd").hide_console();
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url).spawn().map(|_| ())
}
