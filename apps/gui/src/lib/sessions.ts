import { writable, get, derived } from 'svelte/store'
import {
  ipc,
  ENDPOINT_LOCAL,
  endpointRemote,
  type EndpointId,
  type SessionId,
  type SpawnedSession,
  type PersistedTab,
  type SessionStatus,
  type PermissionMode,
} from './ipc'
import { sanitizeModelName } from './model_alias'
import {
  addOrUpdateAppEvent,
  clearAppEvents,
  clearAppEventsForSession,
} from './app_events'
import { pushToast } from './toast'

export interface TabInfo {
  id: SessionId
  backendKey: string
  title: string
  /// 用户手动重命名过;为 true 时 jsonl/remote meta 的 ai title 不再覆盖 tab 标题。
  titlePinned?: boolean
  model: string
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  costUsd?: number
  /// 启动时的 cwd —— 持久化用
  cwd?: string
  /// 子进程的 --session-id;恢复时用 --resume <sid>
  sessionId?: string | null
  /// 用户视角 permission mode("default" / "bypass");spawn 时通过 CLI 注入子进程
  /// (后端把 "bypass" 翻译成 bypassPermissions)。持久化到 state.json。
  permissionMode?: PermissionMode | null
  /// Phase 11.2:本 tab 跑的 transport。Local 默认不持久化字段(老 tab 兼容);
  /// Remote { id } 写入 PersistedTab.endpoint_id 让 restore 还原。
  endpointId?: EndpointId
  /// 用户选定的 gallery avatar id(null/undefined = 用 backend icon 作 fallback)。
  /// 对应 AvatarLibrary.gallery[].name。只影响 UI 展示,不传给子进程。
  avatarId?: string | null
  exited?: number | null
  unread?: boolean
  /// "需要用户操作"标记 — Rust 端推 session-attention 时置位,
  /// 用户切到该 tab 时清掉。值 = 最近一次提示类型(ask / plan),
  /// UI 据此可以选不同颜色的脉冲(目前都用 amber)。
  attention?: 'ask' | 'plan' | null
  /// 真实运行状态(子进程在干活 vs 静止 vs 已退出)。
  /// 由 Rust scan_loop 每 200ms tick 后 emit `session-status` 推过来。
  /// 默认 'starting' 直到第一次扫描完成。
  status?: SessionStatus
}

export const tabs = writable<TabInfo[]>([])
export const activeId = writable<SessionId | null>(null)

/**
 * 已 mount 的 xterm 实例 id 列表。
 *
 * **关键:这个数组按插入顺序排,不参与 LRU 重排** —— 之前把它当 LRU 数组用时,
 * 每次 selectTab 都会把 id 挪到末尾,触发 svelte each block 的 DOM move,
 * xterm WebGL viewport 状态在 DOM 移动 + display:none↔block 切换的组合下会
 * 失效(滚动条 thumb 飘到顶部,即使内容显示的是最新行)。
 *
 * 不做 LRU eviction:dispose 后只能通过 get_screen_snapshot() 恢复当前 vt100 屏幕,
 * 不包含 xterm scrollback,会导致切回长输出 tab 时滚动条消失。保持 terminal
 * 实例常驻,由父级 visibility:hidden 隐藏 inactive tab。
 */
export const mountedIds = writable<SessionId[]>([])

export const activeTab = derived([tabs, activeId], ([$tabs, $id]) => {
  return $tabs.find((t) => t.id === $id) ?? null
})

export interface NewTabOptions {
  cwd?: string
  resumeSessionId?: string | null
  permissionMode?: PermissionMode | null
  /// 用户在 BackendChooser 选定的 model;restore 时回填上次保存的值。
  /// undefined / null = 不传 --model,后端走 backend.default_model。
  model?: string | null
  /// Phase 11.2 endpoint。undefined / Local = 走本地 PTY 老路径。
  endpointId?: EndpointId
}

