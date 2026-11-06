/** Shared history editing for ordinary and admitted-steering human messages.
 * The Host validates the durable row; this component never rewrites history. */
function historyEditBinding(ctx, sessionId) {
  return { historyHost: () => ctx.get('kodeTransport')?.current ?? 'local', editHistory: async (seq, text, requestId, sourceHost) => {
    const transport = ctx.get('kodeTransport'), host = sourceHost ?? transport?.current ?? 'local'
    if ((transport?.current ?? 'local') !== host) throw new Error('执行主机已切换，请返回原主机后重新编辑。')
    const init = { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'edit-message', sessionId, seq, text, requestId }) }
    const response = await (transport ? transport.fetch('/api/kode/agents', init, host) : fetch('/api/kode/agents', init))
    if (response.status === 404) throw new Error('请更新此主机的 Kode 服务以支持历史消息编辑。')
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? '编辑重发失败，请重试。')
    if ((transport?.current ?? 'local') !== host) throw new Error('主机已切换，编辑分支保留在原主机，请返回查看。')
    await ctx.get('uiWorkspace').openSession(result.sessionId)
  } }
}
function HistoryEditableMessage({ native, editHistory, ...props }) {
  const h = react.createElement, { Button, Tooltip, IconEditOutlineRegular } = _deepseek_ai_dsh_client_ui_primitives
  const [open, setOpen] = react.useState(false), [draft, setDraft] = react.useState(''), [error, setError] = react.useState('')
  const [busy, setBusy] = react.useState(false), request = react.useRef(null), inFlight = react.useRef(false), sourceHost = react.useRef(null), editor = react.useRef(null)
  const allowed = props.useAccess('session/fork'), data = props.node.data
  const human = ['user', 'human'].includes(data.source?.kind)
  const text = data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  const editable = allowed && human && typeof editHistory === 'function'
  react.useLayoutEffect(() => {
    if (!open || !editor.current) return
    editor.current.style.height = 'auto'
    editor.current.style.height = Math.min(480, Math.max(80, editor.current.scrollHeight)) + 'px'
  }, [open, draft])
  const close = () => { if (!inFlight.current) setOpen(false) }
  const send = async () => {
    if (inFlight.current || !draft.trim()) return
    inFlight.current = true; setBusy(true); setError('')
    try { await editHistory(data.seq, draft, request.current, sourceHost.current); setOpen(false) }
    catch (error) { setError(error.message) }
    finally { inFlight.current = false; setBusy(false) }
  }
  const action = editable && h(Tooltip, { label: '编辑', side: 'bottom' },
    h('button', { type: 'button', className: MessageIconActions_module_css_default.action, 'aria-label': '编辑消息', disabled: busy, onClick: () => {
      if (inFlight.current) return
      sourceHost.current = props.historyHost?.(); setDraft(text); setError(''); request.current = crypto.randomUUID(); setOpen(true)
    } }, h(IconEditOutlineRegular)))
  // The shipped action row owns Copy placement, hover/last-message reveal and focus behavior.
  if (!open || !editable) return h(native, { ...props, historyEditAction: action })
  const parts = contentParts(data.content)
  return h('div', { className: MessageItem_module_css_default.userRow, 'data-kode-history-editing': true },
    parts.attachments.length > 0 && props.renderFactorySlot('conversation.chat.user.content', {
      content: { text: '', attachments: parts.attachments, extraBlocks: [] }, loadImage: props.loadImage, facts: {},
    }),
    h('form', { className: 'kode-history-edit-inline', onSubmit: event => { event.preventDefault(); void send() } },
      h('textarea', { ref: editor, value: draft, rows: 3, autoFocus: true, 'aria-label': '编辑消息内容', disabled: busy,
        onChange: event => { setDraft(event.target.value); request.current = crypto.randomUUID() },
        onKeyDown: event => {
          if (event.nativeEvent?.isComposing || event.isComposing) return
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() }
        } }),
      h('div', { className: 'kode-history-edit-footer' },
        h('span', { className: 'kode-history-edit-note' }, '从此处创建新分支，后续消息不参与上下文'),
        h(Button, { type: 'button', onClick: close, disabled: busy }, '取消'),
        h(Button, { type: 'submit', variant: 'primary', disabled: busy || !draft.trim() }, busy ? '发送中…' : '重新发送')),
      error && h('p', { role: 'alert', className: 'kode-history-edit-error' }, error)))
}

function installHistoryEditStyle(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `.kode-history-edit-inline{box-sizing:border-box;width:100%;min-width:0;margin:0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-bubble,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-label-primary)}.kode-history-edit-inline textarea{box-sizing:border-box;display:block;width:100%;min-height:80px;max-height:480px;resize:vertical;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.6}.kode-history-edit-inline textarea:focus-visible{outline:none}.kode-history-edit-inline:focus-within{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}.kode-history-edit-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:12px}.kode-history-edit-note{flex:1 1 200px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}.kode-history-edit-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary);font-size:13px}`
    document.head.append(style)
    return () => style.remove()
  }, 'kode.history-edit-style')
}
