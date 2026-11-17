//! `kode-extension.json` (schema `kode.extension/v1`).
//!
//! The manifest is declarative: Kode reads it to show the extension, decide
//! which capabilities to hand over, and how to start its optional backend.
//! Nothing inside the package runs before the user enables it.

use std::path::{Component, Path};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "kode-extension.json";
pub const SCHEMA: &str = "kode.extension/v1";

/// Capabilities an extension may request. Unknown names are rejected so a
/// typo never silently grants nothing (or, later, something else).
pub const CAPABILITIES: &[&str] = &[
    // Pass the shared workbench service connection (URL + admin token file)
    // to the backend. This is the session catalog, runtime registry and
    // messaging service that GUI and dsh already share.
    "workbench",
    // Contribute alternative session views.
    "session.views",
    // Switch a session between the PTY runtime and the extension's runtime.
    "session.runtime",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: String,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub engines: Engines,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub backend: Option<Backend>,
    #[serde(default)]
    pub contributes: Contributes,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Engines {
    /// Semver requirement against the Kode app version, e.g. `>=0.2.2`.
    #[serde(default)]
    pub kode: Option<String>,
}

/// A long-running child process. It must print one JSON ready line
/// (`{"type":"kode.extension.ready","protocol_version":1,"url":...}`) on
/// stdout, and exit when its stdin reaches EOF.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Backend {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Startup can include a first-run dependency install.
    #[serde(default = "default_ready_timeout")]
    pub ready_timeout_secs: u64,
}

