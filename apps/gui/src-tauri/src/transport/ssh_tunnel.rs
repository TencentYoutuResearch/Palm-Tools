//! Phase 11.7:本地 SSH 隧道 —— 借鉴 VS Code Remote 的「用 SSH 当传输通道」思路。
//!
//! GUI 起一个 `ssh -N -L <local>:127.0.0.1:<remote> <ssh_host>` 子进程,把远端
//! 只监听 `127.0.0.1` 的 kode-server 映射到本地一个动态端口。`RemoteTransport`
//! 随后连 `http://127.0.0.1:<local>`,协议层完全无感(见 remote.rs)。
//!
//! 为什么调系统 `ssh` 二进制而不是 russh:复用用户现成的 `~/.ssh/config`、key、
//! ssh-agent、known_hosts —— 零额外配置。代价是依赖宿主装了 ssh(macOS/Linux
//! 默认都有)。
//!
//! 生命周期:`SshTunnel` 被 `RemoteTransport` 持有;`Drop` 时 kill 子进程,
//! 避免 GUI 退出后残留 ssh 进程。

use std::io::ErrorKind;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// 一条活着的 SSH 本地端口转发隧道。
pub struct SshTunnel {
    child: Child,
    /// 动态分配的本地端口 —— `RemoteTransport` 用它拼 `http://127.0.0.1:<port>`。
    pub local_port: u16,
    /// 仅用于 log / 错误信息。
    ssh_host: String,
}

impl SshTunnel {
    /// 起隧道并阻塞等待本地端口可连(或超时报错)。
    ///
    /// - `ssh_host`:`user@remote` 或 `~/.ssh/config` 的 Host 别名
    /// - `ssh_port`:SSH 服务端口(默认 22;devcloud 等非标环境用 `-p <ssh_port>`)。
    ///   0 或 22 → 不加 `-p`,沿用 ssh 默认行为
    /// - `remote_port`:远端 kode-server 监听的端口(`-L local:127.0.0.1:<remote_port>`)
    ///
    /// 失败场景给清晰错误:ssh 二进制缺失 / 端口分配失败 / 隧道建立超时。
    pub fn spawn(ssh_host: &str, ssh_port: u16, remote_port: u16) -> Result<Self, String> {
        if ssh_host.trim().is_empty() {
            return Err("ssh_host is empty".into());
        }
        let local_port = pick_free_local_port().map_err(|e| format!("allocate local port: {e}"))?;

        // -N           不执行远端命令,只做端口转发
        // -T           不分配 TTY
        // -o ExitOnForwardFailure=yes   转发建立不了就让 ssh 退出(否则会僵着)
        // -o ServerAliveInterval=15 / CountMax=3   server 端 45s 无响应判定断线
        // -o BatchMode=yes  不交互式询问密码(隧道场景应走 key/agent;要密码就
        //                   立刻失败,而不是卡在 GUI 看不到的 stdin 上)
        let forward = format!("{local_port}:127.0.0.1:{remote_port}");
        let mut cmd = Command::new("ssh");
        cmd.arg("-N")
            .arg("-T")
            .arg("-o")
            .arg("ExitOnForwardFailure=yes")
            .arg("-o")
            .arg("ServerAliveInterval=15")
            .arg("-o")
            .arg("ServerAliveCountMax=3")
            .arg("-o")
            .arg("BatchMode=yes")
            // 连不上的 host 别让 ssh 默认 ~75s 才放弃 —— 8s 足够区分网络问题
            .arg("-o")
            .arg("ConnectTimeout=8");
        // 非标 SSH 端口(0 / 22 → 不加 -p,走 ssh 默认)
        if ssh_port != 0 && ssh_port != 22 {
            cmd.arg("-p").arg(ssh_port.to_string());
        }
        cmd.arg("-L").arg(&forward).arg(ssh_host);
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                if e.kind() == ErrorKind::NotFound {
                    "ssh binary not found in PATH (install OpenSSH client)".to_string()
                } else {
                    format!("spawn ssh: {e}")
                }
            })?;
        let mut tunnel = SshTunnel {
            child,
            local_port,
            ssh_host: ssh_host.to_string(),
        };

        // 轮询本地端口直到可连(隧道建立有几百 ms 延迟),最多等 10s。
        // 期间若 ssh 子进程已退出(认证失败 / host 不可达)→ 立刻报错,不空等。
        if let Err(e) = tunnel.wait_until_ready(Duration::from_secs(10)) {
            // 起失败要 kill,否则可能残留半死的 ssh
            let _ = tunnel.child.kill();
            return Err(e);
        }

        tracing::info!(
            ssh_host = %tunnel.ssh_host,
            local_port = tunnel.local_port,
            remote_port,
            "SSH tunnel established"
        );
        Ok(tunnel)
    }

    /// 轮询直到本地转发端口可 TCP 连接,或超时 / ssh 进程死。
    fn wait_until_ready(&mut self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let addr = format!("127.0.0.1:{}", self.local_port);
        loop {
            // ssh 进程已退出?认证 / 连接失败的典型表现。
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "ssh exited before tunnel was ready (status {status}); \
                         check host/key/agent for '{}'",
                        self.ssh_host
                    ));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("waitpid ssh: {e}")),
            }
            if std::net::TcpStream::connect_timeout(
                &addr.parse().map_err(|e| format!("bad local addr: {e}"))?,
                Duration::from_millis(300),
            )
            .is_ok()
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "tunnel to '{}' not ready within {:?}",
                    self.ssh_host, timeout
                ));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// 隧道是否还活着(ssh 子进程未退出)。`RemoteTransport` 重连前用它判断
    /// 要不要重起隧道。
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        // reap,避免 zombie。kill 后 wait 应立即返回。
        let _ = self.child.wait();
        tracing::debug!(ssh_host = %self.ssh_host, "SSH tunnel dropped");
    }
}

