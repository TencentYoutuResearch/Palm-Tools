use std::{net::SocketAddr, path::PathBuf};

use kode_sync_server::{build_router, ServerConfig, ServerState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,kode_sync_server=debug")
            }),
        )
        .try_init();

    let bind: SocketAddr = std::env::var("KODE_SYNC_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".into())
        .parse()?;
    let database_path = PathBuf::from(
        std::env::var("KODE_SYNC_DATABASE").unwrap_or_else(|_| "/data/kode-sync.db".into()),
    );
    let public_url = std::env::var("KODE_SYNC_PUBLIC_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{}", bind.port()));
    let state = ServerState::open(ServerConfig {
        database_path,
        public_url,
    })?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "kode sync server listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
