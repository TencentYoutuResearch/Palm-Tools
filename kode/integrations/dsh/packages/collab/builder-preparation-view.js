import React from 'react'
import { IconButton } from './icons.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { BuilderWorkspaceForm } from './builder-workspace-form.js'
import { BuilderSelectionForm } from './builder-selection-form.js'
import { BuilderAccountForm } from './builder-account-form.js'
import { BuilderFundingForm } from './builder-funding-form.js'
import { builderPreparationSteps, readBuilderPreparation, resolveBuilderPreparation } from './builder-preparation-model.js'

const h = React.createElement

/** One explicit setup task at a time. Keep forms mounted so switching steps preserves unsaved input. */
export function BuilderPreparationView({ draft, storage, request, initialChoice, onDraftUpdated, onReady, onStepChange }) {
  const [snapshot, setSnapshot] = React.useState(null), [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(''), [generation, refresh] = React.useReducer(value => value + 1, 0)
  const [editingStep, setEditingStep] = React.useState(null)
  const callbacks = React.useRef({ onReady, onStepChange, onDraftUpdated })
  callbacks.current = { onReady, onStepChange, onDraftUpdated }
  React.useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void readBuilderPreparation(draft, request, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setSnapshot(value)
    }).catch(() => {
      if (!controller.signal.aborted) setError('暂时无法读取已保存的对话配置（网络或服务暂不可用）。输入仍保留；重新读取只查询配置，不会保存或启动任何内容。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [draft.id, draft.home_hub, draft.revision, request, generation])
  const model = resolveBuilderPreparation({ draft, ...snapshot })
  const snapshotCurrent = snapshot?.draftId === draft.id && snapshot?.home === draft.home_hub && snapshot?.draftRevision === draft.revision
  const ready = snapshotCurrent && !loading && !error && !editingStep && model.ready
  const displayed = editingStep ?? model.step
  React.useEffect(() => { callbacks.current.onReady?.(ready) }, [ready])
  React.useEffect(() => {
    callbacks.current.onStepChange?.({ step: model.step, loading, error: error || model.blocked, runtimeBinding: snapshot?.runtimeBinding ?? null })
  }, [model.step, model.blocked, loading, error, snapshot?.runtimeBinding])
  React.useEffect(() => {
    if (!snapshot?.funding) return
    const expires = Math.min(snapshot.funding.budget?.ends_at ?? Infinity, snapshot.funding.grant?.policy?.expires_at ?? Infinity)
    if (!Number.isFinite(expires) || expires <= Date.now()) return
    const timer = setTimeout(refresh, Math.min(expires - Date.now() + 50, 2147483647))
    return () => clearTimeout(timer)
  }, [snapshot?.funding])
  const saved = () => { setEditingStep(null); setLoading(true); refresh() }
  const workspaceSaved = value => { callbacks.current.onDraftUpdated?.(value); saved() }
  const forms = {
    workspace: h(BuilderWorkspaceForm, { draft, storage, request, onSaved: workspaceSaved, onRefresh: saved }),
    selection: h(BuilderSelectionForm, { draft, storage, request, initialChoice, compact: true, onSaved: saved, onOpenWorkspace: () => setEditingStep('workspace') }),
    account: h(BuilderAccountForm, { draft, storage, request, onSaved: saved }),
    funding: h(BuilderFundingForm, { draft, storage, request, onSaved: saved }),
  }
  return h('section', { className: 'kode-builder-preparation-flow', 'aria-label': '准备搭建对话', 'aria-busy': loading },
    h('p', { className: 'kode-builder-preparation-explanation' }, '先确认对话使用的工作区、助手和内部用量上限。这里只准备搭建对话，不会创建或执行团队。'),
    snapshot && h('ul', { className: 'kode-builder-preparation-summary', 'aria-label': '已确认的对话配置' },
      ...builderPreparationSteps.filter(row => model.completed[row.id]).map(row => h('li', { key: row.id },
        h('span', null, row.label, '：', model.summaries[row.id]),
        !model.funded && h(Button, { type: 'button', variant: 'outline', disabled: loading, onClick: () => setEditingStep(row.id), 'aria-label': '修改' + row.label }, '修改')))),
    loading && h('p', { role: 'status' }, '正在核对已保存的配置…'),
    error && h('div', { role: 'status' }, h('p', null, error), h(IconButton, { icon: 'refresh', label: '重新读取配置', onClick: refresh })),
    !loading && !error && model.blocked && h('p', { role: 'status' }, model.blocked),
    ...builderPreparationSteps.map(row => h('div', { key: row.id, className: 'kode-builder-preparation-step', hidden: !snapshotCurrent || !!error || !!model.blocked || displayed !== row.id },
      editingStep && h(Button, { type: 'button', variant: 'outline', onClick: () => setEditingStep(null) }, '返回当前步骤'),
      h('fieldset', { className: 'kode-builder-step-fields', disabled: loading || !!model.blocked || (model.funded && row.id !== 'account') }, forms[row.id]))),
    ready && !editingStep && h('p', { role: 'status' }, '配置已核对。确认下面的启动信息后，才会启动真实模型对话。'))
}
