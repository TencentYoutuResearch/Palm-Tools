import { executeAssignmentWriteTool } from './assignment-write-tool.js'
import { executeAssignmentSourceTool } from './assignment-source-tools.js'
import { executeAssignmentEvidenceTool } from './assignment-evidence-tools.js'
import { publishAssignmentOutput } from './assignment-outputs.js'
import { VerificationArchive } from './verification-archive.js'
import { executeAssignmentVerification } from './assignment-verification.js'
import { VerificationRunners } from './verification-runners.js'
import { captureAssignmentFinalInput } from './assignment-final-input.js'
import { prepareAssignmentArtifact, bindAssignmentArtifact } from './assignment-artifact-workspace.js'
import { captureAssignmentFinalArtifact } from './assignment-final-artifact.js'
import { ArtifactMaterializer } from './artifact-materializer.js'
import { assignmentModelInput } from './assignment-input.js'
import { promptProvenance } from './prompt-provenance.js'
import { admitOfficialAssignment } from './official-assignment-admission.js'
import { assertOfficialProfile, preflightOfficialSelection } from './official-selection-preflight.js'
import { officialLoopServices } from './official-loop-services.js'
import { SelectionOutbox } from './selection-outbox.js'
import { ArtifactOutbox } from './artifact-outbox.js'
import { WorkspaceLocks } from './workspace-locks.js'
import { ExclusiveResources } from './exclusive-resources.js'
import { dirname, join } from 'node:path'
import { OfficialEntryGuard } from './official-entry-guard.js'
import { officialGrantGuard } from './official-grant-guard.js'
import { OfficialToolJournal } from './official-tool-journal.js'
/** Host-owned controlled execution; callers never receive collector credentials. */
import { OfficialCallOutbox } from './official-call-outbox.js'
import { streamLeasedOfficialCall } from './official-call-lease.js'
import { controlledBinding, managedCodexEnabled, managedCodexRoute } from './managed-codex-profile.js'
import { ManagedCodexAdapter } from './managed-codex-adapter.js'
import { AssignmentClarificationOutbox } from './assignment-clarification-outbox.js'
import { TaskWorktrees } from './task-worktrees.js'
import { taskWorkspaceIdentity } from './assignment-task-workspace.js'

