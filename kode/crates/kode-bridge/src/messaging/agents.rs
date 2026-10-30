//! One authoritative Agent registry for the desktop and protocol frontends.
//! TOML is a migration input; bindings retain immutable launch snapshots.
use super::Hub;
use anyhow::{bail, Context, Result};
use kode_core::{config::McpSetupSpec, BackendConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Catalog {
    pub backends: HashMap<String, BackendConfig>,
    pub names: HashMap<String, String>,
    #[serde(default)]
    pub ids: HashMap<String, String>,
    #[serde(default)]
    pub bindings: Value,
    #[serde(default)]
    pub read_only: std::collections::HashSet<String>,
}

fn executable_name(command: &str) -> &str {
    std::path::Path::new(command)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
}

fn profile(key: &str, config: &BackendConfig) -> Option<Value> {
    if !config.is_enabled() {
        return None;
    }
    let protocol = config.protocol_key(key);
    let kind = match protocol {
        "codex" | "tcodex" | "native-codex" | "gateway-codex" => "codex",
        "claude" | "tclaude" | "claude-internal" => "claude",
        "cursor" => "cursor",
        "codebuddy" => "codebuddy",
        _ => match config.mcp_setup {
            Some(McpSetupSpec::Codex { .. }) => "codex",
            Some(McpSetupSpec::Claude { .. }) => "claude",
            Some(McpSetupSpec::Codebuddy { .. }) => "codebuddy",
            _ => return None,
        },
    };
    Some(launch_profile(key, config, kind))
}

fn launch_profile(key: &str, config: &BackendConfig, kind: &str) -> Value {
    let mut command = config.command.clone();
    let mut args = config.args.clone();
    let mut env = Map::new();
    if executable_name(&command) == "env" {
        let count = args
            .iter()
            .take_while(|arg| {
                arg.split_once('=')
                    .is_some_and(|(key, _)| !key.is_empty() && !key.starts_with('-'))
            })
            .count();
        if let Some(executable) = args.get(count).filter(|arg| !arg.starts_with('-')) {
            for arg in &args[..count] {
                let (key, value) = arg.split_once('=').unwrap();
                env.insert(key.into(), json!(value));
            }
            command = executable.clone();
            args = args[count + 1..].to_vec();
        }
    }
    let mut value = json!({"id":format!("kode-{key}"),"name":key,"type":kind,"origin":"custom","executable":command,"args":args,"env":env});
    if let Some(model) = &config.default_model {
        value["defaultModel"] = json!(model);
    }
    value
}

fn backend(profile: &Value, previous: Option<&BackendConfig>) -> Result<BackendConfig> {
    let kind = profile["type"].as_str().context("Agent type is missing")?;
    let command = profile["executable"]
        .as_str()
        .unwrap_or(if kind == "dsh" { "dsh" } else { "" });
    if command.is_empty() || command.contains('\0') {
        bail!("Agent executable is missing or invalid");
    }
    let defaults=kode_core::Config::default();
    let mut config = previous.cloned().unwrap_or_else(||defaults.backends.get(kind).unwrap_or(&defaults.backends["codex"]).clone());
    config.protocol = Some(
        match kind {
            "codex" => {
                if executable_name(command) == "tcodex" {
                    "tcodex"
                } else {
                    "codex"
                }
            }
            "claude" => {
                if executable_name(command) == "tclaude" {
                    "tclaude"
                } else {
                    "claude"
                }
            }
            "cursor" => "cursor",
            "codebuddy" => "codebuddy",
            "custom" if profile["protocol"] == "codex" => "codex",
            "dsh" | "custom" => "raw",
            _ => bail!("unsupported Agent type"),
        }
        .into(),
    );
    // Preserve a known storage identity when the executable is an env/shell
    // wrapper (the imported tcodex definition is one such case).
    if kind == "codex"
        && executable_name(command) != "codex"
        && previous.is_some_and(|old| old.protocol_key("") == "tcodex")
    {
        config.protocol = Some("tcodex".into());
    }
    config.command = command.into();
    config.args = match profile.get("args") {
        None => vec![],
        Some(args) => {
            serde_json::from_value(args.clone()).context("Agent arguments must be strings")?
        }
    };
    let env: std::collections::BTreeMap<String, String> =
        serde_json::from_value(profile.get("env").cloned().unwrap_or(json!({})))?;
    if !env.is_empty() {
        let mut args = Vec::new();
        for (key, value) in env {
            if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                bail!("invalid Agent environment entry");
            }
            args.push(format!("{key}={value}"));
        }
        args.push(config.command);
        args.extend(config.args);
        config.command = if cfg!(windows) { "env" } else { "/usr/bin/env" }.into();
        config.args = args;
    }
    config.default_model = profile["defaultModel"].as_str().map(str::to_owned);
    config.enabled = Some(true);
    Ok(config)
}

