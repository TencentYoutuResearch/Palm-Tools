//! Single backend owner of plugin configuration, synchronization and idle inhibition.
use super::{extension_files as files, Hub};
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
        value["targets"] = files::targets();
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
                let source = files::validate(&input["source"])?;
                let sources = value["sources"].as_array_mut().unwrap();
                if let Some(prior) = sources.iter_mut().find(|row| row["id"] == source["id"]) {
                    for (key, val) in source.as_object().unwrap() {
                        prior[key] = val.clone();
                    }
                } else {
                    sources.push(source)
                }
                save(hub, &value)?;
            }
            "sync-source" => {
                let id = input["id"].as_str().context("source identity required")?;
                let index = value["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|row| row["id"].as_str() == Some(id))
                    .context("source not found")?;
                let before = value["sources"][index].clone();
                let operation = (|| -> Result<()> {
                    let (skills, plugins, revision) = files::snapshot(&self.root, &before)?;
                    let next = files::desired(&self.home, &before, &skills)?;
                    let previous = before["links"].as_array().cloned().unwrap_or_default();
                    value["sources"][index]["links"] = json!(next);
                    value["sources"][index]["skills"] =
                        json!(skills.iter().map(|s| &s["name"]).collect::<Vec<_>>());
                    value["sources"][index]["plugins"] = plugins;
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
                    if let Err(error) = files::native_sync(&self.root, &mut value["sources"][index])
                    {
                        value["sources"][index]["nativeStatus"]["codex"] =
                            json!(format!("failed: {error}"));
                    }
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
pub fn launch_args(hub: &Hub, kind: &str) -> Result<Vec<String>> {
    if !matches!(kind, "claude" | "codebuddy" | "cursor") {
        return Ok(vec![]);
    }
    let value = state(hub)?;
    let mut paths = std::collections::HashSet::new();
    let mut args = vec![];
    for source in value["sources"].as_array().unwrap() {
        if !source["targets"]
            .as_array()
            .is_some_and(|rows| rows.contains(&json!(kind)))
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
