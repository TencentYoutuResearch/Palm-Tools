//! Single backend owner of plugin configuration, synchronization and idle inhibition.
use super::{extension_files as files, extension_targets, Hub};
use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
};
pub struct Extensions {
    pub root: PathBuf,
    pub home: PathBuf,
    pub gate: Mutex<()>,
    power: Mutex<Power>,
}
#[derive(Default)]
struct Power {
    enabled: bool,
    child: Option<Child>,
    error: String,
}
impl Power {
    fn close(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    fn status(&mut self) -> Value {
        if let Some(child) = self.child.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                self.error = format!("保持唤醒进程已退出：{status}");
                self.child = None;
            }
        }
        json!({"enabled":self.enabled,"active":self.child.is_some(),"supported":cfg!(any(target_os="macos",target_os="linux")),"error":self.error})
    }
    fn set(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.close();
            self.error.clear();
            return;
        }
        if self.child.is_some() {
            return;
        }
        let mut command = if cfg!(target_os = "macos") {
            let mut c = Command::new("/usr/bin/caffeinate");
            c.args(["-i", "-w", &std::process::id().to_string()]);
            c
        } else if cfg!(target_os = "linux") {
            let mut c = Command::new("systemd-inhibit");
            c.args([
                "--what=idle:sleep",
                "--mode=block",
                "--why=Kode Agent tasks",
                "--who=Kode",
                "tail",
                &format!("--pid={}", std::process::id()),
                "-f",
                "/dev/null",
            ]);
            c
        } else {
            self.error = "此主机暂不支持保持唤醒".into();
            return;
        };
        match command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                self.child = Some(child);
                self.error.clear();
            }
            Err(error) => self.error = error.to_string(),
        }
    }
}
impl Drop for Power {
    fn drop(&mut self) {
        self.close()
    }
}
impl Extensions {
    pub fn new(root: PathBuf, home: PathBuf) -> Self {
        Self {
            root,
            home,
            gate: Mutex::new(()),
            power: Mutex::new(Power::default()),
        }
    }
    pub fn restore(&self, hub: &Hub) -> Result<()> {
        std::fs::create_dir_all(&self.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))?;
        }
        let state = state(hub)?;
        self.power
            .lock()
            .set(state["keepAwake"].as_bool().unwrap_or(false));
        Ok(())
    }
    pub fn close(&self) {
        self.power.lock().close()
    }
    pub fn view(&self, hub: &Hub) -> Result<Value> {
        let mut value = state(hub)?;
        value.as_object_mut().unwrap().remove("handoffs");
        value["revision"] = hub.store.document("agent-hub")?["revision"].clone();
        let catalog = extension_targets::catalog(hub)?;
        value["targets"] = json!(catalog.paths);
        value["profileTargets"] = json!(catalog.profiles);
        value["capabilities"] = json!({"packageToggle": true});
        // Releases synced by older services already recorded the relative package path.
        // Expose that durable identity immediately, without re-cloning or reinstalling.
        for source in value["sources"].as_array_mut().into_iter().flatten() {
            let disabled = source["disabledPackages"].as_array().cloned().unwrap_or_default();
            for package in source["packages"].as_array_mut().into_iter().flatten() {
                if package["path"].is_string() {
                    package["key"] = package["path"].clone();
                    package["enabled"] = json!(!disabled.contains(&package["path"]));
                }
            }
        }
        value["power"] = self.power.lock().status();
        Ok(value)
    }
    pub fn change(&self, hub: &Hub, input: Value) -> Result<Value> {
        let _guard = self.gate.lock();
        let mut value = state(hub)?;
        match input["action"].as_str().context("action required")? {
            "power" => {
                let enabled = input["enabled"]
                    .as_bool()
                    .context("enabled must be boolean")?;
                value["keepAwake"] = json!(enabled);
                save(hub, &value)?;
                self.power.lock().set(enabled);
            }
            "save-source" => {
                let catalog = extension_targets::catalog(hub)?;
                let sources = value["sources"].as_array_mut().unwrap();
                let intent = input["intent"].as_str();
                let prior = sources
                    .iter_mut()
                    .find(|row| row["id"] == input["source"]["id"]);
                let prior_targets = prior
                    .as_deref()
                    .map(|row| &row["targets"])
                    .unwrap_or(&Value::Null);
                let source = files::validate(&input["source"], &catalog.paths, prior_targets)?;
                if let Some(prior) = prior {
                    if intent == Some("create") {
                        bail!("此来源标识已在使用，请更换标识。");
                    }
                    // Older editors send the unchanged target list as their revision check.
                    let expected = input.get("expectedTargets").unwrap_or(&source["targets"]);
                    if intent == Some("edit") && &prior["targets"] != expected {
                        bail!("来源已变更，请刷新后重试。");
                    }
                    if prior["targets"] != source["targets"] && !prior["syncedTargets"].is_array() {
                        prior["syncedTargets"] = prior["targets"].clone();
                    }
                    for (key, val) in source.as_object().unwrap() {
                        prior[key] = val.clone();
                    }
                } else {
                    if intent == Some("edit") {
                        bail!("来源已被移除，请刷新后重试。");
                    }
                    sources.push(source);
                }
                save(hub, &value)?;
            }
            action @ ("sync-source" | "set-package-enabled") => {
                let id = input["id"].as_str().context("source identity required")?;
                let index = value["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|row| row["id"].as_str() == Some(id))
                    .context("source not found")?;
                let before = value["sources"][index].clone();
                let operation = (|| -> Result<()> {
                    let catalog = extension_targets::catalog(hub)?;
                    let mut config = before.clone();
                    let (skills, plugins, revision, release, packages) = if action == "set-package-enabled" {
                        let release = before["release"].as_str().context("sync this source first")?;
                        if input["release"].as_str() != Some(release) { bail!("来源已更新，请刷新后重试。"); }
                        let key = input["packageKey"].as_str().context("package key required")?;
                        let enabled = input["enabled"].as_bool().context("enabled must be boolean")?;
                        if !before["packages"].as_array().is_some_and(|rows| rows.iter().any(|p| p["path"].as_str() == Some(key))) {
                            bail!("unknown package");
                        }
                        let mut disabled = before["disabledPackages"].as_array().cloned().unwrap_or_default();
                        disabled.retain(|v| v.as_str() != Some(key));
                        if !enabled { disabled.push(json!(key)); }
                        config["disabledPackages"] = json!(disabled);
                        files::inspect_release(&self.root, &config, release, before["revision"].as_str().map(str::to_owned))?
                    } else {
                        files::snapshot(&self.root, &config)?
                    };
                    let (previous, next) =
                        files::plan_links(&self.root, &self.home, &before, &skills, &catalog.paths)?;
                    value["sources"][index]["disabledPackages"] = config["disabledPackages"].clone();
                    value["sources"][index]["syncedTargets"] = before["targets"].clone();
                    value["sources"][index]["links"] = json!(next);
                    value["sources"][index]["skills"] =
                        json!(skills.iter().map(|s| &s["name"]).collect::<Vec<_>>());
                    value["sources"][index]["plugins"] = plugins;
                    value["sources"][index]["release"] = json!(release);
                    value["sources"][index]["packages"] = json!(packages);
                    value["sources"][index]["revision"] = json!(revision);
                    value["sources"][index]["updatedAt"] = json!(crate::now_ms());
                    value["sources"][index]
                        .as_object_mut()
                        .unwrap()
                        .remove("error");
                    if let Err(error) = files::replace(&previous, &next, || save(hub, &value)) {
                        value["sources"][index] = before.clone();
                        return Err(error);
                    }
                    files::native_sync(
                        &self.root,
                        &mut value["sources"][index],
                        &catalog.native_launch,
                    )?;
                    save(hub, &value)?;
                    Ok(())
                })();
                if let Err(error) = operation {
                    value["sources"][index]["error"] = json!(error.to_string());
                    save(hub, &value)?;
                    return Err(error);
                }
            }
            "remove-source" => {
                let id = input["id"].as_str().context("source identity required")?;
                let index = value["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|row| row["id"].as_str() == Some(id))
                    .context("source not found")?;
                if let Err(error) = files::native_remove(&self.root, &mut value["sources"][index]) {
                    save(hub, &value)?;
                    return Err(error);
                }
                let links = value["sources"][index]["links"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let mut removed = value.clone();
                removed["sources"].as_array_mut().unwrap().remove(index);
                files::replace(&links, &[], || save(hub, &removed))?;
            }
            _ => bail!("unknown extension operation"),
        }
        super::agents::refresh_launch_catalog(hub)?;
        self.view(hub)
    }
}
pub fn state(hub: &Hub) -> Result<Value> {
    let value = hub.store.document("agent-hub")?["value"].clone();
    if value.is_null() {
        return Ok(json!({"version":1,"keepAwake":false,"sources":[]}));
    }
    if value["version"] != 1 || !value["sources"].is_array() {
        bail!("invalid backend Agent hub state")
    }
    Ok(value)
}
pub fn save(hub: &Hub, value: &Value) -> Result<()> {
    let stored = hub.store.document("agent-hub")?;
    hub.store.save_document(
        "agent-hub",
        stored["revision"].as_u64().unwrap(),
        value.clone(),
    )?;
    Ok(())
}
pub fn launch_args(hub: &Hub, profile: &Value) -> Result<Vec<String>> {
    let Some(kind) = extension_targets::launch_kind_for_profile(profile) else {
        return Ok(vec![]);
    };
    let Some((target, _)) = extension_targets::for_profile(profile) else {
        return Ok(vec![]);
    };
    let value = state(hub)?;
    let mut paths = std::collections::HashSet::new();
    let mut args = vec![];
    for source in value["sources"].as_array().unwrap() {
        if !source["syncedTargets"]
            .as_array()
            .or_else(|| source["targets"].as_array())
            .is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some(&target)))
        {
            continue;
        }
        for plugin in source["plugins"][kind].as_array().into_iter().flatten() {
            if let Some(path) = plugin["path"].as_str() {
                if paths.insert(path.to_string()) {
                    args.push("--plugin-dir".into());
                    args.push(path.into());
                }
            }
        }
    }
    Ok(args)
}
