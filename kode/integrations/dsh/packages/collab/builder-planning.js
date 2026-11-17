/** Interactive planning reuses one real native Session per draft. The endpoint
 * creates or recovers that Session and never sends a prompt; it grants no team
 * execution. The browser never proposes a session_id. */
export const planningRequestKey = draft => JSON.stringify(['builder-planning', draft.home_hub, draft.id])
export const planningChoiceKey = (home, draftId) => JSON.stringify(['builder-planning-choice', home, draftId ?? ''])
export const planningTextKey = draft => JSON.stringify(['builder-prestart-text', draft.home_hub, draft.id])
export const planningGoalKey = draft => JSON.stringify(['builder-planning-goal-offered', draft.home_hub, draft.id])
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)

const validBinding = (value, draft) => !!value && value.version === 1 && value.mode === 'interactive_planning'
  && value.home_hub === draft.home_hub && value.draft_id === draft.id && Number.isInteger(value.context_epoch) && value.context_epoch > 0
  && typeof value.session_id === 'string' && value.session_id.length > 0 && value.execution_authorized === false

/** Exact ready receipt; anything else is not an openable planning Session. */
export function validPlanning(value, draft) {
  return validBinding(value, draft) && value.state === 'ready' && ['fresh', 'recovered'].includes(value.disposition)
}

