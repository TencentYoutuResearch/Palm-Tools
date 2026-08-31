/**
 * Tauri IPC wrapper —— 把后端 commands 包成强类型函数。
 */
import { invoke, Channel } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

export type SessionId = number

export interface BackendInfo {
  key: string
  command: string
  default_model: string | null
  model_flag: string | null
}

export interface DiscoveredModel {
  id: string
  label: string
  description?: string
  is_default: boolean
}

export interface ModelDiscoveryResult {
  backend: string
  source: string
  version?: string
  custom_allowed: boolean
  models: DiscoveredModel[]
  warning?: string
}

/// Settings 面板用的 backend 列表项 —— 比 BackendInfo 多 enabled 字段,
/// 因为 Settings 要展示全部(含被关掉的)backend 及其开关状态。
export interface BackendListItem {
  key: string
  command: string
  default_model: string | null
  /** is_enabled() 折算后的 bool(None / Some(true) → true) */
  enabled: boolean
}

export interface AvatarSet {
  name: string
  frames: string[]
}

export interface AvatarLibrary {
  running: AvatarSet[]
  awaiting: AvatarSet[]
  idle: AvatarSet[]
  error: AvatarSet[]
  /// 用户可选的 avatar 池,独立于状态类别。
  /// tab 选定后前端记 avatarId 对应到 set.name,null/缺失 = backend fallback。
  gallery: AvatarSet[]
}

export interface AvatarGenerationPrompt {
  prompt: string
  skill_path: string
  gallery_dir: string
  locale: string
}

export interface SpecOpsSession {
  origin: string
  token: string
  workspace: string
}

/// `EndpointId` 镜像 — 后端 `kode_core::transport::EndpointId` 序列化形态。
/// `Local` 单例;`Remote` 带 id(用户配 endpoint 时起的)。
export type EndpointId = { kind: 'local' } | { kind: 'remote'; id: string }

/// 全局唯一 Local 单例,避免每次构造对象。
export const ENDPOINT_LOCAL: EndpointId = { kind: 'local' }
/// 拼一个 Remote endpoint ID。
export function endpointRemote(id: string): EndpointId {
  return { kind: 'remote', id }
}

export interface SpawnedSession {
  id: SessionId
  backend_key: string
  model: string
  title: string
  /// 子进程 --session-id;持久化时存,恢复时回传
  session_id: string | null
  /// 后端 resolve_session_cwd 解析出的实际生效 cwd(显式 > override > KODE_CWD > current_dir > $HOME)
  /// 前端没传 cwd 时也能拿到,用于状态栏显示
  cwd: string
  /// Phase 11.2:本 session 走的 transport endpoint。前端持久化 + 后续 invoke 用
  endpoint_id: EndpointId
}

/// 用户视角 permission mode 简称(spawn 时传后端,后端把 'bypass' 翻译成 bypassPermissions)。
/// 'default' 与 undefined / null 等价,均不注入 flag(子进程默认即 default)。
export type PermissionMode = 'default' | 'bypass'

export interface SessionMeta {
  id: SessionId
  model?: string
  title?: string
  /// jsonl 上报的真实 session uuid。codebuddy /clear 会切换到新 uuid。
  session_id?: string | null
  tokens_reset?: boolean
  tokens?: number
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  cost_usd?: number
  context_pct?: number
}

export interface SessionCreatedEvent {
  id: SessionId
  backend_key: string
  title: string
  model: string
  status: SessionStatus
  cwd: string | null
  session_uuid: string | null
}

export interface SessionExited {
  id: SessionId
  code: number | null
}

/// "需要用户操作"提示。Rust 端在收到 ask_user_question / plan_proposed 时 emit。
/// 前端用来触发 sidebar tab 的脉冲动效。
export interface SessionAttention {
  id: SessionId
  /// 'ask' = AskUserQuestion / Ink select 等待回答
  /// 'plan' = ExitPlanMode 等待 Accept/Reject
  kind: 'ask' | 'plan'
}

/// "等待回应已解除"。Rust 端在 prompt 真的从屏幕消失后 emit;
/// 用户点开 tab **不**会发这个事件 — 必须真正回答 prompt 才解除。
export interface SessionAttentionClear {
  id: SessionId
}

/// 一轮模型回复完成。由 jsonl/rollout 语义解析产生,不是 PTY 退出。
export interface SessionTurnFinished {
  id: SessionId
  status?: 'completed' | string
  summary?: string | null
  duration_ms?: number | null
  turn_id?: string | null
}

/// session 真实运行状态(从 Core::SessionState::Status 同步)。
/// - starting:子进程刚 spawn 还在 init
/// - idle:静止状态(用户在等输入,或工作完成)
/// - busy:子进程正在干活(打印输出 / 跑工具)
/// - exited:已退出
export type SessionStatus = 'starting' | 'idle' | 'busy' | 'exited'

export interface SessionStatusEvent {
  id: SessionId
  status: SessionStatus
}

export type ModelUsagePeriod = 'today' | 'month' | 'all'

export interface ModelUsageTotals {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  total_tokens: number
  cost_usd: number
}

export interface ModelUsageRow extends ModelUsageTotals {
  backend: 'codex' | 'claude' | 'codebuddy' | string
  model: string
  requests: number
}

export interface ModelUsageSnapshot {
  period: ModelUsagePeriod
  scanned_files: number
  rows: ModelUsageRow[]
  totals: ModelUsageTotals
  daily: { date: string; total_tokens: number }[]
}

export const modelUsageIpc = {
  snapshot: (period: ModelUsagePeriod) =>
    invoke<ModelUsageSnapshot>('model_usage_snapshot', { period }),
}

export interface ModelMonitorLayout {
  isNotched: boolean
  notchWidth: number
  notchHeight: number
  menuBarHeight: number
}

