/** Team Builder's local planning instruction: owner-only GET/PUT /api/kode/builder/settings.
 * The built-in base instruction always loads (read-only here; it carries the safety and output protocol);
 * `system_prompt` is only the preference appended after it (`prompt_mode: 'append'`).
 * A new planning Session freezes the revision it starts with; existing Sessions never change.
 * Stored in local preferences only, never in the Hub agents document. */
import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { RolePromptField, rolePromptStyles, utf8Bytes, PROMPT_MAX_BYTES } from './role-prompt-fields.js'
import { IconButton } from './icons.js'
const h = React.createElement
const PATH = '/api/kode/builder/settings'

export function parseBuilderSettings(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.system_prompt !== 'string'
    || value.scope !== 'local_host' || value.applies_to !== 'new_planning_sessions') throw Object.assign(Error('无法识别 Team Builder 设置，没有显示或修改。'), { invalid: true })
  // Base-instruction fields are optional (older services omit them); when present they must say "append".
  const base = value.default_system_prompt
  if ((value.prompt_mode !== undefined && value.prompt_mode !== 'append') || (base !== undefined && typeof base !== 'string')
    || (value.default_system_prompt_version !== undefined && typeof value.default_system_prompt_version !== 'string'))
    throw Object.assign(Error('无法识别 Team Builder 设置，没有显示或修改。'), { invalid: true })
  return { revision: value.revision, systemPrompt: value.system_prompt,
    defaultPrompt: typeof base === 'string' && base.trim() ? base : null, defaultVersion: value.default_system_prompt_version ?? null }
}

