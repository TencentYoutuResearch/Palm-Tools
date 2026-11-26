  const API = '/api/kode/agents', stores = new Map()
  const startupRetryDelays = [250, 500, 1000, 2000, 4000, 8000]
  let stagedAgent, transport, avatarContext, requestNativeRename, routedRename
  let openingSession = false
  const openingListeners = new Set()
  const sessionOpening = {
    subscribe(listener) { openingListeners.add(listener); return () => openingListeners.delete(listener) },
    getSnapshot: () => openingSession,
    set(value) {
      if (openingSession === value) return
      openingSession = value
      for (const listener of openingListeners) listener()
    },
  }
  function ConversationNavigation({ native, ...props }) {
    const loading = useSyncExternalStore(sessionOpening.subscribe, sessionOpening.getSnapshot)
    return h('div', { className: 'kode-conversation-navigation' },
      h('div', { className: 'kode-conversation-body', 'aria-busy': loading, inert: loading || undefined }, h(native, props)),
      loading && h('div', { className: 'kode-conversation-loading', role: 'status' },
        h(IconLoadingOutlineRegular, { size: 18, 'aria-hidden': true }), '加载中…'))
  }
  function RoutedRenameDialog({ native, renameSession, settleSessionRename, ...props }) {
    const rename = async (id, title) => {
      const target = routedRename
      if (target?.id !== id) return renameSession(id, title)
      await projectCall({ action: 'host-operation', id: target.hostId, operation: 'rename-session', args: { sessionId: target.sessionId, title } })
      void refreshWorkspaceDirectory()
    }
    return h(native, { ...props, renameSession: rename, settleSessionRename: () => { routedRename = undefined; settleSessionRename() } })
  }
  function wrapSlot(ctx, name, match, render) {
    ctx.slots.inject(name, () => {
      let entry, native, wrapped
      const restore = () => { if (entry && entry.component === wrapped) entry.component = native }
      const install = () => {
        const source = ctx.slots.entries(name).find(match)
        if (!source || source === entry) return
        restore()
        entry = source
        native = source.component
        wrapped = render(native)
        source.component = wrapped
      }
      const unsubscribe = ctx.slots.subscribe(name, install)
      install()
      return () => { unsubscribe(); restore() }
    })
  }
  const fetchHost = (url, options, host) => transport ? transport.fetch(url, options, host) : fetch(url, options)
  const switchHost = (id, target) => { if (!transport) throw new Error('Kode 主机传输插件尚未就绪。'); return transport.select(id, target) }
  async function call(body, sessionId, refresh = false, host, configurationOnly = false, profileId) {
    const response = await fetchHost(body ? API : `${API}?session_id=${encodeURIComponent(sessionId ?? '')}${refresh ? '&refresh=1' : ''}${configurationOnly ? '&configuration=1' : ''}${profileId ? `&profile_id=${encodeURIComponent(profileId)}` : ''}`, {
      credentials: 'same-origin', cache: 'no-store', method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }, host)
    const value = await parseHostJson(response)
    if (!response.ok) throw new Error(value.error ?? '操作失败，请重试。')
    return value
  }
  async function nativeSessionRequest(host, { profileId, cursor, input, signal }) {
    const path = '/api/kode/native-sessions'
    const query = new URLSearchParams({ profile_id: profileId ?? '' })
    if (cursor) query.set('cursor', cursor)
    const response = await fetchHost(input ? path : `${path}?${query}`, {
      credentials: 'same-origin', cache: 'no-store', signal,
      ...(input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}),
    }, host)
    const value = await parseHostJson(response)
    if (!response.ok) throw new Error(value.error ?? '无法读取原生会话，请重试。')
    return value
  }
  async function saveDefaultAgent(host, profile) {
    return call({ action: 'set-default', profileId: profile?.id ?? null }, undefined, false, host)
  }
  function directory(id, host = transport?.current ?? 'local', configurationOnly = false, profileId) {
    const key = `${host}:${configurationOnly ? `settings:${profileId ?? ''}` : id ?? ''}`
    if (!stores.has(key)) {
      let snapshot = { data: undefined, busy: false, error: '' }, pending, revision = 0
      const listeners = new Set(), publish = patch => { snapshot = { ...snapshot, ...patch }; for (const fn of listeners) fn() }
      const store = {
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot,
        load: (refresh = false) => pending ??= (async () => {
          const ticket = ++revision
          const delays = host === 'local' && !snapshot.data ? startupRetryDelays : []
          try {
            for (let attempt = 0; ticket === revision; attempt++) {
              try {
                const data = await call(undefined, id, refresh, host, configurationOnly, profileId)
                if (ticket === revision) publish({ data, error: '' })
                break
              } catch (error) {
                // Desktop can serve the page before the Kode Agent route is mounted.
                if (error.code !== 'KODE_SERVICE_UPDATE_REQUIRED' || attempt >= delays.length) throw error
                await new Promise(resolve => setTimeout(resolve, delays[attempt]))
              }
            }
          } catch (error) { if (ticket === revision) publish({ error: error.message }) }
          finally { pending = undefined }
        })(),
        operate: async body => {
          if (snapshot.busy) return
          publish({ busy: true, error: '' })
          try {
            const result = await call(body, id, false, host)
            if (result.rebound) {
              const ui = avatarContext?.get('uiWorkspace')
              if (ui) {
                ui.clearMain()
                await avatarContext.sessions.refresh()
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
                await ui.openSession(id)
              }
            }
            await pending
            await store.load()
            if (['save', 'remove'].includes(body.action)) for (const other of stores.values()) if (other !== store) void other.load()
            return result
          } catch (error) { publish({ error: error.message }); throw error }
          finally { publish({ busy: false }) }
        },
      }
      stores.set(key, store)
    }
    return stores.get(key)
  }
  const catalogBlank = (sessions, id) => sessions.list.getSnapshot().byId[id]?.blank === true