export const modelMonitorIpc = {
  setExpanded: (expanded: boolean) =>
    invoke<void>('model_monitor_set_expanded', { expanded }),
  fitHeight: (height: number) =>
    invoke<void>('model_monitor_fit_height', { height }),
  reposition: () => invoke<ModelMonitorLayout>('model_monitor_reposition'),
  onLayoutChanged: (cb: (layout: ModelMonitorLayout) => void) =>
    getCurrentWebviewWindow().listen<ModelMonitorLayout>(
      'model-monitor-layout-changed',
      (event) => cb(event.payload),
    ),
  onNativeHoverChanged: (cb: (hovered: boolean) => void) =>
    getCurrentWebviewWindow().listen<boolean>(
      'model-monitor-native-hover-changed',
      (event) => cb(event.payload),
    ),
  onThemeChanged: (cb: (theme: ThemeMode) => void) =>
    listen<string>('theme-changed', (event) => cb(event.payload as ThemeMode)),
}

/// SpecOps "Open in kode" 触发。payload 携带完整 session DTO,
/// 主窗口 tab 缺失时据此补建(字段与 SessionCreatedEvent 一致)。
/// DTO 字段标记为可选以兼容只带 id 的旧/降级路径。
export interface SessionFocusRequestedEvent {
  id: SessionId
  backend_key?: string
  title?: string
  model?: string
  status?: SessionStatus
  cwd?: string | null
  session_uuid?: string | null
}

export interface PersistedTab {
  backend_key: string
  title: string
  /// 用户手动重命名过;为 true 时恢复后不让后端 ai title 覆盖。
  title_pinned?: boolean
  cwd: string
  session_id?: string | null
  /// 上次保存时的 model(jsonl 自动同步;用户在子进程里 `/model` 切换会触发回写)
  model?: string | null
  /// 用户视角 permission mode 简称("default" / "bypass" / null)
  permission_mode?: string | null
  /// Phase 11.2:本 tab 跑的 transport endpoint。null / 缺失 = Local(向后兼容,
  /// 老 v1 持久化文件没有这字段);Remote { id } 才会写入。restore 时按这个还原。
  endpoint_id?: EndpointId | null
  /// 用户选定的 gallery avatar id(null/缺失 = 用 backend icon 作 fallback)。
  /// 对应 AvatarLibrary.gallery[].name。只影响 UI 展示,不传给子进程。
  avatar_id?: string | null
}

/// 全局 UI 主题。null 也按 system 处理。
export type ThemeMode = 'light' | 'dark' | 'system'
/// 全局 UI 语言。system 走浏览器/系统语言。
export type LocaleMode = 'en' | 'zh-CN' | 'system'

