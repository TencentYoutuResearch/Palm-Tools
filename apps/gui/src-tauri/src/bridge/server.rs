//! 启动 axum server 监听 0.0.0.0:47870(env `KODE_BRIDGE_PORT` 可覆盖)。
//!
//! 不阻塞 setup 钩子 — 后台 task。失败时只 log,不 panic。

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

pub const DEFAULT_PORT: u16 = 47870;
pub const ENV_PORT: &str = "KODE_BRIDGE_PORT";
pub const ENV_BIND: &str = "KODE_BRIDGE_BIND";
pub const ENV_DISABLE: &str = "KODE_BRIDGE_DISABLE";

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub bind: SocketAddr,
    pub disabled: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

impl BridgeConfig {
    pub fn from_env() -> Self {
        let port: u16 = std::env::var(ENV_PORT)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let host: Ipv4Addr = std::env::var(ENV_BIND)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(Ipv4Addr::UNSPECIFIED);
        let disabled = match std::env::var(ENV_DISABLE).ok().as_deref() {
            Some("1") | Some("true") | Some("yes") | Some("on") => true,
            _ => false,
        };
        Self {
            bind: SocketAddr::new(host.into(), port),
            disabled,
        }
    }
}

/// 后台启动 server。
pub fn spawn_bridge(ctx: Arc<kode_bridge::Ctx>, cfg: BridgeConfig) {
    if cfg.disabled {
        tracing::info!("bridge disabled by env");
        return;
    }
    tauri::async_runtime::spawn(async move {
        let router = kode_bridge::build_router(Arc::clone(&ctx));
        match bind_listener(cfg.bind).await {
            Ok((listener, used_fallback)) => {
                let actual = listener.local_addr().unwrap_or(cfg.bind);
                *ctx.listen_addr.lock() = Some(actual);
                if used_fallback {
                    tracing::warn!(requested = %cfg.bind, addr = %actual, "bridge port occupied; using fallback port");
                }
                tracing::info!(addr = %actual, "bridge listening");
                if let Err(e) = axum::serve(listener, router).await {
                    tracing::warn!(error = %e, "bridge server exited");
                }
                *ctx.listen_addr.lock() = None;
            }
            Err(e) => {
                tracing::warn!(addr = %cfg.bind, error = %e, "bridge bind failed");
            }
        }
    });
}

async fn bind_listener(bind: SocketAddr) -> std::io::Result<(tokio::net::TcpListener, bool)> {
    // 陷阱:绑 0.0.0.0:P 时,即使别的进程已经监听 127.0.0.1:P(如某些 VS Code
    // 扩展),内核也认为不冲突 —— bind(0.0.0.0:P) 成功,但所有发往 127.0.0.1:P 的
    // 连接会被路由给更具体的 loopback 监听者,我们的 server 静默收不到流量。
    // 因此非 loopback 绑定时,先显式探测 127.0.0.1:P 是否已被占用,被占则走 fallback。
    if bind.port() != 0 && !bind.ip().is_loopback() {
        let loopback = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), bind.port());
        match tokio::net::TcpListener::bind(loopback).await {
            Ok(probe) => {
                // 没被占 —— 立刻释放探测 listener,继续走正常绑定。
                drop(probe);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                // 127.0.0.1:P 已被别的进程占用 —— 直接换随机端口,避免被劫流量。
                let fallback = SocketAddr::new(bind.ip(), 0);
                return tokio::net::TcpListener::bind(fallback)
                    .await
                    .map(|listener| (listener, true));
            }
            Err(error) => return Err(error),
        }
    }
    match tokio::net::TcpListener::bind(bind).await {
        Ok(listener) => Ok((listener, false)),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && bind.port() != 0 => {
            let fallback = SocketAddr::new(bind.ip(), 0);
            tokio::net::TcpListener::bind(fallback)
                .await
                .map(|listener| (listener, true))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddr};

    use super::bind_listener;

    #[tokio::test]
    async fn occupied_port_falls_back_to_an_available_port() {
        let occupied = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let requested = occupied.local_addr().unwrap();

        let (listener, used_fallback) = bind_listener(requested).await.unwrap();

        assert!(used_fallback);
        assert_ne!(listener.local_addr().unwrap().port(), requested.port());
    }

    #[tokio::test]
    async fn available_port_is_used_without_fallback() {
        let requested = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 0);

        let (listener, used_fallback) = bind_listener(requested).await.unwrap();

        assert!(!used_fallback);
        assert_ne!(listener.local_addr().unwrap().port(), 0);
    }

    /// loopback 被别的进程占用时,绑 0.0.0.0 不能静默成功(否则流量被劫),
    /// 必须走 fallback 换端口。
    #[tokio::test]
    async fn unspecified_bind_falls_back_when_loopback_is_occupied() {
        // 模拟"VS Code 占了 127.0.0.1:P"。
        let occupied = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = occupied.local_addr().unwrap().port();
        let requested = SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port);

        let (listener, used_fallback) = bind_listener(requested).await.unwrap();

        assert!(used_fallback);
        assert_ne!(listener.local_addr().unwrap().port(), port);
    }
}
