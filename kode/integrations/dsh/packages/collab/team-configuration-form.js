import React from 'react'
import { configurationKey, prepareConfiguration, saveConfiguration } from './team-configuration.js'
import { RolePromptField, ROLE_PROMPT_NOTE, rolePromptStyles } from './role-prompt-fields.js'
const h = React.createElement
export function TeamConfigurationForm({ team, storage, onSaved, controls, focusInstructions = false }) {
  const [workers, setWorkers] = React.useState(() => structuredClone(team.spec.workers)), [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState(''), [review, setReview] = React.useState(null)
  const [coordinatorPrompt, setCoordinatorPrompt] = React.useState(team.spec.coordinator_prompt ?? '')
  const interactive = team.spec.execution_mode === 'interactive_native'
  const [name, setName] = React.useState(team.spec.name ?? ''), [purpose, setPurpose] = React.useState(team.spec.purpose ?? '')
  const additions = [], coordinatorTargets = team.spec.coordinator_targets ?? []
  const running = React.useRef(false), active = React.useRef(null)
  const instructions = React.useRef(null)
  React.useEffect(() => {
    // The fields stay disabled until the save record is read; focus once they can take input.
    if (!focusInstructions || !ready) return
    instructions.current?.scrollIntoView({ block: 'start' }); instructions.current?.querySelector('textarea')?.focus({ preventScroll: true })
  }, [focusInstructions, ready])
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    storage.read(configurationKey(team)).then(row => { if (!controller.signal.aborted) { setPending(row); setReady(true) } }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取保存记录，请重新打开团队。') })
    return () => controller.abort()
  }, [team.id, team.revision, team.home_hub])
  const edit = (index, changes) => { setReview(null); setWorkers(old => old.map((row, i) => i === index ? { ...row, ...changes } : row)) }
  const save = async () => {
    if (running.current || !ready || (!review && !pending)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const row = await saveConfiguration({ team, command: pending?.command ?? review, storage, signal: active.current.signal })
      if (!active.current.signal.aborted) { setMessage(interactive ? `已保存第 ${row.revision} 版原生交互配置，尚未发送任务。` : `已保存第 ${row.revision} 版草稿，尚未激活。`); onSaved?.(row) }
    } catch { if (!active.current.signal.aborted) { setMessage('保存结果尚未确认。请恢复原请求；若版本冲突，刷新团队配置后重新编辑。'); try { setPending(await storage.read(configurationKey(team))) } catch {} } }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  return h('section', { className: 'kode-collab-team-configuration', 'aria-label': '职责与执行资源' },
    h('style', null, configurationStyles + rolePromptStyles), h('h3', null, '职责与配置'), h('p', null, interactive ? `当前配置 v${team.revision} · 保存为新版本，不会自动发送任务。` : `当前配置 v${team.revision} · 保存为新草稿，需单独核对权限并激活。`),
    !interactive && h('p', null, '运行中的任务保留原模型与配置快照。激活新版后，旧任务的后续分配可能因版本变化而被阻止，请先完成或暂停旧任务。'),
    h('fieldset', { disabled: !ready || busy || !!pending },
      h('label', null, '团队名称', h('input', { value: name, maxLength: 160, onChange: e => { setReview(null); setName(e.target.value) } })),
      h('label', null, '团队目标', h('textarea', { value: purpose, rows: 3, onChange: e => { setReview(null); setPurpose(e.target.value) } })),
      h('fieldset', { ref: instructions, 'data-role-prompt': 'coordinator' }, h('legend', null, team.spec.name ? `${team.spec.name}（SuperAgent）` : 'SuperAgent'),
        h('p', null, ROLE_PROMPT_NOTE),
        h(RolePromptField, { label: '协调者指令', value: coordinatorPrompt, onChange: text => { setReview(null); setCoordinatorPrompt(text) } })),
      ...workers.map((worker, index) => h('fieldset', { key: worker.id }, h('legend', null, worker.role || worker.id),
        h('label', null, '职责名称', h('input', { value: worker.role, maxLength: 160, onChange: e => edit(index, { role: e.target.value }) })),
        h('label', null, '职责说明（每行一项）', h('textarea', { value: worker.responsibilities.join('\n'), rows: 3, onChange: e => edit(index, { responsibilities: e.target.value.split('\n') }) })),
        h(RolePromptField, { label: '角色指令', value: worker.role_prompt ?? '', onChange: text => edit(index, { role_prompt: text }) })))),
    pending ? h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void save() }, pending.state === 'saved' ? '读取已保存版本' : '恢复原保存请求') :
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => { try { setReview(prepareConfiguration(team, workers, crypto.randomUUID(), coordinatorPrompt, { name, purpose, additions, ...(interactive ? { coordinator_targets: coordinatorTargets } : {}) })); setMessage('') } catch { setMessage('请填写团队与职责信息，并确认每段指令不超过 16000 字节；既有授权配置不完整时请恢复团队草案。') } } }, '核对配置变更'),
    review && !pending && h('div', { role: 'region', 'aria-label': '保存确认' }, h('p', null, `将基于 v${team.revision} 保存 v${team.revision + 1} 草稿，不启动任务或变更授权。`),
      h('p', null, `团队编号：${team.id} · 保留当前身份与对话`),
      h('p', null, `${review.spec.name}：${review.spec.purpose}`),
      h('p', null, `协调者指令：${review.spec.coordinator_prompt ? '已设置' : '未设置'}`),
      ...review.spec.workers.map(w => h('p', { key: w.id }, `${w.role}：${w.responsibilities.join('；')} · 角色指令${w.role_prompt ? '已设置' : '未设置'}`)),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void save() }, '确认保存草稿'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(null) }, '返回编辑')),
    message && h('p', { role: 'status' }, message))
}

const configurationStyles = `
.kode-collab-team-configuration{padding:24px;max-width:880px;box-sizing:border-box;font-size:14px;line-height:1.6}
.kode-collab-team-configuration h3{font-size:20px;margin:0 0 8px}
.kode-collab-team-configuration p{margin:8px 0 16px;max-width:75ch}
.kode-collab-team-configuration>fieldset{border:0;padding:0;margin:24px 0;min-width:0}
.kode-collab-team-configuration>fieldset>fieldset{border:0;border-top:1px solid var(--dsw-alias-border-l2);padding:16px 0;margin:12px 0;min-width:0}
.kode-collab-team-configuration legend{font-weight:600;font-size:16px;padding:0 12px 0 0}
.kode-collab-team-configuration fieldset label{display:grid;gap:6px;margin:12px 0}
.kode-collab-team-configuration input:not([type=checkbox]),.kode-collab-team-configuration textarea{box-sizing:border-box;display:block;width:100%;padding:8px 10px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.kode-collab-team-configuration input:focus-visible,.kode-collab-team-configuration textarea:focus-visible{outline:2px solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}
.kode-collab-team-configuration small{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kode-collab-team-configuration button{margin:4px 8px 4px 0}
.kode-collab-team-configuration [aria-label=保存确认]{border-top:1px solid var(--dsw-alias-border-l2);margin-top:20px;padding-top:16px}
@media(max-width:640px){.kode-collab-team-configuration{padding:16px}}
`
