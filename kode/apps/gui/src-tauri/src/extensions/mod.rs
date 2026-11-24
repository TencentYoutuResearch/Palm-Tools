//! Kode extension host.
//!
//! Kode itself owns session management and sync; extensions add everything
//! else (alternative UIs, team channels, account providers) without being
//! compiled into the app. An extension is a directory with a
//! `kode-extension.json` manifest plus whatever its backend needs. Installing,
//! enabling, disabling and removing all take effect immediately: the host
//! emits `extensions-changed` and the frontend re-reads the registry.
//!
//! Layout under `<config>/kode/extensions/` (`KODE_EXTENSIONS_DIR` overrides):
//! - `registry.json`  installed extensions and their enabled flag
//! - `packages/<id>/` copied packages (linked ones stay where they are)
//! - `data/<id>/`     per-extension private data, survives upgrades
//!
//! Extensions shipped inside the app (`Resources/resources/extensions/<dir>`)
//! are installed on first start and upgraded when a newer app ships a newer
//! copy. Removing one is remembered, so it is not reinstalled.

mod backend;
pub mod manifest;
pub mod ui_feed;
pub mod view;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub use backend::{Progress, Running};
use manifest::Manifest;

pub const CHANGED_EVENT: &str = "extensions-changed";
/// `{ id, message, step, total }` while a backend starts.
pub const PROGRESS_EVENT: &str = "extension-progress";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct Registry {
    #[serde(default)]
    extensions: BTreeMap<String, Entry>,
    /// Bundled extensions the user removed.
    #[serde(default)]
    declined_bundled: BTreeSet<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Entry {
    source: Source,
    enabled: bool,
    /// Installed from the app bundle; follows the bundled copy's upgrades.
    #[serde(default)]
    bundled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Source {
    /// Copied into `packages/<id>`.
    Copy { origin: PathBuf },
    /// Used in place; for extension development.
    Link { path: PathBuf },
}

/// What the frontend sees for one extension.
#[derive(Clone, Debug, Serialize)]
pub struct ExtensionInfo {
    pub id: String,
    pub enabled: bool,
    pub linked: bool,
    pub dir: String,
    pub compatible: bool,
    pub manifest: Option<Manifest>,
    /// Manifest read/validation error; the entry stays listed so it can be
    /// removed or fixed in place.
    pub error: Option<String>,
    pub running: Option<Running>,
}

pub struct ExtensionHost {
    root: PathBuf,
    registry: Mutex<()>,
    backends: backend::Backends,
    views: view::Views,
    /// Where startup progress is emitted; unset in unit tests.
    app: Mutex<Option<AppHandle>>,
}

impl ExtensionHost {
    pub fn new() -> Result<Self> {
        // Isolated debug runs point this elsewhere, like KODE_GUI_STATE_PATH.
        if let Some(root) = std::env::var_os("KODE_EXTENSIONS_DIR") {
            return Ok(Self::at(PathBuf::from(root)));
        }
        let root = dirs::config_dir()
            .ok_or_else(|| anyhow!("config directory unavailable"))?
            .join("kode/extensions");
        Ok(Self::at(root))
    }

    fn at(root: PathBuf) -> Self {
        Self {
            root,
            registry: Mutex::new(()),
            backends: backend::Backends::default(),
            views: view::Views::default(),
            app: Mutex::new(None),
        }
    }

    pub fn attach(&self, app: AppHandle) {
        *self.app.lock() = Some(app);
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.json")
    }

    fn load(&self) -> Result<Registry> {
        match std::fs::read(self.registry_path()) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).context("parse extensions registry")?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, registry: &Registry) -> Result<()> {
        std::fs::create_dir_all(&self.root)?;
        let tmp = self.root.join("registry.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(registry)?)?;
        std::fs::rename(tmp, self.registry_path())?;
        Ok(())
    }

    fn package_dir(&self, id: &str, entry: &Entry) -> PathBuf {
        match &entry.source {
            Source::Copy { .. } => self.root.join("packages").join(id),
            Source::Link { path } => path.clone(),
        }
    }

    pub fn data_dir(&self, id: &str) -> PathBuf {
        self.root.join("data").join(id)
    }

    pub fn list(&self, app_version: &str) -> Result<Vec<ExtensionInfo>> {
        let _guard = self.registry.lock();
        let registry = self.load()?;
        Ok(registry
            .extensions
            .iter()
            .map(|(id, entry)| self.describe(id, entry, app_version))
            .collect())
    }

    fn describe(&self, id: &str, entry: &Entry, app_version: &str) -> ExtensionInfo {
        let dir = self.package_dir(id, entry);
        let (manifest, mut error) = match manifest::read(&dir) {
            Ok(m) if m.id == id => (Some(m), None),
            Ok(m) => (None, Some(format!("manifest id changed to `{}`", m.id))),
            Err(e) => (None, Some(format!("{e:#}"))),
        };
        let compatible = match manifest.as_ref().map(|m| m.compatible_with(app_version)) {
            Some(Ok(ok)) => ok,
            Some(Err(e)) => {
                error.get_or_insert(e.to_string());
                false
            }
            None => false,
        };
        if !compatible && error.is_none() {
            error = Some(format!(
                "requires Kode {}",
                manifest
                    .as_ref()
                    .and_then(|m| m.engines.kode.clone())
                    .unwrap_or_default()
            ));
        }
        ExtensionInfo {
            id: id.to_string(),
            enabled: entry.enabled,
            linked: matches!(entry.source, Source::Link { .. }),
            dir: dir.to_string_lossy().into_owned(),
            compatible,
            manifest,
            error,
            running: self.backends.status(id),
        }
    }

    /// Install or upgrade from a package directory. `link` keeps the
    /// directory in place (development); otherwise it is copied so the
    /// source can be deleted. An upgrade replaces the package atomically and
    /// keeps the enabled flag and data directory.
    pub fn install(&self, source: &Path, link: bool, app_version: &str) -> Result<ExtensionInfo> {
        self.install_from(source, link, false, app_version)
    }

    fn install_from(&self, source: &Path, link: bool, bundled: bool, app_version: &str) -> Result<ExtensionInfo> {
        let source = std::fs::canonicalize(source)
            .with_context(|| format!("extension directory {}", source.display()))?;
        let manifest = manifest::read(&source)?;
        if !manifest.compatible_with(app_version)? {
            bail!(
                "{} requires Kode {}",
                manifest.name,
                manifest.engines.kode.clone().unwrap_or_default()
            );
        }
        let id = manifest.id.clone();
        // A running backend holds files of the old package.
        self.backends.stop(&id);
        let _guard = self.registry.lock();
        let mut registry = self.load()?;
        let entry_source = if link {
            Source::Link { path: source.clone() }
        } else {
            let packages = self.root.join("packages");
            std::fs::create_dir_all(&packages)?;
            let staging = packages.join(format!(".{id}.staging"));
            let _ = std::fs::remove_dir_all(&staging);
            copy_dir(&source, &staging)?;
            let target = packages.join(&id);
            let old = packages.join(format!(".{id}.old"));
            let _ = std::fs::remove_dir_all(&old);
            if target.exists() {
                std::fs::rename(&target, &old)?;
            }
            if let Err(e) = std::fs::rename(&staging, &target) {
                if old.exists() {
                    let _ = std::fs::rename(&old, &target);
                }
                return Err(e.into());
            }
            let _ = std::fs::remove_dir_all(&old);
            Source::Copy { origin: source.clone() }
        };
        if let Some(Entry { source: Source::Copy { .. }, .. }) = registry.extensions.get(&id) {
            if link {
                let _ = std::fs::remove_dir_all(self.root.join("packages").join(&id));
            }
        }
        let enabled = registry.extensions.get(&id).map(|e| e.enabled).unwrap_or(true);
        let entry = Entry { source: entry_source, enabled, bundled };
        registry.extensions.insert(id.clone(), entry.clone());
        registry.declined_bundled.remove(&id);
        self.save(&registry)?;
        Ok(self.describe(&id, &entry, app_version))
    }

    pub fn uninstall(&self, id: &str) -> Result<()> {
        self.backends.stop(id);
        let _guard = self.registry.lock();
        let mut registry = self.load()?;
        let entry = registry
            .extensions
            .remove(id)
            .ok_or_else(|| anyhow!("extension {id} is not installed"))?;
        if let Source::Copy { .. } = entry.source {
            let _ = std::fs::remove_dir_all(self.root.join("packages").join(id));
        }
        if entry.bundled {
            registry.declined_bundled.insert(id.to_string());
        }
        self.save(&registry)
    }

    /// Install or upgrade the extensions shipped in `dir`. Returns whether
    /// anything changed. Extensions the user removed, linked, or installed
    /// from elsewhere are left alone.
    pub fn seed_bundled(&self, dir: &Path, app_version: &str) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut changed = false;
        for package in entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()) {
            let bundled = match manifest::read(&package) {
                Ok(manifest) => manifest,
                Err(error) => {
                    tracing::warn!(path = %package.display(), error = %format!("{error:#}"), "invalid bundled extension");
                    continue;
                }
            };
            let wanted = {
                let _guard = self.registry.lock();
                let Ok(registry) = self.load() else { return changed };
                if registry.declined_bundled.contains(&bundled.id) {
                    false
                } else {
                    match registry.extensions.get(&bundled.id) {
                        None => true,
                        Some(entry @ Entry { source: Source::Copy { .. }, bundled: true, .. }) => {
                            let dir = self.package_dir(&bundled.id, entry);
                            let installed = manifest::read(&dir)
                                .ok()
                                .and_then(|m| semver::Version::parse(&m.version).ok());
                            let shipped = semver::Version::parse(&bundled.version).ok();
                            // Rebuilt apps often ship new content under the
                            // same version; refresh those too.
                            installed.is_none()
                                || shipped > installed
                                || (shipped == installed && !same_tree(&package, &dir))
                        }
                        Some(_) => false,
                    }
                }
            };
            if !wanted {
                continue;
            }
            match self.install_from(&package, false, true, app_version) {
                Ok(_) => {
                    tracing::info!(extension = %bundled.id, version = %bundled.version, "installed bundled extension");
                    changed = true;
                }
                Err(error) => tracing::warn!(extension = %bundled.id, error = %format!("{error:#}"), "bundled extension install failed"),
            }
        }
        changed
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        if !enabled {
            self.backends.stop(id);
        }
        let _guard = self.registry.lock();
        let mut registry = self.load()?;
        let entry = registry
            .extensions
            .get_mut(id)
            .ok_or_else(|| anyhow!("extension {id} is not installed"))?;
        entry.enabled = enabled;
        self.save(&registry)
    }

    /// Manifest and directory of an enabled, valid extension.
    fn active(&self, id: &str, app_version: &str) -> Result<(Manifest, PathBuf)> {
        let _guard = self.registry.lock();
        let registry = self.load()?;
        let entry = registry
            .extensions
            .get(id)
            .ok_or_else(|| anyhow!("extension {id} is not installed"))?;
        if !entry.enabled {
            bail!("extension {id} is disabled");
        }
        let info = self.describe(id, entry, app_version);
        if let Some(error) = info.error {
            bail!("extension {id}: {error}");
        }
        Ok((info.manifest.expect("valid manifest"), self.package_dir(id, entry)))
    }

    /// Start the backend if needed. Blocking.
    pub fn ensure_backend(&self, id: &str, app_version: &str) -> Result<Running, String> {
        let (manifest, dir) = self.active(id, app_version).map_err(|e| format!("{e:#}"))?;
        let data_dir = self.data_dir(id);
        let mut env = vec![
            ("KODE_EXTENSION_ID".to_string(), id.to_string()),
            ("KODE_EXTENSION_DIR".to_string(), dir.to_string_lossy().into_owned()),
            ("KODE_EXTENSION_DATA".to_string(), data_dir.to_string_lossy().into_owned()),
            ("KODE_APP_VERSION".to_string(), app_version.to_string()),
        ];
        if manifest.has("workbench") {
            let path = crate::workbench_state::connection_path().map_err(|e| e.to_string())?;
            env.push((
                "KODE_WORKBENCH_CONNECTION".into(),
                path.to_string_lossy().into_owned(),
            ));
        }
        let app = self.app.lock().clone();
        let extension = id.to_string();
        let on_progress = Box::new(move |progress: Progress| {
            if let Some(app) = &app {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    serde_json::json!({"id": extension, "message": progress.message, "step": progress.step, "total": progress.total}),
                );
            }
        });
        let capabilities = manifest.api_capabilities();
        let grant_for = id.to_string();
        let spawn_env = (!capabilities.is_empty()).then(|| {
            Box::new(move || {
                tauri::async_runtime::block_on(api_grant(&grant_for, &capabilities))
            }) as Box<dyn FnOnce() -> Result<Vec<(String, String)>, String>>
        });
        self.backends.ensure(backend::Launch {
            manifest: &manifest,
            dir: &dir,
            data_dir: &data_dir,
            env,
            spawn_env,
            on_progress,
        })
    }

    pub fn shutdown(&self) {
        self.backends.stop_all();
    }
}

