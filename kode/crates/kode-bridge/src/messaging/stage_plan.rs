//! Derive a stage's exact candidate envelopes from frozen run authority, never from caller tool lists.
use super::{
    model::{now, valid_id},
    store::Store,
    team_activation,
    team_policies::Policy,
    teams::Spec,
    workflows::Pack,
};
use anyhow::{bail, Result};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

impl Store {
    pub fn work_run_stage_plan(&self, id: &str, stage_id: &str) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let plan = plan_in(&tx, id, stage_id, now())?;
        tx.commit()?;
        Ok(plan)
    }
}

/// Shared with dispatch transactions: all authoritative reads use the caller's snapshot.
/// The result remains a candidate plan, never an admission or reservation receipt.
pub(super) fn plan_in(db: &Connection, id: &str, stage_id: &str, at: u64) -> Result<Value> {
    if !valid_id(id) || !valid_id(stage_id) {
        bail!("invalid stage plan identity")
    }
    let body: Option<String> = db
        .query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    let run: Value =
        serde_json::from_str(&body.ok_or_else(|| anyhow::anyhow!("unknown work run"))?)?;
    let pack: Pack = serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
    let stage = pack
        .stages
        .iter()
        .find(|s| s.id == stage_id)
        .ok_or_else(|| anyhow::anyhow!("unknown workflow stage"))?;
    let team_id = run["team_id"].as_str().unwrap();
    let spec: Spec = serde_json::from_value(run["context"]["team"]["spec"].clone())?;
    let mut issues = Vec::new();
    let mut candidates = Vec::new();
    let live =
        team_activation::authorized(db, team_id, run["team_revision"].as_u64().unwrap(), at)?;
    if !matches!(
        run["state"].as_str(),
        Some("waiting_resource" | "queued" | "running")
    ) {
        issues.push(json!({"code":"run_not_schedulable"}));
    }
    if run["authorization"].is_null()
        || live
            .as_ref()
            .is_none_or(|a| a["snapshot_hash"] != run["authorization"]["snapshot_hash"])
    {
        issues.push(json!({"code":"run_authority_unavailable"}));
    }
    let stages = run["stages"].as_array().unwrap();
    let state = stages
        .iter()
        .find(|s| s["stage_id"] == stage_id)
        .ok_or_else(|| anyhow::anyhow!("stage state missing"))?;
    if !matches!(state["state"].as_str(), Some("pending" | "ready"))
        || !state["assignment_id"].is_null()
    {
        issues.push(json!({"code":"stage_not_unassigned"}));
    }
    for dependency in &stage.requires {
        let satisfied = if pack.inputs.contains(dependency) {
            !run["inputs"][dependency].is_null()
        } else {
            super::stage_waiver::dependency_satisfied(db, &run, &pack, dependency, at)?
        };
        if !satisfied {
            issues.push(json!({"code":"stage_dependency_pending","dependency":dependency}));
        }
    }
    let Some(scope) = &stage.execution else {
        issues.push(json!({"code":"stage_execution_scope_missing"}));
        return Ok(
            json!({"run_id":id,"run_revision":run["revision"],"run_state":run["state"],"context_hash":run["context_hash"],"authorization_hash":run["authorization"]["snapshot_hash"],"stage_id":stage_id,"issues":issues,"candidates":[],"eligible_for_dispatch":false}),
        );
    };
    if issues.is_empty() {
        let repository = &run["context"]["binding"]["project"]["config"]["spec"]["repositories"]
            [&scope.repository_binding];
        let workspace: super::teams::WorkspaceRef =
            serde_json::from_value(repository["workspace"].clone())?;
        let authorization = &run["authorization"]["snapshot"];
        let budget: Policy =
            serde_json::from_value(authorization["policies"]["budget"]["policy"].clone())?;
        let scheduling: Policy =
            serde_json::from_value(authorization["policies"]["scheduling"]["policy"].clone())?;
        let Policy::Budget {
            budget_ids,
            unit,
            max_assignment_charge,
            ..
        } = budget
        else {
            bail!("frozen budget policy mismatch")
        };
        let Policy::Scheduling {
            targets,
            weights,
            minimum_quality,
            minimum_confidence,
        } = scheduling
        else {
            bail!("frozen scheduling policy mismatch")
        };
        let (rework_count, escalation) = super::stage_escalation::selected(scope, &run, stage_id);
        let task_tag = escalation.map(|rule| &rule.task_tag).or(scope.task_tag.as_ref());
        let minimum_quality = escalation.map_or(minimum_quality, |rule| minimum_quality.max(rule.minimum_quality));
        let mut roles: Vec<(Option<&str>, &Vec<String>)> = Vec::new();
        if stage.role == "coordinator" {
            roles.push((None, &spec.coordinator_targets));
        }
        for worker in &spec.workers {
            if worker.role != stage.role {
                continue;
            }
            if !worker.workspace_refs.iter().any(|w| {
                w.host_id == workspace.host_id
                    && w.workspace_id == workspace.workspace_id
                    && w.root_ref == workspace.root_ref
            }) {
                issues.push(json!({"code":"worker_workspace_denied","worker_id":worker.id}));
                continue;
            }
            roles.push((Some(&worker.id), &worker.allowed_target_ids));
        }
        for (worker_id, allowed) in roles {
            for id in allowed {
                let target = spec.execution_targets.iter().find(|t| &t.id == id).unwrap();
                let Some(profile_revision) = &target.executor_profile_revision else {
                    issues.push(json!({"code":"executor_profile_revision_missing","target_id":id}));
                    continue;
                };
                if target.host_id != workspace.host_id {
                    issues.push(json!({"code":"target_workspace_host_mismatch","target_id":id}));
                    continue;
                }
                if super::workflow_dependencies::for_stage(&run["context"]["binding"], stage, &target.host_id).is_err() {
                    issues.push(json!({"code":"workflow_dependency_host_unavailable","stage_id":stage.id,"target_id":id}));
                    continue;
                }
                let rule = targets
                    .get(id)
                    .ok_or_else(|| anyhow::anyhow!("frozen target policy missing"))?;
                let mut candidate = json!({"worker_id":worker_id,"target_id":id,"executor_profile_id":target.executor_profile_id,
                        "selection_policy":{"profile_revision":profile_revision,"model":target.model_id,"effort":target.effort,"scope":"executor_configuration"},
                        "provider_id":target.provider_id,"resource":rule.resource,"preferred":rule.preferred,
                        "scheduling":{"weights":weights,"minimum_quality":minimum_quality,"minimum_confidence":minimum_confidence},
                        "team_limits":spec.limits,
                        "capability_profile":{"id":rule.capability_id,"revision":rule.capability_revision},
                        "funding":{"budget_ids":budget_ids,"unit":unit,"amount":max_assignment_charge},
                        "grant_id":authorization["grant"]["policy"]["id"],
                        "grant_scope":{"team_id":team_id,"revision":authorization["grant"]["revision"],
                            "target":{"host":workspace.host_id,"workspace":workspace.workspace_id,"root":workspace.root_ref},
                            "capabilities":scope.capabilities,"tools":scope.tools,"network":scope.network,"budget_ids":budget_ids},
                        "independent_from":stage.independent_from,"eligible_for_dispatch":false});
                if let Some(price_id) = &rule.internal_price_id {
                    let body: Option<String> = db
                        .query_row(
                            "SELECT body FROM price_versions WHERE id=?1",
                            [price_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    let price: Option<super::pricing::Price> =
                        body.map(|body| serde_json::from_str(&body)).transpose()?;
                    match price {
                        Some(price)
                            if price.model == target.model_id
                                && price.unit == unit
                                && authorization["policies"]["budget"]["policy"]["settlement"]
                                    == "internal_price" =>
                        {
                            candidate["internal_price"] = serde_json::to_value(price)?;
                        }
                        _ => {
                            issues.push(json!({"code":"frozen_target_price_unavailable","target_id":id,"price_id":price_id}));
                            continue;
                        }
                    }
                }
                if let Some(tag) = task_tag {
                    let ranking = super::resource_rank::rank_in(
                        db,
                        serde_json::from_value(json!({
                            "task_tag":tag,"minimum_quality":minimum_quality,"minimum_confidence":minimum_confidence,
                            "weights":weights,"candidates":[{"capability_id":rule.capability_id,"capability_revision":rule.capability_revision,
                            "model":target.model_id,"resource":rule.resource,"preferred":rule.preferred}]
                        }))?,
                        at,
                    )?;
                    let recommended = !ranking["candidates"].as_array().unwrap().is_empty();
                    candidate["recommendation"] = json!({"task_tag":tag,"recommended":recommended,
                            "evaluated_at":at,"escalation":escalation.map(|rule| json!({"after_reworks":rule.after_reworks,"observed_reworks":rework_count,"task_tag":rule.task_tag,"minimum_quality":minimum_quality})),"assessment": if recommended { &ranking["candidates"][0] } else { &ranking["excluded"][0] }});
                } else {
                    candidate["recommendation"] =
                        json!({"recommended":false,"reason":"stage_task_tag_missing"});
                }
                candidates.push(candidate);
            }
        }
        if candidates.is_empty() {
            issues.push(json!({"code":"no_configured_stage_candidate"}));
        }
    }
    Ok(
        json!({"run_id":id,"run_revision":run["revision"],"run_state":run["state"],"stage_id":stage_id,"context_hash":run["context_hash"],
            "authorization_hash":run["authorization"]["snapshot_hash"],"issues":issues,"candidates":candidates,
            "eligible_for_dispatch":false,"pending_checks":["live_executor_discovery","trusted_tool_policies","selection_capabilities",
                "quality_floor","resource_and_budget_admission","runtime_independence","atomic_assignment_and_dispatch"]}),
    )
}
