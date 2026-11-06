//! Trusted execution Host estimates only its assigned attempt's frozen reservation.
use super::{
    model::*,
    pricing::{Attribution, Usage},
    Hub,
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accounting {
    pub attempt: u64,
    pub action: Action,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Context,
    AssignmentClarification {
        assignment_id: String,
        observation: super::assignment_clarification::Record,
    },
    AssignmentClarificationRead {
        assignment_id: String,
        request_id: String,
    },
    AssignmentContext {
        assignment_id: String,
    },
    AssignmentWorkspaceReceipt {
        assignment_id: String,
        receipt: super::assignment_workspace::Receipt,
    },
    AssignmentTaskWorkspacePrepare {
        assignment_id: String,
        receipt: super::assignment_task_prepare::Prepare,
    },
    AssignmentTaskWorkspace {
        assignment_id: String,
        receipt: super::assignment_task_workspace::Receipt,
    },
    AssignmentArchiveRead {
        assignment_id: String,
        sequence: u64,
        offset: Option<usize>,
    },
    AssignmentRunContext {
        assignment_id: String,
    },
    AssignmentOutputs {
        assignment_id: String,
        declaration: super::assignment_outputs::Declare,
    },
    AssignmentStop {
        assignment_id: String,
        receipt: super::assignment_stop::Receipt,
    },
    AssignmentCreation {
        assignment_id: String,
        receipt: super::assignment_dispatch::Receipt,
    },
    AssignmentAdmission {
        assignment_id: String,
        admission: super::assignment_admission::Admit,
    },
    GrantContext,
    SelectionEvidence {
        evidence: super::selection_evidence::Evidence,
    },
    VerificationSegment {
        sequence: u64,
        segment: super::verification_record::Segment,
    },
    VerificationComplete {
        sequence: u64,
        record_hash: String,
    },
    ArtifactArchiveSegment {
        sequence: u64,
        index: usize,
        offset: usize,
        chunk: super::artifact_archive::Chunk,
    },
    ArtifactArchiveComplete {
        sequence: u64,
        identity: super::artifact_archive::Identity,
    },
    ArtifactEvidence {
        evidence: super::artifact_evidence::Evidence,
    },
    ToolEvidence {
        evidence: super::tool_evidence::Evidence,
    },
    OfficialBegin {
        request: super::official_calls::Begin,
    },
    OfficialRead {
        call_id: String,
    },
    OfficialEvent {
        call_id: String,
        event: super::official_calls::Evidence,
    },
    ResourceContext,
    MonetaryContext,
    MonetaryQuota {
        observation: super::monetary_quota::Observation,
    },
    Quota {
        sample: super::quota::Sample,
    },
    InvalidateQuota,
    Receipt {
        event_id: String,
    },
    Usage {
        usage: Usage,
    },
}
impl Accounting {
    pub(super) fn requires_assignment_task_workspace(&self) -> bool {
        matches!(self.action, Action::AssignmentTaskWorkspace { .. } | Action::AssignmentTaskWorkspacePrepare { .. })
    }
    pub(super) fn requires_assignment_workspace(&self) -> bool {
        matches!(self.action, Action::AssignmentWorkspaceReceipt { .. })
    }
    pub(super) fn requires_assignment_archive(&self) -> bool {
        matches!(self.action, Action::AssignmentArchiveRead { .. })
    }
    pub(super) fn requires_verification_archive(&self) -> bool {
        matches!(
            self.action,
            Action::VerificationSegment { .. } | Action::VerificationComplete { .. }
        )
    }
    pub(super) fn requires_archive_capability(&self) -> bool {
        matches!(
            self.action,
            Action::ArtifactArchiveSegment { .. } | Action::ArtifactArchiveComplete { .. }
        )
    }
    pub(super) fn requires_assignment_outputs_capability(&self) -> bool {
        matches!(self.action, Action::AssignmentOutputs { .. })
    }
    pub(super) fn requires_assignment_clarification_capability(&self) -> bool {
        matches!(self.action, Action::AssignmentClarification { .. } | Action::AssignmentClarificationRead { .. })
    }
    pub(super) fn requires_assignment_run_capability(&self) -> bool {
        matches!(self.action, Action::AssignmentRunContext { .. })
    }
    pub(super) fn requires_assignment_stop_capability(&self) -> bool {
        matches!(self.action, Action::AssignmentStop { .. })
    }
    pub(super) fn requires_assignment_admission_capability(&self) -> bool {
        matches!(self.action, Action::AssignmentAdmission { .. })
    }
    pub(super) fn requires_assignment_creation_capability(&self) -> bool {
        matches!(self.action, Action::AssignmentCreation { .. })
    }
    pub(super) fn requires_assignment_capability(&self) -> bool {
        matches!(
            self.action,
            Action::AssignmentContext { .. }
                | Action::AssignmentClarification { .. }
                | Action::AssignmentClarificationRead { .. }
                | Action::AssignmentWorkspaceReceipt { .. }
                | Action::AssignmentTaskWorkspacePrepare { .. }
                | Action::AssignmentTaskWorkspace { .. }
                | Action::AssignmentArchiveRead { .. }
                | Action::AssignmentRunContext { .. }
                | Action::AssignmentOutputs { .. }
                | Action::AssignmentStop { .. }
                | Action::AssignmentCreation { .. }
                | Action::AssignmentAdmission { .. }
        )
    }
    pub(super) fn requires_artifact_capability(&self) -> bool {
        matches!(
            self.action,
            Action::ArtifactEvidence { .. }
                | Action::VerificationSegment { .. }
                | Action::VerificationComplete { .. }
                | Action::ArtifactArchiveSegment { .. }
                | Action::ArtifactArchiveComplete { .. }
        )
    }
    pub(super) fn requires_monetary_capability(&self) -> bool {
        matches!(
            self.action,
            Action::MonetaryContext | Action::MonetaryQuota { .. }
        )
    }
    pub(super) fn requires_selection_capability(&self) -> bool {
        matches!(self.action, Action::SelectionEvidence { .. })
    }
    pub(super) fn requires_grant_capability(&self) -> bool {
        matches!(self.action, Action::GrantContext)
    }
    pub(super) fn requires_tool_capability(&self) -> bool {
        matches!(self.action, Action::ToolEvidence { .. })
    }
    pub(super) fn requires_official_capability(&self) -> bool {
        matches!(
            self.action,
            Action::OfficialBegin { .. }
                | Action::OfficialRead { .. }
                | Action::OfficialEvent { .. }
        )
    }

    pub(super) fn requires_quota_capability(&self) -> bool {
        matches!(
            self.action,
            Action::ResourceContext
                | Action::MonetaryContext
                | Action::MonetaryQuota { .. }
                | Action::Quota { .. }
                | Action::InvalidateQuota
        )
    }
    pub(super) fn validate(&self) -> Result<()> {
        if serde_json::to_vec(self)?.len() > 65536 {
            bail!("accounting envelope exceeds transport limit")
        }
        if self.attempt == 0 {
            bail!("invalid accounting attempt")
        }
        match &self.action {
            Action::AssignmentContext { assignment_id }
            | Action::AssignmentClarification { assignment_id, .. }
            | Action::AssignmentClarificationRead { assignment_id, .. }
            | Action::AssignmentAdmission { assignment_id, .. }
            | Action::AssignmentWorkspaceReceipt { assignment_id, .. }
            | Action::AssignmentTaskWorkspacePrepare { assignment_id, .. }
            | Action::AssignmentTaskWorkspace { assignment_id, .. }
            | Action::AssignmentArchiveRead { assignment_id, .. }
            | Action::AssignmentRunContext { assignment_id }
            | Action::AssignmentOutputs { assignment_id, .. }
            | Action::AssignmentStop { assignment_id, .. }
            | Action::AssignmentCreation { assignment_id, .. }
                if !valid_id(assignment_id) =>
            {
                bail!("invalid Assignment context identity")
            }
            Action::Receipt { event_id } if !valid_id(event_id) => {
                bail!("invalid accounting event")
            }
            Action::Usage { usage }
                if !valid_id(&usage.event_id)
                    || !valid_id(&usage.reservation_id)
                    || usage.model.len() > 256 =>
            {
                bail!("invalid remote usage")
            }
            _ => Ok(()),
        }
    }
}
impl Hub {
    // Caller already checked authenticated execution peer and assigned worker.
    pub(super) fn receive_accounting(
        &self,
        operation: &str,
        accounting: Accounting,
    ) -> Result<Value> {
        if let Action::AssignmentContext { assignment_id }
        | Action::AssignmentClarification { assignment_id, .. }
        | Action::AssignmentClarificationRead { assignment_id, .. }
        | Action::AssignmentAdmission { assignment_id, .. }
        | Action::AssignmentWorkspaceReceipt { assignment_id, .. }
        | Action::AssignmentTaskWorkspacePrepare { assignment_id, .. }
            | Action::AssignmentTaskWorkspace { assignment_id, .. }
        | Action::AssignmentArchiveRead { assignment_id, .. }
        | Action::AssignmentRunContext { assignment_id }
        | Action::AssignmentOutputs { assignment_id, .. }
        | Action::AssignmentStop { assignment_id, .. }
        | Action::AssignmentCreation { assignment_id, .. } = &accounting.action
        {
            let assignment = self
                .store
                .work_assignment(assignment_id)?
                .ok_or_else(|| anyhow::anyhow!("unknown Assignment"))?;
            let op = self
                .store
                .operation(operation)?
                .ok_or_else(|| anyhow::anyhow!("unknown operation"))?;
            if assignment["bundle"]["operation"]["id"] != operation
                || assignment["dispatch"]["command"]["operation"]["attempt"] != accounting.attempt
                || op.attempt != accounting.attempt
                || assignment["worker"] != serde_json::to_value(&op.worker)?
            {
                bail!("foreign Assignment operation or attempt")
            }
            if let Action::AssignmentClarification { observation, .. } = &accounting.action {
                return self.store.record_assignment_clarification(&op.worker.node_id, assignment_id, observation.clone());
            }
            if let Action::AssignmentClarificationRead { request_id, .. } = &accounting.action {
                return Ok(json!({"clarification": self.store.assignment_clarification(assignment_id, request_id)?}));
            }
            if let Action::AssignmentTaskWorkspacePrepare { receipt, .. } = &accounting.action {
                return self.store.prepare_assignment_task_workspace_from(&op.worker.node_id, assignment_id, receipt.clone());
            }
            if let Action::AssignmentTaskWorkspace { receipt, .. } = &accounting.action {
                return self.store.assignment_task_workspace_from(&op.worker.node_id, assignment_id, receipt.clone());
            }
            if let Action::AssignmentWorkspaceReceipt { receipt, .. } = &accounting.action {
                return self.store.assignment_workspace_receipt_from(
                    &op.worker.node_id,
                    assignment_id,
                    receipt.clone(),
                );
            }
            if let Action::AssignmentArchiveRead {
                sequence, offset, ..
            } = &accounting.action
            {
                return self
                    .store
                    .assignment_artifact_segment(&assignment, *sequence, *offset);
            }
            if matches!(accounting.action, Action::AssignmentRunContext { .. }) {
                let run = self
                    .store
                    .work_run(
                        assignment["run_id"]
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("Assignment run missing"))?,
                    )?
                    .ok_or_else(|| anyhow::anyhow!("unknown WorkRun"))?;
                if run["context_hash"] != assignment["context_hash"]
                    || run["authorization"]["snapshot_hash"] != assignment["authorization_hash"]
                {
                    bail!("Assignment run context mismatch")
                }
                if serde_json::to_vec(&run)?.len() > 65536 {
                    bail!("Assignment run context exceeds relay limit")
                }
                return Ok(run);
            }
            if let Action::AssignmentOutputs { declaration, .. } = &accounting.action {
                return self.store.declare_assignment_outputs(
                    &op.worker.node_id,
                    assignment_id,
                    declaration.clone(),
                );
            }
            if let Action::AssignmentStop { receipt, .. } = &accounting.action {
                return self.store.assignment_stop_receipt_from(
                    &op.worker.node_id,
                    assignment_id,
                    receipt.clone(),
                );
            }
            if let Action::AssignmentAdmission { admission, .. } = &accounting.action {
                return self.store.admit_work_assignment_from(
                    &op.worker.node_id,
                    assignment_id,
                    admission.clone(),
                );
            }
            if let Action::AssignmentCreation { receipt, .. } = &accounting.action {
                return self.store.assignment_creation_receipt_from(
                    &op.worker.node_id,
                    assignment_id,
                    receipt.clone(),
                );
            }
            if serde_json::to_vec(&assignment)?.len() > 65536 {
                bail!("Assignment context exceeds relay limit")
            }
            return Ok(assignment);
        }
        if matches!(accounting.action, Action::GrantContext) {
            let context = self.store.operation_grant_context(operation, now())?;
            if context["attempt"].as_u64() != Some(accounting.attempt) {
                bail!("foreign grant attempt")
            }
            return Ok(context);
        }
        if let Action::SelectionEvidence { evidence } = &accounting.action {
            if evidence.operation_id != operation || evidence.attempt != accounting.attempt {
                bail!("foreign selection evidence envelope")
            }
            return self.store.record_selection_evidence(evidence.clone());
        }
        if let Action::VerificationSegment { sequence, segment } = &accounting.action {
            return self.store.remote_verification_segment(
                operation,
                accounting.attempt,
                *sequence,
                segment.clone(),
            );
        }
        if let Action::VerificationComplete {
            sequence,
            record_hash,
        } = &accounting.action
        {
            return self.store.complete_remote_verification(
                operation,
                accounting.attempt,
                *sequence,
                record_hash,
            );
        }
        if let Action::ArtifactArchiveSegment {
            sequence,
            index,
            offset,
            chunk,
        } = &accounting.action
        {
            return self.store.put_remote_artifact_segment(
                operation,
                accounting.attempt,
                *sequence,
                *index,
                *offset,
                chunk.clone(),
            );
        }
        if let Action::ArtifactArchiveComplete { sequence, identity } = &accounting.action {
            return self.store.complete_remote_artifact_archive(
                operation,
                accounting.attempt,
                *sequence,
                identity.clone(),
            );
        }
        if let Action::ArtifactEvidence { evidence } = &accounting.action {
            if evidence.operation_id != operation || evidence.attempt != accounting.attempt {
                bail!("foreign artifact evidence envelope");
            }
            return self.store.record_artifact_evidence(evidence.clone());
        }
        if let Action::ToolEvidence { evidence } = &accounting.action {
            if evidence.operation_id != operation || evidence.attempt != accounting.attempt {
                bail!("foreign tool evidence envelope")
            }
            return self.store.record_tool_evidence(evidence.clone());
        }
        if accounting.requires_official_capability() {
            return match accounting.action {
                Action::OfficialBegin { request } => {
                    let op = self
                        .store
                        .operation(operation)?
                        .ok_or_else(|| anyhow::anyhow!("unknown operation"))?;
                    if request.operation_id != operation
                        || request.attempt != accounting.attempt
                        || request.worker_session != op.worker.session_id
                    {
                        bail!("foreign official call begin")
                    }
                    Ok(serde_json::to_value(
                        self.store.begin_official_call(request, now())?,
                    )?)
                }
                Action::OfficialRead { ref call_id }
                | Action::OfficialEvent { ref call_id, .. } => {
                    let call = self
                        .store
                        .official_call(&call_id)?
                        .ok_or_else(|| anyhow::anyhow!("unknown official call"))?;
                    if call.request.operation_id != operation
                        || call.request.attempt != accounting.attempt
                    {
                        bail!("foreign official call")
                    }
                    if let Action::OfficialEvent { event, .. } = accounting.action {
                        Ok(serde_json::to_value(
                            self.store.record_official_call(&call_id, event)?,
                        )?)
                    } else {
                        Ok(serde_json::to_value(call)?)
                    }
                }
                _ => unreachable!(),
            };
        }
        if accounting.requires_quota_capability() {
            let policy = self
                .store
                .operation_resource(operation, accounting.attempt)?
                .ok_or_else(|| anyhow::anyhow!("unknown attempt resource binding"))?;
            return match accounting.action {
                Action::MonetaryContext | Action::MonetaryQuota { .. } => {
                    let op = self
                        .store
                        .operation(operation)?
                        .ok_or_else(|| anyhow::anyhow!("unknown operation"))?;
                    if op.attempt != accounting.attempt {
                        bail!("stale monetary collector attempt")
                    }
                    if let Action::MonetaryQuota { observation } = accounting.action {
                        if observation.host != policy.host
                            || observation.profile != policy.profile
                            || observation.account_id != policy.account_id
                            || observation.account_epoch != policy.account_epoch
                            || observation.binding_revision != policy.binding_revision
                            || !policy
                                .monetary
                                .iter()
                                .any(|requirement| requirement.source == observation.source)
                        {
                            bail!("foreign monetary resource or source")
                        }
                        self.store.record_monetary_quota(observation)
                    } else {
                        Ok(
                            json!({"policy":policy,"binding":self.store.resource_binding(&policy.host,&policy.profile)?,"monetary":self.store.monetary_quota(&policy.host,&policy.profile)?}),
                        )
                    }
                }
                Action::ResourceContext => Ok(
                    json!({"policy":policy,"binding":self.store.resource_binding(&policy.host,&policy.profile)?,"quota":self.store.quota_snapshot(&policy.host,&policy.profile,now())?}),
                ),
                Action::Quota { sample } => {
                    if sample.host != policy.host
                        || sample.profile != policy.profile
                        || sample.account_id != policy.account_id
                        || sample.account_epoch != policy.account_epoch
                        || sample.binding_revision != policy.binding_revision
                    {
                        bail!("foreign quota resource")
                    }
                    self.store.record_quota(sample, now())
                }
                Action::InvalidateQuota => {
                    self.store
                        .invalidate_resource_binding(super::resources::InvalidateBinding {
                            host: policy.host,
                            profile: policy.profile,
                            expected_revision: policy.binding_revision,
                        })
                }
                _ => unreachable!(),
            };
        }
        let context = self
            .store
            .operation_accounting(operation, accounting.attempt)?
            .ok_or_else(|| anyhow::anyhow!("unknown attempt accounting binding"))?;
        let reservation = context["reservation"]["request"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid accounting binding"))?;
        match accounting.action {
            Action::AssignmentAdmission { .. }
            | Action::AssignmentWorkspaceReceipt { .. }
            | Action::AssignmentTaskWorkspacePrepare { .. }
                | Action::AssignmentTaskWorkspace { .. }
            | Action::AssignmentArchiveRead { .. }
            | Action::AssignmentRunContext { .. }
            | Action::AssignmentOutputs { .. }
            | Action::AssignmentStop { .. }
            | Action::AssignmentCreation { .. }
            | Action::AssignmentContext { .. }
            | Action::AssignmentClarification { .. }
            | Action::AssignmentClarificationRead { .. }
            | Action::GrantContext
            | Action::SelectionEvidence { .. }
            | Action::VerificationSegment { .. }
            | Action::VerificationComplete { .. }
            | Action::ArtifactArchiveSegment { .. }
            | Action::ArtifactArchiveComplete { .. }
            | Action::ArtifactEvidence { .. }
            | Action::ToolEvidence { .. }
            | Action::OfficialBegin { .. }
            | Action::OfficialRead { .. }
            | Action::OfficialEvent { .. }
            | Action::ResourceContext
            | Action::MonetaryContext
            | Action::MonetaryQuota { .. }
            | Action::Quota { .. }
            | Action::InvalidateQuota => {
                unreachable!()
            }
            Action::Context => Ok(context),
            Action::Receipt { event_id } => {
                let receipt = self.store.usage_receipt(&event_id)?;
                if receipt
                    .as_ref()
                    .is_some_and(|r| r["usage"]["reservation_id"].as_str() != Some(reservation))
                {
                    bail!("foreign usage receipt")
                }
                Ok(json!({"receipt":receipt}))
            }
            Action::Usage { usage } => {
                if usage.reservation_id != reservation {
                    bail!("foreign usage reservation")
                }
                // Remote Host cannot attest a supplier invoice or claim administrator verification.
                if !matches!(usage.attribution, Attribution::RequestedModel { .. }) {
                    bail!("remote usage requires explicit internal attribution")
                }
                self.store.record_usage(usage, now())
            }
        }
    }
}