/// 新建 tab。所有 spawn 路径(BackendChooser / restoreTabs / 命令面板 quick pick)都走这里。
/// `permissionMode` 是用户视角("default" / "bypass"),后端会翻译成子进程实际取值。
export async function newTab(
  backendKey: string,
  opts: NewTabOptions = {},
): Promise<TabInfo> {
  const { cwd, resumeSessionId, permissionMode, model, endpointId } = opts
  const s: SpawnedSession = await ipc.spawnSession(
    backendKey,
    80,
    24,
    cwd,
    resumeSessionId ?? null,
    permissionMode ?? null,
    model ?? null,
    endpointId ?? null,
  )
  const t: TabInfo = {
    id: s.id,
    backendKey: s.backend_key,
    title: s.title,
    model: s.model,
    // 后端 resolve_session_cwd 会兜底(显式 > override > KODE_CWD > current_dir > $HOME),
    // 前端没传 cwd 时也能拿到真实生效路径,所以优先用 s.cwd。
    cwd: s.cwd || cwd,
    sessionId: s.session_id,
    permissionMode: permissionMode ?? null,
    // 后端返回的 endpoint_id 是权威来源(用户传 null 时后端兜底成 Local)
    endpointId: s.endpoint_id,
    titlePinned: false,
  }
  tabs.update((arr) => arr.some((existing) => existing.id === t.id)
    ? arr.map((existing) => existing.id === t.id ? { ...existing, ...t } : existing)
    : [...arr, t])
  activeId.set(s.id)
  ensureMounted(s.id)
  schedulePersist()
  return t
}

export async function closeTab(id: SessionId) {
  const tab = get(tabs).find((t) => t.id === id)
  await ipc.killSession(id, tab?.endpointId ?? null).catch(() => {})
  clearAppEventsForSession(id)
  tabs.update((arr) => arr.filter((t) => t.id !== id))
  mountedIds.update((arr) => arr.filter((x) => x !== id))
  // 切到下一个 tab
  const remaining = get(tabs)
  if (get(activeId) === id) {
    activeId.set(remaining[remaining.length - 1]?.id ?? null)
  }
  schedulePersist()
}

export function selectTab(id: SessionId) {
  activeId.set(id)
  // 切到当前 tab → 仅清未读(普通流量)。
  // **不**清 attention:必须真正回答 prompt(Rust 端 scan_loop 检测到屏幕清掉后会
  // emit session-attention-clear)attention 才会消失。否则用户随便点一下 tab 就
  // 误以为"已处理",再忘了去回答。
  tabs.update((arr) => arr.map((t) => (t.id === id ? { ...t, unread: false } : t)))
  clearAppEvents((event) => event.sessionId === id && event.kind === 'turn_finished')
  ensureMounted(id)
}

/**
 * 确保 tab 对应的 Terminal 已 mount。
 *
 * 只 append 新 id,不按最近访问重排,保证 Svelte each block 的 key 顺序稳定 →
 * 没有 DOM move → xterm viewport/WebGL 状态不被搅乱。关闭 tab 时才 unmount。
 */
export function ensureMounted(id: SessionId) {
  mountedIds.update((arr) => (arr.includes(id) ? arr : [...arr, id]))
}

/// 本地 session DTO(来自 session-created 或 session-focus-requested)→ upsert 一个本地 tab。
/// 已存在则不动,不存在则 append 并 mount。SpecOps "Open in kode" 在主窗口
/// 尚无该 tab 时靠它补建。
function upsertLocalTabFromDto(dto: {
  id: SessionId
  backend_key?: string
  title?: string
  model?: string
  status?: SessionStatus
  cwd?: string | null
  session_uuid?: string | null
}): void {
  tabs.update((arr) => {
    if (arr.some((tab) => tab.id === dto.id)) return arr
    return [...arr, {
      id: dto.id,
      backendKey: dto.backend_key ?? '',
      title: dto.title ?? '',
      model: dto.model ?? '',
      ...(dto.cwd ? { cwd: dto.cwd } : {}),
      sessionId: dto.session_uuid ?? undefined,
      endpointId: ENDPOINT_LOCAL,
      titlePinned: false,
      status: dto.status ?? 'idle',
    }]
  })
  ensureMounted(dto.id)
}

