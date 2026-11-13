// 恢复编排的纯决策层 —— 故意不 import 任何 Tauri / svelte / 其它模块,
// 这样 `node --test` 能直接 import 它。`sessions.ts` 保留所有 I/O 与模块级
// 状态(restoring / failedRestoreTabs / store / schedulePersist),只调用这里的
// `planRestoreTabs` 与 `finalizeRestore`。搬动时逐行对齐原 restoreTabs 语义。

export interface EndpointIdLike {
  kind: string
  id?: string
}

/// 与 `ipc.ts::PersistedTab` 结构兼容的最小输入(PersistedTab 可赋给它)。
export interface RestoreTabInput {
  backend_key: string
  title: string
  cwd: string
  dsh_session_id?: string
  transport_kind?: 'acp' | 'pty' | 'runtime' | null
  title_pinned?: boolean
  workspace_title?: string | null
  session_id?: string | null
  model?: string | null
  permission_mode?: string | null
  endpoint_id?: EndpointIdLike | null
  avatar_id?: string | null
}

/// 与 `sessions.ts::SharedSession` 结构兼容(泛型保留原类型)。
export interface SharedRow {
  id: number
  backend_key: string
  status?: string | null
  runtime_session_id?: string | null
  native_thread_id?: string | null
}

export interface SpawnOptions {
  cwd?: string
  transportKind: 'acp' | 'pty'
  resumeSessionId: string | null
  permissionMode: 'default' | 'bypass' | null
  model: string | null
  endpointId: EndpointIdLike
}

export interface RestoreProgress {
  current: number
  total: number
  name: string
}

export type PlanStep<T extends RestoreTabInput, S extends SharedRow> =
  | { kind: 'shared'; input: T; owner: S; progress: RestoreProgress }
  | { kind: 'spawn'; input: T; options: SpawnOptions; progress: RestoreProgress }
  | { kind: 'failed'; input: T; reason: string; progress: RestoreProgress }

export interface PlanDeps<E extends EndpointIdLike> {
  sanitizeModelName: (raw: string) => string
  localEndpoint: E
}

const RUNTIME_UNAVAILABLE =
  'The owning runtime is unavailable. Reconnect it before reopening this shared session.'

function persistedEndpointKey(endpointId: EndpointIdLike | null | undefined): string {
  if (!endpointId || endpointId.kind === 'local') return 'local'
  return `remote:${endpointId.id}`
}

/// 按 backend_key + endpoint + session_id 去重,无 session_id 的项原样保留。
export function dedupePersistedTabs<T extends RestoreTabInput>(list: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const tab of list) {
    const sessionId = tab.session_id?.trim()
    if (!sessionId) {
      out.push(tab)
      continue
    }
    const key = `${tab.backend_key}\u0000${persistedEndpointKey(tab.endpoint_id)}\u0000${sessionId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tab)
  }
  return out
}

/// 把持久化项 + shared 列表变成一组决策;不产生任何副作用。
/// - shared:命中在线 owner → 复用 shared tab,不 spawn
/// - failed:runtime transport 且无 owner → 执行层按 reason 抛错并记入失败
/// - spawn:其余走 newTab,options 已收窄好 model / permission / endpoint
export function planRestoreTabs<
  T extends RestoreTabInput,
  S extends SharedRow,
  E extends EndpointIdLike,
>(persisted: T[], shared: S[], deps: PlanDeps<E>): PlanStep<T, S>[] {
  const list = dedupePersistedTabs(persisted)
  return list.map((p, index) => {
    const progress: RestoreProgress = {
      current: index + 1,
      total: list.length,
      name: p.title || p.backend_key,
    }
    const owner = p.session_id && shared.find((row) =>
      (row.native_thread_id === p.session_id ||
        row.runtime_session_id === p.session_id ||
        row.runtime_session_id === p.dsh_session_id) &&
      row.backend_key === p.backend_key &&
      row.status !== 'exited',
    )
    if (owner) return { kind: 'shared', input: p, owner, progress } as const
    if (p.transport_kind === 'runtime') {
      return { kind: 'failed', input: p, reason: RUNTIME_UNAVAILABLE, progress } as const
    }
    // permission_mode 持久化值是 "default" | "bypass" | null;其它值降级 null。
    const mode = p.permission_mode === 'bypass' || p.permission_mode === 'default'
      ? p.permission_mode
      : null
    // model 持久化值 = 上次实际用过的 model 名(jsonl_tail 同步过,包括用户在
    // 子进程里 `/model` 切换后回写)。空字符串 / 'auto' 是没回写时的占位值。
    // sanitize 防御早期 jsonl_tail 没清理的 codebuddy note 后缀(含换行)落盘成脏值,
    // 否则会被原样塞进 `--model` argv 导致子进程异常。
    const rawModel = p.model && p.model !== '' && p.model !== 'auto' ? p.model : null
    const restoredModel = rawModel ? deps.sanitizeModelName(rawModel) || null : null
    // null / 缺失 → Local(老 v1 兼容);只有显式 remote 才还原。
    // 前提:11.4 持久化的 endpoint 已由 restore_persisted_endpoints 注册到
    // transports map(早于 restoreTabs)。endpoint 被删但 tab 没删干净时,
    // spawn 会返 transport not registered,执行层 catch 跳过、不阻断别的 tab。
    const endpointId: EndpointIdLike =
      p.endpoint_id && p.endpoint_id.kind === 'remote' ? p.endpoint_id : deps.localEndpoint
    return {
      kind: 'spawn',
      input: p,
      progress,
      options: {
        cwd: p.cwd || undefined,
        transportKind: p.transport_kind ?? 'pty',
        resumeSessionId: p.session_id ?? null,
        permissionMode: mode,
        model: restoredModel,
        endpointId,
      },
    } as const
  })
}

/// 收尾:全部成功才清空失败列表并补一次 persist;有失败时失败 tab 原样保留,
/// 避免「成功 tab 子集」覆盖 state.json。对应原 `ok === list.length && ok > 0`。
export function finalizeRestore(total: number, ok: number): { clearFailed: boolean; persist: boolean } {
  const success = ok === total && ok > 0
  return { clearFailed: success, persist: success }
}
