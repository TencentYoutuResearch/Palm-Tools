  // VS Code Source Control + Kode GUI Git Graph right-sidebar plugin for DSH.
  const GIT_TAB_ID = 'kode-git-changes'
  const GIT_STATUS_LABELS = { M: '已修改', A: '新增', D: '已删除', R: '重命名', C: '复制', U: '未跟踪' }
  const GIT_SCOPE_LABELS = { staged: '暂存区', unstaged: '工作区', untracked: '未跟踪', commit: '提交' }
  const GRAPH_LANE_STEP = 16
  const GRAPH_LANE_INSET = 11
  const GRAPH_ROW_HEIGHT = 52
  const COMMIT_PAGE_SIZE = 40

  function GuideArtworkGit({ size = 20 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
      h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 6, fill: 'rgba(249, 115, 22, 0.16)' }),
      h('circle', { cx: 8.5, cy: 7.5, r: 2, stroke: '#f97316', strokeWidth: 1.8 }),
      h('circle', { cx: 15.5, cy: 10, r: 2, stroke: '#f97316', strokeWidth: 1.8 }),
      h('circle', { cx: 8.5, cy: 16.5, r: 2, stroke: '#f97316', strokeWidth: 1.8 }),
      h('path', { d: 'M8.5 9.5v5M15.5 12c0 2.2-1.8 3.2-4.2 3.6L10.4 16', stroke: '#f97316', strokeWidth: 1.8, strokeLinecap: 'round' }))
  }

  /** Lay out the visible Git DAG from newest to oldest without inventing edges (matches Kode GUI). */
  function layoutGitGraph(commits) {
    const rows = []
    let lanes = []
    let nextColor = 0
    let maxColumns = 1
    for (const commit of commits) {
      const top = lanes.slice()
      let lane = lanes.findIndex(item => item.hash === commit.hash)
      if (lane < 0) {
        lane = lanes.length
        lanes.push({ hash: commit.hash, color: nextColor++ })
      }
      const node = lanes[lane]
      const after = lanes.filter(item => item.hash !== commit.hash)
      const parents = [...new Set(commit.parents ?? [])]
      const insertAt = Math.min(lane, after.length)
      parents.forEach((hash, index) => {
        if (after.some(item => item.hash === hash)) return
        after.splice(insertAt + index, 0, {
          hash,
          color: index === 0 ? node.color : nextColor++,
        })
      })
      const segments = []
      for (const item of top) {
        const to = item.hash === commit.hash ? lane : after.findIndex(other => other.hash === item.hash)
        if (to >= 0) segments.push({ from: top.indexOf(item), to, color: item.color, kind: 'through' })
      }
      for (const hash of parents) {
        const to = after.findIndex(item => item.hash === hash)
        if (to >= 0) segments.push({ from: lane, to, color: node.color, kind: 'parent' })
      }
      rows.push({
        hash: commit.hash,
        lane,
        color: node.color,
        top: top.map(item => item.color),
        bottom: after.map(item => item.color),
        segments,
        width: Math.max(top.length, lanes.length, after.length),
      })
      maxColumns = Math.max(maxColumns, top.length, lanes.length, after.length)
      lanes = after
    }
    return rows.map(row => ({ ...row, width: maxColumns }))
  }

  function graphPath(segment) {
    const x1 = GRAPH_LANE_INSET + segment.from * GRAPH_LANE_STEP
    const x2 = GRAPH_LANE_INSET + segment.to * GRAPH_LANE_STEP
    if (segment.kind === 'through') return `M ${x1} 0 L ${x1} 26`
    return x1 === x2
      ? `M ${x1} 26 L ${x2} ${GRAPH_ROW_HEIGHT}`
      : `M ${x1} 26 C ${x1} 40, ${x2} 38, ${x2} ${GRAPH_ROW_HEIGHT}`
  }

  function graphContinuationPath(row, column) {
    const color = row.bottom[column]
    if (color == null) return null
    const source = row.top.findIndex(item => item === color)
    if (source < 0) return null
    if (source === row.lane && row.top[source] === row.color) return null
    const x1 = GRAPH_LANE_INSET + source * GRAPH_LANE_STEP
    const x2 = GRAPH_LANE_INSET + column * GRAPH_LANE_STEP
    return x1 === x2
      ? `M ${x1} 26 L ${x2} ${GRAPH_ROW_HEIGHT}`
      : `M ${x1} 26 C ${x1} 40, ${x2} 38, ${x2} ${GRAPH_ROW_HEIGHT}`
  }

  function decorationClass(label) {
    if (label === 'HEAD') return 'is-head'
    if (label.startsWith('tag: ')) return 'is-tag'
    if (label.includes('/')) return 'is-remote'
    return 'is-branch'
  }

  function GraphRail({ graph, merge = false, working = false }) {
    const width = graph.width * GRAPH_LANE_STEP + 6
    return h('span', { className: 'kode-git-rail', style: { width: `${width}px` } },
      h('svg', {
        className: 'kode-git-svg',
        width,
        height: GRAPH_ROW_HEIGHT,
        viewBox: `0 0 ${width} ${GRAPH_ROW_HEIGHT}`,
        preserveAspectRatio: 'none',
        'aria-hidden': true,
      },
        ...graph.segments.map((segment, index) => h('path', {
          key: `s:${index}`,
          d: graphPath(segment),
          className: `kode-git-line kode-git-lane-${segment.color % 6}`,
        })),
        ...graph.bottom.map((color, column) => {
          const d = graphContinuationPath(graph, column)
          return d ? h('path', { key: `c:${column}`, d, className: `kode-git-line kode-git-lane-${color % 6}` }) : null
        })),
      h('span', {
        className: `kode-git-node kode-git-lane-${graph.color % 6}${merge ? ' is-merge' : ''}${working ? ' is-working' : ''}`,
        style: { left: `${GRAPH_LANE_INSET + graph.lane * GRAPH_LANE_STEP}px` },
      }))
  }

  function ExpandedRail({ graph }) {
    const width = graph.width * GRAPH_LANE_STEP + 6
    return h('div', { className: 'kode-git-expanded-rail', style: { width: `${width}px` }, 'aria-hidden': true },
      ...graph.bottom.map((color, column) => h('span', {
        key: column,
        className: `kode-git-expanded-line kode-git-lane-${color % 6}`,
        style: { left: `${GRAPH_LANE_INSET + column * GRAPH_LANE_STEP}px` },
      })))
  }

  /** Build a VS Code-style compact directory tree from relative file items. */
  function buildGitTree(items) {
    const root = { kind: 'dir', name: '', path: '', dirs: new Map(), files: [] }
    for (const item of items) {
      const parts = String(item.path ?? '').split('/').filter(Boolean)
      const fileName = parts.pop() ?? item.path
      let node = root
      let prefix = ''
      for (const segment of parts) {
        prefix = prefix ? `${prefix}/${segment}` : segment
        let child = node.dirs.get(segment)
        if (!child) {
          child = { kind: 'dir', name: segment, path: prefix, dirs: new Map(), files: [] }
          node.dirs.set(segment, child)
        }
        node = child
      }
      node.files.push({ kind: 'file', name: fileName, item })
    }
    const finalize = node => {
      const dirs = [...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(dir => {
          let curr = dir
          let label = dir.name
          while (curr.files.length === 0 && curr.dirs.size === 1) {
            const [only] = curr.dirs.values()
            label = `${label}/${only.name}`
            curr = only
          }
          return { kind: 'dir', name: label, path: curr.path, children: finalize(curr) }
        })
      const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name))
      return [...dirs, ...files]
    }
    return finalize(root)
  }

  function GitTabTitle() {
    return h(React.Fragment, null,
      h(IconBranchOutlineRegular, { size: 14, className: 'kode-git-tab-icon', 'aria-hidden': true }),
      'Git 变更')
  }

  function GitDiffView({ selection, diffState, busy, onAction, onClose }) {
    if (!selection) return null
    const lines = (diffState?.data?.diff ?? '').split('\n')
    const hasDiff = Boolean(diffState?.data?.diff)
    const label = selection.commit
      ? (selection.path ? `${selection.shortHash} · ${selection.path}` : `${selection.shortHash} · ${selection.subject}`)
      : selection.path
    return h('section', { className: 'kode-git-diff', 'aria-label': '差异预览' },
      h('header', { className: 'kode-git-diff-head' },
        h('span', { className: `kode-git-scope-pill is-${selection.scope}` }, GIT_SCOPE_LABELS[selection.scope] ?? selection.scope),
        h('span', { className: 'kode-git-diff-path', title: label }, label),
        selection.scope === 'staged' && h('button', {
          type: 'button', className: 'kode-git-mini-btn', title: '取消暂存', disabled: busy,
          onClick: () => void onAction({ action: 'unstage', path: selection.path }),
        }, '−'),
        (selection.scope === 'unstaged' || selection.scope === 'untracked') && h('button', {
          type: 'button', className: 'kode-git-mini-btn', title: '暂存更改', disabled: busy,
          onClick: () => void onAction({ action: 'stage', path: selection.path }),
        }, '+'),
        h('button', { type: 'button', className: 'kode-git-mini-btn', title: '关闭差异视图', onClick: onClose }, '×')),
      h('div', { className: 'kode-git-diff-body' },
        diffState?.loading && h('p', { className: 'kode-secondary kode-git-empty' }, '正在加载 Diff…'),
        diffState?.error && h(Failure, { text: diffState.error }),
        !diffState?.loading && !diffState?.error && diffState?.data?.binary && h('p', { className: 'kode-secondary kode-git-empty' }, '二进制文件，无法以文本方式展示差异。'),
        !diffState?.loading && !diffState?.error && !diffState?.data?.binary && !hasDiff && h('p', { className: 'kode-secondary kode-git-empty' }, '暂无可显示的文本差异。'),
        !diffState?.loading && !diffState?.error && hasDiff && h('pre', { className: 'kode-git-diff-pre' },
          ...lines.map((line, index) => {
            const cls = line.startsWith('@@') ? 'is-hunk'
              : line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ') ? 'is-meta'
              : line.startsWith('+') ? 'is-add'
              : line.startsWith('-') ? 'is-del'
              : ''
            return h('span', { key: index, className: `kode-git-diff-line${cls ? ` ${cls}` : ''}` }, `${line}\n`)
          })),
        diffState?.data?.truncated && h('p', { className: 'kode-secondary kode-git-empty' }, '差异内容超过 256 KB，已截断显示。')))
  }

  function GitTreeSection({ title, scope, items, viewMode, selectedKey, collapsedDirs, onToggleDir, onSelect, onAction, busy, headerAction }) {
    const [open, setOpen] = useState(true)
    const tree = useMemo(() => (viewMode === 'tree' ? buildGitTree(items) : null), [items, viewMode])

    const renderFileRow = (item, displayName, depth) => {
      const key = `${item.scope}:${item.path}`
      const active = selectedKey === key
      const dirPart = viewMode === 'list' && item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''
      const badge = item.status || 'M'
      return h('div', {
        key,
        className: `kode-git-row is-file${active ? ' is-selected' : ''}`,
        style: { '--kode-git-depth': depth },
        role: 'treeitem',
        'aria-selected': active,
      },
        h('button', {
          type: 'button',
          className: 'kode-git-row-main',
          title: `${item.path}（${GIT_STATUS_LABELS[badge] ?? badge}）`,
          onClick: () => onSelect({ scope: item.scope, path: item.path }),
        },
          h('span', { className: 'kode-git-file-name' }, displayName),
          dirPart && h('span', { className: 'kode-git-file-dir' }, dirPart)),
        (item.added > 0 || item.removed > 0) && h('span', { className: 'kode-git-stat' },
          item.added > 0 && h('span', { className: 'is-add' }, `+${item.added}`),
          item.removed > 0 && h('span', { className: 'is-del' }, `-${item.removed}`)),
        h('span', { className: 'kode-git-row-actions' },
          item.scope === 'staged'
            ? h('button', {
                type: 'button', className: 'kode-git-mini-btn', title: '取消暂存', disabled: busy,
                onClick: event => { event.stopPropagation(); void onAction({ action: 'unstage', path: item.path }) },
              }, '−')
            : h(React.Fragment, null,
                h('button', {
                  type: 'button', className: 'kode-git-mini-btn', title: '暂存更改', disabled: busy,
                  onClick: event => { event.stopPropagation(); void onAction({ action: 'stage', path: item.path }) },
                }, '+'),
                h('button', {
                  type: 'button', className: 'kode-git-mini-btn is-danger', title: item.scope === 'untracked' ? '删除未跟踪文件' : '放弃更改', disabled: busy,
                  onClick: event => {
                    event.stopPropagation()
                    const msg = item.scope === 'untracked' ? `确定删除未跟踪文件「${item.path}」？此操作无法撤销。` : `确定放弃「${item.path}」的未暂存修改？此操作无法撤销。`
                    if (confirm(msg)) void onAction({ action: 'discard', path: item.path, scope: item.scope })
                  },
                }, '↩'))),
        h('span', { className: `kode-git-badge is-${badge}`, title: GIT_STATUS_LABELS[badge] ?? badge }, badge))
    }

    const renderNodes = (nodes, depth = 0) => nodes.flatMap(node => {
      if (node.kind === 'file') return [renderFileRow(node.item, node.name, depth)]
      const dirKey = `${scope}:${node.path}`
      const collapsed = collapsedDirs.has(dirKey)
      return [
        h('button', {
          key: `dir:${dirKey}`,
          type: 'button',
          className: 'kode-git-row is-dir',
          style: { '--kode-git-depth': depth },
          'aria-expanded': !collapsed,
          onClick: () => onToggleDir(dirKey),
        },
          h(collapsed ? IconChevronRightOutlineRegular : IconChevronDownOutlineRegular, { size: 12, 'aria-hidden': true }),
          h(IconFolderCloseRegular, { size: 13, className: 'kode-git-folder-icon', 'aria-hidden': true }),
          h('span', { className: 'kode-git-dir-name', title: node.path }, node.name)),
        ...(!collapsed ? renderNodes(node.children, depth + 1) : []),
      ]
    })

    return h('section', { className: 'kode-git-section' },
      h('div', { className: 'kode-git-section-head' },
        h('button', { type: 'button', className: 'kode-git-section-toggle', 'aria-expanded': open, onClick: () => setOpen(v => !v) },
          h(open ? IconChevronDownOutlineRegular : IconChevronRightOutlineRegular, { size: 12, 'aria-hidden': true }),
          h('span', null, title),
          h('span', { className: 'kode-git-count' }, items.length)),
        headerAction),
      open && (items.length > 0
        ? h('div', { className: 'kode-git-tree', role: 'tree' },
            ...(viewMode === 'tree' ? renderNodes(tree, 0) : items.map(item => renderFileRow(item, item.path.split('/').pop() ?? item.path, 0))))
        : h('p', { className: 'kode-secondary kode-git-empty' }, scope === 'staged' ? '暂无已暂存的文件' : '工作区很干净，暂无未暂存变更')))
  }

  function GitChangesSidebar({ sessionId, sessions }) {
    const host = useSyncExternalStore(
      useCallback(listener => transport?.subscribe(listener) ?? (() => {}), []),
      useCallback(() => transport?.current ?? 'local', []))
    const [status, setStatus] = useState(null)
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [moreError, setMoreError] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [query, setQuery] = useState('')
    const [panelTab, setPanelTab] = useState('graph') // 'graph' (Kode GUI DAG + working tree) | 'tree' (VS Code changes only)
    const [viewMode, setViewMode] = useState('tree')  // 'tree' | 'list' inside working tree
    const [collapsedDirs, setCollapsedDirs] = useState(() => new Set())
    const [expandedKey, setExpandedKey] = useState('working')
    const [commitDetails, setCommitDetails] = useState({})
    const [loadingDetail, setLoadingDetail] = useState(null)
    const [selection, setSelection] = useState(null)
    const [diffState, setDiffState] = useState(null)
    const commitLimitRef = useRef(COMMIT_PAGE_SIZE)
    const requestSeqRef = useRef(0)
    const alive = useRef(true)

    const refresh = useCallback(async ({ silent = false, limit } = {}) => {
      if (!sessionId) return
      const seq = ++requestSeqRef.current
      const requestedLimit = limit ?? commitLimitRef.current
      if (!silent) setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ sessionId, commitLimit: String(requestedLimit) })
        const res = await fetchHost(`/api/kode/git-changes?${params}`, {
          credentials: 'same-origin', cache: 'no-store',
        }, host)
        const value = await parseHostJson(res)
        if (!res.ok) throw new Error(value.error ?? '读取 Git 状态失败')
        if (alive.current && seq === requestSeqRef.current) setStatus(value)
      } catch (failure) {
        if (alive.current && seq === requestSeqRef.current) setError(failure.message)
      } finally {
        if (alive.current && seq === requestSeqRef.current) setLoading(false)
      }
    }, [sessionId, host])

    const loadMoreCommits = useCallback(async () => {
      if (!sessionId || loadingMore || loading) return
      const seq = ++requestSeqRef.current
      const nextLimit = commitLimitRef.current + COMMIT_PAGE_SIZE
      setLoadingMore(true)
      setMoreError('')
      try {
        const params = new URLSearchParams({ sessionId, commitLimit: String(nextLimit) })
        const res = await fetchHost(`/api/kode/git-changes?${params}`, {
          credentials: 'same-origin', cache: 'no-store',
        }, host)
        const value = await parseHostJson(res)
        if (!res.ok) throw new Error(value.error ?? '加载更多提交失败')
        if (alive.current && seq === requestSeqRef.current) {
          commitLimitRef.current = nextLimit
          setStatus(value)
        }
      } catch (failure) {
        if (alive.current && seq === requestSeqRef.current) setMoreError(failure.message)
      } finally {
        if (alive.current && seq === requestSeqRef.current) setLoadingMore(false)
      }
    }, [sessionId, host, loadingMore, loading])

    useEffect(() => {
      alive.current = true
      commitLimitRef.current = COMMIT_PAGE_SIZE
      setLoadingMore(false); setMoreError('')
      setSelection(null); setDiffState(null); setCommitDetails({}); setExpandedKey('working')
      void refresh({ limit: COMMIT_PAGE_SIZE })
      const onFocus = () => { if (document.visibilityState !== 'hidden') void refresh({ silent: true }) }
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onFocus)
      const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh({ silent: true }) }, 12_000)
      return () => {
        alive.current = false
        clearInterval(timer)
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onFocus)
      }
    }, [refresh])

    useEffect(() => {
      if (!sessions?.subscribe || !sessionId) return
      let wasRunning = false
      return sessions.subscribe(() => {
        const nowRunning = Boolean(sessions.getSnapshot?.()?.byId?.[sessionId]?.running)
        if (wasRunning && !nowRunning) void refresh({ silent: true })
        wasRunning = nowRunning
      })
    }, [sessions, sessionId, refresh])

    useEffect(() => {
      if (!selection || !sessionId) { setDiffState(null); return }
      let cancelled = false
      setDiffState({ loading: true, data: null, error: '' })
      const params = new URLSearchParams({ sessionId, diff: '1', scope: selection.scope })
      if (selection.commit) params.set('commit', selection.commit)
      if (selection.path) params.set('path', selection.path)
      fetchHost(`/api/kode/git-changes?${params}`, { credentials: 'same-origin', cache: 'no-store' }, host)
        .then(async res => {
          const value = await parseHostJson(res)
          if (!res.ok) throw new Error(value.error ?? '无法加载差异')
          if (!cancelled) setDiffState({ loading: false, data: value, error: '' })
        })
        .catch(failure => {
          if (!cancelled) setDiffState({ loading: false, data: null, error: failure.message })
        })
      return () => { cancelled = true }
    }, [selection, status, sessionId, host])

    const toggleCommit = async commit => {
      const key = `commit:${commit.hash}`
      if (expandedKey === key) { setExpandedKey(null); return }
      setExpandedKey(key)
      if (commitDetails[commit.hash]) return
      setLoadingDetail(commit.hash)
      try {
        const params = new URLSearchParams({ sessionId, commitDetail: commit.hash })
        const res = await fetchHost(`/api/kode/git-changes?${params}`, { credentials: 'same-origin', cache: 'no-store' }, host)
        const value = await parseHostJson(res)
        if (!res.ok) throw new Error(value.error ?? '无法读取提交详情')
        if (alive.current) setCommitDetails(prev => ({ ...prev, [commit.hash]: value }))
      } catch (failure) {
        if (alive.current) setCommitDetails(prev => ({ ...prev, [commit.hash]: { error: failure.message, files: [] } }))
      } finally {
        if (alive.current) setLoadingDetail(curr => curr === commit.hash ? null : curr)
      }
    }

    const act = async body => {
      setBusy(true); setError('')
      try {
        const res = await fetchHost('/api/kode/git-changes', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, commitLimit: commitLimitRef.current, ...body }),
        }, host)
        const value = await parseHostJson(res)
        if (!res.ok) throw new Error(value.error ?? 'Git 操作失败')
        if (alive.current) {
          setStatus(value)
          if (selection && !selection.commit) {
            const exists = [...(value.staged ?? []), ...(value.unstaged ?? []), ...(value.untracked ?? [])]
              .some(item => item.path === selection.path && item.scope === selection.scope)
            if (!exists) setSelection(null)
          }
        }
      } catch (failure) {
        if (alive.current) setError(failure.message)
      } finally {
        if (alive.current) setBusy(false)
      }
    }

    const toggleDir = key => setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

    const needle = query.trim().toLowerCase()
    const matchFile = item => !needle || item.path.toLowerCase().includes(needle)
    const matchCommit = row => !needle
      || row.subject.toLowerCase().includes(needle)
      || row.shortHash.toLowerCase().includes(needle)
      || row.author.toLowerCase().includes(needle)
      || (row.decorations ?? []).some(label => label.toLowerCase().includes(needle))
    const staged = (status?.staged ?? []).filter(matchFile)
    const changes = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])].filter(matchFile)
    const allCommits = status?.commits ?? []
    const commits = allCommits.filter(matchCommit)
    const totalCount = (status?.staged?.length ?? 0) + (status?.unstaged?.length ?? 0) + (status?.untracked?.length ?? 0)
    const visibleDirtyCount = staged.length + changes.length
    const git = status?.git
    const selectedKey = selection
      ? (selection.commit
          ? (selection.path ? `commit-file:${selection.commit}:${selection.path}` : `commit:${selection.commit}`)
          : `${selection.scope}:${selection.path}`)
      : ''

    const showWorkingTree = totalCount > 0 && visibleDirtyCount > 0
    const headCommit = allCommits.find(row => row.decorations?.includes('HEAD')) ?? allCommits[0]
    const graphRows = useMemo(() => layoutGitGraph(showWorkingTree
      ? [{ hash: 'working-tree', parents: headCommit ? [headCommit.hash] : [] }, ...commits]
      : commits), [showWorkingTree, headCommit?.hash, commits])

    const workingSections = h(React.Fragment, null,
      staged.length > 0 && h(GitTreeSection, {
        title: '暂存的更改',
        scope: 'staged',
        items: staged,
        viewMode,
        selectedKey,
        collapsedDirs,
        onToggleDir: toggleDir,
        onSelect: setSelection,
        onAction: act,
        busy,
        headerAction: h('button', {
          type: 'button', className: 'kode-git-mini-btn', title: '全部取消暂存', disabled: busy,
          onClick: () => void act({ action: 'unstage', all: true }),
        }, '−'),
      }),
      h(GitTreeSection, {
        title: '更改',
        scope: 'changes',
        items: changes,
        viewMode,
        selectedKey,
        collapsedDirs,
        onToggleDir: toggleDir,
        onSelect: setSelection,
        onAction: act,
        busy,
        headerAction: changes.length > 0 && h('button', {
          type: 'button', className: 'kode-git-mini-btn', title: '全部暂存', disabled: busy,
          onClick: () => void act({ action: 'stage', all: true }),
        }, '+'),
      }))

    if (!sessionId) return h('div', { className: 'kode-git-pane' }, h('p', { className: 'kode-secondary kode-git-empty' }, '请先打开一个会话。'))

    return h('div', { className: 'kode-git-pane' },
      h('header', { className: 'kode-git-header' },
        h('div', { className: 'kode-git-branch-row' },
          h(IconBranchOutlineRegular, { size: 14, 'aria-hidden': true }),
          h('strong', { className: 'kode-git-branch-name', title: git?.root ?? status?.cwd ?? '' },
            git ? (git.branch || (git.commit ? `HEAD · ${git.commit.slice(0, 7)}` : '无提交')) : '非 Git 仓库'),
          git?.kind === 'worktree' && h('span', { className: 'kode-git-pill' }, 'worktree'),
          git && (git.ahead > 0 || git.behind > 0) && h('span', { className: 'kode-git-pill' },
            `${git.ahead ? `↑${git.ahead}` : ''}${git.ahead && git.behind ? ' ' : ''}${git.behind ? `↓${git.behind}` : ''}`),
          h('div', { className: 'kode-git-header-actions' },
            h('div', { className: 'kode-git-mode-tabs', role: 'tablist', 'aria-label': '视图模式' },
              h('button', {
                type: 'button', role: 'tab', 'aria-selected': panelTab === 'graph',
                className: `kode-git-mode-tab${panelTab === 'graph' ? ' is-active' : ''}`,
                onClick: () => setPanelTab('graph'),
              }, 'Graph'),
              h('button', {
                type: 'button', role: 'tab', 'aria-selected': panelTab === 'tree',
                className: `kode-git-mode-tab${panelTab === 'tree' ? ' is-active' : ''}`,
                onClick: () => setPanelTab('tree'),
              }, '变更树')),
            h('button', {
              type: 'button',
              className: 'kode-git-mini-btn',
              title: viewMode === 'tree' ? '文件显示：目录树（点击切为列表）' : '文件显示：平铺列表（点击切为目录树）',
              onClick: () => setViewMode(mode => mode === 'tree' ? 'list' : 'tree'),
            }, viewMode === 'tree' ? '树' : '列'),
            h('button', {
              type: 'button',
              className: 'kode-git-mini-btn',
              title: '刷新 Git 状态',
              disabled: loading || busy,
              onClick: () => void refresh(),
            }, loading ? '…' : '↻'))),
        git && h('div', { className: 'kode-git-search' },
          h(IconSearchOutlineRegular, { size: 13, 'aria-hidden': true }),
          h('input', {
            type: 'search',
            placeholder: panelTab === 'graph' ? '筛选文件、提交信息、分支或哈希…' : `筛选 ${totalCount} 个变更文件…`,
            value: query,
            onChange: event => setQuery(event.target.value),
          }))),
      h(Failure, { text: error }),
      !git && !loading && !error && h('p', { className: 'kode-secondary kode-git-empty' }, '当前会话的工作区不是 Git 仓库。'),
      git && h('div', { className: `kode-git-body${selection ? ' has-diff' : ''}` },
        h('div', { className: 'kode-git-lists' },
          panelTab === 'tree'
            ? workingSections
            : h('div', { className: 'kode-git-graph', 'aria-label': 'Git Graph' },
                showWorkingTree && graphRows[0] && h('div', { className: 'kode-git-graph-block' },
                  h('button', {
                    type: 'button',
                    className: `kode-git-graph-row is-working${expandedKey === 'working' ? ' is-selected' : ''}`,
                    'aria-expanded': expandedKey === 'working',
                    onClick: () => setExpandedKey(prev => prev === 'working' ? null : 'working'),
                  },
                    h(GraphRail, { graph: graphRows[0], working: true }),
                    h('span', { className: 'kode-git-graph-content kode-git-working-card' },
                      h('span', { className: 'kode-git-graph-main' },
                        h('strong', null, 'Working tree'),
                        h('span', { className: 'kode-git-count' }, `${totalCount} 处变更`)),
                      h('span', { className: 'kode-git-graph-meta' }, `${git.branch ?? '游离 HEAD'} · 未提交改动`))),
                  expandedKey === 'working' && h('div', { className: 'kode-git-expansion' },
                    h(ExpandedRail, { graph: graphRows[0] }),
                    h('div', { className: 'kode-git-expanded' }, workingSections))),
                commits.length === 0
                  ? h('p', { className: 'kode-secondary kode-git-empty' }, '暂无匹配的提交记录')
                  : commits.map((commit, index) => {
                      const graph = graphRows[index + (showWorkingTree ? 1 : 0)]
                      const isExpanded = expandedKey === `commit:${commit.hash}`
                      const isMerge = (commit.parents?.length ?? 0) > 1
                      const detail = commitDetails[commit.hash]
                      return h('div', { key: commit.hash, className: 'kode-git-graph-block' },
                        h('button', {
                          type: 'button',
                          className: `kode-git-graph-row${isExpanded || selectedKey === `commit:${commit.hash}` ? ' is-selected' : ''}`,
                          'aria-expanded': isExpanded,
                          title: `${commit.hash} ${commit.subject}`,
                          onClick: () => void toggleCommit(commit),
                        },
                          graph && h(GraphRail, { graph, merge: isMerge }),
                          h('span', { className: 'kode-git-graph-content' },
                            h('span', { className: 'kode-git-graph-main' },
                              h('strong', null, commit.subject || '(无提交说明)')),
                            commit.decorations?.length > 0 && h('span', { className: 'kode-git-ref-chips' },
                              ...commit.decorations.map(label => h('span', {
                                key: label,
                                className: `kode-git-ref-chip ${decorationClass(label)}`,
                              }, label))),
                            h('span', { className: 'kode-git-graph-meta' },
                              h('span', { className: 'kode-git-commit-hash' }, commit.shortHash),
                              ` · ${commit.author} · ${commit.relativeTime}${isMerge ? ' · merge' : ''}`))),
                        isExpanded && graph && h('div', { className: 'kode-git-expansion' },
                          h(ExpandedRail, { graph }),
                          h('div', { className: 'kode-git-expanded kode-git-commit-detail' },
                            loadingDetail === commit.hash && h('p', { className: 'kode-secondary kode-git-empty' }, '正在读取提交文件…'),
                            detail?.error && h(Failure, { text: detail.error }),
                            detail && !detail.error && h(React.Fragment, null,
                              detail.message && detail.message.trim() !== commit.subject.trim() && h('pre', { className: 'kode-git-commit-msg' }, detail.message),
                              h('div', { className: 'kode-git-commit-bar' },
                                h('span', { className: 'kode-secondary' }, `改动 ${detail.files?.length ?? 0} 个文件`),
                                h('button', {
                                  type: 'button', className: 'kode-git-mini-btn',
                                  onClick: () => setSelection({ scope: 'commit', commit: commit.hash, shortHash: commit.shortHash, subject: commit.subject }),
                                }, '完整 Patch')),
                              detail.files?.length > 0 && h('div', { className: 'kode-git-commit-files' },
                                ...detail.files.map(file => {
                                  const fileKey = `commit-file:${commit.hash}:${file.path}`
                                  const dirPart = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
                                  const base = file.path.split('/').pop() ?? file.path
                                  return h('button', {
                                    key: fileKey,
                                    type: 'button',
                                    className: `kode-git-row is-file kode-git-commit-file${selectedKey === fileKey ? ' is-selected' : ''}`,
                                    title: file.path,
                                    onClick: () => setSelection({ scope: 'commit', commit: commit.hash, shortHash: commit.shortHash, subject: commit.subject, path: file.path }),
                                  },
                                    h('span', { className: `kode-git-badge is-${file.status}` }, file.status),
                                    h('span', { className: 'kode-git-file-name' }, base),
                                    dirPart && h('span', { className: 'kode-git-file-dir' }, dirPart),
                                    (file.added > 0 || file.removed > 0) && h('span', { className: 'kode-git-stat' },
                                      file.added > 0 && h('span', { className: 'is-add' }, `+${file.added}`),
                                      file.removed > 0 && h('span', { className: 'is-del' }, `-${file.removed}`)))
                                }))))))
                    }),
                status?.hasMoreCommits && h('button', {
                  type: 'button',
                  className: 'kode-git-more-btn',
                  disabled: loadingMore || loading || busy,
                  'aria-busy': loadingMore,
                  onClick: () => void loadMoreCommits(),
                }, loadingMore ? '正在加载更多提交…' : 'More · 查看更多历史提交'),
                moreError && h('p', { className: 'kode-git-more-error', role: 'alert' }, moreError))),
        h(GitDiffView, { selection, diffState, busy, onAction: act, onClose: () => setSelection(null) })))
  }

  function installGitChangesSidebar(ctx) {
    ctx.inject(['sidebarRightTabs'], scope => {
      if (!scope.sidebarRightTabs) return
      scope.effect(() => scope.sidebarRightTabs.register({
        id: GIT_TAB_ID,
        kind: GIT_TAB_ID,
        multiple: false,
        priority: 'builtin',
        title: () => 'Git 变更',
        guide: [{
          id: 'open',
          commandId: 'kode.gitChanges.open',
          order: 25,
          title: () => 'Git 变更',
          description: () => '查看工作区 Git Graph、变更树、Diff 与暂存区',
          icon: GuideArtworkGit,
        }],
      }), 'kode-git-changes-tab')
      scope.inject?.(['sidebarRight', 'shortcuts'], sc => {
        if (!sc.shortcuts || !sc.sidebarRight) return
        sc.effect(() => sc.shortcuts.register({
          id: 'kode.gitChanges.open',
          label: () => 'Git 变更',
          aliases: ['git', 'git graph', 'git changes', 'source control', '变更'],
          defaults: {
            'desktop:macos': { code: 'KeyG', modifiers: ['primary', 'shift'] },
            'desktop:windows': { code: 'KeyG', modifiers: ['primary', 'shift'] },
            'desktop:linux': { code: 'KeyG', modifiers: ['primary', 'shift'] },
          },
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve: ({ target: element }) => {
            const target = sc.sidebarRight.commandTarget?.(element)
            if (target === undefined) return { status: 'blocked', reason: '请先打开一个会话' }
            return {
              status: 'handled',
              run: () => { sc.sidebarRight.openTabFromTarget(GIT_TAB_ID, target) },
            }
          },
        }), 'kode-git-changes-shortcut')
      })
    })
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: GIT_TAB_ID,
      inject: sessionId => ({ sessionId, sessions: ctx.sessions }),
    }, GitChangesSidebar))
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: GIT_TAB_ID,
    }, GitTabTitle))
  }