// 元数据 / 退出事件订阅(全局一次)
let metaUnlisten: (() => void) | null = null
let createdUnlisten: (() => void) | null = null
let exitUnlisten: (() => void) | null = null
let attentionUnlisten: (() => void) | null = null
let attentionClearUnlisten: (() => void) | null = null
let turnFinishedUnlisten: (() => void) | null = null
let statusUnlisten: (() => void) | null = null
let focusUnlisten: (() => void) | null = null

export async function startEventSubscriptions() {
  if (metaUnlisten) return
  const subscribedAt = Date.now()
  const STARTUP_REPLAY_SUPPRESS_MS = 4_000

  function shouldSuppressAttentionEvent(tab: TabInfo | undefined): boolean {
    if (!tab?.sessionId) return false
    if (tab.status === 'starting') return true
    return Date.now() - subscribedAt < STARTUP_REPLAY_SUPPRESS_MS
  }

  createdUnlisten = await ipc.onSessionCreated((session) => {
    console.log('[session-created] received event, id=%d backend=%s', session.id, session.backend_key)
    upsertLocalTabFromDto(session)
    schedulePersist()
  })
  metaUnlisten = await ipc.onSessionMeta((m) => {
    if (m.model) console.debug('[session-meta] id=%d model=%s', m.id, m.model)
    tabs.update((arr) =>
      arr.map((t) => {
        if (t.id !== m.id) return t
        const next: TabInfo = {
          ...t,
          ...(m.title && !t.titlePinned ? { title: m.title } : null),
          ...(m.model ? { model: m.model } : null),
          ...(m.session_id ? { sessionId: m.session_id } : null),
        }
        if (m.tokens_reset) {
          delete next.tokens
          delete next.inputTokens
          delete next.outputTokens
          delete next.cachedTokens
          delete next.costUsd
        }
        if (m.tokens != null) next.tokens = m.tokens
        if (m.input_tokens != null) next.inputTokens = m.input_tokens
        if (m.output_tokens != null) next.outputTokens = m.output_tokens
        if (m.cached_tokens != null) next.cachedTokens = m.cached_tokens
        if (m.cost_usd != null) next.costUsd = m.cost_usd
        return next
      }),
    )
    // title / model / session_id 变了要持久化(token / cost 不持久化,频繁变化没意义)
    if (m.title || m.model || m.session_id) schedulePersist()
  })
  exitUnlisten = await ipc.onSessionExited((m) => {
    // 子进程退出 → tab 直接从列表消失(不展示 exited 状态)。复用 closeTab 的
    // 清理顺序:过滤 tab、清 mountedIds、若是 active 则切到下一个。后端 bridge
    // 仍保留该 session(mark_exited),SpecOps 的 monitor 还能再 poll 一次拿到
    // 最终 transcript —— 我们只是前端隐藏。
    // 但需要给用户一个明确提示(tab 静默消失会让人困惑):
    //   1) toast 弹一下 4s
    //   2) event center 留一条 system 条目(不绑 sessionId,tab 即将不存在)
    const tab = get(tabs).find((t) => t.id === m.id)
    const exitTitle = tab?.title || tab?.backendKey || `Session ${m.id}`
    pushToast({
      severity: 'info',
      title: 'Session exited',
      detail: exitTitle,
      durationMs: 4000,
    })
    addOrUpdateAppEvent({
      kind: 'system',
      severity: 'info',
      dedupeKey: `session_exited:${m.id}`,
      title: 'event_center.kind.session_exited',
      detail: exitTitle,
      source: tab?.backendKey,
    })
    tabs.update((arr) => arr.filter((t) => t.id !== m.id))
    mountedIds.update((arr) => arr.filter((x) => x !== m.id))
    clearAppEventsForSession(m.id)
    if (get(activeId) === m.id) {
      const remaining = get(tabs)
      activeId.set(remaining[remaining.length - 1]?.id ?? null)
    }
    schedulePersist()
  })
  /** attention 置位时的 timestamp（ms），用于保证动效至少显示足够久 */
  let attentionSince = new Map<SessionId, number>()

  attentionUnlisten = await ipc.onSessionAttention((m) => {
    // 不论是不是 active tab,都标记 — active tab 仍然要看到提示(降级动画)
    attentionSince.set(m.id, Date.now())
    const tab = get(tabs).find((t) => t.id === m.id)
    if (!shouldSuppressAttentionEvent(tab)) {
      addOrUpdateAppEvent({
        kind: 'attention',
        severity: 'warning',
        sessionId: m.id,
        dedupeKey: `attention:${m.id}`,
        title: m.kind === 'plan' ? 'event_center.kind.attention_plan' : 'event_center.kind.attention_ask',
        detail: tab?.title ? `${tab.title} · ${tab.backendKey}` : undefined,
        source: tab?.backendKey,
      })
    }
    tabs.update((arr) =>
      arr.map((t) => (t.id === m.id ? { ...t, attention: m.kind } : t)),
    )
  })
  attentionClearUnlisten = await ipc.onSessionAttentionClear((m) => {
    // Hook relay 信号是 authoritative 的,无需最小可见延迟。
    // scan_loop 的 detect()=None 也是可靠的(prompt 确实从屏幕消失)。
    tabs.update((arr) =>
      arr.map((t) => (t.id === m.id ? { ...t, attention: null } : t)),
    )
    clearAppEvents((event) => event.dedupeKey === `attention:${m.id}`)
    attentionSince.delete(m.id)
  })
  turnFinishedUnlisten = await ipc.onSessionTurnFinished((m) => {
    const tab = get(tabs).find((t) => t.id === m.id)
    const isActive = get(activeId) === m.id
    const summary = m.summary?.trim()
    const detailParts = [
      tab?.title ? `${tab.title} · ${tab.backendKey}` : tab?.backendKey,
      summary,
    ].filter(Boolean)
    const detail = detailParts.join('\n')

    // 对话结束统一进「提示通知」(event center),不再用右下角弹窗。
    // active / 后台 tab 都入池;仅后台 tab 额外标 unread(切回时 selectTab 会清掉)。
    //
    // turn_finished 来源:
    //   - codex:semantic.rs parse_codex 的 task_complete 事件(带 turn_id)
    //   - codebuddy/claude:hook_relay 的 Stop 事件(agent 真正停止,不带 turn_id)
    // codebuddy 不再基于 jsonl status=completed emit(那条是"message 流完",
    // 一轮会有多条,导致提前弹"完成")。
    //
    // dedupeKey:codex 有 turn_id 用三元 key 精确区分每一轮;
    // codebuddy/claude 回退到 `turn_finished:{id}`,同 session 只保留最新一条。
    const dedupeKey = m.turn_id
      ? `turn_finished:${m.id}:${m.turn_id}`
      : `turn_finished:${m.id}`
    addOrUpdateAppEvent({
      kind: 'turn_finished',
      severity: 'success',
      sessionId: m.id,
      dedupeKey,
      title: 'event_center.kind.turn_finished',
      detail,
      source: tab?.backendKey,
    })
    if (!isActive && tab) {
      tabs.update((arr) =>
        arr.map((t) => (t.id === m.id ? { ...t, unread: true } : t)),
      )
    }
  })
  statusUnlisten = await ipc.onSessionStatus((m) => {
    tabs.update((arr) =>
      arr.map((t) => (t.id === m.id ? { ...t, status: m.status } : t)),
    )
  })
  focusUnlisten = await ipc.onSessionFocusRequested((m) => {
    // SpecOps headless 创建的 session 在主窗口可能还没 tab(错过 session-created
    // 或主窗口刚启动)。此时用 focus payload 里的 DTO 补建,而不是静默忽略。
    upsertLocalTabFromDto(m)
    selectTab(m.id)
    // SpecOps 是独立窗口,会盖住主窗口。focus 必须把主窗口拉到最前,否则 tab
    // 切换发生在 SpecOps 窗口背后,看起来像什么都没发生。用 Rust 命令聚焦
    // "main" 窗口 —— macOS 上比 webview 层 setFocus 更可靠。
    void ipc.focusMainWindow().catch(() => undefined)
  })
}

