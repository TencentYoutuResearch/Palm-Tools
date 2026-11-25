/**
 * Kode's session view mode: every conversation runs either in Kode's PTY
 * runtime (TUI) or in an extension runtime such as dsh (structured view).
 * The mode is global; switching it moves every conversation across.
 *
 * Both runtimes resume the same native CLI thread (Codex thread id, Claude
 * session id); only one may drive it at a time, or both CLIs would append to
 * the same rollout/jsonl. Every move therefore stops the current driver
 * first and waits until the workbench no longer lists it as live before the
 * other side resumes. Moves only happen between turns: a busy conversation
 * stays where it is and follows once its turn ends.
 */
import { get, writable } from 'svelte/store'
import { invoke } from '@tauri-apps/api/core'
import { ENDPOINT_LOCAL, extensionIpc, ipc, type PersistedTab, type SessionId } from './ipc'
import { activeId, closeTab, mountedIds, newTab, selectTab, syncSharedSessions, tabs, type TabInfo } from './sessions'
import { sessionViews, viewForRuntime, type SessionViewTarget } from './extensions'
import {
  batchCurrentStep,
  createLimiter,
  partitionTuiTargets,
  reorderAfterBatch,
  runPool,
  SnapshotPoller,
  targetActiveAfterBatch,
  type SwitchStep,
} from './runtime_switch_batch'

export type { SwitchStep }

type RuntimeRow = {
  id: number
  runtime: string
  backend_key: string
  session_uuid?: string | null
  native_thread_id?: string | null
  status: string
}
type RuntimeSnapshot = { sessions: RuntimeRow[]; runtimes: Record<string, boolean> }

export type UiMode = 'tui' | 'view'
/** Where builds before state.json kept the mode; read once to carry it over. */
const LEGACY_MODE_KEY = 'kode.sessionView'
export const uiMode = writable<UiMode>('tui')

/**
 * Restore the last session view mode before conversations come back, so a
 * Kode quit in dsh reopens in dsh. The backend keeps it in state.json and
 * writes it at once: WebKit's localStorage may not reach disk when Kode quits
 * right after a switch.
 */
export async function loadUiMode(): Promise<void> {
  let stored = await invoke<string>('get_session_view').catch(() => 'tui')
  try {
    const legacy = localStorage.getItem(LEGACY_MODE_KEY)
    if (legacy === 'view' && stored !== 'view') {
      await invoke('set_session_view', { mode: 'view' })
      stored = 'view'
    }
    localStorage.removeItem(LEGACY_MODE_KEY)
  } catch { /* best effort */ }
  uiMode.set(stored === 'view' ? 'view' : 'tui')
}

export type SwitchProgress = {
  to: 'view' | 'tui'
  title: string
  steps: SwitchStep[]
  current: SwitchStep
  /** Position of this conversation within a mode switch. */
  count: { current: number; total: number } | null
  /** Extension whose startup progress belongs to the `start` step. */
  extension: string | null
  viewTitle: string
}
/** The mode switch in flight, if any; drives the progress overlay. */
export const switchProgress = writable<SwitchProgress | null>(null)

/**
 * Conversations caught half-way through a move. Kode keeps one list of open
 * conversations for both modes (its tabs; on the view side, the runtime's
 * unarchived sessions), so closing one in the view is final. A move remembers
 * its conversation until the other side holds it, so a failed or interrupted
 * move resumes it as a terminal instead of losing it.
 */
type RosterEntry = { backendKey: string; sessionId: string; cwd: string; permissionMode?: TabInfo['permissionMode'] }
// v1 also kept every terminal that had moved to the view, including ones the
// user closed there since; those must not come back.
const ROSTER_KEY = 'kode.tuiRoster.v2'
function readRoster(): RosterEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(ROSTER_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((row) => row && typeof row.sessionId === 'string' && typeof row.backendKey === 'string' && typeof row.cwd === 'string') : []
  } catch { return [] }
}
function writeRoster(rows: RosterEntry[]) {
  try { rows.length ? localStorage.setItem(ROSTER_KEY, JSON.stringify(rows)) : localStorage.removeItem(ROSTER_KEY) } catch { /* best effort */ }
}
function forget(sessionId: string) {
  writeRoster(readRoster().filter((row) => row.sessionId !== sessionId))
}
function rememberAll(list: TabInfo[]) {
  if (!list.length) return
  const adding = new Set(list.map((tab) => tab.sessionId))
  const rows = readRoster().filter((row) => !adding.has(row.sessionId))
  for (const tab of list) {
    rows.push({ backendKey: tab.backendKey, sessionId: tab.sessionId!, cwd: tab.cwd!, permissionMode: tab.permissionMode })
  }
  writeRoster(rows)
}