export const ipc = {
  listBackends: () => invoke<BackendInfo[]>('list_backends'),
  discoverBackendModels: (backendKey: string) =>
    invoke<ModelDiscoveryResult>('discover_backend_models', { backendKey }),
  /** Settings 面板用:返回全部 backend(含 disabled),带 enabled 字段 */
  listAllBackends: () => invoke<BackendListItem[]>('list_all_backends'),
  listAvatarLibrary: () => invoke<AvatarLibrary>('list_avatar_library'),
  getAvatarGenerationPrompt: (locale?: 'en' | 'zh-CN') =>
    invoke<AvatarGenerationPrompt>('get_avatar_generation_prompt', { locale: locale ?? null }),
  spawnSession: (
    backend_key: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume_session_id?: string | null,
    permission_mode?: PermissionMode | null,
    /// 用户在 BackendChooser 选定的 model;restore 时也传上次保存的值。
    /// undefined / null = 不传 --model,后端走 backend.default_model 老语义。
    model?: string | null,
    /// Phase 11.2 endpoint。undefined / null / Local = 走本地 PTY(改造前老路径)。
    /// Remote { id } = 走 RemoteTransport。
    endpoint_id?: EndpointId | null,
    /// Kode xterm 当前主题,注入 TERM_THEME/COLORFGBG 给子 CLI。
    term_theme?: 'light' | 'dark' | null,
  ) =>
    invoke<SpawnedSession>('spawn_session', {
      backendKey: backend_key,
      cols,
      rows,
      cwd,
      resumeSessionId: resume_session_id ?? null,
      // 'default' 跟 null 等价 — 后端 inject_permission_mode_flag 都短路。
      // 这里仍传字符串,后端有 default/None/"" 三态都不注入的逻辑,前端不需要预过滤。
      permissionMode: permission_mode ?? null,
      model: model ?? null,
      endpointId: endpoint_id ?? null,
      termTheme: term_theme ?? null,
    }),
  /// 写入 PTY。**按 endpoint 自动分流**:
  ///   - Local → sync command `write_input`(顺序保证,见 commands.rs 注释)
  ///   - Remote → async command `write_input_remote`(HTTP POST,顺序由 reqwest
  ///     keep-alive 保证)
  writeInput: (id: SessionId, bytes: Uint8Array, endpoint_id?: EndpointId | null) => {
    if (!endpoint_id || endpoint_id.kind === 'local') {
      return invoke<void>('write_input', { id, bytes: Array.from(bytes) })
    }
    return invoke<void>('write_input_remote', {
      id,
      bytes: Array.from(bytes),
      endpointId: endpoint_id,
    })
  },
  resizeSession: (id: SessionId, cols: number, rows: number, endpoint_id?: EndpointId | null) =>
    invoke<void>('resize_session', { id, cols, rows, endpointId: endpoint_id ?? null }),
  killSession: (id: SessionId, endpoint_id?: EndpointId | null) =>
    invoke<void>('kill_session', { id, endpointId: endpoint_id ?? null }),
  setTitle: (id: SessionId, title: string) =>
    invoke<void>('set_title', { id, title }),
  /**
   * 订阅高频字节流 —— 用 Tauri 2 的 Channel<Vec<u8>>(直接 typed array,无 base64 开销)。
   * 后端原子返回订阅前积累的原始 PTY 字节并安装 channel。channel 可能在 invoke
   * 返回后立刻来消息,所以先在本地排队;Terminal 回放 initialBytes 后再调用 start。
   */
  subscribeSessionBytes: async (
    id: SessionId,
    onBytes: (data: Uint8Array) => void,
  ): Promise<{
    initialBytes: Uint8Array
    start: () => void
    unsubscribe: () => Promise<void>
  }> => {
    const subscriptionId = crypto.randomUUID()
    const queued: Uint8Array[] = []
    let started = false
    const ch = new Channel<number[]>()
    ch.onmessage = (data) => {
      const bytes = new Uint8Array(data)
      if (started) {
        onBytes(bytes)
      } else {
        queued.push(bytes)
      }
    }
    const initial = await invoke<number[]>('subscribe_session_bytes', {
      id,
      onBytes: ch,
      subscriptionId,
    })
    return {
      initialBytes: new Uint8Array(initial),
      start: () => {
        if (started) return
        started = true
        for (const bytes of queued) onBytes(bytes)
        queued.length = 0
      },
      unsubscribe: () =>
        invoke<void>('unsubscribe_session_bytes', { id, subscriptionId }),
    }
  },
  // 低频事件 —— emit 即可
  onSessionMeta: (cb: (m: SessionMeta) => void): Promise<UnlistenFn> =>
    listen<SessionMeta>('session-meta', (e) => cb(e.payload)),
  onSessionCreated: (cb: (m: SessionCreatedEvent) => void): Promise<UnlistenFn> =>
    listen<SessionCreatedEvent>('session-created', (e) => cb(e.payload)),
  onSessionExited: (cb: (m: SessionExited) => void): Promise<UnlistenFn> =>
    listen<SessionExited>('session-exited', (e) => cb(e.payload)),
  /** 需要用户操作的提示 — sidebar tab 应展示动效 */
  onSessionAttention: (cb: (m: SessionAttention) => void): Promise<UnlistenFn> =>
    listen<SessionAttention>('session-attention', (e) => cb(e.payload)),
  /** 用户已回应 prompt(屏幕清掉)— 关掉动效 */
  onSessionAttentionClear: (cb: (m: SessionAttentionClear) => void): Promise<UnlistenFn> =>
    listen<SessionAttentionClear>('session-attention-clear', (e) => cb(e.payload)),
  /** 一轮回复完成 — 进入事件中心提示,不代表子进程退出 */
  onSessionTurnFinished: (cb: (m: SessionTurnFinished) => void): Promise<UnlistenFn> =>
    listen<SessionTurnFinished>('session-turn-finished', (e) => cb(e.payload)),
  /** session 真实状态(starting/idle/busy/exited)*/
  onSessionStatus: (cb: (m: SessionStatusEvent) => void): Promise<UnlistenFn> =>
    listen<SessionStatusEvent>('session-status', (e) => cb(e.payload)),
  onSessionFocusRequested: (cb: (m: SessionFocusRequestedEvent) => void): Promise<UnlistenFn> =>
    listen<SessionFocusRequestedEvent>('session-focus-requested', (e) => cb(e.payload)),

  // 持久化 + 主窗口聚焦
  getPersistedTabs: () => invoke<PersistedTab[]>('get_persisted_tabs'),
  saveTabs: (tabs: PersistedTab[]) => invoke<void>('save_tabs', { tabs }),
  focusMainWindow: () => invoke<void>('focus_main_window'),
  captureWindowScreenshot: (windowLabel: string) =>
    invoke<ScreenshotDraft>('capture_window_screenshot', { windowLabel }),
  captureInteractiveScreenshot: () =>
    invoke<ScreenshotDraft>('capture_interactive_screenshot'),
  copyScreenshotCrop: (pngBase64: string, crop: ScreenshotCrop) =>
    invoke<void>('copy_screenshot_crop', { pngBase64, ...crop }),
  openSpecOpsWindow: (session: SpecOpsSession, theme: ThemeMode, locale: LocaleMode) =>
    invoke<void>('open_specops_window', { session, theme, locale }),
  specopsOpen: (workspace: string) => invoke<SpecOpsSession>('specops_open', { workspace }),
  specopsInitGitWorkspace: (workspace: string) => invoke<void>('specops_init_git_workspace', { workspace }),
  specopsClose: (workspace: string) => invoke<void>('specops_close', { workspace }),

  // Phase 9.1.2-final 配对(Flutter App 扫 QR 拿到 host+port+token)
  getPairingPayload: () => invoke<PairingPayload>('get_pairing_payload'),
  cloudSyncStatus: () => invoke<CloudSyncStatus>('cloud_sync_status'),
  cloudSyncCreatePairing: (serverUrl: string) =>
    invoke<CloudPairingPayload>('cloud_sync_create_pairing', { serverUrl }),
  cloudSyncActivateBackend: (backendId: string) =>
    invoke<CloudSyncStatus>('cloud_sync_activate_backend', { backendId }),
  cloudSyncDeploy: (req: CloudDeployReq) =>
    invoke<CloudDeployResult>('deploy_cloud_sync', { req }),

  // 路径配置(GUI 启动 banner / 命令面板用)
  getPathsConfig: () => invoke<PathsConfig>('get_paths_config'),
  setSessionCwd: (path: string) =>
    invoke<PathsConfig>('set_session_cwd', { path }),
  setConfigPath: (path: string) =>
    invoke<PathsConfig>('set_config_path', { path }),

  /// 拿 $HOME(给状态栏显示路径时做 ~ 缩写用)
  getHomeDir: () => invoke<string>('get_home_dir'),

  /// 读取本地工作目录的文件列表和 Git 摘要。仅用于 Local tab。
  /// showHidden 省略时后端默认 true(保留本地显示 dotfiles 的旧行为)。
  workspaceSnapshot: (cwd: string, showHidden?: boolean) =>
    invoke<WorkspaceSnapshot>('workspace_snapshot', { cwd, showHidden: showHidden ?? null }),
  workspaceListDir: (path: string, showHidden?: boolean) =>
    invoke<WorkspaceEntry[]>('workspace_list_dir', { path, showHidden: showHidden ?? null }),
  workspaceSearch: (cwd: string, query: string, showHidden?: boolean) =>
    invoke<WorkspaceEntry[]>('workspace_search', { cwd, query, showHidden: showHidden ?? null }),
  workspacePreviewFile: (path: string) =>
    invoke<FilePreview>('workspace_preview_file', { path }),
  workspaceGitDiff: (cwd: string, path: string, bucket: string) =>
    invoke<GitDiffPreview>('workspace_git_diff', { cwd, path, bucket }),
  workspaceGitCommitDiff: (cwd: string, commit: string) =>
    invoke<GitDiffPreview>('workspace_git_commit_diff', { cwd, commit }),
  workspaceGitCommitDetail: (cwd: string, commit: string) =>
    invoke<GitCommitDetail>('workspace_git_commit_detail', { cwd, commit }),
  workspaceGitCommitFileDiff: (cwd: string, commit: string, path: string) =>
    invoke<GitDiffPreview>('workspace_git_commit_file_diff', { cwd, commit, path }),

  // Theme(全局 UI 主题持久化)
  getTheme: () => invoke<string>('get_theme'),
  setTheme: (theme: ThemeMode) => invoke<void>('set_theme', { theme }),
  // Locale(全局 UI 语言持久化)
  getLocale: () => invoke<string>('get_locale'),
  setLocale: (locale: LocaleMode) => invoke<void>('set_locale', { locale }),

  /// 用系统默认程序打开路径或 URL(Cmd+Click 触发)。
  /// 绝对路径 / ~/... / http(s):// 白名单;失败时静默忽略。
  openPath: (path: string) => invoke<void>('open_path', { path }),

  /// 读系统剪贴板文本(Rust 侧,绕过 WKWebView 权限弹窗)。
  readClipboard: () => invoke<string>('read_clipboard'),

  /// 列出某个工作目录下指定 backend 的所有历史 session。
  /// 返回按 mtime 降序排列的 session 摘要列表。
  listSessionsForCwd: (backendKey: string, cwd: string) =>
    invoke<SessionSummary[]>('list_sessions_for_cwd', { backendKey, cwd }),
}

