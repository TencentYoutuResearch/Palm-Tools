//! Read-only recommendations from home-Hub facts. Ranking never reserves or admits execution.
use super::{
    capability_profiles::{Assessment, Evaluation},
    model::now,
    resource_admission,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub capability_id: String,
    pub capability_revision: u64,
    pub model: String,
    pub resource: resource_admission::Policy,
    #[serde(default)]
    pub preferred: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Weights {
    pub quality: u16,
    pub cost: u16,
    pub latency: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub task_tag: String,
    pub minimum_quality: u8,
    pub minimum_confidence: f64,
    pub weights: Weights,
    pub candidates: Vec<Candidate>,
}
fn tier(value: &str) -> f64 {
    match value {
        "low" => 100.0,
        "medium" => 50.0,
        _ => 0.0,
    }
}
impl Store {
    pub fn rank_resources(&self, input: Request) -> Result<Value> {
        let db = self.db.lock();
        rank_in(&db, input, now())
    }
}

/// Evaluate inside the caller's transaction when ranking frozen stage candidates.
pub(super) fn rank_in(db: &Connection, input: Request, at: u64) -> Result<Value> {
    let weights = &input.weights;
    if input.task_tag.trim().is_empty()
        || input.task_tag.len() > 160
        || input.minimum_quality > 100
        || !input.minimum_confidence.is_finite()
        || !(0.0..=1.0).contains(&input.minimum_confidence)
        || input.candidates.len() > 25
        || weights.quality > 1000
        || weights.cost > 1000
        || weights.latency > 1000
        || u32::from(weights.quality) + u32::from(weights.cost) + u32::from(weights.latency) == 0
    {
        bail!("invalid resource ranking request")
    }
    let mut identities = HashSet::new();
    let mut candidates = Vec::new();
    let mut excluded = Vec::new();
    for candidate in input.candidates {
        if candidate.capability_id.is_empty()
            || candidate.capability_id.len() > 256
            || candidate.capability_revision == 0
            || candidate.model.is_empty()
            || candidate.model.len() > 256
            || !identities.insert((
                candidate.resource.host.clone(),
                candidate.resource.profile.clone(),
                candidate.model.clone(),
            ))
        {
            bail!("invalid or duplicate ranking candidate")
        }
        let mut row = json!({"host":candidate.resource.host,"profile":candidate.resource.profile,"model":candidate.model,
                "capability_id":candidate.capability_id,"capability_revision":candidate.capability_revision,
                "preferred":candidate.preferred,"eligible_for_dispatch":false});
        let body: Option<String> = db
            .query_row(
                "SELECT body FROM capability_profiles WHERE id=?1 AND revision=?2",
                params![candidate.capability_id, candidate.capability_revision],
                |r| r.get(0),
            )
            .optional()?;
        let Some(body) = body else {
            row["reason"] = "capability_revision_missing".into();
            excluded.push(row);
            continue;
        };
        let profile: Value = serde_json::from_str(&body)?;
        if profile["host"] != candidate.resource.host
            || profile["profile"] != candidate.resource.profile
            || profile["model"] != candidate.model
        {
            row["reason"] = "capability_identity_mismatch".into();
            excluded.push(row);
            continue;
        }
        let quota = resource_admission::evaluate(db, &candidate.resource, at)?;
        row["quota"] = serde_json::to_value(&quota)?;
        if !quota.allowed {
            row["reason"] = quota.reason.into();
            excluded.push(row);
            continue;
        }
        let assessments: BTreeMap<String, Assessment> =
            serde_json::from_value(profile["assessments"].clone())?;
        let mut quality: Option<f64> = None;
        let mut cost: Option<f64> = None;
        let mut latency: Option<f64> = None;
        let mut evidence = Vec::new();
        let mut ignored = Vec::new();
        for (id, assessment) in assessments {
            if assessment.valid_until <= at
                || assessment.updated_at > at
                || assessment.confidence < input.minimum_confidence
            {
                ignored.push(json!({"id":id,"reason":"stale_or_insufficient_confidence"}));
                continue;
            }
            // Conflicting retained assessments are conservative: the lowest applicable score wins.
            let slot = match &assessment.evaluation {
                Evaluation::TaskFit { tag, score } if tag == &input.task_tag => {
                    Some((&mut quality, f64::from(*score)))
                }
                Evaluation::CostTier { tier: value } => Some((&mut cost, tier(value))),
                Evaluation::Latency { preference } => Some((&mut latency, tier(preference))),
                _ => None,
            };
            if let Some((slot, score)) = slot {
                *slot = Some(slot.map_or(score, |prior| prior.min(score)));
                evidence.push(json!({"id":id,"source":assessment.source,"confidence":assessment.confidence,"pinned":assessment.pinned,"valid_until":assessment.valid_until}));
            }
        }
        row["evidence"] = json!(evidence);
        row["ignored_assessments"] = json!(ignored);
        row["components"] =
            json!({"quality":quality,"cost_preference":cost,"latency_preference":latency});
        if quality.is_none_or(|score| score < f64::from(input.minimum_quality)) {
            row["reason"] = "quality_evidence_missing_or_below_floor".into();
            excluded.push(row);
            continue;
        }
        let denominator =
            f64::from(weights.quality) + f64::from(weights.cost) + f64::from(weights.latency);
        let score = (quality.unwrap() * f64::from(weights.quality)
            + cost.unwrap_or(0.0) * f64::from(weights.cost)
            + latency.unwrap_or(0.0) * f64::from(weights.latency))
            / denominator;
        row["score"] = json!(score);
        row["reason"] = "recommendation_pending_execution_checks".into();
        candidates.push(row);
    }
    candidates.sort_by(|a, b| {
        b["preferred"]
            .as_bool()
            .cmp(&a["preferred"].as_bool())
            .then_with(|| {
                b["score"]
                    .as_f64()
                    .unwrap()
                    .total_cmp(&a["score"].as_f64().unwrap())
            })
            .then_with(|| a["host"].as_str().cmp(&b["host"].as_str()))
            .then_with(|| a["profile"].as_str().cmp(&b["profile"].as_str()))
            .then_with(|| a["model"].as_str().cmp(&b["model"].as_str()))
    });
    Ok(
        json!({"scope":"capability_recommendation","evaluated_at":at,"candidates":candidates,"excluded":excluded,
            "eligible_for_dispatch":false,"missing_soft_evidence_policy":"zero_credit_not_zero_cost",
            "pending_checks":["activated_team_policy","workspace_and_grant","executor_model_effort_and_tools",
                "review_independence","metering_and_atomic_budget_reservation","resource_locks_and_account_concurrency"],
            "limitations":["declared_evidence_not_independently_verified","cost_tiers_are_not_prices","quota_must_be_rechecked_at_dispatch"]}),
    )
}