pub(super) fn initialize(hub: &Hub) -> Result<()> {
    super::codebuddy_registry::adopt_existing(hub)?;
    let row = hub.store.document("agents")?;
    if row.pointer("/value/shared_registry_version") == Some(&json!(1)) {
        publish(hub, &row["value"])?;
        return Ok(());
    }
    let existed = !row["value"].is_null();
    let mut value = row["value"].as_object().cloned().unwrap_or_default();
    value.entry("version").or_insert(json!(1));
    value.entry("profiles").or_insert(json!([]));
    value.entry("bindings").or_insert(json!({}));
    let mut legacy = hub
        .ctx
        .upgrade()
        .context("Agent host is unavailable")?
        .config
        .backends
        .clone();
    for config in legacy
        .values_mut()
        .filter(|config| config.enabled.is_none())
    {
        config.enabled = Some(crate::backend_probe::which(&config.command).is_some());
    }
    let mut ids = Map::new();
    let mut backends = serde_json::to_value(legacy)?.as_object().unwrap().clone();
    let profiles = value
        .get_mut("profiles")
        .and_then(Value::as_array_mut)
        .context("invalid Agent profiles")?;
    for (key, raw) in &backends {
        let config: BackendConfig = serde_json::from_value(raw.clone())?;
        let Some(candidate) = profile(key, &config) else {
            continue;
        };
        let existing = profiles.iter().find(|item| {
            item["id"] == candidate["id"]
                || item["name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(key))
        });
        let id = existing
            .map(|item| item["id"].clone())
            .unwrap_or_else(|| candidate["id"].clone());
        ids.insert(id.as_str().context("invalid Agent ID")?.into(), json!(key));
        if existing.is_none() {
            profiles.push(candidate);
        }
    }
    for item in profiles.iter() {
        let id = item["id"].as_str().context("invalid Agent ID")?;
        let key = ids
            .entry(id)
            .or_insert_with(|| json!(id.strip_prefix("kode-").unwrap_or(id)))
            .as_str()
            .unwrap()
            .to_owned();
        let previous = backends
            .get(&key)
            .map(|raw| serde_json::from_value(raw.clone()))
            .transpose()?;
        backends.insert(
            key,
            serde_json::to_value(backend(item, previous.as_ref())?)?,
        );
    }
    value.insert("desktop_backends".into(), Value::Object(backends));
    value.insert("desktop_ids".into(), Value::Object(ids));
    value.insert("shared_registry_version".into(), json!(1));
    value.insert("dsh_migrated".into(), json!(existed));
    let saved = hub.store.save_document(
        "agents",
        row["revision"].as_u64().unwrap(),
        Value::Object(value),
    )?;
    publish(hub, &saved["value"])
}

pub(super) fn catalog(hub: &Hub) -> Result<Catalog> {
    catalog_value(&hub.store.document("agents")?["value"])
}

fn catalog_value(value: &Value) -> Result<Catalog> {
    let backends = serde_json::from_value(value["desktop_backends"].clone())?;
    let mut names = HashMap::new();
    let mut read_only = std::collections::HashSet::new();
    for profile in value["profiles"]
        .as_array()
        .context("invalid Agent profiles")?
    {
        if let (Some(id), Some(name)) = (profile["id"].as_str(), profile["name"].as_str()) {
            if let Some(key) = value["desktop_ids"][id].as_str() {
                names.insert(key.into(), name.into());
                if profile["origin"] == "builtin" {
                    read_only.insert(key.into());
                }
            }
        }
    }
    Ok(Catalog {
        backends,
        names,
        ids: serde_json::from_value(value["desktop_ids"].clone())?,
        bindings: value["bindings"].clone(),
        read_only,
    })
}

fn publish(hub: &Hub, value: &Value) -> Result<()> {
    if let Some(ctx) = hub.ctx.upgrade() {
        *ctx.agent_backends.write() = Some(catalog_value(value)?);
    }
    Ok(())
}

/// dsh edits the same document. Keep desktop projections and opaque migration
/// metadata server-owned even when an older client submits only profiles/bindings.
pub(super) fn save(hub: &Hub, revision: u64, mut next: Value) -> Result<Value> {
    let previous = hub.store.document("agents")?;
    if previous["revision"].as_u64() != Some(revision) {
        bail!("configuration changed; reload before saving");
    }
    let old = &previous["value"];
    let object = next.as_object_mut().context("invalid Agent document")?;
    for field in ["desktop_backends", "desktop_ids", "shared_registry_version"] {
        object.insert(field.into(), old[field].clone());
    }
    if !object.contains_key("dsh_migrated") {
        object.insert("dsh_migrated".into(), old["dsh_migrated"].clone());
    }
    if object.get("version") != Some(&json!(1))
        || !object.get("bindings").is_some_and(Value::is_object)
    {
        bail!("invalid Agent document");
    }
    let profiles = object
        .get("profiles")
        .and_then(Value::as_array)
        .context("invalid Agent profiles")?
        .clone();
    let mut ids = old["desktop_ids"].as_object().cloned().unwrap_or_default();
    let mut backends = old["desktop_backends"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut active_keys = std::collections::HashSet::new();
    for item in &profiles {
        let id = item["id"]
            .as_str()
            .filter(|id| super::model::valid_id(id))
            .context("invalid Agent ID")?;
        if !seen.insert(id) {
            bail!("duplicate Agent ID");
        }
        let inherited = old["profiles"]
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|old| old["name"] == item["name"] && old["type"] == item["type"])
            })
            .and_then(|old| old["id"].as_str())
            .and_then(|id| ids.get(id))
            .cloned();
        let key = ids
            .entry(id)
            .or_insert_with(|| {
                inherited.unwrap_or_else(|| json!(id.strip_prefix("kode-").unwrap_or(id)))
            })
            .as_str()
            .context("invalid desktop Agent key")?
            .to_owned();
        active_keys.insert(key.clone());
        let previous = backends
            .get(&key)
            .map(|raw| serde_json::from_value(raw.clone()))
            .transpose()?;
        backends.insert(
            key,
            serde_json::to_value(backend(item, previous.as_ref())?)?,
        );
    }
    for item in old["profiles"]
        .as_array()
        .context("invalid stored Agent profiles")?
    {
        if let Some(id) = item["id"].as_str().filter(|id| !seen.contains(id)) {
            if let Some(key) = ids[id].as_str().filter(|key| !active_keys.contains(*key)) {
                backends.remove(key);
            }
        }
    }
    object.insert("desktop_ids".into(), Value::Object(ids));
    object.insert("desktop_backends".into(), Value::Object(backends));
    let saved = hub.store.save_document("agents", revision, next)?;
    publish(hub, &saved["value"])?;
    Ok(saved)
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(super) enum Change {
    Save {
        key: String,
        config: BackendConfig,
        name: Option<String>,
    },
    Remove {
        key: String,
    },
    Enable {
        key: String,
        enabled: bool,
    },
    Bind {
        key: String,
        thread_id: String,
        config: BackendConfig,
        cwd: String,
        title: String,
        model: Option<String>,
    },
}