async function call(method, body, { signal, fetcher = globalThis.fetch } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetcher(PATH, { method, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const value = await response.json().catch(() => null)
    if (!response.ok) throw Object.assign(Error(value?.error?.message ?? value?.message ?? `Team Builder 设置请求失败 (${response.status})`),
      { status: response.status, code: value?.error?.code ?? value?.code })
    return value
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export const readBuilderSettings = options => call('GET', null, options).then(parseBuilderSettings)

/** PUT with CAS. Conflict → reread; uncertain (409 UNCERTAIN, timeout, network) → GET decides;
 * the same PUT may be repeated. Resolves only once the server holds exactly `systemPrompt`. */
export async function saveBuilderSettings({ expectedRevision, systemPrompt }, options = {}) {
  if (utf8Bytes(systemPrompt) > PROMPT_MAX_BYTES) throw Object.assign(Error(`超过 ${PROMPT_MAX_BYTES} 字节上限，没有保存。`), { status: 400 })
  try {
    const saved = parseBuilderSettings(await call('PUT', { expected_revision: expectedRevision, system_prompt: systemPrompt }, options))
    if (saved.systemPrompt !== systemPrompt || saved.revision <= expectedRevision) throw Object.assign(Error('服务返回的设置与提交内容不一致。'), { uncertain: true })
    return saved
  } catch (failure) {
    // Definite refusals: input, ownership, absent route, or a revision conflict (caller rereads).
    if ([400, 401, 403, 404, 405].includes(failure.status) || failure.code === 'BUILDER_SETTINGS_CONFLICT' || options.signal?.aborted) throw failure
    // Outcome unknown: the server's current value decides; never report a save it doesn't hold.
    const current = await readBuilderSettings(options).catch(() => null)
    if (current && current.systemPrompt === systemPrompt && current.revision > expectedRevision) return current
    throw Object.assign(Error('无法确认是否已保存。'), { uncertain: true, current })
  }
}

/** Settings group: the built-in base instruction (read-only) and the local preference appended after it.
 * Absent backend → says so, no editor. */
export function BuilderPromptSettings({ read = readBuilderSettings, save = saveBuilderSettings }) {
  const [state, setState] = React.useState({ phase: 'loading' }), [text, setText] = React.useState(''), [busy, setBusy] = React.useState(false)
  const [editing, setEditing] = React.useState(false), [expanded, setExpanded] = React.useState(false)
  const [message, setMessage] = React.useState(''), [retry, setRetry] = React.useState(false), [generation, reload] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    const controller = new AbortController(); setState({ phase: 'loading' })
    read({ signal: controller.signal }).then(value => { if (controller.signal.aborted) return; setState({ phase: 'ready', ...value }); setText(value.systemPrompt) },
      failure => { if (!controller.signal.aborted) setState({ phase: failure.status === 404 || failure.status === 405 ? 'unsupported' : 'error', error: failure.message }) })
    return () => controller.abort()
  }, [read, generation])
  const changed = state.phase === 'ready' && text !== state.systemPrompt, over = utf8Bytes(text) > PROMPT_MAX_BYTES
  // The built-in text is always loaded first; a pasted copy would be appended to it a second time.
  const duplicate = state.phase === 'ready' && !!state.defaultPrompt?.trim() && text.includes(state.defaultPrompt.trim())
  const submit = async value => {
    if (busy || state.phase !== 'ready') return
    setBusy(true); setMessage(''); setRetry(false)
    try {
      const saved = await save({ expectedRevision: state.revision, systemPrompt: value })
      setState({ phase: 'ready', ...saved }); setText(saved.systemPrompt); setEditing(false)
      setMessage(saved.systemPrompt ? '已保存补充指令。之后开始的规划会话会在内建规划指令之后加载它；已开始的规划不受影响。' : '已移除补充指令。之后开始的规划会话只加载内建规划指令；已开始的规划不受影响。')
    } catch (failure) {
      if (failure.code === 'BUILDER_SETTINGS_CONFLICT') {
        setMessage('设置已在其它窗口更改，这次没有保存。已重新读取服务上的版本；你的编辑仍在输入框中，请核对后再保存。')
        read().then(value => setState({ phase: 'ready', ...value })).catch(() => reload())
      } else if (failure.uncertain) {
        if (failure.current) setState({ phase: 'ready', ...failure.current })
        setRetry(!failure.current || failure.current.revision === state.revision)
        setMessage(failure.current ? '服务上没有这次的修改，未保存。' : '无法确认是否已保存。可以重试同一次保存（不会重复生效），或重新读取后核对。')
      } else setMessage(failure.message || '未保存，请重试。')
    } finally { setBusy(false) }
  }
  const group = (...children) => h('div', { className: 'kode-settings-group kode-builder-prompt-settings', 'aria-label': '规划指令' },
    h('style', null, rolePromptStyles + promptStyles), h('h3', { className: 'kode-settings-group-title' }, '规划指令'), ...children)
  if (state.phase === 'loading') return group(h('p', { className: 'kode-config-note', role: 'status' }, '正在读取 Team Builder 设置…'))
  if (state.phase === 'unsupported') return group(h('p', { className: 'kode-config-note', role: 'status' }, '当前 Kode 服务还不支持保存补充指令。规划会话照常加载内建规划指令；更新服务后可在这里添加补充指令。'))
  if (state.phase === 'error') return group(h('p', { className: 'kode-config-note', role: 'status' }, state.error || '无法读取 Team Builder 设置。', ' ', h(IconButton, { icon: 'refresh', label: '重新读取', onClick: reload })))
  const cancel = () => { setText(state.systemPrompt); setEditing(false); setMessage(''); setRetry(false) }
  return group(h('div', { className: 'kode-settings-card' },
    h('div', { className: 'kode-integration-row kode-builder-prompt-row' },
      h('span', null, h('strong', null, '内建规划指令'),
        h('small', { className: 'kode-config-note' }, '每次规划都会先加载这段内建指令，其中包含安全规则和输出格式，不能修改或关闭。' + (state.defaultVersion ? ` 版本 ${state.defaultVersion}` : '')),
        state.defaultPrompt
          ? h(React.Fragment, null,
            h('pre', { className: 'kode-builder-prompt-text', 'data-expanded': expanded || undefined, tabIndex: 0, 'aria-label': '内建规划指令全文' }, state.defaultPrompt),
            h(Button, { variant: 'text', className: 'kode-builder-prompt-toggle', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) }, expanded ? '收起' : '展开全文'))
          : h('small', { className: 'kode-config-note', role: 'status' }, '当前 Kode 服务没有提供内建规划指令原文，规划仍会加载它；更新服务后可以在这里阅读。'))),
    h('div', { className: 'kode-integration-row kode-builder-prompt-row' },
      h('span', null, h('strong', null, '补充指令'),
        h('small', { className: 'kode-config-note' }, '追加在内建规划指令之后，只保存在这台电脑。只能补充偏好，不能覆盖安全规则、输出格式、权限与授权，也不改变规划所用的 Agent 或模型。之后开始的规划会话会固定加载当时的版本；已开始的规划不会改变。'),
        !editing && (state.systemPrompt
          ? h('p', { className: 'kode-builder-prompt-text kode-builder-prompt-append' }, state.systemPrompt)
          : h('small', { className: 'kode-config-note' }, '未添加补充指令。'))),
      !editing && h(IconButton, { icon: 'edit', label: '编辑补充指令', disabled: busy, onClick: () => { setEditing(true); setMessage('') } })),
    editing && h(React.Fragment, null,
      h(RolePromptField, { label: '补充指令内容', value: text, onChange: value => { setText(value); setMessage(''); setRetry(false) }, disabled: busy,
        placeholder: '例如：优先拆成两到三名成员；每个成员写清验收方式。' }),
      h('div', { className: 'kode-builder-prompt-actions' },
        h(Button, { variant: 'text', disabled: busy, onClick: cancel }, '取消'),
        state.systemPrompt && h(Button, { variant: 'outline', disabled: busy, onClick: () => void submit('') }, '移除补充指令'),
        retry ? h(Button, { variant: 'primary', disabled: busy, onClick: () => void submit(text) }, busy ? '正在保存…' : '重试保存')
          : h(Button, { variant: 'primary', disabled: busy || !changed || over || duplicate, onClick: () => void submit(text) }, busy ? '正在保存…' : '保存')))),
    editing && duplicate && h('p', { className: 'kode-config-note', role: 'alert' }, '补充指令里包含了整段内建规划指令。内建指令每次都会自动加载，请只保留要补充的内容。'),
    message && h('p', { className: 'kode-config-note', role: 'status' }, message))
}

const promptStyles = `
.kode-builder-prompt-row>span{min-width:0;flex:1;display:grid;gap:4px}
.kode-builder-prompt-text{margin:4px 0 0;padding:8px 10px;max-height:120px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-l1,transparent);border-radius:var(--dsw-radius-sm)}
.kode-builder-prompt-text[data-expanded]{max-height:none}
.kode-builder-prompt-append{max-height:none;color:inherit}
.kode-builder-prompt-toggle{justify-self:start}
.kode-settings-card>.kode-role-prompt{margin:4px 0 0!important}
.kode-settings-card>.kode-builder-prompt-actions{padding:12px 0 16px}
`