/** Conversations the current mode could not take over, by native identity. */
export const migrationFailures = writable<Record<string, string>>({})
export const nativeKey = (tab: TabInfo) => `${tab.backendKey}:${tab.sessionId}`

const runtimeSnapshot = () => invoke<RuntimeSnapshot>('shared_runtime_sessions')
const dshTarget = () => viewForRuntime(get(sessionViews), 'dsh')

const SNAPSHOT_POLL_MS = 150
const VIEW_IMPORT_CONCURRENCY = 8
const TUI_RESUME_CONCURRENCY = 4

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(what)
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_MS))
  }
}

/** A PTY conversation the view's runtime can host. */
export function movableToView(tab: TabInfo, target: SessionViewTarget): boolean {
  return !tab.sharedRuntime && tab.transportKind !== 'acp' && tab.endpointId?.kind !== 'remote'
    && !!tab.sessionId && !!tab.cwd && target.view.backends.includes(tab.backendKey)
}
/** A runtime-hosted conversation backed by a native CLI thread Kode can resume. */
export function movableToTui(tab: TabInfo, target: SessionViewTarget): boolean {
  return !!tab.sharedRuntime && !!tab.sessionId && tab.sessionId !== tab.dshSessionId && !!tab.cwd
    && target.view.backends.includes(tab.backendKey)
}
/** Between turns, with nothing waiting on the user. */
const settled = (tab: TabInfo) => tab.status === 'idle' && !tab.attention

function restoreOrderAndFocus(
  initialOrder: SessionId[],
  previousActive: SessionId | null,
  replacements: Map<SessionId, SessionId>,
) {
  tabs.update((list) => reorderAfterBatch(list, initialOrder, replacements))
  const targetActive = targetActiveAfterBatch(previousActive, replacements, get(tabs))
  if (targetActive != null) selectTab(targetActive)
}

function createBatchProgress(
  mode: UiMode,
  announce: boolean,
  target: SessionViewTarget,
  items: TabInfo[],
  steps: SwitchStep[],
) {
  const stages = new Map<SessionId, SwitchStep>(items.map((tab) => [tab.id, steps[0]]))
  const total = items.length
  let done = 0
  let title = total === 1 ? (items[0]?.title ?? '') : ''
  const emit = () => {
    if (!announce) return
    switchProgress.set({
      to: mode,
      title,
      steps,
      current: batchCurrentStep(steps, stages.values()),
      count: total > 1 ? { current: done, total } : null,
      extension: target.extension,
      viewTitle: target.view.title,
    })
  }
  emit()
  return {
    stage(id: SessionId, next: SwitchStep, tabTitle?: string) {
      stages.set(id, next)
      if (total === 1 || tabTitle) title = tabTitle ?? title
      emit()
    },
    finish(id: SessionId, tabTitle?: string) {
      if (!stages.has(id)) return
      stages.delete(id)
      done++
      if (tabTitle) title = tabTitle
      emit()
    },
  }
}

async function startHost(target: SessionViewTarget) {
  const runtime = target.view.runtime!
  if ((await runtimeSnapshot().catch(() => null))?.runtimes[runtime]) return
  await extensionIpc.start(target.extension)
  await waitFor(`${target.extensionName} did not come online`, 60_000, async () => (await runtimeSnapshot()).runtimes[runtime])
}

