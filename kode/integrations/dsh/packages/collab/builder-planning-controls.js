import React from 'react'
import { planningChoiceKey } from './builder-planning.js'
import { planningSelection } from './builder-planning-handoff.js'
const h = React.createElement

/** Agent = native CLI profile; model = that profile's real catalog. Both come from
 * the native /api/kode/agents configuration view; nothing is merged per role. */
/** `fast`: only a consumer that submits Fast gets the native Fast switch; others get no inert toggle. */
export function usePlanningChoice({ controls, storage, home, draftId, host = 'local', choiceKey, fast: fastSubmitted = false }) {
  const [base, setBase] = React.useState(null), [profileData, setProfileData] = React.useState(null)
  const [stored, setStored] = React.useState(undefined), [error, setError] = React.useState(''), [storageError, setStorageError] = React.useState('')
  const key = choiceKey ?? planningChoiceKey(home, draftId)
  React.useEffect(() => {
    let alive = true; setStored(undefined); setStorageError('')
    storage.read(key).then(value => { if (alive) setStored(value ?? null) }).catch(() => { if (alive) { setStored(null); setStorageError('无法读取已选的 Agent 与模型，将使用原生默认值。') } })
    return () => { alive = false }
  }, [key])
  React.useEffect(() => {
    if (!controls?.readAgentConfiguration) return
    let alive = true; setError('')
    controls.readAgentConfiguration({ host }).then(value => { if (alive) setBase(value) }).catch(failure => { if (alive) setError(failure.message || '无法读取 Agent 列表。') })
    return () => { alive = false }
  }, [controls, host])
  const profiles = (base?.profiles ?? []).filter(row => !base?.supportedTypes || base.supportedTypes.includes(row.type))
  const profileId = profiles.some(row => row.id === stored?.profileId) ? stored.profileId
    : profiles.some(row => row.id === base?.selectedProfileId) ? base.selectedProfileId : profiles[0]?.id ?? ''
  React.useEffect(() => {
    if (!profileId || !controls?.readAgentConfiguration) { setProfileData(null); return }
    let alive = true; setProfileData(null)
    controls.readAgentConfiguration({ host, profileId }).then(value => { if (alive) setProfileData({ profileId, value }) })
      .catch(failure => { if (alive) setProfileData({ profileId, failure: failure.message || '无法读取此 Agent 的模型。' }) })
    return () => { alive = false }
  }, [controls, host, profileId])
  const catalog = profileData?.profileId === profileId ? profileData : null
  const models = catalog?.value?.models ?? [], defaults = catalog?.value?.defaultModelSelection
  const sameProfile = stored?.profileId === profileId
  const model = sameProfile && models.some(row => row.id === stored.model) ? stored.model : models.some(row => row.id === defaults?.model) ? defaults.model : ''
  const efforts = models.find(row => row.id === model)?.reasoningEfforts ?? []
  const effort = sameProfile && stored.model === model && efforts.some(row => row.id === stored.reasoningEffort) ? stored.reasoningEffort
    : model === defaults?.model && efforts.some(row => row.id === defaults?.reasoningEffort) ? defaults.reasoningEffort : undefined
  const fastCapable = fastSubmitted && !!models.find(row => row.id === model)?.fastCapability
  const fast = fastCapable && sameProfile && stored.model === model && typeof stored.fast === 'boolean' ? stored.fast : undefined
  // With Fast submitted, display, storage and the request all hold the one resolved selection.
  const chosen = (fastSubmitted && model && planningSelection(models, { model, ...(effort ? { reasoningEffort: effort } : {}), ...(fast === undefined ? {} : { fast }) }))
    || { model, ...(effort ? { reasoningEffort: effort } : {}), ...(fast === undefined ? {} : { fast }) }
  const save = next => { setStored(next); storage.save(key, next).catch(() => setStorageError('选择未能保存到本机，本次仍按当前选择使用。')) }
  const modelError = catalog?.failure || catalog?.value?.modelError || (catalog?.value && !models.length ? '此 Agent 当前没有可用模型。' : '')
  const loading = stored === undefined || (!base && !error) || (!!profileId && !catalog)
  const profile = profiles.find(row => row.id === profileId)
  return {
    loading, error: error || (!loading && !profiles.length ? '暂无可用 Agent，请先在 Kode 设置 · Agent 中配置。' : ''), modelError, storageError,
    ready: !loading && !error && !!profile && !!model,
    choice: { profileId, ...chosen },
    profileName: profile?.name ?? '', modelName: models.find(row => row.id === chosen.model)?.name ?? chosen.model,
    pickerData: { ...(catalog?.value ?? base ?? {}), profiles, currentProfile: profile, selectedProfileId: profileId, canChangeAgent: true, fast: chosen.fast,
      models: fastSubmitted ? models : models.map(({ fastCapability, ...row }) => row),
      selection: { provider: models.find(row => row.id === chosen.model)?.provider, model: chosen.model, reasoningEffort: chosen.reasoningEffort } },
    selectProfile: id => save({ profileId: id }),
    // Fast follows its model: an explicit toggle is kept; an effort change keeps it; another model takes its own default.
    selectModel: patch => {
      const next = patch.model ?? chosen.model
      if (!fastSubmitted) return save({ profileId, model: next, ...(patch.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}) })
      const kept = typeof patch.fast === 'boolean' ? patch.fast : next === chosen.model ? chosen.fast : undefined
      const wanted = { model: next, ...(patch.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}), ...(typeof kept === 'boolean' ? { fast: kept } : {}) }
      save({ profileId, ...(planningSelection(models, wanted) ?? wanted) })
    },
  }
}

/** Native seat contents: AgentPicker in the hero workspace row, ModelPicker before send. */
export function PlanningAgentPicker({ controls, planning, lockedReason }) {
  if (!controls?.AgentPicker) return h('span', { className: 'kode-builder-seat-note', role: 'status' }, '原生 Agent 控件加载中…')
  return h(controls.AgentPicker, { data: planning.pickerData, busy: planning.loading, lockedReason, onSelect: planning.selectProfile })
}
export function PlanningModelPicker({ controls, planning, lockedReason }) {
  if (!controls?.ModelPicker) return null
  if (planning.modelError) return h('span', { className: 'kode-builder-seat-note', role: 'status', title: planning.modelError }, '模型不可用')
  return h(controls.ModelPicker, { data: planning.pickerData, lockedReason, onSelect: planning.selectModel })
}