export function stopEventSubscriptions() {
  metaUnlisten?.()
  createdUnlisten?.()
  exitUnlisten?.()
  attentionUnlisten?.()
  attentionClearUnlisten?.()
  turnFinishedUnlisten?.()
  statusUnlisten?.()
  focusUnlisten?.()
  metaUnlisten = null
  createdUnlisten = null
  exitUnlisten = null
  attentionUnlisten = null
  attentionClearUnlisten = null
  turnFinishedUnlisten = null
  statusUnlisten = null
  focusUnlisten = null
}

// ============ 持久化 ============
// 前端节流再触发后端 save_tabs;后端再 debounce 落盘。
// 双层 debounce 不冲突 —— 前端这层用来避免每次 keystroke 级别的 store 更新都打 IPC。
let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_FRONT_DEBOUNCE_MS = 200

/**
 * restore 进行中标记 —— restoreTabs 期间每个 newTab 会调 schedulePersist,
 * 但若部分 tab spawn 失败(backend 缺失 / cwd 不存在 / resume 失败),
 * 直接落盘会用「只含成功 tab」的 $tabs 覆盖 state.json,**永久丢失失败 tab 的持久化项**。
 * 下次启动再也无法恢复这些 tab。
 *
 * **restoring 标记不够**:restore 结束后异步的 onSessionMeta(jsonl_tail 回报
 * model/title)仍会触发 schedulePersist,此时 $tabs 只含成功 tab → 依然覆盖。
 * 所以额外用 `failedRestoreTabs` 记录失败 tab,schedulePersist 合并 $tabs + 失败 tab
 * 一起落盘,失败 tab 永远不会从 state.json 丢掉,直到下次 restore 成功或用户手动开同 session。
 */
