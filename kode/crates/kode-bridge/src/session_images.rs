//! Transcript images for phones. Backends keep pasted screenshots and image
//! tool results inline (base64 / data URL) or as local blob files; events must
//! not carry those bytes, so the semantic tail stores each image once under a
//! content id in `<cache>/kode/session-images/<id>.<ext>` and the event only
//! names `{ id, mime, size }`. Phones read the file back in chunks through the
//! `image` setup request and keep their own copy.
//!
//! Files older than [`RETENTION`] are swept at most hourly when a new image is
//! stored. A semantic tail replays its transcript from the start, so images of
//! a live session come back after a sweep or a cache wipe.
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use kode_relay_protocol::{IMAGE_CHUNK_BYTES, MAX_ATTACHMENT_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);
const SWEEP_INTERVAL_SECS: u64 = 3600;
const ID_LEN: usize = 32;

static LAST_SWEEP: AtomicU64 = AtomicU64::new(0);

pub fn root() -> PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join("kode-session-images-test");
    }
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("kode")
        .join("session-images")
}

fn extension(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn content_id(seed: &[u8]) -> String {
    let digest = Sha256::digest(seed);
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..ID_LEN]
        .to_string()
}

fn image_ref(id: &str, mime: &str, size: u64) -> Value {
    json!({ "id": id, "mime": mime, "size": size })
}

/// `{ id, mime, size }` for a base64 image, storing it on first sight.
pub fn from_base64(mime: &str, data: &str) -> Option<Value> {
    store_base64(&root(), mime, data, SystemTime::now())
}

/// Same as [`from_base64`] for a `data:image/...;base64,...` URL.
pub fn from_data_url(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (mime, data) = rest.split_once(";base64,")?;
    from_base64(mime, data)
}

/// Copies a local image file (e.g. a CodeBuddy blob) into the cache.
pub fn from_file(path: &str, mime: Option<&str>) -> Option<Value> {
    store_file(&root(), Path::new(path), mime, SystemTime::now())
}

/// Images inside a transcript content array (Claude `image`, Codex and
/// CodeBuddy `input_image`), stored and returned as refs.
pub fn from_content(content: &Value) -> Vec<Value> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(from_item)
        .collect()
}

/// One content item, if it is an image.
pub fn from_item(item: &Value) -> Option<Value> {
    match item.get("type")?.as_str()? {
        "image" => {
            let source = item.get("source")?;
            if source.get("type")?.as_str()? != "base64" {
                return None;
            }
            from_base64(
                source.get("media_type")?.as_str()?,
                source.get("data")?.as_str()?,
            )
        }
        "input_image" => {
            if let Some(url) = item.get("image_url").and_then(Value::as_str) {
                return from_data_url(url);
            }
            let image = item.get("image")?;
            from_file(
                image.get("blob_path")?.as_str()?,
                image.get("mime").and_then(Value::as_str),
            )
        }
        _ => None,
    }
}

fn store_base64(root: &Path, mime: &str, data: &str, now: SystemTime) -> Option<Value> {
    let ext = extension(mime)?;
    let data = data.trim();
    if data.is_empty() || data.len() as u64 > MAX_ATTACHMENT_BYTES / 3 * 4 + 4 {
        return None;
    }
    let id = content_id(data.as_bytes());
    let path = root.join(format!("{id}.{ext}"));
    let size = match fs::metadata(&path) {
        Ok(meta) => meta.len(),
        Err(_) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .ok()?;
            write(root, &path, &bytes, now)?;
            bytes.len() as u64
        }
    };
    Some(image_ref(&id, mime_of(ext), size))
}