/// `Contents/Resources/resources/extensions` in the app bundle;
/// `KODE_BUNDLED_EXTENSIONS_DIR` overrides it for development.
/// Mint the extension's scoped token (revoking its previous one) and tell the
/// backend where the extension API lives. The admin token stays in Kode.
async fn api_grant(id: &str, capabilities: &[String]) -> Result<Vec<(String, String)>, String> {
    let granted = crate::backend_runtime::call(
        "/extensions/grants",
        Some(serde_json::json!({"extension_id": id, "capabilities": capabilities})),
    )
    .await
    .map_err(|e| format!("extension API unavailable: {e}"))?;
    let token = granted["token"].as_str().ok_or("extension API returned no token")?;
    let (_, document, _) = crate::workbench_state::connection().await.map_err(|e| e.to_string())?;
    let origin = document
        .strip_suffix("/api/v1/messaging/workbench/documents/session-index")
        .ok_or("unexpected Kode backend address")?;
    Ok(vec![
        ("KODE_EXT_API".into(), format!("{origin}/api/ext/v1")),
        ("KODE_EXT_TOKEN".into(), token.into()),
    ])
}

/// Best effort: a stopped or removed extension keeps no live token.
async fn revoke_grant(id: &str) {
    let Ok((client, document, token)) = crate::workbench_state::connection().await else { return };
    let Some(base) = document.strip_suffix("/workbench/documents/session-index") else { return };
    if let Err(error) = client
        .delete(format!("{base}/extensions/grants/{id}"))
        .bearer_auth(token.trim())
        .send()
        .await
    {
        tracing::debug!(%error, extension = id, "extension grant not revoked");
    }
}