let restoring = false
/** 上次 restore 失败的 tab(原样保留持久化项),schedulePersist 会合并它们落盘。 */
let failedRestoreTabs: PersistedTab[] = []

function persistedEndpointKey(endpointId: EndpointId | null | undefined): string {
  if (!endpointId || endpointId.kind === 'local') return 'local'
  return `remote:${endpointId.id}`
}

function dedupePersistedTabs(list: PersistedTab[]): PersistedTab[] {
  const seen = new Set<string>()
  const out: PersistedTab[] = []
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

export function schedulePersist() {
  // restore 期间跳过 —— 见 restoring 注释。失败 tab 不应被「成功 tab 子集」覆盖。
  if (restoring) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const liveTabs: PersistedTab[] = get(tabs).map((t) => ({
      backend_key: t.backendKey,
      title: t.title,
      title_pinned: t.titlePinned ?? false,
      cwd: t.cwd ?? '',
      session_id: t.sessionId ?? null,
      // model 走 store 里实时同步的值 — jsonl_tail 上报新 model 时 onSessionMeta 已经更新过 t.model,
      // 这里取就是最新值。空字符串("auto")也存,反正 restore 时按用户上次状态恢复。
      model: t.model ?? null,
      permission_mode: t.permissionMode ?? null,
      // Phase 11.2:Local endpoint 不写字段(老 tab 兼容,持久化最小)。
      // Remote 必须写入,否则 restore 时只能降级成本地 spawn。
      endpoint_id:
        t.endpointId && t.endpointId.kind === 'remote' ? t.endpointId : null,
      avatar_id: t.avatarId ?? null,
    }))
    // 合并 restore 失败 tab:它们不在 $tabs 里(没 spawn 成功),但 state.json 必须保留
    // 才能下次启动重试。按 session_id 去重(live 优先)。
    const liveSids = new Set(liveTabs.map((t) => t.session_id?.trim()).filter(Boolean) as string[])
    const merged = dedupePersistedTabs([
      ...liveTabs,
      ...failedRestoreTabs.filter((t) => t.session_id?.trim() && !liveSids.has(t.session_id!.trim())),
    ])
    ipc.saveTabs(merged).catch((e) => console.warn('saveTabs failed:', e))
  }, PERSIST_FRONT_DEBOUNCE_MS)
}

