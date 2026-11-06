//! Home resource derivation: derive locks from frozen trusted command references, never model arguments.
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::BTreeSet;

pub(super) fn names(run: &Value, assignment: &Value) -> Result<Vec<String>> {
    let binding = &run["context"]["binding"];
    let pack = &binding["workflow"]["pack"];
    let project = &binding["project"]["config"]["spec"];
    let stages = pack["stages"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing frozen stages"))?;
    let stage = stages
        .iter()
        .find(|stage| stage["id"] == assignment["stage_id"])
        .ok_or_else(|| anyhow::anyhow!("missing frozen resource stage"))?;
    let outputs = stage["produces"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid frozen outputs"))?;
    let mut result = BTreeSet::new();
    for output in outputs {
        let name = output
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid output identity"))?;
        let rule = &pack["evidence_rules"][name];
        if rule["kind"] != "verification" {
            continue;
        }
        let key = rule["command_binding"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing command binding"))?;
        let command = &project["commands"][key];
        let Some(resources) = command.get("exclusive_resources") else {
            continue;
        };
        let resources = resources
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid command exclusive resources"))?;
        if resources.len() > 16 {
            bail!("too many command exclusive resources")
        }
        let mut distinct = BTreeSet::new();
        for resource in resources {
            let name = resource
                .as_str()
                .filter(|id| super::model::valid_id(id))
                .ok_or_else(|| anyhow::anyhow!("invalid exclusive resource identity"))?;
            if !distinct.insert(name) {
                bail!("duplicate exclusive resource identity")
            }
            result.insert(name.to_owned());
        }
        if !resources.is_empty() {
            let environment = command["environment_binding"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing resource command environment"))?;
            if project["environments"][environment]["host_id"] != assignment["worker"]["node_id"] {
                bail!("exclusive resource execution Host mismatch")
            }
        }
    }
    if result.len() > 16 {
        bail!("too many Assignment exclusive resources")
    }
    Ok(result.into_iter().collect())
}

pub(super) fn available(
    db: &Connection,
    assignment: &str,
    _host: &str,
    resources: &[String],
) -> Result<bool> {
    for resource in resources {
        let busy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM assignment_exclusive_holds WHERE resource_id=?1 AND state='held' AND assignment_id<>?2)",params![resource,assignment],|r|r.get(0))?;
        if busy {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Caller owns the same transaction as account/workspace admission; no partial reservations.
pub(super) fn reserve(
    db: &Connection,
    assignment: &str,
    host: &str,
    resources: &[String],
    at: u64,
) -> Result<()> {
    for resource in resources {
        db.execute("INSERT INTO assignment_exclusive_holds(assignment_id,host,resource_id,state,reserved_at) VALUES (?1,?2,?3,'held',?4)",params![assignment,host,resource,at])?;
    }
    Ok(())
}

pub(super) fn held_names(assignment: &Value) -> Result<Vec<String>> {
    let Some(value) = assignment["resources"].get("exclusive_resources") else {
        return Ok(Vec::new());
    };
    let names: Vec<String> = serde_json::from_value(value.clone())?;
    if names.len() > 16
        || names.iter().any(|id| !super::model::valid_id(id))
        || names.windows(2).any(|pair| pair[0] >= pair[1])
    {
        bail!("invalid held exclusive resource identities")
    }
    Ok(names)
}
pub(super) fn assert_held(db: &Connection, assignment: &Value) -> Result<()> {
    for resource in held_names(assignment)? {
        let held:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM assignment_exclusive_holds WHERE assignment_id=?1 AND host=?2 AND resource_id=?3 AND state='held')",params![assignment["id"].as_str(),assignment["resources"]["host"].as_str(),resource],|r|r.get(0))?;
        if !held {
            bail!("assignment exclusive resource hold unavailable")
        }
    }
    Ok(())
}

// v28 storage remains valid; v29 makes resource identity Home-wide.
pub(super) const GLOBAL_INDEX: &str = "DROP INDEX IF EXISTS assignment_exclusive_owner; CREATE UNIQUE INDEX assignment_exclusive_owner ON assignment_exclusive_holds(resource_id) WHERE state='held';";
pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS assignment_exclusive_holds(
 assignment_id TEXT NOT NULL REFERENCES assignment_resource_holds(assignment_id),
 host TEXT NOT NULL,resource_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('held','released')),
 reserved_at INTEGER NOT NULL CHECK(reserved_at>=0),
 PRIMARY KEY(assignment_id,resource_id));
CREATE UNIQUE INDEX IF NOT EXISTS assignment_exclusive_owner ON assignment_exclusive_holds(host,resource_id) WHERE state='held';
CREATE TRIGGER IF NOT EXISTS assignment_exclusive_release AFTER UPDATE OF state ON assignment_resource_holds WHEN NEW.state='released'
 BEGIN UPDATE assignment_exclusive_holds SET state='released' WHERE assignment_id=NEW.assignment_id AND state='held'; END;";

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE assignment_resource_holds(assignment_id TEXT PRIMARY KEY,state TEXT NOT NULL); INSERT INTO assignment_resource_holds VALUES ('a','held'),('b','held'),('c','held');").unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute_batch(GLOBAL_INDEX).unwrap();
        db
    }
    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn active_v28_holders_require_confirmed_release_before_global_upgrade() {
        use super::super::store::Store;
        for holders in [1, 2] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("ledger.sqlite");
            let store = Store::open(&path, "home").unwrap();
            {
                let db = store.db.lock();
                db.execute_batch("DROP INDEX assignment_exclusive_owner; CREATE UNIQUE INDEX assignment_exclusive_owner ON assignment_exclusive_holds(host,resource_id) WHERE state='held'; INSERT INTO assignment_resource_holds VALUES ('a','account','host-a','/fixture-a','held','{}','{}'),('b','account','host-b','/fixture-b','held','{}','{}'); PRAGMA user_version=28;").unwrap();
                reserve(&db, "a", "host-a", &ids(&["same-resource"]), 1).unwrap();
                if holders == 2 {
                    reserve(&db, "b", "host-b", &ids(&["same-resource"]), 1).unwrap();
                }
            }
            drop(store);
            let error = Store::open(&path, "home").err().unwrap();
            assert!(error.to_string().contains("confirmed release"));
            let db = Connection::open(&path).unwrap();
            assert_eq!(
                db.pragma_query_value(None, "user_version", |r| r.get::<_, u64>(0))
                    .unwrap(),
                28
            );
            assert_eq!(
                db.query_row(
                    "SELECT COUNT(*) FROM assignment_exclusive_holds WHERE state='held'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
                holders
            );
            let backups = std::fs::read_dir(root.path())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().contains("pre-v28-"))
                .collect::<Vec<_>>();
            assert_eq!(backups.len(), 1);
            let backup = Connection::open(&backups[0]).unwrap();
            assert_eq!(
                backup
                    .pragma_query_value(None, "user_version", |r| r.get::<_, u64>(0))
                    .unwrap(),
                28
            );
            assert_eq!(
                backup
                    .query_row(
                        "SELECT COUNT(*) FROM assignment_exclusive_holds WHERE state='held'",
                        [],
                        |r| r.get::<_, u64>(0)
                    )
                    .unwrap(),
                holders
            );
        }
    }
    #[test]
    fn v27_upgrade_preserves_held_resources_and_consistent_backup() {
        use super::super::store::Store;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.sqlite");
        let store = Store::open(&path, "home").unwrap();
        store.db.lock().execute_batch("DROP TRIGGER assignment_exclusive_release; DROP TABLE assignment_exclusive_holds; INSERT INTO assignment_resource_holds VALUES ('prior','account','home','/fixture','held','{}','{}'); PRAGMA user_version=27;").unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        let db = store.db.lock();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, u64>(0))
                .unwrap(),
            29
        );
        assert_eq!(
            db.query_row(
                "SELECT state FROM assignment_resource_holds WHERE assignment_id='prior'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "held"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM assignment_exclusive_holds", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            0
        );
        reserve(&db, "prior", "home", &ids(&["fixture-port"]), 10).unwrap();
        drop(db);
        drop(store);
        let backups = std::fs::read_dir(root.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains("pre-v27-"))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |r| r.get::<_, u64>(0))
                .unwrap(),
            27
        );
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM assignment_resource_holds WHERE assignment_id='prior'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            backup
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='assignment_exclusive_holds'",
                    [],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        let store = Store::open(&path, "home").unwrap();
        assert!(!available(
            &store.db.lock(),
            "successor",
            "home",
            &ids(&["fixture-port"])
        )
        .unwrap());
    }
    #[test]
    fn one_home_excludes_workers_across_hosts_until_confirmed_parent_release() {
        let db = database();
        reserve(&db, "a", "host", &ids(&["device"]), 1).unwrap();
        assert!(!available(&db, "b", "host", &ids(&["device"])).unwrap());
        assert!(!available(&db, "b", "other-host", &ids(&["device"])).unwrap());
        assert!(reserve(&db, "b", "other-host", &ids(&["device"]), 2).is_err());
        assert!(available(&db, "b", "other-host", &ids(&["different-device"])).unwrap());
        reserve(&db, "b", "other-host", &ids(&["different-device"]), 2).unwrap();
        db.execute(
            "UPDATE assignment_resource_holds SET state='stopping' WHERE assignment_id='a'",
            [],
        )
        .unwrap();
        assert!(
            !available(&db, "c", "host", &ids(&["device"])).unwrap(),
            "no lease-timeout or stop-request takeover"
        );
        db.execute(
            "UPDATE assignment_resource_holds SET state='released' WHERE assignment_id='a'",
            [],
        )
        .unwrap();
        assert!(available(&db, "c", "host", &ids(&["device"])).unwrap());
        reserve(&db, "c", "host", &ids(&["device"]), 3).unwrap();
        assert!(
            reserve(&db, "a", "host", &ids(&["device"]), 4).is_err(),
            "old assignment cannot revive its released lock"
        );
        assert!(!available(&db, "b", "other-host", &ids(&["device"])).unwrap());
    }
    #[test]
    fn conflicting_multi_resource_transaction_never_leaks_a_partial_hold() {
        let mut db = database();
        reserve(&db, "a", "host", &ids(&["z-device"]), 1).unwrap();
        {
            let tx = db.transaction().unwrap();
            assert!(reserve(&tx, "b", "host", &ids(&["a-port", "z-device"]), 2).is_err());
        }
        assert!(available(&db, "c", "host", &ids(&["a-port"])).unwrap());
        assert!(!available(&db, "c", "host", &ids(&["z-device"])).unwrap());
        assert!(reserve(&db, "missing-parent", "host", &ids(&["other"]), 2).is_err());
    }
}