/// session 摘要(Rust `commands::SessionSummary` 镜像)。
export interface SessionSummary {
  session_id: string
  title: string | null
  model: string | null
  total_tokens: number | null
  last_modified_secs: number
}

export interface WorkspaceEntry {
  name: string
  path: string
  is_dir: boolean
  is_symlink: boolean
  size: number | null
  modified_secs: number | null
}

export interface WorkspaceGitChange {
  path: string
  status: string
  bucket: 'staged' | 'modified' | 'untracked' | 'conflict' | string
}

export interface GitBranchInfo {
  name: string
  display_name: string
  current: boolean
  remote: boolean
}

export interface GitCommitInfo {
  hash: string
  short_hash: string
  author: string
  timestamp_secs: number
  subject: string
  parents?: string[]
  decorations?: string[]
}

export interface GitCommitFileChange {
  path: string
  status: string
}

export interface GitCommitDetail {
  commit: string
  message: string
  files: GitCommitFileChange[]
}

export interface WorkspaceGitSummary {
  is_repo: boolean
  root: string | null
  branch: string | null
  short_head: string | null
  staged: number
  modified: number
  untracked: number
  conflicts: number
  ahead: number
  behind: number
  changes: WorkspaceGitChange[]
  branches?: GitBranchInfo[]
  commits?: GitCommitInfo[]
}

export interface WorkspaceSnapshot {
  path: string
  exists: boolean
  entries: WorkspaceEntry[]
  git: WorkspaceGitSummary
}

export interface FilePreview {
  path: string
  name: string
  kind: 'text' | 'binary' | 'image' | string
  content: string
  size: number
  truncated: boolean
  mime: string
}

export interface GitDiffPreview {
  path: string
  bucket: string
  content: string
  truncated: boolean
}

// =============== 2026-06 backend 管理 ===============

/// 自动探测命中的 backend(后端 `backend_admin::DetectedBackend` 镜像)。
/// 前端用来弹「检测到 X,要加吗?」对话框。
export interface DetectedBackend {
  suggested_key: string
  command_path: string
  command: string
  /** "codebuddy" | "claude" | "json-merge" */
  suggested_setup_style: string
  suggested_setup_cli: string
  suggested_json_path: string | null
  /** 当前 config 已经存在同 key,前端用来禁用「添加」按钮 */
  already_in_config: boolean
}

/// 保存 backend 用的扁平表单结构(后端 `backend_admin::BackendSaveRequest` 镜像)。
export interface BackendSaveRequest {
  key: string
  command: string
  args: string[]
  default_model: string | null
  model_flag: string | null
  permission_mode_flag: string | null
  /** "" | "none" | "codebuddy" | "claude" | "json-merge" */
  setup_style: string | null
  setup_cli: string | null
  setup_json_path: string | null
  /** null = 保留「待探测」语义不写盘;true/false = 显式开关 */
  enabled: boolean | null
}

export const backendAdminIpc = {
  /** 扫 PATH 上的内置已知 candidate(codebuddy / claude / claude-internal / codex) */
  detect: () => invoke<DetectedBackend[]>('detect_known_backends'),
  /** 创建或更新 backend。保存后新 tab 选择列表立即刷新。 */
  save: (request: BackendSaveRequest) => invoke<void>('backend_save', { request }),
  /** 删除 backend(table 不存在不报错) */
  delete: (key: string) => invoke<void>('backend_delete', { key }),
  /** 设置单个 backend 的 enabled 开关(surgical RMW,保留注释)。开关立即生效。 */
  setEnabled: (key: string, enabled: boolean) =>
    invoke<void>('backend_set_enabled', { key, enabled }),
  /** 后端写盘并刷新运行时 backend snapshot 后 emit。 */
  onChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen<unknown>('backends-changed', () => cb()),
}

// =============== Phase 11.4 远端 endpoint 配置 ===============

/// 后端 `endpoints::EndpointSummary` 镜像。
export interface EndpointSummary {
  id: string
  display_name: string
  base_url: string
  /** 是否已激活(transports map 里有对应 RemoteTransport) */
  connected: boolean
  /** SSH 隧道模式:user@host 或 ~/.ssh/config 别名。空 = 直连。 */
  ssh_host: string
  /** SSH 服务端口(0 / 22 = 默认) */
  ssh_port: number
  /** 远端 server 端口(默认 9870) */
  ssh_remote_port: number
}

/// 后端 `endpoints::RemoteBackendInfo` 镜像 — server 端某个 backend 的概要。
export interface RemoteBackendInfo {
  key: string
  display_name: string
  supports_cwd: boolean
  default_cwd: string | null
  model_flag?: string | null
  /// 远端 server 报告的 enabled 状态。**旧 server 不返回该字段** →
  /// 前端语义「缺失视为开启」,因此读时用 `b.enabled !== false`。
  enabled?: boolean
}

/// 后端 `endpoints::EndpointTestResult` 镜像。
export interface EndpointTestResult {
  ok: boolean
  server_version: string
  backends: RemoteBackendInfo[]
  detail: string
}

