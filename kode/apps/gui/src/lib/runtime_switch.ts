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
import { ENDPOINT_LOCAL, extensionIpc, type SessionId } from './ipc'
import { activeId, closeTab, mountedIds, newTab, selectTab, syncSharedSessions, tabs, type TabInfo } from './sessions'
import { sessionViews, viewForRuntime, type SessionViewTarget } from './extensions'

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
const MODE_KEY = 'kode.sessionView'
function storedMode(): UiMode {
  try { return localStorage.getItem(MODE_KEY) === 'view' ? 'view' : 'tui' } catch { return 'tui' }
}
export const uiMode = writable<UiMode>(storedMode())

export type SwitchStep = 'start' | 'stop' | 'import' | 'open' | 'resume'
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
const step = (current: SwitchStep) => switchProgress.update((p) => (p ? { ...p, current } : p))

/**
 * TUI mode's own conversation list, kept apart from dsh's. Every terminal
 * that leaves for the view is remembered here and resumed when Kode returns
 * to TUI, whatever dsh did with it meanwhile (archive, restart, failed
 * import). dsh's catalog and archive are never consulted or changed.
 */
type RosterEntry = { backendKey: string; sessionId: string; cwd: string; permissionMode?: TabInfo['permissionMode'] }
const ROSTER_KEY = 'kode.tuiRoster'
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
function remember(tab: TabInfo) {
  const rows = readRoster().filter((row) => row.sessionId !== tab.sessionId)
  rows.push({ backendKey: tab.backendKey, sessionId: tab.sessionId!, cwd: tab.cwd!, permissionMode: tab.permissionMode })
  writeRoster(rows)
}

/** Conversations the current mode could not take over, by native identity. */
export const migrationFailures = writable<Record<string, string>>({})
export const nativeKey = (tab: TabInfo) => `${tab.backendKey}:${tab.sessionId}`

const runtimeSnapshot = () => invoke<RuntimeSnapshot>('shared_runtime_sessions')
const dshTarget = () => viewForRuntime(get(sessionViews), 'dsh')

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(what)
    await new Promise((resolve) => setTimeout(resolve, 300))
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

function placeAt(id: SessionId, index: number) {
  tabs.update((list) => {
    const from = list.findIndex((tab) => tab.id === id)
    if (from < 0 || index < 0) return list
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(Math.min(index, next.length), 0, moved)
    return next
  })
}

/** Spawning a tab activates it; a background move must not steal focus. */
function restoreFocus(previous: SessionId | null, moved: SessionId, replacement: SessionId | null) {
  if (previous === moved) {
    if (replacement != null) selectTab(replacement)
  } else if (previous != null && get(tabs).some((tab) => tab.id === previous)) {
    selectTab(previous)
  }
}

async function startHost(target: SessionViewTarget) {
  const runtime = target.view.runtime!
  if ((await runtimeSnapshot().catch(() => null))?.runtimes[runtime]) return
  await extensionIpc.start(target.extension)
  await waitFor(`${target.extensionName} did not come online`, 60_000, async () => (await runtimeSnapshot()).runtimes[runtime])
}

/** PTY → extension runtime. Resolves with the runtime-hosted tab id. */
async function moveToView(tab: TabInfo, target: SessionViewTarget): Promise<SessionId> {
  const runtime = target.view.runtime!
  const native = tab.sessionId!
  const index = get(tabs).findIndex((t) => t.id === tab.id)
  const previous = get(activeId)
  step('stop')
  remember(tab)
  await closeTab(tab.id)
  try {
    await waitFor('the terminal session did not stop', 15_000, async () =>
      !(await runtimeSnapshot()).sessions.some((row) => row.runtime === 'gui' && row.session_uuid === native && row.status !== 'exited'),
    )
    step('import')
    const imported = await extensionIpc.runtimeImport(runtime, {
      backend_key: tab.backendKey,
      session_id: native,
      cwd: tab.cwd!,
      title: tab.title || undefined,
    })
    step('open')
    const id = await waitFor('the structured session did not appear', 15_000, async () => {
      await syncSharedSessions()
      const row = get(tabs).find((t) => t.sharedRuntime && (imported.id != null ? t.id === imported.id : t.dshSessionId === imported.runtime_session_id))
      return row?.id
    })
    placeAt(id, index)
    restoreFocus(previous, tab.id, id)
    return id
  } catch (error) {
    // Hand the conversation back to a terminal rather than leave it nowhere.
    const back = await newTab(tab.backendKey, { cwd: tab.cwd, resumeSessionId: native, permissionMode: tab.permissionMode, endpointId: ENDPOINT_LOCAL }).catch(() => null)
    if (back) placeAt(back.id, index)
    restoreFocus(previous, tab.id, back?.id ?? null)
    throw error
  }
}

