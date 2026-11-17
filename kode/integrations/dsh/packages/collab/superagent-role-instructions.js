import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconButton } from './icons.js'
import { RolePromptField, ROLE_PROMPT_NOTE, promptTooLong, promptValue, rolePromptStyles } from './role-prompt-fields.js'
import { configurationKey, prepareConfiguration, saveConfiguration } from './team-configuration.js'
import { readTeamConfiguration, teamRoleRows, SUPERAGENT_ROLE } from './team-agent-defaults.js'
const h = React.createElement

/**
 * Role instructions read, edited and saved in place in the SuperAgent settings tab.
 * The write is the same versioned team-configuration command the team form sends
 * (prepareConfiguration + saveConfiguration: expected_revision CAS, one durable storage
 * record per base revision, receipt checked against the command): it only creates the
 * next draft revision. It changes no Agent, model, worker, permission or activation.
 * One row is edited at a time; cancel discards that row's unsaved text only.
 */
export function SuperagentRoleInstructions({ team, request, storage, onSaved }) {
  const [config, setConfig] = React.useState(null), [error, setError] = React.useState(''), [generation, reload] = React.useReducer(value => value + 1, 0)
  const [pending, setPending] = React.useState(undefined), [editing, setEditing] = React.useState(null), [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    setError(''); setPending(undefined)
    readTeamConfiguration(request, team, controller.signal).then(async row => {
      const record = await storage.read(configurationKey(row))
      if (!controller.signal.aborted) { setConfig(row); setPending(record ?? null) }
    }).catch(() => { if (!controller.signal.aborted) { setConfig(null); setError('无法读取团队当前的角色指令，没有显示或修改任何内容。') } })
    return () => controller.abort()
  }, [request, storage, team.id, team.home_hub, generation])
  const current = role => role.id === SUPERAGENT_ROLE ? config?.spec?.coordinator_prompt : config?.spec?.workers?.find(row => row.id === role.id)?.role_prompt
  const commit = async command => {
    if (busy) return
    setBusy(true); setMessage('')
    try {
      const row = await saveConfiguration({ team: config, command, storage, signal: active.current.signal })
      if (active.current.signal.aborted) return
      setConfig(row); setPending(null); setEditing(null); setText('')
      setMessage(`已保存为第 ${row.revision} 版草稿，尚未生效。核对激活条件并激活后，新指令才会用于之后的运行。`)
      onSaved?.(row)
    } catch {
      if (active.current.signal.aborted) return
      setMessage('保存结果尚未确认，输入仍保留。可恢复原保存请求；如团队已在别处更新，请重新读取后再编辑。')
      try { setPending(await storage.read(configurationKey(config)) ?? null) } catch {}
    } finally { if (!active.current.signal.aborted) setBusy(false) }
  }
  const save = role => {
    let command
    try {
      const workers = config.spec.workers.map(row => row.id === role.id ? { ...row, role_prompt: text } : row)
      command = prepareConfiguration(config, workers, crypto.randomUUID(), role.id === SUPERAGENT_ROLE ? text : undefined)
    } catch { setMessage('团队配置不完整或超出大小上限，无法在这里保存。请展开高级设置检查职责与执行资源。'); return }
    void commit(command)
  }
  const roles = config ? teamRoleRows(config) : []
  const row = role => {
    const value = promptValue(current(role)), open = editing === role.id
    const label = role.id === SUPERAGENT_ROLE ? `${role.label}（SuperAgent）` : role.label
    if (open) return h('div', { key: role.id, className: 'kode-integration-row kode-role-instruction-row', 'data-role-instruction': role.id, 'data-editing': '' },
      h(RolePromptField, { label: `${label} 的指令`, value: text, disabled: busy, onChange: setText, placeholder: role.id === SUPERAGENT_ROLE ? '例如：先确认范围，再分配给成员。' : undefined }),
      h('div', { className: 'kode-collab-row-actions' },
        h(Button, { variant: 'outline', disabled: busy, onClick: () => { setEditing(null); setText(''); setMessage('') } }, '取消'),
        h(Button, { variant: 'primary', disabled: busy || promptTooLong(text) || (promptValue(text) ?? '') === (value ?? ''), onClick: () => save(role) }, busy ? '正在保存…' : '保存为新草稿')))
    return h('div', { key: role.id, className: 'kode-integration-row', 'data-role-instruction': role.id },
      h('span', null, h('strong', null, label),
        h('span', { className: 'kode-config-note kode-role-instruction-preview', 'data-empty': value ? undefined : '' }, value ?? '未设置角色指令')),
      h(IconButton, { icon: 'edit', label: `编辑 ${label} 的指令`, disabled: !!editing || busy || pending !== null,
        onClick: () => { setEditing(role.id); setText(value ?? ''); setMessage('') } }))
  }
  return h('div', { className: 'kode-settings-group kode-role-instructions', 'aria-label': '角色指令' },
    h('style', null, rolePromptStyles + roleInstructionStyles),
    h('h3', { className: 'kode-settings-group-title' }, '角色指令'),
    h('p', { className: 'kode-config-note' }, ROLE_PROMPT_NOTE, config ? ` 当前基于团队第 ${config.revision} 版；保存会生成下一版草稿，激活后才生效。` : ''),
    error ? h('div', { className: 'kode-role-instructions-error' },
      h('p', { className: 'kode-config-note', role: 'status' }, error),
      h(Button, { variant: 'outline', disabled: busy, onClick: () => { setMessage(''); reload() } }, '重试读取'))
      : !config || pending === undefined ? h('p', { className: 'kode-config-note', role: 'status' }, '正在读取角色指令…')
        : h('div', { className: 'kode-settings-card' },
          pending && h('div', { className: 'kode-integration-row', 'data-role-instruction-pending': pending.state },
            h('span', null, h('strong', null, pending.state === 'saved' ? '有一版已保存的草稿尚未载入' : '有一次未确认的保存'),
              h('span', { className: 'kode-config-note' }, '为避免重复写入，编辑前先完成这次请求。它只会按原内容再确认一次，不会生成第二份草稿。')),
            h(Button, { variant: 'outline', disabled: busy, onClick: () => void commit(pending.command) }, pending.state === 'saved' ? '读取已保存版本' : '恢复原保存请求')),
          roles.map(row)),
    message && h('p', { className: 'kode-config-note', role: 'status' }, message))
}

const roleInstructionStyles = `
.kode-role-instructions-error{display:flex;align-items:center;justify-content:space-between;gap:12px}
.kode-role-instructions-error p{margin:0}
.kode-role-instruction-preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}
.kode-role-instruction-preview[data-empty]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.kode-role-instruction-row{flex-direction:column;align-items:stretch}
.kode-role-instruction-row .kode-role-prompt{margin:0}
.kode-role-instruction-row .kode-collab-row-actions{display:flex;justify-content:flex-end;gap:8px}
`
