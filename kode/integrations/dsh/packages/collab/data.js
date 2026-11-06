/** Bounded UI projection and owner read acknowledgments. Lifecycle remains on the Hub. */
function validContact(contact) {
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0
  const preference = contact?.preference
  return preference && nonnegative(preference.revision) && nonnegative(preference.archived_through_sequence)
    && typeof preference.pinned === 'boolean' && typeof preference.archived === 'boolean'
    && typeof contact.archived === 'boolean' && typeof contact.needs_attention === 'boolean'
    && [contact.latest_sequence, contact.unread_count, contact.last_activity_at,
      contact.attention?.decisions, contact.attention?.resources, contact.attention?.stopping, contact.attention?.active_runs].every(nonnegative)
}
export function createCollabData({ request, readRequest = requestConversationReadState, contactDirectory = false, schedulePublish, cancelPublish = () => {} }) {
  const listeners = new Set(), pending = new Map(), controllers = new Set()
  let notificationFrame = null
  let disposed = false, directoryGeneration = 0, activeDirectoryKey
  let snapshot = Object.freeze({ homeHub: null, teams: [], nextTeamCursor: null, directoryLoaded: false,
    directoryQuery: '', archivedContacts: false, knownTeams: {}, directoryLoading: false, directoryError: '', conversations: {} })
  const publish = patch => {
    if (disposed) return
    snapshot = Object.freeze({ ...snapshot, ...patch })
    if (!schedulePublish) { for (const listener of listeners) listener() }
    else if (notificationFrame === null) notificationFrame = schedulePublish(() => {
      notificationFrame = null
      if (!disposed) for (const listener of listeners) listener()
    })
  }
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  const empty = () => ({ items: [], cursor: 0, hasMore: false, loaded: false, loading: false, error: '', readState: null, readError: '' })
  const conversation = id => Object.hasOwn(snapshot.conversations, id) ? snapshot.conversations[id] : empty()
  const updateConversation = (id, patch) => publish({ conversations: { ...snapshot.conversations, [id]: { ...conversation(id), ...patch } } })
  const run = (key, work, externalSignal) => {
    if (disposed) return Promise.resolve()
    if (pending.has(key)) return pending.get(key)
    const controller = new AbortController()
    controllers.add(controller)
    const job = Promise.resolve().then(() => work(externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal)).finally(() => {
      controllers.delete(controller)
      if (pending.get(key) === job) pending.delete(key)
    })
    pending.set(key, job)
    return job
  }
  const readPosition = (id, through, signal) => {
    if (!identity(id)) return Promise.reject(Error('Invalid conversation identity'))
    if (disposed) return Promise.resolve()
    const team = Object.values(snapshot.knownTeams).find(row => row.conversation_id === id)
    if (!team) return Promise.reject(Error('Conversation is not in the loaded directory'))
    if (through !== undefined && (!Number.isSafeInteger(through) || through < 0
      || !conversation(id).items.some(item => item.sequence === through))) return Promise.reject(Error('Read position must identify a loaded message'))
    return run(`read:${id}:${through ?? 'get'}`, async signal => {
      try {
        const state = await readRequest(through === undefined
          ? `/api/kode/conversation/read-state?conversation_id=${encodeURIComponent(id)}`
          : '/api/kode/conversation/read-state', { signal, ...(through === undefined ? {} : { body: { conversation_id: id, through_sequence: through } }) })
        if (disposed || signal.aborted) return
        if (state.home_hub !== snapshot.homeHub || state.team_id !== team.id || state.conversation_id !== id || state.principal_id !== 'local_owner'
          || ![state.through_sequence, state.latest_sequence, state.unread_count].every(value => Number.isSafeInteger(value) && value >= 0)
          || state.through_sequence > state.latest_sequence || state.unread_count > state.latest_sequence - state.through_sequence
          || (through !== undefined && state.through_sequence < through)) throw Error('Invalid read-state projection')
        const current = conversation(id).readState
        // Concurrent GET/POST replies may arrive out of order. Never resurrect an older badge/cursor.
        if (current && (state.through_sequence < current.through_sequence || state.latest_sequence < current.latest_sequence)) return
        updateConversation(id, { readState: state, readError: '' })
      } catch {
        if (!disposed && !signal?.aborted) updateConversation(id, { readError: '已读状态暂未同步。请刷新或重试，消息内容已保留。' })
      }
    }, signal)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    loadReadState: (id, options) => readPosition(id, undefined, options?.signal),
    markRead: (id, through) => through === undefined ? Promise.reject(Error('Read position required')) : readPosition(id, through),
    restoreSelectedTeam(teamId, superagentId) {
      if (!identity(teamId) || !identity(superagentId) || !identity(snapshot.homeHub)) return Promise.reject(Error('Invalid saved contact scope'))
      if (snapshot.knownTeams[superagentId]) return Promise.resolve()
      const home = snapshot.homeHub
      return run(`selected-contact:${home}:${teamId}`, async signal => {
        try {
          const result = await request(`/api/kode/collab/teams?team_id=${encodeURIComponent(teamId)}`, { signal })
          const team = result.team
          if (result.projection !== 'configuration_revision' || team?.id !== teamId || team.superagent_id !== superagentId
            || team.home_hub !== home || !identity(team.conversation_id)) throw Error('Saved contact identity changed')
          const state = await request(`/api/kode/collab/teams?view=contact-preference&team_id=${encodeURIComponent(teamId)}`, { signal })
          const pref = state.preference
          if (state.home_hub !== home || state.team_id !== teamId || state.principal_id !== 'local_owner'
            || !Number.isSafeInteger(pref?.revision) || pref.revision < 0
            || typeof pref.pinned !== 'boolean' || typeof pref.archived !== 'boolean') throw Error('Saved contact preference unavailable')
          if (disposed || snapshot.homeHub !== home || snapshot.knownTeams[superagentId]) return
          publish({ knownTeams: { ...snapshot.knownTeams, [superagentId]: { ...team, contact: { preference: pref } } } })
        } catch {
          if (!disposed && snapshot.homeHub === home) publish({ directoryError: '暂时无法恢复原联系人，请刷新联系人或重新选择。' })
        }
      })
    },
    async refreshContacts({ signal } = {}) {
      const count = snapshot.teams.length
      const search = snapshot.directoryQuery
      const archived = snapshot.archivedContacts
      await this.loadTeams({ search, archived, signal })
      while (!disposed && !signal?.aborted && snapshot.directoryQuery === search && snapshot.archivedContacts === archived
        && !snapshot.directoryError && snapshot.teams.length < count && snapshot.nextTeamCursor) {
        const before = snapshot.nextTeamCursor
        await this.loadTeams({ more: true, search, archived, signal })
        if (snapshot.nextTeamCursor === before) break
      }
    },
    loadTeams({ more = false, search = snapshot.directoryQuery, archived = snapshot.archivedContacts, signal: externalSignal } = {}) {
      if (typeof search !== 'string' || new TextEncoder().encode(search).length > 160 || search.includes('\0')) return Promise.reject(Error('Invalid contact search'))
      search = search.trim()
      if (typeof archived !== 'boolean') return Promise.reject(Error('Invalid contact archive filter'))
      if (disposed) return Promise.resolve()
      if (more && (search !== snapshot.directoryQuery || archived !== snapshot.archivedContacts)) return Promise.reject(Error('Search cursor changed'))
      const after = more ? snapshot.nextTeamCursor : ''
      if (more && (!after || snapshot.directoryLoading)) return Promise.resolve()
      if (!more && search === snapshot.directoryQuery && archived === snapshot.archivedContacts && pending.has(activeDirectoryKey)) return pending.get(activeDirectoryKey)
      const generation = more ? directoryGeneration : ++directoryGeneration
      const key = more ? `directory:${generation}:${after}` : `directory:refresh:${generation}`
      if (!more) activeDirectoryKey = key
      if (search !== snapshot.directoryQuery || archived !== snapshot.archivedContacts) publish({ directoryQuery: search, archivedContacts: archived, teams: [], nextTeamCursor: null, directoryLoaded: false })
      return run(key, async signal => {
        publish({ directoryLoading: true, directoryError: '' })
        try {
          const contactQuery = contactDirectory ? `&view=contacts&archived=${archived}` : ''
          const page = await request(`/api/kode/collab/teams?after=${encodeURIComponent(after)}&limit=25${search ? '&q=' + encodeURIComponent(search) : ''}${contactQuery}`, { signal })
          if (disposed || signal.aborted || generation !== directoryGeneration) return
          if (!identity(page.home_hub) || (snapshot.homeHub && snapshot.homeHub !== page.home_hub)
            || page.projection !== (contactDirectory ? 'contact_directory' : 'configuration_revision') || !Array.isArray(page.items) || page.items.length > 25
            || page.items.some(team => !identity(team.id) || !identity(team.superagent_id) || !identity(team.conversation_id) || team.home_hub !== page.home_hub)
            || new Set(page.items.map(team => team.id)).size !== page.items.length
            || (page.next_cursor !== null && (contactDirectory
              ? !/^[A-Za-z0-9_-]{1,2048}$/.test(page.next_cursor) || page.next_cursor === after
              : !identity(page.next_cursor) || page.next_cursor <= after || page.next_cursor !== page.items.at(-1)?.id))) throw Error('Invalid directory projection')
          if (contactDirectory && (page.archived !== archived || page.order !== 'pinned_attention_unread_recent'
            || page.items.some(team => !validContact(team.contact)))) throw Error('Invalid contact summary')
          const teams = new Map((more ? snapshot.teams : []).map(team => [team.id, team]))
          for (const team of page.items) teams.set(team.id, team)
          const knownTeams = { ...snapshot.knownTeams }
          for (const team of page.items) knownTeams[team.superagent_id] = team
          publish({ homeHub: page.home_hub, knownTeams, teams: [...teams.values()], nextTeamCursor: page.next_cursor, directoryLoaded: true })
        } catch {
          if (!disposed && !signal.aborted && generation === directoryGeneration) publish({ directoryError: '暂时无法读取联系人，已保留上次内容。请重试。' })
        } finally {
          if (!disposed && generation === directoryGeneration) publish({ directoryLoading: false })
        }
      }, externalSignal)
    },
    acceptMessagePage(id, page) {
      if (disposed) return
      const team = Object.values(snapshot.knownTeams).find(row => row.conversation_id === id)
      const before = conversation(id)
      try {
        if (!team || page.home_hub !== snapshot.homeHub || page.team_id !== team.id || page.conversation_id !== id
          || !Array.isArray(page.items) || !page.items.length || page.items.length > 50 || typeof page.has_more !== 'boolean') throw Error('Invalid stream scope')
        const existing = new Map(before.items.map(item => [item.id, item]))
        let previous = 0, cursor = before.cursor
        const append = []
        for (const item of page.items) {
          if (!identity(item.id) || item.home_hub !== snapshot.homeHub || item.team_id !== team.id || item.conversation_id !== id
            || !Number.isSafeInteger(item.sequence) || item.sequence <= previous) throw Error('Invalid stream message')
          previous = item.sequence
          if (item.sequence <= before.cursor) {
            if (JSON.stringify(existing.get(item.id)) !== JSON.stringify(item)) throw Error('Conflicting replay')
          } else {
            if (existing.has(item.id)) throw Error('Duplicate stream identity')
            existing.set(item.id, item); append.push(item); cursor = item.sequence
          }
        }
        if (page.next_cursor !== (page.has_more ? previous : null)) throw Error('Invalid stream continuation')
        if (append.length) updateConversation(id, { items: [...before.items, ...append], cursor, hasMore: page.has_more, loaded: true, error: '' })
      } catch { updateConversation(id, { error: '消息同步暂未确认，已保留原有内容。请刷新重试。' }); throw Error('Invalid conversation stream') }
    },
    loadMessages(id, { signal: externalSignal } = {}) {
      if (!identity(id)) return Promise.reject(Error('Invalid conversation identity'))
      if (disposed) return Promise.resolve()
      const team = Object.values(snapshot.knownTeams).find(row => row.conversation_id === id)
      if (!team) return Promise.reject(Error('Conversation is not in the loaded directory'))
      return run(`conversation:${id}`, async signal => {
        const before = conversation(id), after = before.cursor
        updateConversation(id, { loading: true, error: '' })
        try {
          const page = await request(`/api/kode/conversation/messages?conversation_id=${encodeURIComponent(id)}&after=${after}&limit=50`, { signal })
          if (disposed || signal.aborted) return
          if (page.home_hub !== snapshot.homeHub || page.conversation_id !== id || page.team_id !== team.id
            || !Array.isArray(page.items) || page.items.length > 50 || typeof page.has_more !== 'boolean') throw Error('Invalid conversation projection')
          let cursor = after
          const seen = new Set(before.items.map(item => item.id))
          for (const item of page.items) {
            if (!identity(item.id) || seen.has(item.id) || item.conversation_id !== id || item.team_id !== team.id
              || item.home_hub !== snapshot.homeHub || !Number.isSafeInteger(item.sequence) || item.sequence <= cursor) throw Error('Invalid message identity or order')
            seen.add(item.id); cursor = item.sequence
          }
          if (page.has_more ? page.items.length === 0 || page.next_cursor !== cursor : page.next_cursor !== null) throw Error('Invalid conversation cursor')
          const current = conversation(id)
          const byId = new Map(current.items.map(item => [item.id, item]))
          for (const item of page.items) {
            if (item.sequence <= current.cursor && JSON.stringify(byId.get(item.id)) !== JSON.stringify(item)) throw Error('Conflicting concurrent message')
          }
          const added = page.items.filter(item => item.sequence > current.cursor)
          updateConversation(id, { items: [...current.items, ...added], cursor: Math.max(current.cursor, cursor), hasMore: current.cursor > cursor ? current.hasMore : page.has_more, loaded: true })
        } catch {
          if (!disposed && !externalSignal?.aborted) updateConversation(id, { error: '暂时无法读取对话，已保留上次内容。请重试。' })
        } finally {
          if (!disposed) updateConversation(id, { loading: false })
        }
      }, externalSignal)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (notificationFrame !== null) cancelPublish(notificationFrame)
      for (const controller of controllers) controller.abort()
      listeners.clear()
    },
  }
}

