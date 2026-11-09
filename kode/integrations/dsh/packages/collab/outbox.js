const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const keyOf = team => JSON.stringify([team.home_hub, team.conversation_id])
function validateTeam(team) {
  if (!team || !['home_hub', 'id', 'superagent_id', 'conversation_id'].every(key => validId(team[key]))) throw Error('无法确认联系人身份。')
}
function validateRecord(team, row) {
  if (!row) return
  if (row.home_hub !== team.home_hub || row.team_id !== team.id || row.superagent_id !== team.superagent_id || row.conversation_id !== team.conversation_id
    || (row.prior_run_id !== undefined && !validId(row.prior_run_id)) || (row.draft_token !== undefined && !validId(row.draft_token)) || !validId(row.request_id) || typeof row.content !== 'string' || !['prepared', 'unconfirmed', 'accepted'].includes(row.state)) throw Error('发送记录与当前联系人不匹配。')
}
function validReceipt(row, receipt) {
  return receipt && receipt.home_hub === row.home_hub && receipt.team_id === row.team_id && receipt.superagent_id === row.superagent_id
    && receipt.conversation_id === row.conversation_id && receipt.request_id === row.request_id && receipt.content === row.content
    && receipt.prior_run_id === row.prior_run_id
    && receipt.actor?.kind === 'human' && receipt.state === 'accepted' && validId(receipt.id)
}
export function createCollabOutbox({ storage, request, uuid = () => crypto.randomUUID() }) {
  const listeners = new Set(), pending = new Map(), controllers = new Set()
  let snapshot = {}, disposed = false
  const publish = (key, value) => { if (disposed) return; snapshot = { ...snapshot, [key]: value }; for (const listener of listeners) listener() }
  const serial = (key, kind, work) => {
    if (disposed) return Promise.reject(Error('消息界面已关闭。'))
    const prior = pending.get(key)
    if (prior) return prior.kind === 'load' && kind !== 'load' ? prior.job.then(() => serial(key, kind, work)) : prior.job
    const job = Promise.resolve().then(work).finally(() => { if (pending.get(key)?.job === job) pending.delete(key) })
    pending.set(key, { kind, job }); return job
  }
  const deliver = async (team, row, recover) => {
    validateRecord(team, row)
    if (row.state === 'accepted' || disposed) return row
    const key = keyOf(team), controller = new AbortController(); controllers.add(controller)
    publish(key, { ...row, busy: true, error: '' })
    try {
      let receipt
      if (recover) {
        const result = await request(`/api/kode/conversation/messages?conversation_id=${encodeURIComponent(row.conversation_id)}&request_id=${encodeURIComponent(row.request_id)}`, { signal: controller.signal })
        if (!result || !Object.hasOwn(result, 'message')) throw Error('Invalid receipt response')
        receipt = result.message
      }
      controller.signal.throwIfAborted()
      if (!receipt) receipt = await request('/api/kode/conversation/messages', { signal: controller.signal, body: { conversation_id: row.conversation_id, request_id: row.request_id, content: row.content, ...(row.prior_run_id === undefined ? {} : { prior_run_id: row.prior_run_id }) } })
      if (!validReceipt(row, receipt)) throw Error('Receipt identity mismatch')
      const accepted = { ...row, state: 'accepted', receipt }
      await storage.save(key, accepted)
      publish(key, { ...accepted, busy: false, error: '' })
      return accepted
    } catch {
      const uncertain = { ...row, state: 'unconfirmed' }
      try { await storage.save(key, uncertain) } catch {}
      publish(key, { ...uncertain, busy: false, error: '发送结果尚未确认。重试会先查询原请求，不会新建请求。' })
      return uncertain
    } finally { controllers.delete(controller) }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    keyOf,
    load(team) {
      validateTeam(team); const key = keyOf(team)
      return serial(key, 'load', async () => { const row = await storage.read(key); validateRecord(team, row); publish(key, row ? { ...row, busy: false, error: '' } : null); return row })
    },
    send(team, content, { prior_run_id, draft_token } = {}) {
      validateTeam(team)
      if (typeof content !== 'string' || !content.trim() || content.includes('\0') || new TextEncoder().encode(content).length > 65536) return Promise.reject(Error('请输入不超过 64 KiB 的消息。'))
      if (prior_run_id !== undefined && !validId(prior_run_id)) return Promise.reject(Error('无法确认关联任务。'))
      if (draft_token !== undefined && !validId(draft_token)) return Promise.reject(Error('无法确认草稿版本。'))
      const key = keyOf(team)
      // A second click joins the same in-flight operation. A later differing message cannot replace an unresolved one.
      return serial(key, 'send', async () => {
        const candidate = { home_hub: team.home_hub, team_id: team.id, superagent_id: team.superagent_id, conversation_id: team.conversation_id, request_id: uuid(), content, ...(prior_run_id === undefined ? {} : { prior_run_id }), ...(draft_token === undefined ? {} : { draft_token }), state: 'prepared' }
        if (!validId(candidate.request_id)) throw Error('无法创建消息请求标识。')
        const row = await storage.reserve(key, candidate); validateRecord(team, row)
        if (row.content !== content || row.prior_run_id !== prior_run_id) throw Error('上一条消息结果尚未确认，请先恢复该请求。')
        return deliver(team, row, row.request_id !== candidate.request_id)
      })
    },
    retry(team) {
      validateTeam(team); const key = keyOf(team)
      return serial(key, 'retry', async () => { const row = await storage.read(key); if (!row) throw Error('没有待恢复的消息。'); return deliver(team, row, true) })
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); listeners.clear() },
  }
}
export async function requestCollabMessage(path, { body, signal, fetcher = globalThis.fetch } = {}) {
  if (body === undefined ? !path.startsWith('/api/kode/conversation/messages?') : path !== '/api/kode/conversation/messages') throw Error('Unsupported message request')
  const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  if (!response.ok) throw Error('Message result unavailable')
  return response.json()
}
