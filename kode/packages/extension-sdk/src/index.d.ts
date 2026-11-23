export class KodeApiError extends Error {
  status: number
}

export interface ExtensionEvent {
  seq: number
  session_id: number
  kind:
    | 'session.created'
    | 'session.input_result'
    | 'session.turn_started'
    | 'session.turn_completed'
    | 'session.awaiting'
    | 'session.awaiting_cleared'
    | 'session.exited'
    | (string & {})
  payload: Record<string, unknown>
  ts: number
}

export interface SessionOwnership {
  owner: string
  labels: string[]
  meta: unknown
  parent: number | null
}

export interface Session {
  id: number
  title?: string
  backend_key?: string
  status?: string
  cwd?: string
  ext: SessionOwnership | null
  [key: string]: unknown
}

export interface Bot {
  id: string
  name: string
  avatar: string | null
  backend_key: string
  model: string | null
  permission_ceiling: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions'
  memory_scope: string
  default: boolean
}

export interface CreateSessionOptions {
  /** Run as a bot (`'default'` = the user's assistant). Needs `bots.read`. */
  bot?: string
  backendKey?: string
  cwd?: string
  model?: string
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  initialInput?: string
  labels?: string[]
  meta?: unknown
  parent?: number
  idempotencyKey?: string
}

export class KodeExtension {
  constructor(options?: { api?: string; token?: string; fetch?: typeof fetch })
  hello(): Promise<{ api_version: number; extension_id: string; capabilities: string[]; features: string[]; node_id: string; event_cursor: number; runtimes: { gui: boolean } }>
  listSessions(options?: { owner?: 'self' | 'any'; label?: string }): Promise<Session[]>
  getSession(id: number): Promise<Session>
  listBots(): Promise<{ bots: Bot[]; default_bot: string | null }>
  createSession(options: CreateSessionOptions): Promise<{ session: Session; initial_input: 'pending' | null }>
  sendInput(id: number, text: string, options?: { idempotencyKey?: string }): Promise<{ accepted: true }>
  interrupt(id: number, options?: { idempotencyKey?: string }): Promise<{ accepted: true }>
  updateMeta(id: number, update: { labels?: string[]; meta?: unknown }): Promise<SessionOwnership>
  events(options?: { kinds?: string[]; owner?: 'self' | 'any'; session?: number; after?: number; signal?: AbortSignal }): AsyncGenerator<ExtensionEvent>
}

export function parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data: string }>
