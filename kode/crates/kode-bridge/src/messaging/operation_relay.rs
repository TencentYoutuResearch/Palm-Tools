//! Remote workers call the sole home ledger through authenticated Host links.
//! A command is sent at most once per relay request, including reconnects.
use super::{
    model::*,
    operations::{Action, Command},
    Hub,
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub worker_session: String,
    pub command: Option<Command>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounting: Option<super::accounting_relay::Accounting>,
}
pub(super) struct Pending {
    pub node: String,
    pub request: Request,
    pub sent: bool,
    pub result: tokio::sync::oneshot::Sender<std::result::Result<Value, String>>,
}
impl Request {
    pub(super) fn requires_assignment_task_workspace(&self) -> bool {
        self.accounting.as_ref().is_some_and(|a| a.requires_assignment_task_workspace())
    }
    pub(super) fn requires_assignment_workspace(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_workspace())
    }
    pub(super) fn requires_assignment_archive(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_archive())
    }
    pub(super) fn requires_verification_archive(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_verification_archive())
    }
    pub(super) fn requires_archive_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_archive_capability())
    }
    pub(super) fn requires_assignment_outputs_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_outputs_capability())
    }
    pub(super) fn requires_assignment_clarification_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_clarification_capability())
    }
    pub(super) fn requires_assignment_run_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_run_capability())
    }
    pub(super) fn requires_assignment_stop_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_stop_capability())
    }
    pub(super) fn requires_assignment_admission_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_admission_capability())
    }
    pub(super) fn requires_assignment_creation_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_creation_capability())
    }
    pub(super) fn requires_assignment_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_assignment_capability())
    }
    pub(super) fn requires_monetary_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_monetary_capability())
    }
    pub(super) fn requires_selection_capability(&self) -> bool {
        self.command
            .as_ref()
            .is_some_and(|c| c.selection_ack.is_some())
            || self
                .accounting
                .as_ref()
                .is_some_and(|a| a.requires_selection_capability())
    }
    pub(super) fn requires_grant_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_grant_capability())
    }
    pub(super) fn requires_artifact_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_artifact_capability())
    }
    pub(super) fn requires_tool_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_tool_capability())
    }
    pub(super) fn requires_official_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_official_capability())
    }
    pub(super) fn requires_quota_capability(&self) -> bool {
        self.accounting
            .as_ref()
            .is_some_and(|a| a.requires_quota_capability())
    }
    pub(super) fn requires_resource_capability(&self) -> bool {
        self.command.as_ref().is_some_and(|c| {
            matches!(
                c.action,
                Action::ClaimResource { .. } | Action::RenewResource { .. }
            )
        })
    }
    pub(super) fn validate(&self) -> Result<()> {
        if !valid_id(&self.operation_id) || !valid_id(&self.worker_session) {
            bail!("invalid operation relay identity")
        }
        if self.accounting.is_some() && self.command.is_some() {
            bail!("mixed accounting and execution command")
        }
        if let Some(accounting) = &self.accounting {
            accounting.validate()?;
        }
        if self.command.as_ref().is_some_and(|c| {
            !matches!(
                c.action,
                Action::Claim { .. }
                    | Action::Renew { .. }
                    | Action::ClaimResource { .. }
                    | Action::RenewResource { .. }
                    | Action::Report { .. }
            )
        }) {
            bail!("remote worker cannot perform owner operation controls")
        }
        if let Some(Command {
            action: Action::ClaimResource { resource, .. } | Action::RenewResource { resource, .. },
            ..
        }) = &self.command
        {
            resource.validate()?;
        }
        if let Some(Command {
            action: Action::Report { report_id, content },
            ..
        }) = &self.command
        {
            if !valid_id(report_id) || content.len() > 16384 {
                bail!("invalid operation report")
            }
        }
        Ok(())
    }
}
impl Hub {
    pub(super) async fn relay_operation(&self, node: &str, request: Request) -> Result<Value> {
        request.validate()?;
        if node == self.node_id() || !self.peers().iter().any(|p| p.node_id == node) {
            bail!("unknown remote home Hub")
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (result, receive) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.operation_pending.lock();
            if pending.len() >= 64 {
                bail!("operation relay queue full")
            }
            pending.insert(
                id.clone(),
                Pending {
                    node: node.into(),
                    request,
                    sent: false,
                    result,
                },
            );
        }
        self.wake_peer(node);
        struct Cleanup<'a>(&'a Hub, String);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                self.0.operation_pending.lock().remove(&self.1);
            }
        }
        let _cleanup = Cleanup(self, id);
        match tokio::time::timeout(Duration::from_secs(10), receive).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => bail!(error),
            _ => bail!("home Hub response unavailable; command outcome uncertain, inspect home ledger before retry"),
        }
    }
    pub(super) fn receive_operation(&self, peer: &str, request: Request) -> Result<Value> {
        request.validate()?;
        self.store.expire_operations(now())?;
        let row = self
            .store
            .operation(&request.operation_id)?
            .ok_or_else(|| anyhow::anyhow!("unknown operation"))?;
        if row.worker.node_id != peer || row.worker.session_id != request.worker_session {
            bail!("foreign remote operation")
        }
        if let Some(accounting) = request.accounting {
            return self.receive_accounting(&row.id, accounting);
        }
        match request.command {
            Some(command) => Ok(serde_json::to_value(self.store.command_operation(
                &row.id,
                command,
                now(),
            )?)?),
            None => Ok(serde_json::to_value(row)?),
        }
    }
    pub(super) fn operation_frames(
        &self,
        peer: &str,
        enabled: bool,
        accounting_enabled: bool,
        resource_enabled: bool,
        quota_enabled: bool,
        official_enabled: bool,
        tool_enabled: bool,
        grant_enabled: bool,
        selection_enabled: bool,
        monetary_enabled: bool,
        artifact_enabled: bool,
        assignment_enabled: bool,
        assignment_creation_enabled: bool,
        assignment_admission_enabled: bool,
        assignment_stop_enabled: bool,
        assignment_run_enabled: bool,
        archive_enabled: bool,
        assignment_outputs_enabled: bool,
        assignment_clarification_enabled: bool,
    ) -> Vec<Frame> {
        let mut pending = self.operation_pending.lock();
        let keys: Vec<String> = pending
            .iter()
            .filter(|(_, p)| p.node == peer && !p.sent)
            .map(|(id, _)| id.clone())
            .collect();
        let mut frames = Vec::new();
        for id in keys {
            let archive = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_archive_capability());
            let assignment_outputs = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_assignment_outputs_capability());
            let assignment_clarification = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_assignment_clarification_capability());
            let assignment_run = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_assignment_run_capability());
            let assignment_stop = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_assignment_stop_capability());
            let assignment_admission = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_assignment_admission_capability());
            let assignment_creation = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_assignment_creation_capability());
            let assignment = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_assignment_capability());
            let accounting = pending
                .get(&id)
                .is_some_and(|p| p.request.accounting.is_some());
            let resource = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_resource_capability());
            let quota = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_quota_capability());
            let official = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_official_capability());
            let tool = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_tool_capability());
            let grant = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_grant_capability());
            let selection = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_selection_capability());
            let monetary = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_monetary_capability());
            let artifact = pending
                .get(&id)
                .is_some_and(|p| p.request.requires_artifact_capability());
            if !enabled
                || assignment_outputs && !assignment_outputs_enabled
                || archive && !archive_enabled
                || assignment_clarification && !assignment_clarification_enabled
                || assignment_run && !assignment_run_enabled
                || assignment_stop && !assignment_stop_enabled
                || assignment_admission && !assignment_admission_enabled
                || assignment_creation && !assignment_creation_enabled
                || assignment && !assignment_enabled
                || artifact && !artifact_enabled
                || monetary && !monetary_enabled
                || selection && !selection_enabled
                || grant && !grant_enabled
                || tool && !tool_enabled
                || official && !official_enabled
                || accounting && !accounting_enabled
                || resource && !resource_enabled
                || quota && !quota_enabled
            {
                if let Some(p) = pending.remove(&id) {
                    let _ = p.result.send(Err(if assignment_outputs {
                        "peer lacks operation_assignment_outputs_v1 capability"
                    } else if archive {
                        "peer lacks operation_artifact_archive_v1 capability"
                    } else if assignment_clarification {
                        "peer lacks operation_assignment_clarification_v1 capability"
                    } else if assignment_run {
                        "peer lacks operation_assignment_run_context_v1 capability"
                    } else if assignment_stop {
                        "peer lacks operation_assignment_stop_v1 capability"
                    } else if assignment_admission {
                        "peer lacks operation_assignment_admission_v1 capability"
                    } else if assignment_creation {
                        "peer lacks operation_assignment_creation_v1 capability"
                    } else if assignment {
                        "peer lacks operation_assignment_context_v1 capability"
                    } else if artifact {
                        "peer lacks operation_artifact_evidence_v1 capability"
                    } else if monetary {
                        "peer lacks operation_monetary_quota_v1 capability"
                    } else if selection {
                        "peer lacks operation_selection_evidence_v1 capability"
                    } else if grant {
                        "peer lacks operation_grants_v1 capability"
                    } else if tool {
                        "peer lacks operation_tool_evidence_v1 capability"
                    } else if official {
                        "peer lacks operation_official_calls_v1 capability"
                    } else if quota {
                        "peer lacks operation_quota_v1 capability"
                    } else if resource {
                        "peer lacks operation_resources_v1 capability"
                    } else if accounting {
                        "peer lacks operation_accounting_v1 capability"
                    } else {
                        "peer lacks operation_leases_v1 capability"
                    }
                    .into()));
                }
            } else if let Some(p) = pending.get_mut(&id) {
                p.sent = true;
                frames.push(Frame::OperationRequest {
                    id,
                    request: p.request.clone(),
                });
            }
        }
        frames
    }
}