pub fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("KODE_BUNDLED_EXTENSIONS_DIR") {
        return Some(PathBuf::from(dir));
    }
    let dir = app.path().resource_dir().ok()?.join("resources/extensions");
    dir.is_dir().then_some(dir)
}

/// Startup: install bundled extensions off the UI thread.
pub fn seed_bundled_in_background(app: AppHandle) {
    let Some(dir) = bundled_dir(&app) else {
        return;
    };
    std::thread::spawn(move || {
        let Some(host) = app.try_state::<ExtensionHost>() else {
            return;
        };
        if host.seed_bundled(&dir, &app_version(&app)) {
            changed(&app);
        }
    });
}

/// Whether two package directories hold the same files (ignoring `.git`, as
/// `copy_dir` does).
fn same_tree(a: &Path, b: &Path) -> bool {
    fn files(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, PathBuf)>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                files(root, &path, out)?;
            } else {
                let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
                out.push((rel, path));
            }
        }
        Ok(())
    }
    let (mut left, mut right) = (Vec::new(), Vec::new());
    if files(a, a, &mut left).is_err() || files(b, b, &mut right).is_err() {
        return false;
    }
    left.sort();
    right.sort();
    left.len() == right.len()
        && left.iter().zip(&right).all(|((ra, pa), (rb, pb))| {
            ra == rb
                && matches!((std::fs::read(pa), std::fs::read(pb)), (Ok(x), Ok(y)) if x == y)
        })
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        // VCS metadata is never part of a package.
        if name == ".git" {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(&name);
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            let link = std::fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, &target)?;
            #[cfg(not(unix))]
            std::fs::copy(entry.path().parent().unwrap().join(link), &target).map(|_| ())?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

