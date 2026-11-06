//! Read-only configured versions. Listing confers no authority or execution readiness.
use super::{model::valid_id, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Workflow,
    Project,
    Delivery,
    Dependency,
    BudgetPolicy,
    SchedulingPolicy,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub expected_revision: u64,
    pub kind: Kind,
    #[serde(default)]
    pub after_id: String,
    #[serde(default)]
    pub after_version: String,
    pub limit: u32,
    #[serde(default)]
    pub team_id: Option<String>,
}
fn selected(project: &Value, workspaces: &Value) -> bool {
    project["config"]["spec"]["repositories"]
        .as_object()
        .is_some_and(|repos| {
            !repos.is_empty()
                && repos.values().all(|repo| {
                    workspaces
                        .as_array()
                        .is_some_and(|rows| rows.contains(&repo["workspace"]))
                })
        })
}
fn visible(db: &Connection, row: &Value, kind: &Kind, workspaces: &Value) -> Result<bool> {
    Ok(match kind {
        Kind::Workflow | Kind::BudgetPolicy | Kind::SchedulingPolicy => true,
        Kind::Project => selected(row, workspaces),
        Kind::Dependency => row["config"]["spec"]["artifact"]["hosts"].as_array().is_some_and(|hosts| {
            workspaces.as_array().is_some_and(|workspaces| workspaces.iter().any(|workspace| hosts.contains(&workspace["host_id"])))
        }),
        Kind::Delivery => {
            let reference = &row["config"]["spec"]["project"];
            let body: Option<String> = db
                .query_row(
                    "SELECT body FROM project_configs WHERE id=?1 AND version=?2",
                    params![reference["id"].as_str(), reference["version"].as_str()],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(body) = body {
                let project: Value = serde_json::from_str(&body)?;
                project["hash"] == reference["hash"] && selected(&project, workspaces)
            } else {
                false
            }
        }
    })
}
impl Store {
    pub fn builder_catalog(&self, id: &str, query: Query) -> Result<Value> {
        if !valid_id(id)
            || query.expected_revision == 0
            || query.limit == 0
            || query.limit > 10
            || query.after_id.is_empty() != query.after_version.is_empty()
            || !query.after_id.is_empty()
                && (!valid_id(&query.after_id) || !valid_id(&query.after_version))
        {
            bail!("invalid Builder catalog request")
        }
        let is_policy = matches!(query.kind, Kind::BudgetPolicy | Kind::SchedulingPolicy);
        if is_policy && !query.team_id.as_deref().is_some_and(valid_id) {
            bail!("Builder policy catalog requires candidate team")
        }
        let db = self.db.lock();
        let body: String = db.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&body)?;
        if draft["status"] != "draft" || draft["revision"].as_u64() != Some(query.expected_revision)
        {
            bail!("Builder draft unavailable or revision conflict")
        }
        let (sql,category)=match query.kind {
            Kind::Workflow=>("SELECT body FROM workflow_versions WHERE (id,version)>(?1,?2) AND ?4='workflow' AND ?5 IS NOT NULL ORDER BY id,version LIMIT ?3","workflow"),
            Kind::Project=>("SELECT body FROM project_configs WHERE (id,version)>(?1,?2) AND json_extract(body,'$.config.spec.kind')=?4 AND ?5 IS NOT NULL ORDER BY id,version LIMIT ?3","project_bindings"),
            Kind::Delivery=>("SELECT body FROM project_configs WHERE (id,version)>(?1,?2) AND json_extract(body,'$.config.spec.kind')=?4 AND ?5 IS NOT NULL ORDER BY id,version LIMIT ?3","delivery_policy"),
            Kind::Dependency=>("SELECT body FROM project_configs WHERE (id,version)>(?1,?2) AND json_extract(body,'$.config.spec.kind')=?4 AND ?5 IS NOT NULL ORDER BY id,version LIMIT ?3","workflow_dependency"),
            Kind::BudgetPolicy|Kind::SchedulingPolicy=>("SELECT value FROM workbench_documents WHERE key=('team-policy:' || json_array(json_extract(value,'$.id'),NULL)) AND json_extract(value,'$.team_id')=?5 AND json_extract(value,'$.policy.kind')=?4 AND (json_extract(value,'$.id'),CAST(json_extract(value,'$.revision') AS TEXT))>(?1,?2) ORDER BY json_extract(value,'$.id'),CAST(json_extract(value,'$.revision') AS TEXT) LIMIT ?3",if matches!(query.kind,Kind::BudgetPolicy){"budget"}else{"scheduling"}),
        };
        let mut statement = db.prepare(sql)?;
        let rows = statement
            .query_map(
                params![
                    query.after_id,
                    query.after_version,
                    query.limit + 1,
                    category,
                    query.team_id.as_deref().unwrap_or("")
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = rows.len() > query.limit as usize;
        let mut items = Vec::new();
        let mut cursor = Value::Null;
        for body in rows.into_iter().take(query.limit as usize) {
            let row: Value = serde_json::from_str(&body)?;
            let version = if is_policy {
                json!(row["revision"].to_string())
            } else {
                row["version"].clone()
            };
            cursor = json!({"after_id":row["id"],"after_version":version});
            if visible(
                &db,
                &row,
                &query.kind,
                &draft["interview"]["workspace_refs"],
            )? {
                // Do not silently truncate configuration into a seemingly complete proposal.
                items.push(if body.len()>65536 {json!({"id":row["id"],"version":row["version"],"revision":row["revision"],"hash":row["hash"],"details_omitted":"configuration_too_large"})}else{row});
            }
        }
        Ok(
            json!({"draft_id":id,"draft_revision":query.expected_revision,"home_hub":self.node_id,"items":items,"has_more":has_more,"cursor":if has_more {cursor}else{Value::Null},"eligible_for_execution":false}),
        )
    }
}
