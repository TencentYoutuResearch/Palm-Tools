  let sharedTarget = null
  const sharedListeners = new Set(), sharedDrafts = new Map()
  const sharedStore = { subscribe: fn => { sharedListeners.add(fn); return () => sharedListeners.delete(fn) }, getSnapshot: () => sharedTarget }
  const showShared = target => { sharedTarget = target; for (const notify of sharedListeners) notify() }
  function SharedInteraction({ event, resolved, operate }) {
    const p = event.payload, id = p.request_id ?? p.question_id ?? p.plan_id
    const [values, setValues] = useState(() => Object.fromEntries(Object.entries(p.requested_schema?.properties ?? {}).filter(([, field]) => 'default' in field).map(([key, field]) => [key, field.default])))
    const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState('')
    const keys = React.useRef(new Map())
    const act = async (kind, payload) => {
      if (busy || resolved || done) return
      setBusy(true); setError('')
      const fingerprint = JSON.stringify({ kind, payload })
      if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, window.crypto?.randomUUID?.() ?? `response-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      try { await operate(kind, payload, keys.current.get(fingerprint)); setDone(true) } catch (error) { setError(error.message) } finally { setBusy(false) }
    }
    const respond = response => act('answer', { request_id: id, response })
    const field = (key, spec) => {
      const required = p.requested_schema.required?.includes(key), value = values[key]
      const set = next => setValues(prior => ({ ...prior, [key]: next }))
      const choices = (spec.oneOf ?? spec.enum?.map(value => ({ const: value, title: String(value) })) ?? []).map(choice => ({ value: choice.const, label: choice.title ?? String(choice.const) }))
      return h('label', { className: 'kode-field', key }, h('span', null, `${spec.title ?? key}${required ? ' *' : ''}`), spec.description && h('span', { className: 'kode-config-note' }, spec.description),
        spec.type === 'boolean' ? h('select', { value: value === undefined ? '' : String(value), required, onChange: event => set(event.target.value === '' ? undefined : event.target.value === 'true') }, h('option', { value: '' }, '请选择'), h('option', { value: 'true' }, '是'), h('option', { value: 'false' }, '否')) :
        choices.length && !spec.allow_custom ? h('select', { value: value ?? '', required, onChange: event => set(event.target.value) }, h('option', { value: '' }, '请选择'), ...choices.map(choice => h('option', { value: choice.value, key: choice.value }, choice.label))) :
        spec.type === 'number' || spec.type === 'integer' ? h('input', { type: 'number', step: spec.type === 'integer' ? 1 : 'any', min: spec.minimum, max: spec.maximum, required, value: value ?? '', onChange: event => set(event.target.value === '' ? undefined : Number(event.target.value)) }) :
        h(React.Fragment, null, (choices.length || spec.items?.oneOf?.length) && h('p', { className: 'kode-config-note' }, `可选：${(choices.length ? choices.map(choice => choice.label) : spec.items.oneOf.map(choice => choice.title ?? choice.const)).join('；')}${spec.type === 'array' ? '（每行填写一项）' : ''}`), h('textarea', { rows: 2, required, minLength: spec.minLength, maxLength: spec.maxLength, value: Array.isArray(value) ? value.join('\n') : value ?? '', onChange: event => set(spec.type === 'array' ? event.target.value.split('\n').filter(value => value.trim()) : event.target.value) })))
    }
    return h('fieldset', { disabled: busy || done || resolved },
      p.message && h(MarkdownText, { text: p.message, labels: markdownLabels }),
      p.source === 'acp_permission' ? p.options.map(option => h(Button, { key: option.option_id, onClick: () => void respond({ optionId: option.option_id }) }, option.label)) :
      p.requested_schema ? h('form', { onSubmit: event => { event.preventDefault(); void respond(p.source === 'acp_questions' ? { decision: 'allow', content: values } : { action: 'accept', content: values }) } }, ...Object.entries(p.requested_schema.properties ?? {}).map(([key, spec]) => field(key, spec)), h(Button, { type: 'submit', variant: 'primary' }, '提交回答'), h(Button, { type: 'button', onClick: () => void respond(p.source === 'acp_questions' ? { decision: 'deny' } : { action: 'cancel' }) }, '取消')) :
      event.type === 'plan_proposed' ? h(React.Fragment, null, h(Button, { onClick: () => void act('plan_response', { plan_id: id, accept: true }) }, '批准计划'), h(Button, { onClick: () => void act('plan_response', { plan_id: id, accept: false }) }, '拒绝')) :
      (p.options ?? []).map((option, index) => h(Button, { key: index, onClick: () => void act('answer', { question_id: id, choice_index: index, submit: true }) }, typeof option === 'string' ? option : option.label ?? option.text)),
      (done || resolved) && h('p', { role: 'status', className: 'kode-config-note' }, '已处理'), h(Failure, { text: error }))
  }
  function SharedConversation({ target }) {
    const { session, host } = target
    const [events, setEvents] = useState([]), [draft, setDraft] = useState(() => sharedDrafts.get(`${host}:${session.id}`) ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const requestId = React.useRef(null), scroll = React.useRef(null)
    const request = async body => {
      const response = await fetchHost(body ? '/api/kode/shared-session' : `/api/kode/shared-session?id=${session.id}`, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }, host)
      const value = await parseHostJson(response)
      if (!response.ok) throw new Error(value.error ?? '会话连接暂不可用，请重试。')
      return value
    }
    useEffect(() => {
      let alive = true, pending = false
      const refresh = async () => { if (pending) return; pending = true; try { const value = await request(); if (alive) setEvents(value.events) } catch (error) { if (alive) setError(error.message) } finally { pending = false } }
      void refresh(); const timer = setInterval(() => { void refresh() }, 500)
      return () => { alive = false; clearInterval(timer) }
    }, [host, session.id])
    const resolved = new Set(events.filter(event => event.type === 'interaction.resolved').map(event => event.payload.request_id))
    const operate = (kind, payload, request_id) => request({ session_id: session.id, kind, payload, request_id })
    const rows = React.useMemo(() => {
      const merged = new Map()
      for (const event of events) {
        if (!['message', 'tool_use', 'ask_user_question', 'plan_proposed'].includes(event.type)) continue
        const key = `${event.type}:${event.payload.id ?? event.payload.tool_use_id ?? event.payload.question_id ?? event.payload.plan_id ?? event.ts}`
        const prior = merged.get(key)
        merged.set(key, { ...event, payload: { ...prior?.payload, ...event.payload } })
      }
      return [...merged.values()]
    }, [events])
    const send = async event => { event?.preventDefault(); if (busy || !draft.trim()) return; setBusy(true); setError(''); requestId.current ??= window.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`; try { await request({ session_id: session.id, kind: 'input', payload: { text: draft }, request_id: requestId.current }); sharedDrafts.delete(`${host}:${session.id}`); setDraft(''); requestId.current = null } catch (error) { setError(error.message) } finally { setBusy(false) } }
    const interrupt = async () => { setError(''); try { await request({ session_id: session.id, kind: 'interrupt', payload: {} }) } catch (error) { setError(error.message) } }
    return h('section', { className: 'kode-shared-conversation', 'aria-label': session.title },
      h('header', null, h('div', null, h('strong', null, session.title), h('p', { className: 'kode-config-note' }, '由 Kode GUI 持有的会话')), h(Button, { onClick: () => showShared(null) }, '返回 dsh 会话')),
      h('div', { className: 'kode-shared-messages', ref: scroll, 'aria-live': 'polite' }, !rows.length && h('p', { className: 'kode-config-note' }, '等待会话消息…'), ...rows.map((event, index) => h('div', { className: 'kode-relay', key: `${event.type}:${event.payload.id ?? event.payload.tool_use_id ?? event.payload.question_id ?? index}` },
        h('strong', null, event.type === 'message' ? event.payload.role === 'user' ? '你' : 'Agent' : event.type === 'tool_use' ? event.payload.name ?? '工具' : '需要回应'),
        h(MarkdownText, { text: event.payload.text ?? event.payload.question ?? event.payload.plan ?? event.payload.output ?? '', labels: markdownLabels }),
        ['ask_user_question', 'plan_proposed'].includes(event.type) && h(SharedInteraction, { event, resolved: event.payload.resolved === true || resolved.has(event.payload.request_id ?? event.payload.question_id ?? event.payload.plan_id), operate }),
        event.type === 'tool_use' && event.payload.input && h('details', null, h('summary', null, '查看输入'), h('pre', null, typeof event.payload.input === 'string' ? event.payload.input : JSON.stringify(event.payload.input, null, 2))),
      ))),
      h('form', { className: 'kode-shared-composer', onSubmit: send }, h(Failure, { text: error }), h('label', { className: 'kode-field' }, '发送消息', h('textarea', { value: draft, rows: 3, disabled: busy, onChange: event => { const text = event.target.value; setDraft(text); sharedDrafts.set(`${host}:${session.id}`, text); requestId.current = null } })), h('div', null, h(Button, { type: 'button', onClick: interrupt }, '中断'), h(Button, { type: 'submit', variant: 'primary', disabled: busy || !draft.trim() }, busy ? '正在发送…' : '发送'))),
    )
  }
  function InlineFileChat({native,...props}) {
    const openFile=React.useCallback((path,options)=>{
      if(typeof path!=='string'||/^[a-z][a-z\d+.-]*:\/\//i.test(path))return props.openFile(path,options)
      const match=/^(.*?)(?::([1-9]\d*)(?::[1-9]\d*)?|#L([1-9]\d*)(?:C[1-9]\d*|(?:-L?)[1-9]\d*)?)$/.exec(path)
      const line=match&&Number(match[2]??match[3])
      if(!match||!Number.isSafeInteger(line))return props.openFile(path,options)
      return props.openFile(match[1],{...options,line:options?.line??line})
    },[props.openFile])
    const target = useSyncExternalStore(sharedStore.subscribe, sharedStore.getSnapshot)
    if (target?.kind === 'remote-device') return h(RemoteDeviceConversation, { key: `remote:${target.device.device_id}:${target.session.id}`, target })
    return target ? h(SharedConversation, { key: `${target.host}:${target.session.id}`, target }) : h(native,{...props,openFile})
  }
