//! OpenSSH transport only. This module never replays a runtime action.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "port")]
    pub port: u16,
    pub remote_port: u16,
    pub config_file: Option<std::path::PathBuf>,
}
fn port() -> u16 {
    22
}
impl SshConfig {
    pub fn validate(&self) -> Result<()> {
        if self.host.is_empty()
            || self.host.starts_with('-')
            || self.host.len() > 255
            || self
                .host
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
            || self.port == 0
            || self.remote_port == 0
        {
            bail!("invalid SSH configuration")
        }
        Ok(())
    }
}
pub struct Tunnel {
    child: Child,
    pub url: String,
}
impl Tunnel {
    pub async fn start(config: &SshConfig) -> Result<Self> {
        config.validate()?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let local_port = listener.local_addr()?.port();
        drop(listener);
        let mut command = Command::new("ssh");
        if let Some(path) = &config.config_file {
            command.arg("-F").arg(path);
        }
        let mut child = command
            .args([
                "-N",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ConnectTimeout=8",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-p",
                &config.port.to_string(),
                "-L",
                &format!("127.0.0.1:{local_port}:127.0.0.1:{}", config.remote_port),
                &config.host,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        for _ in 0..100 {
            if child.try_wait()?.is_some() {
                bail!("SSH tunnel exited before becoming ready")
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", local_port))
                .await
                .is_ok()
            {
                return Ok(Self {
                    child,
                    url: format!("http://127.0.0.1:{local_port}"),
                });
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = child.kill().await;
        bail!("SSH tunnel startup timed out")
    }
    pub async fn close(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}
