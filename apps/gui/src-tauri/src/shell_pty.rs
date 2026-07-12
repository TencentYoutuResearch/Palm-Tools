//! Lightweight shell PTY manager for the workspace inspector's terminal panel.
//!
//! Independent from the session system — no jsonl, no metadata, no CoreEvent.
//! PTY bytes go directly to Tauri Channel with a ~50KB ring buffer for
//! reconnect-after-session-switch replay.
//!
//! 单 channel 模型(同 SessionByteBuffer):subscribe 替换旧 channel,
//! unsubscribe 清为 None。shell PTY 在 session 切换时保持存活,
//! 切回时前端重新 subscribe,ring buffer 回放最近输出。

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use kode_core::EndpointId;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::state::AppState;

const RING_BUFFER_CAPACITY: usize = 50 * 1024; // ~50KB

#[allow(dead_code)]
pub struct ShellPty {
    pub id: u32,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub master: Box<dyn MasterPty + Send>,
    /// Single active subscriber channel (like SessionByteBuffer).
    /// subscribe replaces, unsubscribe clears to None.
    pub channel: Option<Channel<Vec<u8>>>,
    pub ring_buffer: VecDeque<u8>,
    pub cwd: String,
}

impl ShellPty {
    fn push_bytes(&mut self, bytes: &[u8]) {
        // Push to ring buffer (evict oldest if over capacity)
        for &b in bytes {
            if self.ring_buffer.len() >= RING_BUFFER_CAPACITY {
                self.ring_buffer.pop_front();
            }
            self.ring_buffer.push_back(b);
        }
        // Forward to active subscriber (if any)
        if let Some(ch) = &self.channel {
            let _ = ch.send(bytes.to_vec());
        }
    }
}

pub struct ShellPtyManager {
    pub shells: Arc<Mutex<HashMap<u32, ShellPty>>>,
    remote_subs: Arc<Mutex<HashMap<(String, u32), tauri::async_runtime::JoinHandle<()>>>>,
    next_id: Arc<Mutex<u32>>,
}

impl ShellPtyManager {
    pub fn new() -> Self {
        Self {
            shells: Arc::new(Mutex::new(HashMap::new())),
            remote_subs: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(1)),
        }
    }

    fn alloc_id(&self) -> u32 {
        let mut g = self.next_id.lock();
        let id = *g;
        *g += 1;
        id
    }
}

impl Default for ShellPtyManager {
    fn default() -> Self {
        Self::new()
    }
}

fn endpoint_or_local(endpoint_id: Option<EndpointId>) -> EndpointId {
    endpoint_id.unwrap_or(EndpointId::Local)
}

fn remote_key(endpoint_id: &EndpointId) -> Option<String> {
    match endpoint_id {
        EndpointId::Local => None,
        EndpointId::Remote { id } => Some(id.clone()),
    }
}

fn get_remote_transport(
    app_state: &AppState,
    endpoint_id: &EndpointId,
) -> Result<Arc<crate::transport::RemoteTransport>, String> {
    let Some(id) = remote_key(endpoint_id) else {
        return Err("local endpoint has no remote transport".into());
    };
    app_state
        .remote_transports
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("remote transport not registered: {id}"))
}

// ── Tauri commands ──────────────────────────────────────────────

/// Spawn a shell PTY (`$SHELL`, fallback `/bin/zsh`). Returns the shell ID.
#[tauri::command]
pub async fn spawn_shell(
    cwd: String,
    cols: u16,
    rows: u16,
    endpoint_id: Option<EndpointId>,
    state: tauri::State<'_, ShellPtyManager>,
    app_state: tauri::State<'_, AppState>,
) -> Result<u32, String> {
    let endpoint_id = endpoint_or_local(endpoint_id);
    if !matches!(endpoint_id, EndpointId::Local) {
        let remote = get_remote_transport(&app_state, &endpoint_id)?;
        return remote.shell_spawn(cwd, cols, rows).await;
    }

    let id = state.alloc_id();
    let pty_system = native_pty_system();
    let size = PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("openpty: {e}"))?;

    // Resolve shell: $SHELL > /bin/zsh
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(Path::new(&cwd));

    // TERM/COLORTERM/locale fallbacks (same logic as PtyHost::spawn)
    if std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }
    if std::env::var_os("COLORTERM").is_none() {
        cmd.env("COLORTERM", "truecolor");
    }
    let has_locale = std::env::var_os("LC_ALL").is_some()
        || std::env::var_os("LANG").is_some()
        || std::env::var_os("LC_CTYPE").is_some();
    if !has_locale {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let writer = Arc::new(Mutex::new(writer));
    let shells = Arc::clone(&state.shells);

    // Reader thread: reads PTY output, pushes to ring buffer + forwards to channel
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = &buf[..n];
                    let mut g = shells.lock();
                    if let Some(shell) = g.get_mut(&id) {
                        shell.push_bytes(data);
                    } else {
                        break; // shell was killed/removed
                    }
                }
            }
        }
    });

    // Reaper: wait for child exit, then remove from map
    let shells_reaper = Arc::clone(&state.shells);
    std::thread::spawn(move || {
        let _ = child.wait();
        let mut g = shells_reaper.lock();
        g.remove(&id);
    });

    let shell_pty = ShellPty {
        id,
        writer,
        killer: Mutex::new(killer),
        master: pair.master,
        channel: None,
        ring_buffer: VecDeque::with_capacity(RING_BUFFER_CAPACITY),
        cwd,
    };

    state.shells.lock().insert(id, shell_pty);
    Ok(id)
}

