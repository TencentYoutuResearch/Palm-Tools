//! Add-backend flow: probe known CLIs, install missing ones, then configure.
//!
//! Settings → Backends → Add lists every `KNOWN_CANDIDATES` entry with its local
//! state. Installed CLIs are configured in one click; missing CLIs show the exact
//! platform install command, and only run it after the user confirms in the GUI.
//!
//! Install recipes are per platform on purpose: macOS/Linux run POSIX scripts
//! through the user's login shell (so nvm/brew PATH tweaks apply), Windows runs
//! PowerShell. A recipe is picked only when its prerequisite tool is on PATH;
//! keys without a known official installer stay "install manually".

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::backend_admin::{which, KnownBackend, KNOWN_CANDIDATES};
use crate::state::AppState;

const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InstallRecipe {
    /// Tool that must be on PATH for this recipe (`npm`, `curl`, `brew`, ...).
    pub requires: &'static str,
    pub script: &'static str,
}

/// Struct literal (not a `const fn`) so `&[r!(..)]` is promoted to `'static`.
macro_rules! r {
    ($requires:expr, $script:expr $(,)?) => {
        InstallRecipe {
            requires: $requires,
            script: $script,
        }
    };
}

/// macOS / Linux recipes, in preference order (official native installer first).
fn unix_recipes(key: &str) -> &'static [InstallRecipe] {
    match key {
        "claude" => &[
            r!("curl", "curl -fsSL https://claude.ai/install.sh | bash"),
            r!("npm", "npm install -g @anthropic-ai/claude-code"),
        ],
        "codex" => &[
            r!("npm", "npm install -g @openai/codex"),
            r!("brew", "brew install --cask codex"),
        ],
        "codebuddy" => &[r!("npm", "npm install -g @tencent-ai/codebuddy-code")],
        "gemini" => &[
            r!("npm", "npm install -g @google/gemini-cli"),
            r!("brew", "brew install gemini-cli"),
        ],
        "opencode" => &[
            r!("curl", "curl -fsSL https://opencode.ai/install | bash"),
            r!("npm", "npm install -g opencode-ai"),
        ],
        "amp" => &[r!("npm", "npm install -g @sourcegraph/amp")],
        "cursor" => &[r!("curl", "curl https://cursor.com/install -fsS | bash")],
        "copilot" => &[r!("npm", "npm install -g @github/copilot")],
        "kimi" => &[r!("curl", "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash")],
        "pi" => &[r!("npm", "npm install -g @mariozechner/pi-coding-agent")],
        "kiro" => &[r!("curl", "curl -fsSL https://cli.kiro.dev/install | bash")],
        "droid" => &[r!("curl", "curl -fsSL https://app.factory.ai/cli | sh")],
        _ => &[],
    }
}

/// Windows recipes (PowerShell). CLIs without an official Windows installer
/// are absent rather than guessed.
fn windows_recipes(key: &str) -> &'static [InstallRecipe] {
    match key {
        "claude" => &[
            r!("powershell", "irm https://claude.ai/install.ps1 | iex"),
            r!("npm", "npm install -g @anthropic-ai/claude-code"),
        ],
        "codex" => &[r!("npm", "npm install -g @openai/codex")],
        "codebuddy" => &[r!("npm", "npm install -g @tencent-ai/codebuddy-code")],
        "gemini" => &[r!("npm", "npm install -g @google/gemini-cli")],
        "opencode" => &[r!("npm", "npm install -g opencode-ai")],
        "amp" => &[r!("npm", "npm install -g @sourcegraph/amp")],
        "cursor" => &[r!(
            "powershell",
            "irm 'https://cursor.com/install?win32=true' | iex",
        )],
        "copilot" => &[r!("npm", "npm install -g @github/copilot")],
        "kimi" => &[r!("powershell", "irm https://code.kimi.com/kimi-code/install.ps1 | iex")],
        "pi" => &[r!("npm", "npm install -g @mariozechner/pi-coding-agent")],
        "droid" => &[r!(
            "powershell",
            "irm https://app.factory.ai/cli/windows | iex"
        )],
        _ => &[],
    }
}

pub(crate) fn recipes_for(key: &str) -> &'static [InstallRecipe] {
    if cfg!(windows) {
        windows_recipes(key)
    } else {
        unix_recipes(key)
    }
}

/// First recipe whose prerequisite is available. `Err` lists the missing tools
/// (empty when this platform has no recipe at all).
fn pick_recipe(
    key: &str,
    has_tool: impl Fn(&str) -> bool,
) -> Result<InstallRecipe, Vec<&'static str>> {
    let recipes = recipes_for(key);
    recipes
        .iter()
        .copied()
        .find(|recipe| has_tool(recipe.requires))
        .ok_or_else(|| recipes.iter().map(|recipe| recipe.requires).collect())
}

