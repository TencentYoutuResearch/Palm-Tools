//! Extension backend processes.
//!
//! Same contract as the SpecOps sidecar: one JSON ready line on stdout, and
//! the child exits when its held-open stdin reaches EOF, so a crashed or
//! killed GUI never leaves extension servers behind. Before it is ready a
//! backend may print progress lines
//! (`{"type":"kode.extension.progress","message":..,"step":1,"total":3}`),
//! which Kode shows while the user waits. Other stdout/stderr lines are kept
//! in a short ring buffer for the Extensions settings page.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::manifest::Manifest;

const READY_TYPE: &str = "kode.extension.ready";
const PROGRESS_TYPE: &str = "kode.extension.progress";
const LOG_LINES: usize = 200;

#[derive(Clone, Debug, Serialize)]
pub struct Running {
    /// Origin plus any path/query the backend wants views to start from.
    pub url: String,
    pub pid: u32,
}

/// Startup progress reported by a backend before it is ready.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Progress {
    pub message: String,
    #[serde(default)]
    pub step: Option<u32>,
    #[serde(default)]
    pub total: Option<u32>,
}

#[derive(Deserialize)]
struct ProgressLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(flatten)]
    progress: Progress,
}

#[derive(Deserialize)]
struct Ready {
    #[serde(rename = "type")]
    kind: String,
    protocol_version: u32,
    url: String,
}

struct Managed {
    child: Child,
    stdin: Option<ChildStdin>,
    running: Running,
}

impl Managed {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn stop(&mut self) {
        // EOF first: dsh and friends flush session state and reap their own
        // agent children on a graceful exit.
        self.stdin.take();
        for _ in 0..80 {
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
pub struct Backends {
    running: Mutex<HashMap<String, Managed>>,
    /// Serializes start per extension so two views opening at once share one
    /// child instead of racing two.
    starting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    logs: Mutex<HashMap<String, Arc<Mutex<VecDeque<String>>>>>,
}

pub struct Launch<'a> {
    pub manifest: &'a Manifest,
    pub dir: &'a Path,
    pub data_dir: &'a Path,
    pub env: Vec<(String, String)>,
    /// Environment that is only worth producing for a new child, such as a
    /// freshly minted token (which revokes the previous one).
    pub spawn_env: Option<Box<dyn FnOnce() -> Result<Vec<(String, String)>, String> + 'a>>,
    pub on_progress: Box<dyn Fn(Progress) + Send + 'static>,
}

impl Backends {
    pub fn status(&self, id: &str) -> Option<Running> {
        let mut running = self.running.lock();
        let alive = running.get_mut(id).map(Managed::alive)?;
        if alive {
            running.get(id).map(|m| m.running.clone())
        } else {
            running.remove(id);
            None
        }
    }

    pub fn logs(&self, id: &str) -> Vec<String> {
        self.log_buffer(id).lock().iter().cloned().collect()
    }

    fn log_buffer(&self, id: &str) -> Arc<Mutex<VecDeque<String>>> {
        self.logs.lock().entry(id.to_string()).or_default().clone()
    }

    /// Start (or return) the backend. Blocking: call from a blocking task.
    pub fn ensure(&self, launch: Launch<'_>) -> Result<Running, String> {
        let id = launch.manifest.id.clone();
        let gate = self.starting.lock().entry(id.clone()).or_default().clone();
        let _gate = gate.lock();
        if let Some(running) = self.status(&id) {
            return Ok(running);
        }
        let backend = launch
            .manifest
            .backend
            .as_ref()
            .ok_or_else(|| format!("extension {id} has no backend"))?;
        std::fs::create_dir_all(launch.data_dir).map_err(|e| e.to_string())?;
        let spawn_env = match launch.spawn_env {
            Some(produce) => produce()?,
            None => vec![],
        };

        let program = resolve_command(&backend.command, launch.dir);
        let mut command = Command::new(&program);
        command
            .args(&backend.args)
            .current_dir(launch.dir)
            .envs(&backend.env)
            .envs(launch.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .envs(spawn_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group: closing the extension also reaps whatever the
            // backend forked if it ignores EOF.
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to start {}: {e}", program.display()))?;

        let log = self.log_buffer(&id);
        log.lock().clear();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("backend stdout unavailable")?;
        let stderr = child.stderr.take();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<String, String>>(1);
        {
            let log = log.clone();
            let id = id.clone();
            let on_progress = launch.on_progress;
            thread::spawn(move || {
                let mut ready_tx = Some(ready_tx);
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(progress) = parse_progress(&line) {
                        if ready_tx.is_some() {
                            on_progress(progress.clone());
                        }
                        push(&log, progress.message);
                        continue;
                    }
                    if let Some(tx) = ready_tx.as_ref() {
                        if let Some(result) = parse_ready(&line) {
                            let _ = tx.send(result);
                            ready_tx = None;
                            continue;
                        }
                    }
                    tracing::debug!(target: "extension", extension = %id, "{line}");
                    push(&log, line);
                }
                if let Some(tx) = ready_tx {
                    let _ = tx.send(Err("backend exited before it was ready".into()));
                }
            });
        }
        if let Some(stderr) = stderr {
            let log = log.clone();
            let id = id.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    tracing::debug!(target: "extension", extension = %id, "{line}");
                    push(&log, line);
                }
            });
        }