/** Extension runtime → PTY. Resolves with the new terminal tab id. */
async function moveToTui(tab: TabInfo): Promise<SessionId> {
  const native = tab.sessionId!
  const index = get(tabs).findIndex((t) => t.id === tab.id)
  const previous = get(activeId)
  step('stop')
  // Should the terminal fail to resume, the roster retries it later.
  remember(tab)
  // Archiving also stops the host's CLI process for this thread.
  await extensionIpc.runtimeArchive(tab.id)
  await waitFor('the structured session did not stop', 15_000, async () =>
    !(await runtimeSnapshot()).sessions.some((row) => row.id === tab.id && row.status !== 'exited'),
  )
  step('resume')
  tabs.update((list) => list.filter((t) => t.id !== tab.id))
  mountedIds.update((ids) => ids.filter((id) => id !== tab.id))
  if (get(activeId) === tab.id) activeId.set(null)
  const created = await newTab(tab.backendKey, { cwd: tab.cwd, resumeSessionId: native, endpointId: ENDPOINT_LOCAL })
  // The terminal holds it now, even before it reports its session id.
  forget(native)
  placeAt(created.id, index)
  restoreFocus(previous, tab.id, created.id)
  return created.id
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
  for (const row of rows) {
    if (get(uiMode) !== 'tui') { kept.push(row); continue }
    if (get(tabs).some((tab) => tab.sessionId === row.sessionId)) continue
    const key = `${row.backendKey}:${row.sessionId}`
    const driven = live.sessions.some((r) => r.status !== 'exited' && (r.session_uuid === row.sessionId || r.native_thread_id === row.sessionId))
    if (driven || get(migrationFailures)[key]) { kept.push(row); continue }
    const previous = get(activeId)
    try {
      await newTab(row.backendKey, { cwd: row.cwd, resumeSessionId: row.sessionId, permissionMode: row.permissionMode, endpointId: ENDPOINT_LOCAL })
      // Restoring in the background must not steal focus.
      if (previous != null && get(tabs).some((tab) => tab.id === previous)) selectTab(previous)
    } catch (error) {
      kept.push(row)
      migrationFailures.update((all) => ({ ...all, [key]: error instanceof Error ? error.message : String(error) }))
    }
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
  const progress = (tab: TabInfo | null, index: number, steps: SwitchStep[]) => {
    if (announce) switchProgress.set({
      to: mode, title: tab?.title ?? '', steps, current: steps[0],
      count: due.length > 1 && tab ? { current: index + 1, total: due.length } : null,
      extension: target.extension, viewTitle: target.view.title,
    })
  }
  if (mode === 'view') {
    progress(due[0] ?? null, 0, ['start'])
    await startHost(target)
  }
  // A fresh terminal may not report its session id yet.
  const resumed = new Set<string>()
  for (const [index, stale] of due.entries()) {
    // Earlier moves and the user may have changed it meanwhile.
    const tab = get(tabs).find((t) => t.id === stale.id)
    if (!tab || !settled(tab) || get(uiMode) !== mode) continue
    progress(tab, index, mode === 'view' ? ['stop', 'import', 'open'] : ['stop', 'resume'])
    // One terminal per native session: further runtime copies of a
    // conversation a terminal already holds are retired, not resumed again.
    if (mode === 'tui' && (resumed.has(tab.sessionId!) || get(tabs).some((t) => !t.sharedRuntime && t.sessionId === tab.sessionId))) {
      await dropCopy(tab)
      continue
    }
    try {
      if (mode === 'view') await moveToView(tab, target)
      else { resumed.add(tab.sessionId!); await moveToTui(tab) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      migrationFailures.update((all) => ({ ...all, [nativeKey(tab)]: message }))
      onFailure?.(tab, message)
    }
  }
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
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* Session-only preference still works. */ }
  const changed = get(uiMode) !== mode
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
