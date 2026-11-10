//! Read-only Worker inventory used by the centralized Worker directory.
//!
//! Only fixed probe commands are exposed here. No caller-supplied command or
//! argument is accepted, and raw environment variables are never returned.

use crate::{backend_probe, Ctx};
use futures_util::future::join_all;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::Duration,
};
use sysinfo::{Disks, System};
use tokio::process::Command;

const AGENT_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const ADB_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

pub async fn collect(ctx: Arc<Ctx>) -> Value {
    let backends = ctx.backends();
    let system = tokio::task::spawn_blocking(system_inventory)
        .await
        .unwrap_or_else(|error| json!({"error": error.to_string()}));
    let (agents, adb) = tokio::join!(agent_inventory(backends), adb_inventory());
    let capabilities = capabilities(&adb);
    json!({
        "observed_at": crate::now_ms(),
        "worker": {
            "kode_version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "hostname": System::host_name(),
            "uptime_seconds": System::uptime(),
            "details": system,
        },
        "resources": system_resources(),
        "agents": agents,
        "adb": adb,
        "capabilities": capabilities,
    })
}

fn system_inventory() -> Value {
    json!({
        "name": System::name(),
        "os_version": System::os_version(),
        "kernel_version": System::kernel_version(),
        "host_name": System::host_name(),
    })
}

fn system_resources() -> Value {
    let mut system = System::new_all();
    system.refresh_all();
    let load = System::load_average();
    let disks = Disks::new_with_refreshed_list()
        .iter()
        .map(|disk| {
            json!({
                "name": disk.name().to_string_lossy(),
                "mount": disk.mount_point().to_string_lossy(),
                "filesystem": disk.file_system().to_string_lossy(),
                "total": disk.total_space(),
                "available": disk.available_space(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "cpu_count": system.cpus().len(),
        "cpu_brand": system.cpus().first().map(|cpu| cpu.brand().trim()),
        "load_1m": load.one,
        "load_5m": load.five,
        "load_15m": load.fifteen,
        "memory_total": system.total_memory(),
        "memory_available": system.available_memory(),
        "disks": disks,
    })
}

async fn agent_inventory(backends: HashMap<String, kode_core::config::BackendConfig>) -> Vec<Value> {
    let mut rows = backends.into_iter().collect::<Vec<_>>();
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    let inventory = join_all(rows.into_iter().map(|(key, config)| async move {
        let executable = backend_probe::which(&config.command);
        let version = match executable.as_deref() {
            Some(path) => probe_version(path).await,
            None => None,
        };
        let available = executable.is_some();
        json!({
            "key": key,
            "name": config.protocol_key(&key),
            "command": config.command,
            "command_path": executable.map(|path| path.to_string_lossy().into_owned()),
            "version": version,
            "enabled": config.is_enabled(),
            "available": available,
        })
    }))
    .await;
    inventory
        .into_iter()
        .filter(|row| row["available"] == true)
        .collect()
}

async fn probe_version(command: &Path) -> Option<String> {
    let output = run_probe(command, &["--version"], AGENT_PROBE_TIMEOUT).await?;
    normalize_version(&output)
}

async fn adb_inventory() -> Value {
    let Some(adb) = backend_probe::which("adb") else {
        return json!({
            "available": false,
            "version": null,
            "devices": [],
            "error": "adb was not found on PATH",
        });
    };
    let version = run_probe(&adb, &["version"], ADB_PROBE_TIMEOUT)
        .await
        .and_then(|text| normalize_version(&text));
    let devices_output = run_probe(&adb, &["devices", "-l"], ADB_PROBE_TIMEOUT).await;
    match devices_output {
        Some(output) => json!({
            "available": true,
            "command_path": adb.to_string_lossy(),
            "version": version,
            "devices": parse_adb_devices(&output),
            "error": Value::Null,
        }),
        None => json!({
            "available": true,
            "command_path": adb.to_string_lossy(),
            "version": version,
            "devices": [],
            "error": "adb devices timed out or failed",
        }),
    }
}

async fn run_probe(command: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut process = Command::new(command);
    process.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, process.output())
        .await
        .ok()?
        .ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    }
    (!text.is_empty()).then_some(text)
}

fn normalize_version(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect())
}

fn parse_adb_devices(output: &str) -> Vec<Value> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.eq_ignore_ascii_case("List of devices attached")
                && !line.starts_with('*')
        })
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            let state = fields.next()?;
            let mut row = serde_json::Map::new();
            row.insert("serial".into(), json!(serial));
            row.insert("state".into(), json!(state));
            for field in fields {
                if let Some((key, value)) = field.split_once(':') {
                    row.insert(key.into(), json!(value));
                }
            }
            row.entry("connection").or_insert_with(|| {
                json!(if serial.contains(':') { "network" } else { "usb" })
            });
            Some(Value::Object(row))
        })
        .collect()
}

fn capabilities(adb: &Value) -> Vec<String> {
    let mut values = vec!["inventory.v1".to_string()];
    if adb["available"] == true {
        values.push("adb".into());
    }
    if backend_probe::which("fastboot").is_some() {
        values.push("fastboot".into());
    }
    values
}

pub fn worker_capabilities() -> Vec<String> {
    vec!["inventory.v1".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_adb_devices_with_network_and_usb_identities() {
        let rows = parse_adb_devices(
            "List of devices attached\n\
             CK0A3KP02514000090 device product:dev model:M4 transport_id:3\n\
             10.0.0.2:5555 unauthorized product:dev model:M3 transport_id:4\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["serial"], "CK0A3KP02514000090");
        assert_eq!(rows[0]["connection"], "usb");
        assert_eq!(rows[1]["connection"], "network");
        assert_eq!(rows[1]["state"], "unauthorized");
    }

    #[test]
    fn normalizes_first_non_empty_version_line() {
        assert_eq!(
            normalize_version("\nAndroid Debug Bridge version 1.0.41\nVersion 35.0.2\n"),
            Some("Android Debug Bridge version 1.0.41".into())
        );
        assert_eq!(normalize_version(" \n"), None);
    }
}