export class OfficialExecution {
  executeAssignmentTool(agent, name, request) {
    this.entry.assertToolBody(agent, name, request)
    const active = this.active.get(agent.id)
    if (this.closed || active?.agent !== agent || !active.assignmentTool) throw new Error('Assignment tool owner unavailable')
    return active.assignmentTool(name, request)
  }
  bindAssignmentInput(request, options) { return bindAssignmentArtifact(this, request, options) }
  prepareAssignmentInput(request, options) { return prepareAssignmentArtifact(this, request, options) }
  constructor(ctx, profiles, client, { host, selectionOutbox, workspaceLocks } = {}) {
    this.ctx = ctx; this.profiles = profiles; this.client = client; this.host = host
    this.outbox = new OfficialCallOutbox(client, profiles)
    this.selection = selectionOutbox ?? new SelectionOutbox(client, profiles)
    this.artifacts = new ArtifactOutbox(client, profiles)
    this.verificationArchive = new VerificationArchive(client,profiles)
    this.verificationRunners = profiles.path ? new VerificationRunners(join(dirname(profiles.path), 'verification-runs')) : null
    this.artifactWorkspaces = profiles.path ? new ArtifactMaterializer(join(dirname(profiles.path), 'artifact-workspaces'), client) : null
    this.taskWorktrees = profiles.path ? new TaskWorktrees(join(dirname(profiles.path), 'task-worktrees')) : null
    this.workspaceLocks = workspaceLocks ?? (profiles.path ? new WorkspaceLocks(join(dirname(profiles.path), 'workspace-locks')) : null)
    this.exclusiveResources = profiles.path ? new ExclusiveResources(join(dirname(profiles.path),'exclusive-resources')) : null
    this.artifacts.start()
    this.ownsSelection = !selectionOutbox
    this.active = new Map(); this.closed = false
    this.clarifications = new AssignmentClarificationOutbox(this)
    this.clarifications.start()
    this.managedCodex = new ManagedCodexAdapter(ctx, profiles)
    this.refreshProviders()
    this.workspaceReleases = new Set(); this.workspaceReleaseErrors = []
    this.entry = new OfficialEntryGuard(ctx, profiles)
    this.tools = new OfficialToolJournal(profiles, client)
    this.ready = Promise.resolve(this.verificationRunners?.open()).then(() => this.tools.recover()).then(() => this.outbox.recover()).then(() => this.selection.tick()).then(() => this.artifacts.tick()).then(() => this.verificationArchive.flush())
  }
  async open(agent, { tools = [], signal, freshContext = false } = {}) {
    await this.ready
    if (this.closed || this.ctx.agents.get(agent.id) !== agent) throw new Error('Official execution owner unavailable')
    if (this.active.has(agent.id)) throw new Error('Official execution already active')
    if (!Array.isArray(tools) || tools.some(name => typeof name !== 'string' || !name)) throw new Error('Explicit official tool names required')
    const binding = this.profiles.binding(agent.id)
    if (!controlledBinding(binding) || !binding.managedOperation || binding.operationClosed) throw new Error('Managed official operation required')
    const operation = structuredClone(binding.managedOperation)
    const profileRevision = binding.revision
    const allowed = new Set(tools), stop = new AbortController()
    const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
    const slot = { stop, lease: undefined, agent, operation, guardReady: false, actions: 0, disposed: false, assignment: structuredClone(binding.managedAssignment ?? null) }
    let stoppedResolve, stoppedReject
    const stopped = new Promise((resolve, reject) => { stoppedResolve = resolve; stoppedReject = reject })
    stopped.catch(() => {})
    this.active.set(agent.id, slot)
    const releaseWorkspace = () => {
      if (!slot.disposed || slot.actions || slot.workspaceReleasing) return
      try { this.verificationRunners?.assertStopped(operation) } catch (error) { stoppedReject(error); return }
      if (!slot.workspaceLease) { stoppedResolve(); return }
      const release = slot.workspaceReleasing = slot.workspaceLease.release()
      this.workspaceReleases.add(release)
      release.then(() => { this.workspaceReleases.delete(release); stoppedResolve() }, error => {
        this.workspaceReleases.delete(release); this.workspaceReleaseErrors.push(error); stoppedReject(error)
      })
    }
    const dispose = () => {
      if (slot.disposed) return
      slot.disposed = true
      const reason = slot.lease?.signal.aborted ? slot.lease.signal.reason : new Error('Official execution ended')
      stop.abort(reason); slot.lease?.dispose()
      if (this.active.get(agent.id) === slot) this.active.delete(agent.id)
      releaseWorkspace()
    }
    slot.dispose = dispose
    try {
      const grant = await officialGrantGuard(this.ctx, this.client, agent, operation, tools, this.host, async derived => {
        if (binding.managedAssignment?.id !== derived.assignment_id) throw new Error('Derived workspace Assignment mismatch')
        if (derived.kind === 'derived_task_worktree') {
          if (!this.taskWorktrees) throw Error('Task worktree validation unavailable')
          return this.taskWorktrees.validate(taskWorkspaceIdentity(derived))
        }
        const prepared = await this.prepareAssignmentInput({ assignment_id: derived.assignment_id, source_stage: derived.source_stage, output: derived.output }, { signal: combined, homeScope: operation.home_node && operation.home_node !== this.host ? { worker_session: agent.id, operation } : undefined })
        if (prepared.input_hash !== derived.input_hash || prepared.snapshot_hash !== derived.snapshot_hash) throw new Error('Derived workspace input changed')
        return prepared.workspace.source
      })
      slot.guardReady = true
      const service = this.ctx.get('kodeOperationLeases')
      if (!service) throw new Error('Official lease service unavailable')
      const configuredProvider = agent.options?.provider
      const checkSelection = (policy, config) => {
        if (!policy) return
        if (policy.scope !== 'executor_configuration' || policy.profile_revision !== profileRevision
            || !configuredProvider || configuredProvider.startsWith('kode-agent-') || config?.provider !== configuredProvider
            || config.model !== policy.model || (policy.effort != null && config.reasoningEffort !== policy.effort)) {
          throw new Error('Official model/effort does not satisfy home selection policy')
        }
      }
      const beforeClaim = async policy => {
        try {
          checkSelection(policy, agent.options)
          const configuration = await preflightOfficialSelection(this.ctx, this.profiles, binding, policy, agent.options, combined, agent, this.managedCodex)
          slot.workspaceLease = await admitOfficialAssignment(this, agent, binding, operation, tools, configuration, grant, combined, freshContext)
          await runtimeProfiles.patchBinding(agent.id, { selectionAdmission: { status: 'capable', policy, operation, configuration, checked_at: Date.now() } })
          return true
        } catch (error) {
          await runtimeProfiles.patchBinding(agent.id, { selectionAdmission: { status: 'rejected', policy, operation, reason: 'official_selection_unsupported_or_mismatched', checked_at: Date.now() } })
          throw error
        }
      }
      const runtimeProfiles = this.profiles
      slot.lease = await service.acquire(agent, operation, combined, { beforeClaim })
      const lease = slot.lease
      lease.signal.addEventListener('abort', dispose, { once: true })
      const assertOwner = async (reporting = false) => {
        combined.throwIfAborted()
        const current = this.profiles.binding(agent.id)
        if (this.closed || this.ctx.agents.get(agent.id) !== agent || this.active.get(agent.id) !== slot || current?.operationClosed || current?.revision !== profileRevision || JSON.stringify(current?.managedOperation) !== JSON.stringify(operation) || JSON.stringify(current?.managedAssignment ?? null) !== JSON.stringify(slot.assignment)) {
          const error = new Error('Official execution ownership changed')
          stop.abort(error); dispose(); throw error
        }
        assertOfficialProfile(this.profiles, binding, lease.selectionPolicy)
        if (reporting === true) await lease.assertReportable()
        else await lease.assertActive()
        slot.workspaceLease?.assertExclusiveResources?.()
        try { await grant.check() } catch (error) { stop.abort(error); dispose(); throw error }
        combined.throwIfAborted()
      }
      slot.assertOwner = assertOwner
      await assertOwner()
      const runtime = this
      slot.assignmentTool = async (name, request) => {
        runtime.entry.assertToolBody(agent, name, request)
        await assertOwner()
        if (name === 'kode_write_source') return executeAssignmentWriteTool(runtime, agent, binding, slot.workspaceLease, request, combined, assertOwner)
        if (['kode_list_source', 'kode_read_source'].includes(name)) return executeAssignmentSourceTool(runtime, agent, binding, slot.workspaceLease, name, request, combined, assertOwner)
        if (['kode_capture_output', 'kode_review_output'].includes(name)) return executeAssignmentEvidenceTool(runtime, agent, binding, slot.workspaceLease, name, request, combined, assertOwner)
        if (name === 'kode_publish_output') return publishAssignmentOutput(runtime, agent, binding, request, combined, assertOwner)
        if (name === 'kode_verify_output') {
          const checked = await executeAssignmentVerification(runtime, agent, binding, slot.workspaceLease, request, combined, assertOwner)
          return { output: request.output, evidence_id: checked.observation.evidence.id,
            sequence: checked.observation.home_sequence ?? null, verdict: checked.observation.evidence.payload.verdict,
            log_archive_status: checked.log_archive_status, completion_authorized: false }
        }
        throw new Error('Unsupported Assignment tool')
      }
      let busy = false
      const enter = () => { if (busy) throw new Error('Official execution action already in progress'); busy = true; slot.actions++ }
      const leave = () => { busy = false; slot.actions--; releaseWorkspace() }
      const streamWith = async function* (options, dispatch, preparedConfig) {
        if (options.sessionId !== agent.id || options.provider?.startsWith('kode-agent-')) throw new Error('Official stream identity mismatch')
        if ((options.tools ?? []).some(tool => !allowed.has(tool.name))) throw Object.assign(new Error('Official stream advertises unauthorized tool'), {
          toolDiagnostic: { advertised: (options.tools ?? []).map(tool => tool.name).slice(0, 64), allowed: [...allowed].slice(0, 64) },
        })
        enter()
        try {
          await assertOwner()
          const assignmentPrompt = await assignmentModelInput(runtime, agent, binding, options, lease.signal)
          await runtime.tools.flush()
          runtime.tools.assertSettled(agent.id, operation)
          const policy = runtime.outbox.policy(agent.id, operation, assertOwner,promptProvenance(binding,options,assignmentPrompt))
          slot.currentCallId = policy.callId
          if (lease.selectionPolicy) {
            checkSelection(lease.selectionPolicy, options)
            if (!preparedConfig) throw new Error('Official selection policy requires a prepared call')
            checkSelection(lease.selectionPolicy, preparedConfig)
            const inputIds = [...new Set((options.messages ?? []).filter(message => message.role === 'user').map(message => message.id))].slice(-64)
            if (!inputIds.length || inputIds.some(id => typeof id !== 'string' || !id)) throw new Error('Official selection evidence requires input identities')
            await runtime.selection.record(agent.id, { operation, profile_revision: profileRevision, threadId: agent.id,
              turnId: policy.callId, inputIds, scope: 'executor_configuration', observed_at: Date.now(), source: 'official_prepared_call',
              model: { requested: lease.selectionPolicy.model, observed: preparedConfig.model, status: 'reported' },
              effort: { requested: lease.selectionPolicy.effort, observed: preparedConfig.reasoningEffort ?? null,
                status: preparedConfig.reasoningEffort == null ? 'unverifiable' : 'reported' } })
            runtime.selection.assertSettled(agent.id, operation, lease.selectionPolicy)
          }
          yield* streamLeasedOfficialCall({ stream: scoped => runtime.entry.stream(scoped, () => dispatch(scoped), assertOwner) }, options, lease, policy)
          // The completed call may consume the final held unit. Preserve authority/identity
          // for reporting; any subsequent model or tool entry still needs execution admission.
          await assertOwner(true)
        } finally { delete slot.currentCallId; leave() }
      }
      const run = {
        signal: lease.signal,
        stream: options => streamWith(options, scoped => runtime.ctx.llm.stream(scoped)),
        async prepareCall(config, signal, configure) {
          if (!config?.provider || config.provider.startsWith('kode-agent-')) throw new Error('Official provider required')
          enter()
          try {
            await assertOwner()
            await runtime.tools.flush()
            runtime.tools.assertSettled(agent.id, operation)
            await runtime.artifacts.awaitSettled(agent.id,operation,{signal:lease.signal,assertOwner})
            runtime.artifacts.assertSettled(agent.id, operation)
            await runtime.verificationArchive.awaitSettled(agent.id,operation,{signal:lease.signal,assertOwner})
            runtime.verificationArchive.assertSettled(agent.id,operation)
            const preparationSignal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal
            preparationSignal.throwIfAborted()
            checkSelection(lease.selectionPolicy, config)
            const prepared = await runtime.ctx.llm.prepareCall(config, preparationSignal, configure)
            checkSelection(lease.selectionPolicy, prepared.config)
            await assertOwner()
            preparationSignal.throwIfAborted()
            let used = false
            return Object.freeze({ ...prepared, stream: async function* (options) {
              if (used) throw new Error('Official prepared call already dispatched')
              used = true
              preparationSignal.throwIfAborted()
              const signal = options.signal ? AbortSignal.any([options.signal, preparationSignal]) : preparationSignal
              yield* streamWith({ ...options, signal }, scoped => prepared.stream(scoped), prepared.config)
            } })
          } finally { leave() }
        },
        async publishOutput(request) {
          enter()
          try {
            await assertOwner()
            return await publishAssignmentOutput(runtime, agent, binding, request, combined, assertOwner)
          } finally { leave() }
        },
        async verify(request) {
          enter()
          try {
            await assertOwner()
            await runtime.tools.flush(); runtime.tools.assertSettled(agent.id,operation)
            return await executeAssignmentVerification(runtime,agent,binding,slot.workspaceLease,request,combined,assertOwner)
          } finally { leave() }
        },
        async execute(request) {
          if (request.agent !== agent || !allowed.has(request.name)) throw new Error('Official tool not authorized')
          enter()
          let workspaceLease
          try {
            await assertOwner()
            await runtime.tools.flush()
            runtime.tools.assertSettled(agent.id, operation)
            const toolSignal = request.signal ? AbortSignal.any([request.signal, lease.signal]) : lease.signal
            toolSignal.throwIfAborted()
            const policy = runtime.ctx.get('kodeOfficialToolPolicies')?.get?.(request.name, agent)
            if (policy?.validateArguments && !policy.validateArguments(request.arguments)) {
              // No implementation has run. Persist a definite rejection so the model
              // can correct its input without treating this as an uncertain effect.
              const message = 'Arguments do not match the tool JSON schema. Correct them using the declared output IDs and parameter constraints.'
              const result = { content: [{ type: 'text', text: message }], isError: true,
                error: { code: 'INVALID_TOOL_ARGUMENTS', message } }
              await runtime.tools.begin(agent.id, operation, request)
              await runtime.tools.end(agent.id, request.callId, 'returned', 'arguments_rejected_before_dispatch', result)
              await assertOwner()
              return result
            }
            const toolScope = await grant.tool(request)
            if (toolScope?.workspaceLock) {
              if (!runtime.workspaceLocks) throw new Error('Official workspace locking unavailable')
              if (slot.workspaceLease) {
                if (slot.workspaceLease.root !== toolScope.root) throw new Error('Official assignment workspace lock changed')
              } else workspaceLease = await runtime.workspaceLocks.acquire(toolScope.root, operation.id, { signal: toolSignal })
            }
            await runtime.tools.begin(agent.id, operation, request)
            let observedResult,resultObserved=false
            try {
              await assertOwner()
              toolSignal.throwIfAborted()
              const dispatch = { ...request, agent, signal: toolSignal }
              const result = await runtime.entry.execute(dispatch, () => (agent.ctx.get ? agent.ctx.get('tools') : agent.ctx.tools).execute(dispatch), assertOwner)
              observedResult=result;resultObserved=true
              // ToolRuntime normalizes thrown failures into results, even after side effects.
              // Trusted local source readers can return errors without an uncertain mutation.
              if (result?.isError === true && !policy?.readOnlyErrors) throw new Error('Official tool outcome requires reconciliation')
              await assertOwner()
              await runtime.tools.end(agent.id, request.callId, 'returned', result?.isError === true ? 'readonly_tool_error' : 'tool_returned',result)
              return result
            } catch (error) {
              await runtime.tools.end(agent.id, request.callId, 'uncertain', 'execution_or_recording_failed',...(resultObserved?[observedResult]:[])).catch(() => {})
              throw error
            }
          } finally { try { await workspaceLease?.release() } finally { leave() } }
        },
        async finish() {
          enter()
          try {
            await assertOwner(true)
            await runtime.tools.flush()
            runtime.tools.assertSettled(agent.id, operation)
            await runtime.artifacts.tick()
            runtime.artifacts.assertSettled(agent.id, operation)
            if (lease.selectionPolicy) runtime.selection.assertSettled(agent.id, operation, lease.selectionPolicy)
            await runtime.verificationArchive.flush()
            runtime.verificationArchive.assertSettled(agent.id,operation)
            const finalArtifact = await captureAssignmentFinalArtifact(runtime, agent, binding, slot.workspaceLease, combined)
            const finalInput = await captureAssignmentFinalInput(runtime, agent, binding, slot.workspaceLease, combined)
            await assertOwner(true)
            const result = await lease.finish()
            await runtime.profiles.patchBinding(agent.id, { operationClosed: true, ...(finalArtifact ? { finalArtifact } : {}), ...(finalInput ? { finalInput } : {}) })
            dispose()
            return result
          } finally { leave() }
        },
        dispose,
        whenStopped: () => stopped,
      }
      slot.run = run
      return run
    } catch (error) { dispose(); throw error }
  }
  loopServices() {
    return officialLoopServices(this.ctx, agent => {
      const slot = agent && this.active.get(agent.id)
      return !this.closed && slot?.agent === agent && !slot.stop.signal.aborted ? slot.run : undefined
    })
  }
  authorizesLease(agent, operation) {
    const slot = this.active.get(agent.id)
    return !this.closed && slot?.agent === agent && slot.guardReady && !slot.stop.signal.aborted && JSON.stringify(slot.operation) === JSON.stringify(operation)
  }
  async assertModelRequest(agent) {
    const slot = this.active.get(agent.id)
    if (this.closed || slot?.agent !== agent || !slot.assertOwner) throw new Error('Managed model request owner unavailable')
    const row = slot.currentCallId && this.outbox.row(agent.id, slot.currentCallId)
    if (!row || row.status !== 'dispatch_admitted' || !this.outbox.active.has(slot.currentCallId)) throw new Error('Managed model request has no admitted call')
    await slot.assertOwner()
    return { call_id: slot.currentCallId, operation: structuredClone(slot.operation) }
  }
  refreshProviders() {
    if (this.closed) return
    const routes = [...new Set([...this.profiles.list(), ...Object.values(this.profiles.bindings).map(binding => binding.profile)]
      .filter(managedCodexEnabled).map(profile => managedCodexRoute(profile.id)))]
    if (this.managedRegistration) this.managedRegistration.replace(routes)
    else if (routes.length) this.managedRegistration = this.ctx.llm.registerAdapter(routes, this.managedCodex)
  }
  closeSession(id) { this.active.get(id)?.dispose() }
  async close() { this.closed = true; this.entry.close(); this.managedRegistration?.(); for (const id of this.active.keys()) this.closeSession(id); await this.managedCodex.close(); await this.clarifications.close(); await this.verificationRunners?.close(); await this.verificationArchive.close(); await this.artifactWorkspaces?.close(); await this.taskWorktrees?.close(); await this.artifacts.close(); await this.ready; if (this.ownsSelection) await this.selection.close(); await Promise.allSettled([...this.workspaceReleases]); if (this.workspaceReleaseErrors.length) throw new AggregateError(this.workspaceReleaseErrors, 'Official workspace release failed') }
}
