//! Immutable home-Hub soft evaluations. These never establish executor capabilities or prices.
use super::{model::now, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Evaluation {
    TaskFit { tag: String, score: u8 },
    CostTier { tier: String },
    Latency { preference: String },
    Strength { text: String },
    Weakness { text: String },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    User,
    Documented,
    Measured,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assessment {
    pub evaluation: Evaluation,
    pub source: Source,
    pub confidence: f64,
    pub evidence: Vec<String>,
    pub updated_at: u64,
    pub valid_until: u64,
    pub pinned: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub expected_revision: u64,
    pub host: String,
    pub profile: String,
    pub model: String,
    pub assessments: BTreeMap<String, Assessment>,
    /// Explicit administrator action; automated suggestions must leave this false.
    #[serde(default)]
    pub replace_pins: bool,
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}
impl Command {
    fn validate(&self, at: u64) -> Result<()> {
        if [&self.id, &self.host, &self.profile, &self.model]
            .iter()
            .any(|s| !text(s, 256))
            || self.assessments.len() > 128
        {
            bail!("invalid capability profile identity or size")
        }
        for (key, item) in &self.assessments {
            let valid = match &item.evaluation {
                Evaluation::TaskFit { tag, score } => text(tag, 160) && *score <= 100,
                Evaluation::CostTier { tier } => ["low", "medium", "high"].contains(&tier.as_str()),
                Evaluation::Latency { preference } => {
                    ["low", "medium", "high"].contains(&preference.as_str())
                }
                Evaluation::Strength { text: value } | Evaluation::Weakness { text: value } => {
                    text(value, 2048)
                }
            };
            if !text(key, 160)
                || !valid
                || !item.confidence.is_finite()
                || !(0.0..=1.0).contains(&item.confidence)
                || item.updated_at == 0
                || item.updated_at > at
                || item.valid_until <= item.updated_at
                || item.valid_until > i64::MAX as u64
                || item.evidence.len() > 16
                || item.evidence.iter().any(|s| !text(s, 2048))
                || (item.source != Source::User && item.evidence.is_empty())
            {
                bail!("invalid capability assessment")
            }
        }
        Ok(())
    }
}
pub(super) fn save_in(tx: &rusqlite::Transaction, input: Command) -> Result<serde_json::Value> {
    let at = now();
    input.validate(at)?;
    let previous: Option<(u64, String)> = tx.query_row(
            "SELECT revision,body FROM capability_profiles WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [&input.id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let revision = previous.as_ref().map(|r| r.0).unwrap_or(0);
    if revision != input.expected_revision {
        bail!("capability profile revision conflict")
    }
    if let Some((_, body)) = previous {
        let prior: serde_json::Value = serde_json::from_str(&body)?;
        if prior["host"] != input.host
            || prior["profile"] != input.profile
            || prior["model"] != input.model
        {
            bail!("capability profile resource identity is immutable")
        }
        let assessments: BTreeMap<String, Assessment> =
            serde_json::from_value(prior["assessments"].clone())?;
        if !input.replace_pins
            && assessments
                .iter()
                .any(|(key, item)| item.pinned && input.assessments.get(key) != Some(item))
        {
            bail!("explicit user action required to replace pinned assessment")
        }
    }
    let revision = revision
        .checked_add(1)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or_else(|| anyhow::anyhow!("capability revision exhausted"))?;
    let row = serde_json::json!({"schema_version":1,"id":input.id,"revision":revision,
            "host":input.host,"profile":input.profile,"model":input.model,"assessments":input.assessments,"created_at":at});
    tx.execute(
        "INSERT INTO capability_profiles(id,revision,body) VALUES (?1,?2,?3)",
        params![input.id, revision, serde_json::to_string(&row)?],
    )?;
    tx.execute("INSERT INTO resource_events(body) VALUES (?1)", [serde_json::to_string(&serde_json::json!({
            "kind":"capability_profile_saved","id":input.id,"revision":revision,"replace_pins":input.replace_pins,"at":at}))?])?;
    Ok(row)
}
impl Store {
    pub fn save_capability_profile(&self, input: Command) -> Result<serde_json::Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = save_in(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn capability_profile(&self, id: &str, revision: u64) -> Result<Option<serde_json::Value>> {
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT body FROM capability_profiles WHERE id=?1 AND revision=?2",
                params![id, revision],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|body| {
            let mut row: serde_json::Value = serde_json::from_str(&body)?;
            let at = now();
            let freshness: BTreeMap<_, _> = row["assessments"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, item)| {
                    (
                        key.clone(),
                        if item["valid_until"].as_u64().unwrap() > at {
                            "fresh"
                        } else {
                            "stale"
                        },
                    )
                })
                .collect();
            row["freshness"] = serde_json::to_value(freshness)?;
            row["evaluated_at"] = at.into();
            Ok(row)
        })
        .transpose()
    }
}