fn tool_available(tool: &str) -> bool {
    // PowerShell always ships with Windows; `which` also finds pwsh/powershell.exe.
    (cfg!(windows) && tool == "powershell") || which(tool).is_some()
}

fn candidate(key: &str) -> Result<&'static KnownBackend, String> {
    KNOWN_CANDIDATES
        .iter()
        .find(|c| c.key == key)
        .ok_or_else(|| format!("unknown backend '{key}'"))
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogEntry {
    pub key: String,
    pub command: String,
    pub command_path: Option<String>,
    /// Present in the Agent registry (built-in defaults count).
    pub configured: bool,
    pub enabled: bool,
    pub read_only: bool,
    /// Script that `backend_install` would run on this platform.
    pub install_script: Option<String>,
    /// Prerequisites missing for every recipe (e.g. `["npm"]`). Empty with no
    /// `install_script` means this platform has no automatic installer.
    pub install_missing: Vec<String>,
}

/// Every known CLI with installed / configured state and the install plan.
#[tauri::command]
pub async fn backend_catalog(state: State<'_, AppState>) -> Result<Vec<CatalogEntry>, String> {
    let catalog = crate::shared_agents::refresh(&state).await?;
    Ok(KNOWN_CANDIDATES
        .iter()
        .map(|c| {
            let existing = catalog.backends.get(c.key);
            let (install_script, install_missing) = match pick_recipe(c.key, tool_available) {
                Ok(recipe) => (Some(recipe.script.to_string()), Vec::new()),
                Err(missing) => (None, missing.into_iter().map(String::from).collect()),
            };
            CatalogEntry {
                key: c.key.into(),
                command: c.command.into(),
                command_path: locate_quick(c.command).map(|p| p.display().to_string()),
                configured: existing.is_some(),
                enabled: existing.is_some_and(|b| b.is_enabled()),
                read_only: catalog.read_only.contains(c.key),
                install_script,
                install_missing,
            }
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigureOutcome {
    pub key: String,
    pub command_path: String,
    /// Memory MCP wiring failed; the backend itself is configured and usable.
    pub mcp_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct InstallLog<'a> {
    key: &'a str,
    line: &'a str,
}

fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

struct RunningGuard(String);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        running().lock().unwrap().remove(&self.0);
    }
}

/// Install a missing CLI with the platform recipe, then configure it.
/// Output lines stream as `backend-install-log` events.
#[tauri::command]
pub async fn backend_install(
    key: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConfigureOutcome, String> {
    let known = candidate(&key)?;
    if !running().lock().unwrap().insert(key.clone()) {
        return Err(format!("{key} is already being installed"));
    }
    let _guard = RunningGuard(key.clone());

    if locate(known.command).await.is_none() {
        let recipe = pick_recipe(&key, tool_available).map_err(|missing| {
            if missing.is_empty() {
                format!("No automatic installer for {key} on this platform; install it manually.")
            } else {
                format!("Installing {key} requires {}.", missing.join(" or "))
            }
        })?;
        run_install(&app, &key, recipe.script).await?;
    }
    configure(&key, &app, &state).await
}

/// Configure an already installed CLI (enable it and wire memory MCP).
#[tauri::command]
pub async fn backend_configure(
    key: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConfigureOutcome, String> {
    candidate(&key)?;
    configure(&key, &app, &state).await
}

async fn run_install(app: &AppHandle, key: &str, script: &str) -> Result<(), String> {
    let _ = app.emit(
        "backend-install-log",
        InstallLog {
            key,
            line: &format!("$ {script}"),
        },
    );
    let mut child = install_command(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start installer: {e}"))?;

    let out = forward_lines(app, key, child.stdout.take());
    let err = forward_lines(app, key, child.stderr.take());
    let pump = async {
        let status = child.wait().await;
        let _ = tokio::join!(out, err);
        status
    };
    let status = tokio::time::timeout(INSTALL_TIMEOUT, pump)
        .await
        .map_err(|_| "installer timed out after 15 minutes".to_string())?
        .map_err(|e| format!("installer failed: {e}"))?;
    if !status.success() {
        return Err(format!("installer exited with {status}; see the log above"));
    }
    Ok(())
}

fn forward_lines<R>(app: &AppHandle, key: &str, reader: Option<R>) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let app = app.clone();
    let key = key.to_string();
    tokio::spawn(async move {
        let Some(reader) = reader else { return };
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit(
                "backend-install-log",
                InstallLog {
                    key: &key,
                    line: &line,
                },
            );
        }
    })
}

#[cfg(not(windows))]
fn install_command(script: &str) -> tokio::process::Command {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh"
            } else {
                "/bin/bash"
            }
            .into()
        });
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-lc").arg(script);
    // brew and some curl installers prompt unless told otherwise.
    cmd.env("NONINTERACTIVE", "1").env("CI", "1");
    cmd
}

