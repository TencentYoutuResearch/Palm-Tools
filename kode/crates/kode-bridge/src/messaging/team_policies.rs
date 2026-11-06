//! Owner-configured budget and scheduling policies. Immutable revisions do not admit execution.
use super::{
    model::{now, valid_id},
    resource_admission,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Weights {
    pub quality: u16,
    pub cost: u16,
    pub latency: u16,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub resource: resource_admission::Policy,
    pub capability_id: String,
    pub capability_revision: u64,
    pub preferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_price_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Policy {
    Budget {
        budget_ids: Vec<String>,
        unit: String,
        max_assignment_charge: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settlement: Option<String>,
    },
    Scheduling {
        targets: BTreeMap<String, Candidate>,
        weights: Weights,
        minimum_quality: u8,
        minimum_confidence: f64,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Write {
    pub id: String,
    pub team_id: String,
    pub expected_revision: u64,
    pub policy: Policy,
}
fn key(id: &str, revision: Option<u64>) -> String {
    format!(
        "team-policy:{}",
        serde_json::to_string(&(id, revision)).unwrap()
    )
}
pub(super) fn read(db: &Connection, id: &str, revision: Option<u64>) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id, revision)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
pub(super) fn write_in(
    tx: &rusqlite::Transaction,
    mut input: Write,
    node_id: &str,
) -> Result<Value> {
    if !valid_id(&input.id)
        || !valid_id(&input.team_id)
        || input.expected_revision >= i64::MAX as u64
        || serde_json::to_vec(&input)?.len() > 65536
    {
        bail!("invalid team policy");
    }
    match &mut input.policy {
        Policy::Budget {
            budget_ids,
            unit,
            max_assignment_charge,
            settlement,
        } => {
            if settlement
                .as_deref()
                .is_some_and(|s| !matches!(s, "reconciled" | "internal_price"))
            {
                bail!("invalid budget settlement policy")
            }
            budget_ids.sort();
            if budget_ids.is_empty()
                || budget_ids.len() > 8
                || budget_ids.iter().any(|id| !valid_id(id))
                || budget_ids.windows(2).any(|w| w[0] == w[1])
                || !valid_id(unit)
                || *max_assignment_charge == 0
                || *max_assignment_charge > 4_000_000_000_000_000
            {
                bail!("invalid budget policy bounds");
            }
        }
        Policy::Scheduling {
            targets,
            weights,
            minimum_quality,
            minimum_confidence,
        } => {
            if targets.is_empty()
                || targets.len() > 64
                || *minimum_quality > 100
                || !minimum_confidence.is_finite()
                || !(0.0..=1.0).contains(minimum_confidence)
                || [weights.quality, weights.cost, weights.latency]
                    .iter()
                    .any(|w| *w > 1000)
                || u32::from(weights.quality) + u32::from(weights.cost) + u32::from(weights.latency)
                    == 0
            {
                bail!("invalid scheduling policy bounds");
            }
            for (id, candidate) in targets {
                if !valid_id(id)
                    || !valid_id(&candidate.capability_id)
                    || candidate
                        .internal_price_id
                        .as_ref()
                        .is_some_and(|id| !valid_id(id))
                    || candidate.capability_revision == 0
                    || candidate.capability_revision > i64::MAX as u64
                {
                    bail!("invalid scheduling candidate");
                }
                candidate.resource.validate()?;
                candidate.resource.limit_ids.sort();
            }
        }
    }
    let revision = input.expected_revision + 1;
    let normalized =
        json!({"id":input.id,"team_id":input.team_id,"revision":revision,"policy":input.policy});
    let hash = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "kode.team.policy.v1\n{}",
                serde_json::to_string(&normalized)?
            )
            .as_bytes()
        )
    );
    let row = json!({"schema_version":1,"id":input.id,"team_id":input.team_id,"revision":revision,"policy":input.policy,
            "hash":hash,"hash_format":"kode.team.policy.v1","home_hub":node_id,"recorded_at":now(),
            "actor":{"kind":"human","id":"local_owner"},"eligible_for_execution":false});
    // Historical retries remain exact even after newer revisions exist.
    if let Some(prior) = read(tx, &input.id, Some(revision))? {
        if prior["hash"] != hash {
            bail!("team policy revision conflict");
        }
        return Ok(prior);
    }
    let current = read(tx, &input.id, None)?;
    if current
        .as_ref()
        .and_then(|r| r["revision"].as_u64())
        .unwrap_or(0)
        != input.expected_revision
    {
        bail!("team policy revision conflict");
    }
    if current.as_ref().is_some_and(|r| {
        r["team_id"] != input.team_id || r["policy"]["kind"] != row["policy"]["kind"]
    }) {
        bail!("team policy owner and kind are immutable");
    }
    // Validate actual configured budget identities, but never treat current availability as a reservation.
    if let Policy::Budget {
        budget_ids,
        unit,
        max_assignment_charge,
        ..
    } = &input.policy
    {
        for id in budget_ids {
            let body: Option<String> = tx
                .query_row("SELECT body FROM budgets WHERE id=?1", [id], |r| r.get(0))
                .optional()?;
            let budget: super::budgets::Budget = serde_json::from_str(
                &body.ok_or_else(|| anyhow::anyhow!("unknown policy budget"))?,
            )?;
            if budget.unit != *unit
                || (budget.scope == super::budgets::Scope::Team && budget.scope_id != input.team_id)
                || budget.limit < *max_assignment_charge
            {
                bail!("budget policy scope, unit or charge ceiling mismatch");
            }
        }
    }
    let body = serde_json::to_string(&row)?;
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3)",
        params![key(&input.id, Some(revision)), revision, body],
    )?;
    tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value",params![key(&input.id,None),revision,body])?;
    Ok(row)
}
impl Store {
    pub(super) fn resolve_team_policies(
        &self,
        team_id: &str,
        spec: &super::teams::Spec,
    ) -> Result<(Value, Vec<Value>)> {
        let mut resolved = json!({});
        let mut issues = Vec::new();
        for (kind, id) in [
            ("budget", &spec.budget_policy_id),
            ("scheduling", &spec.scheduling_policy_id),
        ] {
            let Some(id) = id else {
                issues.push(json!({"code":"team_policy_required","kind":kind}));
                continue;
            };
            let Some(row) = self.team_policy(id, None)? else {
                issues.push(json!({"code":"team_policy_missing","kind":kind,"id":id}));
                continue;
            };
            if row["team_id"] != team_id || row["policy"]["kind"] != kind {
                issues.push(json!({"code":"team_policy_identity_mismatch","kind":kind,"id":id}));
                continue;
            }
            let policy: Policy = serde_json::from_value(row["policy"].clone())?;
            if let Policy::Scheduling { targets, .. } = policy {
                for target in &spec.execution_targets {
                    match targets.get(&target.id) {
                        None => issues
                            .push(json!({"code":"target_policy_missing","target_id":target.id})),
                        Some(candidate)
                            if candidate.resource.host != target.host_id
                                || candidate.resource.profile != target.executor_profile_id
                                || candidate.resource.account_id != target.account_binding_id
                                || candidate.capability_revision.to_string()
                                    != target.capability_profile_revision =>
                        {
                            issues.push(json!({"code":"target_policy_identity_mismatch","target_id":target.id}));
                        }
                        _ => {}
                    }
                }
                for target in &spec.execution_targets {
                    if let Some(price_id) = targets
                        .get(&target.id)
                        .and_then(|candidate| candidate.internal_price_id.as_ref())
                    {
                        match self.price(price_id)? {
                            None => issues.push(json!({"code":"target_price_missing","target_id":target.id,"price_id":price_id})),
                            Some(price) => {
                                if price.model != target.model_id || json!(price.unit) != resolved["budget"]["policy"]["unit"] {
                                    issues.push(json!({"code":"target_price_identity_mismatch","target_id":target.id,"price_id":price_id}));
                                }
                                if resolved["budget"]["policy"]["settlement"] != "internal_price" {
                                    issues.push(json!({"code":"target_price_settlement_mismatch","target_id":target.id}));
                                }
                            }
                        }
                    }
                }
                for id in targets.keys() {
                    if !spec.execution_targets.iter().any(|t| &t.id == id) {
                        issues.push(json!({"code":"target_policy_outside_team","target_id":id}));
                    }
                }
            }
            resolved[kind] = row;
        }
        Ok((resolved, issues))
    }
    pub fn team_policy(&self, id: &str, revision: Option<u64>) -> Result<Option<Value>> {
        if !valid_id(id) || revision.is_some_and(|r| r == 0 || r > i64::MAX as u64) {
            bail!("invalid team policy reference");
        }
        read(&self.db.lock(), id, revision)
    }
    pub fn write_team_policy(&self, input: Write) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = write_in(&tx, input, &self.node_id)?;
        tx.commit()?;
        Ok(result)
    }
}
