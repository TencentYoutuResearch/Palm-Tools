//! Resolve skill destinations from the Agent registry on the host that owns them.
use super::{extension_files::TARGETS, Hub};
use anyhow::Result;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

pub(super) struct Targets {
    pub paths: BTreeMap<String, String>,
    pub profiles: BTreeMap<String, String>,
    pub native_launch: BTreeMap<String, &'static str>,
}

pub(super) fn catalog(hub: &Hub) -> Result<Targets> {
    let agents = hub.store.document("agents")?;
    let mut paths = TARGETS
        .iter()
        .map(|(key, path)| (key.to_string(), path.to_string()))
        .collect::<BTreeMap<_, _>>();
    let mut profiles = BTreeMap::new();
    let mut native_launch = TARGETS
        .iter()
        .filter_map(|(target, _)| launch_kind(target).map(|kind| (target.to_string(), kind)))
        .collect::<BTreeMap<_, _>>();
    for profile in agents["value"]["profiles"].as_array().into_iter().flatten() {
        if let (Some(id), Some((target, directory))) =
            (profile["id"].as_str(), for_profile(profile))
        {
            paths.insert(target.clone(), directory);
            if let Some(kind) = launch_kind_for_profile(profile) {
                native_launch.insert(target.clone(), kind);
            }
            profiles.insert(id.to_owned(), target);
        }
    }
    Ok(Targets {
        paths,
        profiles,
        native_launch,
    })
}

fn configured_path(profile: &Value, key: &str, append_skills: bool) -> Option<String> {
    let value = profile["env"][key].as_str()?;
    let path = Path::new(value);
    if !path.is_absolute() {
        return None;
    }
    let directory = if append_skills {
        path.join("skills")
    } else {
        path.to_path_buf()
    };
    Some(directory.to_str()?.to_owned())
}

pub(super) fn for_profile(profile: &Value) -> Option<(String, String)> {
    let kind = profile["type"].as_str()?;
    let executable = profile["executable"]
        .as_str()
        .and_then(|name| Path::new(name).file_stem())
        .and_then(|name| name.to_str());
    let family = match (kind, executable) {
        ("codex" | "custom", Some("tcodex")) => "tcodex",
        ("claude" | "custom", Some("tclaude")) => "tclaude",
        ("custom", Some("codex" | "claude" | "codebuddy" | "cursor-agent")) => {
            if executable == Some("cursor-agent") {
                "cursor"
            } else {
                executable?
            }
        }
        ("custom", _)
            if profile["protocol"] == "codex" && profile["env"]["CODEX_HOME"].is_string() =>
        {
            "codex"
        }
        _ => kind,
    };
    let config_variable = match family {
        "codex" | "tcodex" => "CODEX_HOME",
        "claude" | "tclaude" => "CLAUDE_CONFIG_DIR",
        "codebuddy" => "CODEBUDDY_CONFIG_DIR",
        _ => "",
    };
    let explicit = configured_path(profile, "KODE_SKILLS_DIR", false)
        .or_else(|| configured_path(profile, config_variable, true));
    if let Some(directory) = explicit {
        // The path is part of the identity so editing an Agent cannot redirect an existing source.
        let native = launch_kind_for_profile(profile).unwrap_or("");
        let digest = Sha256::digest(serde_json::to_vec(&json!([native, directory])).ok()?);
        return Some((format!("directory-{digest:x}"), directory));
    }
    let directory = TARGETS.iter().find(|(target, _)| *target == family)?.1;
    Some((family.into(), directory.into()))
}

pub(super) fn launch_kind(target: &str) -> Option<&'static str> {
    match target {
        "claude" | "tclaude" => Some("claude"),
        "codebuddy" => Some("codebuddy"),
        "cursor" => Some("cursor"),
        _ => None,
    }
}

pub(super) fn launch_kind_for_profile(profile: &Value) -> Option<&'static str> {
    match profile["type"].as_str()? {
        "claude" => Some("claude"),
        "codebuddy" => Some("codebuddy"),
        "cursor" => Some("cursor"),
        // A generic adapter owns its own argv contract.
        _ => None,
    }
}
