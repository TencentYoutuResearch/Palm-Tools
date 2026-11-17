import { fetchPlanning } from './builder-planning.js'
import { resolveDefaultSelection } from '../../src/model-alias.js'

/**
 * Changing the Agent of a Builder planning Session is a native handoff to a successor planning
 * Session, never an in-place profile change. `prepare-handoff` is read-only; the owner confirms the
 * prepared command, which is stored with one request id before the single POST. Unconfirmed
 * outcomes keep that exact command for reconciliation; nothing is resent automatically and nothing
 * is sent to the model.
 */
export const handoffKey = (draft, sessionId) => JSON.stringify(['builder-planning-handoff', draft.home_hub, draft.id, sessionId])
export const handoffChoiceKey = (draft, sessionId) => JSON.stringify(['builder-planning-handoff-choice', draft.home_hub, draft.id, sessionId])
const HUB = '/api/kode/agent-hub'
/** The native Fast conversion, exactly as the server resolves a handoff selection: a model-variant
 * toggle moves between standardModelId and fastModelId; an effort the resolved model does not offer
 * falls back to its default. Null when the catalogue cannot resolve it. */
export function planningSelection(models, wanted) {
  for (const preference of [wanted, { model: wanted.model, ...(typeof wanted.fast === 'boolean' ? { fast: wanted.fast } : {}) }])
    try { return resolveDefaultSelection(models, preference) } catch {}
  return null
}
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const epoch = value => Number.isInteger(value) && value > 0
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
// Plain JSON equality with exactly the same keys (selections hold strings and booleans only).
const same = (a, b) => object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value)
const requested = choice => ({ model: choice.model, ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}), ...(typeof choice.fast === 'boolean' ? { fast: choice.fast } : {}) })

export function validHandoffScope(value, draft, sessionId) {
  return object(value) && value.home_hub === draft.home_hub && value.draft_id === draft.id && value.session_id === sessionId
    && epoch(value.context_epoch) && Number.isInteger(value.draft_revision) && typeof value.context_sha256 === 'string' && value.context_sha256.length > 0
    && ['active', 'handoff_pending', 'superseded'].includes(value.state)
    && (value.source_draft_revision === undefined && value.latest_context_sha256 === undefined
      || epoch(value.source_draft_revision) && value.source_draft_revision <= value.draft_revision && hex64(value.latest_context_sha256))
}
// A stored or server-kept handoff command for this source Session and draft.
const validCommand = (command, draft, sessionId) => object(command) && command.action === 'handoff' && command.sessionId === sessionId
  && token(command.requestId) && typeof command.profileId === 'string' && object(command.selection)
  && object(command.planning) && command.planning.draft_id === draft.id && epoch(command.planning.source_epoch)
const validRefresh = (planning, scope) => {
  const refresh = planning.refresh_context
  if (scope.source_draft_revision === undefined || scope.source_draft_revision === scope.draft_revision) return refresh === undefined
  return object(refresh) && Object.keys(refresh).length === 2 && refresh.source_draft_revision === scope.source_draft_revision
    && refresh.source_draft_revision < scope.draft_revision && hex64(refresh.target_context_sha256) && refresh.target_context_sha256 === scope.latest_context_sha256
}
const pendingRow = (row, draft, sessionId) => !!row && ['prepared', 'sent'].includes(row.state) && row.request_id === row.command?.requestId && validCommand(row.command, draft, sessionId)

/** GET metadata only: null when the Session is not a handoff-capable planning Session. */
export async function readHandoffScope({ draft, sessionId, request = fetchPlanning, signal }) {
  const value = await request(`${HUB}?session_id=${encodeURIComponent(sessionId)}`, { signal, timeout: 15000 })
  const scope = value?.planning_handoff
  if (scope === null || scope === undefined) return null
  if (!validHandoffScope(scope, draft, sessionId)) throw Object.assign(Error('Wrong handoff scope'), { code: 'handoff_scope_mismatch' })
  const retry = scope.pending?.retry_command
  return { ...scope, retry: validCommand(retry, draft, sessionId) && retry.requestId === scope.pending.request_id ? retry : null }
}

/** Read-only: the server's exact command for this source, target and selection. Nothing is stored. */
export async function prepareHandoff({ scope, choice, request = fetchPlanning, signal, refreshContext = false }) {
  const selection = requested(choice)
  const value = await request(HUB, { method: 'POST', body: { action: 'prepare-handoff', sessionId: scope.session_id, profileId: choice.profileId, selection, ...(refreshContext ? { refreshContext: true } : {}) }, signal })
  const prepared = value?.prepared, planning = prepared?.planning
  if (value?.kind !== 'planning' || value.automatic_input !== false || value.execution_authorized !== false || !object(prepared) || 'requestId' in prepared
    || prepared.action !== 'handoff' || prepared.sessionId !== scope.session_id || prepared.profileId !== choice.profileId || !object(prepared.selection)
    || Object.entries(selection).some(([key, value]) => prepared.selection[key] !== value)
    || !object(planning) || planning.draft_id !== scope.draft_id || planning.source_epoch !== scope.context_epoch || planning.draft_revision !== scope.draft_revision
    || planning.source_context_sha256 !== scope.context_sha256 || !hex64(planning.target_profile_revision) || !validRefresh(planning, scope) || planning.refresh_context && !refreshContext)
    throw Object.assign(Error('Prepared handoff mismatch'), { code: 'handoff_prepare_mismatch' })
  return structuredClone(prepared)
}

