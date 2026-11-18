//! Claude-compatible title metadata stays beside the original native transcript.
use anyhow::Context;
use serde_json::json;
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

pub(super) fn write_claude_title(path: &Path, session_id: &str, title: &str) -> anyhow::Result<()> {
    // Open the existing history only. Renaming never creates an empty transcript.
    let mut transcript = OpenOptions::new().read(true).append(true).open(path)?;
    let size = transcript.metadata()?.len();
    transcript.seek(SeekFrom::Start(size.saturating_sub(64 * 1024)))?;
    // A bounded tail may begin inside a UTF-8 character.
    let mut bytes = Vec::new();
    transcript.read_to_end(&mut bytes)?;
    let tail = String::from_utf8_lossy(&bytes);
    let records = format!(
        "{}\n{}\n",
        json!({"type":"custom-title","customTitle":title,"sessionId":session_id}),
        json!({"type":"agent-name","agentName":title,"sessionId":session_id})
    );
    if !tail.ends_with(&records) {
        let separator = if size > 0 && !tail.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        transcript.write_all(format!("{separator}{records}").as_bytes())?;
        transcript.sync_data()?;
    }
    let directory = path.with_extension("");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory)?;
    let mut sidecar = tempfile::NamedTempFile::new_in(&directory)?;
    serde_json::to_writer(&mut sidecar, &json!({"customTitle":title}))?;
    sidecar.as_file().sync_all()?;
    sidecar
        .persist(directory.join("custom-title.json"))
        .map_err(|error| error.error)
        .context("persist native session title")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rename_preserves_history_and_updates_native_title_idempotently() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("thread.jsonl");
        let original = "{\"type\":\"user\",\"message\":{\"content\":\"Original request\"}}";
        std::fs::write(&path, original).unwrap();
        write_claude_title(&path, "thread", "网关迁移").unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.starts_with(original));
        let rows: Vec<serde_json::Value> = first
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(rows[1]["customTitle"], "网关迁移");
        assert_eq!(rows[2]["agentName"], "网关迁移");
        write_claude_title(&path, "thread", "网关迁移").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        write_claude_title(&path, "thread", "Updated title").unwrap();
        let sidecar: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.path().join("thread/custom-title.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(sidecar["customTitle"], "Updated title");
        assert!(
            write_claude_title(&root.path().join("missing.jsonl"), "missing", "title").is_err()
        );
        assert!(!root.path().join("missing.jsonl").exists());
    }
}
