/**
 * Account / cloud connection status pushed by the desktop backend as
 * `cloud-status` whenever it changes (agent socket connecting or dropping,
 * sign-in, sign-out, profile updates). Surfaces that show it subscribe here
 * instead of reading status only when they open.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { CloudSyncStatus } from './ipc'

/** Calls `listener` with every pushed status until the returned stop runs. */
export function watchCloudStatus(listener: (status: CloudSyncStatus) => void): () => void {
  let stopped = false
  let unlisten: UnlistenFn | undefined
  void listen<CloudSyncStatus>('cloud-status', ({ payload }) => listener(payload)).then((stop) => {
    if (stopped) stop()
    else unlisten = stop
  })
  return () => {
    stopped = true
    unlisten?.()
  }
}
