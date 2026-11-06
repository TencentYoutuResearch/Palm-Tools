const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export const conversationViewKey = team => JSON.stringify(['conversation-view-v1', team.home_hub, 'local_owner', team.conversation_id])

function validate(team, record) {
  if (!record) return
  if (record.format !== 'kode.conversation.view.v1' || record.state !== 'draft'
    || record.home_hub !== team.home_hub || record.team_id !== team.id || record.conversation_id !== team.conversation_id
    || !validId(record.request_id) || !validId(record.draft_token)
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || typeof record.value?.draft !== 'string' || record.value.draft.length > 65536
    || !Number.isFinite(record.value.scrollTop) || record.value.scrollTop < 0
    || (record.value.priorRunId !== null && !validId(record.value.priorRunId))) throw Error('草稿记录与当前对话不匹配。')
}

/** IndexedDB stores scoped view data. Revision CAS protects edits from other renderers. */
export function createConversationViews({ storage, view, uuid = () => crypto.randomUUID() }) {
  const rows = new Map(), listeners = new Set()
  let snapshot = {}, disposed = false
  const publish = row => {
    if (disposed) return
    snapshot = { ...snapshot, [row.team.conversation_id]: {
      ready: row.ready, value: row.value, saving: row.dirty || !!row.pending, writing: !!row.pending,
      error: row.error, conflict: row.conflict, draftToken: row.token,
    } }
    for (const listener of listeners) listener()
  }
  const setView = row => view.saveConversation(row.team.conversation_id, row.value, { persist: false })
  const find = team => {
    const row = rows.get(team.conversation_id)
    if (!row || row.team.home_hub !== team.home_hub || row.team.id !== team.id) throw Error('草稿尚未恢复。')
    return row
  }
  const flush = row => {
    if (disposed) return Promise.reject(Error('草稿界面已关闭。'))
    if (row.pending) return row.pending
    const task = (async () => {
      await row.loading
      if (!row.ready) throw Error('草稿尚未恢复。')
      if (row.conflict) throw Error('另一页面已更新草稿，请先处理保存冲突。')
      while (row.dirty) {
        const version = row.version
        const next = {
          format: 'kode.conversation.view.v1', state: 'draft', home_hub: row.team.home_hub,
          team_id: row.team.id, conversation_id: row.team.conversation_id,
          request_id: uuid(), draft_token: row.token, revision: row.revision + 1,
          value: { ...row.value },
        }
        validate(row.team, next)
        const saved = await storage.update(conversationViewKey(row.team), current => {
          validate(row.team, current)
          return (current?.revision ?? 0) === row.revision ? next : current
        })
        validate(row.team, saved)
        if (saved?.request_id !== next.request_id) {
          row.conflict = true
          throw Error('另一页面已更新草稿。当前输入仍保留在此页面。')
        }
        row.revision = next.revision
        row.dirty = row.version !== version
      }
      row.error = ''
      return { value: row.value, draftToken: row.token }
    })()
    row.pending = task
    task.catch(error => { row.error = error.message }).finally(() => {
      if (row.pending === task) row.pending = null
      publish(row)
      if (row.dirty && !row.error && !row.conflict && !disposed) void flush(row).catch(() => {})
    })
    return task
  }
  const update = (row, value) => {
    const next = { draft: value.draft, scrollTop: value.scrollTop, priorRunId: value.priorRunId ?? null }
    if (next.draft === row.value.draft && next.scrollTop === row.value.scrollTop && next.priorRunId === row.value.priorRunId) return
    if (next.draft !== row.value.draft || next.priorRunId !== row.value.priorRunId) row.token = uuid()
    row.token ??= uuid()
    row.value = next
    row.version++
    row.dirty = true
    publish(row)
    void flush(row).catch(() => {})
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    open(team) {
      if (!['home_hub', 'id', 'conversation_id'].every(key => validId(team[key]))) return Promise.reject(Error('无法确认草稿所属对话。'))
      const existing = rows.get(team.conversation_id)
      if (existing) return find(team).loading
      const row = { team, ready: false, revision: 0, token: null, version: 0, dirty: false, pending: null,
        value: { ...view.conversation(team.conversation_id), priorRunId: null }, error: '', conflict: false }
      rows.set(team.conversation_id, row)
      row.loading = (async () => {
        try {
          const [saved, sent] = await Promise.all([
            storage.read(conversationViewKey(team)), storage.read(JSON.stringify([team.home_hub, team.conversation_id])),
          ])
          validate(team, saved)
          if (saved) { row.value = saved.value; row.revision = saved.revision; row.token = saved.draft_token }
          if (saved && sent?.state === 'accepted' && sent.draft_token === saved.draft_token
            && sent.home_hub === team.home_hub && sent.team_id === team.id && sent.conversation_id === team.conversation_id
            && sent.content === saved.value.draft && sent.prior_run_id === (saved.value.priorRunId ?? undefined)
            && sent.receipt?.request_id === sent.request_id && sent.receipt?.state === 'accepted'
            && sent.receipt?.home_hub === team.home_hub && sent.receipt?.team_id === team.id
            && sent.receipt?.conversation_id === team.conversation_id && sent.receipt?.content === saved.value.draft
            && sent.receipt?.actor?.kind === 'human') {
            row.value = { ...row.value, draft: '', priorRunId: null }
            row.token = uuid()
            row.dirty = true
          }
          setView(row)
          row.ready = true
        } catch (error) { row.error = error.message; throw error }
        finally { publish(row) }
      })()
      return row.loading.then(async () => { if (row.dirty) await flush(row) })
    },
    update(id, value) {
      const row = rows.get(id)
      if (disposed || !row?.ready) return
      update(row, value)
    },
    reopen(team) {
      const row = find(team)
      if (row.ready) return Promise.reject(Error('草稿已经恢复。'))
      rows.delete(team.conversation_id)
      return this.open(team)
    },
    async flush(team) {
      const row = find(team)
      await flush(row)
      while (row.dirty) await flush(row)
      return { value: row.value, draftToken: row.token }
    },
    async acknowledge(team, sent) {
      const row = find(team)
      if (!sent?.draft_token || row.token !== sent.draft_token || sent.state !== 'accepted'
        || sent.home_hub !== team.home_hub || sent.team_id !== team.id || sent.conversation_id !== team.conversation_id) return false
      const value = { ...row.value, draft: '', priorRunId: null }
      update(row, value)
      setView(row)
      await flush(row)
      return true
    },
    async retry(team, { overwrite = false } = {}) {
      const row = find(team)
      if (row.pending) await row.pending.catch(() => {})
      if (overwrite) {
        const saved = await storage.read(conversationViewKey(team))
        validate(team, saved)
        row.revision = saved?.revision ?? 0
        row.conflict = false
      }
      return flush(row)
    },
    close() { disposed = true; listeners.clear() },
  }
}
