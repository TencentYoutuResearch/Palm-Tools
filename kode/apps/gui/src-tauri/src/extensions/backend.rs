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

use kode_core::process::HideConsole;
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

        let (program, prepend_bin) =
            resolve_command(&backend.command, launch.dir, launch.data_dir, &launch.on_progress)?;
        let mut command = Command::new(&program).hide_console();
        command
            .args(&backend.args)
            .current_dir(launch.dir)
            .envs(&backend.env)
            .envs(launch.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .envs(spawn_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(bin_dir) = prepend_bin {
            if let Some(joined) = prepend_path_dir(&bin_dir) {
                command.env("PATH", joined);
            }
        }
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

const MANAGED_NODE_VERSION: &str = "24.22.3";

fn node_exe_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn parse_node_version(raw: &str) -> Option<(u32, u32, u32)> {
    let trimmed = raw.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch_part = parts.next()?.split(|c: char| !c.is_ascii_digit()).next()?;
    let patch = patch_part.parse().ok()?;
    Some((major, minor, patch))
}

/// Versions supported directly by the pinned dsh runtime (matches `start.mjs`).
fn node_supports_dsh(version: (u32, u32, u32)) -> bool {
    let (major, minor, patch) = version;
    (major == 24 && (minor > 22 || (minor == 22 && patch >= 3)))
        || (major == 26 && (minor > 13 || (minor == 13 && patch >= 1)))
        || major > 26
}

fn probe_node_version(program: &Path) -> Option<(u32, u32, u32)> {
    let output = Command::new(program)
        .hide_console()
        .arg("-v")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_node_version(&String::from_utf8_lossy(&output.stdout))
}

fn prepend_path_dir(dir: &Path) -> Option<std::ffi::OsString> {
    let mut paths = vec![dir.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(paths).ok()
}

fn collect_versioned_nodes(root: &Path, sub_rel: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let mut candidate = entry.path();
        for seg in sub_rel {
            candidate = candidate.join(seg);
        }
        if candidate.is_file() {
            out.push(candidate);
        }
    }
}

fn managed_node_root(data_dir: &Path) -> PathBuf {
    data_dir
        .join("node-runtime")
        .join(format!("v{MANAGED_NODE_VERSION}"))
}

fn managed_node_paths(root: &Path) -> (PathBuf, PathBuf) {
    if cfg!(windows) {
        (root.join(node_exe_name()), root.to_path_buf())
    } else {
        let bin = root.join("bin");
        (bin.join(node_exe_name()), bin)
    }
}

fn node_platform_slug() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(("darwin-arm64", "tar.gz")),
        ("macos", "x86_64") => Some(("darwin-x64", "tar.gz")),
        ("linux", "x86_64") => Some(("linux-x64", "tar.gz")),
        ("linux", "aarch64") => Some(("linux-arm64", "tar.gz")),
        ("windows", "x86_64") => Some(("win-x64", "zip")),
        ("windows", "aarch64") => Some(("win-arm64", "zip")),
        _ => None,
    }
}

fn node_download_urls(archive: &str) -> Vec<String> {
    if let Ok(base) = std::env::var("KODE_NODE_DIST_BASE_URL") {
        let trimmed = base.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return vec![format!("{trimmed}/v{MANAGED_NODE_VERSION}/{archive}")];
        }
    }
    vec![
        format!("https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/{archive}"),
        format!("https://npmmirror.com/mirrors/node/v{MANAGED_NODE_VERSION}/{archive}"),
    ]
}

fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let output = Command::new("curl")
            .hide_console()
            .args(["-fsSL", "--retry", "2", "--connect-timeout", "15", "-o"])
            .arg(dest)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("failed to run curl: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if err.is_empty() {
                format!("curl exited with {}", output.status)
            } else {
                err
            });
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let script = format!(
            "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '{}' -OutFile '{}'",
            url.replace('\'', "''"),
            dest.display().to_string().replace('\'', "''"),
        );
        let output = Command::new("powershell")
            .hide_console()
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("failed to run powershell: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if err.is_empty() {
                format!("powershell download exited with {}", output.status)
            } else {
                err
            });
        }
        Ok(())
    }
}

