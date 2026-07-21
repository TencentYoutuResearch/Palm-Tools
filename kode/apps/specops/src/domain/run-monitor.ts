/**
 * RunMonitor advances Runs from structured turn completion. It never polls
 * backend status and never reads PTY transcripts; runtime/projector own those.
 */
import { SpecOpsError } from '../core/errors.js'
import type { ExecutionRequestOutcome, ExecutionTurnResult } from '../execution/types.js'
import { exists } from '../store/workspace.js'
import { recordHarnessArtifact } from './harness-core.js'
import { enqueueInteraction } from './interactions.js'
import { readRun, runChangeEvidence, transitionRun } from './run.js'
import {
  advanceToNextTask,
  type RunExecutionRuntime,
  type RunTurn,
  type RunTurnBinding,
} from './run-loop.js'
import { findSpecOpsSessionByRunId, updateSpecOpsSession } from './session.js'
import { specOpsSessionEvents } from './session-events.js'

interface MonitorEntry {
  runId: string
  workspace: string
  runtime: RunExecutionRuntime
  binding: RunTurnBinding
  completion: Promise<ExecutionRequestOutcome<ExecutionTurnResult>>
  generation: number
}

const monitors = new Map<string, MonitorEntry>()
const settlements = new Set<Promise<void>>()
let runtimeRef: RunExecutionRuntime | null = null
let generation = 0

export function initRunMonitor(runtime: RunExecutionRuntime, _workspace: string): void {
  runtimeRef = runtime
}

/** Register exactly one structured turn. Completion, not idle state, advances the Run. */
export function watchRun(
  runId: string,
  workspace: string,
  turn: RunTurn,
): void {
  if (runtimeRef === null) throw new SpecOpsError('execution_unavailable', 'Run monitor has no structured execution runtime')
  if (turn.binding.run_id !== runId) throw new SpecOpsError('run_turn_mismatch', `Turn is bound to ${turn.binding.run_id}, not ${runId}`)
  const current = monitors.get(runId)
  if (current !== undefined) {
    throw new SpecOpsError('run_turn_already_watched', `Run ${runId} already has an active stage-bound turn`)
  }
  const entry: MonitorEntry = {
    runId,
    workspace,
    runtime: runtimeRef,
    binding: turn.binding,
    completion: turn.completion,
    generation: ++generation,
  }
  monitors.set(runId, entry)
  const settlement = settle(entry)
  settlements.add(settlement)
  void settlement.then(
    () => settlements.delete(settlement),
    () => settlements.delete(settlement),
  )
}

export function hasRunMonitor(runId: string): boolean {
  return monitors.has(runId)
}

export function unwatchRun(runId: string): void {
  monitors.delete(runId)
}

export async function shutdownMonitor(): Promise<void> {
  // Invalidate entries before awaiting their prompt promises so completions
  // released by runtime.shutdown cannot mutate a closing/deleted workspace.
  monitors.clear()
  runtimeRef = null
  await Promise.allSettled([...settlements])
}

async function settle(entry: MonitorEntry): Promise<void> {
  try {
    const outcome = await entry.completion
    if (!isCurrent(entry)) return
    if (outcome.outcome === 'outcome_unknown') {
      await preserveRecoveryGate(entry, 'outcome_unknown', `Structured execution outcome is unknown: ${outcome.error.message}`, true)
      return
    }
    const stopReason = outcome.value.stopReason?.trim().toLowerCase() ?? 'unknown'
    if (stopReason !== 'completed' && stopReason !== 'end_turn') {
      await preserveRecoveryGate(entry, `stop_reason_${stopReason}`, `Stage-bound turn stopped with ${stopReason}.`, false)
      return
    }
    await advanceRun(entry, outcome.value)
  } catch (error) {
    if (!isCurrent(entry)) return
    await recoverRun(entry, error)
  }
}

function isCurrent(entry: MonitorEntry): boolean {
  return monitors.get(entry.runId)?.generation === entry.generation
}

