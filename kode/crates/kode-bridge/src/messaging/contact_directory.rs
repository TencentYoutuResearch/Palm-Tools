//! Owner contact preferences are independent from team configuration and execution authority.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Preference {
    pub revision: u64,
    pub pinned: bool,
    pub archived: bool,
    pub archived_through_sequence: u64,
    pub updated_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Pin,
    Unpin,
    Archive,
    Unarchive,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub request_id: String,
    pub expected_revision: u64,
    pub action: Action,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    #[serde(default)]
    pub after: String,
    pub limit: Option<usize>,
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    q: String,
    archived: bool,
    pinned: i64,
    attention: i64,
    unread: i64,
    activity: i64,
    id: String,
}

fn preference_key(team: &str) -> String {
    format!("contact-preference:{team}")
}

fn preference(db: &Connection, team: &str) -> Result<Preference> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [preference_key(team)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|body| Ok(serde_json::from_str(&body)?))
        .unwrap_or_else(|| Ok(Preference::default()))
}

impl Store {
    pub fn contact_preference_request(&self, team: &str, request: &str) -> Result<Value> {
        if !valid_id(team) || !valid_id(request) {
            bail!("invalid contact request identity")
        }
        let db = self.db.lock();
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM teams WHERE id=?1)",
            [team],
            |r| r.get(0),
        )?;
        if !exists {
            bail!("unknown contact")
        }
        let key = format!("contact-preference-receipt:{}", json!([team, request]));
        let saved: Option<String> = db
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        let saved: Option<Value> = saved.map(|v| serde_json::from_str(&v)).transpose()?;
        Ok(
            json!({"home_hub":self.node_id,"team_id":team,"principal_id":"local_owner","request_id":request,"receipt":saved,"preference":preference(&db,team)?}),
        )
    }
    pub fn contact_preference(&self, team: &str) -> Result<Value> {
        if !valid_id(team) {
            bail!("invalid contact identity")
        }
        let db = self.db.lock();
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM teams WHERE id=?1)",
            [team],
            |r| r.get(0),
        )?;
        if !exists {
            bail!("unknown contact")
        }
        Ok(
            json!({"home_hub":self.node_id,"team_id":team,"principal_id":"local_owner","preference":preference(&db, team)?}),
        )
    }

    pub fn change_contact_preference(&self, team: &str, input: Change) -> Result<Value> {
        if !valid_id(team)
            || !valid_id(&input.request_id)
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid contact preference change")
        }
        let request = serde_json::to_value(&input)?;
        let receipt_key = format!(
            "contact-preference-receipt:{}",
            json!([team, input.request_id])
        );
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&receipt_key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(saved) = saved {
            let saved: Value = serde_json::from_str(&saved)?;
            if saved["request"] != request {
                bail!("contact preference request identity conflict")
            }
            return Ok(saved["result"].clone());
        }
        let conversation: String = tx.query_row(
            "SELECT conversation_id FROM teams WHERE id=?1",
            [team],
            |r| r.get(0),
        )?;
        let mut value = preference(&tx, team)?;
        if value.revision != input.expected_revision {
            bail!("contact preference revision conflict")
        }
        match input.action {
            Action::Pin => value.pinned = true,
            Action::Unpin => value.pinned = false,
            Action::Unarchive => value.archived = false,
            Action::Archive => {
                value.archived = true;
                value.archived_through_sequence = tx.query_row(
                    "SELECT COALESCE(MAX(sequence),0) FROM conversation_messages WHERE conversation_id=?1",
                    [&conversation], |r| r.get(0),
                )?;
            }
        }
        value.revision += 1;
        value.updated_at = now();
        let result = json!({"home_hub":self.node_id,"team_id":team,"principal_id":"local_owner","preference":value});
        tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value",
            params![preference_key(team),value.revision,serde_json::to_string(&value)?])?;
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES(?1,1,?2)",
            params![
                receipt_key,
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES(?1,?2)", params![team,serde_json::to_string(&json!({"kind":"contact_preference_changed","actor":{"kind":"human","id":"local_owner"},"request_id":input.request_id,"action":input.action,"preference":value,"at":value.updated_at}))?])?;
        tx.commit()?;
        Ok(result)
    }

    pub fn contact_directory(&self, page: Page) -> Result<Value> {
        let limit = page.limit.unwrap_or(25);
        let search = page.q.trim();
        if !(1..=50).contains(&limit)
            || page.q.len() > 160
            || page.q.contains('\0')
            || page.after.len() > 2048
        {
            bail!("invalid contact directory query")
        }
        let cursor = if page.after.is_empty() {
            None
        } else {
            let value: Cursor = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&page.after)?)?;
            if value.q != search
                || value.archived != page.archived
                || !valid_id(&value.id)
                || !(0..=1).contains(&value.pinned)
                || !(0..=2).contains(&value.attention)
                || !(0..=1).contains(&value.unread)
                || value.activity < 0
            {
                bail!("contact directory cursor scope changed")
            }
            Some(value)
        };
        let db = self.db.lock();
        let sql = "WITH facts AS (
            SELECT t.id,r.body,
              COALESCE(p.value,'{}') AS preference,
              COALESCE(json_extract(p.value,'$.pinned'),0) AS pinned,
              COALESCE((SELECT MAX(m.sequence) FROM conversation_messages m WHERE m.conversation_id=t.conversation_id),0) AS latest,
              COALESCE((SELECT MAX(CAST(json_extract(m.body,'$.created_at') AS INTEGER)) FROM conversation_messages m WHERE m.conversation_id=t.conversation_id),CAST(json_extract(r.body,'$.updated_at') AS INTEGER),0) AS activity,
              (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id=t.conversation_id AND m.actor!='human:local_owner' AND m.sequence>COALESCE((SELECT json_extract(value,'$.through_sequence') FROM workbench_documents WHERE key='conversation-read:'||json_array(t.conversation_id,'local_owner')),0)) AS unread_count,
              (SELECT COUNT(*) FROM work_runs w WHERE w.team_id=t.id AND w.state IN ('waiting_user','paused')) AS decisions,
              (SELECT COUNT(*) FROM work_runs w WHERE w.team_id=t.id AND w.state='waiting_resource') AS resources,
              (SELECT COUNT(*) FROM work_runs w WHERE w.team_id=t.id AND w.state IN ('cancelling','cancel_unconfirmed','taking_over')) AS stopping,
              (SELECT COUNT(*) FROM work_runs w WHERE w.team_id=t.id AND w.state NOT IN ('completed','failed','cancelled')) AS active_runs
            FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision
            LEFT JOIN workbench_documents p ON p.key='contact-preference:'||t.id
            WHERE (?1='' OR instr(lower(json_extract(r.body,'$.spec.name')),lower(?1))>0 OR instr(lower(json_extract(r.body,'$.spec.purpose')),lower(?1))>0)
          ), ranked AS (
            SELECT *,CASE WHEN decisions>0 THEN 2 WHEN resources>0 OR stopping>0 THEN 1 ELSE 0 END AS attention,
              CASE WHEN unread_count>0 THEN 1 ELSE 0 END AS unread,
              CASE WHEN COALESCE(json_extract(preference,'$.archived'),0)=1 AND latest<=COALESCE(json_extract(preference,'$.archived_through_sequence'),0) AND active_runs=0 THEN 1 ELSE 0 END AS archived
            FROM facts
          ) SELECT body,preference,pinned,attention,unread,activity,id,latest,unread_count,decisions,resources,stopping,active_runs,archived
          FROM ranked WHERE archived=?2 AND (?3=0 OR (-pinned,-attention,-unread,-activity,id)>(?4,?5,?6,?7,?8))
          ORDER BY pinned DESC,attention DESC,unread DESC,activity DESC,id ASC LIMIT ?9";
        let mut query = db.prepare(sql)?;
        let mut rows = query.query(params![
            search,
            page.archived,
            cursor.is_some(),
            cursor.as_ref().map(|v| -v.pinned).unwrap_or(0),
            cursor.as_ref().map(|v| -v.attention).unwrap_or(0),
            cursor.as_ref().map(|v| -v.unread).unwrap_or(0),
            cursor.as_ref().map(|v| -v.activity).unwrap_or(0),
            cursor.as_ref().map(|v| v.id.as_str()).unwrap_or(""),
            limit + 1
        ])?;
        let mut items = Vec::new();
        let mut last = None;
        let mut more = false;
        while let Some(row) = rows.next()? {
            if items.len() == limit {
                more = true;
                break;
            }
            let mut team: Value = serde_json::from_str(&row.get::<_, String>(0)?)?;
            let stored = row.get::<_, String>(1)?;
            let pref: Preference = if stored == "{}" {
                Preference::default()
            } else {
                serde_json::from_str(&stored)?
            };
            let attention: i64 = row.get(3)?;
            team["contact"] = json!({"preference":pref,"archived":row.get::<_,bool>(13)?,"latest_sequence":row.get::<_,u64>(7)?,"unread_count":row.get::<_,u64>(8)?,"last_activity_at":row.get::<_,u64>(5)?,"attention":{"decisions":row.get::<_,u64>(9)?,"resources":row.get::<_,u64>(10)?,"stopping":row.get::<_,u64>(11)?,"active_runs":row.get::<_,u64>(12)?},"needs_attention":attention>0});
            last = Some(Cursor {
                q: search.to_owned(),
                archived: page.archived,
                pinned: row.get(2)?,
                attention,
                unread: row.get(4)?,
                activity: row.get(5)?,
                id: row.get(6)?,
            });
            items.push(team);
        }
        let next = if more {
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&last.unwrap())?))
        } else {
            None
        };
        Ok(
            json!({"home_hub":self.node_id,"items":items,"next_cursor":next,"projection":"contact_directory","archived":page.archived,"order":"pinned_attention_unread_recent"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(store: &Store, id: &str, at: u64) -> Value {
        let body = json!({"id":id,"home_hub":"home","superagent_id":format!("super-{id}"),"conversation_id":format!("conversation-{id}"),"spec":{"name":id,"purpose":"Project"},"updated_at":at});
        let db = store.db.lock();
        db.execute(
            "INSERT INTO teams VALUES(?1,1,?2,?3)",
            params![
                id,
                body["superagent_id"].as_str(),
                body["conversation_id"].as_str()
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO team_revisions VALUES(?1,1,'create','{}',?2)",
            params![id, serde_json::to_string(&body).unwrap()],
        )
        .unwrap();
        body
    }

    fn change(store: &Store, team: &str, revision: u64, action: Action) -> Result<Value> {
        store.change_contact_preference(
            team,
            Change {
                request_id: format!("change-{revision}"),
                expected_revision: revision,
                action,
            },
        )
    }

    fn message(store: &Store, team: &str, id: &str, at: u64) {
        store.db.lock().execute("INSERT INTO conversation_messages(id,conversation_id,team_id,actor,request_id,request,body) VALUES(?1,?2,?3,'superagent',?1,'{}',?4)",params![id,format!("conversation-{team}"),team,serde_json::to_string(&json!({"created_at":at})).unwrap()]).unwrap();
    }

    #[test]
    fn preferences_are_exact_durable_and_do_not_mutate_team_or_execution() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("contacts.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let original = seed(&store, "team", 1);
        message(&store, "team", "first", 2);
        let archived = change(&store, "team", 0, Action::Archive).unwrap();
        assert_eq!(
            store
                .contact_preference_request("team", "change-0")
                .unwrap()["receipt"]["result"],
            archived
        );
        assert!(store.contact_preference_request("team", "missing").unwrap()["receipt"].is_null());
        assert_eq!(
            change(&store, "team", 0, Action::Archive).unwrap(),
            archived
        );
        assert!(change(&store, "team", 0, Action::Pin).is_err());
        assert!(store.contact_preference("foreign").is_err());
        assert!(store.contact_directory(Page::default()).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        let hidden = store
            .contact_directory(Page {
                archived: true,
                ..Page::default()
            })
            .unwrap();
        assert_eq!(
            hidden["items"][0]["contact"]["preference"]["archived_through_sequence"],
            1
        );
        message(&store, "team", "second", 3);
        let visible = store.contact_directory(Page::default()).unwrap();
        assert_eq!(visible["items"][0]["id"], "team");
        assert_eq!(visible["items"][0]["contact"]["archived"], false);
        let mut unchanged = visible["items"][0].clone();
        unchanged.as_object_mut().unwrap().remove("contact");
        assert_eq!(unchanged, original);
        assert_eq!(
            store
                .db
                .lock()
                .query_row("SELECT COUNT(*) FROM operations", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        drop(store);
        let reopened = Store::open(&path, "home").unwrap();
        assert_eq!(reopened.contact_preference("team").unwrap(), archived);
        assert_eq!(
            change(&reopened, "team", 0, Action::Archive).unwrap(),
            archived
        );
        assert_eq!(
            change(&reopened, "team", 1, Action::Unarchive).unwrap()["preference"]["archived"],
            false
        );
    }

    #[test]
    fn ranked_cursor_pages_include_pins_attention_unread_and_recent_across_all_teams() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("rank.sqlite"), "home").unwrap();
        for (id, at) in [
            ("z-pin", 1),
            ("y-decision", 2),
            ("x-resource", 3),
            ("w-unread", 4),
            ("a-recent", 20),
            ("b-old", 10),
        ] {
            seed(&store, id, at);
        }
        change(&store, "z-pin", 0, Action::Pin).unwrap();
        {
            let db = store.db.lock();
            for (id, state) in [
                ("y-decision", "waiting_user"),
                ("x-resource", "waiting_resource"),
            ] {
                db.execute(
                    "INSERT INTO work_runs VALUES(?1,?2,?1,'{}',1,?3,'{}','{}')",
                    params![format!("run-{id}"), id, state],
                )
                .unwrap();
            }
        }
        message(&store, "w-unread", "unread", 4);
        change(&store, "y-decision", 0, Action::Archive).unwrap();
        let mut after = String::new();
        let mut ids = Vec::new();
        loop {
            let page = store
                .contact_directory(Page {
                    after: after.clone(),
                    limit: Some(2),
                    ..Page::default()
                })
                .unwrap();
            ids.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v["id"].as_str().unwrap().to_owned()),
            );
            let Some(next) = page["next_cursor"].as_str() else {
                break;
            };
            assert!(store
                .contact_directory(Page {
                    after: next.to_owned(),
                    q: "different".into(),
                    ..Page::default()
                })
                .is_err());
            assert!(store
                .contact_directory(Page {
                    after: next.to_owned(),
                    archived: true,
                    ..Page::default()
                })
                .is_err());
            after = next.to_owned();
        }
        assert_eq!(
            ids,
            [
                "z-pin",
                "y-decision",
                "x-resource",
                "w-unread",
                "a-recent",
                "b-old"
            ]
        );
        assert_eq!(
            store
                .contact_directory(Page {
                    q: "z-pin".into(),
                    ..Page::default()
                })
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn concurrent_owner_changes_preserve_one_revision_and_recover_original_receipt() {
        let root = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(
            Store::open(&root.path().join("concurrent.sqlite"), "home").unwrap(),
        );
        seed(&store, "team", 1);
        let tasks = [Action::Pin, Action::Archive]
            .into_iter()
            .enumerate()
            .map(|(index, action)| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store.change_contact_preference(
                        "team",
                        Change {
                            request_id: format!("request-{index}"),
                            expected_revision: 0,
                            action,
                        },
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = tasks
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            store.contact_preference("team").unwrap()["preference"]["revision"],
            1
        );
    }
}