/// 启动时调,把上次会话恢复成新 tab。
/// 若 PersistedTab 带 session_id,会走 --resume 让子进程加载历史 + 复用 jsonl(token/ctx 立刻显示)。
/// 否则降级为普通 spawn(老 v1 持久化文件兜底)。
/// permission_mode / model 也透传 — bypass 的 tab 重启后仍然 bypass、上次选的 model 重启后仍然生效。
export async function restoreTabs(persisted: PersistedTab[]): Promise<number> {
  // restoring 标记让 schedulePersist 全程跳过 —— 避免「成功 tab 子集」覆盖 state.json
  // 导致失败 tab 的持久化项被永久清掉。结束后按成功与否决定是否补一次 persist。
  restoring = true
  failedRestoreTabs = [] // 清空上次的,本次重新记录
  const list = dedupePersistedTabs(persisted)
  let ok = 0
  try {
    for (const p of list) {
      try {
        // permission_mode 在持久化字段里是 "default" | "bypass" | null;
        // 收窄到 PermissionMode 类型(字符串校验,其它值降级 null)。
        const mode = p.permission_mode === 'bypass' || p.permission_mode === 'default'
          ? (p.permission_mode as PermissionMode)
          : null
        // model 持久化值 = 上次实际用过的 model 名(jsonl_tail 同步过的 — 包括用户在子进程
        // 里 `/model` 切换后回写的那次)。restore 时直接用同一名字注入 `--model`,
        // 子进程首帧就跑在对的模型上(不需要等 jsonl tail)。
        // 空字符串 / 'auto' 当 null 处理 — 这是 jsonl_tail 没回写过 model 时的占位值。
        // 同时跑一遍 sanitize 防御历史脏持久化值:早期 jsonl_tail 没清理 codebuddy
        // 夹带的 note 后缀(含换行),那些脏值可能已落盘到 state.json,restore 时
        // 不清理会被原样塞进 `--model` argv 导致子进程异常。
        const rawModel = p.model && p.model !== '' && p.model !== 'auto' ? p.model : null
        const restoredModel = rawModel ? sanitizeModelName(rawModel) || null : null
        // Phase 11.2 endpoint 还原。`null` / 缺失 → Local(老 tab 兼容)。
        // Remote 还原前提是 11.4 持久化的 endpoint 已经被 restore_persisted_endpoints
        // 注册到 transports map(在 AppState::new 里早于 restoreTabs)。
        // 如果 endpoint 已被用户删但 tab 没删干净 → spawn 命令会返 transport not registered,
        // catch 里跳过这条 — 不阻断别的 tab 恢复。
        const endpointId: EndpointId | undefined =
          p.endpoint_id && p.endpoint_id.kind === 'remote'
            ? p.endpoint_id
            : ENDPOINT_LOCAL
        const restored = await newTab(p.backend_key, {
          cwd: p.cwd || undefined,
          resumeSessionId: p.session_id ?? null,
          permissionMode: mode,
          model: restoredModel,
          endpointId,
        })
        if (p.title) {
          tabs.update((arr) =>
            arr.map((t) =>
              t.id === restored.id
                ? { ...t, title: p.title, titlePinned: p.title_pinned ?? false }
                : t,
            ),
          )
        }
        // 还原用户选定的 avatar id(老 state.json 没这字段 → null → backend fallback)
        if (p.avatar_id) {
          tabs.update((arr) =>
            arr.map((t) => (t.id === restored.id ? { ...t, avatarId: p.avatar_id! } : t)),
          )
        }
        ok++
      } catch (e) {
        // 记录失败 tab,让 schedulePersist 合并落盘 —— 不让它从 state.json 永久消失
        failedRestoreTabs.push(p)
        console.warn(`restore tab ${p.backend_key}@${p.cwd} failed:`, e)
      }
    }
  } finally {
    restoring = false
  }
  // 全部成功 → 清空失败列表 + 补一次 persist 落盘最新状态。
  // 有失败 → 失败 tab 留在 failedRestoreTabs,后续 schedulePersist 会合并它们落盘。
  if (ok === list.length && ok > 0) {
    failedRestoreTabs = []
    schedulePersist()
  }
  return ok
}