fn extract_archive(archive: &Path, dest: &Path, ext: &str) -> Result<(), String> {
    if ext == "tar.gz" {
        let output = Command::new("tar")
            .hide_console()
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(dest)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("failed to run tar: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("tar extract failed: {err}"));
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        let script = format!(
            "$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
            archive.display().to_string().replace('\'', "''"),
            dest.display().to_string().replace('\'', "''"),
        );
        let output = Command::new("powershell")
            .hide_console()
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("failed to run Expand-Archive: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("zip extract failed: {err}"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(format!("unsupported archive extension: {ext}"))
    }
}

fn provision_managed_node(
    data_dir: &Path,
    on_progress: &(dyn Fn(Progress) + Send + 'static),
) -> Result<(PathBuf, PathBuf), String> {
    let target = managed_node_root(data_dir);
    let (target_node, target_bin) = managed_node_paths(&target);
    if target_node.is_file()
        && probe_node_version(&target_node).is_some_and(node_supports_dsh)
    {
        return Ok((target_node, target_bin));
    }

    let (slug, ext) = node_platform_slug().ok_or_else(|| {
        format!(
            "unsupported platform for automatic Node.js {MANAGED_NODE_VERSION} install ({}/{})",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let folder_name = format!("node-v{MANAGED_NODE_VERSION}-{slug}");
    let archive_name = format!("{folder_name}.{ext}");

    on_progress(Progress {
        message: format!("正在自动安装 dsh 专用 Node.js {MANAGED_NODE_VERSION} 运行环境（仅首次）"),
        step: Some(1),
        total: Some(4),
    });

    let parent = target.parent().unwrap_or(data_dir);
    std::fs::create_dir_all(parent).map_err(|e| format!("create node-runtime dir: {e}"))?;
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&staging).map_err(|e| format!("create staging dir: {e}"))?;

    let result = (|| -> Result<(PathBuf, PathBuf), String> {
        let archive_path = staging.join(&archive_name);
        let mut last_err = String::new();
        let mut downloaded = false;
        for url in node_download_urls(&archive_name) {
            tracing::info!(target: "extension", %url, "downloading managed Node.js runtime");
            match download_file(&url, &archive_path) {
                Ok(()) => {
                    downloaded = true;
                    break;
                }
                Err(error) => {
                    tracing::warn!(target: "extension", %url, %error, "managed Node.js download mirror failed");
                    last_err = error;
                }
            }
        }
        if !downloaded {
            return Err(format!(
                "自动安装 Node.js {MANAGED_NODE_VERSION} 失败（{last_err}）。请检查网络或手动安装 Node.js >= {MANAGED_NODE_VERSION}。"
            ));
        }

        extract_archive(&archive_path, &staging, ext)?;
        let extracted = staging.join(&folder_name);
        let (staged_node, _) = managed_node_paths(&extracted);
        if !staged_node.is_file()
            || !probe_node_version(&staged_node).is_some_and(node_supports_dsh)
        {
            return Err(format!(
                "下载的 Node.js {MANAGED_NODE_VERSION} 运行环境校验失败"
            ));
        }

        if target.exists() {
            let _ = std::fs::remove_dir_all(&target);
        }
        if let Err(rename_err) = std::fs::rename(&extracted, &target) {
            // Another concurrent process may have finished installing into `target`.
            if target_node.is_file()
                && probe_node_version(&target_node).is_some_and(node_supports_dsh)
            {
                return Ok((target_node.clone(), target_bin.clone()));
            }
            return Err(format!("install managed Node.js: {rename_err}"));
        }
        Ok((target_node.clone(), target_bin.clone()))
    })();

    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn discover_modern_node(data_dir: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    let exe = node_exe_name();
    // 1. Prefer an already-provisioned standalone Node 24 owned by this extension.
    let managed = managed_node_root(data_dir);
    let (managed_node, managed_bin) = managed_node_paths(&managed);
    if managed_node.is_file()
        && probe_node_version(&managed_node).is_some_and(node_supports_dsh)
    {
        return Some((managed_node, Some(managed_bin)));
    }

    // 2. Also reuse legacy private Node 24 installed by `start.mjs` if present.
    let legacy_bin = data_dir
        .join("node-24")
        .join("node_modules")
        .join("node")
        .join("bin");
    let legacy_node = legacy_bin.join(exe);
    if legacy_node.is_file()
        && probe_node_version(&legacy_node).is_some_and(node_supports_dsh)
    {
        return Some((legacy_node, Some(legacy_bin)));
    }

    // 3. Fast path: default `node` on PATH already satisfies dsh.
    if probe_node_version(Path::new(exe)).is_some_and(node_supports_dsh) {
        return Some((PathBuf::from(exe), None));
    }

    // 4. Scan common Node version managers and Homebrew prefixes.
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        #[cfg(unix)]
        {
            collect_versioned_nodes(&home.join(".nvm/versions/node"), &["bin", exe], &mut candidates);
            collect_versioned_nodes(&home.join(".fnm/node-versions"), &["installation", "bin", exe], &mut candidates);
            collect_versioned_nodes(
                &home.join("Library/Application Support/fnm/node-versions"),
                &["installation", "bin", exe],
                &mut candidates,
            );
            collect_versioned_nodes(&home.join(".volta/tools/image/node"), &["bin", exe], &mut candidates);
            collect_versioned_nodes(&home.join(".local/share/mise/installs/node"), &["bin", exe], &mut candidates);
            collect_versioned_nodes(&home.join(".asdf/installs/nodejs"), &["bin", exe], &mut candidates);
            for fixed in [
                "/opt/homebrew/opt/node@24/bin/node",
                "/opt/homebrew/bin/node",
                "/usr/local/opt/node@24/bin/node",
                "/usr/local/bin/node",
            ] {
                let path = PathBuf::from(fixed);
                if path.is_file() {
                    candidates.push(path);
                }
            }
        }
        #[cfg(windows)]
        {
            collect_versioned_nodes(&home.join(".volta/tools/image/node"), &[exe], &mut candidates);
            collect_versioned_nodes(&home.join(".fnm/node-versions"), &["installation", exe], &mut candidates);
            if let Some(nvm_home) = std::env::var_os("NVM_HOME") {
                collect_versioned_nodes(Path::new(&nvm_home), &[exe], &mut candidates);
            }
        }
    }

    candidates
        .into_iter()
        .filter_map(|path| {
            let version = probe_node_version(&path)?;
            node_supports_dsh(version).then_some((version, path))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| {
            let bin_dir = path.parent().map(Path::to_path_buf);
            (path, bin_dir)
        })
}

fn resolve_command(
    command: &str,
    dir: &Path,
    data_dir: &Path,
    on_progress: &(dyn Fn(Progress) + Send + 'static),
) -> Result<(PathBuf, Option<PathBuf>), String> {
    if command.starts_with("./") || command.starts_with("../") {
        return Ok((dir.join(command), None));
    }
    if command == "node" {
        if let Some(found) = discover_modern_node(data_dir) {
            return Ok(found);
        }
        // Automatically provision a private standalone Node 24 runtime (with npm)
        // when the system has no Node or an older Node version.
        match provision_managed_node(data_dir, on_progress) {
            Ok((node, bin_dir)) => return Ok((node, Some(bin_dir))),
            Err(error) => {
                // If an older system `node` >= 18 exists, let `start.mjs` attempt its
                // npm fallback; otherwise surface the provisioning error directly.
                if probe_node_version(Path::new(node_exe_name()))
                    .is_some_and(|(major, _, _)| major >= 18)
                {
                    tracing::warn!(target: "extension", %error, "managed Node.js download failed; falling back to system node");
                    return Ok((PathBuf::from(command), None));
                }
                return Err(error);
            }
        }
    }
    // Bare names resolve on PATH, which `fix_path_env` already
    // extended to the login shell's PATH at startup.
    Ok((PathBuf::from(command), None))
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

    #[test]
    fn node_version_parsing_and_minimum_check() {
        assert_eq!(parse_node_version("v24.22.3\n"), Some((24, 22, 3)));
        assert_eq!(parse_node_version("v20.18.1-nightly.1"), Some((20, 18, 1)));
        assert_eq!(parse_node_version("not-a-version"), None);
        assert!(node_supports_dsh((24, 22, 3)));
        assert!(node_supports_dsh((24, 23, 0)));
        assert!(node_supports_dsh((26, 13, 1)));
        assert!(node_supports_dsh((27, 0, 0)));
        assert!(!node_supports_dsh((24, 22, 2)));
        assert!(!node_supports_dsh((24, 9, 0)));
        assert!(!node_supports_dsh((22, 14, 0)));
        assert!(!node_supports_dsh((18, 20, 4)));
        assert!(!node_supports_dsh((25, 0, 0)));
    }

    #[cfg(unix)]
    #[test]
    fn discover_modern_node_prefers_managed_runtime() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = managed_node_root(dir.path());
        let (node_path, bin_dir) = managed_node_paths(&root);
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(&node_path, "#!/bin/sh\necho v24.22.3\n").unwrap();
        std::fs::set_permissions(&node_path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (found, found_bin) = discover_modern_node(dir.path()).expect("should find managed node");
        assert_eq!(found, node_path);
        assert_eq!(found_bin, Some(bin_dir));
    }
}
