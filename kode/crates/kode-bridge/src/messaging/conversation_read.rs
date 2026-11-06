//! User read position is independent of runtime delivery/consumption and execution.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkRead {
    pub through_sequence: u64,
}
fn key(id: &str) -> String {
    format!("conversation-read:{}", json!([id, "local_owner"]))
}
fn position(db: &Connection, id: &str) -> Result<u64> {
    Ok(db
        .query_row(
            "SELECT json_extract(value,'$.through_sequence') FROM workbench_documents WHERE key=?1",
            [key(id)],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}
fn state(db: &Connection, home: &str, id: &str) -> Result<Value> {
    if !valid_id(id) {
        bail!("invalid conversation identity")
    }
    let team: String =
        db.query_row("SELECT id FROM teams WHERE conversation_id=?1", [id], |r| {
            r.get(0)
        })?;
    let through = position(db, id)?;
    let latest: u64 = db.query_row(
        "SELECT COALESCE(MAX(sequence),0) FROM conversation_messages WHERE conversation_id=?1",
        [id],
        |r| r.get(0),
    )?;
    let unread: u64 = db.query_row("SELECT COUNT(*) FROM conversation_messages WHERE conversation_id=?1 AND sequence>?2 AND actor!='human:local_owner'", params![id,through], |r| r.get(0))?;
    Ok(
        json!({"home_hub":home,"team_id":team,"conversation_id":id,"principal_id":"local_owner","through_sequence":through,"latest_sequence":latest,"unread_count":unread}),
    )
}
impl Store {
    pub fn conversation_read_state(&self, id: &str) -> Result<Value> {
        state(&self.db.lock(), &self.node_id, id)
    }
    pub fn mark_conversation_read(&self, id: &str, input: MarkRead) -> Result<Value> {
        if input.through_sequence > i64::MAX as u64 {
            bail!("invalid read sequence")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let before = state(&tx, &self.node_id, id)?;
        if input.through_sequence != 0 && !tx.query_row("SELECT EXISTS(SELECT 1 FROM conversation_messages WHERE conversation_id=?1 AND sequence=?2)", params![id,input.through_sequence], |r| r.get::<_,bool>(0))? {
            bail!("read sequence is not in this conversation")
        }
        if input.through_sequence > before["through_sequence"].as_u64().unwrap() {
            let value = json!({"through_sequence":input.through_sequence,"principal_id":"local_owner","at":now()});
            tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES(?1,1,?2) ON CONFLICT(key) DO UPDATE SET revision=revision+1,value=excluded.value", params![key(id),serde_json::to_string(&value)?])?;
            tx.execute("INSERT INTO team_events(team_id,body) VALUES(?1,?2)", params![before["team_id"].as_str(),serde_json::to_string(&json!({"kind":"conversation_read_advanced","conversation_id":id,"principal_id":"local_owner","through_sequence":input.through_sequence,"at":now()}))?])?;
        }
        let result = state(&tx, &self.node_id, id)?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_cursor_is_monotonic_and_counts_only_incoming_visible_messages() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("read.sqlite"), "home").unwrap();
        {
            let db = store.db.lock();
            db.execute(
                "INSERT INTO teams VALUES('team',1,'super','conversation')",
                [],
            )
            .unwrap();
            for (seq, conversation, actor) in [
                (1, "conversation", "human:local_owner"),
                (2, "conversation", "superagent"),
                (3, "other", "superagent"),
                (4, "conversation", "system"),
            ] {
                db.execute("INSERT INTO conversation_messages(sequence,id,conversation_id,team_id,actor,request_id,request,body) VALUES(?1,?2,?3,'team',?4,?2,'{}','{}')",params![seq,format!("message-{seq}"),conversation,actor]).unwrap();
            }
        }
        assert_eq!(
            store.conversation_read_state("conversation").unwrap()["unread_count"],
            2
        );
        assert!(store
            .mark_conversation_read(
                "conversation",
                MarkRead {
                    through_sequence: 3
                }
            )
            .is_err());
        assert!(store
            .mark_conversation_read(
                "conversation",
                MarkRead {
                    through_sequence: 5
                }
            )
            .is_err());
        let marked = store
            .mark_conversation_read(
                "conversation",
                MarkRead {
                    through_sequence: 2,
                },
            )
            .unwrap();
        assert_eq!(marked["unread_count"], 1);
        assert_eq!(
            store
                .mark_conversation_read(
                    "conversation",
                    MarkRead {
                        through_sequence: 1
                    }
                )
                .unwrap(),
            marked
        );
        assert_eq!(
            store
                .mark_conversation_read(
                    "conversation",
                    MarkRead {
                        through_sequence: 2
                    }
                )
                .unwrap(),
            marked
        );
        assert_eq!(
            store
                .db
                .lock()
                .query_row("SELECT COUNT(*) FROM team_events", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            1
        );
        drop(store);
        let store = Store::open(&root.path().join("read.sqlite"), "home").unwrap();
        assert_eq!(
            store.conversation_read_state("conversation").unwrap(),
            marked
        );
        assert_eq!(
            store
                .mark_conversation_read(
                    "conversation",
                    MarkRead {
                        through_sequence: 4
                    }
                )
                .unwrap()["unread_count"],
            0
        );
    }
}