/// 后端 `endpoints::RemoteFsListing` 镜像 — 远端目录浏览结果。
export interface RemoteFsEntry {
  name: string
  is_dir: boolean
}
export interface RemoteFsListing {
  path: string
  parent: string | null
  entries: RemoteFsEntry[]
}

export const endpointIpc = {
  /** 列出所有持久化的 endpoint(含每个的 connected 状态) */
  list: () => invoke<EndpointSummary[]>('endpoint_list'),
  /** 添加(内部会先 test → 持久化 → 注册 transport;失败抛 string)。
   *  SSH 模式:传 ssh_host(user@host)+ ssh_port(SSH 服务端口,0=22)+ ssh_remote_port(kode-server 端口,默认 9870)。 */
  add: (
    id: string,
    display_name: string,
    base_url: string,
    token: string,
    ssh_host: string = '',
    ssh_port: number = 0,
    ssh_remote_port: number = 0,
  ) =>
    invoke<EndpointSummary>('endpoint_add', {
      req: { id, display_name, base_url, token, ssh_host, ssh_port, ssh_remote_port },
    }),
  /** 删除 + 停 WS */
  remove: (id: string) => invoke<void>('endpoint_remove', { id }),
  /** 修改 endpoint 的 UI 显示名 */
  updateDisplayName: (id: string, display_name: string) =>
    invoke<void>('endpoint_update_display_name', { id, displayName: display_name }),
  /** 不写盘只测连接 — Dialog 上的「Test」按钮。SSH 模式会先起临时隧道。 */
  testConnection: (
    base_url: string,
    token: string,
    ssh_host: string = '',
    ssh_port: number = 0,
    ssh_remote_port: number = 0,
  ) =>
    invoke<EndpointTestResult>('endpoint_test_connection', {
      baseUrl: base_url,
      token,
      sshHost: ssh_host || null,
      sshPort: ssh_port || null,
      sshRemotePort: ssh_remote_port || null,
    }),
  /** Phase 11.5:拉某 endpoint 的远端 backend 列表(BackendChooser 用) */
  getRemoteBackends: (id: string) =>
    invoke<RemoteBackendInfo[]>('endpoint_get_remote_backends', { id }),
  discoverBackendModels: (id: string, backendKey: string) =>
    invoke<ModelDiscoveryResult>('endpoint_discover_backend_models', { id, backendKey }),
  /** Phase 11.5.4:列举远端某目录的子目录(RemoteCwdPicker 用) */
  fsList: (id: string, path: string, show_hidden: boolean = false) =>
    invoke<RemoteFsListing>('endpoint_fs_list', {
      id,
      path,
      showHidden: show_hidden,
    }),
  /** 拉远端 endpoint 上某 cwd/backend 的历史 session 列表 */
  listSessionsForCwd: (id: string, backendKey: string, cwd: string) =>
    invoke<SessionSummary[]>('endpoint_list_sessions_for_cwd', {
      id,
      backendKey,
      cwd,
    }),
  /** 远端 tab WorkspacePanel:列文件 + git 摘要(对齐 ipc.workspaceSnapshot)。
   *  showHidden 省略时后端默认 false(保留远端隐藏 dotfiles 的旧行为)。 */
  workspaceSnapshot: (id: string, cwd: string, showHidden?: boolean) =>
    invoke<WorkspaceSnapshot>('endpoint_workspace_snapshot', { id, cwd, showHidden: showHidden ?? null }),
  /** 远端 tab:展开目录(对齐 ipc.workspaceListDir) */
  workspaceListDir: (id: string, path: string, showHidden?: boolean) =>
    invoke<WorkspaceEntry[]>('endpoint_workspace_list_dir', { id, path, showHidden: showHidden ?? null }),
  /** 远端 tab:预览文件(对齐 ipc.workspacePreviewFile) */
  workspacePreviewFile: (id: string, path: string) =>
    invoke<FilePreview>('endpoint_workspace_preview_file', { id, path }),
  /** 远端 tab:git diff(对齐 ipc.workspaceGitDiff) */
  workspaceGitDiff: (id: string, cwd: string, path: string, bucket: string) =>
    invoke<GitDiffPreview>('endpoint_workspace_git_diff', { id, cwd, path, bucket }),
  /** 远端 tab:commit diff(对齐 ipc.workspaceGitCommitDiff) */
  workspaceGitCommitDiff: (id: string, cwd: string, commit: string) =>
    invoke<GitDiffPreview>('endpoint_workspace_git_commit_diff', { id, cwd, commit }),
  /** 远端 tab:commit detail(对齐 ipc.workspaceGitCommitDetail) */
  workspaceGitCommitDetail: (id: string, cwd: string, commit: string) =>
    invoke<GitCommitDetail>('endpoint_workspace_git_commit_detail', { id, cwd, commit }),
  /** 远端 tab:commit file diff(对齐 ipc.workspaceGitCommitFileDiff) */
  workspaceGitCommitFileDiff: (id: string, cwd: string, commit: string, path: string) =>
    invoke<GitDiffPreview>('endpoint_workspace_git_commit_file_diff', { id, cwd, commit, path }),
}

// ── 远端 Bridge 部署 ──────────────────────────────────────────────────────

/// 后端 `deploy::DeployReq` 镜像。
export interface DeployReq {
  ssh_host: string
  display_name?: string
  ssh_port: number
  remote_port: number
}

/// 后端 `deploy::DeployResult` 镜像。
export interface DeployResult {
  endpoint_id: string
  bridge_token: string
  endpoint_created: boolean
}

/// 后端 `deploy::DeployProgress` 镜像 —— 通过 `deploy-progress` event 推送。
export interface DeployProgress {
  step: string
  status: 'running' | 'done' | 'failed'
  message: string
}

export const deployIpc = {
  /** 触发部署(分步进度通过 `deploy-progress` event 推送,需配合 `listen` 订阅) */
  deploy: (req: DeployReq) => invoke<DeployResult>('deploy_remote_bridge', { req }),
}

export interface PathsConfig {
  /// 当前生效的 session cwd(给新 tab 用)
  session_cwd: string
  /// true = 用户显式设置;false = 默认回退
  session_cwd_overridden: boolean
  /// 当前 config.toml 路径
  config_path: string
  /// true = 用户显式设置;false = dirs::config_dir 默认
  config_path_overridden: boolean
  /// config.toml 是否实际存在
  config_exists: boolean
}