fn store_file(root: &Path, source: &Path, mime: Option<&str>, now: SystemTime) -> Option<Value> {
    let ext = match mime {
        Some(mime) => extension(mime)?,
        None => {
            let ext = source.extension()?.to_str()?.to_ascii_lowercase();
            extension(&format!("image/{ext}"))?
        }
    };
    let meta = fs::metadata(source).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_ATTACHMENT_BYTES {
        return None;
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let seed = format!("file:{}:{}:{modified}", source.display(), meta.len());
    let id = content_id(seed.as_bytes());
    let path = root.join(format!("{id}.{ext}"));
    if !path.exists() {
        let bytes = fs::read(source).ok()?;
        write(root, &path, &bytes, now)?;
    }
    Some(image_ref(&id, mime_of(ext), meta.len()))
}

/// Writes through a temp name so a concurrent reader never sees half a file.
fn write(root: &Path, path: &Path, bytes: &[u8], now: SystemTime) -> Option<()> {
    sweep(root, now);
    fs::create_dir_all(root).ok()?;
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    if fs::write(&tmp, bytes)
        .and_then(|_| fs::rename(&tmp, path))
        .is_err()
    {
        let _ = fs::remove_file(&tmp);
        return None;
    }
    Some(())
}

fn sweep(root: &Path, now: SystemTime) {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let last = LAST_SWEEP.load(Ordering::Relaxed);
    if secs.saturating_sub(last) < SWEEP_INTERVAL_SECS
        || LAST_SWEEP
            .compare_exchange(last, secs, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
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
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    id: String,
    #[serde(default)]
    offset: u64,
}

/// One chunk of a cached image: `{ id, mime, size, offset, data, complete }`.
pub async fn read(payload: Value) -> (u16, Value) {
    let root = root();
    tokio::task::spawn_blocking(move || read_in(&root, payload))
        .await
        .unwrap_or_else(|error| (500, json!({"error":"internal","detail":error.to_string()})))
}

fn read_in(root: &Path, payload: Value) -> (u16, Value) {
    let request: ReadRequest = match serde_json::from_value(payload) {
        Ok(request) => request,
        Err(error) => {
            return (
                400,
                json!({"error":"bad_request","detail":error.to_string()}),
            )
        }
    };
    let valid = request.id.len() == ID_LEN
        && request
            .id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return (
            400,
            json!({"error":"bad_request","detail":"invalid image id"}),
        );
    }
    let found = ["png", "jpg", "gif", "webp"].into_iter().find_map(|ext| {
        let path = root.join(format!("{}.{ext}", request.id));
        fs::File::open(&path).ok().map(|file| (file, ext))
    });
    let Some((mut file, ext)) = found else {
        return (
            404,
            json!({"error":"not_found","detail":"This image is no longer cached on the desktop"}),
        );
    };
    let result = (|| -> std::io::Result<(u64, Vec<u8>)> {
        let size = file.metadata()?.len();
        let mut data = Vec::new();
        if request.offset < size {
            file.seek(SeekFrom::Start(request.offset))?;
            file.take(IMAGE_CHUNK_BYTES as u64).read_to_end(&mut data)?;
        }
        Ok((size, data))
    })();
    match result {
        Ok((size, data)) if request.offset < size => {
            let end = request.offset + data.len() as u64;
            (
                200,
                json!({
                    "id": request.id,
                    "mime": mime_of(ext),
                    "size": size,
                    "offset": request.offset,
                    "data": base64::engine::general_purpose::STANDARD.encode(&data),
                    "complete": end >= size,
                }),
            )
        }
        Ok(_) => (
            400,
            json!({"error":"bad_request","detail":"offset is past the end"}),
        ),
        Err(error) => (500, json!({"error":"internal","detail":error.to_string()})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn base64_images_are_stored_once_and_read_in_chunks() {
        let root = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..IMAGE_CHUNK_BYTES + 10).map(|i| i as u8).collect();
        let data = b64(&bytes);
        let now = SystemTime::now();
        let first = store_base64(root.path(), "image/png", &data, now).unwrap();
        let again = store_base64(root.path(), "image/png", &data, now).unwrap();
        assert_eq!(first, again);
        assert_eq!(first["mime"], "image/png");
        assert_eq!(first["size"], bytes.len() as u64);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);

        let id = first["id"].as_str().unwrap();
        let (status, head) = read_in(root.path(), json!({"id": id}));
        assert_eq!(status, 200);
        assert_eq!(head["complete"], false);
        let (status, tail) = read_in(root.path(), json!({"id": id, "offset": IMAGE_CHUNK_BYTES}));
        assert_eq!(status, 200);
        assert_eq!(tail["complete"], true);
        let mut joined = base64::engine::general_purpose::STANDARD
            .decode(head["data"].as_str().unwrap())
            .unwrap();
        joined.extend(
            base64::engine::general_purpose::STANDARD
                .decode(tail["data"].as_str().unwrap())
                .unwrap(),
        );
        assert_eq!(joined, bytes);
    }

    #[test]
    fn rejects_unknown_types_bad_ids_and_missing_images() {
        let root = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        assert!(store_base64(root.path(), "image/svg+xml", &b64(b"<svg/>"), now).is_none());
        assert!(store_base64(root.path(), "image/png", "not base64!", now).is_none());
        assert_eq!(read_in(root.path(), json!({"id": "../etc/passwd"})).0, 400);
        assert_eq!(
            read_in(root.path(), json!({"id": "a".repeat(ID_LEN)})).0,
            404
        );
        assert_eq!(
            read_in(root.path(), json!({"id": "a", "path": "/x"})).0,
            400
        );
    }

    #[test]
    fn local_files_are_copied_under_a_stable_id() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let blob = source.path().join("blob.PNG");
        fs::write(&blob, b"png bytes").unwrap();
        let now = SystemTime::now();
        let first = store_file(root.path(), &blob, None, now).unwrap();
        fs::remove_file(&blob).unwrap();
        assert!(store_file(root.path(), &blob, None, now).is_none());
        let (status, body) = read_in(root.path(), json!({"id": first["id"]}));
        assert_eq!(status, 200);
        assert_eq!(body["data"], b64(b"png bytes"));
        assert_eq!(body["mime"], "image/png");
    }

    fn png() -> String {
        b64(b"\x89PNG fake image")
    }

    #[test]
    fn claude_pasted_and_tool_result_images_become_refs() {
        use kode_core::session::jsonl_tail::Backend;
        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{}"}}}}]}}}}"#,
            png()
        );
        let evs = crate::semantic::parse_line(3, Backend::Claude, &line);
        assert_eq!(evs.len(), 1, "image-only prompt still yields a message");
        let message = &evs[0].payload;
        assert_eq!(message["text"], "");
        assert_eq!(message["images"][0]["mime"], "image/png");

        let line = format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"tu_1","content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{}"}}}}]}}]}}}}"#,
            png()
        );
        let evs = crate::semantic::parse_line(3, Backend::Claude, &line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].r#type, "tool_use");
        assert_eq!(evs[0].payload["id"], "tu_1");
        assert_eq!(
            evs[0].payload["images"][0]["id"],
            message["images"][0]["id"]
        );
    }

    #[test]
    fn codex_image_wrappers_are_dropped_and_the_prompt_kept() {
        use kode_core::session::jsonl_tail::Backend;
        let line = format!(
            r#"{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"<image name=[Image #1] path=\"/tmp/a.png\">"}},{{"type":"input_image","image_url":"data:image/png;base64,{}"}},{{"type":"input_text","text":"</image>"}},{{"type":"input_text","text":"[Image #1] why"}}]}}}}"#,
            png()
        );
        let evs = crate::semantic::parse_line(4, Backend::Codex, &line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].payload["text"], "[Image #1] why");
        assert_eq!(evs[0].payload["images"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn codebuddy_blob_images_are_copied() {
        use kode_core::session::jsonl_tail::Backend;
        let dir = tempfile::tempdir().unwrap();
        let blob = dir.path().join("blob.png");
        fs::write(&blob, b"blob").unwrap();
        let line = json!({
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "look"},
                {"type": "input_image", "image": {"type": "image_blob_ref", "mime": "image/png", "blob_path": blob}},
            ],
        })
        .to_string();
        let evs = crate::semantic::parse_line(5, Backend::Codebuddy, &line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].payload["images"][0]["size"], 4);
    }

    #[test]
    fn data_urls_need_a_base64_image() {
        assert!(from_data_url("https://example.com/a.png").is_none());
        assert!(from_data_url("data:text/plain;base64,aGk=").is_none());
    }
}
