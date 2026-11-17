//! Authoritative collaboration origin checks for context registration, not runtime admission.
use super::{model::Kind, storage};
use crate::messaging::coordinator_context_scope::{self, ContextScope};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::messaging) struct Origin {
    pub home_hub: String,
    pub host_id: String,
    pub workspace_id: String,
    pub root_ref: String,
}

pub(in crate::messaging) fn resolve(
    db: &Connection,
    home: &str,
    surface_id: &str,
    thread_id: &str,
    team_id: &str,
    team_revision: u64,
    audience_revision: u64,
) -> Result<(ContextScope, Origin)> {
    let surface = storage::surface(db, home, surface_id, true)?;
    if surface.id != surface_id
        || surface.audience_revision != audience_revision
        || audience_revision == 0
        || team_revision == 0
    {
        bail!("context surface identity or audience changed")
    }
    storage::check_team(db, &surface, team_id, Some(team_revision), None)?;
    // Only real discussion roots can establish a fresh context. No legacy session lookup,
    // task/archive inference, message content projection, or client supplied scope is used.
    let root: String = db.query_row(
        "SELECT body FROM collaboration_messages WHERE surface_id=?1 AND id=?2 AND thread_id=?2 AND kind='discussion'",
        params![surface_id, thread_id], |r| r.get(0),
    )?;
    let root: serde_json::Value = serde_json::from_str(&root)?;
    if root["id"] != thread_id
        || root["thread_id"] != thread_id
        || root["surface_id"] != surface_id
        || root["kind"] != "discussion"
        || root["scope"] != serde_json::to_value(&surface.scope)?
    {
        bail!("context discussion origin mismatch")
    }
    let scope = ContextScope {
        version: 2,
        home_hub: home.into(),
        team_id: team_id.into(),
        kind: if surface.kind == Kind::Dm {
            coordinator_context_scope::Kind::TeamPrivate
        } else {
            coordinator_context_scope::Kind::DiscussionThread
        },
        scope_id: coordinator_context_scope::discussion_scope_id(surface_id, thread_id)?,
        context_epoch: 1,
    };
    scope.validate()?;
    let origin = Origin {
        home_hub: surface.scope.home_hub,
        host_id: surface.scope.host_id,
        workspace_id: surface.scope.workspace_id,
        root_ref: surface.scope.root_ref,
    };
    Ok((scope, origin))
}

#[cfg(test)]
#[path = "context_registry_tests.rs"]
mod tests;