/** The successor receipt for exactly this command: same draft and source, the next epoch, nothing sent. */
export function validHandoffReceipt(receipt, command, draft) {
  return object(receipt) && receipt.version === 1 && receipt.mode === 'interactive_planning' && receipt.kind === 'planning' && receipt.state === 'ready'
    && receipt.home_hub === draft.home_hub && receipt.draft_id === draft.id && receipt.draft_id === command.planning.draft_id
    && typeof receipt.session_id === 'string' && receipt.session_id.length > 0 && receipt.session_id !== command.sessionId
    && receipt.context_epoch === command.planning.source_epoch + 1 && ['fresh', 'recovered'].includes(receipt.disposition)
    // The successor runs on the target profile's own route with exactly the reviewed selection.
    && same(receipt.initial_selection, { ...command.selection, provider: `kode-agent-${command.profileId}` })
    && receipt.source_session_id === command.sessionId && receipt.source_epoch === command.planning.source_epoch && receipt.request_id === command.requestId
    && receipt.automatic_input === false && receipt.execution_authorized === false
}

const storageFailed = reserved => Object.assign(Error('Handoff storage failed'), { code: 'handoff_storage_failed', reserved })

/** The stored unconfirmed command, null, or { unreadable } for a record that cannot be resent. */
export async function pendingHandoff(storage, draft, sessionId) {
  const row = await storage.read(handoffKey(draft, sessionId))
  if (!row || row.state === 'accepted') return null
  return pendingRow(row, draft, sessionId) ? row : { unreadable: true }
}

async function send({ storage, key, row, draft, request, signal }) {
  try { await storage.save(key, { ...row, state: 'sent' }) } catch { throw storageFailed(true) }
  const receipt = await request(HUB, { method: 'POST', body: row.command, signal })
  if (!validHandoffReceipt(receipt, row.command, draft)) throw Object.assign(Error('Invalid handoff receipt'), { code: 'handoff_receipt_mismatch' })
  // The server already confirmed it; a failed local mark only means the next check resends the same id.
  try { await storage.save(key, { ...row, state: 'accepted', session_id: receipt.session_id }) } catch {}
  return receipt
}

/** Owner-confirmed: store the prepared command with one request id, then post it once. */
export async function confirmHandoff({ storage, draft, prepared, uuid = () => crypto.randomUUID(), request = fetchPlanning, signal }) {
  const key = handoffKey(draft, prepared.sessionId), requestId = uuid()
  const row = { request_id: requestId, state: 'prepared', command: { ...structuredClone(prepared), requestId } }
  let stored
  try { stored = await storage.reserve(key, row, () => false) } catch { throw storageFailed(false) }
  if (stored?.request_id !== requestId) throw Object.assign(Error('Previous handoff unconfirmed'), { code: 'handoff_previous_unconfirmed' })
  return send({ storage, key, row: stored, draft, request, signal })
}

/** Reconcile: resend only the original command, from this device or the server's retry_command. */
export async function verifyHandoff({ storage, draft, sessionId, retry, request = fetchPlanning, signal }) {
  const key = handoffKey(draft, sessionId)
  let row
  try {
    row = await storage.read(key)
    if (!pendingRow(row, draft, sessionId) && validCommand(retry, draft, sessionId))
      row = await storage.reserve(key, { request_id: retry.requestId, state: 'prepared', command: structuredClone(retry) }, () => false)
  } catch { throw storageFailed(false) }
  if (!pendingRow(row, draft, sessionId)) throw Object.assign(Error('Nothing to verify'), { code: 'handoff_previous_unreadable' })
  return send({ storage, key, row, draft, request, signal })
}

export function handoffError(error, stage) {
  switch (error?.code) {
    case 'handoff_previous_unconfirmed': return '上次交接没有收到服务确认，原请求仍保留在本机，所以没有发送新的交接。请先核对原请求。'
    case 'handoff_previous_unreadable': return '本机记录的交接请求无法读取，也没有服务保留的原请求，所以没有发送任何请求。'
    case 'handoff_storage_failed': return error.reserved ? '本机已保存交接请求，但未能标记为已发送，所以还没有发送。可以核对原请求。' : '本机未能保存交接请求，没有发送请求，也没有建立继任会话。'
    case 'handoff_scope_changed': return '规划会话的上下文已变化（轮次、草案版本或上下文），确认已撤回，没有发送请求。请重新准备交接。'
    case 'handoff_prepare_mismatch': return '服务准备的交接与所选 Agent、模型或当前规划不符，没有保存或发送任何请求。'
    case 'handoff_scope_mismatch': return '服务返回的交接状态不属于当前规划会话，没有发送任何请求。'
    case 'handoff_receipt_mismatch': return '服务返回的结果与这次交接不符，没有打开任何会话；原请求仍保留在本机，可以核对。'
  }
  if (stage === 'read') return '无法读取交接状态，没有发送任何请求。'
  if (stage === 'prepare') return '无法准备交接，没有保存或发送任何请求。'
  return '交接没有收到服务确认，原请求已保存在本机。不会自动重试，也不会改用其他模型或新的请求号；可以核对原请求。'
}
