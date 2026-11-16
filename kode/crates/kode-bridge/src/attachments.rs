//! Phone attachments land in `<temp>/kode-attachments/<upload id>/<name>` so a
//! message can reference them by absolute path. Uploads arrive as ordered
//! base64 chunks over the setup channel; the chunk that completes the file
//! returns its path. Folders older than [`RETENTION`] are swept on each new
//! upload, so nothing here needs to outlive a conversation.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use base64::Engine;
use kode_relay_protocol::{MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_CHUNK_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};

const RETENTION: Duration = Duration::from_secs(24 * 3600);
const DIR_NAME: &str = "kode-attachments";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    upload_id: String,
    name: String,
    size: u64,
    offset: u64,
    data: String,
}

pub fn root() -> PathBuf {
    std::env::temp_dir().join(DIR_NAME)
}

pub async fn receive(payload: Value) -> (u16, Value) {
    let root = root();
    tokio::task::spawn_blocking(move || receive_in(&root, payload, SystemTime::now()))
        .await
        .unwrap_or_else(|error| (500, json!({"error":"internal","detail":error.to_string()})))
}

fn bad(detail: impl Into<String>) -> (u16, Value) {
    (400, json!({"error":"bad_request","detail":detail.into()}))
}

fn receive_in(root: &Path, payload: Value, now: SystemTime) -> (u16, Value) {
    let chunk: Chunk = match serde_json::from_value(payload) {
        Ok(chunk) => chunk,
        Err(error) => return bad(error.to_string()),
    };
    if !valid_upload_id(&chunk.upload_id) {
        return bad("invalid upload_id");
    }
    if chunk.size == 0 || chunk.size > MAX_ATTACHMENT_BYTES {
        return bad(format!(
            "attachment must be 1 to {} MB",
            MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    let data = match base64::engine::general_purpose::STANDARD.decode(chunk.data.as_bytes()) {
        Ok(data) => data,
        Err(_) => return bad("data is not base64"),
    };
    if data.is_empty()
        || data.len() > MAX_ATTACHMENT_CHUNK_BYTES
        || chunk.offset + data.len() as u64 > chunk.size
    {
        return bad("chunk does not fit the declared size");
    }
    let dir = root.join(&chunk.upload_id);
    let path = dir.join(file_name(&chunk.name));
    let result = (|| -> std::io::Result<Option<u64>> {
        let mut file = if chunk.offset == 0 {
            sweep(root, now);
            fs::create_dir_all(&dir)?;
            fs::File::create(&path)?
        } else {
            let file = fs::OpenOptions::new().append(true).open(&path)?;
            let len = file.metadata()?.len();
            if len != chunk.offset {
                return Ok(Some(len));
            }
            file
        };
        file.write_all(&data)?;
        Ok(None)
    })();
    match result {
        Ok(Some(received)) => (
            409,
            json!({"error":"offset_mismatch","detail":"upload is out of order; restart it","received":received}),
        ),
        Ok(None) => {
            let received = chunk.offset + data.len() as u64;
            if received < chunk.size {
                return (
                    200,
                    json!({"upload_id":chunk.upload_id,"received":received}),
                );
            }
            (
                200,
                json!({
                    "upload_id": chunk.upload_id,
                    "received": received,
                    "complete": true,
                    "path": path.to_string_lossy(),
                    "name": path.file_name().map(|name| name.to_string_lossy()),
                    "size": received,
                }),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (
            409,
            json!({"error":"offset_mismatch","detail":"upload expired; restart it","received":0}),
        ),
        Err(error) => (500, json!({"error":"internal","detail":error.to_string()})),
    }
}

fn valid_upload_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// A single path component without separators, whitespace or a leading dot.
/// Whitespace is replaced too, so a referenced path stays one token.
fn file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_start_matches('.');
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.chars().count() <= 16 => (stem, ext),
        _ => (clean, ""),
    };
    let stem: String = stem.chars().take(80).collect();
    let stem = if stem.is_empty() {
        "attachment".into()
    } else {
        stem
    };
    if ext.is_empty() {
        stem
    } else {
        format!("{stem}.{ext}")
    }
}

fn sweep(root: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > RETENTION);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, name: &str, size: u64, offset: u64, data: &[u8]) -> Value {
        json!({
            "upload_id": id,
            "name": name,
            "size": size,
            "offset": offset,
            "data": base64::engine::general_purpose::STANDARD.encode(data),
        })
    }

    #[test]
    fn chunks_assemble_into_a_referenced_file() {
        let root = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let (status, body) = receive_in(
            root.path(),
            chunk("upload-0001", "../My Photo.JPG", 6, 0, b"abc"),
            now,
        );
        assert_eq!(status, 200);
        assert_eq!(body["received"], 3);
        assert!(body.get("path").is_none());

        let (status, _) = receive_in(
            root.path(),
            chunk("upload-0001", "../My Photo.JPG", 6, 1, b"x"),
            now,
        );
        assert_eq!(status, 409, "out-of-order chunks are rejected");

        let (status, body) = receive_in(
            root.path(),
            chunk("upload-0001", "../My Photo.JPG", 6, 3, b"def"),
            now,
        );
        assert_eq!(status, 200);
        assert_eq!(body["complete"], true);
        assert_eq!(body["name"], "My_Photo.JPG");
        let path = PathBuf::from(body["path"].as_str().unwrap());
        assert_eq!(path, root.path().join("upload-0001").join("My_Photo.JPG"));
        assert_eq!(fs::read(path).unwrap(), b"abcdef");
    }

    #[test]
    fn rejects_bad_ids_sizes_and_overruns() {
        let root = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        for payload in [
            chunk("../escape", "a.txt", 1, 0, b"a"),
            chunk("upload-0002", "a.txt", MAX_ATTACHMENT_BYTES + 1, 0, b"a"),
            chunk("upload-0002", "a.txt", 2, 0, b"abc"),
        ] {
            assert_eq!(receive_in(root.path(), payload, now).0, 400);
        }
        assert_eq!(fs::read_dir(root.path()).map(|d| d.count()).unwrap_or(0), 0);
    }

    #[test]
    fn new_uploads_sweep_expired_folders() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("old-upload")).unwrap();
        let later = SystemTime::now() + RETENTION + Duration::from_secs(60);
        let (status, _) = receive_in(
            root.path(),
            chunk("upload-0003", "note.txt", 1, 0, b"a"),
            later,
        );
        assert_eq!(status, 200);
        assert!(!root.path().join("old-upload").exists());
        assert!(root.path().join("upload-0003").exists());
    }

    #[test]
    fn file_names_stay_single_safe_components() {
        assert_eq!(file_name("..\\..\\x.zip"), "x.zip");
        assert_eq!(file_name(".env"), "env");
        assert_eq!(file_name(""), "attachment");
        assert_eq!(file_name("照片 1.heic"), "照片_1.heic");
    }
}