        let timeout = Duration::from_secs(backend.ready_timeout_secs.max(1));
        let url = match ready_rx.recv_timeout(timeout) {
            Ok(Ok(url)) => url,
            Ok(Err(error)) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(with_tail(error, &log));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(with_tail(
                    format!("backend was not ready within {}s", timeout.as_secs()),
                    &log,
                ));
            }
        };
        let running = Running { url, pid: child.id() };
        self.running.lock().insert(
            id,
            Managed {
                child,
                stdin,
                running: running.clone(),
            },
        );
        Ok(running)
    }

    pub fn stop(&self, id: &str) {
        let managed = self.running.lock().remove(id);
        if let Some(mut managed) = managed {
            managed.stop();
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<_> = self.running.lock().drain().map(|(_, m)| m).collect();
        for mut managed in all {
            managed.stop();
        }
    }
}

fn resolve_command(command: &str, dir: &Path) -> PathBuf {
    if command.starts_with("./") || command.starts_with("../") {
        dir.join(command)
    } else {
        // Bare names (`node`) resolve on PATH, which `fix_path_env` already
        // extended to the login shell's PATH at startup.
        PathBuf::from(command)
    }
}

fn parse_progress(line: &str) -> Option<Progress> {
    let line: ProgressLine = serde_json::from_str(line.trim()).ok()?;
    (line.kind == PROGRESS_TYPE).then_some(line.progress)
}

fn parse_ready(line: &str) -> Option<Result<String, String>> {
    let ready: Ready = serde_json::from_str(line.trim()).ok()?;
    if ready.kind != READY_TYPE {
        return None;
    }
    if ready.protocol_version != 1 {
        return Some(Err(format!(
            "unsupported ready protocol {}",
            ready.protocol_version
        )));
    }
    Some(validate_url(&ready.url).map(|_| ready.url))
}

/// Views load this URL in a webview with no other origin checks, so only
/// accept plain loopback HTTP.
pub fn validate_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|e| format!("invalid ready url: {e}"))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() != "http" || !loopback || !url.username().is_empty() {
        return Err("extension views must be served from loopback http".into());
    }
    Ok(url)
}

fn push(log: &Mutex<VecDeque<String>>, line: String) {
    let mut log = log.lock();
    if log.len() == LOG_LINES {
        log.pop_front();
    }
    log.push_back(line);
}

fn with_tail(error: String, log: &Mutex<VecDeque<String>>) -> String {
    let log = log.lock();
    let tail: Vec<_> = log.iter().rev().take(8).rev().cloned().collect();
    if tail.is_empty() {
        error
    } else {
        format!("{error}\n{}", tail.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_are_recognised() {
        let progress = parse_progress(
            r#"{"type":"kode.extension.progress","message":"Installing","step":1,"total":3}"#,
        )
        .unwrap();
        assert_eq!((progress.message.as_str(), progress.step, progress.total), ("Installing", Some(1), Some(3)));
        assert!(parse_progress(r#"{"type":"kode.extension.ready","protocol_version":1,"url":"x"}"#).is_none());
        assert!(parse_progress("plain output").is_none());
    }

    #[test]
    fn ready_line_must_be_loopback_http() {
        assert!(parse_ready("dsh starting...").is_none());
        assert!(parse_ready(r#"{"type":"other","protocol_version":1,"url":"x"}"#).is_none());
        let ok = parse_ready(
            r#"{"type":"kode.extension.ready","protocol_version":1,"url":"http://127.0.0.1:4000/?t=1"}"#,
        );
        assert_eq!(ok, Some(Ok("http://127.0.0.1:4000/?t=1".into())));
        let remote = parse_ready(
            r#"{"type":"kode.extension.ready","protocol_version":1,"url":"https://example.com/"}"#,
        );
        assert!(matches!(remote, Some(Err(_))));
    }
}