#[cfg(windows)]
fn install_command(script: &str) -> tokio::process::Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
    ])
    .arg(script)
    .creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// PATH + `~/.local/bin`; cheap enough for the catalog listing.
fn locate_quick(command: &str) -> Option<PathBuf> {
    which(command).or_else(|| {
        let dir = dirs::home_dir()?.join(".local").join("bin");
        executable_in(&dir, command)
    })
}

/// Full lookup after an install: installers often add a bin dir the GUI
/// process has never seen. Ask the login shell (unix) / the registry PATH
/// (Windows) and prepend the hit's directory so PTY spawns find it too.
async fn locate(command: &str) -> Option<PathBuf> {
    if let Some(path) = which(command) {
        return Some(path);
    }
    let found = match locate_quick(command) {
        Some(path) => Some(path),
        None => locate_via_system(command).await,
    }?;
    if let Some(dir) = found.parent() {
        prepend_path(dir);
    }
    Some(found)
}

#[cfg(not(windows))]
async fn locate_via_system(command: &str) -> Option<PathBuf> {
    let output = install_command(&format!("command -v {command}"))
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let path = PathBuf::from(text.lines().last()?.trim());
    (path.is_absolute() && path.is_file()).then_some(path)
}

#[cfg(windows)]
async fn locate_via_system(command: &str) -> Option<PathBuf> {
    let script = "[Environment]::GetEnvironmentVariable('Path','User') + ';' + \
                  [Environment]::GetEnvironmentVariable('Path','Machine')";
    let output = install_command(script)
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let paths = String::from_utf8_lossy(&output.stdout).trim().to_string();
    crate::backend_admin::which_in(command, std::ffi::OsStr::new(&paths), None)
}

fn executable_in(dir: &Path, command: &str) -> Option<PathBuf> {
    let joined = std::env::join_paths([dir]).ok()?;
    crate::backend_admin::which_in(command, &joined, std::env::var_os("PATHEXT").as_deref())
}

fn prepend_path(dir: &Path) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    if std::env::split_paths(&current).any(|p| p == dir) {
        return;
    }
    let mut dirs = vec![dir.to_path_buf()];
    dirs.extend(std::env::split_paths(&current));
    if let Ok(joined) = std::env::join_paths(dirs) {
        std::env::set_var("PATH", joined);
    }
}

