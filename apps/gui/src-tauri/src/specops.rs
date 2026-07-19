//! SpecOps sidecar lifecycle.
//!
//! One workspace owns one `specops serve` child. The child is a regular process,
//! not a PTY session: stdout has a single structured ready line and HTTP carries
//! all subsequent traffic. Bridge credentials are passed only to the child env.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SpecOpsSession {
    pub origin: String,
    pub token: String,
    pub workspace: String,
}

#[derive(Debug, Deserialize)]
struct ReadyMessage {
    #[serde(rename = "type")]
    kind: String,
    protocol_version: u32,
    origin: String,
    token: String,
}

struct ManagedChild {
    child: Child,
    session: SpecOpsSession,
    /// Held open so the sidecar's stdin stays connected for this GUI's lifetime.
    /// The sidecar self-exits on stdin EOF; when this GUI process dies (normal
    /// exit, crash, or SIGKILL), the OS closes the pipe → the sidecar reads EOF
    /// → it exits on its own, even if `shutdown_all`/`Drop` never ran.
    stdin: Option<ChildStdin>,
}

impl ManagedChild {
    fn stop(&mut self) {
        // EOF lets the sidecar flush structured agent state and reap its ACP /
        // app-server children. Give that graceful path a short window before
        // using kill as a hard backstop.
        self.stdin.take();
        for _ in 0..20 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct SpecOpsManager {
    children: Mutex<HashMap<PathBuf, ManagedChild>>,
}

impl SpecOpsManager {
    pub fn open(
        &self,
        workspace: &Path,
        bridge_origin: &str,
        bridge_token: &str,
    ) -> Result<SpecOpsSession, String> {
        let workspace = std::fs::canonicalize(workspace)
            .map_err(|e| format!("invalid SpecOps workspace: {e}"))?;
        {
            let mut children = self.children.lock();
            if let Some(existing) = children.get_mut(&workspace) {
                match existing.child.try_wait() {
                    Ok(None) => return Ok(existing.session.clone()),
                    Ok(Some(_)) | Err(_) => {
                        existing.stop();
                        children.remove(&workspace);
                    }
                }
            }
        }

        // Reap orphan sidecars for this workspace before starting a fresh one.
        // The in-process `children` map only tracks sidecars WE own; a previous
        // GUI instance (e.g. a `tauri dev` run that was SIGKILLed on hot-reload,
        // or a crashed app) can leave a `specops serve --workspace <path>`
        // process still listening on the bridge. Those orphans each run their
        // own run-monitor and would each launchRun on the next action, spawning
        // duplicate worktrees/kode sessions. The stdin-EOF self-exit handles the
        // common case, but this is the belt-and-suspenders backstop.
        reap_orphan_sidecars(&workspace);

        // `init` is idempotent and also installs newly added built-in skills
        // into existing workspaces. Running it only for new configs leaves old
        // projects on stale workflow instructions.
        let output = specops_command()?
            .arg("init")
            .arg("--workspace")
            .arg(&workspace)
            .output()
            .map_err(|e| format!("failed to initialize SpecOps: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            // SpecOps CLI prints "<code>: <message>" on stderr for known errors.
            let hint = if detail.contains("not_git_workspace")
                || detail.contains("not a Git workspace")
            {
                "\n\nThe selected folder is not a Git repository. Run `git init` there first."
            } else if detail.contains("workspace_not_root")
                || detail.contains("must be the Git root")
            {
                "\n\nThe selected folder is inside a Git repo but not its root. Pick the repository root directory."
            } else {
                ""
            };
            return Err(format!(
                "specops init failed: {}{hint}",
                if detail.is_empty() {
                    format!("exit status {}", output.status)
                } else {
                    detail.to_string()
                },
            ));
        }

        let mut command = specops_command()?;
        command
            .arg("serve")
            .arg("--workspace")
            .arg(&workspace)
            .env("KODE_BRIDGE_URL", bridge_origin)
            .env("KODE_BRIDGE_TOKEN", bridge_token)
            // stdin is a held-open pipe (not null) so the sidecar can detect our
            // death via EOF and self-exit. See ManagedChild::stdin.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to start SpecOps: {e}"))?;

        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "SpecOps stdout unavailable".to_string())?;
        let stderr = child.stderr.take();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let result = reader
                .read_line(&mut line)
                .map_err(|e| e.to_string())
                .and_then(|count| {
                    if count == 0 {
                        Err("SpecOps exited before ready".to_string())
                    } else {
                        parse_ready(&line)
                    }
                });
            let _ = ready_tx.send(result);
            for line in reader.lines().map_while(Result::ok) {
                tracing::debug!(target: "specops", "{line}");
            }
        });
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    tracing::warn!(target: "specops", "{line}");
                }
            });
        }

        let ready = match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(ready)) => ready,
            Ok(Err(error)) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("SpecOps did not become ready within 10 seconds".into());
            }
        };
        let session = SpecOpsSession {
            origin: ready.origin,
            token: ready.token,
            workspace: workspace.to_string_lossy().into_owned(),
        };
        self.children.lock().insert(
            workspace,
            ManagedChild {
                child,
                session: session.clone(),
                stdin,
            },
        );
        Ok(session)
    }

    pub fn close(&self, workspace: &Path) -> Result<(), String> {
        let canonical = std::fs::canonicalize(workspace)
            .map_err(|e| format!("invalid SpecOps workspace: {e}"))?;
        if let Some(mut managed) = self.children.lock().remove(&canonical) {
            managed.stop();
        }
        Ok(())
    }

    /// 停掉所有 SpecOps 子进程。在 app 退出时调用,避免 sidecar 变成孤儿进程残留。
    /// Drop 在 Tauri/macOS 直接 exit 进程时不保证执行,所以必须在 RunEvent::Exit
    /// 里显式调这个。
    pub fn shutdown_all(&self) {
        let mut children = self.children.lock();
        for (_, mut managed) in children.drain() {
            managed.stop();
        }
    }
}