fn host(app: &AppHandle) -> Result<tauri::State<'_, ExtensionHost>, String> {
    app.try_state::<ExtensionHost>()
        .ok_or_else(|| "extension host unavailable".to_string())
}

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&ExtensionHost, &str) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = host(&app)?;
        work(&host, &app_version(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extension_list(app: AppHandle) -> Result<Vec<ExtensionInfo>, String> {
    blocking(app, |host, version| host.list(version).map_err(|e| format!("{e:#}"))).await
}

#[tauri::command]
pub async fn extension_install(
    app: AppHandle,
    path: String,
    link: bool,
) -> Result<ExtensionInfo, String> {
    let notify = app.clone();
    let info = blocking(app, move |host, version| {
        host.install(Path::new(&path), link, version)
            .map_err(|e| format!("{e:#}"))
    })
    .await?;
    changed(&notify);
    Ok(info)
}

#[tauri::command]
pub async fn extension_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let notify = app.clone();
    let views = id.clone();
    blocking(app, move |host, _| host.uninstall(&id).map_err(|e| format!("{e:#}"))).await?;
    revoke_grant(&views).await;
    view::close_extension(&notify, &views);
    changed(&notify);
    Ok(())
}

#[tauri::command]
pub async fn extension_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let notify = app.clone();
    let views = id.clone();
    blocking(app, move |host, _| {
        host.set_enabled(&id, enabled).map_err(|e| format!("{e:#}"))
    })
    .await?;
    if !enabled {
        revoke_grant(&views).await;
        view::close_extension(&notify, &views);
    }
    changed(&notify);
    Ok(())
}

