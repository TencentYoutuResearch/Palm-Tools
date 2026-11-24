/**
 * Kode extensions on the frontend: the installed list (live, follows
 * `extensions-changed`) and the session views they contribute.
 *
 * A session view belongs to a workbench runtime (dsh). Tabs hosted by that
 * runtime render in the view's native webview; PTY tabs of the view's
 * backends can be switched into the runtime and back (see runtime_switch.ts).
 */
import { derived, get, writable } from 'svelte/store'
import { pushToast } from './toast'
import { extensionIpc, type ExtensionInfo, type ExtensionPanel, type ExtensionUiMessage, type ExtensionProgress, type ExtensionSessionView, type ExtensionViewAction, type PersistedTab } from './ipc'

export const extensions = writable<ExtensionInfo[]>([])
/** Latest startup progress per extension, cleared once its backend runs. */
export const extensionProgress = writable<Record<string, ExtensionProgress>>({})

export type SessionViewTarget = {
  extension: string
  extensionName: string
  view: ExtensionSessionView
}

export const sessionViews = derived(extensions, (list): SessionViewTarget[] =>
  list
    .filter((ext) => ext.enabled && !ext.error && ext.manifest)
    .flatMap((ext) =>
      ext.manifest!.contributes.sessionViews.map((view) => ({
        extension: ext.id,
        extensionName: ext.manifest!.name,
        view,
      })),
    ),
)

/** Anything Kode hosts in a native extension webview. */
export type ViewTarget = {
  extension: string
  extensionName: string
  view: { id: string; title: string }
}

export type PanelTarget = {
  extension: string
  extensionName: string
  view: ExtensionPanel
}

export const panels = derived(extensions, (list): PanelTarget[] =>
  list
    .filter((ext) => ext.enabled && !ext.error && ext.manifest)
    .flatMap((ext) =>
      (ext.manifest!.contributes.panels ?? []).map((view) => ({
        extension: ext.id,
        extensionName: ext.manifest!.name,
        view,
      })),
    ),
)

export const panelKey = (target: { extension: string; view: { id: string } }) => `${target.extension}:${target.view.id}`

/** Unread-style counts a panel page reports through `kodeHost.request('badge')`. */
export const panelBadges = writable<Record<string, number>>({})

export function viewForRuntime(views: SessionViewTarget[], runtime: string | undefined): SessionViewTarget | null {
  if (!runtime) return null
  return views.find((target) => target.view.runtime === runtime) ?? null
}

export function viewForBackend(views: SessionViewTarget[], backendKey: string): SessionViewTarget | null {
  return views.find((target) => target.view.runtime && target.view.backends.includes(backendKey)) ?? null
}

export async function refreshExtensions(): Promise<void> {
  extensions.set(await extensionIpc.list())
}

let watching = false
export async function startExtensionWatch(onViewAction: (action: ExtensionViewAction) => void): Promise<void> {
  if (watching) return
  watching = true
  await extensionIpc.onChanged(() => {
    void refreshExtensions()
      .then(() => {
        const running = new Set(get(extensions).filter((ext) => ext.running).map((ext) => ext.id))
        extensionProgress.update((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !running.has(id))))
      })
      .catch((error) => console.warn('extensions refresh failed:', error))
  })
  await extensionIpc.onProgress((progress) => extensionProgress.update((all) => ({ ...all, [progress.id]: progress })))
  await extensionIpc.onViewAction(onViewAction)
  await extensionIpc.onUi(onUiMessage)
  await refreshExtensions().catch((error) => console.warn('extensions unavailable:', error))
}

/** Badges go to the rail (and dsh's sidebar); notifications become toasts
 *  named after the extension, and only for enabled extensions. */
function onUiMessage(message: ExtensionUiMessage) {
  const ext = get(extensions).find((e) => e.id === message.extension && e.enabled)
  if (!ext) return
  if (message.type === 'badge') {
    if (!(ext.manifest?.contributes.panels ?? []).some((p) => p.id === message.panel)) return
    panelBadges.update((all) => ({ ...all, [`${message.extension}:${message.panel}`]: message.count }))
  } else {
    pushToast({ severity: message.severity, title: `${ext.manifest?.name ?? ext.id} · ${message.title}`, detail: message.body || undefined, durationMs: 6000 })
  }
}

/**
 * Runtime-hosted tabs come back only once their host runs again. Start the
 * hosts the previous run had tabs in; everything else stays lazy so an idle
 * Kode does not keep extension servers alive.
 */
export function autostartRuntimeHosts(persisted: PersistedTab[]): void {
  if (!persisted.some((tab) => tab.transport_kind === 'runtime')) return
  const started = new Set<string>()
  for (const target of get(sessionViews)) {
    if (!target.view.runtime || started.has(target.extension)) continue
    started.add(target.extension)
    void extensionIpc.start(target.extension).catch((error) => console.warn(`extension ${target.extension} failed to start:`, error))
  }
}
