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

/// Host capabilities an extension may request, besides the extension API's
/// own (`kode_bridge::messaging::ext::CAPABILITIES`). Unknown names are
/// rejected so a typo never silently grants nothing (or something else).
pub const CAPABILITIES: &[&str] = &[
    // Pass the shared workbench service connection (URL + admin token file)
    // to the backend. This is the session catalog, runtime registry and
    // messaging service that GUI and dsh already share.
    "workbench",
    // Contribute alternative session views.
    "session.views",
    // Switch a session between the PTY runtime and the extension's runtime.
    "session.runtime",
    // Contribute pages to Kode's main area, opened from the activity rail.
    "ui.panels",
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
    #[serde(default)]
    pub panels: Vec<Panel>,
}

/// A page in Kode's main area (beside the session sidebar, not over the
/// whole window), served by the backend and opened from the activity rail.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Panel {
    pub id: String,
    pub title: String,
    /// Name of a Kode icon for the rail; unknown names fall back to a generic one.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default = "default_view_path")]
    pub path: String,
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

pub struct ViewSpec {
    pub path: String,
    pub html_attributes: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    pub drag_region: Option<DragRegion>,
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
            if !CAPABILITIES.contains(&capability.as_str())
                && !kode_bridge::messaging::ext::CAPABILITIES.contains(&capability.as_str())
            {
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
        for panel in &self.contributes.panels {
            if !valid_id(&panel.id) || !seen.insert(panel.id.as_str()) {
                bail!("invalid or duplicate view id `{}`", panel.id);
            }
            if !panel.path.starts_with('/') {
                bail!("panel `{}` path must start with /", panel.id);
            }
            if panel.icon.as_ref().is_some_and(|icon| icon.len() > 40 || !icon.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')) {
                bail!("panel `{}` icon must be a Kode icon name", panel.id);
            }
        }
        if !self.contributes.panels.is_empty() && (!self.has("ui.panels") || self.backend.is_none()) {
            bail!("panels need the ui.panels capability and a backend to serve them");
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

    /// Where a session view or panel is served, plus its embed hints.
    pub fn view(&self, id: &str) -> Option<ViewSpec> {
        if let Some(view) = self.contributes.session_views.iter().find(|v| v.id == id) {
            return Some(ViewSpec {
                path: view.path.clone(),
                html_attributes: view.html_attributes.clone(),
                drag_region: view.drag_region.clone(),
            });
        }
        self.contributes.panels.iter().find(|p| p.id == id).map(|panel| ViewSpec {
            path: panel.path.clone(),
            html_attributes: Default::default(),
            drag_region: None,
        })
    }

    pub fn has(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }

    /// Capabilities served by the extension API (`kode.api/v1`). A backend
    /// that requests any gets its own scoped token instead of the admin one.
    pub fn api_capabilities(&self) -> Vec<String> {
        self.capabilities
            .iter()
            .filter(|c| kode_bridge::messaging::ext::CAPABILITIES.contains(&c.as_str()))
            .cloned()
            .collect()
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
    fn panels_need_capability_backend_and_unique_ids() {
        let mut manifest = sample();
        manifest.contributes.panels = serde_json::from_value(serde_json::json!([{ "id": "team", "title": "Team", "icon": "users" }])).unwrap();
        assert!(manifest.validate().is_err(), "ui.panels is required");
        manifest.capabilities.push("ui.panels".into());
        manifest.validate().unwrap();
        assert_eq!(manifest.view("team").unwrap().path, "/");
        assert!(manifest.view("dsh").is_some() && manifest.view("missing").is_none());
        manifest.contributes.panels[0].id = "dsh".into();
        assert!(manifest.validate().is_err(), "panel ids share the namespace of session views");
        manifest.contributes.panels[0].id = "team".into();
        manifest.contributes.panels[0].icon = Some("<svg>".into());
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn accepts_valid_manifest() {
        sample().validate().unwrap();
    }

    #[test]
    fn extension_api_capabilities_are_accepted_and_separated() {
        let example: Manifest = serde_json::from_str(include_str!(
            "../../../../../integrations/ext-sample/kode-extension.json"
        ))
        .unwrap();
        example.validate().unwrap();
        assert!(!example.has("workbench"), "the sample proves the API needs no admin access");
        let mut manifest = sample();
        manifest.capabilities.extend(["sessions.create".into(), "events.subscribe".into()]);
        manifest.validate().unwrap();
        assert_eq!(manifest.api_capabilities(), ["sessions.create", "events.subscribe"]);
        assert!(sample().api_capabilities().is_empty(), "host-only manifests get no API token");
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