// ── cwd 历史(top 5,区分本地/远端) ────────────────────────────────────────
//
// bucket 约定:
//   'local' = 本地 tab 的 cwd 历史
//   其它字符串 = 远端 endpoint_id 的 cwd 历史
export const cwdHistoryIpc = {
  /** 读取某 bucket 的 cwd 历史(最多 5 条,最新在前) */
  get: (bucket: string) => invoke<string[]>('cwd_history_get', { bucket }),
  /** 把一个 cwd 推进某 bucket(去重、top5、立即落盘)。空串会被忽略。 */
  push: (bucket: string, cwd: string) =>
    invoke<void>('cwd_history_push', { bucket, cwd }),
}

// ============== Shell PTY (terminal panel) ==============

export type ShellId = number

export const shellIpc = {
  /** Spawn a shell PTY ($SHELL). Returns the shell ID. */
  spawn: (cwd: string, cols: number, rows: number, endpoint_id?: EndpointId | null, term_theme?: 'light' | 'dark' | null) =>
    invoke<ShellId>('spawn_shell', { cwd, cols, rows, endpointId: endpoint_id ?? null, termTheme: term_theme ?? null }),

  /** Write bytes to the shell PTY stdin. */
  write: (id: ShellId, bytes: Uint8Array, endpoint_id?: EndpointId | null) =>
    invoke<void>('write_shell', { id, bytes: Array.from(bytes), endpointId: endpoint_id ?? null }),

  /** Resize the shell PTY. */
  resize: (id: ShellId, cols: number, rows: number, endpoint_id?: EndpointId | null) =>
    invoke<void>('resize_shell', { id, cols, rows, endpointId: endpoint_id ?? null }),

  /** Kill the shell PTY and remove it from the manager. */
  kill: (id: ShellId, endpoint_id?: EndpointId | null) =>
    invoke<void>('kill_shell', { id, endpointId: endpoint_id ?? null }),

  /**
   * Subscribe to shell PTY byte stream. On subscribe, the ring buffer
   * (~50KB) is replayed first, then live bytes stream in.
   * Returns an unsubscribe function.
   */
  subscribeBytes: async (
    id: ShellId,
    endpoint_id: EndpointId | null | undefined,
    onBytes: (data: Uint8Array) => void,
  ): Promise<() => Promise<void>> => {
    const ch = new Channel<number[]>()
    ch.onmessage = (data) => onBytes(new Uint8Array(data))
    await invoke<void>('subscribe_shell_bytes', { id, endpointId: endpoint_id ?? null, onBytes: ch })
    return () => invoke<void>('unsubscribe_shell_bytes', { id, endpointId: endpoint_id ?? null })
  },
}

export interface PairingPayload {
  host: string
  port: number
  token: string
  /** kode://pair?host=…&port=…&token=… —— Flutter 扫码后直接解析 */
  uri: string
  /** true = bridge 被 KODE_BRIDGE_DISABLE 关掉,无法配对 */
  bridge_disabled: boolean
}

export interface CloudSyncStatus {
  server_url: string
  device_id: string | null
  active_backend_id: string | null
  backends: CloudBackendSummary[]
  state: 'not_configured' | 'connecting' | 'waiting_for_pairing' | 'syncing' | 'offline' | string
  connected: boolean
  sync_enabled: boolean
  binding_count: number
  last_error: string | null
}

export interface CloudBackendSummary {
  id: string
  name: string
  server_url: string
  ssh_host: string | null
  ssh_port: number | null
  remote_port: number | null
  deployment_kind: 'standalone' | 'docker' | null
  remote_deploy_dir: string | null
  managed: boolean
  active: boolean
}

export interface CloudDeployReq {
  name: string
  ssh_host: string
  ssh_port: number
  remote_port: number
  server_url: string
  deployment_kind: 'standalone' | 'docker'
  remote_deploy_dir: string | null
}

export interface CloudDeployResult {
  backend: CloudBackendSummary
}

export interface CloudDeployProgress {
  step: string
  status: 'running' | 'done' | 'failed'
  message: string
}

export interface CloudPairingPayload {
  pairing_id: string
  /** One-time secret. Kept inside the QR/URI and never displayed in clear text. */
  secret: string
  uri: string
  expires_at: number
}

// ============== M4 memory review queue ==============

/// 来源标注 —— 前端聚合本地 + 多远端 pending / hit 时给每条打来源。
/// 'local' = 本地 vault;{ remote, endpointId } = 某个已配置远端。
export type MemoryOrigin = { kind: 'local' } | { kind: 'remote'; endpointId: string }

/// 一条待审 propose(kode-memory pending/<id>.md)。
export interface MemoryPending {
  id: string
  author: string
  session: string | null
  scope: string
  created: string
  confidence: number
  tags: string[]
  kind: string
  subsystem: string | null
  supersedes: string | null
  related: string[]
  contradicts: string[]
  body: string
  rationale: string | null
  /** 当前 author 剩余能量(approve/reject 后会变;UI 给出"agent 还剩 X 点"提示) */
  author_energy: number
  /** 前端聚合时打上的来源标注(后端不返回此字段) */
  origin?: MemoryOrigin
}

export interface MemoryStats {
  pending: number
  facts: number
  root: string
}

export interface MemoryReviewResult {
  outcome: 'approved' | 'rejected' | 'blacklisted'
  author_energy: number
  remaining_pending: number
}

export interface RemoteMemoryPendingEvent {
  endpoint_id: string
  count: number
}

/// 用户给出的判决。所有字段 snake_case 与后端 `VerdictDto` 对齐。
export type MemoryVerdict =
  | { kind: 'approve' }
  | {
      kind: 'edit_then_approve'
      body?: string
      tags?: string[]
      scope?: string
      confidence?: number
      /** Phase 10.10:edit-then-approve 时收集的 related ULID */
      related?: string[]
      /** Phase 10.10:contradicts ULID */
      contradicts?: string[]
    }
  | { kind: 'reject'; reason: string }
  | { kind: 'blacklist'; reason: string }

