/**
 * Move one conversation between Kode's PTY runtime (TUI view) and an
 * extension runtime such as dsh (structured view).
 *
 * Both runtimes resume the same native CLI thread (Codex thread id, Claude
 * session id); only one may drive it at a time, or both CLIs would append to
 * the same rollout/jsonl. Every switch therefore stops the current driver
 * first and waits until the workbench no longer lists it as live before the
 * other side resumes. Switching only happens between turns.
 */
import { get, writable } from 'svelte/store'
import { invoke } from '@tauri-apps/api/core'
import { ENDPOINT_LOCAL, extensionIpc, type SessionId } from './ipc'
import { activeId, closeTab, mountedIds, newTab, selectTab, syncSharedSessions, tabs, type TabInfo } from './sessions'
import { sessionViews, type SessionViewTarget } from './extensions'

type RuntimeRow = {
  id: number
  runtime: string
  backend_key: string
  session_uuid?: string | null
  native_thread_id?: string | null
  status: string
}
type RuntimeSnapshot = { sessions: RuntimeRow[]; runtimes: Record<string, boolean> }

export type SwitchStep = 'start' | 'stop' | 'import' | 'open' | 'resume'
export type SwitchProgress = {
  to: 'view' | 'tui'
  title: string
  steps: SwitchStep[]
  current: SwitchStep
  /** Extension whose startup progress belongs to the `start` step. */
  extension: string | null
  viewTitle: string
}
/** The switch in flight, if any; drives the progress overlay. */
export const switchProgress = writable<SwitchProgress | null>(null)
const step = (current: SwitchStep) => switchProgress.update((p) => (p ? { ...p, current } : p))

const runtimeSnapshot = () => invoke<RuntimeSnapshot>('shared_runtime_sessions')

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(what)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

export type SwitchBlocker = 'remote' | 'no_session' | 'busy' | null

/** Why a PTY tab cannot move into an extension runtime right now. */
export function toRuntimeBlocker(tab: TabInfo): SwitchBlocker {
  if (tab.endpointId?.kind === 'remote') return 'remote'
  if (!tab.sessionId || !tab.cwd) return 'no_session'
  if (tab.status !== 'idle') return 'busy'
  return null
}

/** Why a runtime-hosted tab cannot move back into a PTY right now. */
export function toTuiBlocker(tab: TabInfo): SwitchBlocker {
  if (!tab.sessionId || !tab.cwd) return 'no_session'
  if (tab.status === 'busy' || tab.status === 'starting') return 'busy'
  return null
}

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

/** PTY → extension runtime. Resolves with the runtime-hosted tab id. */
export async function switchToRuntime(tab: TabInfo, target: SessionViewTarget): Promise<SessionId> {
  const runtime = target.view.runtime
  if (!runtime) throw new Error(`${target.extensionName} has no runtime`)
  const blocker = toRuntimeBlocker(tab)
  if (blocker) throw new Error(blocker)
  const native = tab.sessionId!
  const index = get(tabs).findIndex((t) => t.id === tab.id)
  switchProgress.set({ to: 'view', title: tab.title, steps: ['start', 'stop', 'import', 'open'], current: 'start', extension: target.extension, viewTitle: target.view.title })
  try {
    return await moveToRuntime(tab, target, runtime, native, index)
  } finally {
    switchProgress.set(null)
  }
}

async function moveToRuntime(tab: TabInfo, target: SessionViewTarget, runtime: string, native: string, index: number): Promise<SessionId> {
  // Bring the host up before stopping anything, so a broken extension never
  // costs the user their running terminal.
  await extensionIpc.start(target.extension)
  await waitFor(`${target.extensionName} did not come online`, 60_000, async () => (await runtimeSnapshot()).runtimes[runtime])

  step('stop')
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
    selectTab(id)
    return id
  } catch (error) {
    // Hand the conversation back to a terminal rather than leave it nowhere.
    await newTab(tab.backendKey, { cwd: tab.cwd, resumeSessionId: native, permissionMode: tab.permissionMode, endpointId: ENDPOINT_LOCAL }).catch(() => {})
    throw error
  }
}

/** Extension runtime → PTY. Resolves with the new terminal tab id. */
export async function switchToTui(tab: TabInfo): Promise<SessionId> {
  const blocker = toTuiBlocker(tab)
  if (blocker) throw new Error(blocker)
  const native = tab.sessionId!
  const index = get(tabs).findIndex((t) => t.id === tab.id)
  const target = get(sessionViews).find((view) => view.view.runtime === 'dsh')
  switchProgress.set({ to: 'tui', title: tab.title, steps: ['stop', 'resume'], current: 'stop', extension: null, viewTitle: target?.view.title ?? 'dsh' })
  try {
    return await moveToTui(tab, native, index)
  } finally {
    switchProgress.set(null)
  }
}

async function moveToTui(tab: TabInfo, native: string, index: number): Promise<SessionId> {
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
  placeAt(created.id, index)
  return created.id
}