export async function requestConversationReadState(path, { body, signal, fetcher = globalThis.fetch } = {}) {
  if (body === undefined ? !path.startsWith('/api/kode/conversation/read-state?') : path !== '/api/kode/conversation/read-state') throw Error('Unsupported read-state request')
  const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  if (!response.ok) throw Error('Read-state result unavailable')
  return response.json()
}

export async function requestCollabRead(path, { signal, fetcher = globalThis.fetch } = {}) {
  if (!path.startsWith('/api/kode/work-run/trace?') && !path.startsWith('/api/kode/work-run/execution?') && !path.startsWith('/api/kode/work-run/waiver?') && !path.startsWith('/api/kode/builder/default-selection?') && !path.startsWith('/api/kode/builder/conversation?') && !path.startsWith('/api/kode/builder/funding?') && !path.startsWith('/api/kode/builder/selection?') && !path.startsWith('/api/kode/builder/models?') && !path.startsWith('/api/kode/collab/budgets?') && !path.startsWith('/api/kode/resource-coverage?') && !path.startsWith('/api/kode/builder/patch-status?') && !path.startsWith('/api/kode/builder/workspace-directory?') && !path.startsWith('/api/kode/builder/drafts?') && !path.startsWith('/api/kode/collab/evidence?') && !path.startsWith('/api/kode/work-run?') && !path.startsWith('/api/kode/collab/runs?') && !path.startsWith('/api/kode/collab/teams?') && !path.startsWith('/api/kode/conversation/messages?')) throw Error('Unsupported collaboration read')
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetcher(path, { method: 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal })
    if (!response.ok) throw Object.assign(Error('Collaboration read unavailable'), { status: response.status })
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