export function renameTab(id: SessionId, title: string) {
  tabs.update((arr) =>
    arr.map((t) => (t.id === id ? { ...t, title, titlePinned: true } : t)),
  )
  schedulePersist()
}

/**
 * 设置 tab 的 gallery avatar id。
 * 传 null 清掉自定义,回退到 backend icon fallback。
 * 只影响 UI 展示,不传给子进程。持久化到 state.json 的 avatar_id 字段。
 */
export function setTabAvatar(id: SessionId, avatarId: string | null) {
  tabs.update((arr) =>
    arr.map((t) => (t.id === id ? { ...t, avatarId } : t)),
  )
  schedulePersist()
}

/**
 * 拖拽重排 tabs。只在 dnd finalize 时调用 —— consider 阶段用 tabs.update
 * 直接刷视觉,不走这里(避免每 move 一次就 schedulePersist)。
 *
 * **不碰 mountedIds** —— xterm WebGL viewport 依赖 mountedIds 插入顺序稳定
 * (见上方 mountedIds 注释)。tabs 重排只影响 .tab 行 DOM,Terminal 实例在
 * 独立 each block,不受影响。
 */
export function reorderTabs(nextOrder: SessionId[]) {
  tabs.update((arr) => {
    const byId = new Map(arr.map((t) => [t.id, t]))
    const next: TabInfo[] = []
    for (const id of nextOrder) {
      const t = byId.get(id)
      if (t) {
        next.push(t)
        byId.delete(id)
      }
    }
    // 保险:nextOrder 漏掉的 id(理论不会)追加到末尾
    for (const t of byId.values()) next.push(t)
    return next
  })
  schedulePersist()
}

/**
 * 复制 tab 配置开新 session。**不**继承 jsonl 历史 —— 显式不传 resumeSessionId,
 * 后端 spawn_session 会走 Session::new 路径注入新 uuid。
 *
 * 继承:backendKey / cwd / model / permissionMode / endpointId。
 * 新 tab 的 title 由 backend ai-title 流回来(newTab 已设 titlePinned: false)。
 */
export async function duplicateTab(id: SessionId) {
  const src = get(tabs).find((t) => t.id === id)
  if (!src) return
  const model = src.model && src.model !== 'auto' ? sanitizeModelName(src.model) || null : null
  const dup = await newTab(src.backendKey, {
    cwd: src.cwd,
    model,
    permissionMode: src.permissionMode ?? null,
    endpointId: src.endpointId,
    // 显式不传 resumeSessionId —— 新 session,空历史
  })
  // 继承 avatarId(用户选定的头像随 duplicate 一起带过去)
  if (src.avatarId) {
    tabs.update((arr) =>
      arr.map((t) => (t.id === dup.id ? { ...t, avatarId: src.avatarId } : t)),
    )
    schedulePersist()
  }
}
