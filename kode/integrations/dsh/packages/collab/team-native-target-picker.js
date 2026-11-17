import React from 'react'
import { IconButton } from './icons.js'
import { readNativeCatalog, nativeConfigurationTarget } from './team-native-target.js'
const h = React.createElement
/** Read only until the parent form is explicitly reviewed and saved. */
export function TeamNativeTargetPicker({ team, controls, disabled, onAdd }) {
  const [metadata, setMetadata] = React.useState(null)
  const [catalog, setCatalog] = React.useState(null), [profile, setProfile] = React.useState(''), [model, setModel] = React.useState('')
  const [effort, setEffort] = React.useState(''), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null)
  React.useEffect(() => () => active.current?.abort(), [team.id, team.revision, team.home_hub])
  const load = async profileId => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError(''); setCatalog(null); setProfile(profileId ?? ''); setModel(''); setEffort('')
    try { const [value, native] = await Promise.all([readNativeCatalog(team, profileId, controller.signal), controls.readAgentConfiguration({ host: 'local' })]); if (!controller.signal.aborted) { setCatalog(value); setMetadata(native) } }
    catch { if (!controller.signal.aborted) setError('无法核实原生 CLI / 模型目录，请重新读取。未添加任何资源。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const selected = catalog?.selected_profile?.id === profile ? catalog.models.find(row => row.id === model) : null
  const profiles = (catalog?.profiles ?? []).map(row => ({ ...row, ...metadata?.profiles?.find(native => native.id === row.id), id: row.id, type: row.type }))
  const data = { profiles, selectedProfileId: profile, currentProfile: profiles.find(row => row.id === profile), canChangeAgent: true,
    types: metadata?.types ?? {}, supportedTypes: metadata?.supportedTypes ?? [],
    models: (catalog?.selected_profile?.id === profile ? catalog.models : []).map(row => ({ ...row, reasoningEfforts: row.reasoningEfforts?.map(value => typeof value === 'string' ? { id: value, name: value } : value) })),
    selection: { model, reasoningEffort: effort || undefined } }
  const lockedReason = disabled || busy ? '正在读取或保存配置' : undefined
  if (!controls?.AgentPicker || !controls?.ModelPicker || !controls?.readAgentConfiguration) return h('p', { role: 'status' }, '原生 Agent 与模型控件尚未就绪，请重新打开设置。')
  return h('fieldset', { disabled: disabled || busy, 'aria-label': '新增原生执行资源' },
    h('legend', null, '新增原生 CLI / 模型'),
    h('p', null, '仅从本机已核实目录添加；保存不会启动会话、发送消息或授予权限。'),
    h(IconButton, { icon: 'refresh', label: busy ? '正在读取目录…' : '读取原生 CLI / 模型目录', disabled: disabled || busy, onClick: () => void load() }),
    catalog && h(controls.AgentPicker, { data, busy, lockedReason, scopeKey: `team-target:${team.id}:${team.revision}`, onSelect: id => void load(id) }),
    catalog?.selected_profile && h(controls.ModelPicker, { data, busy, lockedReason, scopeKey: `team-target-model:${team.id}:${team.revision}:${profile}`, onSelect: patch => {
      const modelId = patch.model ?? model, nextEffort = patch.reasoningEffort ?? (modelId === model ? effort : '')
      if (!catalog.models.some(row => row.id === modelId)) return
      setModel(modelId); setEffort(nextEffort)
    } }),
    selected && h('button', { type: 'button', onClick: () => {
      try { const addition = { catalog, modelId: model, effort: effort || null, id: crypto.randomUUID() }; nativeConfigurationTarget(team, addition); onAdd(addition); setModel(''); setEffort(''); setError('') }
      catch { setError('目录已变化，请重新读取后选择。') }
    } }, '加入待保存资源'),
    error && h('p', { role: 'status' }, error))
}
