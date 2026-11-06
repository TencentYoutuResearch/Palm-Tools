//! Provider monetary facts, fenced by home-Hub account identity. Never a team budget.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub host: String,
    pub profile: String,
    pub account_id: String,
    pub account_epoch: u64,
    pub binding_revision: u64,
    pub source: String,
    pub observed_at_ms: u64,
    pub status: String,
    pub sample: Option<Sample>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub source: String,
    pub source_version: String,
    pub observed_at_ms: u64,
    pub valid_until_ms: u64,
    pub provider_available: Option<bool>,
    pub completeness: String,
    pub limits: Vec<Value>,
    pub account_identity: String,
    pub limitations: Vec<String>,
}
fn source(value: &str) -> bool {
    ["deepseek_balance", "openrouter_key", "openrouter_credits"].contains(&value)
}
fn decimal(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let value = value.strip_prefix('-').unwrap_or(value);
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    !whole.is_empty()
        && whole.len() <= 18
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction
            .is_none_or(|p| !p.is_empty() && p.len() <= 12 && p.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}
impl Observation {
    fn validate(&self, received: u64) -> Result<()> {
        if [&self.host, &self.profile, &self.account_id]
            .iter()
            .any(|id| !valid_id(id))
            || !source(&self.source)
            || self.account_epoch == 0
            || self.binding_revision == 0
            || self.observed_at_ms == 0
            || self.observed_at_ms > received.saturating_add(60000)
        {
            bail!("invalid monetary observation identity or time")
        }
        if self.status != "reported" {
            if self.sample.is_some()
                || ![
                    "authentication_unavailable",
                    "rate_limited",
                    "provider_payment_required",
                    "unavailable",
                    "cancelled_or_timed_out",
                ]
                .contains(&self.status.as_str())
            {
                bail!("invalid monetary collection failure")
            }
            return Ok(());
        }
        let sample = self
            .sample
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("reported monetary sample missing"))?;
        if sample.source != self.source
            || sample.observed_at_ms != self.observed_at_ms
            || sample.valid_until_ms <= sample.observed_at_ms
            || sample.valid_until_ms > sample.observed_at_ms.saturating_add(900000)
            || sample.source_version.len() > 64
            || sample.source_version.is_empty()
            || sample.limits.is_empty()
            || sample.limits.len() > 68
            || sample.account_identity != "requires_host_binding"
            || sample.limitations.len() > 8
            || sample.limitations.iter().any(|s| s.len() > 128)
            || !["partial", "complete_for_endpoint"].contains(&sample.completeness.as_str())
        {
            bail!("invalid monetary sample")
        }
        let mut ids = std::collections::HashSet::new();
        for limit in &sample.limits {
            let Some(fields) = limit.as_object() else {
                bail!("invalid monetary limit")
            };
            let id = limit["limit_id"].as_str().unwrap_or("");
            if !valid_id(id)
                || !ids.insert(id)
                || fields.keys().any(|key| {
                    ![
                        "limit_id",
                        "kind",
                        "scope",
                        "unit",
                        "remaining",
                        "granted",
                        "topped_up",
                        "limit",
                        "used",
                        "reached",
                        "resets_at_ms",
                        "quality",
                        "purchased",
                        "unlimited",
                        "usage_scope",
                        "include_byok",
                        "reset_quality",
                    ]
                    .contains(&key.as_str())
                })
            {
                bail!("invalid monetary limit fields")
            }
            let kind = limit["kind"].as_str().unwrap_or("");
            let scope = limit["scope"].as_str().unwrap_or("");
            let unit = limit["unit"].as_str().unwrap_or("");
            let valid_scope = match self.source.as_str() {
                "deepseek_balance" => {
                    kind == "balance" && scope == "account" && ["usd", "cny"].contains(&unit)
                }
                "openrouter_credits" => kind == "balance" && scope == "account" && unit == "usd",
                _ => {
                    (kind == "key_cap" && scope == "key" && unit == "usd")
                        || (kind == "organization_budget"
                            && ["member", "organization", "workspace", "key", "guardrail"]
                                .contains(&scope)
                            && unit == "usd")
                        || (kind == "usage_window" && scope == "free_models" && unit == "requests")
                }
            };
            if !valid_scope
                || !["reported", "derived"].contains(&limit["quality"].as_str().unwrap_or(""))
            {
                bail!("invalid monetary limit scope")
            }
            if ["remaining", "limit", "used", "reached", "resets_at_ms"]
                .iter()
                .any(|key| !fields.contains_key(*key))
            {
                bail!("missing monetary limit fields")
            }
            for key in [
                "remaining",
                "granted",
                "topped_up",
                "limit",
                "used",
                "purchased",
            ] {
                if let Some(value) = fields.get(key).filter(|v| !v.is_null()) {
                    if !(if unit == "requests" {
                        value.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
                    } else {
                        decimal(value)
                    }) {
                        bail!("invalid monetary amount")
                    }
                }
            }
            for key in ["reached", "unlimited", "include_byok"] {
                if fields
                    .get(key)
                    .is_some_and(|v| !v.is_null() && !v.is_boolean())
                {
                    bail!("invalid monetary flag")
                }
            }
            if fields
                .get("resets_at_ms")
                .is_some_and(|v| !v.is_null() && v.as_u64().is_none_or(|v| v > i64::MAX as u64))
            {
                bail!("invalid monetary reset")
            }
            if fields.get("usage_scope").is_some_and(|v| v != "all_time")
                || fields.get("reset_quality").is_some_and(|v| {
                    v != "not_applicable" && v != "derived_from_provider_utc_schedule"
                })
            {
                bail!("invalid monetary provenance")
            }
        }
        Ok(())
    }
}
impl Store {
    pub fn record_monetary_quota(&self, input: Observation) -> Result<Value> {
        let received = now();
        input.validate(received)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let current: Option<(String,u64,u64,bool)> = tx.query_row(
            "SELECT b.account_id,b.account_epoch,b.revision,(a.enabled AND b.enabled AND b.account_epoch=a.epoch) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile=?2",
            params![input.host,input.profile], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if current
            != Some((
                input.account_id.clone(),
                input.account_epoch,
                input.binding_revision,
                true,
            ))
        {
            bail!("monetary binding is stale or unavailable")
        }
        let body = serde_json::to_string(&input)?;
        let prior: Option<(u64,u64,String)> = tx.query_row(
            "SELECT binding_revision,observed_at,body FROM monetary_quota WHERE host=?1 AND profile=?2 AND source=?3",
            params![input.host,input.profile,input.source], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((revision, at, previous)) = prior {
            if revision == input.binding_revision && at >= input.observed_at_ms {
                if at == input.observed_at_ms && previous == body {
                    return Ok(json!({"accepted":true,"duplicate":true}));
                }
                bail!("monetary observation is older or conflicts")
            }
        }
        super::monetary_admission::observe(&tx, &input)?;
        tx.execute("INSERT INTO monetary_quota(host,profile,source,binding_revision,observed_at,body,last_reported) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(host,profile,source) DO UPDATE SET binding_revision=excluded.binding_revision,observed_at=excluded.observed_at,body=excluded.body,last_reported=CASE WHEN excluded.last_reported IS NOT NULL THEN excluded.last_reported WHEN monetary_quota.binding_revision=excluded.binding_revision THEN monetary_quota.last_reported ELSE NULL END",
            params![input.host,input.profile,input.source,input.binding_revision,input.observed_at_ms,body,if input.status == "reported" {Some(&body)} else {None}])?;
        tx.execute("INSERT INTO resource_events(body) VALUES (?1)", [serde_json::to_string(&json!({"kind":"monetary_quota_observed","received_at_ms":received,"observation":input}))?])?;
        tx.commit()?;
        Ok(json!({"accepted":true,"duplicate":false}))
    }
    pub fn monetary_quota(&self, host: &str, profile: &str) -> Result<Value> {
        let db = self.db.lock();
        let current: Option<(String,u64,u64,bool)> = db.query_row(
            "SELECT b.account_id,b.account_epoch,b.revision,(a.enabled AND b.enabled AND b.account_epoch=a.epoch) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile=?2",
            params![host,profile], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let mut query = db.prepare("SELECT body,last_reported FROM monetary_quota WHERE host=?1 AND profile=?2 ORDER BY source")?;
        let rows = query.query_map(params![host, profile], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        let at = now();
        let mut result = Vec::new();
        for row in rows {
            let (body, last) = row?;
            let observation: Observation = serde_json::from_str(&body)?;
            let valid = current.as_ref()
                == Some(&(
                    observation.account_id.clone(),
                    observation.account_epoch,
                    observation.binding_revision,
                    true,
                ));
            if !valid {
                result.push(json!({"source":observation.source,"status":"binding_changed","last_reported":null}));
                continue;
            }
            let latest: Option<Observation> =
                last.map(|body| serde_json::from_str(&body)).transpose()?;
            let freshness = latest
                .as_ref()
                .and_then(|row| row.sample.as_ref())
                .map(|s| {
                    if s.valid_until_ms > at {
                        "fresh"
                    } else {
                        "stale"
                    }
                });
            result.push(json!({"source":observation.source,"status":observation.status,"observed_at_ms":observation.observed_at_ms,
                "last_reported":latest,"last_reported_freshness":freshness,"eligible_for_dispatch":false}));
        }
        Ok(
            json!({"host":host,"profile":profile,"sources":result,"evaluated_at_ms":at,"scope":"provider_facts_not_team_budget"}),
        )
    }
}