/// Start the backend (if any) and return where it serves.
#[tauri::command]
pub async fn extension_start(app: AppHandle, id: String) -> Result<Running, String> {
    let notify = app.clone();
    let running = blocking(app, move |host, version| host.ensure_backend(&id, version)).await?;
    changed(&notify);
    Ok(running)
}

#[tauri::command]
pub async fn extension_restart(app: AppHandle, id: String) -> Result<Running, String> {
    let notify = app.clone();
    let views = id.clone();
    view::close_extension(&notify, &views);
    let running = blocking(app, move |host, version| {
        host.backends.stop(&id);
        host.ensure_backend(&id, version)
    })
    .await?;
    changed(&notify);
    Ok(running)
}

#[tauri::command]
pub fn extension_logs(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    Ok(host(&app)?.backends.logs(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(dir: &Path, id: &str, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(manifest::FILE_NAME),
            serde_json::json!({
                "schema": manifest::SCHEMA,
                "id": id,
                "name": id,
                "version": version,
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("payload.txt"), version).unwrap();
    }

    #[test]
    fn install_upgrade_disable_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let host = ExtensionHost::at(tmp.path().join("ext"));
        let src = tmp.path().join("src");
        package(&src, "kode.sample", "0.1.0");
        let info = host.install(&src, false, "0.2.2").unwrap();
        assert!(info.enabled && !info.linked && info.error.is_none());

        host.set_enabled("kode.sample", false).unwrap();
        package(&src, "kode.sample", "0.2.0");
        let info = host.install(&src, false, "0.2.2").unwrap();
        // Upgrades keep the user's enabled choice.
        assert!(!info.enabled);
        assert_eq!(info.manifest.unwrap().version, "0.2.0");
        let copied = tmp.path().join("ext/packages/kode.sample/payload.txt");
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "0.2.0");
        assert!(host.active("kode.sample", "0.2.2").is_err());

        host.uninstall("kode.sample").unwrap();
        assert!(!copied.exists());
        assert!(host.list("0.2.2").unwrap().is_empty());
    }

    #[test]
    fn bundled_extensions_install_upgrade_and_stay_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let host = ExtensionHost::at(tmp.path().join("ext"));
        let shipped = tmp.path().join("bundle");
        package(&shipped.join("sample"), "kode.sample", "0.1.0");
        assert!(host.seed_bundled(&shipped, "0.2.2"));
        assert!(!host.seed_bundled(&shipped, "0.2.2"), "same version is not reinstalled");
        std::fs::write(shipped.join("sample/payload.txt"), "rebuilt").unwrap();
        assert!(host.seed_bundled(&shipped, "0.2.2"), "a rebuild under the same version is refreshed");
        let copied = tmp.path().join("ext/packages/kode.sample/payload.txt");
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "rebuilt");
        assert!(!host.seed_bundled(&shipped, "0.2.2"));

        host.set_enabled("kode.sample", false).unwrap();
        package(&shipped.join("sample"), "kode.sample", "0.2.0");
        assert!(host.seed_bundled(&shipped, "0.2.2"));
        let info = &host.list("0.2.2").unwrap()[0];
        assert_eq!(info.manifest.as_ref().unwrap().version, "0.2.0");
        assert!(!info.enabled, "upgrades keep the user's choice");

        host.uninstall("kode.sample").unwrap();
        assert!(!host.seed_bundled(&shipped, "0.2.2"), "removed bundled extensions stay removed");
        assert!(host.list("0.2.2").unwrap().is_empty());

        // Installing it again by hand clears the removal.
        host.install(&shipped.join("sample"), false, "0.2.2").unwrap();
        host.uninstall("kode.sample").unwrap();
        assert!(host.seed_bundled(&shipped, "0.2.2"));
    }

    #[test]
    fn bundled_copy_never_replaces_a_user_install() {
        let tmp = tempfile::tempdir().unwrap();
        let host = ExtensionHost::at(tmp.path().join("ext"));
        let mine = tmp.path().join("mine");
        package(&mine, "kode.sample", "0.1.0");
        host.install(&mine, true, "0.2.2").unwrap();
        let shipped = tmp.path().join("bundle");
        package(&shipped.join("sample"), "kode.sample", "9.0.0");
        assert!(!host.seed_bundled(&shipped, "0.2.2"));
        assert!(host.list("0.2.2").unwrap()[0].linked);
    }

    #[test]
    fn linked_package_stays_in_place_and_reports_broken_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let host = ExtensionHost::at(tmp.path().join("ext"));
        let src = tmp.path().join("dev");
        package(&src, "kode.dev", "0.1.0");
        let info = host.install(&src, true, "0.2.2").unwrap();
        assert!(info.linked);
        std::fs::write(src.join(manifest::FILE_NAME), "{").unwrap();
        let listed = host.list("0.2.2").unwrap();
        assert!(listed[0].error.is_some());
        assert!(host.active("kode.dev", "0.2.2").is_err());
    }
}