impl Drop for SpecOpsManager {
    fn drop(&mut self) {
        for (_, mut managed) in self.children.get_mut().drain() {
            managed.stop();
        }
    }
}

/// Kill orphan `specops serve --workspace <workspace>` processes left behind by
/// a previous GUI instance (crash / dev hot-reload SIGKILL). Best-effort: any
/// failure is logged and ignored — a missed orphan is not fatal (the new
/// sidecar still works), and we must never kill an unrelated process.
///
/// Matching is deliberately strict: the process command line must contain BOTH
/// `serve` and the exact canonical workspace path. codebuddy/claude agent
/// processes never match (they have no `serve --workspace <this path>` in argv).
/// macOS/Linux only; a no-op elsewhere.
fn reap_orphan_sidecars(workspace: &Path) {
    #[cfg(unix)]
    {
        let ws = workspace.to_string_lossy();
        let my_pid = std::process::id();
        // pgrep -f matches against the full command line. `specops` narrows to
        // our sidecar; we still re-verify each hit's argv before killing.
        let output = Command::new("pgrep").arg("-f").arg("specops").output();
        let Ok(output) = output else { return };
        let stdout = String::from_utf8_lossy(&output.stdout);
        for pid_str in stdout.split_whitespace() {
            let Ok(pid) = pid_str.parse::<u32>() else {
                continue;
            };
            if pid == my_pid {
                continue;
            }
            // Re-read the exact command line and require: a serve subcommand,
            // the --workspace flag, and this exact workspace path.
            let cmd = Command::new("ps")
                .arg("-o")
                .arg("command=")
                .arg("-p")
                .arg(pid_str)
                .output();
            let Ok(cmd) = cmd else { continue };
            let cmdline = String::from_utf8_lossy(&cmd.stdout);
            let cmdline = cmdline.trim();
            let is_specops_serve = cmdline.contains("serve")
                && cmdline.contains("--workspace")
                && cmdline.contains(ws.as_ref())
                && (cmdline.contains("specops") || cmdline.contains("main.js"));
            if !is_specops_serve {
                continue;
            }
            tracing::warn!(
                target: "specops",
                pid,
                workspace = %ws,
                "reaping orphan SpecOps sidecar before starting a fresh one"
            );
            // SIGTERM lets the sidecar close its HTTP server and children.
            let _ = Command::new("kill").arg(pid_str).output();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = workspace;
    }
}

fn parse_ready(line: &str) -> Result<ReadyMessage, String> {
    let ready: ReadyMessage = serde_json::from_str(line.trim())
        .map_err(|e| format!("invalid SpecOps ready message: {e}"))?;
    if ready.kind != "ready"
        || ready.protocol_version != 1
        || !ready.origin.starts_with("http://127.0.0.1:")
        || ready.token.len() < 32
    {
        return Err("incompatible or unsafe SpecOps sidecar; rebuild the SpecOps sidecar".into());
    }
    Ok(ready)
}

fn specops_command() -> Result<Command, String> {
    if let Some(binary) = std::env::var_os("KODE_SPECOPS_BIN") {
        return Ok(Command::new(binary));
    }

    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let is_app_bundle = current.to_string_lossy().contains(".app/Contents/MacOS/");

    // Debug builds should reflect `pnpm build` immediately. A sibling sidecar
    // can be stale because Tauri only refreshes it during its own build step.
    // A packaged debug app still uses its bundled sidecar so it has no Node
    // dependency and exercises the same discovery path as a release app.
    if cfg!(debug_assertions) && !is_app_bundle {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../specops/dist/cli/main.js");
        if script.is_file() {
            let mut command = Command::new("node");
            command.arg(script);
            return Ok(command);
        }
    }

    if let Some(parent) = current.parent() {
        let sidecar = parent.join("specops");
        if sidecar.is_file() {
            return Ok(Command::new(sidecar));
        }
        if let Ok(entries) = std::fs::read_dir(parent) {
            if let Some(sidecar) = entries.flatten().map(|entry| entry.path()).find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("specops-"))
                    && path.is_file()
            }) {
                return Ok(Command::new(sidecar));
            }
        }
    }
    Err("SpecOps sidecar is missing; rebuild or reinstall kode".into())
}

#[cfg(test)]
mod tests {
    use super::{parse_ready, specops_command};

    #[test]
    fn ready_message_requires_loopback_and_token() {
        let token = "a".repeat(64);
        let line = format!(
            r#"{{"type":"ready","protocol_version":1,"origin":"http://127.0.0.1:1234","token":"{token}"}}"#
        );
        let parsed = parse_ready(&line).unwrap();
        assert_eq!(parsed.origin, "http://127.0.0.1:1234");
        assert!(parse_ready(
            r#"{"type":"ready","protocol_version":1,"origin":"http://0.0.0.0:1","token":"short"}"#
        )
        .is_err());
        assert!(
            parse_ready(&format!(r#"{{"type":"ready","protocol_version":2,"origin":"http://127.0.0.1:1234","token":"{token}"}}"#)).is_err()
        );
    }

    #[test]
    fn debug_build_prefers_the_node_bundle_over_a_sibling_sidecar() {
        if !cfg!(debug_assertions) {
            return;
        }
        let command = specops_command().unwrap();
        assert_eq!(command.get_program(), "node");
        let script = command
            .get_args()
            .next()
            .expect("node command must include the SpecOps bundle");
        assert!(script
            .to_string_lossy()
            .ends_with("specops/dist/cli/main.js"));
    }
}