async fn configure(
    key: &str,
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<ConfigureOutcome, String> {
    let known = candidate(key)?;
    let path = locate(known.command).await.ok_or_else(|| {
        format!(
            "{} was not found after installation. Restart Kode or add it to PATH.",
            known.command
        )
    })?;

    let catalog = crate::shared_agents::refresh(state).await?;
    if catalog.read_only.contains(key) {
        // Managed elsewhere; installing the binary is all we can do.
    } else if catalog.backends.contains_key(key) {
        crate::shared_agents::change(
            state,
            serde_json::json!({"action":"enable","key":key,"enabled":true}),
        )
        .await?;
    } else {
        let mut backend = kode_core::Config::default()
            .backend(key)
            .cloned()
            .ok_or_else(|| format!("no default definition for '{key}'"))?;
        backend.enabled = Some(true);
        crate::shared_agents::change(
            state,
            serde_json::json!({"action":"save","key":key,"config":backend,"name":key}),
        )
        .await?;
    }
    let _ = app.emit("backends-changed", ());

    let spec = crate::shared_agents::refresh(state)
        .await?
        .backends
        .get(key)
        .and_then(|b| b.mcp_setup.clone());
    let mcp_warning = match spec {
        Some(spec) if !kode_memory::runtime_context::uses_shared_services(key) => {
            match tokio::task::spawn_blocking(move || {
                crate::memory_mcp::run_setup_for_backend(&spec)
            })
            .await
            {
                Ok(Ok(())) => {
                    let _ = app.emit("memory-mcp-changed", ());
                    None
                }
                Ok(Err(e)) => Some(e),
                Err(e) => Some(e.to_string()),
            }
        }
        _ => None,
    };

    Ok(ConfigureOutcome {
        key: key.into(),
        command_path: path.display().to_string(),
        mcp_warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_recipe_targets_a_known_candidate() {
        for key in [
            "claude",
            "codex",
            "codebuddy",
            "gemini",
            "opencode",
            "amp",
            "cursor",
            "copilot",
            "kimi",
            "pi",
            "kiro",
            "droid",
        ] {
            assert!(candidate(key).is_ok(), "{key} must be a known candidate");
        }
        for c in KNOWN_CANDIDATES {
            for recipe in unix_recipes(c.key).iter().chain(windows_recipes(c.key)) {
                assert!(!recipe.script.trim().is_empty());
            }
        }
    }

    #[test]
    fn platform_recipes_do_not_cross_shells() {
        for c in KNOWN_CANDIDATES {
            for recipe in unix_recipes(c.key) {
                assert_ne!(recipe.requires, "powershell", "{}", c.key);
                assert!(!recipe.script.contains("iex"), "{}", c.key);
            }
            for recipe in windows_recipes(c.key) {
                assert!(!recipe.script.contains("| bash"), "{}", c.key);
                assert!(!recipe.script.contains("| sh"), "{}", c.key);
                assert_ne!(recipe.requires, "brew", "{}", c.key);
            }
        }
    }

    #[test]
    fn internal_wrappers_have_no_installer() {
        for key in ["claude-internal", "tcodex", "tclaude"] {
            assert!(unix_recipes(key).is_empty());
            assert!(windows_recipes(key).is_empty());
        }
    }

    #[test]
    fn pick_recipe_falls_back_by_prerequisite() {
        if cfg!(windows) {
            return;
        }
        assert_eq!(
            pick_recipe("claude", |tool| tool == "npm")
                .unwrap()
                .requires,
            "npm"
        );
        assert_eq!(pick_recipe("claude", |_| true).unwrap().requires, "curl");
        assert_eq!(
            pick_recipe("codebuddy", |_| false).unwrap_err(),
            vec!["npm"]
        );
        assert!(pick_recipe("tclaude", |_| true).unwrap_err().is_empty());
    }

    #[test]
    fn kimi_uses_official_installer_scripts() {
        let unix = unix_recipes("kimi");
        assert_eq!(unix.len(), 1, "kimi should have one unix recipe");
        assert_eq!(unix[0].requires, "curl");
        assert_eq!(
            unix[0].script,
            "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
        );

        let windows = windows_recipes("kimi");
        assert_eq!(windows.len(), 1, "kimi should have one windows recipe");
        assert_eq!(windows[0].requires, "powershell");
        assert_eq!(
            windows[0].script,
            "irm https://code.kimi.com/kimi-code/install.ps1 | iex"
        );
    }

    /// gui 层矩阵：PATH 探测白名单必须恰好覆盖 `Config::default()` 的 17 个
    /// 内置 backend(数据源一致,新增 backend 忘记登记立刻失败)。
    #[test]
    fn probe_candidates_match_every_builtin_backend() {
        use std::collections::BTreeSet;
        let candidates: BTreeSet<&str> = KNOWN_CANDIDATES.iter().map(|c| c.key).collect();
        let builtin: BTreeSet<String> = kode_core::config::Config::default()
            .backends
            .keys()
            .cloned()
            .collect();
        let builtin: BTreeSet<&str> = builtin.iter().map(String::as_str).collect();
        assert_eq!(
            candidates, builtin,
            "KNOWN_CANDIDATES must cover exactly the built-in backends"
        );
        assert_eq!(candidates.len(), 17);
    }

    /// gui 层矩阵：安装配方只给有官方安装器的 12 个 key;其余 5 个
    /// (claude-internal / tcodex / tclaude / grok / antigravity)两个平台都
    /// 留空 → UI 提示手动安装。与 kode-core 的能力分组呼应。
    #[test]
    fn install_recipes_cover_exactly_the_official_installers() {
        use std::collections::BTreeSet;
        let manual: BTreeSet<&str> = [
            "claude-internal",
            "tcodex",
            "tclaude",
            "grok",
            "antigravity",
        ]
        .into_iter()
        .collect();
        for key in &manual {
            assert!(unix_recipes(key).is_empty(), "{key} should be manual on unix");
            assert!(
                windows_recipes(key).is_empty(),
                "{key} should be manual on windows"
            );
        }
        let candidates: BTreeSet<&str> = KNOWN_CANDIDATES.iter().map(|c| c.key).collect();
        let with_recipe: BTreeSet<&str> = KNOWN_CANDIDATES
            .iter()
            .filter(|c| !unix_recipes(c.key).is_empty() || !windows_recipes(c.key).is_empty())
            .map(|c| c.key)
            .collect();
        let expected: BTreeSet<&str> = candidates.difference(&manual).copied().collect();
        assert_eq!(with_recipe, expected);
        assert_eq!(with_recipe.len(), 12);
        // ACP-capable backends have an official installer on every platform.
        for key in ["codebuddy", "opencode"] {
            assert!(!unix_recipes(key).is_empty(), "{key} unix installer");
            assert!(!windows_recipes(key).is_empty(), "{key} windows installer");
        }
    }
}
