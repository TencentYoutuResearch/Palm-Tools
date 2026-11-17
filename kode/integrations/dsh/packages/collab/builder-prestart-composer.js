import React from 'react'
import * as composerModule from '@kode/dsh-composer'
import { portableComposerSupport } from './portable-composer.js'
import { planningTextKey } from './builder-planning.js'
import { PlanningAgentPicker, PlanningModelPicker } from './builder-planning-controls.js'
const h = React.createElement, NativeComposer = portableComposerSupport(composerModule)
export const prestartTextKey = planningTextKey
/**
 * Native hero row: only the Agent above the card, the model before send. Planning
 * needs no project or machine; where it runs is stated below the composer.
 */
export function planningHeader({ controls, planning, lockedReason }) {
  return () => h(PlanningAgentPicker, { controls, planning, lockedReason })
}

/**
 * Unsent text before the planning Session exists. Storage is fail-closed: if the
 * saved text cannot be read or written, editing and sending stop so nothing is lost
 * or silently replaced.
 */
export function BuilderPrestartComposer({ draft, storage, controls, planning, onStart, blockedReason = '', pendingReason, busy = false }) {
  const [text, setText] = React.useState(''), [state, setState] = React.useState('loading'), [error, setError] = React.useState('')
  const writes = React.useRef(Promise.resolve()), failed = React.useRef(false)
  const key = prestartTextKey(draft)
  React.useEffect(() => {
    let alive = true; failed.current = false; setState('loading'); setError('')
    storage.read(key).then(row => { if (alive) { setText(typeof row?.content === 'string' ? row.content : ''); setState('ready') } })
      .catch(() => { if (alive) { failed.current = true; setState('blocked'); setError('无法恢复已保存的补充内容。为避免覆盖，暂不能编辑或开始；请检查本地存储后重新打开。') } })
    return () => { alive = false }
  }, [key])
  const edit = value => {
    if (failed.current || state !== 'ready') return
    setText(value)
    writes.current = writes.current.then(() => storage.save(key, { content: value })).catch(() => {
      failed.current = true; setState('blocked'); setError('补充内容未能保存到本机。为避免丢失，暂不能继续；请复制内容后重新打开。')
    })
  }
  const clear = async () => { setText(''); writes.current = writes.current.then(() => storage.save(key, { content: '' })); await writes.current }
  const submit = async input => {
    if (input.scopeKey !== key || input.text !== text) throw Error('Draft changed')
    await writes.current
    if (failed.current) throw Error('Prestart text unavailable')
    await onStart({ text, clear })
  }
  // A pending original request freezes Agent/model: recovery resends it unchanged.
  const ready = state === 'ready' && !blockedReason && (!!pendingReason || planning.ready)
  const lockedReason = state === 'blocked' ? error : pendingReason
  if (!NativeComposer) return h('p', { role: 'status' }, '原生输入组件不可用，请更新 Kode 插件。')
  return h('div', { className: 'kode-builder-prestart-composer' },
    h(NativeComposer, { scopeKey: key, value: text, ariaLabel: '规划对话的补充说明', placeholder: '补充约束或想法（可选），开始后会放进规划会话的输入框，由你确认发送',
      maxLength: 16384, disabled: state !== 'ready' || busy, editingDisabled: state === 'blocked', allowEmpty: true, sendDisabled: !ready,
      sendLabel: pendingReason ? '恢复上次请求' : '开始规划对话', failureLabel: '规划会话未能打开，补充内容已保留。', onChange: edit, onSubmit: submit,
      header: planningHeader({ controls, planning, lockedReason }),
      trailing: h(PlanningModelPicker, { controls, planning, lockedReason }) }),
    (error || pendingReason || planning.storageError) && h('p', { role: 'status', className: 'kode-builder-composer-note' }, error || pendingReason || planning.storageError))
}
