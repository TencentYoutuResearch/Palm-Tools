  async function wecomCall(body = null) {
    const response = await fetchHost(
      '/api/kode/wecom',
      body ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin', cache: 'no-store' },
      'local',
    )
    const value = await parseHostJson(response)
    if (!response.ok) throw new Error(value.error ?? '企业微信机器人桥接暂不可用')
    return value
  }
  function WeComBridgeCard() {
    const [state, setState] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [sessions, setSessions] = useState([])
    const [newChatId, setNewChatId] = useState('')
    const [newChatName, setNewChatName] = useState('')
    const [testing, setTesting] = useState(false)
    const [testChatId, setTestChatId] = useState('')
    const [testFormat, setTestFormat] = useState('markdown')
    const [testContent, setTestContent] = useState('')

    const load = async () => {
      setError('')
      try { setState(await wecomCall()) } catch (err) { setError(err.message) }
    }
    useEffect(() => { void load() }, [])

    const save = async patch => {
      setBusy(true); setError(''); setNotice('')
      try {
        const res = await wecomCall({ action: 'configure', config: patch })
        setState(prev => ({ ...prev, ...res }))
        setNotice('已保存企业微信机器人配置')
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }
    const fetchSessions = async () => {
      setBusy(true); setError(''); setNotice('')
      try {
        const res = await wecomCall({ action: 'sessions', include_groups: true })
        setSessions(res.sessions ?? [])
        if (res.help_message) setState(prev => ({ ...prev, auth_notice: res.help_message }))
        else if (res.error) setError(res.error)
        else setNotice(`已获取 ${(res.sessions ?? []).length} 个企微会话`)
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }
    const pollNow = async () => {
      setBusy(true); setError(''); setNotice('')
      try {
        const res = await wecomCall({ action: 'poll_now' })
        setState(prev => ({ ...prev, last_poll: res.last_poll, auth_notice: res.auth_notice, recent_events: res.recent_events }))
        if (res.help_message) setNotice('企微授权已过期，请按下方提示完成授权')
        else if (res.error) setError(res.error)
        else setNotice(`检查完成：扫描 ${res.checked_chats ?? 0} 个会话，发现 ${res.published ?? 0} 条新消息`)
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }
    const sendTest = async event => {
      event.preventDefault()
      setBusy(true); setError(''); setNotice('')
      try {
        const res = await wecomCall({ action: 'send', chat_id: testChatId.trim(), content: testContent.trim(), format: testFormat })
        if (res.help_message) setState(prev => ({ ...prev, auth_notice: res.help_message }))
        else if (!res.ok) setError(res.error ?? '发送失败')
        else { setTestContent(''); setNotice('消息已通过 wecom-cli 发送') }
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    const status = state?.status
    const config = state?.config ?? { enabled: false, poll_interval_secs: 30, auto_discover_sessions: true, watched_chats: [] }
    const authNotice = state?.auth_notice
    const watched = config.watched_chats ?? []
    const addWatched = (chatId, name) => {
      const id = String(chatId ?? '').trim()
      if (!id || watched.some(c => c.chat_id === id)) return
      void save({ watched_chats: [...watched, { chat_id: id, name: (name || id).trim() }] })
      setNewChatId(''); setNewChatName('')
    }
    const removeWatched = chatId => void save({ watched_chats: watched.filter(c => c.chat_id !== chatId) })

    return h('div', { className: 'kode-agent-row kode-wecom-card' },
      h('div', { className: 'kode-agent-row-head' },
        h('span', { className: 'kode-agent-name' }, '企业微信机器人（wecom-cli）'),
        status && h('span', { className: 'kode-agent-tag' }, !status.installed ? '未安装' : status.authorized ? `已授权 · ${status.bot_id || 'aibot'}` : '未授权'),
        h('div', { className: 'kode-agent-row-actions' },
          h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => void load() }, '刷新状态'),
          status?.authorized && h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => void pollNow() }, '立即检查'))),
      h('p', { className: 'kode-config-note' }, '接入本机 wecom-cli 智能机器人后，所有伙伴与会话均可直接调用 wecom_sessions_list / wecom_messages_list / wecom_message_send 与企微通信；开启监听后，可在伙伴的「关注」里添加「企业微信机器人收到消息」自动响应。'),
      status && !status.authorized && status.error && h(Failure, { text: status.error }),
      authNotice && h('div', { className: 'kode-wecom-auth-notice', role: 'alert' },
        h('strong', null, '企业微信消息权限提示：'),
        h('pre', { className: 'kode-wecom-notice-text' }, authNotice)),
      status?.installed && h('div', { className: 'kode-wecom-controls' },
        h('label', { className: 'kode-integration-row' },
          h('span', null, h('strong', null, '启用企微消息监听'), h('span', { className: 'kode-config-note' }, '按间隔轮询已关注会话的新消息并发布 wecom/message 事件唤醒伙伴。')),
          h('input', { type: 'checkbox', role: 'switch', checked: Boolean(config.enabled), disabled: busy, onChange: event => void save({ enabled: event.target.checked }) })),
        h('div', { className: 'kode-watch-grid' },
          h('label', { className: 'kode-field' },
            h('span', null, '轮询间隔（10–300 秒）'),
            h('input', { type: 'number', min: 10, max: 300, value: config.poll_interval_secs ?? 30, disabled: busy, onChange: event => { const v = Number(event.target.value); if (v >= 10 && v <= 300) void save({ poll_interval_secs: v }) } })),
          h('label', { className: 'kode-avatar-background-toggle' },
            h('input', { type: 'checkbox', checked: config.auto_discover_sessions !== false, disabled: busy, onChange: event => void save({ auto_discover_sessions: event.target.checked }) }),
            '自动发现机器人最近会话')),
        h('div', { className: 'kode-wecom-chats' },
          h('div', { className: 'kode-wecom-chats-head' },
            h('strong', null, `监听会话列表（${watched.length}）`),
            h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => void fetchSessions() }, '拉取企微会话'),
            h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setTesting(!testing) }, testing ? '收起发消息' : '测试发送消息')),
          watched.length > 0 && h('div', { className: 'kode-memory-tags' },
            ...watched.map(chat => h('span', { key: chat.chat_id, className: 'kode-agent-tag kode-wecom-chat-chip' },
              `${chat.name} (${chat.chat_id})`,
              h('button', { type: 'button', className: 'kode-bot-release', title: '移除监听', onClick: () => removeWatched(chat.chat_id) }, '×')))),
          sessions.length > 0 && h('div', { className: 'kode-wecom-discovered' },
            h('span', { className: 'kode-config-note' }, '点击添加到监听列表：'),
            ...sessions.map(s => h('button', {
              key: s.chat_id,
              type: 'button',
              className: 'kode-banner-chip',
              disabled: busy || watched.some(c => c.chat_id === s.chat_id),
              onClick: () => addWatched(s.chat_id, s.name),
            }, `+ ${s.name}`))),
          h('form', { className: 'kode-wecom-add-form', onSubmit: event => { event.preventDefault(); addWatched(newChatId, newChatName) } },
            h('input', { type: 'text', value: newChatId, placeholder: '输入 chat_id（单聊 userid 或群 chat_id）', disabled: busy, onChange: e => setNewChatId(e.target.value) }),
            h('input', { type: 'text', value: newChatName, placeholder: '备注名（可选）', disabled: busy, onChange: e => setNewChatName(e.target.value) }),
            h(Button, { type: 'submit', variant: 'outline', disabled: busy || !newChatId.trim() }, '添加'))),
        testing && h('form', { className: 'kode-agent-editor', onSubmit: event => void sendTest(event) },
          h('div', { className: 'kode-watch-grid' },
            h('label', { className: 'kode-field' },
              h('span', null, '目标 chat_id'),
              h('input', { type: 'text', required: true, value: testChatId, placeholder: 'userid 或群 chat_id', disabled: busy, onChange: e => setTestChatId(e.target.value) })),
            h(SelectField, { label: '消息类型', value: testFormat, options: [{ value: 'markdown', label: '智能机器人 Markdown' }, { value: 'text', label: '普通文本' }], disabled: busy, onChange: setTestFormat })),
          h('label', { className: 'kode-field' },
            h('span', null, '消息内容'),
            h('textarea', { rows: 3, required: true, value: testContent, placeholder: '输入要发送到企业微信的消息…', disabled: busy, onChange: e => setTestContent(e.target.value) })),
          h('div', { className: 'kode-settings-footer' },
            h(Button, { type: 'submit', variant: 'primary', disabled: busy || !testChatId.trim() || !testContent.trim() }, '发送到企业微信')))),
      notice && h('p', { role: 'status', className: 'kode-saved kode-memory-notice' }, notice),
      h(Failure, { text: error }))
  }