/** Phase 10.9-13 后端 DTO */
export interface MemoryFactFull {
  id: string
  author: string
  scope: string
  kind: string
  subsystem: string | null
  created: string
  confidence: number
  tags: string[]
  deprecated: boolean
  body: string
  supersedes: string | null
  related: string[]
  contradicts: string[]
  applies_to: string[]
  tried: string | null
  failed_because: string | null
  use_instead: string | null
}

export interface MemoryBacklink {
  id: string
  kind: string  // "supersedes" | "related" | "contradicts"
  snippet: string
}

export interface MemoryFactWithBacklinks {
  fact: MemoryFactFull
  backlinks: MemoryBacklink[]
}

export interface MemorySearchHit {
  id: string
  author: string
  scope: string
  kind: string
  subsystem: string | null
  created: string
  confidence: number
  tags: string[]
  title: string | null
  snippet: string
  body: string
  score: number
  /** 前端聚合时打上的来源标注(后端不返回此字段) */
  origin?: MemoryOrigin
}

export interface MemorySearchArgs {
  query: string
  scope?: string
  kinds?: string[]
  subsystem?: string
  include_deprecated?: boolean
  top_k?: number
  current_path?: string
}

export interface MemoryEnergyEntry {
  author: string
  energy: number
  max: number
}

export interface MemoryAuthorAccept {
  author: string
  accepts: number
  total_reviews: number
  rate: number | null
}

export interface MemoryMetricsSummary {
  today_proposes: number
  accept_rate_7d: number | null
  total_reviews_7d: number
  by_author: MemoryAuthorAccept[]
  energy_by_author: MemoryEnergyEntry[]
}

/// 把 bridge /search · /recent 返回的原始 hit(kode_memory::SearchHit 形态,
/// 无 body 字段、score 可能缺失)归一化为前端 MemorySearchHit。
function normalizeRemoteHit(raw: Record<string, unknown>): MemorySearchHit {
  const snippet = typeof raw.snippet === 'string' ? raw.snippet : ''
  return {
    id: String(raw.id ?? ''),
    author: typeof raw.author === 'string' ? raw.author : '',
    scope: typeof raw.scope === 'string' ? raw.scope : '',
    kind: typeof raw.kind === 'string' && raw.kind ? (raw.kind as string) : 'gotcha',
    subsystem: typeof raw.subsystem === 'string' ? raw.subsystem : null,
    created: typeof raw.created === 'string' ? raw.created : '',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 1,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    title: typeof raw.title === 'string' ? raw.title : null,
    snippet,
    // 远端 hit 没有完整 body,退化到 snippet(spec: Browse 远端 detail 用 search hit 字段)
    body: typeof raw.body === 'string' && raw.body ? (raw.body as string) : snippet,
    score: typeof raw.score === 'number' ? raw.score : 0,
  }
}

export const memoryIpc = {
  listPending: () => invoke<MemoryPending[]>('memory_list_pending'),
  listPendingRemote: (endpointId: string) =>
    invoke<MemoryPending[]>('memory_list_pending_remote', { endpointId }),
  /** 远端搜索。bridge 返回的 hit 缺 body 字段(只有 snippet),这里归一化补上,
   *  让远端 hit 满足 MemorySearchHit 类型(body 退化到 snippet)。 */
  searchRemote: (endpointId: string, query: string, scope?: string, top_k?: number) =>
    invoke<Record<string, unknown>[]>('memory_search_remote', {
      endpointId,
      query,
      scope: scope ?? null,
      topK: top_k ?? null,
    }).then((raw) => raw.map(normalizeRemoteHit)),
  /** 远端「最近 fact」列表(空 query 默认视图) */
  listRecentRemote: (endpointId: string, scope?: string, limit?: number) =>
    invoke<Record<string, unknown>[]>('memory_list_recent_remote', {
      endpointId,
      scope: scope ?? null,
      limit: limit ?? null,
    }).then((raw) => raw.map(normalizeRemoteHit)),
  stats: () => invoke<MemoryStats>('memory_stats'),
  review: (id: string, verdict: MemoryVerdict) =>
    invoke<MemoryReviewResult>('memory_review', { id, verdict }),
  reviewRemote: (endpointId: string, id: string, verdict: MemoryVerdict) =>
    invoke<MemoryReviewResult>('memory_review_remote', { endpointId, id, verdict }),
  readFact: (id: string) => invoke<MemoryFactFull>('memory_read_fact', { id }),
  /** 用户从 GUI 直接录一条(走 propose 路径) */
  propose: (args: {
    author?: string
    scope: string
    body: string
    tags?: string[]
    rationale?: string
    confidence?: number
    kind?: string
  }) => invoke<string>('memory_propose', { args }),
  /** pending 数变化事件(状态栏 badge / 面板自动刷新) */
  onPendingCount: (cb: (n: number) => void): Promise<UnlistenFn> =>
    listen<number>('memory-pending', (e) => cb(e.payload)),
  /** 远端 endpoint 的 pending 数变化事件 */
  onRemotePendingCount: (cb: (m: RemoteMemoryPendingEvent) => void): Promise<UnlistenFn> =>
    listen<RemoteMemoryPendingEvent>('memory-pending-remote', (e) => cb(e.payload)),

  // ── Phase 10.9-13 ──────────────────────────────────────────────
  search: (args: MemorySearchArgs) =>
    invoke<MemorySearchHit[]>('memory_search', { args }),
  /** 空 query 时的兜底列表(Browse 面板默认视图)。按 created 倒序,默认 30 天 / 20 条 */
  listRecent: (opts?: { scope?: string; since_hours?: number; limit?: number }) => {
    const args: Record<string, unknown> = {}
    if (opts?.scope) args.scope = opts.scope
    if (opts?.since_hours != null) args.sinceHours = opts.since_hours
    if (opts?.limit != null) args.limit = opts.limit
    return invoke<MemorySearchHit[]>('memory_list_recent', args)
  },
  /** Browse 面板「按项目过滤」下拉:列出所有 distinct scope(字典序) */
  listScopes: () => invoke<string[]>('memory_list_scopes'),
  readWithBacklinks: (id: string) =>
    invoke<MemoryFactWithBacklinks>('memory_read_with_backlinks', { id }),
  deprecate: (id: string, reason: string) =>
    invoke<void>('memory_deprecate', { id, reason }),
  updateScope: (id: string, scope: string) =>
    invoke<void>('memory_update_scope', { id, scope }),
  bumpRecall: (id: string, query?: string) =>
    invoke<void>('memory_bump_recall', { id, query }),
  metricsSummary: () => invoke<MemoryMetricsSummary>('memory_metrics_summary'),

  /** Browse 面板 filter 持久化(state.json) */
  browseStateGet: () =>
    invoke<{
      last_scope: string | null
      last_kinds: string[]
      include_deprecated: boolean
    } | null>('memory_browse_state_get'),
  browseStateSet: (next: {
    last_scope: string | null
    last_kinds: string[]
    include_deprecated: boolean
  }) => invoke<void>('memory_browse_state_set', { next }),
}

