//! Bounded interview observations, never trusted execution or permission evidence.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inspection {
    pub workspace: super::teams::WorkspaceRef,
    pub facts: Vec<Fact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_checks: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fact {
    pub path: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<Trust>,
}
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Observed,
    Missing,
    UnsupportedFile,
    TooLarge,
    ChangedDuringRead,
    NotText,
    SymlinkDenied,
    Unavailable,
    DirectoryScanned,
    DirectoryPartial,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    UntrustedProjectData,
}
impl Inspection {
    pub fn validate(&self, workspaces: &[super::teams::WorkspaceRef]) -> Result<()> {
        let w = &self.workspace;
        if !workspaces.iter().any(|v| {
            v.host_id == w.host_id && v.workspace_id == w.workspace_id && v.root_ref == w.root_ref
        }) || self.facts.is_empty()
            || self.facts.len() > 64
            || self.pending_checks.len() > 16
            || self.pending_checks.iter().any(|value| value.is_empty() || value.len() > 160 || value.contains('\0'))
            || self
                .facts
                .iter()
                .map(|f| &f.path)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.facts.len()
        {
            bail!("Builder inspection outside selected workspace or invalid facts")
        }
        for f in &self.facts {
            if f.path.is_empty()
                || f.path.len() > 1024
                || f.path.contains(['\0', '\\'])
                || f.path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                bail!("invalid Builder fact path")
            }
            if f.status == Status::Observed {
                let content = f
                    .content
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("Builder fact content missing"))?;
                let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
                if content.len() > 65536
                    || content.contains('\0')
                    || f.bytes != Some(content.len())
                    || f.sha256.as_deref() != Some(hash.as_str())
                    || f.observed_at
                        .is_none_or(|at| at == 0 || at > i64::MAX as u64)
                    || f.trust.is_none()
                {
                    bail!("invalid Builder fact content binding")
                }
            } else if f.sha256.is_some()
                || f.bytes.is_some()
                || f.observed_at.is_some()
                || f.content.is_some()
                || f.trust.is_some()
            {
                bail!("unobserved Builder fact cannot carry content")
            }
        }
        Ok(())
    }
}