/**
 * Starting in the view mode: bring the view's runtime up before conversations
 * are restored, so they open there directly instead of as terminals first.
 * Resolves with the backends it hosts, or null to restore as terminals.
 * If startup fails, self-heal back into TUI mode so the app is never stranded
 * in a broken view mode across restarts.
 */
export async function prepareViewRestore(onFallback?: (detail: string) => void): Promise<string[] | null> {
  const target = dshTarget()
  if (get(uiMode) !== 'view' || !target?.view.runtime) return null
  try {
    await startHost(target)
    await syncSharedSessions()
    return target.view.backends
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.warn('view runtime unavailable; falling back to terminals:', error)
    uiMode.set('tui')
    void invoke('set_session_view', { mode: 'tui' }).catch((e) => console.warn('session view fallback not saved:', e))
    onFallback?.(detail)
    return null
  }
}

/** Open a saved conversation in the view's runtime without a terminal. */
export async function openInView(saved: PersistedTab): Promise<TabInfo | null> {
  const target = dshTarget()
  if (!target?.view.runtime || !saved.session_id) return null
  const probe = { backendKey: saved.backend_key, sessionId: saved.session_id, cwd: saved.cwd } as TabInfo
  // A never-prompted terminal has nothing to show in the view.
  if (!await hasTranscript(probe)) return null
  const imported = await extensionIpc.runtimeImport(target.view.runtime, {
    backend_key: saved.backend_key,
    session_id: saved.session_id,
    cwd: saved.cwd,
    title: saved.title || undefined,
  })
  return waitFor('the structured session did not appear', 15_000, async () => {
    await syncSharedSessions()
    return get(tabs).find((t) => t.sharedRuntime && (imported.id != null ? t.id === imported.id : t.dshSessionId === imported.runtime_session_id))
  })
}

type OpenIdentity = { backend_key: string; session_id?: string | null; dsh_session_id?: string | null }
const identity = (row: OpenIdentity) => [row.session_id, row.dsh_session_id].filter(Boolean).map((id) => `${row.backend_key}:${id}`)

/**
 * One list of open conversations for both modes, which the view also edits
 * (`updateOpenTabs` in the dsh integration). A runtime-hosted session outside
 * `expected` (left from before the list was shared, or closed while the
 * runtime was down) is closed here too. Busy sessions stay.
 */
export async function alignSharedTabs(expected: OpenIdentity[]) {
  const open = new Set(expected.flatMap(identity))
  const extra = get(tabs).filter((tab) => tab.sharedRuntime && settled(tab)
    && !identity({ backend_key: tab.backendKey, session_id: tab.sessionId, dsh_session_id: tab.dshSessionId }).some((key) => open.has(key)))
  await Promise.all(extra.map((tab) => closeTab(tab.id).catch((error) => console.warn('closing a session the open list no longer has failed:', error))))
}

/** Align once the view's runtime comes online, for a start in the terminal
 *  mode that still brought it up (it hosts conversations of its own). */
export function alignWhenOnline(expected: OpenIdentity[]) {
  const runtime = dshTarget()?.view.runtime
  if (!runtime) return
  void waitFor('view runtime offline', 120_000, async () => (await runtimeSnapshot()).runtimes[runtime])
    .then(() => syncSharedSessions())
    .then(() => alignSharedTabs(expected))
    .catch(() => {})
}

/**
 * Batch PTY → extension runtime.
 * Stops all eligible terminals concurrently so the GUI bridge coalesces their
 * exits, shares one snapshot poller for exit/open detection, runs imports with
 * bounded concurrency, and restores original tab order & focus once done.
 */