async function advanceRun(entry: MonitorEntry, result: ExecutionTurnResult): Promise<void> {
  if (!isCurrent(entry)) return
  const run = await readRun(entry.workspace, entry.runId)
  if (run.state !== 'running') {
    monitors.delete(entry.runId)
    return
  }

  const task = run.tasks[run.current_task]
  if (task === undefined || task.id !== entry.binding.task_id) {
    await preserveRecoveryGate(entry, 'stage_binding_mismatch', 'The completed turn is not bound to the current Run task.', false)
    return
  }
  if (run.execution?.execution_id !== entry.binding.execution_id
    || run.execution.process_generation !== entry.binding.process_generation) {
    await preserveRecoveryGate(entry, 'execution_binding_mismatch', 'The completed turn belongs to a stale execution generation.', false)
    return
  }
  if (!await exists(run.worktree_path)) {
    monitors.delete(entry.runId)
    await transitionRun(run, 'cancelled')
    return
  }

  const evidence = await runChangeEvidence(run)
  if (evidence.files.length === 0 || evidence.digest === entry.binding.baseline_digest) {
    await preserveRecoveryGate(
      entry,
      'implementation_evidence_missing',
      'The stage-bound turn completed without a new worktree diff; the task was not advanced.',
      false,
    )
    return
  }

  const turnId = result.turnId?.trim() || entry.binding.request_id
  await recordHarnessArtifact(entry.workspace, entry.runId, {
    kind: 'evidence',
    subject: task.id,
    producer: 'run-monitor',
    uri: null,
    content_hash: evidence.digest,
    source_commit: null,
    inputs: [],
    metadata: {
      receipt_type: 'implementation_completion',
      run_id: entry.runId,
      task_id: task.id,
      turn_id: turnId,
      request_id: entry.binding.request_id,
      execution_id: entry.binding.execution_id,
      process_generation: entry.binding.process_generation,
      monitor_generation: entry.generation,
      purpose: entry.binding.purpose,
      stop_reason: result.stopReason,
      changed_files: evidence.files,
    },
  })

  monitors.delete(entry.runId)
  if (run.current_task + 1 < run.tasks.length) {
    const next = await advanceToNextTask(run, entry.runtime)
    watchRun(entry.runId, entry.workspace, next)
    return
  }

  await transitionRun(run, 'awaiting_verify')
  await publishVerifyAction(entry, run.run_id, task.id, run.iteration)
}

async function recoverRun(entry: MonitorEntry, error: unknown): Promise<void> {
  console.error(`[specops] failed to advance structured run ${entry.runId}`, error)
  try {
    const run = await readRun(entry.workspace, entry.runId)
    if (run.state === 'awaiting_verify') {
      await publishVerifyAction(entry, run.run_id, run.tasks[run.current_task]?.id ?? 'unknown', run.iteration)
      return
    }
    if (run.state === 'running') {
      await preserveRecoveryGate(entry, 'run_turn_error', error instanceof Error ? error.message : String(error), false)
    }
  } catch (readError) {
    console.error(`[specops] failed to persist structured run recovery ${entry.runId}`, readError)
  }
}

async function preserveRecoveryGate(
  entry: MonitorEntry,
  reason: string,
  message: string,
  closeExecution: boolean,
): Promise<void> {
  monitors.delete(entry.runId)
  const run = await readRun(entry.workspace, entry.runId)
  if (closeExecution && run.execution !== null) {
    await entry.runtime.close(run.execution.execution_id).catch(() => undefined)
  }
  const session = await findSpecOpsSessionByRunId(entry.workspace, entry.runId)
  if (session === null) return
  const updated = await updateSpecOpsSession(entry.workspace, session.id, (record) => {
    record.phase = 'run_in_worktree'
    record.state = 'awaiting_user'
    if (closeExecution && record.current_execution?.execution_id === entry.binding.execution_id) {
      record.current_execution = null
    }
    record.execution.last_error = message
    record.execution.last_reconciled_at = new Date().toISOString()
    enqueueInteraction(record, {
      kind: 'resume',
      source: 'reconciliation',
      idempotency_key: `resume:${entry.runId}:${entry.binding.task_id}:${entry.binding.request_id}:${reason}`,
      payload: {
        reason,
        prompt: `Resume Run task ${entry.binding.task_id}. ${message}`,
      },
    })
  })
  specOpsSessionEvents.publish('session.action_required', session.id, updated.required_action)
}

async function publishVerifyAction(
  entry: MonitorEntry,
  runId: string,
  taskId: string,
  iteration: number,
): Promise<void> {
  const specopsSession = await findSpecOpsSessionByRunId(entry.workspace, runId)
  if (specopsSession === null) return
  const updated = await updateSpecOpsSession(entry.workspace, specopsSession.id, (record) => {
    record.phase = 'verify'
    record.state = 'awaiting_user'
    enqueueInteraction(record, {
      kind: 'run_verify',
      source: 'system',
      idempotency_key: `run_verify:${runId}:${taskId}:${iteration}`,
      payload: { run_id: runId },
    })
  })
  specOpsSessionEvents.publish('session.action_required', specopsSession.id, updated.required_action)
}
