//! Validate archived raw workspace content against the already recorded snapshot.
use super::artifact_evidence::Snapshot;
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
pub(super) fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    version: u32,
    snapshot: Snapshot,
    base_tree: String,
    manifest: Vec<Vec<String>>,
    contents: BTreeMap<String, String>,
}
pub(super) fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn validate(data: &[u8], snapshot: &Snapshot) -> Result<()> {
    let b: Bundle = serde_json::from_slice(data)?;
    if b.version != 1
        || b.snapshot != *snapshot
        || !b.snapshot.artifact_hashes.is_empty()
        || b.manifest.len() > 10000
        || !matches!(b.base_tree.len(), 40 | 64)
        || !b
            .base_tree
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        bail!("archive snapshot mismatch")
    }
    let mut previous: Option<&str> = None;
    let mut used = BTreeSet::new();
    let mut total = 0usize;
    for row in &b.manifest {
        if row.len() < 2 {
            bail!("invalid archive manifest")
        }
        let path = &row[0];
        let kind = row[1].as_str();
        if path.is_empty()
            || path.len() > 4096
            || path.contains('\0')
            || path.contains('\\')
            || path
                .split('/')
                .any(|p| matches!(p, "" | "." | ".." | ".git"))
            || previous.is_some_and(|p| {
                p.encode_utf16().cmp(path.encode_utf16()) != std::cmp::Ordering::Less
            })
        {
            bail!("unsafe or unordered archive path")
        }
        previous = Some(path);
        if kind == "deleted" {
            if row.len() != 2 {
                bail!("invalid deleted archive entry")
            }
            continue;
        }
        if row.len() != 3
            || !matches!(kind, "file" | "executable" | "symlink")
            || !valid_hash(&row[2])
        {
            bail!("invalid archive entry")
        }
        let encoded = b
            .contents
            .get(&row[2])
            .ok_or_else(|| anyhow::anyhow!("missing archive content"))?;
        let bytes = STANDARD.decode(encoded)?;
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| anyhow::anyhow!("archive size overflow"))?;
        if total > 128 * 1024 * 1024
            || STANDARD.encode(&bytes) != *encoded
            || digest(&bytes) != row[2]
        {
            bail!("archive content hash or size mismatch")
        }
        if kind == "symlink" {
            std::str::from_utf8(&bytes)?;
        }
        used.insert(&row[2]);
    }
    if used.len() != b.contents.len() {
        bail!("unreferenced archive content")
    }
    let tree = digest(format!(
        "kode.workspace.manifest.v1\n{}",
        serde_json::to_string(&b.manifest)?
    ));
    if tree != snapshot.tree_hash
        || digest(format!(
            "kode.workspace.delta.v1\n{}\n{}",
            b.base_tree, tree
        )) != snapshot.patch_hash
    {
        bail!("archive manifest hash mismatch")
    }
    Ok(())
}
