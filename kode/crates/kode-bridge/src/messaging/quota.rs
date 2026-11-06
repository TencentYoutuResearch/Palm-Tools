//! Trusted collector snapshots fenced by account epoch and resource revision.
use super::{model::valid_id, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub window_id: String,
    pub used_percent: Option<f64>,
    pub resets_at_ms: Option<u64>,
    pub window_minutes: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bucket {
    pub limit_id: String,
    pub observed_at_ms: u64,
    pub valid_until_ms: u64,
    pub windows: Vec<Window>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub host: String,
    pub profile: String,
    pub account_id: String,
    pub account_epoch: u64,
    pub binding_revision: u64,
    pub observed_at_ms: u64,
    pub buckets: Vec<Bucket>,
    pub truncated: bool,
}
impl Store {
    pub fn record_quota(&self, sample: Sample, received: u64) -> Result<serde_json::Value> {
        if !valid_id(&sample.host)
            || !valid_id(&sample.profile)
            || !valid_id(&sample.account_id)
            || sample.buckets.len() > 128
            || sample.observed_at_ms > received.saturating_add(60000)
        {
            bail!("invalid quota sample")
        }
        let mut keys = std::collections::HashSet::new();
        for bucket in &sample.buckets {
            if !valid_id(&bucket.limit_id)
                || !keys.insert(&bucket.limit_id)
                || bucket.windows.len() > 8
                || bucket.observed_at_ms > sample.observed_at_ms
                || bucket.valid_until_ms < bucket.observed_at_ms
                || bucket.valid_until_ms - bucket.observed_at_ms > 900000
            {
                bail!("invalid quota bucket")
            }
            let mut windows = std::collections::HashSet::new();
            for window in &bucket.windows {
                if !valid_id(&window.window_id)
                    || !windows.insert(&window.window_id)
                    || window
                        .used_percent
                        .is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v))
                    || window.window_minutes == Some(0)
                    || window.resets_at_ms.is_some_and(|v| v > i64::MAX as u64)
                {
                    bail!("invalid quota window")
                }
            }
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let binding:Option<(String,u64,u64,u64,bool)>=tx.query_row("SELECT b.account_id,b.account_epoch,b.revision,a.epoch,(a.enabled AND b.enabled) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile=?2",params![sample.host,sample.profile],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        if binding
            != Some((
                sample.account_id.clone(),
                sample.account_epoch,
                sample.binding_revision,
                sample.account_epoch,
                true,
            ))
        {
            bail!("quota binding is stale or unavailable")
        }
        let body = serde_json::to_string(&sample)?;
        let prior:Option<(u64,u64,String)>=tx.query_row("SELECT binding_revision,observed_at,body FROM quota_snapshots WHERE host=?1 AND profile=?2",params![sample.host,sample.profile],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((revision, at, old)) = prior {
            if revision == sample.binding_revision && at >= sample.observed_at_ms {
                if at == sample.observed_at_ms && old == body {
                    return Ok(serde_json::json!({"accepted":true,"duplicate":true}));
                }
                bail!("quota observation is older or conflicts with stored sample")
            }
        }
        super::quota_evidence::observe(&tx, &sample, true)?;
        tx.execute("INSERT INTO quota_snapshots(host,profile,binding_revision,observed_at,received_at,body) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(host,profile) DO UPDATE SET binding_revision=excluded.binding_revision,observed_at=excluded.observed_at,received_at=excluded.received_at,body=excluded.body",params![sample.host,sample.profile,sample.binding_revision,sample.observed_at_ms,received,body])?;
        tx.execute("INSERT INTO resource_events(body) VALUES (?1)",[serde_json::to_string(&serde_json::json!({"kind":"quota_observed","source":"codex_app_server","received_at_ms":received,"sample":sample}))?])?;
        tx.commit()?;
        Ok(serde_json::json!({"accepted":true,"duplicate":false}))
    }
    pub fn quota_snapshot(&self, host: &str, profile: &str, at: u64) -> Result<serde_json::Value> {
        let db = self.db.lock();
        let found:Option<(String,u64,bool)>=db.query_row("SELECT q.body,q.received_at,(b.enabled=1 AND a.enabled=1 AND a.epoch=b.account_epoch AND q.binding_revision=b.revision) FROM quota_snapshots q JOIN resource_bindings b ON b.host=q.host AND b.profile=q.profile JOIN resource_accounts a ON a.id=b.account_id WHERE q.host=?1 AND q.profile=?2",params![host,profile],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((body, received, current)) = found else {
            return Ok(serde_json::json!({"status":"unavailable"}));
        };
        if !current {
            return Ok(serde_json::json!({"status":"binding_changed"}));
        }
        let sample: Sample = serde_json::from_str(&body)?;
        let buckets=sample.buckets.iter().map(|bucket|serde_json::json!({"limit_id":bucket.limit_id,"observed_at_ms":bucket.observed_at_ms,"windows":bucket.windows.iter().map(|window| {
            let freshness=if window.resets_at_ms.is_some_and(|reset|reset<=at) {"reset_passed"} else if bucket.valid_until_ms<=at {"stale"} else if window.used_percent.is_some()&&window.resets_at_ms.is_some()&&window.window_minutes.is_some() {"reported"} else {"unknown"};
            serde_json::json!({"window":window,"freshness":freshness})
        }).collect::<Vec<_>>()})).collect::<Vec<_>>();
        Ok(
            serde_json::json!({"status":if buckets.is_empty(){"unavailable"}else{"reported"},"account_id":sample.account_id,"account_epoch":sample.account_epoch,"binding_revision":sample.binding_revision,"received_at_ms":received,"truncated":sample.truncated,"source":"codex_app_server","exhaustion_evidence":super::quota_evidence::view(&db,host,profile,sample.binding_revision,at)?,"buckets":buckets}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::resources::{AccountCommand, BindingCommand};
    #[test]
    fn quota_epoch_fencing_idempotency_and_freshness_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("q.sqlite");
        let store = Store::open(&path, "home").unwrap();
        store
            .change_resource_account(AccountCommand {
                id: "a".into(),
                expected_epoch: 0,
                enabled: true,
            })
            .unwrap();
        store
            .bind_resource_account(BindingCommand {
                host: "home".into(),
                profile: "worker".into(),
                account_id: "a".into(),
                account_epoch: 1,
                expected_revision: 0,
            })
            .unwrap();
        let sample = Sample {
            host: "home".into(),
            profile: "worker".into(),
            account_id: "a".into(),
            account_epoch: 1,
            binding_revision: 1,
            observed_at_ms: 1000,
            truncated: false,
            buckets: vec![Bucket {
                limit_id: "quota".into(),
                observed_at_ms: 1000,
                valid_until_ms: 2000,
                windows: vec![Window {
                    window_id: "primary".into(),
                    used_percent: Some(100.0),
                    resets_at_ms: Some(3000),
                    window_minutes: Some(60),
                }],
            }],
        };
        store.record_quota(sample.clone(), 1000).unwrap();
        assert_eq!(
            store.record_quota(sample.clone(), 1001).unwrap()["duplicate"],
            true
        );
        let mut changed = sample.clone();
        changed.buckets[0].windows[0].used_percent = Some(0.0);
        assert!(store.record_quota(changed, 1001).is_err());
        assert_eq!(
            store.quota_snapshot("home", "worker", 2000).unwrap()["buckets"][0]["windows"][0]
                ["freshness"],
            "stale"
        );
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(
            store.quota_snapshot("home", "worker", 3000).unwrap()["buckets"][0]["windows"][0]
                ["freshness"],
            "reset_passed"
        );
        store
            .change_resource_account(AccountCommand {
                id: "a".into(),
                expected_epoch: 1,
                enabled: true,
            })
            .unwrap();
        assert!(store.record_quota(sample, 3000).is_err());
        assert_eq!(
            store.quota_snapshot("home", "worker", 3000).unwrap()["status"],
            "binding_changed"
        );
    }
}
