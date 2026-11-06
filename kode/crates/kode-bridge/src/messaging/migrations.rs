//! Versioned messaging schema upgrades. Backups use SQLite snapshots, never raw WAL copies.
use anyhow::{bail, Result};
use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};
pub(super) const VERSION: u32 = 29;
const BASE_SCHEMA: &str = r#"          CREATE TABLE IF NOT EXISTS identity (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, info TEXT NOT NULL, token TEXT NOT NULL, seen INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, source_node TEXT NOT NULL, source_session TEXT NOT NULL, target_node TEXT NOT NULL, target_session TEXT NOT NULL, idem TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(source_node,source_session,idem));
          CREATE TABLE IF NOT EXISTS cancellation_peers (peer TEXT PRIMARY KEY, supported INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS input_cancellations (message_id TEXT PRIMARY KEY, session TEXT NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1)), body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS input_cancellation_pending ON input_cancellations(session,pending,message_id);
          CREATE TABLE IF NOT EXISTS input_cancellation_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS runtime_deliveries (message_id TEXT PRIMARY KEY, session TEXT NOT NULL, phase INTEGER NOT NULL CHECK(phase BETWEEN 0 AND 2), body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS runtime_delivery_pending ON runtime_deliveries(session,phase,message_id);
          CREATE UNIQUE INDEX IF NOT EXISTS runtime_delivery_input ON runtime_deliveries(session,json_extract(body,'$.input_id'));
          CREATE TABLE IF NOT EXISTS delivery_peer_cursors (peer TEXT PRIMARY KEY, seq INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS delivery_mirrors (message_id TEXT PRIMARY KEY, body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS delivery_mirror_events (peer TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(peer,seq));
          CREATE TABLE IF NOT EXISTS runtime_delivery_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS message_target ON messages(target_node,target_session);
          CREATE INDEX IF NOT EXISTS message_inbox_status ON messages(target_node,target_session,json_extract(body,'$.status'));
          CREATE INDEX IF NOT EXISTS message_status ON messages(json_extract(body,'$.status'));
          CREATE INDEX IF NOT EXISTS message_route ON messages(source_node,target_node);
          CREATE TABLE IF NOT EXISTS workbench_documents (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);"#;

pub(super) fn preflight(db: &Connection, node: &str) -> Result<u32> {
    let version: u32 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > VERSION {
        bail!("messaging schema {version} is newer than supported {VERSION}")
    }
    let identity: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity')",
        [],
        |r| r.get(0),
    )?;
    if identity {
        let stored: Option<String> = db
            .query_row("SELECT value FROM identity WHERE key='node_id'", [], |r| {
                r.get(0)
            })
            .optional()?;
        if stored.as_deref().is_some_and(|id| id != node) {
            bail!("database belongs to a different node")
        }
    }
    Ok(version)
}
pub(super) fn backup_before_upgrade(
    db: &Connection,
    path: &Path,
    version: u32,
) -> Result<Option<PathBuf>> {
    let has_tables: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')", [], |r| r.get(0))?;
    if version == VERSION || !has_tables {
        return Ok(None);
    }
    let backup = path.with_extension(format!("pre-v{version}-{}.sqlite", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&backup)?;
    drop(file);
    // VACUUM INTO includes committed WAL pages in a consistent standalone snapshot.
    if let Err(error) = db.execute(
        "VACUUM INTO ?1",
        [backup
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid backup path"))?],
    ) {
        let _ = std::fs::remove_file(&backup);
        return Err(error.into());
    }
    std::fs::File::open(&backup)?.sync_all()?;
    Ok(Some(backup))
}
pub(super) fn migrate(db: &Connection, node: &str) -> Result<()> {
    let version = preflight(db, node)?;
    if version == VERSION {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    if version < 1 {
        tx.execute_batch(BASE_SCHEMA)?;
    }
    if version < 2 {
        let columns = tx
            .prepare("PRAGMA table_info(lifecycle_events)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !columns.is_empty() && !columns.iter().any(|c| c == "historical") {
            tx.execute_batch("ALTER TABLE lifecycle_events ADD COLUMN historical INTEGER NOT NULL DEFAULT 0; UPDATE lifecycle_events SET historical=1")?;
        }
        super::lifecycle::initialize_in(&tx)?;
    }
    if version < 3 {
        tx.execute_batch("CREATE TABLE operations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_key TEXT NOT NULL,state TEXT NOT NULL,lease_until INTEGER,body TEXT NOT NULL,UNIQUE(owner,request_key));
          CREATE INDEX operation_expiry ON operations(state,lease_until);
          CREATE TABLE operation_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,body TEXT NOT NULL);
          CREATE INDEX operation_audit ON operation_events(operation_id,seq);
          CREATE TABLE operation_reports(operation_id TEXT NOT NULL,report_id TEXT NOT NULL,command TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(operation_id,report_id));")?;
    }
    if version < 4 {
        tx.execute_batch("CREATE TABLE resource_accounts(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>0),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
          CREATE TABLE resource_bindings(host TEXT NOT NULL,profile TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES resource_accounts(id),account_epoch INTEGER NOT NULL CHECK(account_epoch>0),revision INTEGER NOT NULL CHECK(revision>0),PRIMARY KEY(host,profile));
          CREATE INDEX resource_account_bindings ON resource_bindings(account_id,account_epoch);
          CREATE TABLE resource_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);")?;
    }
    if version < 5 {
        tx.execute_batch("CREATE TABLE quota_snapshots(host TEXT NOT NULL,profile TEXT NOT NULL,binding_revision INTEGER NOT NULL,observed_at INTEGER NOT NULL,received_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(host,profile));")?;
    }
    if version < 6 {
        tx.execute_batch("ALTER TABLE resource_bindings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));")?;
    }
    if version < 7 {
        tx.execute_batch("CREATE TABLE budgets(id TEXT PRIMARY KEY,body TEXT NOT NULL);
          CREATE TABLE budget_reservations(id TEXT PRIMARY KEY,request TEXT NOT NULL,body TEXT NOT NULL);
          CREATE TABLE budget_settlements(reservation_id TEXT NOT NULL REFERENCES budget_reservations(id),event_id TEXT NOT NULL,command TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(reservation_id,event_id));
          CREATE TABLE budget_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);")?;
    }
    if version < 8 {
        tx.execute_batch("CREATE TABLE operation_budget_bindings(operation_id TEXT NOT NULL REFERENCES operations(id),attempt INTEGER NOT NULL,reservation_id TEXT NOT NULL UNIQUE REFERENCES budget_reservations(id),PRIMARY KEY(operation_id,attempt));")?;
    }
    if version < 9 {
        tx.execute_batch("CREATE TABLE budget_reservation_index(budget_id TEXT NOT NULL,reservation_id TEXT NOT NULL REFERENCES budget_reservations(id),PRIMARY KEY(budget_id,reservation_id));
          CREATE TABLE budget_event_index(budget_id TEXT NOT NULL,seq INTEGER NOT NULL REFERENCES budget_events(seq),PRIMARY KEY(budget_id,seq));
          INSERT INTO budget_reservation_index SELECT j.value,r.id FROM budget_reservations r,json_each(r.request,'$.budget_ids') j;
          INSERT OR IGNORE INTO budget_event_index SELECT json_extract(body,'$.budget.id'),seq FROM budget_events WHERE json_extract(body,'$.kind')='budget_configured';
          INSERT OR IGNORE INTO budget_event_index SELECT j.value,e.seq FROM budget_events e,json_each(e.body,'$.reservation.request.budget_ids') j;
          CREATE TRIGGER budget_reservation_index_insert AFTER INSERT ON budget_reservations BEGIN
            INSERT INTO budget_reservation_index SELECT value,new.id FROM json_each(new.request,'$.budget_ids');END;
          CREATE TRIGGER budget_event_index_insert AFTER INSERT ON budget_events BEGIN
            INSERT OR IGNORE INTO budget_event_index SELECT json_extract(new.body,'$.budget.id'),new.seq WHERE json_extract(new.body,'$.kind')='budget_configured';
            INSERT OR IGNORE INTO budget_event_index SELECT value,new.seq FROM json_each(new.body,'$.reservation.request.budget_ids');END;")?;
    }
    if version < 10 {
        tx.execute_batch("CREATE TABLE price_versions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
          CREATE TABLE reservation_prices(reservation_id TEXT PRIMARY KEY REFERENCES budget_reservations(id),price_id TEXT NOT NULL REFERENCES price_versions(id));
          CREATE TABLE metered_usage(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,reservation_id TEXT NOT NULL REFERENCES budget_reservations(id),command TEXT NOT NULL,result TEXT NOT NULL);
          CREATE INDEX metered_usage_reservation ON metered_usage(reservation_id,seq);")?;
    }
    if version < 11 {
        tx.execute_batch("CREATE TABLE operation_resource_bindings(operation_id TEXT NOT NULL REFERENCES operations(id),attempt INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(operation_id,attempt));")?;
    }
    if version < 12 {
        tx.execute_batch("CREATE TABLE quota_window_evidence(host TEXT NOT NULL,profile TEXT NOT NULL,binding_revision INTEGER NOT NULL,account_id TEXT NOT NULL,account_epoch INTEGER NOT NULL,limit_id TEXT NOT NULL,window_id TEXT NOT NULL,observed_at INTEGER NOT NULL,used_percent REAL NOT NULL,resets_at INTEGER,PRIMARY KEY(host,profile,binding_revision,limit_id,window_id));")?;
        super::quota_evidence::backfill(&tx)?;
    }
    if version < 13 {
        tx.execute_batch("CREATE TABLE official_calls(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,attempt INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL); CREATE INDEX official_call_operation ON official_calls(operation_id,attempt,id); CREATE TABLE official_call_events(call_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(call_id,sequence),FOREIGN KEY(call_id) REFERENCES official_calls(id));")?;
    }
    if version < 14 {
        tx.execute_batch("CREATE INDEX event_source_cursor ON events(json_extract(message,'$.source.node_id'),json_extract(message,'$.source.session_id'),seq);
          CREATE INDEX event_target_cursor ON events(json_extract(message,'$.target.node_id'),json_extract(message,'$.target.session_id'),seq);")?;
    }
    if version < 15 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS capability_profiles(id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), body TEXT NOT NULL, PRIMARY KEY(id,revision));")?;
    }
    if version < 16 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS monetary_quota(host TEXT NOT NULL,profile TEXT NOT NULL,source TEXT NOT NULL,binding_revision INTEGER NOT NULL,observed_at INTEGER NOT NULL,body TEXT NOT NULL,last_reported TEXT,PRIMARY KEY(host,profile,source));")?;
    }
    if version < 17 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS monetary_evidence(host TEXT NOT NULL,profile TEXT NOT NULL,binding_revision INTEGER NOT NULL,source TEXT NOT NULL,limit_id TEXT NOT NULL,observed_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(host,profile,binding_revision,source,limit_id));")?;
        // Replay source facts in durable order so partial snapshots cannot erase known exhaustion.
        let mut query = tx.prepare("SELECT json_extract(body,'$.observation') FROM resource_events WHERE json_extract(body,'$.kind')='monetary_quota_observed' ORDER BY seq")?;
        let rows = query.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            let observation: super::monetary_quota::Observation = serde_json::from_str(&row?)?;
            super::monetary_admission::observe(&tx, &observation)?;
        }
    }
    if version < 18 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),superagent_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL UNIQUE);
          CREATE TABLE IF NOT EXISTS team_revisions(team_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),request_id TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(team_id,revision),UNIQUE(team_id,request_id));
          CREATE TABLE IF NOT EXISTS team_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,team_id TEXT NOT NULL,body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS team_event_cursor ON team_events(team_id,seq);")?;
    }
    if version < 19 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS workflow_versions(id TEXT NOT NULL,version TEXT NOT NULL,hash TEXT NOT NULL,canonical TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
          CREATE TABLE IF NOT EXISTS workflow_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,workflow_id TEXT NOT NULL,body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS workflow_event_cursor ON workflow_events(workflow_id,seq);")?;
    }
    if version < 20 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS project_configs(id TEXT NOT NULL,version TEXT NOT NULL,canonical TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
          CREATE TABLE IF NOT EXISTS project_config_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,config_id TEXT NOT NULL,body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS project_config_event_cursor ON project_config_events(config_id,seq);")?;
    }
    if version < 21 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS work_runs(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,request_id TEXT NOT NULL,request TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,initial_body TEXT NOT NULL,UNIQUE(team_id,request_id));
          CREATE INDEX IF NOT EXISTS work_run_team ON work_runs(team_id,id);
          CREATE TABLE IF NOT EXISTS work_run_commands(run_id TEXT NOT NULL,request_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,request_id));
          CREATE TABLE IF NOT EXISTS work_run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS work_run_event_cursor ON work_run_events(run_id,seq);")?;
    }
    if version < 22 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS work_assignments(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,stage_id TEXT NOT NULL,stage_attempt INTEGER NOT NULL,team_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(run_id,stage_id,stage_attempt));
            CREATE INDEX IF NOT EXISTS work_assignment_capacity ON work_assignments(team_id,state);
            CREATE INDEX IF NOT EXISTS work_assignment_run ON work_assignments(run_id,state);
            CREATE TABLE IF NOT EXISTS work_dispatch_outbox(assignment_id TEXT PRIMARY KEY,state TEXT NOT NULL,body TEXT NOT NULL);")?;
    }
    if version < 23 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS assignment_account_capacities(account_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,capacity INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS assignment_resource_holds(assignment_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,host TEXT NOT NULL,root TEXT NOT NULL,state TEXT NOT NULL,request TEXT NOT NULL,receipt TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS assignment_account_holds ON assignment_resource_holds(account_id,state);
            CREATE INDEX IF NOT EXISTS assignment_workspace_holds ON assignment_resource_holds(host,state);")?;
    }
    if version < 24 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS artifact_archives(sequence INTEGER PRIMARY KEY,hash TEXT NOT NULL,bytes INTEGER NOT NULL,complete INTEGER NOT NULL CHECK(complete IN (0,1)));
            CREATE TABLE IF NOT EXISTS artifact_archive_chunks(sequence INTEGER NOT NULL,idx INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(sequence,idx));")?;
    }
    if version < 25 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS builder_draft_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),request_id TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,revision),UNIQUE(id,request_id));")?;
    }
    if version < 26 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS conversation_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,team_id TEXT NOT NULL,actor TEXT NOT NULL,request_id TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(conversation_id,actor,request_id));
            CREATE INDEX IF NOT EXISTS conversation_message_page ON conversation_messages(conversation_id,sequence);")?;
    }
    if version < 27 {
        tx.execute_batch("CREATE INDEX IF NOT EXISTS conversation_reply_trace ON conversation_messages(conversation_id,json_extract(body,'$.in_reply_to'),sequence);")?;
    }
    if version < 28 {
        tx.execute_batch(super::assignment_exclusive_resources::SCHEMA)?;
    }
    if version < 29 {
        let held: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM assignment_exclusive_holds WHERE state='held')",[],|row|row.get(0))?;
        if held { bail!("active exclusive resources require confirmed release before global-scope upgrade") }
        tx.execute_batch(super::assignment_exclusive_resources::GLOBAL_INDEX)?;
    }
    tx.pragma_update(None, "user_version", VERSION)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::store::Store;
    #[test]
    fn v25_conversation_upgrade_preserves_builder_drafts_and_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store.db.lock().execute_batch("INSERT INTO builder_draft_revisions VALUES ('fixture',1,'create','{}','{\"retained\":true}'); DROP TABLE conversation_messages; PRAGMA user_version=25;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.builder_draft("fixture").unwrap().unwrap()["retained"],
            true
        );
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains("pre-v25-"))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 25);
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='conversation_messages'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            backup
                .query_row("SELECT COUNT(*) FROM builder_draft_revisions", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn v24_builder_upgrade_preserves_documents_and_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store
            .db
            .lock()
            .execute_batch("DROP TABLE builder_draft_revisions; PRAGMA user_version=24;")
            .unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert!(store.builder_draft("fixture").unwrap().is_none());
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v24-"))
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = Connection::open(&backups()[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 24);
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='builder_draft_revisions'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        drop(store);
        let _reopened = Store::open(&path, "local").unwrap();
        assert_eq!(backups().len(), 1);
    }
    #[test]
    fn v23_archive_upgrade_preserves_documents_and_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store.db.lock().execute_batch("DROP TABLE artifact_archive_chunks; DROP TABLE artifact_archives; PRAGMA user_version=23;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        assert_eq!(
            store
                .db
                .lock()
                .query_row("SELECT COUNT(*) FROM artifact_archives", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|p| p.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v23-"))
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = Connection::open(&backups()[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 23);
        drop(backup);
        drop(store);
        let _store = Store::open(&path, "local").unwrap();
        assert_eq!(backups().len(), 1);
    }
    #[test]
    fn v22_assignment_resource_upgrade_preserves_documents_and_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store.db.lock().execute_batch("DROP TABLE assignment_resource_holds; DROP TABLE assignment_account_capacities; PRAGMA user_version=22;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert!(store.assignment_capacity("fixture").unwrap().is_none());
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v22-"))
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = Connection::open(&backups()[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 22);
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='assignment_resource_holds'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        drop(store);
        let _reopened = Store::open(&path, "local").unwrap();
        assert_eq!(backups().len(), 1);
    }
    #[test]
    fn v21_assignment_upgrade_preserves_documents_and_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store.db.lock().execute_batch("DROP TABLE work_dispatch_outbox; DROP TABLE work_assignments; PRAGMA user_version=21;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert!(store.work_assignment("fixture").unwrap().is_none());
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v21-"))
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = Connection::open(&backups()[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 21);
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='work_assignments'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        drop(store);
        let _reopened = Store::open(&path, "local").unwrap();
        assert_eq!(backups().len(), 1);
    }
    #[test]
    fn v20_work_run_upgrade_preserves_documents_and_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store.db.lock().execute_batch("DROP TABLE work_run_events; DROP TABLE work_run_commands; DROP TABLE work_runs; PRAGMA user_version=20;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert!(store.work_run("fixture").unwrap().is_none());
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v20-"))
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = Connection::open(&backups()[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 20);
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='work_runs'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        drop(store);
        let _reopened = Store::open(&path, "local").unwrap();
        assert_eq!(backups().len(), 1);
    }
    #[test]
    fn v19_project_upgrade_retains_existing_documents() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store.db.lock().execute_batch("DROP TABLE project_config_events; DROP TABLE project_configs; PRAGMA user_version=19;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert!(store.project_config("fixture", "1").unwrap().is_none());
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v19-"))
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = Connection::open(&backups()[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 19);
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='project_configs'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        drop(store);
        let _reopened = Store::open(&path, "local").unwrap();
        assert_eq!(backups().len(), 1);
    }
    #[test]
    fn v18_workflow_upgrade_retains_existing_documents() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store
            .db
            .lock()
            .execute_batch(
                "DROP TABLE workflow_events; DROP TABLE workflow_versions; PRAGMA user_version=18;",
            )
            .unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert!(store.workflow("fixture", "1").unwrap().is_none());
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains("pre-v18-"))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            Connection::open(&backups[0])
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            18
        );
    }
    #[test]
    fn v17_team_upgrade_preserves_documents_and_creates_no_teams() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .save_document("fixture", 0, serde_json::json!({"retained":true}))
            .unwrap();
        store.db.lock().execute_batch("DROP TABLE team_events; DROP TABLE team_revisions; DROP TABLE teams; PRAGMA user_version=17;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.document("fixture").unwrap()["value"]["retained"],
            true
        );
        assert_eq!(
            store
                .teams(super::super::teams::Page {
                    after: String::new(),
                    limit: None
                })
                .unwrap()["items"],
            serde_json::json!([])
        );
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains("pre-v17-"))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            Connection::open(&backups[0])
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            17
        );
    }
    #[test]
    fn wal_upgrade_has_private_consistent_backup_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("messages.sqlite");
        let old = Connection::open(&path).unwrap();
        old.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE identity(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO identity VALUES ('node_id','local'); CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message TEXT NOT NULL); INSERT INTO events(message) VALUES ('{\"id\":\"legacy\",\"status\":\"accepted\"}');").unwrap();
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v0-"))
                .collect::<Vec<_>>()
        };
        let files = backups();
        assert_eq!(files.len(), 1);
        let backup = Connection::open(&files[0]).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            backup
                .query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            1
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&files[0]).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(backup);
        drop(store);
        drop(old);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            backups().len(),
            1,
            "current schema must not create repeated backups"
        );
        assert_eq!(
            store
                .db
                .lock()
                .query_row("SELECT COUNT(*) FROM lifecycle_events", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn v13_event_index_upgrade_preserves_history_cursors_and_backup() {
        use crate::messaging::model::{Address, Message, Status};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("events.sqlite");
        let store = Store::open(&path, "local").unwrap();
        store
            .insert(Message {
                id: "historical".into(),
                source: Address {
                    node_id: "peer".into(),
                    session_id: "sender".into(),
                },
                target: Address {
                    node_id: "local".into(),
                    session_id: "worker".into(),
                },
                content: "retained".into(),
                idempotency_key: "one".into(),
                in_reply_to: None,
                hop_count: 0,
                created_at: 1,
                expires_at: 2,
                status: Status::Accepted,
                detail: None,
            })
            .unwrap();
        let before = serde_json::to_value(store.events(0, Some("worker")).unwrap()).unwrap();
        store.db.lock().execute_batch("DROP INDEX event_source_cursor; DROP INDEX event_target_cursor; PRAGMA user_version=13;").unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            serde_json::to_value(store.events(0, Some("worker")).unwrap()).unwrap(),
            before
        );
        assert!(store.events(1, Some("worker")).unwrap().is_empty());
        assert_eq!(preflight(&store.db.lock(), "local").unwrap(), VERSION);
        let backups = || {
            std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v13-"))
                .collect::<Vec<_>>()
        };
        assert_eq!(backups().len(), 1);
        let backup = Connection::open(&backups()[0]).unwrap();
        assert_eq!(preflight(&backup, "local").unwrap(), 13);
        assert_eq!(
            backup
                .query_row("SELECT COUNT(*) FROM events", [], |row| row
                    .get::<_, u64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='event_source_cursor'",
                    [],
                    |row| row.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        drop(store);
        let _store = Store::open(&path, "local").unwrap();
        assert_eq!(backups().len(), 1);
    }

    #[test]
    fn failed_upgrade_rolls_back_ddl_import_and_version() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message TEXT NOT NULL); INSERT INTO events(message) VALUES ('malformed-json');").unwrap();
        assert!(migrate(&db, "local").is_err());
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert_eq!(db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='runtime_deliveries'", [], |r|r.get::<_,u64>(0)).unwrap(), 0);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn preversioned_lifecycle_rows_are_historical_but_new_events_are_not() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(BASE_SCHEMA).unwrap();
        db.execute_batch("CREATE TABLE lifecycle_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,source_key TEXT NOT NULL,message_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(kind,source_key)); INSERT INTO lifecycle_events(kind,source_key,message_id,body) VALUES ('message','1','legacy','{}'); INSERT INTO identity VALUES ('lifecycle_v1_imported','1');").unwrap();
        migrate(&db, "local").unwrap();
        db.execute(
            "INSERT INTO input_cancellation_events(message_id,body) VALUES ('new','{}')",
            [],
        )
        .unwrap();
        let flags = db
            .prepare("SELECT historical FROM lifecycle_events ORDER BY seq")
            .unwrap()
            .query_map([], |r| r.get::<_, bool>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(flags, [true, false]);
    }

    #[test]
    fn future_schema_and_foreign_identity_are_rejected_before_upgrade() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA user_version=99; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('unchanged');").unwrap();
        assert!(migrate(&db, "local")
            .unwrap_err()
            .to_string()
            .contains("newer"));
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            99
        );
        db.execute_batch("PRAGMA user_version=0; CREATE TABLE identity(key TEXT PRIMARY KEY,value TEXT); INSERT INTO identity VALUES ('node_id','other');").unwrap();
        assert!(migrate(&db, "local")
            .unwrap_err()
            .to_string()
            .contains("different node"));
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='messages'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            0
        );
    }
}