/// Write bytes to the shell PTY stdin.
#[tauri::command]
pub async fn write_shell(
    id: u32,
    bytes: Vec<u8>,
    endpoint_id: Option<EndpointId>,
    state: tauri::State<'_, ShellPtyManager>,
    app_state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let endpoint_id = endpoint_or_local(endpoint_id);
    if !matches!(endpoint_id, EndpointId::Local) {
        let remote = get_remote_transport(&app_state, &endpoint_id)?;
        return remote.shell_write(id, &bytes).await;
    }

    let g = state.shells.lock();
    let shell = g.get(&id).ok_or("shell not found")?;
    let mut w = shell.writer.lock();
    w.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    w.flush().ok();
    Ok(())
}

/// Resize the shell PTY.
#[tauri::command]
pub async fn resize_shell(
    id: u32,
    cols: u16,
    rows: u16,
    endpoint_id: Option<EndpointId>,
    state: tauri::State<'_, ShellPtyManager>,
    app_state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let endpoint_id = endpoint_or_local(endpoint_id);
    if !matches!(endpoint_id, EndpointId::Local) {
        let remote = get_remote_transport(&app_state, &endpoint_id)?;
        return remote.shell_resize(id, cols, rows).await;
    }

    let mut g = state.shells.lock();
    let shell = g.get_mut(&id).ok_or("shell not found")?;
    let size = PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    };
    shell
        .master
        .resize(size)
        .map_err(|e| format!("resize: {e}"))
}

/// Kill the shell PTY and remove it from the manager.
#[tauri::command]
pub async fn kill_shell(
    id: u32,
    endpoint_id: Option<EndpointId>,
    state: tauri::State<'_, ShellPtyManager>,
    app_state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let endpoint_id = endpoint_or_local(endpoint_id);
    if let Some(key) = remote_key(&endpoint_id) {
        if let Some(handle) = state.remote_subs.lock().remove(&(key, id)) {
            handle.abort();
        }
        let remote = get_remote_transport(&app_state, &endpoint_id)?;
        return remote.shell_kill(id).await;
    }

    let mut g = state.shells.lock();
    if let Some(shell) = g.get_mut(&id) {
        let mut k = shell.killer.lock();
        let _ = k.kill();
    }
    g.remove(&id);
    Ok(())
}

/// Subscribe to shell PTY byte stream.
/// On subscribe, the ring buffer (~50KB) is replayed first, then live bytes stream in.
#[tauri::command]
pub async fn subscribe_shell_bytes(
    id: u32,
    endpoint_id: Option<EndpointId>,
    on_bytes: Channel<Vec<u8>>,
    state: tauri::State<'_, ShellPtyManager>,
    app_state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let endpoint_id = endpoint_or_local(endpoint_id);
    if let Some(key) = remote_key(&endpoint_id) {
        let remote = get_remote_transport(&app_state, &endpoint_id)?;
        if let Some(old) = state.remote_subs.lock().remove(&(key.clone(), id)) {
            old.abort();
        }
        let handle = remote.shell_subscribe_bytes(id, on_bytes).await?;
        state.remote_subs.lock().insert((key, id), handle);
        return Ok(());
    }

    let mut g = state.shells.lock();
    let shell = g.get_mut(&id).ok_or("shell not found")?;

    // Replay ring buffer first (for reconnect after session switch)
    if !shell.ring_buffer.is_empty() {
        let snapshot: Vec<u8> = shell.ring_buffer.iter().copied().collect();
        let _ = on_bytes.send(snapshot);
    }

    // Set as active channel (replaces any previous subscriber)
    shell.channel = Some(on_bytes);
    Ok(())
}

/// Unsubscribe from shell PTY byte stream (clears the channel).
#[tauri::command]
pub fn unsubscribe_shell_bytes(
    id: u32,
    endpoint_id: Option<EndpointId>,
    state: tauri::State<'_, ShellPtyManager>,
) -> Result<(), String> {
    let endpoint_id = endpoint_or_local(endpoint_id);
    if let Some(key) = remote_key(&endpoint_id) {
        if let Some(handle) = state.remote_subs.lock().remove(&(key, id)) {
            handle.abort();
        }
        return Ok(());
    }

    let mut g = state.shells.lock();
    let shell = g.get_mut(&id).ok_or("shell not found")?;
    shell.channel = None;
    Ok(())
}

/// Get the ring buffer snapshot (for initial reconnect).
#[tauri::command]
pub fn get_shell_snapshot(
    id: u32,
    state: tauri::State<'_, ShellPtyManager>,
) -> Result<Vec<u8>, String> {
    let g = state.shells.lock();
    let shell = g.get(&id).ok_or("shell not found")?;
    Ok(shell.ring_buffer.iter().copied().collect())
}