async function moveBatchToView(activeDue: TabInfo[], target: SessionViewTarget, announce: boolean) {
  const runtime = target.view.runtime!
  const initialOrder = get(tabs).map((t) => t.id)
  const previousActive = get(activeId)
  const replacements = new Map<SessionId, SessionId>()
  const progress = createBatchProgress('view', announce, target, activeDue, ['stop', 'import', 'open'])
  // Until the view holds them; closing them there later is final.
  rememberAll(activeDue)
  // Fire all terminal kills together so backend_runtime.rs coalesces exits into one publish.
  await Promise.all(activeDue.map((tab) => closeTab(tab.id)))
  const exitPoller = new SnapshotPoller(SNAPSHOT_POLL_MS, runtimeSnapshot)
  const openPoller = new SnapshotPoller(SNAPSHOT_POLL_MS, async () => {
    await syncSharedSessions()
    return get(tabs)
  })
  const importLimit = createLimiter(VIEW_IMPORT_CONCURRENCY)
  const rollbackLimit = createLimiter(TUI_RESUME_CONCURRENCY)
  await Promise.all(activeDue.map(async (tab) => {
    const native = tab.sessionId!
    try {
      await exitPoller.waitFor(
        'the terminal session did not stop',
        15_000,
        (snap) => !snap.sessions.some((row) => row.runtime === 'gui' && row.session_uuid === native && row.status !== 'exited'),
      )
      if (get(uiMode) !== 'view') return
      progress.stage(tab.id, 'import', tab.title)
      const imported = await importLimit(() =>
        extensionIpc.runtimeImport(runtime, {
          backend_key: tab.backendKey,
          session_id: native,
          cwd: tab.cwd!,
          title: tab.title || undefined,
        }),
      )
      progress.stage(tab.id, 'open', tab.title)
      const id = await openPoller.waitFor(
        'the structured session did not appear',
        15_000,
        (list) => list.find((t) => t.sharedRuntime && (imported.id != null ? t.id === imported.id : t.dshSessionId === imported.runtime_session_id))?.id,
      )
      forget(native)
      replacements.set(tab.id, id)
    } catch (error) {
      // Hand the conversation back to a terminal rather than leave it nowhere.
      const back = await rollbackLimit(() =>
        newTab(tab.backendKey, { cwd: tab.cwd, resumeSessionId: native, permissionMode: tab.permissionMode, endpointId: ENDPOINT_LOCAL }),
      ).catch(() => null)
      if (back) {
        forget(native)
        replacements.set(tab.id, back.id)
      }
      const message = error instanceof Error ? error.message : String(error)
      migrationFailures.update((all) => ({ ...all, [nativeKey(tab)]: message }))
      onFailure?.(tab, message)
    } finally {
      progress.finish(tab.id, tab.title)
    }
  }))
  restoreOrderAndFocus(initialOrder, previousActive, replacements)
}

/**
 * Batch extension runtime → PTY.
 * Retires duplicate runtime copies, archives all unique conversations in
 * parallel so dsh settles them in one batch publish, verifies exit via one
 * shared poller, and resumes PTYs with bounded concurrency.
 */
async function moveBatchToTui(activeDue: TabInfo[], target: SessionViewTarget, announce: boolean) {
  const initialOrder = get(tabs).map((t) => t.id)
  const previousActive = get(activeId)
  const { toResume, toDrop } = partitionTuiTargets(activeDue, get(tabs))
  if (toDrop.length) await Promise.all(toDrop.map((tab) => dropCopy(tab)))
  if (!toResume.length) return
  const replacements = new Map<SessionId, SessionId>()
  const progress = createBatchProgress('tui', announce, target, toResume, ['stop', 'resume'])
  // Should any terminal fail to resume, the roster retries it later.
  rememberAll(toResume)
  const exitPoller = new SnapshotPoller(SNAPSHOT_POLL_MS, runtimeSnapshot)
  const resumeLimit = createLimiter(TUI_RESUME_CONCURRENCY)
  await Promise.all(toResume.map(async (tab) => {
    const native = tab.sessionId!
    try {
      // Archiving also stops the host's CLI process for this thread.
      await extensionIpc.runtimeArchive(tab.id)
      await exitPoller.waitFor(
        'the structured session did not stop',
        15_000,
        (snap) => !snap.sessions.some((row) => row.id === tab.id && row.status !== 'exited'),
      )
      if (get(uiMode) !== 'tui') return
      progress.stage(tab.id, 'resume', tab.title)
      tabs.update((list) => list.filter((t) => t.id !== tab.id))
      mountedIds.update((ids) => ids.filter((id) => id !== tab.id))
      if (get(activeId) === tab.id) activeId.set(null)
      const created = await resumeLimit(() =>
        newTab(tab.backendKey, { cwd: tab.cwd, resumeSessionId: native, endpointId: ENDPOINT_LOCAL }),
      )
      // The terminal holds it now, even before it reports its session id.
      forget(native)
      replacements.set(tab.id, created.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      migrationFailures.update((all) => ({ ...all, [nativeKey(tab)]: message }))
      onFailure?.(tab, message)
    } finally {
      progress.finish(tab.id, tab.title)
    }
  }))
  restoreOrderAndFocus(initialOrder, previousActive, replacements)
}

let running: Promise<void> | null = null
let again = false

/**
 * Move every settled conversation into the current mode's runtime.
 * `announce` shows the progress overlay (an explicit mode switch); later
 * passes pick up turns that have ended, quietly.
 */
function reconcile(announce = false): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    try {
      do {
        again = false
        await reconcileOnce(announce)
        announce = false
      } while (again)
    } finally {
      running = null
      switchProgress.set(null)
    }
  })()
  return running
}

