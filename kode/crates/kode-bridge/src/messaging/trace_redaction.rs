//! Audit exports never include credential fields or command environments/arguments.
use serde_json::{json, Value};
pub(super) fn redact(value: &mut Value, path: &str, removed: &mut Vec<String>, depth: usize) {
    if depth > 24 {
        *value = json!({"redacted":true});
        removed.push(path.into());
        return;
    }
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                let normalized = key.to_ascii_lowercase().replace('-', "_");
                let next = format!("{path}.{key}");
                if matches!(
                    normalized.as_str(),
                    "token"
                        | "owner_token"
                        | "admin_token"
                        | "access_token"
                        | "refresh_token"
                        | "api_key"
                        | "secret"
                        | "secret_key"
                        | "password"
                        | "private_key"
                        | "authorization"
                        | "cookie"
                        | "headers"
                        | "env"
                        | "args"
                        | "argv"
                ) || normalized.ends_with("_token")
                {
                    *child = json!({"redacted":true});
                    removed.push(next);
                } else {
                    redact(child, &next, removed, depth + 1)
                }
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                redact(item, &format!("{path}[{index}]"), removed, depth + 1)
            }
        }
        Value::String(text) => {
            let lower = text.to_ascii_lowercase();
            if lower.contains("authorization:")
                || lower.contains("bearer ")
                || lower.contains("-----begin private key")
                || lower.contains("access_token=")
                || lower.contains("api_key=")
            {
                *value = json!({"redacted":true});
                removed.push(path.into());
                return;
            }
            let trimmed = text.trim_start();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                if let Ok(mut nested) = serde_json::from_str::<Value>(text) {
                    let before = removed.len();
                    redact(&mut nested, path, removed, depth + 1);
                    if removed.len() != before {
                        *text = nested.to_string()
                    }
                }
            }
        }
        _ => {}
    }
}
