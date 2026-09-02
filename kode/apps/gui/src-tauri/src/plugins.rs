//! Cross-platform plugin inventory and Git-backed skill deployment.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const PLATFORMS: [(&str, &str); 4] = [
    ("codex", ".codex/skills"),
    ("claude", ".claude/skills"),
    ("cursor", ".cursor/skills"),
    ("codebuddy", ".codebuddy/skills"),
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginSyncConfig {
    pub remote: Option<String>,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default)]
    pub auto_push: bool,
    /// Empty means all plugins are enabled for backwards compatibility.
    #[serde(default)]
    pub enabled_plugins: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformStatus {
    pub platform: String,
    pub compatibility: String,
    pub installed_skills: usize,
    pub available_skills: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInventory {
    pub name: String,
    pub source: String,
    pub enabled: bool,
    pub platforms: Vec<PlatformStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginOverview {
    pub root: String,
    pub initialized: bool,
    pub config: PluginSyncConfig,
    pub plugins: Vec<PluginInventory>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginSyncReport {
    pub initialized: bool,
    pub pulled: bool,
    pub pushed: bool,
    pub deployed: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativePlugin {
    pub id: String,
    pub name: String,
    pub source: Option<String>,
    pub version: Option<String>,
    pub enabled: Option<bool>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeBackendInventory {
    pub backend: String,
    pub cli_available: bool,
    /// ready, partial, unavailable, or error.
    pub status: String,
    pub detail: Option<String>,
    pub capabilities: Vec<String>,
    pub plugins: Vec<NativePlugin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativePluginOverview {
    pub read_only: bool,
    pub backends: Vec<NativeBackendInventory>,
}

fn default_branch() -> String {
    "main".into()
}

fn home() -> Result<PathBuf> {
    dirs::home_dir().context("home directory unavailable")
}
fn root() -> Result<PathBuf> {
    Ok(std::env::var_os("KODE_PLUGIN_ROOT")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".kode-plugins")))
}
fn config_path() -> Result<PathBuf> {
    Ok(root()?.join(".kode/config.json"))
}

fn load_config() -> Result<PluginSyncConfig> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(PluginSyncConfig {
            branch: default_branch(),
            ..Default::default()
        });
    }
    serde_json::from_slice(&fs::read(&path)?).with_context(|| format!("parse {}", path.display()))
}

fn save_config(config: &PluginSyncConfig) -> Result<()> {
    let path = config_path()?;
    fs::create_dir_all(path.parent().unwrap())?;
    fs::write(&path, serde_json::to_vec_pretty(config)?)?;
    Ok(())
}

fn skill_count(path: &Path) -> usize {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .count()
}

fn source_skill_count(plugin: &Path, platform: &str) -> usize {
    skill_count(&plugin.join("skills"))
        + skill_count(&plugin.join("shared/skills"))
        + skill_count(&plugin.join("platforms").join(platform).join("skills"))
}

fn compatibility(plugin: &Path, platform: &str, available: usize) -> String {
    let platform_root = plugin.join("platforms").join(platform);
    if plugin.join("skills").exists() {
        "native"
    } else if platform_root.exists() {
        if available > 0 {
            "native"
        } else {
            "partial"
        }
    } else if plugin.join("shared/skills").exists() {
        "adapted"
    } else {
        "unsupported"
    }
    .into()
}

fn list_plugins() -> Result<Vec<PluginInventory>> {
    let repo = root()?.join("plugins");
    let home = home()?;
    let mut out = Vec::new();
    let config = load_config()?;
    for entry in fs::read_dir(&repo)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
    {
        let plugin = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let platforms = PLATFORMS
            .iter()
            .map(|(platform, destination)| {
                let available = source_skill_count(&plugin, platform);
                PlatformStatus {
                    platform: (*platform).into(),
                    compatibility: compatibility(&plugin, platform, available),
                    installed_skills: skill_count(&home.join(destination)),
                    available_skills: available,
                }
            })
            .collect();
        out.push(PluginInventory {
            enabled: config.enabled_plugins.is_empty() || config.enabled_plugins.contains(&name),
            name,
            source: plugin.display().to_string(),
            platforms,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn normalize_name(value: &str) -> Result<String> {
    let name = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let name = name
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if name.is_empty() || name.len() > 64 {
        bail!("plugin name must contain 1-64 letters or numbers");
    }
    Ok(name)
}

fn json_string(value: Option<&serde_json::Value>) -> Option<String> {
    value.and_then(|value| match value {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn plugin_source(value: &serde_json::Value) -> Option<String> {
    json_string(value.get("marketplaceName"))
        .or_else(|| json_string(value.get("marketplace")))
        .or_else(|| json_string(value.get("source")))
        .or_else(|| {
            value
                .get("marketplaceSource")
                .and_then(|source| json_string(source.get("source")))
        })
}

fn parse_native_plugins(value: serde_json::Value) -> Vec<NativePlugin> {
    let entries = value
        .get("installed")
        .and_then(serde_json::Value::as_array)
        .or_else(|| value.get("plugins").and_then(serde_json::Value::as_array))
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut plugins = entries
        .iter()
        .filter_map(|entry| {
            let name = json_string(entry.get("name"))
                .or_else(|| json_string(entry.get("pluginName")))
                .or_else(|| json_string(entry.get("pluginId")))?;
            Some(NativePlugin {
                id: json_string(entry.get("pluginId"))
                    .or_else(|| json_string(entry.get("id")))
                    .unwrap_or_else(|| name.clone()),
                name,
                source: plugin_source(entry),
                version: json_string(entry.get("version")),
                enabled: entry.get("enabled").and_then(serde_json::Value::as_bool),
                scope: json_string(entry.get("scope")),
            })
        })
        .collect::<Vec<_>>();
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins
}

fn run_json_command(program: &str, args: &[&str]) -> Result<serde_json::Value> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start {program}"))?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output()?;
            if !output.status.success() {
                bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
            }
            return serde_json::from_slice(&output.stdout)
                .with_context(|| format!("parse {program} plugin inventory"));
        }
        if started.elapsed() >= Duration::from_secs(6) {
            child.kill()?;
            let _ = child.wait();
            bail!("scan timed out after 6 seconds");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn cli_backend(backend: &str, program: &str) -> NativeBackendInventory {
    let capabilities = match backend {
        "codex" | "codebuddy" => vec!["inventory", "marketplaces", "install", "update", "enable"],
        "claude" => vec!["inventory", "marketplaces", "install", "update"],
        _ => vec!["inventory"],
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
    match run_json_command(program, &["plugin", "list", "--json"]) {
        Ok(value) => NativeBackendInventory {
            backend: backend.into(),
            cli_available: true,
            status: "ready".into(),
            detail: None,
            capabilities,
            plugins: parse_native_plugins(value),
        },
        Err(error) => {
            let unavailable = error
                .chain()
                .any(|cause| cause.to_string().contains("No such file or directory"));
            NativeBackendInventory {
                backend: backend.into(),
                cli_available: !unavailable,
                status: if unavailable { "unavailable" } else { "error" }.into(),
                detail: (!unavailable).then(|| "inventory-command-failed".into()),
                capabilities,
                plugins: Vec::new(),
            }
        }
    }
}

fn cursor_backend() -> NativeBackendInventory {
    let local = home().map(|home| home.join(".cursor/plugins/local"));
    let mut plugins = Vec::new();
    if let Ok(local) = &local {
        for entry in fs::read_dir(local).into_iter().flatten().flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let manifest = entry.path().join(".cursor-plugin/plugin.json");
            let fallback = entry.path().join("plugin.json");
            let manifest = if manifest.is_file() {
                manifest
            } else {
                fallback
            };
            let value = fs::read(&manifest)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            let name = value
                .as_ref()
                .and_then(|value| json_string(value.get("name")))
                .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());
            plugins.push(NativePlugin {
                id: name.clone(),
                name,
                source: Some("local".into()),
                version: value
                    .as_ref()
                    .and_then(|value| json_string(value.get("version"))),
                enabled: None,
                scope: Some("user".into()),
            });
        }
    }
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    let cli_available = Command::new("cursor-agent")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok();
    NativeBackendInventory {
        backend: "cursor".into(),
        cli_available,
        status: "partial".into(),
        detail: Some("cursor-local-only".into()),
        capabilities: vec!["local-inventory", "marketplaces"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        plugins,
    }
}

#[tauri::command]
pub async fn native_plugin_overview() -> Result<NativePluginOverview, String> {
    tauri::async_runtime::spawn_blocking(|| NativePluginOverview {
        read_only: true,
        backends: vec![
            cli_backend("codex", "codex"),
            cli_backend("claude", "claude"),
            cursor_backend(),
            cli_backend("codebuddy", "codebuddy"),
        ],
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_set_enabled(name: String, enabled: bool) -> Result<(), String> {
    (|| {
        let mut cfg = load_config()?;
        if cfg.enabled_plugins.is_empty() {
            cfg.enabled_plugins = list_plugins()?
                .into_iter()
                .map(|plugin| plugin.name)
                .collect();
        }
        cfg.enabled_plugins.retain(|item| item != &name);
        if enabled {
            cfg.enabled_plugins.push(name);
            cfg.enabled_plugins.sort();
        }
        save_config(&cfg)
    })()
    .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub fn plugin_create(name: String, description: String) -> Result<String, String> {
    (|| {
        let name = normalize_name(&name)?;
        let plugin = root()?.join("plugins").join(&name);
        if plugin.exists() { bail!("plugin {name} already exists"); }
        fs::create_dir_all(plugin.join(".codex-plugin"))?;
        fs::create_dir_all(plugin.join(".claude-plugin"))?;
        fs::create_dir_all(plugin.join("skills").join(&name))?;
        let description = if description.trim().is_empty() { format!("Reusable {name} workflows") } else { description.trim().to_owned() };
        let manifest = serde_json::json!({"name": name, "version": "0.1.0", "description": description});
        let bytes = serde_json::to_vec_pretty(&manifest)?;
        fs::write(plugin.join(".codex-plugin/plugin.json"), &bytes)?;
        fs::write(plugin.join(".claude-plugin/plugin.json"), &bytes)?;
        fs::write(plugin.join("skills").join(&name).join("SKILL.md"), format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nDescribe the reusable workflow here.\n"))?;
        let market_dir = root()?.join(".agents/plugins");
        fs::create_dir_all(&market_dir)?;
        let market_path = market_dir.join("marketplace.json");
        let mut market = if market_path.exists() { serde_json::from_slice::<serde_json::Value>(&fs::read(&market_path)?)? } else { serde_json::json!({"name":"kode-local","interface":{"displayName":"Kode Local"},"plugins":[]}) };
        market["plugins"].as_array_mut().context("marketplace plugins must be an array")?.push(serde_json::json!({"name":name,"source":{"source":"local","path":format!("./plugins/{name}")},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}));
        fs::write(market_path, serde_json::to_vec_pretty(&market)?)?;
        Ok(plugin.display().to_string())
    })().map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub fn plugin_overview() -> Result<PluginOverview, String> {
    (|| {
        let root = root()?;
        Ok(PluginOverview {
            initialized: root.join(".git").exists(),
            root: root.display().to_string(),
            config: load_config()?,
            plugins: list_plugins()?,
        })
    })()
    .map_err(|e: anyhow::Error| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct PluginConfigArgs {
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub auto_push: Option<bool>,
}

#[tauri::command]
pub fn plugin_config_set(args: PluginConfigArgs) -> Result<(), String> {
    (|| {
        let mut cfg = load_config()?;
        if let Some(remote) = args.remote {
            cfg.remote = (!remote.trim().is_empty()).then(|| remote.trim().to_owned());
        }
        if let Some(branch) = args.branch {
            if !branch.trim().is_empty() {
                cfg.branch = branch.trim().to_owned();
            }
        }
        if let Some(auto_push) = args.auto_push {
            cfg.auto_push = auto_push;
        }
        save_config(&cfg)
    })()
    .map_err(|e: anyhow::Error| e.to_string())
}

fn git(repo: &Path, args: &[&str]) -> Result<bool> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .with_context(|| format!("run git {}", args.join(" ")))?;
    if !output.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(!output.stdout.is_empty())
}

fn git_ok(repo: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn copy_skills(from: &Path, destination: &Path, plugin_name: &str) -> Result<usize> {
    let mut count = 0;
    for entry in fs::read_dir(from)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("SKILL.md").is_file())
    {
        let target = destination.join(format!(
            "{}--{}",
            plugin_name,
            entry.file_name().to_string_lossy()
        ));
        if target.exists() {
            fs::remove_dir_all(&target)?;
        }
        copy_tree(&entry.path(), &target)?;
        count += 1;
    }
    Ok(count)
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if entry.file_type()?.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_sync_now() -> Result<PluginSyncReport, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<PluginSyncReport> {
        let repo = root()?;
        let cfg = load_config()?;
        fs::create_dir_all(&repo)?;
        fs::create_dir_all(repo.join("plugins"))?;
        let initialized = !repo.join(".git").exists();
        let mut pulled = false;
        let mut pushed = false;
        if initialized {
            git(&repo, &["init", "-b", &cfg.branch])?;
            if let Some(remote) = &cfg.remote {
                git(&repo, &["remote", "add", "origin", remote])?;
                git(&repo, &["fetch", "origin"])?;
                if git_ok(
                    &repo,
                    &["rev-parse", "--verify", &format!("origin/{}", cfg.branch)],
                ) {
                    git(
                        &repo,
                        &[
                            "checkout",
                            "-B",
                            &cfg.branch,
                            &format!("origin/{}", cfg.branch),
                        ],
                    )?;
                    pulled = true;
                }
            }
        }
        if !initialized {
            if let Some(remote) = &cfg.remote {
                if git_ok(&repo, &["remote", "get-url", "origin"]) {
                    git(&repo, &["remote", "set-url", "origin", remote])?;
                } else {
                    git(&repo, &["remote", "add", "origin", remote])?;
                }
            }
        }
        if cfg.remote.is_some() && !initialized {
            git(&repo, &["fetch", "origin", &cfg.branch])?;
            git(
                &repo,
                &["merge", "--no-edit", &format!("origin/{}", cfg.branch)],
            )?;
            pulled = true;
        }
        let home = home()?;
        let mut deployed = BTreeMap::new();
        for (platform, destination) in PLATFORMS {
            let destination = home.join(destination);
            fs::create_dir_all(&destination)?;
            let mut count = 0;
            for entry in fs::read_dir(repo.join("plugins"))
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.path().is_dir())
            {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !cfg.enabled_plugins.is_empty() && !cfg.enabled_plugins.contains(&name) {
                    continue;
                }
                count += copy_skills(&entry.path().join("skills"), &destination, &name)?;
                count += copy_skills(&entry.path().join("shared/skills"), &destination, &name)?;
                count += copy_skills(
                    &entry.path().join("platforms").join(platform).join("skills"),
                    &destination,
                    &name,
                )?;
            }
            deployed.insert(platform.into(), count);
        }
        if cfg.auto_push && cfg.remote.is_some() {
            git(&repo, &["add", "plugins"])?;
            if Command::new("git")
                .current_dir(&repo)
                .args(["diff", "--cached", "--quiet"])
                .status()?
                .success()
                == false
            {
                git(&repo, &["commit", "-m", "chore: sync kode plugins"])?;
                git(&repo, &["push", "origin", &cfg.branch])?;
                pushed = true;
            }
        }
        Ok(PluginSyncReport {
            initialized,
            pulled,
            pushed,
            deployed,
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn platform_compatibility_is_explicit() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("shared/skills/demo")).unwrap();
        fs::write(
            tmp.path().join("shared/skills/demo/SKILL.md"),
            "---\nname: demo\n---",
        )
        .unwrap();
        assert_eq!(compatibility(tmp.path(), "cursor", 1), "adapted");
        fs::create_dir_all(tmp.path().join("platforms/cursor/hooks")).unwrap();
        assert_eq!(compatibility(tmp.path(), "cursor", 1), "native");
    }

    #[test]
    fn native_inventory_accepts_provider_json() {
        let plugins = parse_native_plugins(serde_json::json!({
            "installed": [{
                "pluginId": "review@team",
                "name": "review",
                "marketplaceName": "team",
                "version": "1.2.3",
                "enabled": true
            }]
        }));
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "review@team");
        assert_eq!(plugins[0].source.as_deref(), Some("team"));
        assert_eq!(plugins[0].enabled, Some(true));
    }
}