/**
 * In TUI mode: resume remembered terminals no tab holds and no runtime still
 * drives (a busy dsh turn moves back on its own once it ends). An entry
 * leaves the roster once a tab holds it, so closing that tab later is final.
 */
async function restoreRoster() {
  const rows = readRoster()
  if (!rows.length) return
  const live = await runtimeSnapshot().catch(() => null)
  if (!live) return
  const kept: RosterEntry[] = []
  const toRestore: RosterEntry[] = []
  for (const row of rows) {
    if (get(uiMode) !== 'tui') { kept.push(row); continue }
    if (get(tabs).some((tab) => tab.sessionId === row.sessionId)) continue
    const key = `${row.backendKey}:${row.sessionId}`
    const driven = live.sessions.some((r) => r.status !== 'exited' && (r.session_uuid === row.sessionId || r.native_thread_id === row.sessionId))
    if (driven || get(migrationFailures)[key]) { kept.push(row); continue }
    toRestore.push(row)
  }
  if (toRestore.length) {
    const previous = get(activeId)
    await runPool(toRestore, TUI_RESUME_CONCURRENCY, async (row) => {
      if (get(uiMode) !== 'tui') { kept.push(row); return }
      if (get(tabs).some((tab) => tab.sessionId === row.sessionId)) return
      const key = `${row.backendKey}:${row.sessionId}`
      try {
        await newTab(row.backendKey, { cwd: row.cwd, resumeSessionId: row.sessionId, permissionMode: row.permissionMode, endpointId: ENDPOINT_LOCAL })
      } catch (error) {
        kept.push(row)
        migrationFailures.update((all) => ({ ...all, [key]: error instanceof Error ? error.message : String(error) }))
      }
    })
    // Restoring in the background must not steal focus.
    if (previous != null && get(tabs).some((tab) => tab.id === previous)) selectTab(previous)
  }
  // Keep anything remembered while this pass ran.
  const seen = new Set(rows.map((row) => row.sessionId))
  writeRoster([...kept, ...readRoster().filter((row) => !seen.has(row.sessionId))])
}

async function reconcileOnce(announce: boolean) {
  const mode = get(uiMode)
  const target = dshTarget()
  try {
    if (target?.view.runtime) await moveAll(mode, announce, target)
  } finally {
    if (mode === 'tui') await restoreRoster()
  }
}

/** Sessions found without a transcript, rechecked after a while: a terminal
 * writes its transcript on the first prompt. */
const blank = new Map<string, number>()
const BLANK_RECHECK_MS = 60_000
async function hasTranscript(tab: TabInfo): Promise<boolean> {
  const key = nativeKey(tab), missed = blank.get(key)
  if (missed && Date.now() - missed < BLANK_RECHECK_MS) return false
  const available = await invoke<boolean>('native_transcript_available', { backendKey: tab.backendKey, sessionId: tab.sessionId, cwd: tab.cwd }).catch(() => true)
  if (available) blank.delete(key); else blank.set(key, Date.now())
  return available
}

