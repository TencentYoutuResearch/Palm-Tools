import React from 'react'
import { BuilderPatchRecovery } from './builder-patch-recovery.js'
import { answerKey, submitAnswers, requestBuilderAnswers } from './builder-answers.js'
const h = React.createElement
export function BuilderAnswerForm({ draft, storage, onSaved, onRefresh }) {
  const [answers, setAnswers] = React.useState({}), [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const controller = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const current = new AbortController(); controller.current = current
    void storage.read(answerKey(draft)).then(value => { if (!current.signal.aborted) { setPending(value?.state !== 'accepted' ? value : null); setReady(true) } }).catch(() => { if (!current.signal.aborted) setError('无法读取提交记录，请检查浏览器存储权限。') })
    return () => current.abort()
  }, [draft.id, draft.home_hub])
  const submit = async event => {
    event.preventDefault(); if (running.current || !ready) return
    running.current = true; setBusy(true); setError('')
    try {
      const receipt = await submitAnswers({ storage, draft, answers, request: requestBuilderAnswers, signal: controller.current.signal })
      if (!controller.current.signal.aborted) { setPending(null); setAnswers({}); onSaved(receipt) }
    } catch {
      if (!controller.current.signal.aborted) {
        setError('回答尚未确认保存。重试会提交原请求；若草案已被修改，请先刷新核对。')
        try { setPending(await storage.read(answerKey(draft))) } catch {}
      }
    } finally { running.current = false; if (!controller.current.signal.aborted) setBusy(false) }
  }
  return h('form', { className: 'kode-collab-composer', onSubmit: submit },
    ...(pending ? Object.entries(pending.command.answers).map(([key, value]) => h('p', { key }, key, '：', value)) : draft.interview.questions.map(question => h('label', { key: question.id, className: 'kode-collab-input-label' }, question.prompt,
      h('textarea', { value: answers[question.id] ?? '', maxLength: 8192, onChange: event => setAnswers(value => ({ ...value, [question.id]: event.target.value })) })))),
    (pending || draft.interview.questions.length > 0) && h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy || (!pending && !draft.interview.questions.every(question => answers[question.id]?.trim())) }, busy ? '正在保存…' : pending ? '重试原回答' : '保存回答'),
    pending && h(BuilderPatchRecovery, { draft, pending, kind: 'answers', storage, storageKey: answerKey(draft), onResolved: () => { setAnswers(pending.command.answers); setPending(null); setError(''); onRefresh() } }),
    error && h('p', { role: 'status' }, error))
}
