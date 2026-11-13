use serde_json::json;
use std::io::Write;

const AUDIT_ENV: &str = "KODE_TCODEX_INPUT_AUDIT";
const MAX_AUDIT_BYTES: u64 = 8 * 1024 * 1024;

fn is_tcodex(backend_key: &str, backend_protocol: &str) -> bool {
    [backend_key, backend_protocol].iter().any(|key| {
        let key = key.trim().to_ascii_lowercase();
        key == "tcodex" || key.ends_with(":tcodex")
    })
}

fn append(entry: serde_json::Value) {
    let Some(root) = dirs::data_local_dir().or_else(|| Some(std::env::temp_dir())) else {
        return;
    };
    let path = root.join("kode").join("tcodex-input-audit.jsonl");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() >= MAX_AUDIT_BYTES) {
        let _ = std::fs::rename(&path, path.with_extension("jsonl.1"));
    }
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{entry}");
}

pub fn record_input(
    id: u64,
    backend_key: &str,
    backend_protocol: &str,
    bytes: &[u8],
) {
    if !cfg!(windows)
        || std::env::var(AUDIT_ENV).as_deref() != Ok("1")
        || !is_tcodex(backend_key, backend_protocol)
    {
        return;
    }
    let hex = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    append(json!({
        "kind": "input",
        "at_ms": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default(),
        "session_id": id,
        "backend_key": backend_key,
        "backend_protocol": backend_protocol,
        "len": bytes.len(),
        "hex": hex,
    }));
}

pub fn record_exit(id: u64, code: Option<i32>, backend_key: Option<&str>) {
    if !cfg!(windows) || std::env::var(AUDIT_ENV).as_deref() != Ok("1") {
        return;
    }
    append(json!({
        "kind": "exit",
        "at_ms": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default(),
        "session_id": id,
        "code": code,
        "backend_key": backend_key,
    }));
}
