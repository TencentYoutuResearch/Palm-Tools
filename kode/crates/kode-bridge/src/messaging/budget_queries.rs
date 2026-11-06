//! Owner recovery and bounded accounting evidence. Queries never reserve, settle or release funds.
use super::{budgets::Reservation, store::Store};
use anyhow::Result;
use rusqlite::{params, OptionalExtension};
impl Store {
    pub fn budget_reservation(&self, id: &str) -> Result<Option<serde_json::Value>> {
        let db = self.db.lock();
        let body: Option<String> = db
            .query_row(
                "SELECT body FROM budget_reservations WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|body| {
            let row:Reservation=serde_json::from_str(&body)?;
            let binding:Option<(String,u64)>=db.query_row("SELECT operation_id,attempt FROM operation_budget_bindings WHERE reservation_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            Ok(serde_json::json!({"reservation":row,"billing_status":if row.finalized {"finalized"}else if row.charge_basis.as_deref()==Some("estimated") {"estimated_pending_reconciliation"}else{"pending_reconciliation"},"operation_binding":binding.map(|(id,attempt)|serde_json::json!({"operation_id":id,"attempt":attempt}))}))
        }).transpose()
    }
    pub fn budget_settlement(&self, id: &str, event: &str) -> Result<Option<serde_json::Value>> {
        let row:Option<(String,String)>=self.db.lock().query_row("SELECT command,result FROM budget_settlements WHERE reservation_id=?1 AND event_id=?2",params![id,event],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        row.map(|(command,result)|Ok(serde_json::json!({"command":serde_json::from_str::<serde_json::Value>(&command)?,"result":serde_json::from_str::<serde_json::Value>(&result)?}))).transpose()
    }
    pub fn budget_reservations(&self, id: &str, after: &str) -> Result<serde_json::Value> {
        let db = self.db.lock();
        let mut query=db.prepare("SELECT r.id,r.body FROM budget_reservation_index i JOIN budget_reservations r ON r.id=i.reservation_id WHERE i.budget_id=?1 AND i.reservation_id>?2 ORDER BY i.reservation_id LIMIT 100")?;
        let rows = query.query_map(params![id, after], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut result = Vec::new();
        let mut bytes = 0;
        let mut next = after.to_owned();
        for row in rows {
            let (key, body) = row?;
            if !result.is_empty() && bytes + body.len() > 32768 {
                break;
            }
            bytes += body.len();
            next = key;
            result.push(serde_json::from_str::<serde_json::Value>(&body)?);
        }
        Ok(
            serde_json::json!({"next":next,"may_have_more":!result.is_empty(),"reservations":result,"ordering":"reservation_id"}),
        )
    }
    pub fn budget_events(&self, id: &str, after: u64) -> Result<serde_json::Value> {
        let db = self.db.lock();
        let mut query=db.prepare("SELECT e.seq,e.body FROM budget_event_index i JOIN budget_events e ON e.seq=i.seq WHERE i.budget_id=?1 AND i.seq>?2 ORDER BY i.seq LIMIT 100")?;
        let rows = query.query_map(params![id, after], |r| {
            Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut result = Vec::new();
        let mut bytes = 0;
        let mut cursor = after;
        for row in rows {
            let (seq, body) = row?;
            if !result.is_empty() && bytes + body.len() > 32768 {
                break;
            }
            bytes += body.len();
            cursor = seq;
            result.push(serde_json::json!({"seq":seq,"data":serde_json::from_str::<serde_json::Value>(&body)?}));
        }
        Ok(serde_json::json!({"cursor":cursor,"may_have_more":!result.is_empty(),"events":result}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::budgets::{Configure, Reserve, Scope, Settle};
    #[test]
    fn accounting_queries_recover_receipts_and_v8_indexes_without_rebilling() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.sqlite");
        let store = Store::open(&path, "home").unwrap();
        for id in ["team", "shared", "other"] {
            store
                .configure_budget(
                    Configure {
                        id: id.into(),
                        scope: Scope::Team,
                        scope_id: id.into(),
                        unit: "credits".into(),
                        limit: 100,
                        starts_at: 1,
                        ends_at: 9999,
                        expected_revision: 0,
                    },
                    1,
                )
                .unwrap();
        }
        store
            .reserve_budget(
                Reserve {
                    id: "hold".into(),
                    budget_ids: vec!["team".into(), "shared".into()],
                    amount: 50,
                    unit: "credits".into(),
                    operation_id: "op".into(),
                },
                2,
            )
            .unwrap();
        store
            .settle_budget(
                "hold",
                Settle {
                    event_id: "estimate".into(),
                    expected_revision: 1,
                    total_charge: 20,
                    finalized: false,
                    basis: "estimated".into(),
                },
                3,
            )
            .unwrap();
        let before = store.budget("team").unwrap();
        assert_eq!(
            store.budget_reservation("hold").unwrap().unwrap()["billing_status"],
            "estimated_pending_reconciliation"
        );
        assert!(store.budget_reservation("missing").unwrap().is_none());
        let receipt = store
            .budget_settlement("hold", "estimate")
            .unwrap()
            .unwrap();
        assert_eq!(receipt["result"]["held"], 30);
        let page = store.budget_events("team", 0).unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 3);
        assert_eq!(
            store.budget_events("other", 0).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .budget_events("team", page["cursor"].as_u64().unwrap())
                .unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            store.budget_reservations("team", "").unwrap()["reservations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.budget_reservations("team", "hold").unwrap()["reservations"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        // Simulate an existing v8 ledger: new indexes and triggers must bootstrap old evidence.
        store.db.lock().execute_batch("DROP TRIGGER budget_reservation_index_insert;DROP TRIGGER budget_event_index_insert;DROP TABLE budget_reservation_index;DROP TABLE budget_event_index;DROP TABLE metered_usage;DROP TABLE reservation_prices;DROP TABLE price_versions;DROP TABLE operation_resource_bindings;DROP TABLE official_call_events;DROP TABLE official_calls;DROP TABLE quota_window_evidence;DROP INDEX event_source_cursor; DROP INDEX event_target_cursor; PRAGMA user_version=8;").unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(store.budget("team").unwrap(), before);
        assert_eq!(store.budget_events("team", 0).unwrap(), page);
        assert_eq!(
            store
                .budget_settlement("hold", "estimate")
                .unwrap()
                .unwrap(),
            receipt
        );
        let db = store.db.lock();
        let mut q=db.prepare("EXPLAIN QUERY PLAN SELECT seq FROM budget_event_index WHERE budget_id=?1 AND seq>?2 ORDER BY seq LIMIT 100").unwrap();
        let plans = q
            .query_map(params!["team", 0], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(plans
            .iter()
            .any(|p| p.contains("SEARCH") && p.contains("INDEX")));
    }
    #[test]
    fn indexed_pages_cover_all_accounting_events_and_reservations_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("page.sqlite"), "home").unwrap();
        store
            .configure_budget(
                Configure {
                    id: "team".into(),
                    scope: Scope::Team,
                    scope_id: "team".into(),
                    unit: "credits".into(),
                    limit: 1000,
                    starts_at: 1,
                    ends_at: 9999,
                    expected_revision: 0,
                },
                1,
            )
            .unwrap();
        for i in 0..125 {
            store
                .reserve_budget(
                    Reserve {
                        id: format!("r{i:03}"),
                        budget_ids: vec!["team".into()],
                        amount: 1,
                        unit: "credits".into(),
                        operation_id: format!("op{i}"),
                    },
                    2,
                )
                .unwrap();
        }
        let before = store.budget("team").unwrap();
        let mut cursor = 0;
        let mut count = 0;
        loop {
            let page = store.budget_events("team", cursor).unwrap();
            let rows = page["events"].as_array().unwrap();
            if rows.is_empty() {
                break;
            }
            assert!(rows.len() <= 100);
            assert!(page["cursor"].as_u64().unwrap() > cursor);
            cursor = page["cursor"].as_u64().unwrap();
            count += rows.len();
        }
        assert_eq!(count, 126);
        let mut after = String::new();
        let mut ids = std::collections::HashSet::new();
        loop {
            let page = store.budget_reservations("team", &after).unwrap();
            let rows = page["reservations"].as_array().unwrap();
            if rows.is_empty() {
                break;
            }
            for row in rows {
                assert!(ids.insert(row["request"]["id"].as_str().unwrap().to_owned()));
            }
            after = page["next"].as_str().unwrap().to_owned();
        }
        assert_eq!(ids.len(), 125);
        assert_eq!(store.budget("team").unwrap(), before);
    }
}