/** Same-origin JSON call that keeps the server's safe error code for display. */
export async function fetchPlanning(path, { method = 'GET', body, signal, fetcher = globalThis.fetch, timeout = 20000 } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeout)
  try {
    const response = await fetcher(path, { method, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    if (!response.ok) {
      const detail = await response.json().catch(() => null)
      throw Object.assign(Error('Planning not confirmed'), { status: response.status, code: typeof detail?.code === 'string' ? detail.code : undefined })
    }
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

/**
 * GET is navigation metadata only:
 * { state: 'not_created' } | { state: 'ready', value } | { state: 'uncertain', value, retry? }.
 * A missing endpoint is reported, never treated as "not created".
 */
export async function readPlanning(draft, { signal, fetcher } = {}) {
  let value
  try { value = await fetchPlanning(`/api/kode/builder/planning?draft_id=${encodeURIComponent(draft.id)}`, { signal, fetcher, timeout: 15000 }) }
  catch (error) {
    if (error?.status === 404) throw Object.assign(Error('Planning bridge unavailable'), { code: 'planning_unavailable' })
    throw error
  }
  if (value?.state === 'not_created') {
    if (value.home_hub !== draft.home_hub || value.draft_id !== draft.id || value.execution_authorized !== false) throw Error('Wrong planning scope')
    return { state: 'not_created' }
  }
  if (value?.state === 'ready') {
    if (!validPlanning(value, draft)) throw Error('Invalid planning binding')
    return { state: 'ready', value }
  }
  if (value?.state === 'uncertain') {
    if (!validBinding(value, draft)) throw Error('Invalid planning binding')
    const retry = value.retry_request
    const usable = !!retry && typeof retry === 'object' && !Array.isArray(retry) && retry.draft_id === draft.id && token(retry.request_id)
    return { state: 'uncertain', value, ...(usable ? { retry } : {}) }
  }
  throw Error('Unknown planning state')
}

export const requestPlanning = (command, { signal, fetcher } = {}) => fetchPlanning('/api/kode/builder/planning', { method: 'POST', body: command, signal, fetcher })

// Only refusals the backend raises before any binding/creation step may free the local request id.
// Every other code, a bare 400/403 or an unknown status leaves the original pending: a later error
// (registry, identity, workspace or authorization changes) does not prove nothing was created earlier.
const REFUSED_BEFORE_CREATE = ['DRAFT_REVISION_CHANGED', 'NATIVE_AGENT_UNAVAILABLE', 'PLANNING_WORKSPACE_REQUIRED']
const definite = error => error?.status === 409 && REFUSED_BEFORE_CREATE.includes(error.code)

// An unconfirmed command, whatever revision it was built for. A newer draft revision says nothing
// about whether it created a Session, so it is never replaced on that basis.
const unconfirmed = (row, draft) => !!row && ['prepared', 'sent'].includes(row.state) && Number.isInteger(row.draft_revision)
  && !!row.command && row.command.draft_id === draft.id && row.command.request_id === row.request_id
const unresolved = (row, draft) => unconfirmed(row, draft) && row.draft_revision === draft.revision

/**
 * The exact unconfirmed start command, if any; while it exists the choice is frozen.
 * `draft_revision` may be older than the draft: then it must be verified before any new start.
 * A record that is neither confirmed, refused nor resendable is reported unreadable, never ignored.
 */
export async function pendingPlanning(storage, draft) {
  const row = await storage.read(planningRequestKey(draft))
  if (!row || ['accepted', 'failed'].includes(row.state)) return null
  return unconfirmed(row, draft) ? row : { unreadable: true }
}

/** Local persistence failed: nothing was sent. `reserved` says whether the exact command is stored for a later resend. */
const storageFailed = (error, reserved) => Object.assign(Error('Planning request was not stored'), { code: 'planning_storage_failed', reserved, cause: error })

/** Sends a stored command exactly as stored; only a definite refusal marks it failed. */
async function sendStored({ storage, key, pending, draft, request, signal }) {
  if (signal?.aborted) throw Error('Disposed')
  try { await storage.save(key, { ...pending, state: 'sent' }) }
  catch (error) { throw storageFailed(error, true) }
  let receipt
  try { receipt = await request(structuredClone(pending.command), { signal }) }
  catch (error) {
    if (definite(error)) await storage.save(key, { ...pending, state: 'failed' }).catch(() => {})
    throw error
  }
  // A mismatched receipt is not a refusal: the original command stays pending for reconciliation.
  if (!validPlanning(receipt, draft)) throw Object.assign(Error('Invalid planning receipt'), { code: 'planning_receipt_mismatch' })
  await storage.save(key, { ...pending, state: 'accepted', session_id: receipt.session_id })
  return receipt
}

/**
 * The complete command is reserved atomically before sending. Any outcome other than a
 * definite refusal leaves it pending, and the next attempt resends it byte-for-byte
 * whatever the pickers now show. Only a refused (failed) request may be replaced;
 * concurrent starts share one. An unconfirmed command of an older revision blocks a new
 * one without sending anything: it has to be verified first (verifyPlanning).
 */
export async function startPlanning({ storage, draft, choice, workspaceId, request = requestPlanning, signal, uuid = () => crypto.randomUUID() }) {
  const key = planningRequestKey(draft), request_id = uuid()
  const command = { draft_id: draft.id, draft_revision: draft.revision, request_id,
    ...(choice?.profileId ? { profile_id: choice.profileId } : {}), ...(choice?.model ? { model: choice.model } : {}),
    ...(choice?.reasoningEffort ? { reasoning_effort: choice.reasoningEffort } : {}), ...(workspaceId ? { workspace_id: workspaceId } : {}) }
  let pending
  try { pending = await storage.reserve(key, { request_id, draft_revision: draft.revision, state: 'prepared', command }, current => current.state === 'failed') }
  catch (error) { throw storageFailed(error, false) }
  if (unconfirmed(pending, draft) && pending.draft_revision !== draft.revision)
    throw Object.assign(Error('An earlier start is unconfirmed'), { code: 'planning_previous_unconfirmed', revision: pending.draft_revision })
  // Whatever won the slot is sent exactly as stored; a newly built command is never substituted for it.
  if (!unresolved(pending, draft)) throw Object.assign(Error('Stored planning request is not resendable'), { code: 'planning_previous_unreadable' })
  return sendStored({ storage, key, pending, draft, request, signal })
}

/**
 * Verify an unconfirmed start of any revision by resending that original command verbatim:
 * the server either returns the Session it created or definitely refuses it (then the slot is free).
 */
export async function verifyPlanning({ storage, draft, request = requestPlanning, signal }) {
  const key = planningRequestKey(draft)
  let pending
  try { pending = await storage.read(key) } catch (error) { throw storageFailed(error, false) }
  if (!unconfirmed(pending, draft)) throw Object.assign(Error('Stored planning request is not resendable'), { code: 'planning_previous_unreadable' })
  return sendStored({ storage, key, pending, draft, request, signal })
}

/** Uncertain creation: resend the server's own original request verbatim — same id, same model. */
export async function retryPlanning({ draft, retry, request = requestPlanning, signal }) {
  const receipt = await request(structuredClone(retry), { signal })
  if (!validPlanning(receipt, draft)) throw Error('Invalid planning receipt')
  return receipt
}

/**
 * Owner-confirmed completion of a partially initialized original Session: the server's own
 * retry_request, unchanged, plus complete_partial. It only finishes that Session (same id); it
 * never creates a replacement and sends nothing to the model. Local storage is not touched, so a
 * pending original command is neither rewritten with the flag nor marked failed on any outcome.
 */
export async function completePlanning({ draft, binding, retry, request = requestPlanning, signal }) {
  const receipt = await request({ ...structuredClone(retry), complete_partial: true }, { signal })
  if (!validPlanning(receipt, draft) || receipt.session_id !== binding.session_id)
    throw Object.assign(Error('Invalid planning receipt'), { code: 'planning_receipt_mismatch' })
  return receipt
}

/**
 * Reopening a known binding confirms it with the minimal request. No Agent/model
 * fields are sent, so the Session's current model is never overridden.
 */
export async function confirmPlanning({ draft, request = requestPlanning, signal, uuid = () => crypto.randomUUID() }) {
  const receipt = await request({ draft_id: draft.id, draft_revision: draft.revision, request_id: uuid() }, { signal })
  if (!validPlanning(receipt, draft)) throw Error('Invalid planning receipt')
  return receipt
}

/** Reading the binding failed. Nothing was started by reading, so this never claims an unconfirmed creation. */
export function planningReadError(error) {
  if (error?.code === 'planning_unavailable') return '规划会话服务尚未部署到当前 Kode 服务，暂时无法读取或开始规划。目标与补充内容已保留。'
  if (error?.status === 403) return '只有草案所有者可以查看规划会话状态。'
  return '暂时无法读取规划会话状态（网络或服务暂不可用）。目标与补充内容已保留；重新读取只查询状态，不会创建会话或发送内容。'
}

/**
 * Field diagnosis for a failed planning call: only a numeric HTTP status and an identifier-shaped
 * code are shown. Never the message, stack or response body.
 */
export function planningDiagnostic(error) {
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code) ? error.code : null
  if (status === null) return code ? `诊断：未收到完整的 HTTP 响应 · ${code}` : '诊断：未收到完整的 HTTP 响应'
  return `诊断：HTTP ${status}${code ? ` · ${code}` : ''}`
}

/** Shown verbatim; never implies a team, budget or tool grant was created. */
export function planningError(error) {
  // Local storage, not the network: no request was sent, so no session can have been created.
  if (error?.code === 'planning_previous_unconfirmed') return `上次开始规划（草案第 ${error.revision} 版）没有收到服务确认，原请求仍保留在本机。草案更新不代表它没有创建会话，所以没有按新版本开始，也没有发送任何请求。请先核对原请求。`
  if (error?.code === 'planning_previous_unreadable') return '无法读取上次开始请求，为避免重复创建暂不能开始，也没有发送任何请求。'
  if (error?.code === 'planning_storage_failed') return error.reserved
    ? '本机已保存开始请求，但未能标记为发送，所以还没有发送，也没有创建会话。目标与补充内容已保留；再次开始会发送同一请求。'
    : '本机未能保存开始请求（浏览器存储不可用或被其他页面占用），没有发送请求，也没有创建会话。目标与补充内容已保留，可检查浏览器存储权限或关闭旧页面后重试。'
  if (error?.code === 'planning_receipt_mismatch') return '服务返回的会话不属于此草案，所以没有打开。原请求仍保存在本机，可稍后重新查询状态。'
  if (error?.code === 'planning_unavailable') return '规划会话服务尚未部署到当前 Kode 服务。目标与补充内容已保留。'
  if (error?.status === 403) return '只有草案所有者可以开始规划对话。原请求仍保留在本机，没有据此判断它未创建会话，也不会改发新请求。'
  if (error?.status === 400) return '服务没有接受这次开始请求。原请求仍保留在本机，没有据此判断它未创建会话；重新查询状态或再次开始只会重发同一请求。'
  switch (error?.code) {
    case 'CONTROLLED_BUILDER_CONFLICT': return '此草案已有旧版受控搭建会话，不能自动切换到新的规划会话。旧记录在“团队设计设置 · 高级”中可查看。'
    case 'PLANNING_RECONCILIATION_REQUIRED': return '上次开始规划时没有收到确认。原请求已保留，没有重复创建会话；重新查询状态即可看到结果。'
    case 'PLANNING_CREATION_IN_PROGRESS': return '规划会话正在创建。稍后重新查询状态即可打开，不会再创建一次。'
    case 'PLANNING_ALREADY_BOUND': return '此草案已绑定规划会话；如需换模型，请在原会话里切换。'
    case 'PLANNING_WORKSPACE_REQUIRED': return '选择的工作区在当前 Kode 服务上不可用，没有创建会话。可在“更改规划位置”中改选，或改用私有规划目录。'
    case 'PLANNING_WORKSPACE_CHANGED': return '草案的工作区已变化，原规划会话不会被改绑。'
    case 'PLANNING_IDENTITY_CHANGED': return '无法核实原规划会话，没有打开或替换任何会话。'
    case 'NATIVE_AGENT_UNAVAILABLE': return '所选 Agent 在当前 Kode 服务上不可用，请在设置中选择已安装的 Agent。'
    case 'DRAFT_REVISION_CHANGED': return '草案已更新，请刷新后再开始。'
    case 'DRAFT_UNAVAILABLE': return '此草案已不可编辑。'
  }
  if (error?.status === 409) return '服务还没有确认这次创建。原请求已保存在本机；再次开始会重发同一请求，不会重复创建会话。'
  return '没有收到服务确认，可能是网络中断或超时。原请求已保存在本机；再次开始会重发同一请求，不会重复创建会话。'
}

/** Offer text to the Session's own native input. keep: an existing draft is never replaced; nothing is sent. */
export async function offerPlanningText(host, sessionId, text, signal) {
  await new Promise(resolve => requestAnimationFrame(() => resolve()))
  signal?.throwIfAborted()
  const binding = host.sessions.binding?.(sessionId), input = binding?.ctx.get('conversation')?.input
  if (!input) return 'input_unavailable'
  const result = input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'keep' })
  if (result === 'applied') input.for?.(binding.ctx)?.focus?.()
  return result
}

/** Explicit "open in session mode": the native workspace takes over the main view. */
export async function openPlanningSession(host, sessionId, text, signal) {
  if (!host?.sessions || !host.uiWorkspace) throw Error('Native workspace unavailable')
  // A view closed while waiting (back to the list, another draft) must not open or fill anything.
  signal?.throwIfAborted()
  await host.sessions.refresh()
  signal?.throwIfAborted()
  await host.uiWorkspace.openSession(sessionId)
  signal?.throwIfAborted()
  host.selectMode?.('session')
  return text ? offerPlanningText(host, sessionId, text, signal) : 'opened'
}
