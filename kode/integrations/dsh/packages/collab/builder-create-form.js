import React from 'react'
import * as composerModule from '@kode/dsh-composer'
import { portableComposerSupport } from './portable-composer.js'
import { createDraftKey, createBuilderDraft, requestCreateDraft } from './builder-create.js'
import { planningHeader } from './builder-prestart-composer.js'
import { PlanningModelPicker } from './builder-planning-controls.js'
const NativeComposer = portableComposerSupport(composerModule)
const h = React.createElement
/** Saving a goal only creates the draft record; it never opens a Session or starts a model. */
export function BuilderCreateForm({ home, storage, onCreated, controls, planning }) {
  const [purpose, setPurpose] = React.useState(''), [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false), draftWrites = React.useRef(Promise.resolve()), draftFailed = React.useRef(false)
  const textKey = JSON.stringify(['builder-goal-text', home])
  const edit = value => {
    if (draftFailed.current) return
    setPurpose(value)
    draftWrites.current = draftWrites.current.then(() => storage.save(textKey, { purpose: value })).catch(() => { draftFailed.current = true; setReady(false); setError('输入尚未保存，请检查浏览器存储权限后重新打开。') })
  }
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void Promise.all([storage.read(createDraftKey(home)), storage.read(textKey)]).then(([row, text]) => { if (!controller.signal.aborted) { setPending(row?.state !== 'accepted' ? row : null); setPurpose(typeof text?.purpose === 'string' ? text.purpose : ''); setReady(true) } })
      .catch(() => { if (!controller.signal.aborted) { draftFailed.current = true; setError('无法读取已保存的目标。为避免覆盖，暂不能编辑；请检查浏览器存储权限。') } })
    return () => controller.abort()
  }, [home])
  const submit = async () => {
    if (!ready || running.current) return
    running.current = true; setBusy(true); setError('')
    try {
      await draftWrites.current
      if (draftFailed.current) throw Error('Goal draft unavailable')
      const draft = await createBuilderDraft({ storage, home, purpose, request: requestCreateDraft, signal: active.current.signal })
      if (!active.current.signal.aborted) {
        // The confirmed receipt is authoritative; cleanup failure must not offer creation retry.
        try { await storage.save(textKey, { purpose: '' }) } catch { setError('目标已保存，本地输入清理失败；请勿重复创建。') }
        setPending(null); onCreated(draft)
      }
    } catch {
      if (!active.current.signal.aborted) {
        setError('目标尚未确认保存，重试会恢复同一份草案。')
        try { setPending(await storage.read(createDraftKey(home))) } catch {}
      }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const text = pending?.command.purpose ?? purpose, scopeKey = JSON.stringify(['builder-goal', home])
  if (!NativeComposer) return h('p', { role: 'status' }, '原生输入组件不可用，请更新 Kode 插件。')
  return h('div', { className: 'kode-collab-builder-create' },
    h(NativeComposer, { scopeKey, value: text, ariaLabel: '团队目标', placeholder: '你希望团队完成什么？描述任务、分工和期望交付…', maxLength: 8192,
      disabled: !ready || busy, editingDisabled: !!pending || draftFailed.current, sendLabel: pending ? '恢复原草案' : '保存目标',
      failureLabel: '目标尚未确认保存，重试会恢复同一份草案。', onChange: edit,
      onSubmit: async input => { if (input.scopeKey !== scopeKey || input.text !== text || !ready || busy) throw Error('Builder goal changed'); await submit() },
      header: planningHeader({ controls, planning }),
      trailing: h(PlanningModelPicker, { controls, planning }) }),
    error && h('p', { role: 'status', className: 'kode-builder-composer-note' }, error))
}
