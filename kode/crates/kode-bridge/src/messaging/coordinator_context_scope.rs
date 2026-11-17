//! Context identity contract only. No route or runtime admission is enabled here.
//! Legacy controls remain unchanged; a v2 label never authorizes history reuse.
use super::model::valid_id;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    TeamPrivate,
    DiscussionThread,
    BuilderDraft,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Wire")]
pub struct ContextScope {
    pub version: u32,
    pub home_hub: String,
    pub team_id: String,
    pub kind: Kind,
    pub scope_id: String,
    pub context_epoch: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    version: u32,
    home_hub: String,
    team_id: String,
    kind: Kind,
    scope_id: String,
    context_epoch: u64,
}

impl TryFrom<Wire> for ContextScope {
    type Error = anyhow::Error;
    fn try_from(v: Wire) -> Result<Self> {
        let scope = Self {
            version: v.version,
            home_hub: v.home_hub,
            team_id: v.team_id,
            kind: v.kind,
            scope_id: v.scope_id,
            context_epoch: v.context_epoch,
        };
        scope.validate()?;
        Ok(scope)
    }
}

impl ContextScope {
    pub fn validate(&self) -> Result<()> {
        // Epoch rotation is not implemented yet; do not imply support for it.
        if self.version != 2
            || self.context_epoch != 1
            || ![&self.home_hub, &self.team_id, &self.scope_id]
                .iter()
                .all(|id| valid_id(id))
            || self.kind == Kind::DiscussionThread
                && (self.scope_id.len() != 64
                    || !self
                        .scope_id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        {
            bail!("Invalid context_scope v2 identity")
        }
        Ok(())
    }

    /// Canonical ordered-array hash, shared with the JS context-scope contract.
    pub fn key(&self) -> Result<String> {
        self.validate()?;
        let encoded = serde_json::to_vec(&serde_json::json!([
            self.version,
            self.home_hub,
            self.team_id,
            self.kind,
            self.scope_id,
            self.context_epoch
        ]))?;
        Ok(format!("{:x}", Sha256::digest(encoded)))
    }
}

pub fn discussion_scope_id(surface_id: &str, thread_id: &str) -> Result<String> {
    if !valid_id(surface_id) || !valid_id(thread_id) {
        bail!("Invalid discussion context identity")
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&[surface_id, thread_id])?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn fixture() -> Value {
        json!({"version":2,"home_hub":"home","team_id":"team","kind":"discussion_thread",
            "scope_id":discussion_scope_id("surface","a").unwrap(),"context_epoch":1})
    }
    #[test]
    fn strict_scope_rejects_missing_unknown_and_unimplemented_identity() {
        let base = fixture();
        for (key, value) in [
            ("version", json!(1)),
            ("context_epoch", json!(2)),
            ("kind", json!("legacy_shared")),
            ("scope_id", json!("thread-a")),
            ("home_hub", json!("")),
            ("team_id", json!("../team")),
            ("inherited", json!(true)),
        ] {
            let mut row = base.clone();
            row[key] = value;
            assert!(
                serde_json::from_value::<ContextScope>(row).is_err(),
                "accepted {key}"
            );
        }
        for key in [
            "version",
            "home_hub",
            "team_id",
            "kind",
            "scope_id",
            "context_epoch",
        ] {
            let mut row = base.clone();
            row.as_object_mut().unwrap().remove(key);
            assert!(
                serde_json::from_value::<ContextScope>(row).is_err(),
                "accepted missing {key}"
            );
        }
        assert!(serde_json::from_value::<ContextScope>(Value::Null).is_err());
    }
    #[test]
    fn each_identity_dimension_changes_context_key_without_reading_history() {
        let base = fixture();
        let a: ContextScope = serde_json::from_value(base.clone()).unwrap();
        for (key, value) in [
            ("home_hub", json!("other")),
            ("team_id", json!("other")),
            ("kind", json!("team_private")),
            (
                "scope_id",
                json!(discussion_scope_id("surface", "b").unwrap()),
            ),
        ] {
            let mut row = base.clone();
            row[key] = value;
            let b: ContextScope = serde_json::from_value(row).unwrap();
            assert_ne!(a.key().unwrap(), b.key().unwrap());
        }
        assert_ne!(
            discussion_scope_id("ab", "c").unwrap(),
            discussion_scope_id("a", "bc").unwrap()
        );
        assert_eq!(
            serde_json::from_value::<ContextScope>(serde_json::to_value(&a).unwrap()).unwrap(),
            a
        );
    }
    #[test]
    fn canonical_hash_matches_js_golden_contract() {
        let id = discussion_scope_id("surface", "thread-a").unwrap();
        assert_eq!(
            id,
            "6e8680193a309edd5ea2ddc7658a96f4655bf580dc3584ad712b8b1981e2bdc0"
        );
        let mut row = fixture();
        row["scope_id"] = json!(id);
        let scope: ContextScope = serde_json::from_value(row.clone()).unwrap();
        assert_eq!(
            scope.key().unwrap(),
            "f806668b15956c9551350039f6c07f29910690ff74498e13b4603d41cb1ae021"
        );
        row["kind"] = json!("team_private");
        row["scope_id"] = json!("private");
        assert_eq!(
            serde_json::from_value::<ContextScope>(row.clone())
                .unwrap()
                .key()
                .unwrap(),
            "af332ef4679034726d90dd1d85c5c4dec2eb6733cfb6cb5c959bea20fb553421"
        );
        row["kind"] = json!("builder_draft");
        row["scope_id"] = json!("draft-a");
        assert_eq!(
            serde_json::from_value::<ContextScope>(row)
                .unwrap()
                .key()
                .unwrap(),
            "19a7c4ef5d91fc94f4b53010ad1789fa3d48ce9d3565dc14dd5bbad509960882"
        );
    }
}
