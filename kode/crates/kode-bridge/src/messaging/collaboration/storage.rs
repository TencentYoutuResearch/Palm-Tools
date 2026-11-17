use super::model::*;
use crate::messaging::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}
pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(super) fn scope_key(scope: &Scope) -> Result<String> {
    Ok(serde_json::to_string(scope)?)
}
pub(super) fn check_scope(db: &Connection, home: &str, scope: &Scope) -> Result<()> {
    if scope.home_hub != home || scope.host_id != home {
        bail!("collaboration currently requires a local registered workspace on this Home Hub")
    }
    if !valid_id(&scope.workspace_id) || !text(&scope.root_ref, 4096) {
        bail!("invalid workspace scope")
    }
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key='workspaces'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let catalog: Value = body
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(Value::Null);
    let row = &catalog["tables"]["workspaces"][&scope.workspace_id];
    if catalog["version"] != 2
        || row["path"].as_str() != Some(&scope.root_ref)
        || !catalog["global"]["workspaceIds"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(scope.workspace_id)))
    {
        bail!("workspace missing, moved or revoked")
    }
    Ok(())
}
pub(super) fn surface(db: &Connection, home: &str, id: &str, enabled: bool) -> Result<Surface> {
    if !valid_id(id) {
        bail!("invalid surface identity")
    }
    let s: String = db.query_row(
        "SELECT body FROM collaboration_surfaces WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    let row: Surface = serde_json::from_str(&s)?;
    check_scope(db, home, &row.scope)?;
    if enabled && !row.enabled {
        bail!("surface disabled")
    }
    Ok(row)
}
pub(super) fn check_team(
    db: &Connection,
    surface: &Surface,
    id: &str,
    revision: Option<u64>,
    worker: Option<&str>,
) -> Result<u64> {
    if !surface.team_ids.iter().any(|v| v == id) {
        bail!("team is not a member of this surface")
    }
    team_in_scope(db, &surface.scope, id, revision, worker)
}
pub(super) fn team_in_scope(
    db: &Connection,
    scope: &Scope,
    id: &str,
    revision: Option<u64>,
    worker: Option<&str>,
) -> Result<u64> {
    if !valid_id(id) {
        bail!("invalid team identity")
    }
    let body:String=db.query_row("SELECT r.body FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision WHERE t.id=?1",[id],|r|r.get(0))?;
    let row: Value = serde_json::from_str(&body)?;
    let current = row["revision"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("invalid team revision"))?;
    if revision.is_some_and(|v| v != current) {
        bail!("team revision changed")
    }
    let allows = |w: &Value| {
        w["host_id"] == scope.host_id
            && w["workspace_id"] == scope.workspace_id
            && w["root_ref"] == scope.root_ref
    };
    if !row["spec"]["workspace_refs"]
        .as_array()
        .is_some_and(|a| a.iter().any(allows))
    {
        bail!("workspace outside team scope")
    }
    if let Some(worker) = worker {
        if !valid_id(worker) {
            bail!("invalid worker role")
        }
        let found = row["spec"]["workers"]
            .as_array()
            .and_then(|a| a.iter().find(|w| w["id"] == worker));
        if !found.is_some_and(|w| {
            w["workspace_refs"]
                .as_array()
                .is_some_and(|a| a.iter().any(allows))
        }) {
            bail!("worker outside task workspace")
        }
    }
    Ok(current)
}
pub(super) fn receipt(
    db: &Connection,
    namespace: &str,
    id: &str,
    request: &Value,
) -> Result<Option<Value>> {
    if !valid_id(id) {
        bail!("invalid request identity")
    }
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT request,body FROM collaboration_receipts WHERE namespace=?1 AND request_id=?2",
            params![namespace, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(old, body)| {
        if serde_json::from_str::<Value>(&old)? != *request {
            bail!("collaboration request identity conflict")
        }
        Ok(serde_json::from_str(&body)?)
    })
    .transpose()
}
pub(super) fn save_receipt(
    db: &Connection,
    namespace: &str,
    id: &str,
    request: &Value,
    result: &Value,
) -> Result<()> {
    db.execute("INSERT INTO collaboration_receipts(namespace,request_id,request,body) VALUES (?1,?2,?3,?4)",params![namespace,id,serde_json::to_string(request)?,serde_json::to_string(result)?])?;
    Ok(())
}
pub(in crate::messaging) fn insert_message(
    db: &Connection,
    surface: &str,
    thread: &str,
    kind: &str,
    mut row: Value,
) -> Result<Value> {
    let id = row["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("message identity missing"))?
        .to_string();
    db.execute("INSERT INTO collaboration_messages(id,surface_id,thread_id,kind,body) VALUES (?1,?2,?3,?4,?5)",params![id,surface,thread,kind,serde_json::to_string(&row)?])?;
    row["sequence"] = json!(db.last_insert_rowid());
    db.execute(
        "UPDATE collaboration_messages SET body=?1 WHERE id=?2",
        params![serde_json::to_string(&row)?, id],
    )?;
    Ok(row)
}
// Older owner-command rows omitted scope. Recover only in the response, from the
// persisted task and relational message identity; never infer scope from the request.
fn restore_legacy_command_scope(
    db: &Connection,
    home: &str,
    surface: &Surface,
    stored_id: &str,
    stored_thread: &str,
    stored_kind: &str,
    row: &mut Value,
) -> Result<()> {
    if stored_kind != "owner_command" || row.get("scope").is_some() {
        return Ok(());
    }
    let task_id = row["task_id"].as_str()
        .ok_or_else(|| anyhow::anyhow!("legacy command task identity missing"))?;
    let task = super::tasks::task(db, task_id)?;
    let (_, archive) = super::tasks::guard(db, home, &task)?;
    if row["id"] != stored_id || row["kind"] != stored_kind
        || row["surface_id"] != surface.id || row["thread_id"] != stored_thread
        || task.archive_surface_id != surface.id || task.thread_id != stored_thread
        || task.scope != surface.scope || archive.scope != surface.scope
    {
        bail!("legacy command task scope mismatch")
    }
    row["scope"] = serde_json::to_value(task.scope)?;
    Ok(())
}

pub(super) fn message(db: &Connection, surface: &str, id: &str) -> Result<Value> {
    let body: String = db.query_row(
        "SELECT body FROM collaboration_messages WHERE surface_id=?1 AND id=?2",
        params![surface, id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&body)?)
}
impl Store {
    pub(super) fn change_collaboration_surface(
        &self,
        id: &str,
        input: SurfaceChange,
    ) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !text(&input.title, 160)
            || input.expected_revision >= i64::MAX as u64
            || input.team_ids.is_empty()
            || input.team_ids.len() > 64
            || (input.kind == Kind::Dm && input.team_ids.len() != 1)
        {
            bail!("invalid collaboration surface")
        }
        let mut unique = std::collections::HashSet::new();
        if !input.team_ids.iter().all(|v| unique.insert(v)) {
            bail!("duplicate team member")
        }
        let request = serde_json::to_value(&input)?;
        let namespace = format!("surface:{id}");
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        check_scope(&tx, &self.node_id, &input.scope)?;
        if let Some(r) = receipt(&tx, &namespace, &input.request_id, &request)? {
            return Ok(r);
        }
        for team in &input.team_ids {
            team_in_scope(&tx, &input.scope, team, None, None)?;
        }
        let prior: Option<String> = tx
            .query_row(
                "SELECT body FROM collaboration_surfaces WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let prior: Option<Surface> = prior.map(|s| serde_json::from_str(&s)).transpose()?;
        if prior.as_ref().map(|p| p.revision).unwrap_or(0) != input.expected_revision {
            bail!("surface revision changed")
        }
        if prior
            .as_ref()
            .is_some_and(|p| p.scope != input.scope || p.kind != input.kind)
        {
            bail!("surface scope and kind are immutable")
        }
        let audience_revision = prior
            .as_ref()
            .map(|p| {
                p.audience_revision
                    + u64::from(p.team_ids != input.team_ids || p.enabled != input.enabled)
            })
            .unwrap_or(1);
        let row = Surface {
            id: id.into(),
            scope: input.scope,
            kind: input.kind,
            title: input.title,
            team_ids: input.team_ids,
            revision: input.expected_revision + 1,
            audience_revision,
            enabled: input.enabled,
        };
        let body = serde_json::to_value(&row)?;
        tx.execute("INSERT INTO collaboration_surfaces(id,scope_key,kind,revision,enabled,body) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,body=excluded.body",params![id,scope_key(&row.scope)?,if row.kind==Kind::Channel{"channel"}else{"dm"},row.revision,row.enabled,serde_json::to_string(&row)?])?;
        save_receipt(&tx, &namespace, &input.request_id, &request, &body)?;
        tx.commit()?;
        Ok(body)
    }
    pub(super) fn collaboration_surfaces(&self, scope: Scope) -> Result<Value> {
        let db = self.db.lock();
        check_scope(&db, &self.node_id, &scope)?;
        let mut q=db.prepare("SELECT body FROM collaboration_surfaces WHERE scope_key=?1 AND enabled=1 ORDER BY id LIMIT 201")?;
        let rows = q
            .query_map([scope_key(&scope)?], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() > 200 {
            bail!("surface directory exceeds supported bound")
        }
        let items = rows
            .into_iter()
            .map(|s| serde_json::from_str::<Value>(&s))
            .collect::<serde_json::Result<Vec<_>>>()?;
        Ok(json!({"scope":scope,"items":items}))
    }
    pub(super) fn send_collaboration_message(&self, id: &str, input: Send) -> Result<Value> { 
        Ok(self.send_collaboration_message_with_status(id,input)?.0)
    }
    pub(super) fn send_collaboration_message_with_status(&self, id: &str, input: Send) -> Result<(Value,bool)> {
        if !text(&input.content, 65536) || input.mentions.len() > 16 {
            bail!("invalid message")
        }
        let request = serde_json::to_value(&input)?;
        let namespace = format!("message:{id}");
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let surface = surface(&tx, &self.node_id, id, true)?;
        if let Some(r) = receipt(&tx, &namespace, &input.request_id, &request)? {
            return Ok((r,false));
        }
        if input.expected_revision != surface.revision {
            bail!("surface revision changed")
        }
        if let Some(selection)=&input.interactive_selection {
            if selection.audience_revision!=surface.audience_revision {bail!("interactive selection audience changed")}
            check_team(&tx,&surface,&selection.team_id,Some(selection.team_revision),None)?;
            let workspace=json!({"host_id":surface.scope.host_id,"workspace_id":surface.scope.workspace_id,"root_ref":surface.scope.root_ref});
            crate::messaging::interactive_team::validate_selection_in(&tx,&self.node_id,selection,&workspace)?;
            if input.mentions.iter().any(|m|m.team_id!=selection.team_id||m.team_revision!=selection.team_revision||
                if selection.participant_id=="coordinator" {m.worker_id.is_some()} else {m.worker_id.as_deref()!=selection.participant_id.strip_prefix("worker:")}) {bail!("interactive selection mentions mismatch")}
        }
        for mention in &input.mentions {
            check_team(
                &tx,
                &surface,
                &mention.team_id,
                Some(mention.team_revision),
                mention.worker_id.as_deref(),
            )?;
        }
        let message_id = uuid::Uuid::new_v4().to_string();
        let thread_id = if let Some(root) = &input.thread_id {
            let row = message(&tx, id, root)?;
            if row["thread_id"] != *root {
                bail!("thread must reference a root message")
            }
            root.clone()
        } else {
            message_id.clone()
        };
        let mut row = json!({"id":message_id,"surface_id":id,"thread_id":thread_id,"scope":surface.scope,"actor":{"kind":"human","id":"local_owner"},"kind":"discussion","content":input.content,"mentions":input.mentions,"created_at":now(),"delivery_state":"stored_only","execution_authorized":false});
        if let Some(selection)=&input.interactive_selection {
            row["interactive_selection"]=serde_json::to_value(selection)?;
            row["audience_revision"]=json!(surface.audience_revision);
            // Interactive routing is only an owner Host choice; do not invoke controlled dispatch.
        } else {
        super::discussion_dispatch::accept(&tx, &self.node_id, &surface, &mut row, &input.mentions)?;
        }
        let row = insert_message(&tx, id, &thread_id, "discussion", row)?;
        save_receipt(&tx, &namespace, &input.request_id, &request, &row)?;
        tx.commit()?;
        Ok((row,true))
    }
    pub(super) fn collaboration_messages(&self, id: &str, page: Page) -> Result<Value> {
        let limit = page.limit.unwrap_or(25);
        if limit == 0 || limit > 50 || page.after > i64::MAX as u64 {
            bail!("invalid message page")
        }
        let db = self.db.lock();
        let surface = surface(&db, &self.node_id, id, true)?;
        if let Some(thread) = &page.thread_id {
            let root = message(&db, id, thread)?;
            if root["thread_id"] != *thread {
                bail!("invalid thread root")
            }
        }
        let mut q=db.prepare("SELECT seq,body,id,thread_id,kind FROM collaboration_messages WHERE surface_id=?1 AND seq>?2 AND (?3 IS NULL OR thread_id=?3) ORDER BY seq LIMIT ?4")?;
        let rows = q
            .query_map(params![id, page.after, page.thread_id, limit + 1], |r| {
                Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut after = page.after;
        let mut more = false;
        for (seq, body, stored_id, stored_thread, stored_kind) in rows {
            if items.len() == limit || (!items.is_empty() && bytes + body.len() > 262144) {
                more = true;
                break;
            }
            bytes += body.len();
            after = seq;
            let mut row = serde_json::from_str::<Value>(&body)?;
            restore_legacy_command_scope(&db, &self.node_id, &surface, &stored_id, &stored_thread, &stored_kind, &mut row)?;
            super::discussion_dispatch::presentation(&db, &mut row)?;
            items.push(row);
        }
        Ok(
            json!({"surface":surface,"items":items,"has_more":more,"next_cursor":if more{json!(after)}else{Value::Null}}),
        )
    }
}

impl Store {
    /// Stable sidebar entry points for both channel and DM threads; no private cross-surface union.
    pub(super) fn collaboration_threads(&self, id: &str, page: Page) -> Result<Value> {
        let limit = page.limit.unwrap_or(25);
        if limit == 0 || limit > 50 || page.after > i64::MAX as u64 || page.thread_id.is_some() {
            bail!("invalid thread page")
        }
        let db = self.db.lock();
        let surface = surface(&db, &self.node_id, id, true)?;
        let mut query=db.prepare("SELECT root.seq,root.body,(SELECT count(*) FROM collaboration_messages reply WHERE reply.surface_id=root.surface_id AND reply.thread_id=root.id AND reply.id!=root.id),(SELECT max(seq) FROM collaboration_messages reply WHERE reply.surface_id=root.surface_id AND reply.thread_id=root.id) FROM collaboration_messages root WHERE root.surface_id=?1 AND root.id=root.thread_id AND root.seq>?2 ORDER BY root.seq LIMIT ?3")?;
        let rows = query
            .query_map(params![id, page.after, limit + 1], |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                    r.get::<_, u64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut next = page.after;
        let mut more = false;
        for (seq, body, replies, last) in rows {
            if items.len() == limit || (!items.is_empty() && bytes + body.len() > 262144) {
                more = true;
                break;
            }
            bytes += body.len();
            next = seq;
            let mut root: Value = serde_json::from_str(&body)?;
            // Summaries are scoped by the same authorized surface and exact root.
            // Never infer reply counts or participants from a paginated message window.
            let mut actors_query = db.prepare("SELECT json_extract(body,'$.actor') FROM collaboration_messages WHERE surface_id=?1 AND thread_id=?2 AND id!=thread_id AND json_type(body,'$.actor')='object' GROUP BY json_extract(body,'$.actor') ORDER BY min(seq) LIMIT 3")?;
            let reply_actors = actors_query.query_map(params![id,root["id"].as_str().unwrap_or("")], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?.into_iter()
                .map(|actor| serde_json::from_str::<Value>(&actor)).collect::<serde_json::Result<Vec<_>>>()?;
            let root_id = root["id"].as_str().unwrap_or("").to_owned();
            let root_kind = root["kind"].as_str().unwrap_or("").to_owned();
            restore_legacy_command_scope(&db, &self.node_id, &surface, &root_id, &root_id, &root_kind, &mut root)?;
            super::discussion_dispatch::presentation(&db, &mut root)?;
            items.push(json!({"thread_id":root["id"],"root":root,"reply_count":replies,"reply_actors":reply_actors,"last_sequence":last}));
        }
        Ok(
            json!({"surface":surface,"items":items,"has_more":more,"next_cursor":if more{json!(next)}else{Value::Null}}),
        )
    }
}
