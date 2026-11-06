import React from 'react'
import { BuilderPatchRecovery } from './builder-patch-recovery.js'
import { workspaceKey, submitWorkspaces, requestBuilderWorkspaces } from './builder-workspaces.js'
const h = React.createElement
const keyOf = row => JSON.stringify([row.host_id, row.workspace_id])
export function BuilderWorkspaceForm({ draft, storage, request, onSaved, onRefresh }) {
  const [hosts, setHosts] = React.useState([]), [rows, setRows] = React.useState([]), [node, setNode] = React.useState('')
  const [selected, setSelected] = React.useState(draft.interview.workspace_refs), [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const lifetime = React.useRef(null), discovery = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    void Promise.all([storage.read(workspaceKey(draft)), request('/api/kode/builder/workspace-directory?', { signal: controller.signal })]).then(([record, directory]) => {
      if (controller.signal.aborted) return
      if (directory.home_hub !== draft.home_hub || !Array.isArray(directory.hosts)) throw Error('Wrong home')
      setPending(record?.state !== 'accepted' ? record : null); setHosts(directory.hosts); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setError('无法读取工作区目录或保存记录，请刷新后重试。') })
    return () => { controller.abort(); discovery.current?.abort() }
  }, [draft.id, draft.home_hub])
  const chooseHost = async value => {
    discovery.current?.abort(); const controller = new AbortController(); discovery.current = controller
    setNode(value); setRows([]); setError('')
    if (!value) return
    try {
      const result = await request(`/api/kode/builder/workspace-directory?node_id=${encodeURIComponent(value)}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.home_hub !== draft.home_hub || result.node_id !== value || !Array.isArray(result.workspaces) || result.workspaces.some(row => row.host_id !== value)) throw Error('Wrong workspace host')
      setRows(result.workspaces)
    } catch { if (!controller.signal.aborted) setError('此主机的工作区暂时不可用，已有选择仍保留。') }
  }
  const submit = async event => {
    event.preventDefault(); if (running.current || !ready) return
    running.current = true; setBusy(true); setError('')
    try {
      const receipt = await submitWorkspaces({ storage, draft, workspace_refs: selected, request: requestBuilderWorkspaces, signal: lifetime.current.signal })
      if (!lifetime.current.signal.aborted) { setPending(null); setSelected(receipt.interview.workspace_refs); onSaved(receipt) }
    } catch {
      if (!lifetime.current.signal.aborted) { setError('工作区选择尚未确认保存，重试会提交原选择。'); try { setPending(await storage.read(workspaceKey(draft))) } catch {} }
    } finally { running.current = false; if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  return h('form', { className: 'kode-collab-composer kode-collab-workspace-form', onSubmit: submit },
    h('h3', null, '工作区'), h('p', { className: 'kode-collab-note' }, '选择团队使用的工作区。修改后需要重新检查项目并生成方案。'),
    h('label', null, '所在主机', h('select', { value: node, disabled: !ready || busy || !!pending, onChange: event => void chooseHost(event.target.value) }, h('option', { value: '' }, '选择主机'), ...hosts.map(host => h('option', { key: host.node_id, value: host.node_id }, host.name)))),
    ...rows.map(row => h('label', { key: keyOf(row), className: 'kode-collab-workspace-option' }, h('input', { type: 'checkbox', disabled: busy || !!pending, checked: selected.some(value => keyOf(value) === keyOf(row)), onChange: event => setSelected(values => event.target.checked ? [...values.filter(value => keyOf(value) !== keyOf(row)), { host_id: row.host_id, workspace_id: row.workspace_id, root_ref: row.root_ref }] : values.filter(value => keyOf(value) !== keyOf(row))) }), row.name, ' · ', row.root_ref)),
    h('h4', null, pending ? '待确认的原选择' : '已选择'), ...(pending?.command.workspace_refs ?? selected).map(row => h('p', { key: keyOf(row) }, row.host_id, ' · ', row.root_ref,
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setSelected(values => values.filter(value => keyOf(value) !== keyOf(row))) }, '移除'))),
    h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy }, busy ? '正在保存…' : pending ? '重试原工作区选择' : '保存工作区'),
    pending && h(BuilderPatchRecovery, { draft, pending, kind: 'workspaces', storage, storageKey: workspaceKey(draft), onResolved: () => { setSelected(pending.command.workspace_refs); setPending(null); setError(''); onRefresh() } }),
    error && h('p', { role: 'status' }, error))
}
