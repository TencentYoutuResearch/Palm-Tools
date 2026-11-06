//! Home-administrator grants. Immutable revisions are stored separately from the current pointer.
use super::{model::valid_id, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Read,
    WorkspaceWrite,
    Commit,
    Push,
    Merge,
    Deploy,
    ExternalMessage,
    Delegate,
    BuilderDraftWrite,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub host: String,
    pub workspace: String,
    pub root: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub id: String,
    pub team_id: String,
    pub enabled: bool,
    pub expires_at: u64,
    pub targets: Vec<Target>,
    pub capabilities: Vec<Capability>,
    pub tools: Vec<String>,
    pub network: bool,
    pub budget_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Write {
    pub expected_revision: u64,
    pub policy: Policy,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Grant {
    pub revision: u64,
    pub policy: Policy,
    pub grantor: String,
    pub recorded_at: u64,
}
fn key(id: &str, revision: Option<u64>) -> String {
    format!(
        "team-grant:{}",
        serde_json::to_string(&(id, revision)).unwrap()
    )
}
pub(super) fn read(db: &Connection, id: &str, revision: Option<u64>) -> Result<Option<Grant>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id, revision)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
impl Policy {
    fn validate(&self, _at: u64) -> Result<()> {
        if !valid_id(&self.id)
            || !valid_id(&self.team_id)
            || self.targets.is_empty()
            || self.targets.len() > 64
            || self.tools.len() > 256
            || self.budget_ids.len() > 64
            || self.expires_at > i64::MAX as u64
        {
            bail!("invalid team grant policy")
        }
        for target in &self.targets {
            if !valid_id(&target.host)
                || !valid_id(&target.workspace)
                || !target.root.starts_with('/')
                || target.root.len() > 4096
                || target.root.contains('\0')
                || target.root.split('/').any(|p| p == ".." || p == ".")
            {
                bail!("invalid grant workspace root")
            }
        }
        if self
            .tools
            .iter()
            .chain(self.budget_ids.iter())
            .any(|v| !valid_id(v) || v == "*")
        {
            bail!("explicit grant tool and budget identities required")
        }
        if self.capabilities.len() > 9 {
            bail!("invalid grant capabilities")
        }
        Ok(())
    }
}
pub(super) fn write_in(tx: &rusqlite::Transaction, input: Write, at: u64) -> Result<Value> {
    input.policy.validate(at)?;
    let next = input
        .expected_revision
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| anyhow::anyhow!("invalid grant revision"))?;
    let current = read(tx, &input.policy.id, None)?;
    if let Some(ref old) = current {
        if old.revision == next && old.policy == input.policy {
            return Ok(json!({"grant":old,"duplicate":true}));
        }
        if old.policy.team_id != input.policy.team_id {
            bail!("grant team identity cannot change")
        }
    }
    if current.as_ref().map(|g| g.revision).unwrap_or(0) != input.expected_revision {
        bail!("grant revision conflict")
    }
    if input.policy.enabled && input.policy.expires_at <= at {
        bail!("team grant already expired")
    }
    let grant = Grant {
        revision: next,
        policy: input.policy,
        grantor: "home_administrator".into(),
        recorded_at: at,
    };
    let body = serde_json::to_string(&grant)?;
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3)",
        params![key(&grant.policy.id, Some(next)), next, body],
    )?;
    tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value",params![key(&grant.policy.id,None),next,body])?;
    Ok(json!({"grant":grant,"duplicate":false}))
}
impl Store {
    pub fn team_grant(&self, id: &str, revision: Option<u64>) -> Result<Option<Grant>> {
        if !valid_id(id) {
            bail!("invalid grant identity")
        }
        read(&self.db.lock(), id, revision)
    }
    pub fn write_team_grant(&self, input: Write, at: u64) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = write_in(&tx, input, at)?;
        tx.commit()?;
        Ok(result)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub team_id: String,
    pub revision: u64,
    pub target: Target,
    pub capabilities: Vec<Capability>,
    pub tools: Vec<String>,
    pub network: bool,
    pub budget_ids: Vec<String>,
}
pub(super) fn evaluate(db: &Connection, id: &str, input: &Check, at: u64) -> Result<Value> {
    if !valid_id(id)
        || input.tools.len() > 256
        || input.capabilities.len() > 9
        || input.budget_ids.len() > 64
    {
        bail!("invalid grant check")
    }
    let grant = read(db, id, None)?;
    let reason = match &grant {
        None => Some("missing"),
        Some(g) if g.policy.team_id != input.team_id => Some("foreign_team"),
        Some(g) if g.revision != input.revision => Some("revision_changed"),
        Some(g) if !g.policy.enabled => Some("revoked"),
        Some(g) if g.policy.expires_at <= at => Some("expired"),
        Some(g) if !g.policy.targets.contains(&input.target) => Some("workspace_denied"),
        Some(g) if input.network && !g.policy.network => Some("network_denied"),
        Some(g)
            if input
                .capabilities
                .iter()
                .any(|v| !g.policy.capabilities.contains(v)) =>
        {
            Some("capability_denied")
        }
        Some(g) if input.tools.iter().any(|v| !g.policy.tools.contains(v)) => Some("tool_denied"),
        Some(g)
            if input
                .budget_ids
                .iter()
                .any(|v| !g.policy.budget_ids.contains(v)) =>
        {
            Some("budget_denied")
        }
        _ => None,
    };
    Ok(
        json!({"allowed":reason.is_none(),"reason":reason,"revision":grant.as_ref().map(|g|g.revision),"expires_at":grant.as_ref().map(|g|g.policy.expires_at)}),
    )
}
impl Store {
    pub fn check_team_grant(&self, id: &str, input: Check, at: u64) -> Result<Value> {
        evaluate(&self.db.lock(), id, &input, at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_grant_denies_checks_but_exact_write_receipt_survives() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("hub.sqlite"), "fixture").unwrap();
        let target = Target {
            host: "fixture".into(),
            workspace: "workspace".into(),
            root: "/srv/fixture".into(),
        };
        let policy = Policy {
            id: "grant".into(),
            team_id: "team".into(),
            enabled: true,
            expires_at: 200,
            targets: vec![target.clone()],
            capabilities: vec![Capability::Read],
            tools: vec!["read".into()],
            network: false,
            budget_ids: vec![],
        };
        store
            .write_team_grant(
                Write {
                    expected_revision: 0,
                    policy: policy.clone(),
                },
                100,
            )
            .unwrap();
        let check = Check {
            team_id: "team".into(),
            revision: 1,
            target,
            capabilities: vec![Capability::Read],
            tools: vec!["read".into()],
            network: false,
            budget_ids: vec![],
        };
        assert_eq!(
            store.check_team_grant("grant", check.clone(), 199).unwrap()["allowed"],
            true
        );
        assert_eq!(
            store.check_team_grant("grant", check, 200).unwrap()["reason"],
            "expired"
        );
        assert_eq!(
            store
                .write_team_grant(
                    Write {
                        expected_revision: 0,
                        policy: policy.clone()
                    },
                    300
                )
                .unwrap()["duplicate"],
            true
        );
        assert!(store
            .write_team_grant(
                Write {
                    expected_revision: 1,
                    policy
                },
                300
            )
            .is_err());
    }
}
