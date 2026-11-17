import React from 'react'
import { IconButton } from './icons.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { canonical } from './builder-accept-command.js'
import { readProposalCandidate, saveProposalCandidate, candidateSaveKey, candidateError, applyCandidateForm, candidateProblems, stateText, toForm } from './builder-candidate.js'
import { RolePromptField, ROLE_PROMPT_NOTE, PROMPT_MAX_BYTES, TEAM_MAX_BYTES, rolePromptStyles } from './role-prompt-fields.js'
const h = React.createElement

/**
 * Reads the candidate, lets the owner edit each role in a readable form and saves only on
 * an explicit confirmation. Nothing here posts, accepts, authorizes or starts by itself.
 */
export function BuilderCandidateReview({ draft, storage, onSaved, onRefresh }) {
  const [read, setRead] = React.useState({ state: 'loading' }), [generation, reload] = React.useReducer(value => value + 1, 0)
  const [source, setSource] = React.useState(null), [form, setForm] = React.useState(null), [confirming, setConfirming] = React.useState(false)
  const [pending, setPending] = React.useState(undefined), [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(null)
  const lifetime = React.useRef(null)
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    // A new revision (or re-read) ends any confirmation and every in-flight save of the old scope.
    // An open form stays visible but is bound to the revision it was read at; it never moves forward.
    setRead({ state: 'loading' }); setPending(undefined); setConfirming(false); setBusy(false)
    storage.read(candidateSaveKey(draft)).then(row => { if (!controller.signal.aborted) setPending(row ?? null) }).catch(() => { if (!controller.signal.aborted) setPending({ unreadable: true }) })
    readProposalCandidate(draft, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setRead({ state: 'ok', value }) },
      error => { if (!controller.signal.aborted) setRead({ state: 'error', message: candidateError(error) }) })
    return () => controller.abort()
  }, [draft.id, draft.home_hub, draft.revision, generation])
  const value = read.value, limits = { prompt: value?.prompt_max_bytes ?? PROMPT_MAX_BYTES, team: value?.team_max_bytes ?? TEAM_MAX_BYTES }
  const stale = value && value.draft_revision !== draft.revision
  /** The review is bound to the read it came from: the draft revision and the reply it was parsed from. */
  const open = (kind, spec, workflow) => { setSource({ kind, spec, workflow, revision: value.draft_revision, reply: value.source ?? null }); setForm(toForm(spec)); setConfirming(false); setNotice(null) }
  const expired = !!source && source.revision !== draft.revision
  const discard = () => { setForm(null); setSource(null); setConfirming(false) }
  const edit = changes => { setConfirming(false); setForm(current => ({ ...current, ...changes })) }
  const editWorker = (id, changes) => edit({ workers: form.workers.map(row => row.id === id ? { ...row, ...changes } : row) })
  const problems = form ? candidateProblems(source.spec, form, limits) : []
  const command = () => ({ draft_id: draft.id, request_id: crypto.randomUUID(), expected_revision: source.revision, proposed_team: applyCandidateForm(source.spec, form),
    ...(source.workflow ? { proposed_workflow: source.workflow } : {}) })
  const save = async recovered => {
    // An edit read at another revision is never submitted against the current one.
    if (busy || !recovered && (!source || expired)) return
    setBusy(true); setNotice(null)
    const signal = lifetime.current.signal, scope = draft
    try {
      const row = await saveProposalCandidate({ draft: scope, command: recovered ?? command(), storage, signal })
      if (signal.aborted) return
      setForm(null); setSource(null); setConfirming(false)
      setNotice({ revision: row.revision, text: `已保存为草案第 ${row.revision} 版的团队方案。它还不是团队：请在下方核对并接受。原生交互团队通过频道与私信协作；受控执行团队仍需单独激活。` })
      onSaved?.(row)
    } catch (error) {
      if (signal.aborted) return
      setNotice({ revision: scope.revision, text: candidateError(error) })
      try {
        const row = await storage.read(candidateSaveKey(scope))
        // A late record of an earlier scope must not land on a newer revision.
        if (!signal.aborted) setPending(row ?? null)
      } catch {}
    } finally { if (!signal.aborted) setBusy(false) }
  }
  const sameAsSaved = value?.candidate && value.saved_proposal && canonical(value.candidate.proposed_team) === canonical(value.saved_proposal)
  return h('section', { className: 'kode-builder-candidate', 'aria-label': '方案候选' },
    h('style', null, candidateStyles + rolePromptStyles),
    h('h4', null, '规划会话中的方案候选'),
    h('p', { className: 'kode-config-note' }, '只读取规划会话最近一条已完成回复中的公开内容。候选需要你审核、编辑并明确保存；不会自动保存、接受、授权或启动。'),
    pending?.command && pending.state === 'prepared' && h('div', { className: 'kode-integration-row', role: 'status' },
      h('span', null, h('strong', null, '上次保存没有收到确认'), h('span', { className: 'kode-config-note' }, '可能已保存，也可能没有。恢复会原样重发上次的请求：已保存就读取结果，未保存只保存一次。')),
      h(Button, { variant: 'primary', disabled: busy, onClick: () => void save(pending.command) }, '恢复原保存请求')),
    read.state === 'loading' && h('p', { className: 'kode-config-note', role: 'status' }, '正在读取规划会话的最近回复…'),
    read.state === 'error' && h('p', { role: 'status', 'data-candidate-state': 'error' }, read.message, ' ', h(IconButton, { icon: 'refresh', label: '重新读取', onClick: reload })),
    read.state === 'ok' && stale && h('p', { role: 'status', 'data-candidate-state': 'stale' }, `草案已更新到第 ${value.draft_revision} 版，这里显示的是第 ${draft.revision} 版。请先刷新草案；没有保存任何内容。`, ' ',
      onRefresh && h(IconButton, { icon: 'refresh', label: '刷新草案', onClick: onRefresh })),
    read.state === 'ok' && !stale && !form && h('div', { 'data-candidate-state': value.state },
      value.state === 'candidate' ? h('div', { className: 'kode-integration-row' },
        h('span', null, h('strong', null, sameAsSaved ? '候选与已保存方案相同' : '有一份新的方案候选'),
          h('span', { className: 'kode-config-note' }, `${value.candidate.proposed_team.name || '未命名团队'} · ${(value.candidate.proposed_team.workers ?? []).length} 个成员${value.source ? ` · 来自第 ${value.source.turn} 轮回复` : ''}`)),
        h('div', { className: 'kode-collab-row-actions' }, h(IconButton, { icon: 'refresh', label: '重新读取', disabled: busy, onClick: reload }),
          h(Button, { variant: sameAsSaved ? 'outline' : 'primary', disabled: busy || pending?.state === 'prepared', onClick: () => open('candidate', value.candidate.proposed_team, value.candidate.proposed_workflow) }, '审核并编辑')))
        : h('p', { className: 'kode-config-note', role: 'status' }, stateText[value.state], ' ', h(IconButton, { icon: 'refresh', label: '重新读取', disabled: busy, onClick: reload })),
      value.saved_proposal && !value.candidate && h('div', { className: 'kode-integration-row' },
        h('span', null, h('strong', null, '已保存的团队方案'), h('span', { className: 'kode-config-note' }, '可以调整成员职责与角色指令，保存后成为草案的新版本。')),
        h(Button, { variant: 'outline', disabled: busy || pending?.state === 'prepared', onClick: () => open('saved', value.saved_proposal) }, '编辑已保存方案'))),
    form && expired && h('div', { className: 'kode-integration-row', role: 'alert', 'data-candidate-state': 'expired' },
      h('span', null, h('strong', null, `这份编辑基于草案第 ${source.revision} 版，草案现在是第 ${draft.revision} 版`),
        h('span', { className: 'kode-config-note' }, '为避免把旧方案保存到新版本，这份编辑已不能保存。你的输入仍保留在下方，可复制后重新读取，按新版本重新审核。')),
      h(Button, { variant: 'primary', onClick: () => { discard(); reload() } }, '重新读取并审核')),
    form && h('form', { className: 'kode-builder-candidate-form', 'data-bound-revision': source.revision, onSubmit: event => event.preventDefault() },
      h('p', { className: 'kode-config-note' }, source.kind === 'candidate' ? '正在审核规划会话给出的候选。' : '正在编辑已保存的团队方案。', ' 工作区、执行资源、流程与策略按原样保留，可在保存后的方案摘要中核对。'),
      h('label', null, '团队名称', h('input', { value: form.name, readOnly: expired, maxLength: 160, onChange: event => edit({ name: event.target.value }) })),
      h('label', null, '团队目标', h('textarea', { value: form.purpose, readOnly: expired, rows: 2, onChange: event => edit({ purpose: event.target.value }) })),
      h('p', { className: 'kode-config-note' }, ROLE_PROMPT_NOTE),
      h('fieldset', { 'data-role-prompt': 'coordinator' }, h('legend', null, '协调者（SuperAgent）'),
        h(RolePromptField, { label: '协调者指令', readOnly: expired, value: form.coordinator_prompt, max: limits.prompt, onChange: text => edit({ coordinator_prompt: text }) })),
      ...form.workers.map(row => h('fieldset', { key: row.id, 'data-role-prompt': row.id }, h('legend', null, row.role || row.id),
        h('label', null, '职责名称', h('input', { value: row.role, readOnly: expired, maxLength: 160, onChange: event => editWorker(row.id, { role: event.target.value }) })),
        h('label', null, '职责说明（每行一项）', h('textarea', { value: row.responsibilities, readOnly: expired, rows: 3, onChange: event => editWorker(row.id, { responsibilities: event.target.value }) })),
        h(RolePromptField, { label: '角色指令', readOnly: expired, value: row.role_prompt, max: limits.prompt, onChange: text => editWorker(row.id, { role_prompt: text }) }))),
      source.workflow && h('p', { className: 'kode-config-note' }, '候选附带的工作流会一并保存为草案内容，不会自动执行。'),
      problems.length > 0 && h('ul', { className: 'kode-builder-candidate-problems', role: 'status' }, ...problems.map(text => h('li', { key: text }, text))),
      expired ? null : confirming ? h('div', { role: 'region', 'aria-label': '保存确认', className: 'kode-builder-candidate-confirm' },
        h('p', null, `将基于草案第 ${draft.revision} 版保存为第 ${draft.revision + 1} 版的团队方案。这不会接受团队，也不会授权或启动任务。`),
        h(Button, { variant: 'primary', disabled: busy, onClick: () => void save() }, busy ? '正在保存…' : '确认保存方案'),
        h(Button, { variant: 'text', disabled: busy, onClick: () => setConfirming(false) }, '返回编辑'))
        : h('div', { className: 'kode-builder-candidate-actions' },
          h(Button, { variant: 'primary', disabled: busy || problems.length > 0, onClick: () => setConfirming(true) }, '核对并保存'),
          h(Button, { variant: 'text', disabled: busy, onClick: discard }, '放弃编辑'))),
    // A notice belongs to the revision it was produced for; it never describes a newer one.
    notice?.revision === draft.revision && h('p', { role: 'status' }, notice.text))
}

const candidateStyles = `
.kode-builder-candidate{display:grid;gap:8px;margin:0 0 24px;padding-bottom:16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-builder-candidate h4{margin:0;font-size:14px;font-weight:600}
.kode-builder-candidate p{margin:0}
.kode-builder-candidate .kode-collab-row-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}
.kode-builder-candidate-form{display:grid;gap:4px;min-width:0}
.kode-builder-candidate-form>label{display:grid;gap:6px;margin:8px 0}
.kode-builder-candidate-form fieldset{border:0;border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 0;margin:8px 0 0;min-width:0}
.kode-builder-candidate-form fieldset label{display:grid;gap:6px;margin:10px 0}
.kode-builder-candidate-form legend{font-weight:600;padding:0 12px 0 0}
.kode-builder-candidate-form input,.kode-builder-candidate-form label>textarea{box-sizing:border-box;width:100%;padding:8px 10px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.kode-builder-candidate-form input:focus-visible,.kode-builder-candidate-form label>textarea:focus-visible{outline:2px solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}
.kode-builder-candidate-problems{margin:8px 0;padding-left:20px;font-size:13px}
.kode-builder-candidate-actions,.kode-builder-candidate-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.kode-builder-candidate-confirm p{flex-basis:100%}
`
