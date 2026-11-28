  // Shared Kode Memory ("共享记忆"): owner approval queue + approved facts browser.
  const MEMORY_KIND_LABELS = { gotcha: '踩坑', invariant: '硬规则', recipe: '配方', dead_end: '死胡同', preference: '偏好' }
  async function memoryCall(query = '', body = null, host = 'local') {
    const response = await fetchHost(
      `/api/kode/memory${query}`,
      body
        ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { credentials: 'same-origin', cache: 'no-store' },
      host,
    )
    const value = await parseHostJson(response)
    if (!response.ok) throw Object.assign(new Error(value.error ?? '共享记忆暂不可用'), { code: value.code, status: response.status })
    return value
  }
  let memorySnapshot = { data: null, error: '', recoveryNeeded: false, loaded: false }, memoryPendingReq
  const memoryListeners = new Set()
  const memoryStore = { subscribe: fn => { memoryListeners.add(fn); return () => memoryListeners.delete(fn) }, getSnapshot: () => memorySnapshot }
  function publishMemory(next) { memorySnapshot = next; for (const listener of memoryListeners) listener() }
  async function refreshMemory(host = 'local') {
    if (host === 'local' && memoryPendingReq) return memoryPendingReq
    const req = memoryCall('', null, host).then(
      data => {
        if (host === 'local') publishMemory({ data, error: '', recoveryNeeded: false, loaded: true })
        return data
      },
      error => {
        if (host === 'local') publishMemory({ ...memorySnapshot, error: error.message, recoveryNeeded: error.code === 'KODE_SERVICE_UPDATE_REQUIRED', loaded: true })
        throw error
      },
    )
    if (host === 'local') {
      memoryPendingReq = req.catch(() => null).finally(() => { memoryPendingReq = undefined })
      return memoryPendingReq
    }
    return req
  }
  let memoryWatching = false, memoryFocusAt = 0
  function followMemoryFreshness() {
    if (memoryWatching) return
    memoryWatching = true
    const reread = () => {
      if (document.hidden || Date.now() - memoryFocusAt < 5000) return
      memoryFocusAt = Date.now()
      void refreshMemory('local')
    }
    window.addEventListener?.('focus', reread)
    document.addEventListener?.('visibilitychange', reread)
  }
  function useMemorySummary() {
    const snapshot = useSyncExternalStore(memoryStore.subscribe, memoryStore.getSnapshot)
    useEffect(() => {
      followMemoryFreshness()
      void refreshMemory('local')
      const timer = setInterval(() => { if (!document.hidden) void refreshMemory('local') }, 15000)
      return () => clearInterval(timer)
    }, [])
    return snapshot
  }
  // Lucide Brain / Bookmark-like glyph rendered at sidebar native icon size.
  const memoryIcon = size => navIcon(size,
    h('path', { d: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' }),
    h('path', { d: 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z' }),
    h('path', { d: 'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4' }),
  )
  function MemoryNavIcon({ size = sidebarIconSize } = {}) { return memoryIcon(size) }
  function MemoryPendingBadge() {
    const { data } = useMemorySummary()
    const count = data?.stats?.pending ?? data?.pending?.length ?? 0
    if (!count) return null
    return h('span', { className: 'kode-bot-badge kode-memory-badge', 'aria-label': `${count} 条待审批记忆`, title: `${count} 条待审批记忆` }, count > 99 ? '99+' : String(count))
  }
  function formatMemoryTime(iso) {
    if (!iso) return ''
    try {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    } catch { return iso }
  }
  function KodeMemoryPage({ slots }) {
    const { data: hostsData } = useProjectHosts()
    const [host, setHost] = useState(() => transport?.current ?? 'local')
    const localSummary = useMemorySummary()
    const [remoteData, setRemoteData] = useState(null)
    const [remoteError, setRemoteError] = useState('')
    const [remoteRecovery, setRemoteRecovery] = useState(false)
    const [tab, setTab] = useState('pending')
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const [actionError, setActionError] = useState('')
    const [selectedIds, setSelectedIds] = useState(() => new Set())
    const [editingId, setEditingId] = useState(null)
    const [editDraft, setEditDraft] = useState({ title: '', scope: '', body: '', tags: '', confidence: '0.8' })
    const [reasonTarget, setReasonTarget] = useState(null) // { id, kind: 'reject'|'blacklist'|'deprecate'|'batch_reject', reason }
    const [factsData, setFactsData] = useState(null)
    const [factsQuery, setFactsQuery] = useState('')
    const [factsScope, setFactsScope] = useState('')
    const [factsLoading, setFactsLoading] = useState(false)
    const [factsError, setFactsError] = useState('')

    const data = host === 'local' ? localSummary.data : remoteData
    const loadError = host === 'local' ? localSummary.error : remoteError
    const recoveryNeeded = host === 'local' ? localSummary.recoveryNeeded : remoteRecovery
    const pending = data?.pending ?? []
    const stats = data?.stats ?? { pending: pending.length, facts: 0, root: '' }
    const maxEnergy = data?.max_energy ?? 15
    const energyAuthors = data?.energy_by_author ?? []

    const reloadPending = async (targetHost = host) => {
      setActionError('')
      try {
        if (targetHost === 'local') {
          await refreshMemory('local')
        } else {
          setRemoteError(''); setRemoteRecovery(false)
          const next = await memoryCall('', null, targetHost)
          setRemoteData(next)
        }
      } catch (error) {
        if (targetHost !== 'local') {
          setRemoteError(error.message)
          setRemoteRecovery(error.code === 'KODE_SERVICE_UPDATE_REQUIRED')
        }
      }
    }
    const loadFacts = async (q = factsQuery, scope = factsScope, targetHost = host) => {
      setFactsLoading(true); setFactsError('')
      try {
        const qs = new URLSearchParams({ view: 'facts', limit: '60' })
        if (q.trim()) qs.set('q', q.trim())
        if (scope.trim()) qs.set('scope', scope.trim())
        setFactsData(await memoryCall(`?${qs.toString()}`, null, targetHost))
      } catch (error) {
        setFactsError(error.message)
      } finally {
        setFactsLoading(false)
      }
    }
    useEffect(() => {
      setSelectedIds(new Set()); setEditingId(null); setReasonTarget(null); setNotice(''); setActionError('')
      void reloadPending(host)
      if (tab === 'facts') void loadFacts(factsQuery, factsScope, host)
    }, [host])
    useEffect(() => {
      if (tab === 'facts') void loadFacts(factsQuery, factsScope, host)
    }, [tab])

    const reviewOne = async (item, verdict, label) => {
      setBusy(true); setActionError(''); setNotice('')
      try {
        const res = await memoryCall('', { action: 'review', id: item.id, verdict }, host)
        setEditingId(null); setReasonTarget(null)
        setSelectedIds(prev => { const next = new Set(prev); next.delete(item.id); return next })
        const energyText = typeof res.author_energy === 'number' ? `，能量余额 ${res.author_energy.toFixed(1)} / ${(res.max_energy ?? maxEnergy).toFixed(0)}` : ''
        setNotice(`${label}${energyText}`)
        await reloadPending(host)
        if (tab === 'facts') await loadFacts(factsQuery, factsScope, host)
      } catch (error) {
        setActionError(error.message)
      } finally {
        setBusy(false)
      }
    }
    const batchReview = async (kind, reason = '') => {
      const items = pending.filter(item => selectedIds.has(item.id))
      if (!items.length) return
      setBusy(true); setActionError(''); setNotice('')
      let okCount = 0
      try {
        for (const item of items) {
          const verdict = kind === 'approve' ? { kind: 'approve' } : { kind: 'reject', reason: reason || '批量拒绝' }
          await memoryCall('', { action: 'review', id: item.id, verdict }, host)
          okCount++
        }
        setSelectedIds(new Set()); setReasonTarget(null)
        setNotice(`已批量${kind === 'approve' ? '批准' : '拒绝'} ${okCount} 条提议`)
        await reloadPending(host)
      } catch (error) {
        setActionError(`已完成 ${okCount}/${items.length} 条：${error.message}`)
        await reloadPending(host)
      } finally {
        setBusy(false)
      }
    }
    const deprecateFact = async (id, reason) => {
      setBusy(true); setActionError(''); setNotice('')
      try {
        await memoryCall('', { action: 'deprecate', id, reason: reason || '由人工废弃' }, host)
        setReasonTarget(null)
        setNotice('已废弃该条记忆')
        await loadFacts(factsQuery, factsScope, host)
        await reloadPending(host)
      } catch (error) {
        setActionError(error.message)
      } finally {
        setBusy(false)
      }
    }
    const startEdit = item => {
      setReasonTarget(null)
      setEditingId(item.id)
      setEditDraft({
        title: item.title ?? '',
        scope: item.scope ?? 'shared',
        body: item.body ?? '',
        tags: Array.isArray(item.tags) ? item.tags.join(', ') : '',
        confidence: String(item.confidence ?? 0.8),
      })
    }
    const toggleSelect = id => setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    const allSelected = pending.length > 0 && pending.every(item => selectedIds.has(item.id))
    const hostOptions = (hostsData?.hosts ?? [{ id: 'local', name: '此计算机' }]).map(row => ({ value: row.id, label: row.name }))

    return h('div', { className: 'kode-settings-page kode-agent-settings kode-memory-page' },
      h('header', { className: 'kode-settings-brand' },
        h('span', { className: 'kode-settings-brand-avatar', 'aria-hidden': true }, h(MemoryNavIcon, { size: 20 })),
        h('div', { className: 'kode-settings-brand-meta' },
          h('h2', null, '共享记忆'),
          h('p', null, '审批 Agent 提交的记忆提议、查看能量配额，并检索已入库的团队与项目记忆。'))),
      h('div', { className: 'kode-settings-layout' },
        h('div', { className: 'kode-memory-toolbar' },
          h('nav', { className: 'kode-settings-nav', 'aria-label': '共享记忆视图' },
            h('button', { type: 'button', id: 'kode-memory-tab-pending', 'aria-current': tab === 'pending' ? 'page' : undefined, 'aria-controls': 'kode-memory-pending', onClick: () => setTab('pending') },
              `待审批 (${stats.pending ?? pending.length})`),
            h('button', { type: 'button', id: 'kode-memory-tab-facts', 'aria-current': tab === 'facts' ? 'page' : undefined, 'aria-controls': 'kode-memory-facts', onClick: () => setTab('facts') },
              `已入库 (${stats.facts ?? 0})`)),
          h('div', { className: 'kode-memory-header-actions' },
            hostOptions.length > 1 && h('div', { className: 'kode-memory-host-picker' },
              h(SelectField, { label: '主机', showLabel: false, value: host, options: hostOptions, onChange: setHost })),
            h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => { void reloadPending(host); if (tab === 'facts') void loadFacts(factsQuery, factsScope, host) } }, '刷新'))),
        h('section', { id: `kode-memory-${tab}`, className: 'kode-settings-section', tabIndex: -1, 'aria-label': tab === 'pending' ? '待审批记忆' : '已入库记忆' },
          h('div', { className: 'kode-memory-stats' },
            h('span', { className: 'kode-memory-stat' }, '能量上限 ', h('strong', null, String(maxEnergy)), ' · 批准后全额返还，6 小时恢复至上限')),

          energyAuthors.length > 0 && h('div', { className: 'kode-memory-energy-strip', 'aria-label': '作者能量状态' },
            ...energyAuthors.map(row => {
              const ratio = Math.max(0, Math.min(1, (row.energy ?? 0) / (row.max || maxEnergy || 15)))
              return h('span', { key: row.author, className: 'kode-memory-energy-pill', 'data-low': ratio < 0.25 ? 'true' : undefined, title: `${row.author}: ${(row.energy ?? 0).toFixed(1)} / ${(row.max ?? maxEnergy).toFixed(0)}` },
                h('span', { className: 'kode-memory-energy-author' }, row.author),
                h('span', { className: 'kode-memory-energy-bar' }, h('span', { style: { width: `${Math.round(ratio * 100)}%` } })),
                h('span', { className: 'kode-memory-energy-val' }, `${(row.energy ?? 0).toFixed(1)}/${(row.max ?? maxEnergy).toFixed(0)}`))
            })),

          notice && h('p', { role: 'status', className: 'kode-saved kode-memory-notice' }, notice),
          h(Failure, { text: actionError || loadError }),
          recoveryNeeded && slots && h(ServiceRecoveryLink, { host, slots }),

          tab === 'pending' && h('div', { className: 'kode-memory-content' },
        pending.length > 1 && h('div', { className: 'kode-memory-batch-bar' },
          h('label', { className: 'kode-memory-check' },
            h('input', { type: 'checkbox', checked: allSelected, onChange: () => setSelectedIds(allSelected ? new Set() : new Set(pending.map(p => p.id))) }),
            h('span', null, allSelected ? '取消全选' : `全选 (${pending.length})`)),
          selectedIds.size > 0 && h('div', { className: 'kode-memory-batch-actions' },
            h(Button, { type: 'button', variant: 'primary', disabled: busy, onClick: () => void batchReview('approve') }, `批量批准 (${selectedIds.size})`),
            h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setReasonTarget({ id: '__batch__', kind: 'batch_reject', reason: '' }) }, `批量拒绝 (${selectedIds.size})`))),

        reasonTarget?.kind === 'batch_reject' && h('form', {
          className: 'kode-agent-row kode-memory-reason-form',
          onSubmit: event => { event.preventDefault(); void batchReview('reject', reasonTarget.reason.trim()) },
        },
          h('label', { className: 'kode-field' },
            h('span', null, `批量拒绝 ${selectedIds.size} 条提议的理由（可选）`),
            h('input', { type: 'text', autoFocus: true, value: reasonTarget.reason, placeholder: '例如：内容过时或过于具体', onChange: e => setReasonTarget({ ...reasonTarget, reason: e.target.value }) })),
          h('div', { className: 'kode-settings-footer' },
            h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setReasonTarget(null) }, '取消'),
            h(Button, { type: 'submit', variant: 'primary', disabled: busy }, '确认批量拒绝'))),

        !pending.length && !loadError && h('div', { className: 'kode-agent-row kode-memory-empty' },
          h('strong', null, '暂无待审批的记忆提议'),
          h('p', { className: 'kode-config-note' }, 'Agent 在对话中调用 memory_propose 后，提议会出现在这里；批准后即刻入库供所有会话检索，并全额返还消耗的能量。')),

        h('ul', { className: 'kode-agent-rows' },
          ...pending.map(item => {
            const isEditing = editingId === item.id
            const itemReason = reasonTarget?.id === item.id ? reasonTarget : null
            const itemMax = item.max_energy ?? maxEnergy
            return h('li', { key: item.id, className: 'kode-agent-row kode-memory-card' },
              h('div', { className: 'kode-memory-card-head' },
                pending.length > 1 && h('input', { type: 'checkbox', 'aria-label': `选择 ${item.title || item.id}`, checked: selectedIds.has(item.id), onChange: () => toggleSelect(item.id) }),
                h('span', { className: 'kode-agent-tag kode-memory-scope' }, item.scope),
                item.kind && h('span', { className: 'kode-agent-tag' }, MEMORY_KIND_LABELS[item.kind] ?? item.kind),
                h('strong', { className: 'kode-memory-title' }, item.title || item.id),
                h('span', { className: 'kode-memory-meta' },
                  `${item.author} · 能量 ${(item.author_energy ?? itemMax).toFixed(1)}/${itemMax.toFixed(0)} · 置信度 ${(item.confidence ?? 0.8).toFixed(2)}`,
                  item.created ? ` · ${formatMemoryTime(item.created)}` : '')),

              item.supersedes && h('p', { className: 'kode-config-note kode-memory-supersedes' }, `将替代旧记忆：${item.supersedes}`),

              !isEditing && h(React.Fragment, null,
                h('pre', { className: 'kode-memory-body' }, item.body),
                item.rationale && h('p', { className: 'kode-memory-rationale' }, h('strong', null, '理由：'), item.rationale),
                Array.isArray(item.tags) && item.tags.length > 0 && h('div', { className: 'kode-memory-tags' },
                  ...item.tags.map(tag => h('span', { key: tag, className: 'kode-agent-tag' }, `#${tag}`))),

                !itemReason && h('div', { className: 'kode-memory-actions' },
                  h(Button, { type: 'button', variant: 'primary', disabled: busy, onClick: () => void reviewOne(item, { kind: 'approve' }, '已批准并入库') }, '批准'),
                  h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => startEdit(item) }, '编辑后批准'),
                  h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setReasonTarget({ id: item.id, kind: 'reject', reason: '' }) }, '拒绝'),
                  h(Button, { type: 'button', variant: 'outline', className: 'kode-delete', disabled: busy, onClick: () => setReasonTarget({ id: item.id, kind: 'blacklist', reason: '' }) }, '拉黑')),

                itemReason && h('form', {
                  className: 'kode-memory-reason-form',
                  onSubmit: event => {
                    event.preventDefault()
                    const kind = itemReason.kind === 'blacklist' ? 'blacklist' : 'reject'
                    const defaultReason = kind === 'blacklist' ? '垃圾或无效记忆' : '不需要入库'
                    void reviewOne(item, { kind, reason: itemReason.reason.trim() || defaultReason }, kind === 'blacklist' ? '已拉黑并归档' : '已拒绝并归档')
                  },
                },
                  h('label', { className: 'kode-field' },
                    h('span', null, itemReason.kind === 'blacklist' ? '拉黑原因（将额外扣除 2.0 能量）' : '拒绝原因（将额外扣除 0.5 能量）'),
                    h('input', { type: 'text', autoFocus: true, value: itemReason.reason, placeholder: '可选，记录归档原因', onChange: e => setReasonTarget({ ...itemReason, reason: e.target.value }) })),
                  h('div', { className: 'kode-settings-footer' },
                    h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setReasonTarget(null) }, '取消'),
                    h(Button, { type: 'submit', variant: 'primary', disabled: busy }, itemReason.kind === 'blacklist' ? '确认拉黑' : '确认拒绝')))),

              isEditing && h('form', {
                className: 'kode-agent-editor kode-memory-editor',
                onSubmit: event => {
                  event.preventDefault()
                  const tags = editDraft.tags.split(',').map(s => s.trim()).filter(Boolean)
                  const parsedConfidence = Number.parseFloat(editDraft.confidence)
                  const confidence = Number.isFinite(parsedConfidence) ? Math.max(0, Math.min(1, parsedConfidence)) : undefined
                  void reviewOne(item, {
                    kind: 'edit_then_approve',
                    title: editDraft.title.trim() || null,
                    scope: editDraft.scope.trim() || null,
                    body: editDraft.body,
                    tags,
                    confidence,
                  }, '已编辑并批准入库')
                },
              },
                h('div', { className: 'kode-watch-grid' },
                  h('label', { className: 'kode-field' },
                    h('span', null, '标题'),
                    h('input', { type: 'text', value: editDraft.title, onChange: e => setEditDraft({ ...editDraft, title: e.target.value }) })),
                  h('label', { className: 'kode-field' },
                    h('span', null, '作用域（如 shared 或 project:name）'),
                    h('input', { type: 'text', required: true, value: editDraft.scope, onChange: e => setEditDraft({ ...editDraft, scope: e.target.value }) }))),
                h('label', { className: 'kode-field' },
                  h('span', null, '记忆正文'),
                  h('textarea', { rows: 5, required: true, value: editDraft.body, onChange: e => setEditDraft({ ...editDraft, body: e.target.value }) })),
                h('div', { className: 'kode-watch-grid' },
                  h('label', { className: 'kode-field' },
                    h('span', null, '标签（英文逗号分隔）'),
                    h('input', { type: 'text', value: editDraft.tags, placeholder: 'uart, deploy, gotcha', onChange: e => setEditDraft({ ...editDraft, tags: e.target.value }) })),
                  h('label', { className: 'kode-field' },
                    h('span', null, '置信度（0.0 ~ 1.0）'),
                    h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: editDraft.confidence, onChange: e => setEditDraft({ ...editDraft, confidence: e.target.value }) }))),
                h('div', { className: 'kode-settings-footer' },
                  h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setEditingId(null) }, '取消'),
                  h(Button, { type: 'submit', variant: 'primary', disabled: busy || !editDraft.body.trim() }, '保存并批准'))))
          }))),

      tab === 'facts' && h('div', { className: 'kode-memory-content' },
        h('form', {
          className: 'kode-memory-search-bar',
          onSubmit: event => { event.preventDefault(); void loadFacts(factsQuery, factsScope, host) },
        },
          h('input', { type: 'search', value: factsQuery, placeholder: '搜索已入库记忆（关键词、模块、规范…）', onChange: e => setFactsQuery(e.target.value) }),
          h('select', { 'aria-label': '按作用域筛选', value: factsScope, onChange: e => { setFactsScope(e.target.value); void loadFacts(factsQuery, e.target.value, host) } },
            h('option', { value: '' }, '全部作用域'),
            ...(factsData?.scopes ?? []).map(scope => h('option', { key: scope, value: scope }, scope))),
          h(Button, { type: 'submit', variant: 'outline', disabled: factsLoading }, factsLoading ? '搜索中…' : '搜索')),

        h(Failure, { text: factsError }),
        !factsLoading && !(factsData?.facts?.length) && h('div', { className: 'kode-agent-row kode-memory-empty' },
          h('strong', null, factsQuery.trim() ? '没有匹配的记忆' : '记忆库还是空的'),
          h('p', { className: 'kode-config-note' }, '批准待审批提议后，记忆会出现在这里并可供所有 Agent 搜索。')),

        h('ul', { className: 'kode-agent-rows' },
          ...(factsData?.facts ?? []).map(fact => {
            const depTarget = reasonTarget?.id === fact.id && reasonTarget?.kind === 'deprecate' ? reasonTarget : null
            return h('li', { key: fact.id, className: 'kode-agent-row kode-memory-card' },
              h('div', { className: 'kode-memory-card-head' },
                h('span', { className: 'kode-agent-tag kode-memory-scope' }, fact.scope),
                fact.kind && h('span', { className: 'kode-agent-tag' }, MEMORY_KIND_LABELS[fact.kind] ?? fact.kind),
                h('strong', { className: 'kode-memory-title' }, fact.title || fact.id),
                h('span', { className: 'kode-memory-meta' },
                  `${fact.author ?? 'unknown'} · 命中 ${fact.recall_count ?? 0} 次`,
                  fact.created ? ` · ${formatMemoryTime(fact.created)}` : '')),
              h('pre', { className: 'kode-memory-body' }, fact.snippet || fact.body || ''),
              Array.isArray(fact.tags) && fact.tags.length > 0 && h('div', { className: 'kode-memory-tags' },
                ...fact.tags.map(tag => h('span', { key: tag, className: 'kode-agent-tag' }, `#${tag}`))),
              !depTarget && h('div', { className: 'kode-memory-actions' },
                h(Button, { type: 'button', variant: 'outline', className: 'kode-delete', disabled: busy, onClick: () => setReasonTarget({ id: fact.id, kind: 'deprecate', reason: '' }) }, '废弃')),
              depTarget && h('form', {
                className: 'kode-memory-reason-form',
                onSubmit: event => { event.preventDefault(); void deprecateFact(fact.id, depTarget.reason.trim()) },
              },
                h('label', { className: 'kode-field' },
                  h('span', null, '废弃原因（软删除，不再参与检索）'),
                  h('input', { type: 'text', autoFocus: true, value: depTarget.reason, placeholder: '例如：已过时或被新规则替代', onChange: e => setReasonTarget({ ...depTarget, reason: e.target.value }) })),
                h('div', { className: 'kode-settings-footer' },
                  h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setReasonTarget(null) }, '取消'),
                  h(Button, { type: 'submit', variant: 'primary', disabled: busy }, '确认废弃'))))
          }))))))
  }
