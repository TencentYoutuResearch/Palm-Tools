//! Owned stdio facade for the existing Kode OpenSSH tunnel. EOF releases it.
use anyhow::{bail, Result};
use kode_bridge::messaging::{SshConfig, SshTunnel};
use std::io::{BufRead, Write};

#[tokio::main]
async fn main() -> Result<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if tx.blocking_send(line).is_err() {
                break;
            }
        }
    });
    let Some(line) = rx.recv().await else {
        bail!("missing tunnel configuration")
    };
    let config: SshConfig = serde_json::from_str(&line?)?;
    let mut tunnel = SshTunnel::start(&config).await?;
    println!("{}", serde_json::json!({ "url": tunnel.url }));
    std::io::stdout().flush()?;
    // A parent crash closes stdin. No detached forwarding process survives it.
    tokio::select! { _ = rx.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
    tunnel.close().await;
    Ok(())
}