/// bind `127.0.0.1:0` 让 OS 分配空闲端口,拿到端口号后立即 drop listener。
/// 短暂的 TOCTOU 窗口(端口被别人抢)在实践中可忽略 —— 隧道紧接着就连上。
fn pick_free_local_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_free_local_port_returns_nonzero() {
        let p = pick_free_local_port().unwrap();
        assert!(p > 0);
    }

    #[test]
    fn pick_free_local_port_varies() {
        // 连续两次大概率不同(OS 递增分配);即便相同也不算错,这里只是冒烟。
        let a = pick_free_local_port().unwrap();
        let b = pick_free_local_port().unwrap();
        assert!(a > 0 && b > 0);
    }

    #[test]
    fn spawn_empty_host_errors() {
        // 不能用 unwrap_err()(SshTunnel 没实现 Debug),手动 match。
        match SshTunnel::spawn("", 22, 9870) {
            Ok(_) => panic!("expected error for empty host"),
            Err(e) => assert!(e.contains("empty"), "got: {e}"),
        }
    }

    /// 非标 SSH 端口:port=0 和 port=22 都不加 -p(走 ssh 默认),非 22 加 -p。
    /// 这里只验证 spawn 能拒绝空 host,无需真连接。
    #[test]
    fn spawn_empty_host_with_custom_ssh_port_errors() {
        match SshTunnel::spawn("", 36000, 9870) {
            Ok(_) => panic!("expected error for empty host"),
            Err(e) => assert!(e.contains("empty"), "got: {e}"),
        }
    }

    /// 用一个一定连不上的 host,验证不会无限挂起且能 kill 干净。
    /// 走 BatchMode=yes + ConnectTimeout=8 → ssh 8s 内放弃 → try_wait 捕获报错。
    ///
    /// `#[ignore]`:依赖真实 ssh + 网络栈超时行为,耗时约 8-10s 且环境相关,
    /// 不进常规 CI 套件。手动验证:`cargo test -- --ignored spawn_unreachable`。
    #[test]
    #[ignore]
    fn spawn_unreachable_host_fails_fast_and_cleans_up() {
        // RFC 5737 TEST-NET-1,保证不可路由;BatchMode 下 ssh 会很快放弃。
        // 给一个不存在的别名也行,这里用 IP 形式避免 DNS。
        let res = SshTunnel::spawn("nonexistent-user@192.0.2.1", 22, 9870);
        assert!(res.is_err(), "expected failure for unreachable host");
    }
}
