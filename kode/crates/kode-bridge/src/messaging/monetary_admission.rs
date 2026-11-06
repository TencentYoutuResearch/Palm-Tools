//! Scoped money constraints participate in the same lease transaction as window quotas.
use super::{monetary_quota::Observation, resource_admission::Policy};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub source: String,
    pub currency: String,
    #[serde(default)]
    pub free_models: bool,
}
impl Requirement {
    pub fn validate(&self) -> Result<()> {
        if !["deepseek_balance", "openrouter_key", "openrouter_credits"]
            .contains(&self.source.as_str())
            || !["usd", "cny"].contains(&self.currency.as_str())
            || (self.source != "deepseek_balance" && self.currency != "usd")
            || (self.free_models && self.source != "openrouter_key")
        {
            bail!("invalid monetary requirement")
        }
        Ok(())
    }
}
fn exhausted(row: &Value) -> Option<bool> {
    if row["kind"] == "key_cap" && row["unlimited"] == true && row["limit"].is_null() {
        return Some(false);
    }
    let value = &row["remaining"];
    if let Some(count) = value.as_u64() {
        return Some(count == 0);
    }
    value
        .as_str()
        .map(|v| v.starts_with('-') || v.bytes().all(|b| b == b'0' || b == b'.'))
}
fn applicable(row: &Value, requirement: &Requirement) -> bool {
    if row["scope"] == "free_models" {
        requirement.free_models
    } else {
        row["unit"] == requirement.currency
    }
}
pub(super) fn observe(db: &Connection, observation: &Observation) -> Result<()> {
    let mut entries = Vec::new();
    if let Some(sample) = &observation.sample {
        entries.push(("_collection".to_string(), json!({"denied":false})));
        if let Some(available) = sample.provider_available {
            entries.push(("_availability".into(), json!({"denied":!available})));
        }
        for limit in &sample.limits {
            if let Some(reached) = exhausted(limit) {
                entries.push((
                    limit["limit_id"].as_str().unwrap().to_string(),
                    json!({"denied":reached,"limit":limit}),
                ));
            }
        }
    } else if [
        "authentication_unavailable",
        "rate_limited",
        "provider_payment_required",
    ]
    .contains(&observation.status.as_str())
    {
        entries.push((
            "_collection".into(),
            json!({"denied":true,"reason":observation.status}),
        ));
    }
    for (id, body) in entries {
        db.execute("INSERT INTO monetary_evidence(host,profile,binding_revision,source,limit_id,observed_at,body) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(host,profile,binding_revision,source,limit_id) DO UPDATE SET observed_at=excluded.observed_at,body=excluded.body WHERE excluded.observed_at>monetary_evidence.observed_at",
            params![observation.host,observation.profile,observation.binding_revision,observation.source,id,observation.observed_at_ms,serde_json::to_string(&body)?])?;
    }
    Ok(())
}
pub(super) struct Check {
    pub denial: Option<String>,
    pub complete: bool,
    pub until: u64,
}
pub(super) fn evaluate(db: &Connection, policy: &Policy, at: u64) -> Result<Check> {
    let mut result = Check {
        denial: None,
        complete: true,
        until: u64::MAX,
    };
    for requirement in &policy.monetary {
        let mut query = db.prepare("SELECT body FROM monetary_evidence WHERE host=?1 AND profile=?2 AND binding_revision=?3 AND source=?4")?;
        let evidence = query.query_map(
            params![
                policy.host,
                policy.profile,
                policy.binding_revision,
                requirement.source
            ],
            |r| r.get::<_, String>(0),
        )?;
        for row in evidence {
            let row: Value = serde_json::from_str(&row?)?;
            if row["denied"] != true {
                continue;
            }
            if !row["limit"].is_null() {
                if !applicable(&row["limit"], requirement)
                    || row["limit"]["resets_at_ms"]
                        .as_u64()
                        .is_some_and(|reset| reset <= at)
                {
                    continue;
                }
            }
            result.denial = Some(
                row["reason"]
                    .as_str()
                    .unwrap_or("provider_monetary_exhausted")
                    .to_string(),
            );
            return Ok(result);
        }
        let body: Option<String> = db.query_row("SELECT body FROM monetary_quota WHERE host=?1 AND profile=?2 AND binding_revision=?3 AND source=?4",
            params![policy.host,policy.profile,policy.binding_revision,requirement.source], |r| r.get(0)).optional()?;
        let observation = body
            .map(|s| serde_json::from_str::<Observation>(&s))
            .transpose()?;
        let Some(sample) = observation
            .as_ref()
            .filter(|o| o.status == "reported")
            .and_then(|o| o.sample.as_ref())
        else {
            result.complete = false;
            continue;
        };
        if sample.observed_at_ms > at
            || sample.valid_until_ms <= at
            || sample.completeness != "complete_for_endpoint"
        {
            result.complete = false;
        }
        result.until = result.until.min(sample.valid_until_ms);
        let limits: Vec<_> = sample
            .limits
            .iter()
            .filter(|row| applicable(row, requirement))
            .collect();
        if limits.is_empty()
            || (requirement.free_models && !limits.iter().any(|row| row["scope"] == "free_models"))
        {
            result.complete = false;
        }
        for limit in limits {
            if exhausted(limit).is_none() {
                result.complete = false;
            }
            if let Some(reset) = limit["resets_at_ms"].as_u64() {
                result.until = result.until.min(reset);
                if reset <= at {
                    result.complete = false;
                }
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{
        resources::{AccountCommand, BindingCommand},
        store::Store,
    };
    #[test]
    fn v16_upgrade_replays_exhaustion_before_a_partial_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("money.sqlite");
        let store = Store::open(&path, "home").unwrap();
        store
            .change_resource_account(AccountCommand {
                id: "account".into(),
                expected_epoch: 0,
                enabled: true,
            })
            .unwrap();
        store
            .bind_resource_account(BindingCommand {
                host: "home".into(),
                profile: "worker".into(),
                account_id: "account".into(),
                account_epoch: 1,
                expected_revision: 0,
            })
            .unwrap();
        for (at, remaining) in [(1000, json!("0")), (1001, Value::Null)] {
            let row: Observation = serde_json::from_value(json!({"host":"home","profile":"worker","account_id":"account","account_epoch":1,"binding_revision":1,"source":"deepseek_balance","observed_at_ms":at,"status":"reported","sample":{
                "source":"deepseek_balance","source_version":"fixture","observed_at_ms":at,"valid_until_ms":2000,"provider_available":true,"completeness":"partial","account_identity":"requires_host_binding","limitations":[],
                "limits":[{"limit_id":"balance:CNY","kind":"balance","scope":"account","unit":"cny","remaining":remaining,"limit":null,"used":null,"reached":null,"resets_at_ms":null,"quality":"reported"}]
            }})).unwrap();
            store.record_monetary_quota(row).unwrap();
        }
        store
            .db
            .lock()
            .execute_batch("DROP TABLE monetary_evidence; PRAGMA user_version=16;")
            .unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        let policy: Policy = serde_json::from_value(json!({"host":"home","profile":"worker","account_id":"account","account_epoch":1,"binding_revision":1,"limit_ids":[],"unknown_quota":"team_budget","monetary":[{"source":"deepseek_balance","currency":"cny"}]})).unwrap();
        assert_eq!(
            store.resource_admission(&policy, 3000).unwrap().reason,
            "provider_monetary_exhausted"
        );
        let count: u64 = store.db.lock().query_row("SELECT count(*) FROM resource_events WHERE json_extract(body,'$.kind')='monetary_quota_observed'",[],|r|r.get(0)).unwrap();
        assert_eq!(count, 2);
    }
}
