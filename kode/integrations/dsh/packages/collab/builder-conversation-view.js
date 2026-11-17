import React from 'react'
import * as composerModule from '@kode/dsh-composer'
import { portableComposerSupport } from './portable-composer.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
const NativeComposer=portableComposerSupport(composerModule)
import { visibleRefresh } from './visible-refresh.js'
import { builderMessageKey, sendBuilderMessage, requestBuilderMessage } from './builder-message.js'
const h = React.createElement
export function BuilderConversationView({ draft, created, storage, request, onDraftUpdated,readOnly=false,closed=false,accessory }) {
  const [messages, setMessages] = React.useState([]), [content, setContent] = React.useState(''), [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(''), [error, setError] = React.useState('')
  const cursor = React.useRef({ seq: 0, offset: 0 }), active = React.useRef(null), sending = React.useRef(false)
  const operation = created.request.operation
  const textKey=JSON.stringify(['builder-message-text',draft.home_hub,draft.id,operation.id])
  const writes=React.useRef(Promise.resolve()),writeFailed=React.useRef(false)
  const edit=value=>{setContent(value);writes.current=writes.current.then(()=>storage.save(textKey,{content:value})).catch(()=>{writeFailed.current=true;setReady(false);setNotice('消息草稿尚未保存，请检查浏览器存储权限后重新打开。')})}
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void Promise.all([storage.read(builderMessageKey(draft, created)),storage.read(textKey)]).then(([value,text]) => {
      if (!controller.signal.aborted) { setPending(value?.state !== 'accepted' ? value : null);setContent(typeof text?.content==='string'?text.content:''); setReady(true) }
    }).catch(() => { if (!controller.signal.aborted) setNotice('无法读取消息发送记录，请重新打开草案。') })
    const stop = visibleRefresh({ refresh: async () => {
      try {
        const before = cursor.current
        const value = await request(`/api/kode/builder/conversation?operation_id=${encodeURIComponent(operation.id)}&seq=${before.seq}&offset=${before.offset}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (value.operation_id !== operation.id || value.draft_id !== draft.id || !Array.isArray(value.messages) || value.messages.length > 8 || typeof value.has_more !== 'boolean') throw Error('Wrong conversation')
        let position = before
        for (const row of value.messages) {
          if (!Number.isSafeInteger(row.seq) || !Number.isSafeInteger(row.offset) || row.seq < position.seq || (row.seq === position.seq && row.offset < position.offset)
            || row.offset < 0 || !['user', 'assistant'].includes(row.role) || typeof row.text !== 'string' || !row.text.length || Array.from(row.text).length > 4096) throw Error('Invalid conversation fragment')
          position = { seq: row.seq, offset: row.offset + Array.from(row.text).length }
        }
        const next = value.cursor
        if (!Number.isSafeInteger(next?.seq) || !Number.isSafeInteger(next.offset) || next.seq < position.seq || next.offset < 0 || (next.seq === position.seq && next.offset < position.offset)
          || (value.has_more && next.seq === before.seq && next.offset === before.offset)) throw Error('Invalid conversation cursor')
        if (onDraftUpdated) {
          const current = await request(`/api/kode/builder/drafts?draft_id=${encodeURIComponent(draft.id)}`, { signal: controller.signal })
          if (controller.signal.aborted) return
          if (current.id !== draft.id || current.home_hub !== draft.home_hub || !Number.isSafeInteger(current.revision) || current.revision < 1 || !['draft', 'revoked'].includes(current.status)
            || !Array.isArray(current.interview?.questions) || !Array.isArray(current.interview.workspace_refs)) throw Error('Wrong draft update')
          onDraftUpdated(current)
        }
        cursor.current = next; setMessages(previous => [...previous, ...value.messages]); setError('')
        return value.has_more ? 250 : 3000
      } catch { if (!controller.signal.aborted) setError('暂时无法读取助手对话，已有内容仍保留。'); return 10000 }
    } })
    return () => { stop(); controller.abort() }
  }, [operation.id, draft.id, draft.home_hub, onDraftUpdated])
  const submit = async event => {
    event.preventDefault(); if (sending.current || !ready||readOnly) return
    if (!pending && (!content.trim() || content.includes('\0') || new TextEncoder().encode(content).length > 16384)) { setNotice('请输入不超过 16 KiB 的消息。'); return }
    sending.current = true; setBusy(true); setNotice('')
    try {
      await writes.current
      if(writeFailed.current)throw Error('Builder message draft unavailable')
      await sendBuilderMessage({ storage, draft, created, content, request: requestBuilderMessage, signal: active.current.signal })
      if (!active.current.signal.aborted) {
        setPending(null);setContent('');setNotice('Hub 已接收。')
        try { await storage.save(textKey,{content:''}) } catch { setNotice('Hub 已接收，本地输入清理失败；请勿重复发送。') }
      }
    } catch { if (!active.current.signal.aborted) { setNotice('消息结果尚未确认，重试会发送原内容。'); try { setPending(await storage.read(builderMessageKey(draft, created))) } catch {} } }
    finally { sending.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const text=pending?.command.content??content,scopeKey=JSON.stringify(['builder-message',draft.home_hub,draft.id,operation.id])
  return h('section', { className: 'kode-collab-builder-conversation', 'aria-label': 'Team Builder 对话' }, h('h3', null, '与 Team Builder 对话'),
    error && h('p', { role: 'status' }, error),
    h('div', { className: 'kode-collab-messages kode-builder-message-history', 'aria-label':'真实模型对话记录' }, ...messages.map(row => h('article', { key: `${row.seq}:${row.offset}`, className: 'kode-collab-message' }, h('strong', null, row.role === 'user' ? '你' : 'Team Builder'), h('p', { style: { whiteSpace: 'pre-wrap' } }, row.text)))),
    closed?h('p',null,'本次搭建已结束，对话记录可继续查看。'):h('form', { className: 'kode-builder-message-composer', onSubmit: submit },
      NativeComposer?h(NativeComposer,{scopeKey,value:text,ariaLabel:'给 Team Builder 的消息',placeholder:'继续描述需求，和 Team Builder 一起完善团队…',maxLength:16384,disabled:readOnly||!ready||busy,editingDisabled:!!pending,accessory,sendLabel:pending?'重试原助手消息':'发送给 Team Builder',onChange:edit,onSubmit:async input=>{if(input.scopeKey!==scopeKey||input.text!==text||readOnly||!ready||busy)throw Error('Builder message scope changed');await submit({preventDefault(){}})}}):h(React.Fragment,null,accessory,
      h('textarea', { 'aria-label': '给 Team Builder 的消息', value: text, disabled: readOnly||!ready || busy || !!pending, onChange: event => edit(event.target.value) }),
      h(Button, { type: 'submit', disabled: readOnly||!ready || busy }, pending ? '重试原助手消息' : '发送给 Team Builder'))),
    notice && h('p', { role: 'status' }, notice))
}