fn default_ready_timeout() -> u64 {
    180
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Contributes {
    #[serde(default, rename = "sessionViews")]
    pub session_views: Vec<SessionView>,
}

/// An alternative presentation for a session tab, served by the backend.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionView {
    pub id: String,
    pub title: String,
    /// Workbench runtime (`dsh`) whose sessions open in this view.
    #[serde(default)]
    pub runtime: Option<String>,
    /// Backend keys whose PTY sessions can be switched into `runtime`
    /// (`codex`, `claude`, ...). The runtime must answer `import_session`.
    #[serde(default)]
    pub backends: Vec<String>,
    /// Path appended to the backend's ready URL origin.
    #[serde(default = "default_view_path")]
    pub path: String,
    /// `data-*` attributes Kode sets on `<html>` before the page runs, per
    /// platform (`macos`, `windows`, `linux`, or `*`). Lets a web UI pick its
    /// desktop layout (e.g. room for the macOS traffic lights) without a
    /// flash of the browser layout.
    #[serde(default, rename = "htmlAttributes")]
    pub html_attributes: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    /// Elements that move the window when dragged, since the view covers
    /// Kode's own titlebar.
    #[serde(default, rename = "dragRegion")]
    pub drag_region: Option<DragRegion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DragRegion {
    pub selector: String,
    /// Descendants that stay clickable; form controls always do.
    #[serde(default)]
    pub exclude: Option<String>,
}

fn default_view_path() -> String {
    "/".into()
}

pub fn read(dir: &Path) -> Result<Manifest> {
    let path = dir.join(FILE_NAME);
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    manifest.validate()?;
    Ok(manifest)
}

impl Manifest {
    pub fn validate(&self) -> Result<()> {
        if self.schema != SCHEMA {
            bail!("unsupported schema `{}` (expected {SCHEMA})", self.schema);
        }
        if !valid_id(&self.id) {
            bail!("invalid extension id `{}`", self.id);
        }
        if self.name.trim().is_empty() {
            bail!("extension name is empty");
        }
        semver::Version::parse(&self.version)
            .with_context(|| format!("invalid version `{}`", self.version))?;
        if let Some(requirement) = &self.engines.kode {
            semver::VersionReq::parse(requirement)
                .with_context(|| format!("invalid engines.kode `{requirement}`"))?;
        }
        for capability in &self.capabilities {
            if !CAPABILITIES.contains(&capability.as_str()) {
                bail!("unknown capability `{capability}`");
            }
        }
        if let Some(backend) = &self.backend {
            if backend.command.trim().is_empty() {
                bail!("backend.command is empty");
            }
            if is_relative_path(&backend.command) && !stays_inside(&backend.command) {
                bail!("backend.command escapes the extension directory");
            }
        }
        let mut seen = std::collections::HashSet::new();
        for view in &self.contributes.session_views {
            if !valid_id(&view.id) || !seen.insert(view.id.as_str()) {
                bail!("invalid or duplicate session view id `{}`", view.id);
            }
            if !view.path.starts_with('/') {
                bail!("session view `{}` path must start with /", view.id);
            }
            if !view.backends.is_empty() && (view.runtime.is_none() || !self.has("session.runtime")) {
                bail!("session view `{}` switches backends; it needs a runtime and the session.runtime capability", view.id);
            }
            if view.runtime.as_deref().is_some_and(|r| r == "gui" || !valid_id(r)) {
                bail!("session view `{}` has an invalid runtime", view.id);
            }
            for (platform, attributes) in &view.html_attributes {
                if !matches!(platform.as_str(), "*" | "macos" | "windows" | "linux") {
                    bail!("session view `{}`: unknown platform `{platform}`", view.id);
                }
                if let Some(name) = attributes.keys().find(|name| !valid_data_attribute(name)) {
                    bail!("session view `{}`: `{name}` is not a data-* attribute", view.id);
                }
            }
        }
        if !self.contributes.session_views.is_empty() {
            if !self.has("session.views") {
                bail!("sessionViews requires the session.views capability");
            }
            if self.backend.is_none() {
                bail!("sessionViews require a backend to serve them");
            }
        }
        Ok(())
    }

    pub fn has(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }

    /// `None` when the manifest does not constrain the version.
    pub fn compatible_with(&self, app_version: &str) -> Result<bool> {
        let Some(requirement) = &self.engines.kode else {
            return Ok(true);
        };
        let requirement = semver::VersionReq::parse(requirement)?;
        let version = semver::Version::parse(app_version)?;
        // Pre-release app builds (`0.2.2-dev`) should satisfy `>=0.2.2`.
        let release = semver::Version::new(version.major, version.minor, version.patch);
        Ok(requirement.matches(&version) || requirement.matches(&release))
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'))
        && !id.starts_with('.')
        && !id.contains("..")
}

fn valid_data_attribute(name: &str) -> bool {
    name.strip_prefix("data-").is_some_and(|rest| {
        !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

fn is_relative_path(command: &str) -> bool {
    command.starts_with("./") || command.starts_with("../")
}

fn stays_inside(relative: &str) -> bool {
    let mut depth = 0i32;
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(_) => depth += 1,
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Manifest {
        serde_json::from_value(serde_json::json!({
            "schema": SCHEMA,
            "id": "kode.new-ui",
            "name": "dsh UI",
            "version": "0.1.0",
            "engines": { "kode": ">=0.2.2" },
            "capabilities": ["workbench", "session.views"],
            "backend": { "command": "./bin/start.mjs" },
            "contributes": { "sessionViews": [{ "id": "dsh", "title": "dsh", "runtime": "dsh" }] }
        }))
        .unwrap()
    }

    /// The extension `run.sh app` bundles into the app must stay valid.
    #[test]
    fn bundled_dsh_extension_manifest_is_valid() {
        let manifest: Manifest = serde_json::from_str(include_str!(
            "../../../../../integrations/dsh/kode-extension/kode-extension.json"
        ))
        .unwrap();
        manifest.validate().unwrap();
        assert_eq!(manifest.id, "kode.new-ui");
    }

    #[test]
    fn accepts_valid_manifest() {
        sample().validate().unwrap();
    }

    #[test]
    fn rejects_unknown_capability_and_escape() {
        let mut manifest = sample();
        manifest.capabilities.push("fs.all".into());
        assert!(manifest.validate().is_err());
        let mut manifest = sample();
        manifest.backend.as_mut().unwrap().command = "./../../bin/sh".into();
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn views_need_capability_and_backend() {
        let mut manifest = sample();
        manifest.capabilities.retain(|c| c != "session.views");
        assert!(manifest.validate().is_err());
        let mut manifest = sample();
        manifest.backend = None;
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn backend_switching_needs_runtime_capability() {
        let mut manifest = sample();
        manifest.contributes.session_views[0].backends = vec!["codex".into()];
        assert!(manifest.validate().is_err());
        manifest.capabilities.push("session.runtime".into());
        manifest.validate().unwrap();
        manifest.contributes.session_views[0].runtime = Some("gui".into());
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn html_attributes_are_data_only() {
        let mut manifest = sample();
        let attributes = |name: &str| [("macos".to_string(), [(name.to_string(), "darwin".to_string())].into())].into();
        manifest.contributes.session_views[0].html_attributes = attributes("data-platform");
        manifest.validate().unwrap();
        manifest.contributes.session_views[0].html_attributes = attributes("onload");
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn prerelease_app_satisfies_release_requirement() {
        assert!(sample().compatible_with("0.2.2-dev").unwrap());
        assert!(!sample().compatible_with("0.2.1").unwrap());
    }

    #[test]
    fn rejects_bad_ids() {
        for id in ["", "Kode", "a/b", "..x", ".hidden"] {
            assert!(!valid_id(id), "{id}");
        }
        assert!(valid_id("kode.team"));
    }
}
