  const kodeRelayPattern = /* @relayPattern */ null
  function parseRelay(data) {
    if (data.source?.kind !== 'agent-message' || !data.source.senderSessionId?.startsWith('kode:')) return undefined
    const raw = textContent(data.content)
    const match = kodeRelayPattern.exec(raw)
    if (!match || ((match[5] || match[6]) && match[1] !== (match[5] || match[6])) || data.source.senderSessionId !== `kode:${match[2].replace('/', ':')}`) return undefined
    return { id: match[1], address: match[2], replyTo: match[3], ...relayTitlePrefix(match[4]) }
  }
  // Optional `[Kode message title: "<JSON string>"]` first line; anything malformed stays plain content.
  function relayTitlePrefix(text) {
    const match = /^\[Kode message title: ("(?:[^"\\\n]|\\.)*")\]\n/.exec(text)
    let title
    try { title = match && JSON.parse(match[1]) } catch {}
    return typeof title === 'string' && title.trim() && !/[\r\n]/.test(title) ? { title: title.trim(), content: text.slice(match[0].length) } : { content: text }
  }
  let namesSnapshot = { sessions: [], nodeId: undefined, error: '' }, namesPending
  const nameListeners = new Set()
  const namesStore = { subscribe: fn => { nameListeners.add(fn); return () => nameListeners.delete(fn) }, getSnapshot: () => namesSnapshot }
  async function refreshNames() {
    if (namesPending) return namesPending
    namesPending = (async () => {
      try {
        const response = await fetchHost('/api/kode/sessions', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('暂时无法读取会话名称')
        namesSnapshot = { ...await parseHostJson(response), error: '' }
      } catch { namesSnapshot = { ...namesSnapshot, error: '暂时无法读取会话名称' } }
      finally { namesPending = undefined; for (const fn of nameListeners) fn() }
    })()
    return namesPending
  }
  function useNames(sessions) {
    const directory = useSyncExternalStore(namesStore.subscribe, namesStore.getSnapshot)
    const local = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
    useEffect(() => { void refreshNames() }, [])
    return (nodeId, sessionId) => {
      const row = directory.sessions.find(s => s.address.node_id === (nodeId ?? directory.nodeId) && s.address.session_id === sessionId)
      const localTitle = nodeId == null || nodeId === directory.nodeId ? local.byId[sessionId]?.title : undefined
      const title = localTitle || row?.title
      // IDs are routing addresses, never a human-facing substitute for names.
      return title && title !== sessionId && !/^session-[0-9a-f-]+$/i.test(title) ? title : directory.error || !row ? '会话名称暂不可用' : '未命名会话'
    }
  }
  // Presentation only: match the complete authenticated incoming envelope, never
  // strip protocol-looking fragments from a substantive assistant answer.
  function RelayEchoVisibility({ node, sessionId, useChat }) {
    const raw = textContent(node.data.content)
    const turn = node.location?.turn?.turn
    const keys = useChat(snapshot => {
      if (turn == null) return ''
      return snapshot.locations.getTurn(turn).filter(key => {
        const candidate = snapshot.nodes.get(key)
        if (candidate?.kind !== 'assistant-step' || candidate.data.status !== 'settled') return false
        const blocks = candidate.data.blocks
        if (!blocks?.length || blocks.some(block => block.kind !== 'text')) return false
        const text = blocks.map(block => block.text).join('')
        return text === raw || (text.endsWith(raw) && /^[^\r\n:]{1,80}: $/.test(text.slice(0, -raw.length)))
      }).join('\n')
    })
    // rc.2's public chat data attributes let this remain a plugin without
    // replacing the native assistant renderer (and its reasoning/image seats).
    // Scope to this card's flow; encode every code point before building CSS.
    const quoted = value => `"${Array.from(String(value), ch => `\\${ch.codePointAt(0).toString(16)} `).join('')}"`
    const marker = `${sessionId}/${node.key}`
    const css = keys ? keys.split('\n').map(key => `[data-chat-flow]:has([data-kode-relay=${quoted(marker)}]) [data-chat-node-key=${quoted(key)}]{display:none}`).join('\n') : ''
    return h('span', { 'data-kode-relay': marker, hidden: true }, css && h('style', null, css))
  }
  // The projection's answered flag wins; otherwise only a received relay that names a sent request in its reply-to answers it. Delivery receipts never do.
  // Sent lines fly out on the paper plane; received ones arrive as mail, opened once they answer us.
  const relayKinds = {
    waiting: { label: '等待对方回复', icon: IconPaperPlaneOutlineRegular, badge: IconClockOutlineRegular, tone: 'waiting' },
    answered: { label: '已收到回复', icon: IconPaperPlaneOutlineRegular, badge: IconCheckOutlineRegular, tone: 'answered' },
    sent: { label: '已发送', icon: IconPaperPlaneOutlineRegular },
    replied: { label: '已回复对方', icon: IconPaperPlaneOutlineRegular },
    reply: { label: '收到对方回复', icon: IconMailReadOutlineRegular },
    incoming: { label: '收到消息', icon: IconMailUnreadOutlineRegular },
  }
  function relayIcon(key) {
    const {icon,badge} = relayKinds[key]
    return h('span', { className:'kode-relay-icon', 'data-relay-kind':key, 'aria-hidden':true },
      h(icon,{size:16}), badge && h('span',{className:'kode-relay-badge'},h(badge,{size:7})))
  }
  // Agent prose reads as Markdown, but a panel body must stay quiet: images become
  // links (MarkdownText would fetch remote ones), single newlines keep their line
  // breaks, and underscores or asterisks inside bare paths stay literal.
  const fenceLine = /^ {0,3}(`{3,}|~{3,})/
  const barePath = /(^|[\s(（])((?:[~.]{0,2}\/|[A-Za-z]:\\)?[\w.@~-]+(?:[\\/][\w.@~-]+)+)/g
  function quietSpan(text) {
    return text.replace(/!\[/g, '[').replace(barePath, (match, lead, path) => path.includes('://') || !/[_*]/.test(path) ? match : lead + path.replace(/[_*]/g, '\\$&'))
  }
  // A code span closes only on the next backtick run of its opening length; a run
  // with no partner stays text. Each length's runs are visited once, so this is linear.
  function quietLine(line) {
    const runs = [...line.matchAll(/`+/g)], byLength = new Map(), next = new Map()
    runs.forEach((run, at) => { const list = byLength.get(run[0].length); if (list) list.push(at); else byLength.set(run[0].length, [at]) })
    let quiet = '', cursor = 0
    for (let at = 0; at < runs.length; at++) {
      const length = runs[at][0].length, list = byLength.get(length)
      let index = next.get(length) ?? 0
      while (index < list.length && list[index] <= at) index++
      next.set(length, index)
      if (index === list.length) continue
      const close = runs[list[index]], end = close.index + length
      quiet += quietSpan(line.slice(cursor, runs[at].index)) + line.slice(runs[at].index, end)
      cursor = end; at = list[index]
    }
    return quiet + quietSpan(line.slice(cursor))
  }
  function quietMarkdown(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    let open = null
    return lines.map((line, index) => {
      const found = line.match(fenceLine)?.[1]
      // A backtick fence's info string cannot hold backticks; ```x``` is an inline span.
      const marker = found?.[0] === '`' && line.slice(line.indexOf(found) + found.length).includes('`') ? undefined : found
      if (open) { if (marker && marker[0] === open[0] && marker.length >= open.length && !line.slice(line.indexOf(marker) + marker.length).trim()) open = null; return line }
      if (marker) { open = marker; return line }
      const quiet = quietLine(line)
      const next = lines[index + 1]
      return quiet.trim() && next?.trim() && !fenceLine.test(next) && !/\\$|\s{2}$/.test(quiet) ? `${quiet}  ` : quiet
    }).join('\n')
  }
  function PanelMarkdown({ text, className }) {
    const source = useMemo(() => String(text ?? '').trim() ? quietMarkdown(text) : '', [text])
    return source ? h('div', { className: ['kode-panel-markdown', className].filter(Boolean).join(' ') }, h(MarkdownText, { text: source, labels: markdownLabels, variant: 'compact', omitHtml: true })) : null
  }
  // Collapsed relays show only the two real session names, the title and the
  // disclosure chevron; time, delivery and body live in the expanded detail.
  function RelayToggle({ from, to, title, open, onToggle, kind, failed }) {
    return h('button', { type: 'button', className: 'kode-relay-toggle', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'kode-relay-heading' }, relayIcon(kind), h('strong', { title: from.title }, from.name), h('span', { className: 'kode-secondary', 'aria-label': '发往' }, '→'), h('strong', { title: to.title }, to.name)),
      failed && h('span', { className: 'kode-relay-failed kode-error', role: 'img', 'aria-label': '通信未成功', title: '通信未成功' }, h(IconWarningOutlineRegular, { size: 14 })),
      h(IconChevronDownOutlineRegular, { size: 12 }),
      h('span', { className: 'kode-relay-title' }, title))
  }
  const currentEnd = name => ({ name, title: `${name}（当前会话）` })
  function RelayCard({ relay, time, nameOf, sessionId, node, useChat }) {
    const [open, setOpen] = useState(false)
    const slash = relay.address.indexOf('/'), sender = nameOf(relay.address.slice(0, slash), relay.address.slice(slash + 1))
    return h('section', { className: 'kode-relay', 'aria-label': '会话消息', 'data-open': open ? '' : undefined },
      useChat && h(RelayEchoVisibility, { node, sessionId, useChat }),
      h(RelayToggle, { from: { name: sender, title: sender }, to: currentEnd(nameOf(undefined, sessionId)), title: relayTitle(relay), open, onToggle: () => setOpen(!open), kind: relay.replyTo ? 'reply' : 'incoming' }),
      open && h('div', { className: 'kode-relay-detail' }, h('p', { className: 'kode-panel-meta' }, relay.replyTo ? '回复了这段对话' : '发来一条消息', Number.isFinite(time) && ' · ', Number.isFinite(time) && h('time', { dateTime: new Date(time).toISOString() }, new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))), h(PanelMarkdown, { text: relay.content, className: 'kode-relay-body' })),
    )
  }
  function HistoricalRelay({ sessions, ...props }) {
    const nameOf = useNames(sessions)
    return h(RelayCard, { ...props, nameOf })
  }
