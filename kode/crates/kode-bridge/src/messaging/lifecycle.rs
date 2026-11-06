//! Local commit-ordered audit projection, separate from legacy message cursors.
use super::store::Store;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

#[cfg(test)]
pub(super) fn initialize(db: &Connection) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    initialize_in(&tx)?;
    tx.commit()?;
    Ok(())
}
pub(super) fn initialize_in(tx: &Connection) -> Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS lifecycle_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source_key TEXT NOT NULL,
      message_id TEXT NOT NULL, body TEXT NOT NULL, historical INTEGER NOT NULL DEFAULT 0, UNIQUE(kind,source_key));
      CREATE INDEX IF NOT EXISTS lifecycle_message ON lifecycle_events(message_id,seq);
      CREATE TRIGGER IF NOT EXISTS lifecycle_message_insert AFTER INSERT ON events BEGIN
        INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body) VALUES ('message',CAST(NEW.seq AS TEXT),json_extract(NEW.message,'$.id'),json_object('message_id',json_extract(NEW.message,'$.id'),'status',json_extract(NEW.message,'$.status'),'detail',json_extract(NEW.message,'$.detail')));
      END;
      CREATE TRIGGER IF NOT EXISTS lifecycle_delivery_insert AFTER INSERT ON runtime_delivery_events BEGIN
        INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body) VALUES ('delivery',CAST(NEW.seq AS TEXT),NEW.message_id,NEW.body);
      END;
      CREATE TRIGGER IF NOT EXISTS lifecycle_mirror_insert AFTER INSERT ON delivery_mirror_events BEGIN
        INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body) VALUES ('remote_delivery',json_array(NEW.peer,NEW.seq),json_extract(NEW.body,'$.message_id'),json_object('peer',NEW.peer,'observation',json(NEW.body)));
      END;
      CREATE TRIGGER IF NOT EXISTS lifecycle_cancellation_insert AFTER INSERT ON input_cancellation_events BEGIN
        INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body) VALUES ('cancellation',CAST(NEW.seq AS TEXT),NEW.message_id,NEW.body);
      END;")?;
    let imported: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM identity WHERE key='lifecycle_v1_imported')",
        [],
        |r| r.get(0),
    )?;
    if !imported {
        // Historical tables have independent clocks. Bootstrap order is stable,
        // but not evidence of cross-table chronology before this projection.
        tx.execute_batch("INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body,historical)
          SELECT 'message',CAST(seq AS TEXT),json_extract(message,'$.id'),json_object('message_id',json_extract(message,'$.id'),'status',json_extract(message,'$.status'),'detail',json_extract(message,'$.detail')),1 FROM events ORDER BY seq;
          INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body,historical) SELECT 'delivery',CAST(seq AS TEXT),message_id,body,1 FROM runtime_delivery_events ORDER BY seq;
          INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body,historical) SELECT 'remote_delivery',json_array(peer,seq),json_extract(body,'$.message_id'),json_object('peer',peer,'observation',json(body)),1 FROM delivery_mirror_events ORDER BY peer,seq;
          INSERT OR IGNORE INTO lifecycle_events(kind,source_key,message_id,body,historical) SELECT 'cancellation',CAST(seq AS TEXT),message_id,body,1 FROM input_cancellation_events ORDER BY seq;
          INSERT INTO identity(key,value) VALUES ('lifecycle_v1_imported','1');")?;
    }
    Ok(())
}
// Start with indexed participants, then seek each message's audit cursor.
// UNION prevents a self-addressed event from appearing twice.
pub(super) const SESSION_QUERY: &str = "SELECT e.seq,e.kind,e.message_id,e.body,e.historical FROM messages m CROSS JOIN lifecycle_events e INDEXED BY lifecycle_message ON e.message_id=m.id WHERE m.source_node=?3 AND m.source_session=?2 AND e.seq>?1
UNION
SELECT e.seq,e.kind,e.message_id,e.body,e.historical FROM messages m CROSS JOIN lifecycle_events e INDEXED BY lifecycle_message ON e.message_id=m.id WHERE m.target_node=?3 AND m.target_session=?2 AND e.seq>?1
ORDER BY seq LIMIT 100";
#[derive(Serialize)]
pub struct Event {
    pub seq: u64,
    pub kind: String,
    pub message_id: String,
    pub data: serde_json::Value,
    pub historical: bool,
}
impl Store {
    pub fn lifecycle_events(&self, after: u64, session: Option<&str>) -> Result<Vec<Event>> {
        let db = self.db.lock();
        let mut q = db.prepare(if session.is_some() { SESSION_QUERY } else { "SELECT e.seq,e.kind,e.message_id,e.body,e.historical FROM lifecycle_events e JOIN messages m ON m.id=e.message_id WHERE e.seq>?1 ORDER BY e.seq LIMIT 100" })?;
        let mut rows = if let Some(session) = session {
            q.query(params![after, session, self.node_id])?
        } else {
            q.query([after])?
        };
        let mut events = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let (seq, kind, message_id, body, historical): (u64, String, String, String, bool) = (
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            );
            let event = Event {
                seq,
                kind,
                message_id,
                data: serde_json::from_str(&body)?,
                historical,
            };
            let size = serde_json::to_vec(&event)?.len();
            if !events.is_empty() && bytes + size > 32768 {
                break;
            }
            bytes += size;
            events.push(event);
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_import_is_idempotent_and_projection_shares_source_transaction() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE identity(key TEXT PRIMARY KEY,value TEXT);
          CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message TEXT);
          CREATE TABLE runtime_delivery_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT,body TEXT);
          CREATE TABLE delivery_mirror_events(peer TEXT,seq INTEGER,body TEXT);
          CREATE TABLE input_cancellation_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT,body TEXT);
          INSERT INTO events(message) VALUES ('{\"id\":\"old\",\"status\":\"accepted\",\"content\":\"private full body\"}');
          INSERT INTO runtime_delivery_events(message_id,body) VALUES ('old','{\"message_id\":\"old\",\"phase\":\"consumed\"}');").unwrap();
        initialize(&db).unwrap();
        initialize(&db).unwrap();
        let count = || {
            db.query_row("SELECT COUNT(*) FROM lifecycle_events", [], |r| {
                r.get::<_, u64>(0)
            })
            .unwrap()
        };
        assert_eq!(count(), 2);
        let message_body: String = db
            .query_row(
                "SELECT body FROM lifecycle_events WHERE kind='message'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!message_body.contains("private full body"));
        {
            let tx = db.unchecked_transaction().unwrap();
            tx.execute("INSERT INTO input_cancellation_events(message_id,body) VALUES ('old','{\"state\":\"requested\"}')", []).unwrap();
            tx.rollback().unwrap();
        }
        assert_eq!(
            count(),
            2,
            "rolled-back observations cannot escape into the audit"
        );
        db.execute("INSERT INTO input_cancellation_events(message_id,body) VALUES ('old','{\"state\":\"requested\"}')", []).unwrap();
        assert_eq!(count(), 3);
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM lifecycle_events WHERE historical=1",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            2
        );
        initialize(&db).unwrap();
        assert_eq!(count(), 3);
    }
}