// ============== M4.1:codebuddy MCP setup ==============

export interface MemoryMcpCheckResult {
  binary_available: boolean
  binary_path: string | null
  codebuddy_available: boolean
  configured_for_codebuddy: boolean
  claude_internal_available: boolean
  configured_for_claude_internal: boolean
  dismissed_at: number | null
  memory_root: string
  /** kode 管理的 Stop hook 是否已注入到 codebuddy settings.json */
  hook_configured_codebuddy?: boolean
  /** kode 管理的 Stop hook 是否已注入到 claude settings.json */
  hook_configured_claude?: boolean
  /**
   * 2026-06 数据驱动 backend 状态映射:`backend_key -> BackendMcpStatus`。
   * 包含所有声明了 mcp_setup 的 backend(老 backend_admin 字段对应同一份数据)。
   */
  backends: Record<string, BackendMcpStatus>
}

/** 单 backend 的 memory MCP 接入状态(后端 `BackendStatus` 镜像) */
export interface BackendMcpStatus {
  /** backend.command 在 PATH 上 */
  command_available: boolean
  /** mcp_setup.cli 在 PATH 上;json-merge 风格无 cli,这里是 null */
  setup_cli_available: boolean | null
  /** memory 是否已注册到该 backend 的 mcp 配置 */
  configured: boolean
  /** mcp_setup 风格 ("codebuddy" / "claude" / "json-merge") */
  setup_style: string
}

/** 单 backend 自动 setup 结果(后端 `AutoSetupOutcome` 镜像) */
export interface MemoryMcpAutoSetupOutcome {
  /** `"codebuddy"` / `"claude-internal"` */
  backend: string
  success: boolean
  /** 失败原因(stdout/stderr 拼接);成功时为 null */
  error: string | null
}

/** 启动自动 setup 报告(后端 `AutoSetupReport` 镜像) */
export interface MemoryMcpAutoSetupReport {
  check: MemoryMcpCheckResult
  attempts: MemoryMcpAutoSetupOutcome[]
}

export const memoryMcpIpc = {
  /** 拉一次状态。banner mount 时调,后端事件触发时也调。 */
  check: () => invoke<MemoryMcpCheckResult>('memory_mcp_check'),
  /** 一键写 ~/.codebuddy.json 的 mcpServers.memory */
  setupCodebuddy: () => invoke<void>('memory_mcp_setup_codebuddy'),
  /** 一键写 ~/.claude-internal/.claude.json 的 mcpServers.memory */
  setupClaudeInternal: () => invoke<void>('memory_mcp_setup_claude_internal'),
  /** 用户点"暂不提示" — 写 state.json 的 mcp_prompt_dismissed_at */
  dismiss: () => invoke<void>('memory_mcp_dismiss_prompt'),
  /** 启动后 800ms / 配置变更后由后端推送的"该刷新 banner 了"事件 */
  onSetupRequired: (cb: (r: MemoryMcpCheckResult) => void): Promise<UnlistenFn> =>
    listen<MemoryMcpCheckResult>('memory-mcp-setup-required', (e) => cb(e.payload)),
  /** 配置成功后由后端推送 — banner 据此重新拉状态自然消失 */
  onChanged: (cb: () => void): Promise<UnlistenFn> =>
    listen<unknown>('memory-mcp-changed', () => cb()),
  /**
   * 启动时自动 setup 完成后由后端推送(全成功 / 部分失败都会发)。
   * 用于让 banner 弹一条「已自动接入」的成功提示,或在失败时把错因展开。
   * payload 是 `AutoSetupReport`:`check`(setup 跑完后重探测的状态)+ `attempts`(每个 backend 的成功/失败/错因)。
   */
  onAutoConfigured: (cb: (r: MemoryMcpAutoSetupReport) => void): Promise<UnlistenFn> =>
    listen<MemoryMcpAutoSetupReport>('memory-mcp-auto-configured', (e) => cb(e.payload)),

  /// ---- M4.2:kode-memory prompt 注入开关 ----
  /** 拉当前注入开关 + 完整 prompt 预览 */
  promptStatus: () =>
    invoke<{ enabled: boolean; preview: string; preview_bytes: number }>(
      'memory_prompt_status'
    ),
  /** 切 enabled — 只影响**下次** spawn 的 tab,现存 tab 不变 */
  promptSetEnabled: (enabled: boolean) =>
    invoke<void>('memory_prompt_set_enabled', { enabled }),
}

// ============================================================
// Git sync config
// ============================================================

export interface SyncConfig {
  configured: boolean
  initialized: boolean
  remote: string | null
  auto_sync: boolean
  auto_push: boolean
  branch: string
}

export interface SyncReport {
  pulled: boolean
  pushed: boolean
  reconciled: number
  initialized: boolean
  skipped_reason?: string | null
}

export const syncIpc = {
  getConfig: () => invoke<SyncConfig>('memory_sync_config'),
  setConfig: (cfg: { remote?: string; auto_push?: boolean; auto_sync?: boolean }) =>
    invoke<void>('memory_sync_config_set', {
      args: {
        remote: cfg.remote ?? null,
        auto_push: cfg.auto_push ?? null,
        auto_sync: cfg.auto_sync ?? null,
      },
    }),
  syncNow: (remote?: string | null) =>
    invoke<SyncReport>('memory_sync_now', {
      args: {
        remote: remote ?? null,
      },
    }),
}
export type ScreenshotDraft = { pngBase64: string; width: number; height: number }
export type ScreenshotCrop = { x: number; y: number; width: number; height: number }
