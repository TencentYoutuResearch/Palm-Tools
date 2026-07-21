import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'

import { SpecOpsError } from '../core/errors.js'
import { atomicWrite, pathInside } from '../store/workspace.js'

export type HarnessLoopKind = 'clarify' | 'build' | 'verify_repair' | 'drift'
export type HarnessLoopState = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type ScheduledTaskState = 'blocked' | 'ready' | 'running' | 'verifying' | 'reviewing' | 'completed' | 'failed' | 'cancelled'
export type ArtifactKind = 'spec' | 'plan' | 'context' | 'patch' | 'verification' | 'review' | 'evidence' | 'drift_report' | 'gate_decision' | 'note'

export interface HarnessTaskInput {
  id: string
  title: string
  depends_on?: string[]
}

export interface ScheduledTask {
  id: string
  title: string
  depends_on: string[]
  state: ScheduledTaskState
  attempt: number
  assigned_agent: string | null
  worktree: string | null
  updated_at: string
}

export interface LoopInstance {
  id: string
  kind: HarnessLoopKind
  state: HarnessLoopState
  iteration: number
  task_id: string | null
  started_at: string | null
  completed_at: string | null
}

export interface HarnessArtifact {
  schema_version: 1
  id: string
  run_id: string
  kind: ArtifactKind
  subject: string
  producer: string
  uri: string | null
  content_hash: string | null
  source_commit: string | null
  inputs: string[]
  metadata: Record<string, unknown>
  created_at: string
}

export type HarnessEventType =
  | 'harness.initialized'
  | 'run.transitioned'
  | 'task.transitioned'
  | 'loop.transitioned'
  | 'artifact.recorded'
  | 'gate.decided'
  | 'budget.exhausted'
  | 'drift.detected'

export interface HarnessEvent {
  schema_version: 1
  id: string
  sequence: number
  run_id: string
  type: HarnessEventType
  at: string
  actor: string
  idempotency_key: string
  data: Record<string, unknown>
}

export interface HarnessControlState {
  schema_version: 1
  run_id: string
  run_state: string
  sequence: number
  tasks: ScheduledTask[]
  loops: LoopInstance[]
  artifacts: HarnessArtifact[]
  gates: Array<{ id: string; status: 'passed' | 'failed' | 'approval_required'; reason: string; at: string; actor?: string }>
  budget: { max_iterations: number; used_iterations: number; exhausted: boolean }
  updated_at: string
}

const locks = new Map<string, Promise<unknown>>()

function stateFile(workspace: string, runId: string): string {
  return pathInside(workspace, '.specops', 'runs', runId, 'harness-state.json')
}

