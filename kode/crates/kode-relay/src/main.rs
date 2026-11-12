use std::net::SocketAddr;

use std::sync::Arc;

use kode_relay::{
    build_router,
    identity::{JwksConfig, JwksVerifier},
    palm::Palm,
    palmx::{CloudServices, CustomLoginKey, Palmx},
    session::{MemoryStore, RestStore, Sessions},
    RelayState, RelayTimings,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // Container platforms (CloudBase 云托管 included) inject PORT.
    let bind: SocketAddr = match std::env::var("KODE_RELAY_BIND") {
        Ok(bind) => bind.parse()?,
        Err(_) => {
            let port = std::env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8080);
            SocketAddr::from(([0, 0, 0, 0], port))
        }
    };
    let issuer = std::env::var("KODE_RELAY_ISSUER").map_err(|_| {
        anyhow::anyhow!(
            "KODE_RELAY_ISSUER is required, e.g. https://<env-id>.api.tcloudbasegateway.com"
        )
    })?;
    let mut jwks = JwksConfig::cloudbase(&issuer);
    jwks.audience = std::env::var("KODE_RELAY_AUDIENCE")
        .ok()
        .filter(|aud| !aud.trim().is_empty());

    let mut state = RelayState::new(JwksVerifier::new(jwks), RelayTimings::default())
        .with_issuer(issuer.trim_end_matches('/'));
    // PalmX OAuth (PalmxApp, the platform-wide palm pool) is not offered:
    // Kode accounts live in Kode's own palm library. `Palmx` still carries
    // the shared CloudBase services.
    if let Some((_palmx, palm)) = palm_from_env(&issuer)? {
        tracing::info!(app_id = %palm.app_id, "palm sign-in enabled");
        state = state.with_palm(palm);
    }
    if let Some(sessions) = sessions_from_env(&issuer)? {
        state = state.with_sessions(sessions);
    }
    state.spawn_sweeper();
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, %issuer, "kode relay listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Per-device relay sessions need `KODE_RELAY_SESSION_SECRET` (at least 32
/// bytes). With the service key they persist in CloudBase; without it they
/// live in memory and end with the process, which only suits local runs.
fn sessions_from_env(issuer: &str) -> anyhow::Result<Option<Sessions>> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let Some(secret) = var("KODE_RELAY_SESSION_SECRET") else {
        tracing::warn!("KODE_RELAY_SESSION_SECRET is unset; clients keep provider sessions");
        return Ok(None);
    };
    let store: Arc<dyn kode_relay::session::SessionStore> = match var("KODE_RELAY_SERVICE_KEY") {
        Some(service_key) => Arc::new(RestStore::new(issuer, service_key)?),
        None => {
            tracing::warn!("no KODE_RELAY_SERVICE_KEY; relay sessions are kept in memory only");
            Arc::new(MemoryStore::default())
        }
    };
    tracing::info!("relay sessions enabled");
    Ok(Some(Sessions::new(secret.trim().as_bytes(), store)?))
}

/// Containers stop with SIGTERM; local runs with Ctrl-C.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// Palm sign-in needs four secrets; with any missing both palm methods stay
/// disabled and the relay keeps serving email sign-in. PalmX OAuth and the
/// in-app 1:N scan share the Palm app, its api_key and the CloudBase keys.
fn palm_from_env(issuer: &str) -> anyhow::Result<Option<(Palmx, Palm)>> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let (Some(app_id), Some(api_key), Some(custom_key), Some(service_key)) = (
        var("KODE_RELAY_PALMX_APP_ID"),
        var("KODE_RELAY_PALMX_API_KEY"),
        var("KODE_RELAY_CUSTOM_LOGIN_KEY"),
        var("KODE_RELAY_SERVICE_KEY"),
    ) else {
        return Ok(None);
    };
    let base =
        var("KODE_RELAY_PALMX_BASE").unwrap_or_else(|| "https://open.intl.palm.tencent.com".into());
    let sdk_url = var("KODE_RELAY_PALM_SDK_URL")
        .unwrap_or_else(|| format!("{base}/palm/x/jssdk/loader/palm-mobile-manager.js"));
    let key: CustomLoginKey = serde_json::from_str(&custom_key).map_err(|error| {
        anyhow::anyhow!("KODE_RELAY_CUSTOM_LOGIN_KEY is not the CloudBase key JSON: {error}")
    })?;
    let services = Arc::new(CloudServices::new(
        &base,
        api_key,
        issuer,
        key,
        service_key,
    )?);
    Ok(Some((
        Palmx::new(app_id.clone(), base, services.clone()),
        Palm::new(app_id, sdk_url, services),
    )))
}