pub fn resolve(catalog: &Catalog, key: &str, thread_id: Option<&str>) -> Result<BackendConfig> {
    if let Some(thread_id) = thread_id {
        if let Some(binding) = catalog.bindings.as_object().and_then(|rows| {
            rows.values().find(|binding| {
                binding["threadId"].as_str() == Some(thread_id)
                    && (binding["backendKey"].as_str() == Some(key)
                        || binding["profile"]["id"]
                            .as_str()
                            .and_then(|id| catalog.ids.get(id))
                            .map(String::as_str)
                            == Some(key))
            })
        }) {
            if let Some(config) = binding.get("desktopConfig") {
                return Ok(serde_json::from_value(config.clone())?);
            }
            return backend(&binding["profile"], catalog.backends.get(key));
        }
    }
    catalog
        .backends
        .get(key)
        .cloned()
        .context("Agent is not configured")
}

pub(super) fn change(hub: &Hub, command: Change) -> Result<Catalog> {
    if let Change::Bind {
        key,
        thread_id,
        config,
        cwd,
        title,
        model,
    } = &command
    {
        if !super::model::valid_id(thread_id) || !std::path::Path::new(cwd).is_absolute() {
            bail!("invalid native session identity");
        }
        let row = hub.store.document("agents")?;
        let mut value = row["value"].clone();
        let id = value["desktop_ids"]
            .as_object()
            .and_then(|ids| {
                ids.iter()
                    .find(|(_, v)| v.as_str() == Some(key))
                    .map(|(id, _)| id.clone())
            })
            .unwrap_or_else(|| format!("kode-{key}"));
        let binding_id = format!("native:{key}:{thread_id}");
        if value["bindings"].get(&binding_id).is_none() {
            if let Some(mut item) = profile(key, config) {
                item["id"] = json!(id);
                value["bindings"][&binding_id] = json!({"threadId":thread_id,"profile":item,"runtime":"pty","backendKey":key,"desktopConfig":config,"seenInputs":[]});
                let saved =
                    hub.store
                        .save_document("agents", row["revision"].as_u64().unwrap(), value)?;
                publish(hub, &saved["value"])?;
            }
        }
        for attempt in 0..4 {
            let index = hub.store.document("session-index")?;
            let mut value = index["value"].as_object().cloned().unwrap_or_default();
            let rows = value
                .entry("native_sessions")
                .or_insert(json!([]))
                .as_array_mut()
                .context("invalid native session catalog")?;
            let mut item = json!({"backend_key":key,"agent_id":id,"session_id":thread_id,"cwd":cwd,"title":title,"model":model,"transport_kind":"pty","endpoint_id":null});
            if let Some(existing) = rows
                .iter_mut()
                .find(|row| row["backend_key"] == *key && row["session_id"] == *thread_id)
            {
                if let Some(id) = existing.get("dsh_session_id") {
                    item["dsh_session_id"] = id.clone();
                }
                if *existing == item {
                    break;
                }
                *existing = item;
            } else {
                rows.push(item);
            }
            match hub.store.save_document(
                "session-index",
                index["revision"].as_u64().unwrap(),
                Value::Object(value),
            ) {
                Ok(_) => break,
                Err(error)
                    if attempt < 3 && error.to_string().contains("configuration changed") =>
                {
                    continue
                }
                Err(error) => return Err(error),
            }
        }
        return catalog(hub);
    }
    let row = hub.store.document("agents")?;
    let mut value = row["value"].clone();
    let key = match &command {
        Change::Save { key, .. } | Change::Remove { key } | Change::Enable { key, .. } => {
            key.clone()
        }
        Change::Bind { .. } => unreachable!(),
    };
    if key.is_empty()
        || key.len() > 155
        || !key.as_bytes()[0].is_ascii_alphanumeric()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        bail!("invalid Agent key");
    }
    let previous: Option<BackendConfig> = value["desktop_backends"]
        .get(&key)
        .map(|raw| serde_json::from_value(raw.clone()))
        .transpose()?;
    let id = value["desktop_ids"]
        .as_object()
        .and_then(|ids| {
            ids.iter()
                .find(|(_, v)| v.as_str() == Some(&key))
                .map(|(id, _)| id.clone())
        })
        .unwrap_or_else(|| format!("kode-{key}"));
    let current = value["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|profile| profile["id"] == id)
        .cloned();
    if current
        .as_ref()
        .is_some_and(|profile| profile["origin"] == "builtin")
    {
        bail!("Built-in Agent is read-only; add a custom configuration");
    }
    let (config, name) = match command {
        Change::Save {
            mut config, name, ..
        } => {
            if config.protocol.is_none() {
                config.protocol = previous.as_ref().and_then(|old| old.protocol.clone());
            }
            if config.command.trim().is_empty()
                || config.command.contains('\0')
                || config.args.iter().any(|arg| arg.contains('\0'))
            {
                bail!("invalid Agent command or arguments");
            }
            if config.protocol.as_deref().is_some_and(|protocol| {
                ![
                    "codex",
                    "tcodex",
                    "claude",
                    "tclaude",
                    "claude-internal",
                    "codebuddy",
                    "cursor",
                    "raw",
                ]
                .contains(&protocol)
            }) {
                bail!("unsupported Agent protocol");
            }
            (Some(config), name)
        }
        Change::Enable { enabled, .. } => {
            let mut config = previous.context("Agent is not configured")?;
            config.enabled = Some(enabled);
            (Some(config), None)
        }
        Change::Remove { .. } => (None, None),
        Change::Bind { .. } => unreachable!(),
    };
    value["profiles"]
        .as_array_mut()
        .unwrap()
        .retain(|profile| profile["id"] != id);
    if let Some(config) = config {
        value["desktop_backends"][&key] = serde_json::to_value(&config)?;
        let candidate = profile(&key, &config).or_else(|| {
            current
                .as_ref()
                .filter(|_| config.is_enabled())
                .map(|old| launch_profile(&key, &config, old["type"].as_str().unwrap_or("custom")))
        });
        if let Some(mut item) = candidate {
            if let Some(old) = current.as_ref().filter(|old| {
                old["type"] == "custom"
                    && (config.protocol.as_deref() == Some("raw") || old["protocol"] == "codex")
            }) {
                item["type"] = old["type"].clone();
                item["protocol"] = old["protocol"].clone();
            }
            item["id"] = json!(id);
            item["name"] = json!(name
                .filter(|name| !name.trim().is_empty())
                .or_else(|| current
                    .as_ref()
                    .and_then(|old| old["name"].as_str().map(str::to_owned)))
                .unwrap_or_else(|| key.clone()));
            value["profiles"].as_array_mut().unwrap().push(item);
        }
    } else {
        value["desktop_backends"]
            .as_object_mut()
            .unwrap()
            .remove(&key);
    }
    value["desktop_ids"][&id] = json!(key);
    let saved = hub
        .store
        .save_document("agents", row["revision"].as_u64().unwrap(), value)?;
    publish(hub, &saved["value"])?;
    catalog_value(&saved["value"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn codebuddy_keeps_its_protocol_and_permission_flags_for_named_profiles(){
        let defaults=kode_core::Config::default();let item=profile("codebuddy",&defaults.backends["codebuddy"]).unwrap();
        assert_eq!(item["type"],"codebuddy");let configured=backend(&item,None).unwrap();
        assert_eq!(configured.protocol.as_deref(),Some("codebuddy"));assert_eq!(configured.permission_mode_flag.as_deref(),Some("--permission-mode"));
    }

    fn host() -> (tempfile::TempDir, Arc<crate::Ctx>, Arc<Hub>) {
        let root = tempfile::tempdir().unwrap();
        let mut config = kode_core::Config::default();
        let template = config.backends["codex"].clone();
        config.backends.clear();
        for (key, provider) in [
            ("native-codex", "openai"),
            ("gateway-codex", "shared_codex"),
            ("tcodex", "tencent"),
        ] {
            let mut entry = template.clone();
            entry.protocol = Some(if key == "tcodex" { "tcodex" } else { "codex" }.into());
            entry.args = vec!["-c".into(), format!("model_provider=\"{provider}\"")];
            entry.enabled = Some(true);
            config.backends.insert(key.into(), entry);
        }
        let ctx =
            crate::build_runtime_ctx(config, "shared-agent-test-token-at-least-32-bytes".into());
        let hub = Hub::open(
            super::super::Config {
                node_id: "shared-agent-test".into(),
                database: root.path().join("agents.sqlite"),
                peers: vec![],
            },
            &ctx,
        )
        .unwrap();
        (root, ctx, hub)
    }

    #[tokio::test]
    async fn desktop_and_dsh_edit_one_registry_with_stable_agent_ids() {
        let (_root, ctx, hub) = host();
        assert_eq!(catalog(&hub).unwrap().backends.len(), 3);
        let mut config = catalog(&hub).unwrap().backends["native-codex"].clone();
        config.args = vec!["-c".into(), "model_provider=\"openai\"".into()];
        change(
            &hub,
            Change::Save {
                key: "work-agent".into(),
                config,
                name: Some("My original Codex".into()),
            },
        )
        .unwrap();
        let row = hub.store.document("agents").unwrap();
        let mut document = row["value"].clone();
        let item = document["profiles"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["id"] == "kode-work-agent")
            .unwrap();
        assert_eq!(item["name"], "My original Codex");
        item["name"] = json!("Renamed in dsh");
        item["args"] = json!(["-c", "model_provider=\"gateway_v2\""]);
        item["env"] = json!({"EXAMPLE_KEY":"private-fixture-value"});
        save(&hub, row["revision"].as_u64().unwrap(), document).unwrap();
        let shared = catalog(&hub).unwrap();
        assert_eq!(shared.names["work-agent"], "Renamed in dsh");
        assert_eq!(
            shared.backends["work-agent"].protocol.as_deref(),
            Some("codex")
        );
        assert_eq!(ctx.backends()["work-agent"], shared.backends["work-agent"]);
        assert_eq!(shared.backends["work-agent"].command, "/usr/bin/env");
        let config = shared.backends["work-agent"].clone();
        change(
            &hub,
            Change::Save {
                key: "work-agent".into(),
                config,
                name: Some("Edited in desktop".into()),
            },
        )
        .unwrap();
        let row = hub.store.document("agents").unwrap();
        let item = row["value"]["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "kode-work-agent")
            .unwrap();
        assert_eq!(item["name"], "Edited in desktop");
        assert_eq!(item["env"]["EXAMPLE_KEY"], "private-fixture-value");
        assert_eq!(item["executable"], "codex");
        assert_eq!(item["args"], json!(["-c", "model_provider=\"gateway_v2\""]));
    }

    #[tokio::test]
    async fn edits_and_deletion_do_not_change_a_bound_native_session_or_its_catalog_entry() {
        let (root, ctx, hub) = host();
        let old = catalog(&hub).unwrap().backends["native-codex"].clone();
        change(
            &hub,
            Change::Bind {
                key: "native-codex".into(),
                thread_id: "thread-before-edit".into(),
                config: old.clone(),
                cwd: root.path().to_string_lossy().into(),
                title: "Existing session".into(),
                model: Some("native-model".into()),
            },
        )
        .unwrap();
        let row = hub.store.document("agents").unwrap();
        let mut document = row["value"].clone();
        let item = document["profiles"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["id"] == "kode-native-codex")
            .unwrap();
        item["args"] = json!(["-c", "model_provider=\"another_service\""]);
        save(&hub, row["revision"].as_u64().unwrap(), document).unwrap();
        assert_ne!(ctx.backends()["native-codex"].args, old.args);
        assert_eq!(
            ctx.backend_for_session("native-codex", Some("thread-before-edit"))
                .unwrap(),
            old
        );
        change(
            &hub,
            Change::Remove {
                key: "native-codex".into(),
            },
        )
        .unwrap();
        assert!(!ctx.backends().contains_key("native-codex"));
        assert_eq!(
            ctx.backend_for_session("native-codex", Some("thread-before-edit"))
                .unwrap(),
            old
        );
        let index = hub.store.document("session-index").unwrap();
        assert_eq!(
            index["value"]["native_sessions"][0]["agent_id"],
            "kode-native-codex"
        );
        let mut closed = index["value"].clone();
        closed["gui"] = json!({"tabs":[]});
        hub.store
            .save_document("session-index", index["revision"].as_u64().unwrap(), closed)
            .unwrap();
        assert_eq!(
            hub.store.document("session-index").unwrap()["value"]["native_sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn disable_delete_restart_and_stale_writes_do_not_resurrect_agents() {
        let (root, ctx, hub) = host();
        let stale = hub.store.document("agents").unwrap();
        change(
            &hub,
            Change::Enable {
                key: "tcodex".into(),
                enabled: false,
            },
        )
        .unwrap();
        assert!(!catalog(&hub).unwrap().backends["tcodex"].is_enabled());
        assert!(hub.store.document("agents").unwrap()["value"]["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != "kode-tcodex"));
        assert!(save(
            &hub,
            stale["revision"].as_u64().unwrap(),
            stale["value"].clone()
        )
        .unwrap_err()
        .to_string()
        .contains("configuration changed"));
        change(
            &hub,
            Change::Enable {
                key: "tcodex".into(),
                enabled: true,
            },
        )
        .unwrap();
        let row = hub.store.document("agents").unwrap();
        let mut next = row["value"].clone();
        next["profiles"]
            .as_array_mut()
            .unwrap()
            .retain(|row| row["id"] != "kode-gateway-codex");
        save(&hub, row["revision"].as_u64().unwrap(), next).unwrap();
        assert!(!ctx.backends().contains_key("gateway-codex"));
        drop(hub);
        let hub = Hub::open(
            super::super::Config {
                node_id: "shared-agent-test".into(),
                database: root.path().join("agents.sqlite"),
                peers: vec![],
            },
            &ctx,
        )
        .unwrap();
        assert!(!catalog(&hub)
            .unwrap()
            .backends
            .contains_key("gateway-codex"));
    }
}