/** Retire a runtime copy of a conversation a terminal already holds. */
async function dropCopy(tab: TabInfo) {
  await extensionIpc.runtimeArchive(tab.id).catch(() => {})
  tabs.update((list) => list.filter((t) => t.id !== tab.id))
  mountedIds.update((ids) => ids.filter((id) => id !== tab.id))
  if (get(activeId) === tab.id) activeId.set(null)
}

async function moveAll(mode: UiMode, announce: boolean, target: SessionViewTarget) {
  const failed = get(migrationFailures)
  let due = get(tabs).filter((tab) =>
    (mode === 'view' ? movableToView(tab, target) : movableToTui(tab, target)) && settled(tab) && !failed[nativeKey(tab)],
  )
  // A never-prompted terminal has nothing to show in the view; it simply
  // stays a terminal instead of failing the move.
  if (mode === 'view') {
    const present = await Promise.all(due.map(hasTranscript))
    due = due.filter((_, index) => present[index])
  }
  if (!due.length && !(announce && mode === 'view')) return
  if (mode === 'view') {
    if (announce) switchProgress.set({
      to: mode, title: due.length === 1 ? (due[0]?.title ?? '') : '', steps: ['start'], current: 'start',
      count: due.length > 1 ? { current: 0, total: due.length } : null,
      extension: target.extension, viewTitle: target.view.title,
    })
    const before = get(tabs).map((tab) => ({ backend_key: tab.backendKey, session_id: tab.sessionId, dsh_session_id: tab.dshSessionId }))
    await startHost(target)
    // The runtime publishes what it last had open. The open list is shared
    // (the view edits it too), so keep what it holds as well as what Kode had
    // in front before the switch.
    const saved = await ipc.getPersistedTabs().catch(() => null)
    await syncSharedSessions()
    if (saved) await alignSharedTabs([...before, ...saved])
  }
  if (get(uiMode) !== mode) return
  const liveById = new Map(get(tabs).map((tab) => [tab.id, tab]))
  const activeDue = due
    .map((stale) => liveById.get(stale.id))
    .filter((tab): tab is TabInfo => Boolean(tab && settled(tab)))
  if (!activeDue.length) return
  if (mode === 'view') await moveBatchToView(activeDue, target, announce)
  else await moveBatchToTui(activeDue, target, announce)
}

let onFailure: ((tab: TabInfo, message: string) => void) | null = null
let watching = false
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Keep conversations in the current mode's runtime: a turn that ends, a
 * session the other runtime publishes, a restored tab all follow the mode.
 */
export function startModeWatch(failure: (tab: TabInfo, message: string) => void) {
  onFailure = failure
  if (watching) return
  watching = true
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void reconcile() }, 400)
  }
  tabs.subscribe(schedule)
  sessionViews.subscribe(schedule)
  if (get(uiMode) === 'view') {
    const target = dshTarget()
    if (target) void startHost(target).catch(() => {})
  }
}

/** Switch every conversation to `mode`. Resolves once the settled ones moved. */
export async function setUiMode(mode: UiMode): Promise<void> {
  const previous = get(uiMode)
  if (mode === 'view' && previous !== 'view') {
    const target = dshTarget()
    if (!target?.view.runtime) throw new Error('dsh extension is not available')
    // Start the runtime BEFORE committing `view` mode to memory or state.json,
    // so a startup failure (e.g. missing/old Node or install error) never
    // strands the app in a broken view mode.
    switchProgress.set({
      to: 'view',
      title: '',
      steps: ['start'],
      current: 'start',
      count: null,
      extension: target.extension,
      viewTitle: target.view.title,
    })
    try {
      await startHost(target)
    } catch (error) {
      switchProgress.set(null)
      throw error
    }
  }
  void invoke('set_session_view', { mode }).catch((error) => console.warn('session view not saved:', error))
  const changed = previous !== mode
  uiMode.set(mode)
  if (changed) migrationFailures.set({})
  await reconcile(true)
}

/** Try one conversation again after a failed move. */
export function retryMigration(tab: TabInfo) {
  migrationFailures.update((all) => {
    const next = { ...all }
    delete next[nativeKey(tab)]
    return next
  })
  void reconcile(true)
}
