//! Standalone entry for dsh users. Reuses the bridge runtime; never edits CLI hooks/settings.
use anyhow::{bail, Context, Result};
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let mut config = None;
    let mut token_file = None;
    let mut bind = "127.0.0.1:47870".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => config = args.next(),
            "--token-file" => token_file = args.next(),
            "--bind" => bind = args.next().context("--bind needs an address")?,
            "--help" => {
                println!("kode-session-server --config CONFIG.json --token-file TOKEN [--bind 127.0.0.1:47870]");
                return Ok(());
            }
            _ => bail!("unknown argument: {arg}"),
        }
    }
    let config: kode_bridge::messaging::Config =
        serde_json::from_slice(&std::fs::read(config.context("--config is required")?)?)?;
    let token = std::fs::read_to_string(token_file.context("--token-file is required")?)?
        .trim()
        .to_string();
    if token.len() < 32 {
        bail!("administrator token must contain at least 32 bytes")
    }
    let ctx = kode_bridge::build_runtime_ctx(kode_core::config::Config::load(), token);
    let hub = kode_bridge::messaging::Hub::open(config, &ctx)?;
    // The service owns messaging once; do not use the environment-enabled GUI attachment.
    let router = hub.router();
    hub.start();
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    println!(
        "kode-session-server {} {}",
        hub.node_id(),
        listener.local_addr()?
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    hub.shutdown();
    Ok(())
}