function eventsFile(workspace: string, runId: string): string {
  return pathInside(workspace, '.specops', 'runs', runId, 'harness-events.json')
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  locks.set(key, next.then(() => undefined, () => undefined))
  return next
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

function initialTaskState(task: HarnessTaskInput, taskIds: Set<string>, now: string): ScheduledTask {
  const dependencies = task.depends_on ?? []
  for (const dependency of dependencies) {
    if (!taskIds.has(dependency)) throw new SpecOpsError('invalid_tasks', `task ${task.id} depends on unknown task: ${dependency}`)
  }
  return { id: task.id, title: task.title, depends_on: [...dependencies], state: dependencies.length === 0 ? 'ready' : 'blocked', attempt: 0, assigned_agent: null, worktree: null, updated_at: now }
}

function loop(id: string, kind: HarnessLoopKind): LoopInstance {
  return { id, kind, state: 'pending', iteration: 0, task_id: null, started_at: null, completed_at: null }
}

export async function initializeHarnessRun(
  workspace: string,
  runId: string,
  tasks: HarnessTaskInput[],
  maxIterations: number,
): Promise<HarnessControlState> {
  const existing = await readHarnessState(workspace, runId)
  if (existing !== null) return existing
  const now = new Date().toISOString()
  const taskIds = new Set(tasks.map((task) => task.id))
  const state: HarnessControlState = {
    schema_version: 1,
    run_id: runId,
    run_state: 'created',
    sequence: 0,
    tasks: tasks.map((task) => initialTaskState(task, taskIds, now)),
    loops: [loop('clarify', 'clarify'), loop('build', 'build'), loop('verify-repair', 'verify_repair'), loop('drift', 'drift')],
    artifacts: [], gates: [],
    budget: { max_iterations: maxIterations, used_iterations: 0, exhausted: false },
    updated_at: now,
  }
  await atomicWrite(stateFile(workspace, runId), `${JSON.stringify(state, null, 2)}\n`)
  await appendHarnessEvent(workspace, runId, 'harness.initialized', 'harness-core', { tasks, max_iterations: maxIterations }, `init:${runId}`)
  return (await readHarnessState(workspace, runId))!
}

export async function readHarnessState(workspace: string, runId: string): Promise<HarnessControlState | null> {
  const snapshot = await readJson<HarnessControlState | null>(stateFile(workspace, runId), null)
  if (snapshot !== null) {
    // Older snapshots kept every gate transition, so a resolved approval could
    // appear beside its stale approval_required predecessor. The event journal
    // remains the audit history; HarnessControlState is the current projection.
    snapshot.gates = currentGateStates(snapshot.gates)
    return snapshot
  }
  const events = await readJson<HarnessEvent[]>(eventsFile(workspace, runId), [])
  if (events.length === 0) return null
  return rebuildHarnessState(workspace, runId, events)
}

export function currentGateStates(gates: HarnessControlState['gates']): HarnessControlState['gates'] {
  const current: HarnessControlState['gates'] = []
  const indexes = new Map<string, number>()
  for (const gate of gates) {
    const index = indexes.get(gate.id)
    if (index === undefined) {
      indexes.set(gate.id, current.length)
      current.push(gate)
    } else {
      current[index] = gate
    }
  }
  return current
}

export async function readHarnessEvents(workspace: string, runId: string): Promise<HarnessEvent[]> {
  return readJson<HarnessEvent[]>(eventsFile(workspace, runId), [])
}

export async function listHarnessStates(workspace: string): Promise<HarnessControlState[]> {
  let runIds: string[]
  try { runIds = await readdir(pathInside(workspace, '.specops', 'runs')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const states = await Promise.all(runIds.map((runId) => readHarnessState(workspace, runId)))
  return states.filter((state): state is HarnessControlState => state !== null).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function appendHarnessEvent(
  workspace: string,
  runId: string,
  type: HarnessEventType,
  actor: string,
  data: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
): Promise<HarnessEvent> {
  return withLock(`${workspace}:${runId}`, async () => {
    const events = await readHarnessEvents(workspace, runId)
    const duplicate = events.find((event) => event.idempotency_key === idempotencyKey)
    if (duplicate !== undefined) return duplicate
    const event: HarnessEvent = { schema_version: 1, id: randomUUID(), sequence: events.length + 1, run_id: runId, type, at: new Date().toISOString(), actor, idempotency_key: idempotencyKey, data }
    events.push(event)
    await atomicWrite(eventsFile(workspace, runId), `${JSON.stringify(events, null, 2)}\n`)
    const state = await readHarnessState(workspace, runId)
    if (state !== null) {
      reduceEvent(state, event)
      await atomicWrite(stateFile(workspace, runId), `${JSON.stringify(state, null, 2)}\n`)
    }
    return event
  })
}

function reduceEvent(state: HarnessControlState, event: HarnessEvent): void {
  state.sequence = event.sequence
  state.updated_at = event.at
  if (event.type === 'run.transitioned' && typeof event.data.state === 'string') state.run_state = event.data.state
  if (event.type === 'task.transitioned') {
    const task = state.tasks.find((item) => item.id === event.data.task_id)
    if (task !== undefined && typeof event.data.state === 'string') {
      task.state = event.data.state as ScheduledTaskState
      task.updated_at = event.at
      if (typeof event.data.agent === 'string') task.assigned_agent = event.data.agent
      if (typeof event.data.worktree === 'string') task.worktree = event.data.worktree
      if (task.state === 'running') task.attempt += 1
      if (task.state === 'completed') unlockTasks(state)
    }
  }
  if (event.type === 'loop.transitioned') {
    const item = state.loops.find((candidate) => candidate.kind === event.data.kind)
    if (item !== undefined && typeof event.data.state === 'string') {
      item.state = event.data.state as HarnessLoopState
      item.task_id = typeof event.data.task_id === 'string' ? event.data.task_id : item.task_id
      if (item.state === 'running') { item.iteration += 1; item.started_at ??= event.at }
      if (item.state === 'completed') item.completed_at = event.at
    }
  }
  if (event.type === 'artifact.recorded') state.artifacts.push(event.data.artifact as unknown as HarnessArtifact)
  if (event.type === 'gate.decided') {
    const gate = event.data.gate as HarnessControlState['gates'][number]
    const index = state.gates.findIndex((item) => item.id === gate.id)
    if (index === -1) state.gates.push(gate)
    else state.gates[index] = gate
  }
  if (event.type === 'budget.exhausted') state.budget.exhausted = true
  if (typeof event.data.iteration === 'number') {
    state.budget.used_iterations = Math.max(state.budget.used_iterations, event.data.iteration)
    state.budget.exhausted = state.budget.used_iterations >= state.budget.max_iterations
  }
}

async function rebuildHarnessState(workspace: string, runId: string, events: HarnessEvent[]): Promise<HarnessControlState> {
  const initialized = events.find((event) => event.type === 'harness.initialized')
  const rawTasks = initialized?.data.tasks
  if (!Array.isArray(rawTasks)) throw new SpecOpsError('harness_recovery_failed', `Run ${runId} has no recoverable initialization event`)
  const inputs: HarnessTaskInput[] = rawTasks.map((raw) => {
    if (typeof raw === 'string') return { id: raw, title: raw }
    const item = raw as Partial<HarnessTaskInput>
    if (typeof item.id !== 'string') throw new SpecOpsError('harness_recovery_failed', `Run ${runId} has an invalid task initialization event`)
    return { id: item.id, title: typeof item.title === 'string' ? item.title : item.id, ...(Array.isArray(item.depends_on) ? { depends_on: item.depends_on } : {}) }
  })
  const at = initialized?.at ?? new Date().toISOString()
  const ids = new Set(inputs.map((task) => task.id))
  const maxIterations = typeof initialized?.data.max_iterations === 'number' ? initialized.data.max_iterations : 8
  const state: HarnessControlState = {
    schema_version: 1, run_id: runId, run_state: 'created', sequence: 0,
    tasks: inputs.map((task) => initialTaskState(task, ids, at)),
    loops: [loop('clarify', 'clarify'), loop('build', 'build'), loop('verify-repair', 'verify_repair'), loop('drift', 'drift')],
    artifacts: [], gates: [], budget: { max_iterations: maxIterations, used_iterations: 0, exhausted: false }, updated_at: at,
  }
  for (const event of events) reduceEvent(state, event)
  await atomicWrite(stateFile(workspace, runId), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

function unlockTasks(state: HarnessControlState): void {
  const completed = new Set(state.tasks.filter((task) => task.state === 'completed').map((task) => task.id))
  for (const task of state.tasks) {
    if (task.state === 'blocked' && task.depends_on.every((id) => completed.has(id))) {
      task.state = 'ready'
      task.updated_at = state.updated_at
    }
  }
}

export async function transitionHarnessTask(workspace: string, runId: string, taskId: string, state: ScheduledTaskState, details: { agent?: string; worktree?: string; iteration?: number } = {}): Promise<void> {
  const control = await readHarnessState(workspace, runId)
  const task = control?.tasks.find((item) => item.id === taskId)
  if (task === undefined) throw new SpecOpsError('scheduler_task_missing', `Harness task does not exist: ${taskId}`)
  const allowed: Record<ScheduledTaskState, ScheduledTaskState[]> = {
    blocked: ['ready', 'cancelled'],
    ready: ['running', 'cancelled'],
    // Intermediate implementation tasks complete at the scheduler boundary;
    // Run-level verify/review happens once after the final task.
    running: ['verifying', 'completed', 'failed', 'cancelled'],
    verifying: ['reviewing', 'running', 'failed', 'cancelled'],
    reviewing: ['completed', 'running', 'failed', 'cancelled'],
    completed: [], failed: ['running', 'cancelled'], cancelled: [],
  }
  if (task.state !== state && !allowed[task.state].includes(state)) {
    throw new SpecOpsError('invalid_scheduler_transition', `cannot transition task ${taskId} from ${task.state} to ${state}`)
  }
  if (task.state === state) return
  await appendHarnessEvent(workspace, runId, 'task.transitioned', 'scheduler', { task_id: taskId, state, ...details })
}

export async function transitionHarnessLoop(workspace: string, runId: string, kind: HarnessLoopKind, state: HarnessLoopState, taskId?: string): Promise<void> {
  await appendHarnessEvent(workspace, runId, 'loop.transitioned', 'loop-orchestrator', { kind, state, task_id: taskId ?? null })
}

export async function recordHarnessArtifact(workspace: string, runId: string, artifact: Omit<HarnessArtifact, 'schema_version' | 'id' | 'run_id' | 'created_at'>): Promise<HarnessArtifact> {
  const record: HarnessArtifact = { schema_version: 1, id: randomUUID(), run_id: runId, created_at: new Date().toISOString(), ...artifact }
  await appendHarnessEvent(workspace, runId, 'artifact.recorded', artifact.producer, { artifact: record })
  return record
}

export async function recordGateDecision(workspace: string, runId: string, id: string, status: 'passed' | 'failed' | 'approval_required', reason: string, actor = 'policy-engine'): Promise<void> {
  const current = await readHarnessState(workspace, runId)
  const latest = current?.gates.filter((gate) => gate.id === id).at(-1)
  if (latest?.status === status && latest.reason === reason) return
  await appendHarnessEvent(workspace, runId, 'gate.decided', actor, { gate: { id, status, reason, actor, at: new Date().toISOString() } })
}
